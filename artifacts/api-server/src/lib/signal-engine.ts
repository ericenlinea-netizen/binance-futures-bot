import { db, gameRoundsTable, signalLogsTable } from "@workspace/db";
import { desc, sql, eq } from "drizzle-orm";

export interface SignalResult {
  signal: "ENTER" | "WAIT";
  confidence: number;
  streak: number;
  hitRate10: number;
  hitRate20: number;
  hitRate50: number;
  totalRounds: number;
  reason: string;
}

export type GaleAlert =
  | "WIN_DIRECT"      // first entry won
  | "WIN_GALE"        // gale entry won
  | "GALE_TRIGGERED"  // first entry lost → apply gale
  | "LOSS_FINAL"      // both entries lost
  | null;

/**
 * Multiplier target for win/loss resolution and hit rate calculations.
 * Override with HIT_THRESHOLD env var (float, default 1.5).
 */
export const HIT_THRESHOLD =
  Number(process.env["HIT_THRESHOLD"] ?? 1.5);

/**
 * Minimum confidence score to emit an ENTER signal for 1.5x target.
 * Override with CONFIDENCE_THRESHOLD env var (integer 0–100, default 62).
 * Lowered from 65 → 62 based on 483-round calibration (92.9% efficiency).
 */
export const CONFIDENCE_THRESHOLD =
  Number(process.env["CONFIDENCE_THRESHOLD"] ?? 62);

/**
 * Minimum confidence score for 2.0x ENTER signals.
 * Lower than 1.5x to account for the natural ~50% hit rate at 2.0x.
 * Override with CONFIDENCE_THRESHOLD_20 env var (default 57).
 */
export const CONFIDENCE_THRESHOLD_20 =
  Number(process.env["CONFIDENCE_THRESHOLD_20"] ?? 57);

/**
 * Minimum consecutive loss streak required before any ENTER signal is emitted.
 * Override with MIN_STREAK env var (integer, default 2).
 */
export const MIN_STREAK =
  Number(process.env["MIN_STREAK"] ?? 2);

/**
 * Rounds to block ENTER signals after a LOSS_FINAL (total gale loss).
 * Override with COOLDOWN_ROUNDS env var (integer, default 2).
 * Reduced from 3 → 2: avoid missing good entries after quick recovery.
 */
export const COOLDOWN_ROUNDS =
  Number(process.env["COOLDOWN_ROUNDS"] ?? 2);

// ─── Pure analysis function ───────────────────────────────────────────────────
/**
 * Pure, deterministic signal computation from a slice of round history.
 * DB access is intentionally separated — pass rounds ordered newest-first.
 *
 * @param recent         Up to 50 most-recent rounds, newest first.
 * @param totalRounds    Total DB count for display.
 * @param threshold      Base confidence threshold for ENTER. Defaults to CONFIDENCE_THRESHOLD.
 * @param minStreak      Hard minimum consecutive losses before any ENTER. Defaults to MIN_STREAK.
 * @param cooldownLeft   Rounds remaining in post-LOSS_FINAL cooldown (0 = no cooldown active).
 * @param hitTarget      Multiplier target used for streak + hit rate calculations. Defaults to HIT_THRESHOLD.
 */
export function analyzeRounds(
  recent: { multiplier: number }[],
  totalRounds: number,
  threshold = CONFIDENCE_THRESHOLD,
  minStreak = MIN_STREAK,
  cooldownLeft = 0,
  hitTarget = HIT_THRESHOLD,
): SignalResult {
  if (recent.length < 5) {
    return {
      signal: "WAIT", confidence: 0, streak: 0,
      hitRate10: 0, hitRate20: 0, hitRate50: 0,
      totalRounds,
      reason: "Datos insuficientes (se necesitan ≥5 rondas)",
    };
  }

  const streak = calcStreak(recent, hitTarget);
  const hitRate10 = calcHitRate(recent, 10, hitTarget);
  const hitRate20 = calcHitRate(recent, 20, hitTarget);
  const hitRate50 = calcHitRate(recent, 50, hitTarget);
  const trend = ema([...recent].reverse().slice(-20).map((r) => r.multiplier));

  // ── Cooldown after LOSS_FINAL ─────────────────────────────────────────────
  if (cooldownLeft > 0) {
    return {
      signal: "WAIT", confidence: 0, streak, hitRate10, hitRate20, hitRate50,
      totalRounds,
      reason: `Enfriamiento post-pérdida (${cooldownLeft} ronda${cooldownLeft !== 1 ? "s" : ""} restante${cooldownLeft !== 1 ? "s" : ""})`,
    };
  }

  // ── Hard gate: minimum streak ─────────────────────────────────────────────
  if (streak < minStreak) {
    return {
      signal: "WAIT", confidence: 0, streak, hitRate10, hitRate20, hitRate50,
      totalRounds,
      reason: `Esperar racha ≥${minStreak} pérdidas (actual: ${streak})`,
    };
  }

  let confidence = 0;
  const reasons: string[] = [];

  // ── Streak bonus ──────────────────────────────────────────────────────────
  if (streak >= 4) { confidence += 40; reasons.push(`${streak} pérdidas seguidas`); }
  else if (streak >= 3) { confidence += 32; reasons.push(`${streak} pérdidas seguidas`); }
  else if (streak >= 2) { confidence += 22; reasons.push(`${streak} pérdidas seguidas`); }

  // ── Hit rate bonuses ──────────────────────────────────────────────────────
  // For 2.0x (natural hit rate ~50%), tier thresholds are scaled by 0.85
  // so the scoring reflects the lower baseline rather than comparing to 1.5x norms.
  const t = hitTarget >= 2.0 ? 0.85 : 1.0;

  if (hitRate10 >= 0.65 * t) { confidence += 25; reasons.push(`Hit rate 10R: ${(hitRate10 * 100).toFixed(0)}%`); }
  else if (hitRate10 >= 0.50 * t) confidence += 16;
  else if (hitRate10 >= 0.35 * t) confidence += 6;

  if (hitRate20 >= 0.65 * t) { confidence += 20; reasons.push(`Hit rate 20R: ${(hitRate20 * 100).toFixed(0)}%`); }
  else if (hitRate20 >= 0.50 * t) confidence += 12;
  else if (hitRate20 >= 0.35 * t) confidence += 4;

  if (hitRate50 >= 0.65 * t) { confidence += 15; reasons.push(`Hit rate global: ${(hitRate50 * 100).toFixed(0)}%`); }
  else if (hitRate50 >= 0.50 * t) confidence += 9;
  else if (hitRate50 >= 0.35 * t) confidence += 4;

  // ── EMA trend ─────────────────────────────────────────────────────────────
  if (trend < 1.3) { confidence += 6; reasons.push("Tendencia enfriándose"); }
  else if (trend > 3.0) confidence -= 5;

  // ── Big-win penalty ───────────────────────────────────────────────────────
  // Raised threshold 8x → 12x: with average multiplier 5.16x, too many normal
  // "big" rounds (8–11x) were incorrectly penalized as cold-period indicators.
  const roundBeforeStreak = recent[streak];
  if (roundBeforeStreak && roundBeforeStreak.multiplier >= 12) {
    confidence -= 10;
    reasons.push(`Penalización post-pico (${roundBeforeStreak.multiplier.toFixed(2)}x)`);
  }

  confidence = Math.max(0, Math.min(100, confidence));

  // ── Adaptive threshold ────────────────────────────────────────────────────
  // Raised trigger 40% → 35%: only block entries when hit rate is truly poor,
  // not just minor variance. Bonus reduced +8 → +6 to be less aggressive.
  const effectiveThreshold = hitRate10 < 0.35 ? threshold + 6 : threshold;
  if (hitRate10 < 0.35 && confidence >= threshold) {
    reasons.push(`Umbral elevado (servidor frío: ${(hitRate10 * 100).toFixed(0)}% en 10R)`);
  }

  const signal: "ENTER" | "WAIT" = confidence >= effectiveThreshold ? "ENTER" : "WAIT";

  return {
    signal, confidence, streak, hitRate10, hitRate20, hitRate50, totalRounds,
    reason: reasons.length
      ? reasons.join(" • ")
      : signal === "ENTER"
        ? "Múltiples indicadores alineados"
        : "Confianza insuficiente — esperar",
  };
}

export interface DualSignalResult extends SignalResult {
  /** Same analysis computed against a 2.0x target. */
  signal20: SignalResult;
}

// ─── DB-aware wrapper ─────────────────────────────────────────────────────────
/** Fetches data from DB then delegates to pure analyzeRounds() for both targets. */
export async function computeSignal(): Promise<DualSignalResult> {
  const [recent, [{ count }], lastLossFinal] = await Promise.all([
    db.select({ multiplier: gameRoundsTable.multiplier })
      .from(gameRoundsTable)
      .orderBy(desc(gameRoundsTable.id))
      .limit(50),
    db.select({ count: sql<number>`count(*)` }).from(gameRoundsTable),
    db.select({ resolvedAt: signalLogsTable.resolvedAt })
      .from(signalLogsTable)
      .where(
        sql`${signalLogsTable.outcome} = 'LOSS' AND ${signalLogsTable.galeAttempt} = 1`,
      )
      .orderBy(desc(signalLogsTable.id))
      .limit(1),
  ]);

  let cooldownLeft = 0;
  if (lastLossFinal[0]?.resolvedAt) {
    const roundsSince = await db
      .select({ c: sql<number>`count(*)` })
      .from(gameRoundsTable)
      .where(sql`${gameRoundsTable.crashedAt} > ${lastLossFinal[0].resolvedAt}`);
    const played = Number(roundsSince[0]?.c ?? 0);
    cooldownLeft = Math.max(0, COOLDOWN_ROUNDS - played);
  }

  const total = Number(count ?? 0);
  // 1.5x uses the standard threshold; 2.0x uses its own lower threshold
  // to account for the natural ~50% hit rate at the higher target.
  const signal15 = analyzeRounds(recent, total, CONFIDENCE_THRESHOLD, MIN_STREAK, cooldownLeft, 1.5);
  const signal20 = analyzeRounds(recent, total, CONFIDENCE_THRESHOLD_20, MIN_STREAK, cooldownLeft, 2.0);

  return { ...signal15, signal20 };
}

// ─── Gale resolution ──────────────────────────────────────────────────────────
export type DualGaleAlert = {
  gale15: GaleAlert;
  gale20: GaleAlert;
};

/**
 * Resolves any PENDING signal log against the new round result.
 * Both 1.5x and 2.0x rows now drive independent gale state machines.
 * Mutates DB: updates outcome + resolvedAt on the pending row.
 */
export async function resolveAndGetGaleAlert(newMultiplier: number): Promise<DualGaleAlert> {
  const now = new Date();

  const pendingRows = await db
    .select()
    .from(signalLogsTable)
    .where(eq(signalLogsTable.outcome, "PENDING"))
    .orderBy(desc(signalLogsTable.id));

  if (!pendingRows.length) return { gale15: null, gale20: null };

  let gale15: GaleAlert = null;
  let gale20: GaleAlert = null;

  for (const pending of pendingRows) {
    const target = (pending.hitTarget ?? HIT_THRESHOLD) as number;
    const isWin = newMultiplier >= target;
    const galeAttempt = pending.galeAttempt ?? 0;

    await db
      .update(signalLogsTable)
      .set({ outcome: isWin ? "WIN" : "LOSS", resolvedAt: now })
      .where(eq(signalLogsTable.id, pending.id));

    // 1.5x gale state machine.
    if (Math.abs(target - 1.5) < 0.01) {
      if (galeAttempt === 0) gale15 = isWin ? "WIN_DIRECT" : "GALE_TRIGGERED";
      else gale15 = isWin ? "WIN_GALE" : "LOSS_FINAL";
    }

    // 2.0x gale state machine (independent from 1.5x).
    if (Math.abs(target - 2.0) < 0.01) {
      if (galeAttempt === 0) gale20 = isWin ? "WIN_DIRECT" : "GALE_TRIGGERED";
      else gale20 = isWin ? "WIN_GALE" : "LOSS_FINAL";
    }
  }

  return { gale15, gale20 };
}

// ─── Signal logging ───────────────────────────────────────────────────────────
/** Persists an ENTER signal to the log. No-op for WAIT signals. */
export async function logSignal(
  roundId: number,
  result: SignalResult,
  galeAttempt: 0 | 1 = 0,
  hitTarget = 1.5,
): Promise<void> {
  if (result.signal !== "ENTER") return;
  await db.insert(signalLogsTable).values({
    roundId,
    signalType: "ENTER",
    confidence: result.confidence,
    outcome: "PENDING",
    galeAttempt,
    hitTarget,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function calcHitRate(rounds: { multiplier: number }[], n: number, target = HIT_THRESHOLD): number {
  const slice = rounds.slice(0, n);
  if (!slice.length) return 0;
  return slice.filter((r) => r.multiplier >= target).length / slice.length;
}

function calcStreak(rounds: { multiplier: number }[], target = HIT_THRESHOLD): number {
  let streak = 0;
  for (const r of rounds) {
    if (r.multiplier < target) streak++;
    else break;
  }
  return streak;
}

function ema(values: number[], alpha = 0.3): number {
  if (!values.length) return 0;
  let e = values[values.length - 1];
  for (let i = values.length - 2; i >= 0; i--)
    e = alpha * values[i] + (1 - alpha) * e;
  return e;
}
