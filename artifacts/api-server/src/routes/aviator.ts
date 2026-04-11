import { Router } from "express";
import { db, gameRoundsTable, signalLogsTable } from "@workspace/db";
import { desc, sql, count } from "drizzle-orm";
import { CreateRoundBody, GetRoundsQueryParams } from "@workspace/api-zod";
import { computeSignal, logSignal, resolveAndGetGaleAlert, DualGaleAlert } from "../lib/signal-engine";
import { sendTelegramMessage } from "../lib/telegram";
import { logger } from "../lib/logger";
import { buildResearchDashboard } from "../lib/research-engine";

const router = Router();

// ─── Server-side dedup cache (multiplier*100 → timestamp) ─────────────────────
// Only applied to non-CDP sources. CDP ("spribe") is always trusted and never deduped.
const _recentRounds = new Map<number, number>();
const _DEDUP_MS = 6000;
const CDP_SOURCES = new Set(["spribe", "cdp-binary", "cdp-text"]);

function isDuplicate(multiplier: number, source?: string): boolean {
  // CDP rounds are always authoritative — never deduplicate them
  if (source && CDP_SOURCES.has(source)) return false;
  const key = Math.round(multiplier * 100);
  const last = _recentRounds.get(key);
  const now = Date.now();
  // Clean stale entries while we're here
  for (const [k, t] of _recentRounds) if (now - t > _DEDUP_MS * 2) _recentRounds.delete(k);
  if (last && now - last < _DEDUP_MS) return true;
  _recentRounds.set(key, now);
  return false;
}

// ─── POST /rounds ─────────────────────────────────────────────────────────────
router.post("/rounds", async (req, res) => {
  const parsed = CreateRoundBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.message });
    return;
  }

  const { multiplier } = parsed.data;
  // Optional source field — identifies whether the round came from CDP ("spribe") or injector
  const source = typeof req.body?.source === "string" ? req.body.source : undefined;

  // Reject duplicates for non-CDP sources — same multiplier within 6s is poll noise
  // CDP (source="spribe") is always trusted and bypasses dedup
  if (isDuplicate(multiplier, source)) {
    res.status(409).json({ ok: false, reason: "duplicate" });
    return;
  }

  const isWin = multiplier >= 1.5;

  // Insert round
  const [round] = await db
    .insert(gameRoundsTable)
    .values({ multiplier, crashedAt: new Date() })
    .returning();

  // Resolve any pending signals — independent Gale state machines for 1.5x and 2.0x.
  const { gale15, gale20 } = await resolveAndGetGaleAlert(multiplier).catch((err) => {
    logger.warn({ err }, "Failed to resolve gale alert");
    return { gale15: null, gale20: null } as DualGaleAlert;
  });

  // Send Gale resolution Telegram message (1.5x only — drives main alerts)
  const galeTgMsg = buildGaleTelegramMsg(multiplier, gale15);
  if (galeTgMsg) {
    sendTelegramMessage(galeTgMsg).catch(() => { });
  }

  // Compute new signal for next round
  const signal = await computeSignal();

  // ── 1.5x gale handling ────────────────────────────────────────────────────
  if (gale15 === "GALE_TRIGGERED") {
    // Unconditionally log 1.5x gale tracker so LOSS_FINAL is always captured.
    await db.insert(signalLogsTable).values({
      roundId: round.id,
      signalType: "ENTER",
      confidence: signal.confidence,
      outcome: "PENDING",
      galeAttempt: 1,
      hitTarget: 1.5,
    }).catch((err) => logger.warn({ err }, "Failed to log 1.5x gale tracker"));

    if (signal.signal === "ENTER") {
      sendTelegramMessage(buildSignalTelegramMsg(signal, 1)).catch(() => { });
    }
  } else {
    // Normal 1.5x signal
    if (signal.signal === "ENTER") {
      await logSignal(round.id, signal, 0, 1.5).catch((err) =>
        logger.warn({ err }, "Failed to log 1.5x signal"),
      );
      sendTelegramMessage(buildSignalTelegramMsg(signal, 0)).catch(() => { });
    }
  }

  // ── 2.0x gale handling ────────────────────────────────────────────────────
  if (gale20 === "GALE_TRIGGERED") {
    // Unconditionally log 2.0x gale tracker so LOSS_FINAL is always captured.
    await db.insert(signalLogsTable).values({
      roundId: round.id,
      signalType: "ENTER",
      confidence: signal.signal20?.confidence ?? 0,
      outcome: "PENDING",
      galeAttempt: 1,
      hitTarget: 2.0,
    }).catch((err) => logger.warn({ err }, "Failed to log 2.0x gale tracker"));
  } else {
    // Normal 2.0x signal (only when not already in a gale cycle)
    if (signal.signal20?.signal === "ENTER") {
      await logSignal(round.id, signal.signal20, 0, 2.0).catch((err) =>
        logger.warn({ err }, "Failed to log 2.0x signal"),
      );
    }
  }

  res.status(201).json({
    id: round.id,
    multiplier: round.multiplier,
    crashedAt: round.crashedAt.toISOString(),
    createdAt: round.createdAt.toISOString(),
    signal,
    galeAlert: gale15,
    gale20Alert: gale20,
  });
});

// ─── GET /rounds ──────────────────────────────────────────────────────────────
router.get("/rounds", async (req, res) => {
  const parsed = GetRoundsQueryParams.safeParse({
    page: req.query["page"] ? Number(req.query["page"]) : undefined,
    limit: req.query["limit"] ? Number(req.query["limit"]) : undefined,
  });

  const page = parsed.success ? (parsed.data.page ?? 1) : 1;
  const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;
  const offset = (page - 1) * limit;

  const [rounds, totalResult] = await Promise.all([
    db.select().from(gameRoundsTable).orderBy(desc(gameRoundsTable.id)).limit(limit).offset(offset),
    db.select({ count: count() }).from(gameRoundsTable),
  ]);

  res.json({
    rounds: rounds.map((r) => ({
      id: r.id, multiplier: r.multiplier,
      crashedAt: r.crashedAt.toISOString(), createdAt: r.createdAt.toISOString(),
    })),
    total: Number(totalResult[0]?.count ?? 0),
    page, limit,
  });
});

// ─── GET /signal ──────────────────────────────────────────────────────────────
router.get("/signal", async (_req, res) => {
  res.json(await computeSignal());
});

// ─── GET /signals (history) ───────────────────────────────────────────────────
router.get("/signals", async (req, res) => {
  const limit = Math.min(Number(req.query["limit"] ?? 30), 100);
  const logs = await db
    .select()
    .from(signalLogsTable)
    .orderBy(desc(signalLogsTable.id))
    .limit(limit);

  res.json({
    signals: logs.map((s) => ({
      id: s.id,
      roundId: s.roundId ?? null,
      signalType: s.signalType,
      confidence: s.confidence,
      outcome: s.outcome,
      galeAttempt: s.galeAttempt ?? 0,
      hitTarget: s.hitTarget ?? 1.5,
      createdAt: s.createdAt.toISOString(),
      resolvedAt: s.resolvedAt ? s.resolvedAt.toISOString() : null,
    })),
  });
});

// ─── GET /stats ───────────────────────────────────────────────────────────────
router.get("/stats", async (_req, res) => {
  // Fetch aggregate stats from DB (no row-level cap for accuracy)
  const [aggResult, recentRounds, signalStats] = await Promise.all([
    db.select({
      total: sql<number>`count(*)`,
      hits: sql<number>`count(*) filter (where multiplier >= 1.5)`,
      avgMult: sql<number>`avg(multiplier)`,
    }).from(gameRoundsTable),
    db.select({ multiplier: gameRoundsTable.multiplier })
      .from(gameRoundsTable).orderBy(desc(gameRoundsTable.id)).limit(50),
    db.select({
      signalType: signalLogsTable.signalType,
      outcome: signalLogsTable.outcome,
      galeAttempt: signalLogsTable.galeAttempt,
      hitTarget: signalLogsTable.hitTarget,
    }).from(signalLogsTable),
  ]);

  const totalRounds = Number(aggResult[0]?.total ?? 0);
  const hitRate = totalRounds > 0 ? Number(aggResult[0]?.hits ?? 0) / totalRounds : 0;
  const avgMultiplier = Number(aggResult[0]?.avgMult ?? 0);

  // Streaks — computed from all rounds, fetched in order
  const allForStreaks = await db.select({ multiplier: gameRoundsTable.multiplier })
    .from(gameRoundsTable).orderBy(gameRoundsTable.id);

  let bestStreak = 0, worstStreak = 0, cur = 0, curLoss = 0;
  for (const r of allForStreaks) {
    if (r.multiplier >= 1.5) {
      cur++; curLoss = 0;
      if (cur > bestStreak) bestStreak = cur;
    } else {
      curLoss++; cur = 0;
      if (curLoss > worstStreak) worstStreak = curLoss;
    }
  }

  function galeStats(rows: typeof signalStats, targetLabel: 1.5 | 2.0) {
    const enter = rows.filter(
      (s) => s.signalType === "ENTER" && Math.abs((s.hitTarget ?? 1.5) - targetLabel) < 0.01,
    );
    const wDirect = enter.filter((s) => s.outcome === "WIN" && (s.galeAttempt ?? 0) === 0).length;
    const wGale   = enter.filter((s) => s.outcome === "WIN" && (s.galeAttempt ?? 0) === 1).length;
    const loss    = enter.filter((s) => s.outcome === "LOSS" && (s.galeAttempt ?? 0) === 1).length;
    // Count unique entry cycles (gale_attempt=0 rows only) — each cycle is 1 entry event.
    const totalCycles = enter.filter((s) => (s.galeAttempt ?? 0) === 0).length;
    return { total: totalCycles, winDirect: wDirect, winGale: wGale, lossCount: loss };
  }

  const stats15 = galeStats(signalStats, 1.5);
  const stats20 = galeStats(signalStats, 2.0);

  // Legacy flat fields (used by BacktestPanel + older consumers)
  const totalEnterSignals = stats15.total + stats20.total;
  const winDirect = stats15.winDirect;
  const winGale   = stats15.winGale;
  const lossCount = stats15.lossCount;
  const resolvedEnters = winDirect + winGale + lossCount;
  const signalAccuracy = resolvedEnters > 0 ? (winDirect + winGale) / resolvedEnters : 0;

  res.json({
    totalRounds, hitRate, avgMultiplier, bestStreak, worstStreak,
    signalAccuracy, totalEnterSignals, winDirect, winGale, lossCount,
    // Per-target breakdown
    gale15: stats15,
    gale20: stats20,
    recentMultipliers: [...recentRounds].reverse().map((r) => r.multiplier),
  });
});

// ─── GET /research ─────────────────────────────────────────────────────────────
router.get("/research", async (_req, res) => {
  const rounds = await db
    .select({
      id: gameRoundsTable.id,
      multiplier: gameRoundsTable.multiplier,
      createdAt: gameRoundsTable.createdAt,
    })
    .from(gameRoundsTable)
    .orderBy(gameRoundsTable.id);

  res.json(buildResearchDashboard(rounds));
});

// ─── GET /backtest ─────────────────────────────────────────────────────────────
// Compares 1.5x vs 2x targets using separate signal_logs per target.
router.get("/backtest", async (_req, res) => {
  const [allRounds, signals15, signals20] = await Promise.all([
    db.select({ multiplier: gameRoundsTable.multiplier }).from(gameRoundsTable),
    // Signals for 1.5x target only
    db.execute(sql`
      SELECT sl.id, sl.outcome, sl.gale_attempt, sl.hit_target,
             gr.multiplier AS resolved_mult
      FROM signal_logs sl
      JOIN LATERAL (
        SELECT multiplier FROM game_rounds
        WHERE crashed_at <= sl.resolved_at
        ORDER BY crashed_at DESC LIMIT 1
      ) gr ON true
      WHERE sl.outcome != 'PENDING'
        AND sl.resolved_at IS NOT NULL
        AND sl.hit_target = 1.5
    `),
    // Signals for 2.0x target only
    db.execute(sql`
      SELECT sl.id, sl.outcome, sl.gale_attempt, sl.hit_target,
             gr.multiplier AS resolved_mult
      FROM signal_logs sl
      JOIN LATERAL (
        SELECT multiplier FROM game_rounds
        WHERE crashed_at <= sl.resolved_at
        ORDER BY crashed_at DESC LIMIT 1
      ) gr ON true
      WHERE sl.outcome != 'PENDING'
        AND sl.resolved_at IS NOT NULL
        AND sl.hit_target = 2.0
    `),
  ]);

  const total = allRounds.length;
  const hitRate15 = total ? allRounds.filter((r) => r.multiplier >= 1.5).length / total : 0;
  const hitRate20 = total ? allRounds.filter((r) => r.multiplier >= 2.0).length / total : 0;

  type Row = { outcome: string; gale_attempt: number; resolved_mult: number };

  function calcPnl(rows: Row[], target: number) {
    let pnl = 0, wins = 0, losses = 0, galeTriggers = 0;
    const profit1 = target - 1;   // profit on 1-unit bet (e.g. 0.5u for 1.5x, 1u for 2x)
    const profit2 = profit1 * 2;  // profit on 2-unit gale bet

    for (const row of rows) {
      const ga = Number(row.gale_attempt ?? 0);
      const won = Number(row.resolved_mult ?? 0) >= target;

      if (ga === 0) {
        if (won) { pnl += profit1; wins++; }
        else     { pnl -= 1; galeTriggers++; }
      } else {
        if (won) { pnl += profit2; wins++; }
        else     { pnl -= 2; losses++; }
      }
    }

    return {
      pnl: Math.round(pnl * 100) / 100,
      wins,
      galeTriggers,
      lossCount: losses,
      signalCount: rows.length,
    };
  }

  const rows15 = (signals15.rows ?? signals15) as Row[];
  const rows20 = (signals20.rows ?? signals20) as Row[];
  const r15 = calcPnl(rows15, 1.5);
  const r20 = calcPnl(rows20, 2.0);
  const totalSignals = rows15.length + rows20.length;

  res.json({
    totalRounds: total,
    target15: {
      hitRate: hitRate15,
      wins: r15.wins,
      galeTriggers: r15.galeTriggers,
      lossCount: r15.lossCount,
      pnl: r15.pnl,
      profitPerSignal: r15.signalCount ? Math.round((r15.pnl / r15.signalCount) * 100) / 100 : 0,
    },
    target20: {
      hitRate: hitRate20,
      wins: r20.wins,
      galeTriggers: r20.galeTriggers,
      lossCount: r20.lossCount,
      pnl: r20.pnl,
      profitPerSignal: r20.signalCount ? Math.round((r20.pnl / r20.signalCount) * 100) / 100 : 0,
    },
    resolvedSignals: totalSignals,
    note: "P&L asume apuesta base 1 unidad. Gale usa 2 unidades.",
  });
});

// ─── Telegram message builders ────────────────────────────────────────────────
function buildGaleTelegramMsg(multiplier: number, alert: string | null): string | null {
  if (!alert) return null;
  const m = multiplier.toFixed(2);
  switch (alert) {
    case "WIN_DIRECT":
      return `✅ *GANADA DIRECTA*\nRonda: *${m}x* — Primera entrada exitosa 🎯`;
    case "WIN_GALE":
      return `🔄 *GANADA CON GALE*\nRonda: *${m}x* — Se recuperó con la segunda entrada 💪`;
    case "GALE_TRIGGERED":
      return `⚠️ *GALE ACTIVADO*\nRonda: *${m}x* — Primera entrada perdida\n_Aplica el doble de apuesta en la siguiente_`;
    case "LOSS_FINAL":
      return `❌ *PÉRDIDA TOTAL*\nRonda: *${m}x* — Ambas entradas perdidas. Esperar nueva señal.`;
    default:
      return null;
  }
}

function buildSignalTelegramMsg(
  signal: { signal: string; confidence: number; streak: number; reason: string; hitRate10: number; hitRate20: number; hitRate50: number },
  galeAttempt: number,
): string {
  const isEnter = signal.signal === "ENTER";
  const galeTag = galeAttempt === 1 ? " *(GALE — doble apuesta)*" : "";
  if (isEnter) {
    return (
      `🟢 *ENTRAR*${galeTag}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📈 Confianza: *${signal.confidence.toFixed(0)}%*\n` +
      `🔴 Racha bajas: *${signal.streak}*\n` +
      `📊 Hit rates: *${(signal.hitRate10 * 100).toFixed(0)}%* (10R) • *${(signal.hitRate20 * 100).toFixed(0)}%* (20R) • *${(signal.hitRate50 * 100).toFixed(0)}%* (50R)\n` +
      `💡 _${signal.reason}_`
    );
  }
  return (
    `🔴 *ESPERAR*\n` +
    `Confianza: ${signal.confidence.toFixed(0)}% — _${signal.reason}_`
  );
}

export default router;
