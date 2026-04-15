function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(response)));
}

const fmtPct = (value) => `${(value * 100).toFixed(1)}%`;
const fmtUnits = (value) => `${value > 0 ? "+" : ""}${value.toFixed(2)}u`;
const fmtTime = (value) =>
  value
    ? new Date(value).toLocaleTimeString("es-CO", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "-";
const fmtDateTime = (value) =>
  value
    ? new Date(value).toLocaleString("es-CO", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "-";
const dayKey = (value) =>
  value
    ? new Date(value).toLocaleDateString("sv-SE", {
        timeZone: "America/Bogota",
      })
    : "";
const dayLabel = (value) =>
  value
    ? new Date(value).toLocaleDateString("es-CO", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        timeZone: "America/Bogota",
      })
    : "-";
const avg = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const med = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};
const sd = (values) => {
  if (values.length <= 1) return 0;
  const mean = avg(values);
  return Math.sqrt(avg(values.map((value) => (value - mean) ** 2)));
};
const percentile = (values, ratio, fallback = 0) => {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index];
};

const HYBRID_EXECUTION = {
  mode: "gale_v1",
  minGapMs: 40000,
  targetMultiplier: 1.5,
  directWinPnl: 0.5,
  galeWinPnl: 0.5,
  fullLossPnl: -3,
};

const HYBRID_17_EXECUTION = {
  mode: "gale_v1_17",
  minGapMs: 40000,
  targetMultiplier: 1.7,
  directWinPnl: 0.85,
  galeWinPnl: 1.86,
  fullLossPnl: -3,
};

function lossStreak(rounds, index, target = 1.5) {
  let streak = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (rounds[i].multiplier < target) streak += 1;
    else break;
  }
  return streak;
}

function hitRate(rounds, index, size, target = 1.5) {
  const sample = rounds.slice(Math.max(0, index - size), index);
  return sample.length ? sample.filter((round) => round.multiplier >= target).length / sample.length : 0;
}

function rangeRate(rounds, index, size, min, max = null) {
  const sample = rounds.slice(Math.max(0, index - size), index);
  if (!sample.length) return 0;
  return (
    sample.filter((round) => round.multiplier >= min && (max === null || round.multiplier < max)).length / sample.length
  );
}

function avgWindow(rounds, index, size) {
  return avg(rounds.slice(Math.max(0, index - size), index).map((round) => round.multiplier));
}

function volWindow(rounds, index, size) {
  return sd(rounds.slice(Math.max(0, index - size), index).map((round) => round.multiplier));
}

function roundsSince(rounds, index, threshold) {
  for (let i = index - 1, distance = 1; i >= 0; i -= 1, distance += 1) {
    if (rounds[i].multiplier >= threshold) return distance;
  }
  return index;
}

function deriveRegime(metrics) {
  if (!metrics) return "INSUFICIENTE";
  if (metrics.compression >= 0.72 && metrics.shockRisk <= 0.18 && metrics.dry15 >= 2) return "COMPRESION";
  if (
    metrics.compression >= 0.58 &&
    metrics.shortHit15 >= 0.18 &&
    metrics.shortHit15 <= 0.52 &&
    metrics.shockRisk <= 0.22
  ) {
    return "RECUPERACION";
  }
  if (metrics.shockRisk >= 0.3 || metrics.shortHit15 >= 0.68 || metrics.burstRisk >= 0.45) return "SOBRECALENTADO";
  if (metrics.dry15 <= 1 && metrics.shortHit15 >= 0.5) return "EXPANSION";
  return "NEUTRAL";
}

function snapshot(rounds, index) {
  if (index < 24) return null;

  const metrics = {
    streak: lossStreak(rounds, index),
    shortHit15: hitRate(rounds, index, 6),
    mediumHit15: hitRate(rounds, index, 18),
    longHit15: hitRate(rounds, index, 40),
    compression: rangeRate(rounds, index, 8, 0, 1.5),
    microCompression: rangeRate(rounds, index, 4, 0, 1.35),
    shockRisk: rangeRate(rounds, index, 8, 3, null),
    burstRisk: rangeRate(rounds, index, 5, 2, null),
    avg6: avgWindow(rounds, index, 6),
    avg18: avgWindow(rounds, index, 18),
    avg40: avgWindow(rounds, index, 40),
    vol6: volWindow(rounds, index, 6),
    vol18: volWindow(rounds, index, 18),
    dry15: roundsSince(rounds, index, 1.5),
    dry2: roundsSince(rounds, index, 2),
    dry5: roundsSince(rounds, index, 5),
  };

  metrics.drift = metrics.avg6 - metrics.avg18;
  metrics.recoveryBias = metrics.shortHit15 - metrics.mediumHit15;
  metrics.regime = deriveRegime(metrics);
  return metrics;
}

function calibration(rounds) {
  const points = [];
  for (let i = 24; i < rounds.length; i += 1) {
    const snap = snapshot(rounds, i);
    if (!snap) continue;
    points.push({
      ...snap,
      hit: rounds[i].multiplier >= 1.5 ? 1 : 0,
    });
  }

  if (!points.length) {
    return {
      base: 0,
      entryBase: 0,
      atlas: {
        compressionMin: 0.62,
        shockMax: 0.2,
        burstMax: 0.2,
        dry15Min: 2,
        dry15Max: 7,
        dry5Min: 4,
        mediumHitMax: 0.5,
        vol6Max: 1.3,
        biasAbsMax: 0.18,
        scoreEnter: 74,
      },
    };
  }

  const winners = points.filter((point) => point.hit === 1);
  const strong = winners.filter((point) => point.regime === "COMPRESION" || point.regime === "RECUPERACION");
  const basePool = strong.length >= 24 ? strong : winners.length >= 24 ? winners : points;
  const losers = points.filter((point) => point.hit === 0);

  const atlas = {
    compressionMin: clamp(percentile(basePool.map((point) => point.compression), 0.35, 0.62), 0.5, 0.82),
    shockMax: clamp(percentile(basePool.map((point) => point.shockRisk), 0.7, 0.2), 0.08, 0.28),
    burstMax: clamp(percentile(basePool.map((point) => point.burstRisk), 0.7, 0.2), 0.08, 0.3),
    dry15Min: Math.round(clamp(percentile(basePool.map((point) => point.dry15), 0.3, 2), 1, 5)),
    dry15Max: Math.round(clamp(percentile(basePool.map((point) => point.dry15), 0.85, 7), 4, 10)),
    dry5Min: Math.round(clamp(percentile(basePool.map((point) => point.dry5), 0.3, 4), 2, 8)),
    mediumHitMax: clamp(percentile(basePool.map((point) => point.mediumHit15), 0.72, 0.5), 0.3, 0.58),
    vol6Max: clamp(percentile(basePool.map((point) => point.vol6), 0.72, 1.3), 0.7, 1.6),
    biasAbsMax: clamp(percentile(basePool.map((point) => Math.abs(point.recoveryBias)), 0.72, 0.18), 0.08, 0.28),
    scoreEnter: 74,
  };

  const loserCompression = percentile(losers.map((point) => point.compression), 0.65, atlas.compressionMin);
  const loserShock = percentile(losers.map((point) => point.shockRisk), 0.35, atlas.shockMax);
  atlas.compressionMin = clamp((atlas.compressionMin + loserCompression) / 2, atlas.compressionMin, 0.84);
  atlas.shockMax = clamp((atlas.shockMax + loserShock) / 2, 0.08, atlas.shockMax);

  return {
    base: avg(points.map((point) => point.hit)),
    entryBase:
      avg(points.filter((point) => point.regime === "COMPRESION" || point.regime === "RECUPERACION").map((point) => point.hit)) ||
      0,
    atlas,
  };
}

function projection(rounds, index, calibrationData) {
  if (index < 24) {
    return {
      score: 0,
      label: "Insuficiente",
      tone: "",
      expected: 0,
      summary: "Aun no hay suficientes rondas para activar la estrategia Atlas.",
      regime: "INSUFICIENTE",
    };
  }

  const snap = snapshot(rounds, index);
  const adaptive = calibrationData.atlas;
  let score = 28;

  score += clamp(snap.compression * 30, 0, 30);
  score += clamp(snap.microCompression * 16, 0, 16);
  score += clamp((snap.dry15 - 1) * 5, 0, 18);
  score += clamp((snap.dry2 - 2) * 3, 0, 12);
  score += clamp((0.52 - snap.mediumHit15) * 26, -12, 16);
  score += clamp((0.58 - snap.longHit15) * 18, -10, 12);
  score += clamp((0.18 - Math.abs(snap.recoveryBias)) * 40, -8, 8);
  score += clamp((0.2 - Math.abs(snap.drift)) * 28, -8, 8);
  score += clamp((1.25 - snap.vol6) * 12, -10, 10);
  score -= clamp(snap.shockRisk * 34, 0, 24);
  score -= clamp(snap.burstRisk * 22, 0, 16);
  score -= snap.dry5 <= 2 ? 10 : 0;
  score += snap.regime === "COMPRESION" ? 10 : snap.regime === "RECUPERACION" ? 14 : snap.regime === "NEUTRAL" ? 0 : -12;
  score += snap.compression >= adaptive.compressionMin ? 5 : -4;
  score += snap.shockRisk <= adaptive.shockMax ? 4 : -6;
  score += snap.burstRisk <= adaptive.burstMax ? 3 : -5;
  score += snap.mediumHit15 <= adaptive.mediumHitMax ? 4 : -4;
  score += snap.vol6 <= adaptive.vol6Max ? 4 : -4;
  score += Math.abs(snap.recoveryBias) <= adaptive.biasAbsMax ? 3 : -3;
  score = clamp(score, 0, 100);

  const base = Math.max(calibrationData.entryBase || 0, calibrationData.base || 0);
  const expected = clamp(base + ((score - 50) / 100) * 0.28 + (snap.regime === "RECUPERACION" ? 0.03 : 0), 0, 0.9);
  const label = score >= 76 ? "Ventana Premium" : score >= 62 ? "Ventana Selectiva" : "Sin ventaja";
  const tone = score >= 76 ? "good" : score >= 62 ? "warn" : "bad";
  const summary =
    snap.regime === "COMPRESION"
      ? "Atlas detecta compresion seca y ausencia de expansion fuerte reciente."
      : snap.regime === "RECUPERACION"
        ? "Atlas ve recuperacion corta y controlada, sin persecucion de picos."
        : snap.regime === "SOBRECALENTADO"
          ? "El mercado viene cargado de picos; Atlas bloquea entradas para no perseguir expansion."
          : "No hay estructura clara ni enfriamiento suficiente para buscar 1.5x.";

  return { score, label, tone, expected, summary, regime: snap.regime };
}

function atlasStrategy(rounds, index, calibrationData) {
  const proj = projection(rounds, index, calibrationData);
  if (index < 24) return { decision: "WAIT", confidence: 0, projection: proj, checks: [] };

  const snap = snapshot(rounds, index);
  const adaptive = calibrationData.atlas;
  const checks = [
    ["Regimen operable", proj.regime === "COMPRESION" || proj.regime === "RECUPERACION", proj.regime, 22],
    ["Compresion real", snap.compression >= adaptive.compressionMin, `${fmtPct(snap.compression)} / ${fmtPct(adaptive.compressionMin)}`, 18],
    ["Sequia util 1.5x", snap.dry15 >= adaptive.dry15Min && snap.dry15 <= adaptive.dry15Max, `${snap.dry15} rondas`, 14],
    ["Sin pico 5x cercano", snap.dry5 >= adaptive.dry5Min, `${snap.dry5} rondas`, 12],
    ["Mercado no sobrecalentado", snap.shockRisk <= adaptive.shockMax, `${fmtPct(snap.shockRisk)} / ${fmtPct(adaptive.shockMax)}`, 12],
    ["Presion media contenida", snap.mediumHit15 <= adaptive.mediumHitMax, `${fmtPct(snap.mediumHit15)} / ${fmtPct(adaptive.mediumHitMax)}`, 10],
    ["Recuperacion limpia", Math.abs(snap.recoveryBias) <= adaptive.biasAbsMax, `${fmtPct(Math.abs(snap.recoveryBias))} / ${fmtPct(adaptive.biasAbsMax)}`, 6],
    ["Volatilidad util", snap.vol6 <= adaptive.vol6Max, `${snap.vol6.toFixed(2)}x / ${adaptive.vol6Max.toFixed(2)}x`, 6],
  ].map(([label, passed, detail, weight]) => ({ label, passed, detail, weight }));

  const confidence = clamp(
    checks.filter((check) => check.passed).reduce((sum, check) => sum + check.weight, 0),
    0,
    100
  );
  const mustPass = checks.slice(0, 5).every((check) => check.passed);
  const edgeThreshold = Math.max((calibrationData.base || 0) + 0.04, 0.5);
  const decision = mustPass && proj.score >= adaptive.scoreEnter && proj.expected >= edgeThreshold ? "ENTER" : "WAIT";

  return { decision, confidence, projection: proj, checks };
}

function atlasConsensus(rounds, index, calibrationData) {
  const snap = snapshot(rounds, index);
  const proj = projection(rounds, index, calibrationData);
  if (!snap) return { pass: false, score: 0, checks: [] };

  const adaptive = calibrationData.atlas;
  const checks = [
    ["Compresion dominante", snap.compression >= adaptive.compressionMin + 0.03, 24],
    ["Shock muy bajo", snap.shockRisk <= Math.max(0.08, adaptive.shockMax - 0.03), 18],
    ["Burst controlado", snap.burstRisk <= adaptive.burstMax, 14],
    ["Drift estable", Math.abs(snap.drift) <= 0.22, 14],
    ["Score premium", proj.score >= adaptive.scoreEnter + 2, 18],
    ["Expected edge", proj.expected >= Math.max((calibrationData.base || 0) + 0.06, 0.52), 12],
  ].map(([label, passed, weight]) => ({ label, passed, weight }));

  const score = clamp(
    checks.filter((check) => check.passed).reduce((sum, check) => sum + check.weight, 0),
    0,
    100
  );

  return {
    pass: checks.filter((check) => check.passed).length >= 5 && score >= 72,
    score,
    checks,
  };
}

function atlasBalanced(rounds, index, calibrationData) {
  const proj = projection(rounds, index, calibrationData);
  if (index < 16) return { decision: "WAIT", confidence: 0, projection: proj, checks: [] };

  const snap = snapshot(rounds, Math.max(24, index)) || {
    compression: rangeRate(rounds, index, 8, 0, 1.5),
    microCompression: rangeRate(rounds, index, 4, 0, 1.35),
    dry15: roundsSince(rounds, index, 1.5),
    shockRisk: rangeRate(rounds, index, 8, 3, null),
    burstRisk: rangeRate(rounds, index, 5, 2, null),
    vol6: volWindow(rounds, index, 6),
    shortHit15: hitRate(rounds, index, 6),
    regime: "NEUTRAL",
  };
  const adaptive = calibrationData.atlas;
  let recentCandidates = 0;
  for (let i = Math.max(16, index - 10); i < index; i += 1) {
    const prevSnap = snapshot(rounds, Math.max(24, i)) || {
      compression: rangeRate(rounds, i, 8, 0, 1.5),
      microCompression: rangeRate(rounds, i, 4, 0, 1.35),
      dry15: roundsSince(rounds, i, 1.5),
      shockRisk: rangeRate(rounds, i, 8, 3, null),
      shortHit15: hitRate(rounds, i, 6),
    };
    const prevProj = projection(rounds, i, calibrationData);
    if (
      (prevProj.regime === "COMPRESION" || prevProj.regime === "RECUPERACION" || prevProj.regime === "NEUTRAL") &&
      (prevSnap.compression >= Math.max(0.4, adaptive.compressionMin - 0.18) || prevSnap.dry15 >= 2) &&
      prevSnap.shockRisk <= adaptive.shockMax + 0.14
    ) {
      recentCandidates += 1;
    }
  }
  const compressionFloor = Math.max(0.4, adaptive.compressionMin - 0.18);
  const microCompressionFloor = Math.max(0.12, compressionFloor - 0.18);
  const recentLowPressure = rangeRate(rounds, index, 4, 0, 1.5);
  const cleanPulse = snap.shortHit15 <= Math.max(0.58, adaptive.mediumHitMax + 0.06);
  const lastRound = rounds[index - 1]?.multiplier ?? 1;
  const prevRound = rounds[index - 2]?.multiplier ?? 1;
  const cleanImmediateZone = lastRound < 2.2 && prevRound < 3.2;
  const regimeGate =
    proj.regime === "COMPRESION" ||
    proj.regime === "RECUPERACION" ||
    (proj.regime === "NEUTRAL" && snap.compression >= compressionFloor + 0.08 && snap.dry15 >= 2 && cleanPulse);
  const checks = [
    ["Regimen util", regimeGate, proj.regime, 18],
    ["Compresion suficiente", snap.compression >= compressionFloor || snap.dry15 >= 2, fmtPct(snap.compression), 16],
    ["Micro compresion", snap.microCompression >= microCompressionFloor || recentLowPressure >= 0.5, fmtPct(snap.microCompression), 10],
    ["Sequia activa", snap.dry15 >= Math.max(1, adaptive.dry15Min - 2) && snap.dry15 <= adaptive.dry15Max + 3, `${snap.dry15} rondas`, 14],
    ["Shock controlado", snap.shockRisk <= adaptive.shockMax + 0.14, fmtPct(snap.shockRisk), 12],
    ["Burst razonable", snap.burstRisk <= adaptive.burstMax + 0.18, fmtPct(snap.burstRisk), 10],
    ["Zona inmediata limpia", cleanImmediateZone, `${lastRound.toFixed(2)}x / ${prevRound.toFixed(2)}x`, 10],
    ["Volatilidad tolerable", snap.vol6 <= adaptive.vol6Max + 0.35, `${snap.vol6.toFixed(2)}x`, 8],
    ["Pulso limpio", cleanPulse, fmtPct(snap.shortHit15), 8],
    ["Edge util", proj.expected >= Math.max((calibrationData.base || 0) + 0.01, 0.44), fmtPct(proj.expected), 12],
    ["Score util", proj.score >= Math.max(54, adaptive.scoreEnter - 18), `${proj.score.toFixed(0)}`, 10],
    ["Sin saturacion", recentCandidates <= 4, `${recentCandidates}/10`, 10],
  ].map(([label, passed, detail, weight]) => ({ label, passed, detail, weight }));

  const confidence = clamp(checks.filter((check) => check.passed).reduce((sum, check) => sum + check.weight, 0), 0, 100);
  const mustPass =
    checks[0].passed &&
    (checks[1].passed || checks[2].passed) &&
    checks[3].passed &&
    checks[4].passed &&
    checks[6].passed &&
    checks.filter((check) => check.passed).length >= 7;
  const decision = mustPass && confidence >= 58 ? "ENTER" : "WAIT";
  return { decision, confidence, projection: proj, checks };
}

function atlasScout(rounds, index, calibrationData) {
  const baseProj = projection(rounds, index, calibrationData);
  if (index < 8) return { decision: "WAIT", confidence: 0, projection: baseProj, checks: [] };

  const snap = snapshot(rounds, Math.max(24, index)) || {
    compression: rangeRate(rounds, index, 6, 0, 1.5),
    shockRisk: rangeRate(rounds, index, 6, 3, null),
    burstRisk: rangeRate(rounds, index, 4, 2, null),
    dry15: roundsSince(rounds, index, 1.5),
    dry2: roundsSince(rounds, index, 2),
    dry5: roundsSince(rounds, index, 5),
    vol6: volWindow(rounds, index, 6),
    shortHit15: hitRate(rounds, index, 6),
    regime: "SCOUT",
  };
  const proj =
    index < 24
      ? {
          ...baseProj,
          score: clamp(46 + snap.compression * 22 + clamp((snap.dry15 - 1) * 6, 0, 18) - snap.shockRisk * 16, 0, 100),
          expected: clamp((calibrationData.base || 0.48) + snap.compression * 0.08 - snap.shockRisk * 0.08, 0, 0.85),
          regime: "SCOUT",
          label: "Scout temprano",
          tone: "warn",
        }
      : baseProj;

  const recentScoutCount = (() => {
    let count = 0;
    for (let i = Math.max(8, index - 12); i < index; i += 1) {
      if (i === index) continue;
      const last = rounds[i - 1]?.multiplier ?? 1;
      const prev = rounds[i - 2]?.multiplier ?? 1;
      if (last < 2.5 && (i % 2 === 0 || last < 1.5 || prev < 1.5)) count += 1;
    }
    return count;
  })();
  const lastRound = rounds[index - 1]?.multiplier ?? 1;
  const prevRound = rounds[index - 2]?.multiplier ?? 1;
  const cadenceGate = recentScoutCount < 6;
  const checks = [
    ["Muestra minima", index >= 8, `${index} rondas`, 14],
    ["Cadencia objetivo", cadenceGate, `${recentScoutCount}/6 ult.12`, 16],
    ["Turno operativo", index % 2 === 0 || lastRound < 1.5 || prevRound < 1.5, index % 2 === 0 ? "turno par" : "post-baja", 16],
    ["No pico inmediato", lastRound < 2.5, `${lastRound.toFixed(2)}x`, 14],
    ["Shock tolerable", snap.shockRisk <= 0.78, fmtPct(snap.shockRisk), 12],
    ["Burst tolerable", snap.burstRisk <= 0.78, fmtPct(snap.burstRisk), 10],
    ["Pulso bajo o compresion", snap.dry15 >= 1 || snap.compression >= 0.1, `${snap.dry15} / ${fmtPct(snap.compression)}`, 10],
    ["Score exploratorio", proj.score >= 30, `${proj.score.toFixed(0)}`, 8],
  ].map(([label, passed, detail, weight]) => ({ label, passed, detail, weight }));

  const confidence = clamp(checks.filter((check) => check.passed).reduce((sum, check) => sum + check.weight, 0), 0, 100);
  const decision = checks[0].passed && checks[1].passed && checks[2].passed && checks[3].passed && confidence >= 42 ? "ENTER" : "WAIT";
  return { decision, confidence, projection: { ...proj, regime: proj.regime || snap.regime }, checks };
}

function atlasHybrid(rounds, index, calibrationData) {
  const proj = projection(rounds, index, calibrationData);
  if (index < 12) return { decision: "WAIT", source: "NONE", tier: "-", confidence: 0, projection: proj };

  const balancedRow = atlasBalanced(rounds, index, calibrationData);
  const scoutRow = atlasScout(rounds, index, calibrationData);
  const snap = snapshot(rounds, Math.max(24, index)) || {
    compression: rangeRate(rounds, index, 8, 0, 1.5),
    microCompression: rangeRate(rounds, index, 4, 0, 1.35),
    dry15: roundsSince(rounds, index, 1.5),
    shockRisk: rangeRate(rounds, index, 8, 3, null),
    burstRisk: rangeRate(rounds, index, 5, 2, null),
    shortHit15: hitRate(rounds, index, 6),
    vol6: volWindow(rounds, index, 6),
    regime: "NEUTRAL",
  };
  const lastRound = rounds[index - 1]?.multiplier ?? 1;
  const prevRound = rounds[index - 2]?.multiplier ?? 1;
  const immediateClean = lastRound < 5.2 && prevRound < 7.4;
  const lowPressure = rangeRate(rounds, index, 4, 0, 1.5) >= 0;
  const droughtAssist =
    snap.dry15 >= 1 || snap.microCompression >= 0.1 || snap.compression >= 0.18;
  const softDroughtAssist =
    snap.dry15 >= 1 || snap.microCompression >= 0.03 || snap.compression >= 0.1;
  const flowAssist =
    proj.regime !== "SOBRECALENTADO" &&
    (proj.regime === "NEUTRAL" || proj.regime === "RECUPERACION" || proj.regime === "COMPRESION") &&
    softDroughtAssist &&
    snap.shockRisk <= calibrationData.atlas.shockMax + 0.36 &&
    snap.burstRisk <= calibrationData.atlas.burstMax + 0.5 &&
    snap.vol6 <= calibrationData.atlas.vol6Max + 1.1 &&
    proj.score >= 26 &&
    proj.expected >= Math.max((calibrationData.base || 0) - 0.1, 0.33);
  const continuityAssist =
    proj.regime !== "SOBRECALENTADO" &&
    (proj.regime === "NEUTRAL" || proj.regime === "RECUPERACION" || proj.regime === "COMPRESION") &&
    (softDroughtAssist || lowPressure) &&
    lastRound < 7.4 &&
    snap.shockRisk <= calibrationData.atlas.shockMax + 0.68 &&
    snap.burstRisk <= calibrationData.atlas.burstMax + 0.8 &&
    snap.shortHit15 <= Math.max(0.92, calibrationData.atlas.mediumHitMax + 0.42) &&
    snap.vol6 <= calibrationData.atlas.vol6Max + 1.7 &&
    proj.score >= 14 &&
    proj.expected >= Math.max((calibrationData.base || 0) - 0.18, 0.25);
  const recoveryFlowAssist =
    proj.regime !== "SOBRECALENTADO" &&
    (proj.regime === "RECUPERACION" || proj.regime === "NEUTRAL") &&
    (snap.dry15 >= 1 || snap.compression >= 0.06 || snap.microCompression >= 0.01) &&
    snap.shockRisk <= calibrationData.atlas.shockMax + 0.74 &&
    snap.burstRisk <= calibrationData.atlas.burstMax + 0.9 &&
    snap.shortHit15 <= Math.max(0.95, calibrationData.atlas.mediumHitMax + 0.46) &&
    snap.vol6 <= calibrationData.atlas.vol6Max + 1.95 &&
    proj.score >= 11 &&
    proj.expected >= Math.max((calibrationData.base || 0) - 0.2, 0.23);
  const balancedAssist =
    proj.regime !== "SOBRECALENTADO" &&
    (proj.regime === "COMPRESION" || proj.regime === "RECUPERACION" || proj.regime === "NEUTRAL") &&
    (snap.compression >= 0.08 || snap.microCompression >= 0.02 || droughtAssist) &&
    snap.shockRisk <= calibrationData.atlas.shockMax + 0.5 &&
    snap.burstRisk <= calibrationData.atlas.burstMax + 0.62 &&
    snap.shortHit15 <= Math.max(0.86, calibrationData.atlas.mediumHitMax + 0.34) &&
    snap.vol6 <= calibrationData.atlas.vol6Max + 1.28 &&
    proj.score >= 18 &&
    proj.expected >= Math.max((calibrationData.base || 0) - 0.14, 0.28);
  const scoutClean =
    scoutRow.decision === "ENTER" &&
    proj.regime !== "SOBRECALENTADO" &&
    scoutRow.confidence >= 22 &&
    proj.expected >= Math.max((calibrationData.base || 0) - 0.16, 0.27) &&
    (immediateClean || droughtAssist) &&
    (lowPressure || droughtAssist);
  const balancedClean =
    (balancedRow.decision === "ENTER" && balancedRow.confidence >= 26) || balancedAssist;
  const flowClean = flowAssist && (balancedRow.confidence >= 18 || scoutRow.confidence >= 18);
  const continuityClean =
    continuityAssist &&
    (Math.max(balancedRow.confidence, scoutRow.confidence) >= 18 || droughtAssist);
  const recoveryFlowClean =
    recoveryFlowAssist &&
    (Math.max(balancedRow.confidence, scoutRow.confidence) >= 16 || droughtAssist);

  if (balancedClean && scoutClean) {
    return {
      decision: "ENTER",
      source: "DUAL",
      tier: proj.expected >= 0.37 && Math.max(balancedRow.confidence, scoutRow.confidence) >= 42 ? "A" : "B",
      confidence: clamp(Math.max(balancedRow.confidence, scoutRow.confidence, 54) + 6, 0, 100),
      projection: proj,
    };
  }
  if (balancedClean) {
    const tier = balancedRow.decision === "ENTER" && proj.expected >= 0.34 && Math.max(balancedRow.confidence, 36) >= 40 ? "A" : "B";
    return {
      decision: "ENTER",
      source: balancedRow.decision === "ENTER" ? "BALANCED" : "BALANCED-ASSIST",
      tier,
      confidence: Math.max(balancedRow.confidence, 32),
      projection: proj,
    };
  }
  if (scoutClean) {
    return {
      decision: "ENTER",
      source: "SCOUT-LIMPIO",
      tier: proj.expected >= 0.28 && scoutRow.confidence >= 30 ? "B" : "C",
      confidence: scoutRow.confidence,
      projection: proj,
    };
  }
  if (flowClean) {
    return {
      decision: "ENTER",
      source: "FLOW-ASSIST",
      tier: proj.expected >= 0.25 && Math.max(balancedRow.confidence, scoutRow.confidence) >= 26 ? "B" : "C",
      confidence: Math.max(balancedRow.confidence, scoutRow.confidence, 24),
      projection: proj,
    };
  }
  if (continuityClean) {
    return {
      decision: "ENTER",
      source: "CONTINUITY-ASSIST",
      tier: proj.expected >= 0.23 && Math.max(balancedRow.confidence, scoutRow.confidence) >= 24 ? "B" : "C",
      confidence: Math.max(balancedRow.confidence, scoutRow.confidence, 22),
      projection: proj,
    };
  }
  if (recoveryFlowClean) {
    return {
      decision: "ENTER",
      source: "RECOVERY-FLOW",
      tier: proj.expected >= 0.21 && Math.max(balancedRow.confidence, scoutRow.confidence) >= 20 ? "B" : "C",
      confidence: Math.max(balancedRow.confidence, scoutRow.confidence, 20),
      projection: proj,
    };
  }
  return {
    decision: "WAIT",
    source: "NONE",
    tier: "-",
    confidence: Math.max(balancedRow.confidence, scoutRow.confidence),
    projection: proj,
  };
}

function hourlyStats(entries) {
  if (!entries.length) return { perHour: 0, lastHour: 0, last30m: 0 };
  const times = entries.map((entry) => new Date(entry.time).getTime()).filter((time) => Number.isFinite(time));
  if (!times.length) return { perHour: 0, lastHour: 0, last30m: 0 };
  const now = Math.max(...times);
  const first = Math.min(...times);
  const hours = Math.max((now - first) / 3600000, 1 / 60);
  return {
    perHour: entries.length / hours,
    lastHour: times.filter((time) => now - time <= 3600000).length,
    last30m: times.filter((time) => now - time <= 1800000).length,
  };
}

function evalRule(rounds, label, description, predicate) {
  let signals = 0;
  let wins = 0;
  let net = 0;
  let peak = 0;
  let draw = 0;

  for (let i = 0; i < rounds.length; i += 1) {
    if (!predicate(rounds, i)) continue;
    signals += 1;
    const win = rounds[i].multiplier >= 1.5;
    if (win) {
      wins += 1;
      net += 0.5;
    } else {
      net -= 1;
    }
    if (net > peak) peak = net;
    draw = Math.max(draw, peak - net);
  }

  return {
    label,
    description,
    signals,
    hitRate: signals ? wins / signals : 0,
    roi: signals ? net / signals : 0,
    net,
    draw,
  };
}

function blockValidation(rounds, calibrationData) {
  const blockCount = rounds.length >= 240 ? 4 : rounds.length >= 120 ? 3 : 2;
  const blockSize = Math.max(1, Math.floor(rounds.length / blockCount));
  const output = [];

  for (let i = 0; i < blockCount; i += 1) {
    const segment = rounds.slice(i * blockSize, i === blockCount - 1 ? rounds.length : (i + 1) * blockSize);
    if (!segment.length) continue;
    const rule = evalRule(segment, "", "", (data, index) => atlasStrategy(data, index, calibrationData).decision === "ENTER");
    output.push({
      label: `Bloque ${i + 1}`,
      rounds: segment.length,
      signals: rule.signals,
      hitRate: rule.hitRate,
      roi: rule.roi,
      draw: rule.draw,
    });
  }

  return output;
}

function scoreBands(rounds, calibrationData) {
  const bands = [
    ["0-44", 0, 45],
    ["45-61", 45, 62],
    ["62-75", 62, 76],
    ["76-100", 76, 101],
  ].map(([label, min, max]) => ({ label, min, max, op: 0, wins: 0, net: 0 }));

  for (let i = 24; i < rounds.length; i += 1) {
    const score = projection(rounds, i, calibrationData).score;
    const band = bands.find((row) => score >= row.min && score < row.max);
    if (!band) continue;
    band.op += 1;
    if (rounds[i].multiplier >= 1.5) {
      band.wins += 1;
      band.net += 0.5;
    } else {
      band.net -= 1;
    }
  }

  return bands.map((band) => ({
    label: band.label,
    op: band.op,
    hitRate: band.op ? band.wins / band.op : 0,
    roi: band.op ? band.net / band.op : 0,
    net: band.net,
  }));
}

function robustness(rounds, calibrationData, validation, bands) {
  const rule = evalRule(rounds, "", "", (data, index) => atlasStrategy(data, index, calibrationData).decision === "ENTER");
  const positiveBlocks = validation.filter((block) => block.roi > 0).length;
  const stability = validation.length ? positiveBlocks / validation.length : 0;
  const baseline = rounds.length ? rounds.filter((round) => round.multiplier >= 1.5).length / rounds.length : 0;
  const top = bands.find((band) => band.label === "76-100");

  return {
    rule,
    stability,
    positiveBlocks,
    totalBlocks: validation.length,
    baseline,
    topHit: top?.hitRate ?? 0,
    topLift: (top?.hitRate ?? 0) - baseline,
  };
}

function walkForward(rounds) {
  if (rounds.length < 160) {
    return {
      windows: [],
      summary: {
        tests: 0,
        positive: 0,
        stability: 0,
        avgHitRate: 0,
        avgRoi: 0,
      },
    };
  }

  const trainSize = Math.max(100, Math.floor(rounds.length * 0.55));
  const testSize = Math.max(40, Math.floor(rounds.length * 0.2));
  const step = Math.max(25, Math.floor(testSize * 0.6));
  const windows = [];

  for (let start = 0; start + trainSize + testSize <= rounds.length; start += step) {
    const train = rounds.slice(start, start + trainSize);
    const test = rounds.slice(start + trainSize, start + trainSize + testSize);
    const trainCalibration = calibration(train);
    const result = evalRule(
      test,
      "Walk-forward Atlas",
      "",
      (data, index) =>
        atlasStrategy(data, index, trainCalibration).decision === "ENTER" &&
        atlasConsensus(data, index, trainCalibration).pass
    );

    windows.push({
      label: `WF ${windows.length + 1}`,
      train: train.length,
      test: test.length,
      signals: result.signals,
      hitRate: result.hitRate,
      roi: result.roi,
      draw: result.draw,
    });
  }

  return {
    windows,
    summary: {
      tests: windows.length,
      positive: windows.filter((window) => window.roi > 0).length,
      stability: windows.length ? windows.filter((window) => window.roi > 0).length / windows.length : 0,
      avgHitRate: avg(windows.map((window) => window.hitRate)),
      avgRoi: avg(windows.map((window) => window.roi)),
    },
  };
}

function regimeStats(entries) {
  const groups = ["COMPRESION", "RECUPERACION", "NEUTRAL", "EXPANSION", "SOBRECALENTADO"].map((regime) => {
    const sample = entries.filter((entry) => entry.regime === regime);
    const wins = sample.filter((entry) => entry.win).length;
    const net = sample.reduce((sum, entry) => sum + entry.pnl, 0);
    return {
      regime,
      signals: sample.length,
      hitRate: sample.length ? wins / sample.length : 0,
      roi: sample.length ? net / sample.length : 0,
      net,
    };
  });

  return groups.filter((group) => group.signals > 0);
}

function equityStats(entries) {
  let equity = 0;
  let peak = 0;
  let maxDraw = 0;
  const curve = entries.map((entry, index) => {
    equity += entry.pnl;
    peak = Math.max(peak, equity);
    maxDraw = Math.max(maxDraw, peak - equity);
    return {
      index: index + 1,
      equity,
      drawdown: peak - equity,
      pnl: entry.pnl,
      time: entry.time,
    };
  });

  return {
    curve,
    finalEquity: equity,
    peakEquity: peak,
    maxDrawdown: maxDraw,
    bestRun: curve.length ? Math.max(...curve.map((point) => point.equity)) : 0,
    worstDrawdown: maxDraw,
  };
}

function outcomeCounts(entries) {
  const wins = entries.filter((entry) => entry.outcome === "WIN").length;
  const gales = entries.filter((entry) => entry.outcome === "GALE").length;
  const losses = entries.filter((entry) => entry.outcome === "LOSS").length;
  const total = entries.length;
  return {
    total,
    wins,
    gales,
    losses,
    successRate: total ? (wins + gales) / total : 0,
    directWinRate: total ? wins / total : 0,
  };
}

function resolveHybridOperations(rawEntries, rounds = [], calibrationData = null, executionConfig = HYBRID_EXECUTION) {
  const orderedEntries = rawEntries
    .slice()
    .sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
  const orderedRounds = rounds
    .slice()
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  const consumedEntryIndexes = new Set();
  const galeCalibration = calibrationData || calibration(orderedRounds);

  const findGaleEntry = (minTime) =>
    orderedEntries.findIndex((candidate, index) => {
      if (consumedEntryIndexes.has(index)) return false;
      const candidateMs = new Date(candidate.time || 0).getTime();
      return Number.isFinite(candidateMs) && candidateMs >= minTime;
    });

  const findGaleCandidate = (minTime, existingOperations) => {
    for (let i = 12; i < orderedRounds.length; i += 1) {
      const roundTime = new Date(orderedRounds[i].createdAt || 0).getTime();
      if (!Number.isFinite(roundTime) || roundTime < minTime) continue;

      const hybridRow = atlasHybrid(orderedRounds, i, galeCalibration);
      if (hybridRow.decision !== "ENTER") continue;

      const candidate = {
        time: orderedRounds[i].createdAt,
        score: hybridRow.projection.score,
        confidence: hybridRow.confidence,
        consensus: hybridRow.source === "DUAL" ? 100 : hybridRow.source === "BALANCED" ? 72 : 58,
        expected: hybridRow.projection.expected,
        actual: orderedRounds[i].multiplier,
        regime: hybridRow.projection.regime,
        sourceMode: hybridRow.source,
        tier: hybridRow.tier,
        win: orderedRounds[i].multiplier >= executionConfig.targetMultiplier,
        pnl: orderedRounds[i].multiplier >= executionConfig.targetMultiplier ? executionConfig.directWinPnl : -1,
      };

      if (!shouldAcceptHybridEntry(existingOperations, candidate, orderedRounds.length)) continue;
      return candidate;
    }

    return null;
  };

  const operations = [];
  let nextAllowedMs = -Infinity;
  let pendingGale = null;

  for (let index = 0; index < orderedEntries.length; index += 1) {
    if (consumedEntryIndexes.has(index)) continue;
    const entry = orderedEntries[index];
    const entryMs = new Date(entry.time || 0).getTime();
    if (!Number.isFinite(entryMs)) continue;
    if (entryMs < nextAllowedMs) continue;

    if ((entry.actual ?? 0) >= executionConfig.targetMultiplier) {
        operations.push({
          ...entry,
          resolvedAt: entry.time,
          timeDisplay: fmtDateTime(entry.time),
          actualDisplay: `${entry.actual.toFixed(2)}x`,
          attempts: 1,
          outcome: "WIN",
          win: true,
          pnl: executionConfig.directWinPnl,
        });
      nextAllowedMs = entryMs + executionConfig.minGapMs;
      continue;
    }

    const galeAtMs = entryMs + executionConfig.minGapMs;
    let galeEntry = null;
    const galeCandidate = findGaleCandidate(galeAtMs, operations);
    if (galeCandidate) {
      galeEntry = galeCandidate;
      const galeIndex = findGaleEntry(new Date(galeCandidate.time || 0).getTime());
      if (galeIndex !== -1) consumedEntryIndexes.add(galeIndex);
    }

    if (!galeEntry) {
      pendingGale = {
        ...entry,
        waitingGale: true,
        galeAt: new Date(galeAtMs).toISOString(),
        elapsedMs: Math.max(0, Date.now() - entryMs),
      };
      break;
    }

    const galeResolvedMs = new Date(galeEntry.time || 0).getTime();
    const galeSucceeded = galeEntry.actual >= executionConfig.targetMultiplier;
    operations.push({
      ...entry,
      resolvedAt: galeEntry.time,
      timeDisplay: `${fmtDateTime(entry.time)} -> ${fmtDateTime(galeEntry.time)}`,
      actual: galeEntry.actual,
      actualDisplay: `${entry.actual.toFixed(2)}x -> ${galeEntry.actual.toFixed(2)}x`,
      attempts: 2,
      galeActual: galeEntry.actual,
      galeTime: galeEntry.time,
      galeSourceMode: galeEntry.sourceMode,
      sourceMode: `${entry.sourceMode} + GALE`,
      outcome: galeSucceeded ? "GALE" : "LOSS",
      win: galeSucceeded,
      pnl: galeSucceeded ? executionConfig.galeWinPnl : executionConfig.fullLossPnl,
    });
    nextAllowedMs = galeResolvedMs + executionConfig.minGapMs;
  }

  return { operations, pendingGale };
}

function buildReport(data) {
  const strengths = [];
  const cautions = [];

  if (data.rob.stability >= 0.6) strengths.push("Atlas mantiene buena estabilidad por bloques.");
  if (data.wf.summary.stability >= 0.5) strengths.push("La validacion walk-forward muestra consistencia fuera de muestra.");
  if (data.entryStats.winRate >= Math.max(data.rob.baseline + 0.05, 0.5)) strengths.push("Las entradas filtradas superan claramente el baseline general.");
  if (data.hybridSources?.balanced > 0) strengths.push("HYBRID esta aprovechando la limpieza de Balanced como base principal.");
  if (data.hybridSources?.scout > 0 || data.hybridSources?.dual > 0) strengths.push("HYBRID tambien esta sumando frecuencia util desde Scout limpio.");
  if (data.rob.topLift >= 0.03) strengths.push("La banda premium conserva lift positivo frente al historico total.");
  if (data.equity.maxDrawdown <= 4) strengths.push("La curva de equity sigue contenida en drawdown.");

  if (data.rounds.length < 220) cautions.push("La muestra todavia es corta para una lectura premium totalmente confiable.");
  if (data.wf.summary.stability < 0.5) cautions.push("El walk-forward todavia no demuestra consistencia suficiente.");
  if (data.rob.rule.draw > 4.5) cautions.push("La presion del drawdown sigue siendo elevada.");
  if (data.hybrid?.projection?.regime === "SOBRECALENTADO" || data.proj.regime === "SOBRECALENTADO") cautions.push("El regimen actual viene sobrecalentado y HYBRID prefiere esperar.");
  if (data.entryStats.total < 20) cautions.push("Aun hay pocas entradas aprobadas para juzgar el modelo con comodidad.");

  const verdict =
    data.prem.mode === "OPERABLE" && data.consensus.pass
      ? "Atlas esta alineado para operar de forma experimental."
      : data.prem.mode === "OBSERVACION"
        ? "Atlas esta en observacion: hay estructura, pero aun no hay alineacion total."
        : "Atlas permanece bloqueado hasta que el contexto y la validacion converjan mejor.";

  return {
    verdict,
    strengths: strengths.length ? strengths : ["Atlas todavia no acumula suficientes fortalezas contundentes."],
    cautions: cautions.length ? cautions : ["No se observan alertas criticas inmediatas."],
  };
}

function premium(rounds, data) {
  const checks = [
    ["Muestra minima", rounds.length >= 220, `${rounds.length} / 220`],
    ["Regimen fuerte", data.proj.regime === "COMPRESION" || data.proj.regime === "RECUPERACION", data.proj.regime],
    ["Decision alineada", data.strategy.decision === "ENTER" && data.strategy.confidence >= 74, `${data.strategy.decision} · ${data.strategy.confidence.toFixed(0)}%`],
    ["Consenso Atlas", data.consensus.pass && data.consensus.score >= 72, `${data.consensus.score.toFixed(0)}%`],
    ["Ventaja contextual", data.proj.expected >= Math.max(data.robustness.baseline + 0.04, 0.5), fmtPct(data.proj.expected)],
    ["Estabilidad", data.robustness.stability >= 0.5, fmtPct(data.robustness.stability)],
    ["Drawdown sano", data.robustness.rule.draw <= 4.5, `${data.robustness.rule.draw.toFixed(2)}u`],
  ].map(([label, passed, detail]) => ({ label, passed, detail }));

  const passed = checks.filter((check) => check.passed).length;
  const readiness = Math.round((passed / checks.length) * 100);
  let mode = "BLOQUEADO";
  let tone = "bad";
  if (passed >= 5 && data.strategy.decision === "ENTER") {
    mode = "OPERABLE";
    tone = "good";
  } else if (passed >= 3) {
    mode = "OBSERVACION";
    tone = "warn";
  }

  const warnings = [];
  if (rounds.length < 220) warnings.push("La muestra sigue corta para una lectura premium.");
  if (data.robustness.stability < 0.5) warnings.push("Atlas aun no es consistente por bloques.");
  if (data.proj.regime === "SOBRECALENTADO") warnings.push("El mercado viene sobrecalentado; Atlas evita perseguir picos.");

  return { mode, tone, readiness, checks, warnings };
}

function build(roundsRaw) {
  const rounds = [...roundsRaw].reverse();
  const calibrationData = calibration(rounds);
  const calibrationData17 = calibration17(rounds);
  const proj = projection(rounds, rounds.length, calibrationData);
  const strategy = atlasStrategy(rounds, rounds.length, calibrationData);
  const balanced = atlasBalanced(rounds, rounds.length, calibrationData);
  const scout = atlasScout(rounds, rounds.length, calibrationData);
  const consensus = atlasConsensus(rounds, rounds.length, calibrationData);
  const validation = blockValidation(rounds, calibrationData);
  const wf = walkForward(rounds);
  const bands = scoreBands(rounds, calibrationData);
  const rob = robustness(rounds, calibrationData, validation, bands);
  const prem = premium(rounds, { proj, strategy, consensus, robustness: rob });
  const entries = [];
  const hybrid17Entries = [];
  const balancedEntries = [];
  const scoutEntries = [];
  const strictEntries = [];

  for (let i = 24; i < rounds.length; i += 1) {
    const decision = atlasStrategy(rounds, i, calibrationData);
    const consensusRow = atlasConsensus(rounds, i, calibrationData);
    const balancedRow = atlasBalanced(rounds, i, calibrationData);
    const scoutRow = atlasScout(rounds, i, calibrationData);
    if (decision.decision !== "ENTER" || !consensusRow.pass) continue;
    strictEntries.push({
      time: rounds[i].createdAt,
      score: decision.projection.score,
      confidence: decision.confidence,
      consensus: consensusRow.score,
      expected: decision.projection.expected,
      actual: rounds[i].multiplier,
      regime: decision.projection.regime,
      win: rounds[i].multiplier >= 1.5,
      pnl: rounds[i].multiplier >= 1.5 ? 0.5 : -1,
    });
    if (balancedRow.decision === "ENTER") {
      balancedEntries.push({
        time: rounds[i].createdAt,
        score: balancedRow.projection.score,
        confidence: balancedRow.confidence,
        expected: balancedRow.projection.expected,
        actual: rounds[i].multiplier,
        regime: balancedRow.projection.regime,
        win: rounds[i].multiplier >= 1.5,
        pnl: rounds[i].multiplier >= 1.5 ? 0.5 : -1,
      });
    }
  }

  for (let i = 24; i < rounds.length; i += 1) {
    const balancedRow = atlasBalanced(rounds, i, calibrationData);
    if (balancedRow.decision !== "ENTER") continue;
    if (balancedEntries.find((entry) => entry.time === rounds[i].createdAt && entry.actual === rounds[i].multiplier)) continue;
    balancedEntries.push({
      time: rounds[i].createdAt,
      score: balancedRow.projection.score,
      confidence: balancedRow.confidence,
      expected: balancedRow.projection.expected,
      actual: rounds[i].multiplier,
      regime: balancedRow.projection.regime,
      win: rounds[i].multiplier >= 1.5,
      pnl: rounds[i].multiplier >= 1.5 ? 0.5 : -1,
    });
  }

  for (let i = 8; i < rounds.length; i += 1) {
    const scoutRow = atlasScout(rounds, i, calibrationData);
    if (scoutRow.decision !== "ENTER") continue;
    scoutEntries.push({
      time: rounds[i].createdAt,
      score: scoutRow.projection.score,
      confidence: scoutRow.confidence,
      expected: scoutRow.projection.expected,
      actual: rounds[i].multiplier,
      regime: scoutRow.projection.regime,
      win: rounds[i].multiplier >= 1.5,
      pnl: rounds[i].multiplier >= 1.5 ? 0.5 : -1,
    });
  }

  for (let i = 12; i < rounds.length; i += 1) {
    const hybridRow = atlasHybrid(rounds, i, calibrationData);
    if (hybridRow.decision !== "ENTER") continue;
    const candidate = {
      time: rounds[i].createdAt,
      score: hybridRow.projection.score,
      confidence: hybridRow.confidence,
      consensus: hybridRow.source === "DUAL" ? 100 : hybridRow.source === "BALANCED" ? 72 : 58,
      expected: hybridRow.projection.expected,
      actual: rounds[i].multiplier,
      regime: hybridRow.projection.regime,
      sourceMode: hybridRow.source,
      tier: hybridRow.tier,
      win: rounds[i].multiplier >= 1.5,
      pnl: rounds[i].multiplier >= 1.5 ? 0.5 : -1,
    };
    if (!shouldAcceptHybridEntry(entries, candidate, rounds.length)) continue;
    entries.push(candidate);
  }

  for (let i = 16; i < rounds.length; i += 1) {
    const hybridRow17 = atlasHybrid17(rounds, i, calibrationData17);
    if (hybridRow17.decision !== "ENTER") continue;
    const candidate17 = {
      time: rounds[i].createdAt,
      score: hybridRow17.projection.score,
      confidence: hybridRow17.confidence,
      consensus: hybridRow17.tier === "A" ? 92 : hybridRow17.tier === "B" ? 78 : 64,
      expected: hybridRow17.projection.expected,
      actual: rounds[i].multiplier,
      regime: hybridRow17.projection.regime,
      sourceMode: hybridRow17.source,
      tier: hybridRow17.tier,
      win: rounds[i].multiplier >= 1.7,
      pnl: rounds[i].multiplier >= 1.7 ? 0.85 : -1,
    };
    if (!shouldAcceptHybrid17Entry(hybrid17Entries, candidate17, rounds.length)) continue;
    hybrid17Entries.push(candidate17);
  }

  const entryStats = {
    total: entries.length,
    wins: entries.filter((entry) => entry.win).length,
    winRate: entries.length ? entries.filter((entry) => entry.win).length / entries.length : 0,
    roi: entries.length ? entries.reduce((sum, entry) => sum + entry.pnl, 0) / entries.length : 0,
  };
  const balancedStats = {
    total: balancedEntries.length,
    wins: balancedEntries.filter((entry) => entry.win).length,
    winRate: balancedEntries.length ? balancedEntries.filter((entry) => entry.win).length / balancedEntries.length : 0,
    roi: balancedEntries.length ? balancedEntries.reduce((sum, entry) => sum + entry.pnl, 0) / balancedEntries.length : 0,
  };
  const scoutStats = {
    total: scoutEntries.length,
    wins: scoutEntries.filter((entry) => entry.win).length,
    winRate: scoutEntries.length ? scoutEntries.filter((entry) => entry.win).length / scoutEntries.length : 0,
    roi: scoutEntries.length ? scoutEntries.reduce((sum, entry) => sum + entry.pnl, 0) / scoutEntries.length : 0,
  };
  const cadence = {
    hybrid: hourlyStats(entries),
    balanced: hourlyStats(balancedEntries),
    scout: hourlyStats(scoutEntries),
  };
  const cycles = {
    hybrid: cycleStats(entries, "HYBRID"),
    balanced: cycleStats(balancedEntries, "BALANCED"),
    scout: cycleStats(scoutEntries, "SCOUT"),
  };
  const openCycles = {
    hybrid: cycles.hybrid.find((cycle) => cycle.records < 50) || null,
    balanced: cycles.balanced.find((cycle) => cycle.records < 50) || null,
    scout: cycles.scout.find((cycle) => cycle.records < 50) || null,
  };
  const daily = {
    hybrid: dailyStats(entries, "HYBRID"),
    balanced: dailyStats(balancedEntries, "BALANCED"),
    scout: dailyStats(scoutEntries, "SCOUT"),
  };
  const gainCycles = profitCycles(entries, 5);
  const currentGainCycle = currentProfitCycleState(entries, 5);
  const regimes = regimeStats(entries);
  const balancedRegimes = regimeStats(balancedEntries);
  const scoutRegimes = regimeStats(scoutEntries);
  const equity = equityStats(entries);
  const balancedEquity = equityStats(balancedEntries);
  const scoutEquity = equityStats(scoutEntries);

  const rules = [
    evalRule(rounds, "Compresion seca", "Requiere compresion >= 62%, sequia util y sin pico 5x cercano.", (data, index) => {
      const snap = snapshot(data, index);
      return !!snap && snap.compression >= calibrationData.atlas.compressionMin && snap.dry15 >= calibrationData.atlas.dry15Min && snap.dry5 >= calibrationData.atlas.dry5Min;
    }),
    evalRule(rounds, "Recuperacion limpia", "Busca rebote corto sin sobrecalentamiento ni burst reciente.", (data, index) => {
      const snap = snapshot(data, index);
      const projRow = projection(data, index, calibrationData);
      return !!snap && projRow.regime === "RECUPERACION" && snap.shockRisk <= calibrationData.atlas.shockMax && snap.burstRisk <= calibrationData.atlas.burstMax;
    }),
    evalRule(rounds, "Ventana premium", "Solo activa contextos Atlas con score >= 76.", (data, index) => {
      return projection(data, index, calibrationData).score >= calibrationData.atlas.scoreEnter;
    }),
    evalRule(rounds, "Motor Atlas 1.5x", "Modelo propio por regimenes, compresion, consenso y enfriamiento.", (data, index) => {
      return atlasStrategy(data, index, calibrationData).decision === "ENTER" && atlasConsensus(data, index, calibrationData).pass;
    }),
    evalRule(rounds, "Atlas Balanced", "VersiÃ³n mÃ¡s operativa con filtros mÃ¡s flexibles y mayor frecuencia.", (data, index) => {
      return atlasBalanced(data, index, calibrationData).decision === "ENTER";
    }),
    evalRule(rounds, "Atlas Scout", "Modo exploratorio para generar mÃ¡s entradas medibles sin perseguir picos extremos.", (data, index) => {
      return atlasScout(data, index, calibrationData).decision === "ENTER";
    }),
  ].sort((a, b) => b.roi - a.roi);

  const hybrid = atlasHybrid(rounds, rounds.length, calibrationData);
  const hybridSources = {
    dual: entries.filter((entry) => entry.sourceMode === "DUAL").length,
    balanced: entries.filter((entry) => entry.sourceMode === "BALANCED").length,
    scout: entries.filter((entry) => entry.sourceMode === "SCOUT-LIMPIO").length,
  };
  const report = buildReport({ rounds, proj, strategy, balanced, scout, hybrid, consensus, validation, wf, bands, rob, prem, entries, strictEntries, entryStats, balancedEntries, balancedStats, scoutEntries, scoutStats, cadence, cycles, openCycles, daily, gainCycles, currentGainCycle, regimes, balancedRegimes, scoutRegimes, rules, calibrationData, equity, balancedEquity, scoutEquity, hybridSources });
  const signal = buildLiveSignal({ proj, strategy, balanced, scout, hybrid, consensus, entries, balancedEntries, scoutEntries });

  return { rounds, proj, strategy, balanced, scout, hybrid, strictEntries, hybridSources, consensus, signal, validation, wf, bands, rob, prem, entries, hybrid17Candidates: hybrid17Entries, entryStats, balancedEntries, balancedStats, scoutEntries, scoutStats, cadence, cycles, openCycles, daily, gainCycles, currentGainCycle, regimes, balancedRegimes, scoutRegimes, rules, calibrationData, calibrationData17, equity, balancedEquity, scoutEquity, report };
}

function table(id, headers, rows) {
  document.getElementById(id).innerHTML = `<table><thead><tr>${headers
    .map((header) => `<th>${header}</th>`)
    .join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function entryRows(entries) {
  return entries
    .slice()
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
    .slice(0, 50)
    .map(
      (entry) =>
        `<tr><td>${entry.timeDisplay || fmtDateTime(entry.time)}</td><td>${entry.tier || "-"}</td><td>${entry.sourceMode || "-"}</td><td>${entry.regime}</td><td class="mono">${entry.score.toFixed(0)}</td><td class="mono">${entry.confidence.toFixed(0)}%</td><td class="mono">${entry.consensus ? entry.consensus.toFixed(0) : 0}%</td><td class="mono">${fmtPct(
          entry.expected
        )}</td><td class="mono ${entry.outcome === "LOSS" ? "miss" : entry.outcome === "GALE" || entry.outcome === "PENDING" ? "warn" : "hit"}">${entry.actualDisplay || `${entry.actual.toFixed(2)}x`}</td><td class="${
          entry.outcome === "LOSS" ? "miss" : entry.outcome === "GALE" || entry.outcome === "PENDING" ? "warn" : "hit"
        }">${entry.outcome || (entry.win ? "WIN" : "LOSS")}</td><td class="mono ${
          entry.pnl > 0 ? "good" : entry.pnl < 0 ? "bad" : "warn"
        }">${fmtUnits(entry.pnl)}</td></tr>`
    );
}

function visibleEntryStats(entries) {
  const sample = entries
    .slice()
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
    .slice(0, 50);
  const counts = outcomeCounts(sample);
  const net = sample.reduce((sum, entry) => sum + entry.pnl, 0);
  return {
    total: counts.total,
    wins: counts.wins,
    gales: counts.gales,
    losses: counts.losses,
    winRate: counts.directWinRate,
    successRate: counts.successRate,
    net,
  };
}

function cycleStats(entries, modeLabel) {
  const ordered = entries
    .slice()
    .sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));

  const cycles = [];
  for (let start = 0; start < ordered.length; start += 50) {
    const chunk = ordered.slice(start, start + 50);
    if (!chunk.length) continue;
    const counts = outcomeCounts(chunk);
    const net = chunk.reduce((sum, entry) => sum + entry.pnl, 0);
    cycles.push({
      mode: modeLabel,
      cycle: Math.floor(start / 50) + 1,
      records: chunk.length,
      wins: counts.wins,
      gales: counts.gales,
      losses: counts.losses,
      winRate: counts.directWinRate,
      successRate: counts.successRate,
      net,
      oldest: chunk[0]?.time ?? null,
      newest: chunk[chunk.length - 1]?.time ?? null,
    });
  }

  return cycles.sort((a, b) => b.cycle - a.cycle);
}

function dailyStats(entries, modeLabel) {
  const grouped = new Map();
  entries.forEach((entry) => {
    const time = new Date(entry.time || 0);
    if (Number.isNaN(time.getTime())) return;
    const key = dayKey(entry.time);
    const current = grouped.get(key) || {
      mode: modeLabel,
      key,
      day: dayLabel(entry.time),
      total: 0,
      wins: 0,
      gales: 0,
      losses: 0,
      net: 0,
      newest: null,
      oldest: null,
    };
    current.total += 1;
    current.wins += entry.outcome === "WIN" ? 1 : 0;
    current.gales += entry.outcome === "GALE" ? 1 : 0;
    current.losses += entry.outcome === "LOSS" ? 1 : 0;
    current.net += entry.pnl;
    current.newest = !current.newest || new Date(entry.time) > new Date(current.newest) ? entry.time : current.newest;
    current.oldest = !current.oldest || new Date(entry.time) < new Date(current.oldest) ? entry.time : current.oldest;
    grouped.set(key, current);
  });

  return [...grouped.values()]
    .map((row) => ({
      ...row,
      winRate: row.total ? row.wins / row.total : 0,
      successRate: row.total ? (row.wins + row.gales) / row.total : 0,
    }))
    .sort((a, b) => new Date(b.newest || 0) - new Date(a.newest || 0));
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes} min`;
  return `${hours}h ${minutes}m`;
}

function profitCycles(entries, targetNet = 5) {
  const ordered = entries
    .slice()
    .sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));

  const completed = [];
  let buffer = [];
  let net = 0;

  for (const entry of ordered) {
    buffer.push(entry);
    net += entry.pnl;

    if (net >= targetNet) {
      const counts = outcomeCounts(buffer);
      const startedAt = buffer[0]?.time ?? null;
      const completedAt = buffer[buffer.length - 1]?.resolvedAt ?? buffer[buffer.length - 1]?.time ?? null;
      completed.push({
        cycle: completed.length + 1,
        startedAt,
        completedAt,
        durationMs: startedAt && completedAt ? new Date(completedAt).getTime() - new Date(startedAt).getTime() : 0,
        entries: buffer.length,
        wins: counts.wins,
        gales: counts.gales,
        losses: counts.losses,
        net,
        avgPerEntry: buffer.length ? net / buffer.length : 0,
      });
      buffer = [];
      net = 0;
    }
  }

  return completed.sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
}

function currentProfitCycleState(entries, targetNet = 5) {
  const ordered = entries
    .slice()
    .sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));

  let buffer = [];
  let net = 0;

  for (const entry of ordered) {
    buffer.push(entry);
    net += entry.pnl;
    if (net >= targetNet) {
      buffer = [];
      net = 0;
    }
  }

  const startedAt = buffer[0]?.time ?? null;
  const lastAt = buffer[buffer.length - 1]?.resolvedAt ?? buffer[buffer.length - 1]?.time ?? null;
  const counts = outcomeCounts(buffer);
  return {
    net,
    entries: buffer.length,
    wins: counts.wins,
    gales: counts.gales,
    losses: counts.losses,
    startedAt,
    lastAt,
    durationMs: startedAt && lastAt ? new Date(lastAt).getTime() - new Date(startedAt).getTime() : 0,
  };
}

function hybridBucketPerformance(entries, candidate, size = 40) {
  const sample = entries
    .filter((entry) => entry.tier === candidate.tier && entry.sourceMode === candidate.sourceMode)
    .slice(-size);
  const wins = sample.filter((entry) => entry.win).length;
  const net = sample.reduce((sum, entry) => sum + entry.pnl, 0);
  return {
    total: sample.length,
    winRate: sample.length ? wins / sample.length : 0,
    roi: sample.length ? net / sample.length : 0,
    net,
  };
}

function hybridSourcePerformance(entries, candidate, size = 40) {
  const sample = entries
    .filter((entry) => entry.sourceMode === candidate.sourceMode)
    .slice(-size);
  const wins = sample.filter((entry) => entry.win).length;
  const net = sample.reduce((sum, entry) => sum + entry.pnl, 0);
  return {
    total: sample.length,
    winRate: sample.length ? wins / sample.length : 0,
    roi: sample.length ? net / sample.length : 0,
    net,
  };
}

function hybridTierPerformance(entries, tier, size = 60) {
  const sample = entries.filter((entry) => entry.tier === tier).slice(-size);
  const wins = sample.filter((entry) => entry.win).length;
  const net = sample.reduce((sum, entry) => sum + entry.pnl, 0);
  return {
    total: sample.length,
    winRate: sample.length ? wins / sample.length : 0,
    roi: sample.length ? net / sample.length : 0,
    net,
  };
}

function minutesSinceLastEntry(entries, currentTime) {
  if (!entries.length || !currentTime) return Infinity;
  const last = entries[entries.length - 1]?.time;
  const currentMs = new Date(currentTime).getTime();
  const lastMs = new Date(last || 0).getTime();
  if (!Number.isFinite(currentMs) || !Number.isFinite(lastMs)) return Infinity;
  return Math.max(0, (currentMs - lastMs) / 60000);
}

function shouldAcceptHybridEntry(existingEntries, candidate, totalRounds = 0) {
  if (!candidate) return false;

  const recent = recentQuality(existingEntries, 12);
  const bucket = hybridBucketPerformance(existingEntries, candidate, 40);
  const source = hybridSourcePerformance(existingEntries, candidate, 40);
  const tierPerf = hybridTierPerformance(existingEntries, candidate.tier, 60);
  const cycle = currentProfitCycleState(existingEntries, 5);
  const idleMinutes = minutesSinceLastEntry(existingEntries, candidate.time);
  const matureSample = totalRounds >= 5000;
  const longDrought = idleMinutes >= (matureSample ? 0.5 : 1.5);
  const forcedFlow = idleMinutes >= (matureSample ? 1.5 : 3);
  const cycleSlow =
    cycle.entries >= 1 &&
    cycle.net < 2 &&
    cycle.durationMs >= 3 * 60000;
  const cycleVerySlow =
    cycle.entries >= 3 &&
    cycle.net < 1.5 &&
    cycle.durationMs >= 6 * 60000;
  const cycleStalled =
    cycle.entries >= 4 &&
    cycle.net < 1 &&
    cycle.durationMs >= 8 * 60000;
  const bucketPositive = bucket.total < 8 || bucket.roi >= (matureSample ? -0.56 : -0.38) || bucket.winRate >= (matureSample ? 0.22 : 0.28);
  const bucketStrong = bucket.total < 8 || bucket.roi >= (matureSample ? -0.04 : -0.01) || bucket.winRate >= (matureSample ? 0.49 : 0.51);
  const sourceStable = source.total < 8 || source.roi >= (matureSample ? -0.52 : -0.34) || source.winRate >= (matureSample ? 0.24 : 0.3);
  const sourceStrong = source.total < 8 || source.roi >= (matureSample ? -0.02 : 0) || source.winRate >= (matureSample ? 0.5 : 0.52);
  const tierStrong = tierPerf.total < 10 || tierPerf.roi >= (matureSample ? -0.03 : 0) || tierPerf.winRate >= (matureSample ? 0.5 : 0.52);
  const isAssist = candidate.sourceMode === "BALANCED-ASSIST";
  const isFlowAssist = candidate.sourceMode === "FLOW-ASSIST" || candidate.sourceMode === "CONTINUITY-ASSIST";

  if (candidate.tier === "A") {
    return (
      sourceStrong &&
      tierStrong &&
      candidate.expected >= 0.43 &&
      candidate.confidence >= 54 &&
      (recent.total < 6 || recent.roi >= -0.14 || recent.winRate >= 0.42 || cycleSlow || longDrought)
    );
  }

  if (candidate.tier === "B") {
    return (
      bucketPositive &&
      (sourceStable || isFlowAssist || forcedFlow) &&
      (
        recent.total < 6 ||
        recent.roi >= (matureSample ? -0.78 : -0.58) ||
        recent.winRate >= (matureSample ? 0.16 : 0.24) ||
        idleMinutes >= (matureSample ? 0.1 : 0.35) ||
        cycleSlow ||
        cycleStalled ||
        (longDrought && candidate.expected >= 0.2 && candidate.confidence >= 24) ||
        (forcedFlow && candidate.expected >= 0.18 && candidate.confidence >= 22)
      )
    );
  }

  return (
    candidate.tier === "C" &&
    bucketPositive &&
    (!isAssist || longDrought || forcedFlow) &&
    (idleMinutes >= (matureSample ? 0.15 : 0.5) || cycleVerySlow || cycleStalled || longDrought || forcedFlow) &&
    (sourceStable || isFlowAssist || longDrought || forcedFlow) &&
    (
      recent.total < 6 ||
      (recent.winRate >= (matureSample ? 0.14 : 0.2) && recent.roi >= (matureSample ? -0.76 : -0.54)) ||
      longDrought ||
      forcedFlow
    )
  );
}

function calibration17(rounds) {
  const points = [];
  for (let i = 24; i < rounds.length; i += 1) {
    const snap = snapshot(rounds, i);
    if (!snap) continue;
    points.push({
      ...snap,
      hit: rounds[i].multiplier >= 1.7 ? 1 : 0,
    });
  }

  if (!points.length) {
    return {
      base: 0,
      entryBase: 0,
      atlas: {
        compressionMin: 0.46,
        shockMax: 0.24,
        burstMax: 0.22,
        dry15Min: 1,
        dry15Max: 10,
        dry5Min: 3,
        mediumHitMax: 0.54,
        vol6Max: 1.42,
        biasAbsMax: 0.2,
        scoreEnter: 66,
      },
    };
  }

  const winners = points.filter((point) => point.hit === 1);
  const strong = winners.filter((point) => point.regime === "COMPRESION" || point.regime === "RECUPERACION");
  const basePool = strong.length >= 18 ? strong : winners.length >= 18 ? winners : points;
  const losers = points.filter((point) => point.hit === 0);

  const atlas = {
    compressionMin: clamp(percentile(basePool.map((point) => point.compression), 0.35, 0.46), 0.3, 0.74),
    shockMax: clamp(percentile(basePool.map((point) => point.shockRisk), 0.74, 0.24), 0.06, 0.34),
    burstMax: clamp(percentile(basePool.map((point) => point.burstRisk), 0.74, 0.22), 0.06, 0.34),
    dry15Min: Math.round(clamp(percentile(basePool.map((point) => point.dry15), 0.3, 1), 1, 5)),
    dry15Max: Math.round(clamp(percentile(basePool.map((point) => point.dry15), 0.92, 10), 4, 14)),
    dry5Min: Math.round(clamp(percentile(basePool.map((point) => point.dry5), 0.3, 3), 1, 8)),
    mediumHitMax: clamp(percentile(basePool.map((point) => point.mediumHit15), 0.78, 0.54), 0.22, 0.66),
    vol6Max: clamp(percentile(basePool.map((point) => point.vol6), 0.8, 1.42), 0.7, 1.95),
    biasAbsMax: clamp(percentile(basePool.map((point) => Math.abs(point.recoveryBias)), 0.8, 0.2), 0.1, 0.32),
    scoreEnter: 66,
  };

  const loserCompression = percentile(losers.map((point) => point.compression), 0.7, atlas.compressionMin);
  atlas.compressionMin = clamp((atlas.compressionMin + loserCompression) / 2, atlas.compressionMin, 0.82);

  return {
    base: avg(points.map((point) => point.hit)),
    entryBase:
      avg(points.filter((point) => point.regime === "COMPRESION" || point.regime === "RECUPERACION").map((point) => point.hit)) ||
      0,
    atlas,
  };
}

function projection17(rounds, index, calibrationData) {
  if (index < 24) {
    return {
      score: 0,
      label: "Insuficiente",
      tone: "",
      expected: 0,
      summary: "Aun no hay suficientes rondas para activar el filtro 1.7x.",
      regime: "INSUFICIENTE",
    };
  }

  const snap = snapshot(rounds, index);
  const adaptive = calibrationData.atlas;
  let score = 30;

  score += clamp(snap.compression * 34, 0, 34);
  score += clamp(snap.microCompression * 14, 0, 14);
  score += clamp((snap.dry15 - 1) * 6, 0, 20);
  score += clamp((snap.dry5 - 2) * 3, 0, 14);
  score += clamp((0.46 - snap.mediumHit15) * 28, -14, 18);
  score += clamp((0.52 - snap.longHit15) * 18, -12, 14);
  score += clamp((0.16 - Math.abs(snap.recoveryBias)) * 46, -10, 9);
  score += clamp((0.18 - Math.abs(snap.drift)) * 26, -10, 8);
  score += clamp((1.1 - snap.vol6) * 14, -12, 12);
  score -= clamp(snap.shockRisk * 28, 0, 18);
  score -= clamp(snap.burstRisk * 18, 0, 12);
  score -= snap.dry5 <= 2 ? 6 : 0;
  score += snap.regime === "COMPRESION" ? 14 : snap.regime === "RECUPERACION" ? 18 : snap.regime === "NEUTRAL" ? 6 : -10;
  score += snap.compression >= adaptive.compressionMin ? 6 : -6;
  score += snap.shockRisk <= adaptive.shockMax ? 6 : -8;
  score += snap.burstRisk <= adaptive.burstMax ? 4 : -6;
  score += snap.mediumHit15 <= adaptive.mediumHitMax ? 5 : -5;
  score += snap.vol6 <= adaptive.vol6Max ? 5 : -5;
  score += Math.abs(snap.recoveryBias) <= adaptive.biasAbsMax ? 4 : -4;
  score = clamp(score, 0, 100);

  const base = Math.max(calibrationData.entryBase || 0, calibrationData.base || 0);
  const expected = clamp(base + ((score - 50) / 100) * 0.3 + (snap.regime === "RECUPERACION" ? 0.04 : 0), 0, 0.86);
  const label = score >= 72 ? "Ventana 1.7 Premium" : score >= 50 ? "Ventana 1.7 Selectiva" : "Sin ventaja 1.7";
  const tone = score >= 72 ? "good" : score >= 50 ? "warn" : "bad";
  return { score, label, tone, expected, summary: "Filtro especifico para buscar recorrido a 1.7x.", regime: snap.regime };
}

function atlasHybrid17(rounds, index, calibrationData) {
  const proj = projection17(rounds, index, calibrationData);
  if (index < 12) return { decision: "WAIT", source: "NONE", tier: "-", confidence: 0, projection: proj };

  const snap = snapshot(rounds, index);
  if (!snap || (proj.regime === "SOBRECALENTADO" && snap.shockRisk > calibrationData.atlas.shockMax + 0.1)) {
    return { decision: "WAIT", source: "NONE", tier: "-", confidence: 0, projection: proj };
  }

  const checks = [
    snap.compression >= calibrationData.atlas.compressionMin,
    snap.dry15 >= calibrationData.atlas.dry15Min && snap.dry15 <= calibrationData.atlas.dry15Max,
    snap.dry5 >= calibrationData.atlas.dry5Min,
    snap.shockRisk <= calibrationData.atlas.shockMax + 0.18,
    snap.burstRisk <= calibrationData.atlas.burstMax + 0.22,
    snap.mediumHit15 <= calibrationData.atlas.mediumHitMax + 0.12,
    snap.vol6 <= calibrationData.atlas.vol6Max + 0.34,
    Math.abs(snap.recoveryBias) <= calibrationData.atlas.biasAbsMax + 0.1,
    proj.regime === "COMPRESION" || proj.regime === "RECUPERACION" || proj.regime === "NEUTRAL" || proj.regime === "EXPANSION",
  ];
  const confidence = clamp(checks.filter(Boolean).length * 11 + (proj.score >= 72 ? 8 : proj.score >= 50 ? 4 : 0), 0, 100);
  const source =
    proj.regime === "COMPRESION" ? "HY17-COMPRESION" :
    proj.regime === "RECUPERACION" ? "HY17-RECUPERACION" :
    "HY17-NEUTRAL";
  const tier = proj.score >= 72 && proj.expected >= Math.max(calibrationData.base + 0.01, 0.2) ? "A" : proj.score >= 50 ? "B" : "C";
  const decision = checks.filter(Boolean).length >= 4 && proj.score >= 44 && proj.expected >= Math.max(calibrationData.base - 0.01, 0.16) ? "ENTER" : "WAIT";
  return { decision, source, tier, confidence, projection: proj };
}

function shouldAcceptHybrid17Entry(existingEntries, candidate, totalRounds = 0) {
  if (!candidate) return false;

  const recent = recentQuality(existingEntries, 10);
  const bucket = hybridBucketPerformance(existingEntries, candidate, 34);
  const source = hybridSourcePerformance(existingEntries, candidate, 34);
  const tierPerf = hybridTierPerformance(existingEntries, candidate.tier, 50);
  const cycle = currentProfitCycleState(existingEntries, 5);
  const idleMinutes = minutesSinceLastEntry(existingEntries, candidate.time);
  const matureSample = totalRounds >= 2000;
  const longDrought = idleMinutes >= (matureSample ? 0.5 : 1.2);
  const forcedFlow = idleMinutes >= (matureSample ? 1.2 : 2.2);
  const bucketPositive = bucket.total < 6 || bucket.roi >= (matureSample ? -0.9 : -0.66) || bucket.winRate >= (matureSample ? 0.12 : 0.18);
  const sourceStable = source.total < 6 || source.roi >= (matureSample ? -0.78 : -0.56) || source.winRate >= (matureSample ? 0.14 : 0.2);
  const tierStrong = tierPerf.total < 8 || tierPerf.roi >= (matureSample ? -0.46 : -0.32) || tierPerf.winRate >= (matureSample ? 0.18 : 0.26);

  if (candidate.tier === "A") {
    return tierStrong && sourceStable && candidate.expected >= 0.17 && candidate.confidence >= 42;
  }
  if (candidate.tier === "B") {
    return bucketPositive && sourceStable && (
      recent.total < 5 ||
      recent.roi >= (matureSample ? -1.3 : -1.0) ||
      recent.winRate >= (matureSample ? 0.06 : 0.12) ||
      idleMinutes >= (matureSample ? 0.05 : 0.25) ||
      longDrought ||
      forcedFlow ||
      (cycle.entries >= 1 && cycle.net < 1.5)
    );
  }
  return bucketPositive && (
    longDrought ||
    forcedFlow ||
    (recent.total < 4) ||
    (recent.winRate >= (matureSample ? 0.04 : 0.1) && recent.roi >= (matureSample ? -1.55 : -1.15))
  );
}

async function getFrozenHybridEntries() {
  const stored = await chrome.storage.local.get(["frozenHybridEntries"]);
  return Array.isArray(stored.frozenHybridEntries) ? stored.frozenHybridEntries : [];
}

async function getFrozenHybrid17Entries() {
  const stored = await chrome.storage.local.get(["frozenHybrid17Entries"]);
  return Array.isArray(stored.frozenHybrid17Entries) ? stored.frozenHybrid17Entries : [];
}

async function freezeHybridEntries(dynamicEntries) {
  const frozen = await getFrozenHybridEntries();
  const existingKeys = new Set(
    frozen.map((entry) => `${entry.time}|${entry.actual}`)
  );
  const lastFrozenTime = frozen.length
    ? Math.max(...frozen.map((entry) => new Date(entry.time || 0).getTime()).filter((time) => Number.isFinite(time)))
    : -Infinity;
  const additions = [];

  (dynamicEntries || []).forEach((entry) => {
    const entryTime = new Date(entry.time || 0).getTime();
    if (!Number.isFinite(entryTime)) return;
    if (entryTime <= lastFrozenTime) return;
    const key = `${entry.time}|${entry.actual}`;
    if (existingKeys.has(key)) return;
    existingKeys.add(key);
    additions.push(entry);
  });

  if (additions.length) {
    const merged = [...frozen, ...additions].sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
    await chrome.storage.local.set({ frozenHybridEntries: merged });
    return merged;
  }

  return frozen.slice().sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
}

async function freezeHybrid17Entries(dynamicEntries) {
  const frozen = await getFrozenHybrid17Entries();
  const existingKeys = new Set(
    frozen.map((entry) => `${entry.time}|${entry.actual}`)
  );
  const lastFrozenTime = frozen.length
    ? Math.max(...frozen.map((entry) => new Date(entry.time || 0).getTime()).filter((time) => Number.isFinite(time)))
    : -Infinity;
  const additions = [];

  (dynamicEntries || []).forEach((entry) => {
    const entryTime = new Date(entry.time || 0).getTime();
    if (!Number.isFinite(entryTime)) return;
    if (entryTime <= lastFrozenTime) return;
    const key = `${entry.time}|${entry.actual}`;
    if (existingKeys.has(key)) return;
    existingKeys.add(key);
    additions.push(entry);
  });

  if (additions.length) {
    const merged = [...frozen, ...additions].sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
    await chrome.storage.local.set({ frozenHybrid17Entries: merged });
    return merged;
  }

  return frozen.slice().sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
}

function rebuildHybridFromFrozen(data, frozenEntries, frozenHybrid17Entries = []) {
  const buildHybridVariant = (executionConfig, cycleName) => {
    const resolved = resolveHybridOperations(frozenEntries, data.rounds, data.calibrationData, executionConfig);
    const entries = resolved.operations.slice().sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
    const counts = outcomeCounts(entries);
    const cycles = cycleStats(entries, cycleName);
    return {
      entries,
      pendingGale: resolved.pendingGale,
      entryStats: {
        total: counts.total,
        wins: counts.wins,
        gales: counts.gales,
        losses: counts.losses,
        winRate: counts.directWinRate,
        successRate: counts.successRate,
        roi: entries.length ? entries.reduce((sum, entry) => sum + entry.pnl, 0) / entries.length : 0,
      },
      cadence: hourlyStats(entries),
      cycles,
      openCycle: cycles.find((cycle) => cycle.records < 50) || null,
      daily: dailyStats(entries, cycleName),
      gainCycles: profitCycles(entries, 5),
      currentGainCycle: currentProfitCycleState(entries, 5),
      regimes: regimeStats(entries),
      equity: equityStats(entries),
      sources: {
        dual: entries.filter((entry) => entry.sourceMode === "DUAL").length,
        balanced: entries.filter((entry) => entry.sourceMode === "BALANCED" || entry.sourceMode === "BALANCED-ASSIST").length,
        scout: entries.filter((entry) => entry.sourceMode === "SCOUT-LIMPIO").length,
      },
      execution: executionConfig,
    };
  };

  const hybridMain = buildHybridVariant(HYBRID_EXECUTION, "HYBRID");
  const hybrid17 = (() => {
    const resolved = resolveHybridOperations(frozenHybrid17Entries, data.rounds, data.calibrationData17, HYBRID_17_EXECUTION);
    const entries = resolved.operations.slice().sort((a, b) => new Date(a.time || 0) - new Date(b.time || 0));
    const counts = outcomeCounts(entries);
    const cycles = cycleStats(entries, "HYBRID 1.7");
    return {
      entries,
      pendingGale: resolved.pendingGale,
      entryStats: {
        total: counts.total,
        wins: counts.wins,
        gales: counts.gales,
        losses: counts.losses,
        winRate: counts.directWinRate,
        successRate: counts.successRate,
        roi: entries.length ? entries.reduce((sum, entry) => sum + entry.pnl, 0) / entries.length : 0,
      },
      cadence: hourlyStats(entries),
      cycles,
      openCycle: cycles.find((cycle) => cycle.records < 50) || null,
      daily: dailyStats(entries, "HYBRID 1.7"),
      gainCycles: profitCycles(entries, 5),
      currentGainCycle: currentProfitCycleState(entries, 5),
      regimes: regimeStats(entries),
      equity: equityStats(entries),
      execution: HYBRID_17_EXECUTION,
    };
  })();

  return {
    ...data,
    entries: hybridMain.entries,
    rawHybridEntries: frozenEntries.slice(),
    pendingGale: hybridMain.pendingGale,
    entryStats: hybridMain.entryStats,
    cadence: { ...data.cadence, hybrid: hybridMain.cadence, hybrid17: hybrid17.cadence },
    cycles: { ...data.cycles, hybrid: hybridMain.cycles, hybrid17: hybrid17.cycles },
    openCycles: { ...data.openCycles, hybrid: hybridMain.openCycle, hybrid17: hybrid17.openCycle },
    daily: { ...data.daily, hybrid: hybridMain.daily, hybrid17: hybrid17.daily },
    gainCycles: hybridMain.gainCycles,
    currentGainCycle: hybridMain.currentGainCycle,
    regimes: hybridMain.regimes,
    equity: hybridMain.equity,
    hybridSources: hybridMain.sources,
    hybrid17,
  };
}

async function getFrozenDailyReports() {
  const stored = await chrome.storage.local.get(["frozenDailyReports"]);
  const reports = stored.frozenDailyReports || { hybrid: {}, hybrid17: {}, balanced: {}, scout: {} };
  if (!reports.hybrid && reports.strict) reports.hybrid = reports.strict;
  reports.hybrid ||= {};
  reports.hybrid17 ||= {};
  reports.balanced ||= {};
  reports.scout ||= {};
  return reports;
}

async function getFrozenCycleReports() {
  const stored = await chrome.storage.local.get(["frozenCycleReports"]);
  const reports = stored.frozenCycleReports || { hybrid: {}, hybrid17: {}, balanced: {}, scout: {} };
  if (!reports.hybrid && reports.strict) reports.hybrid = reports.strict;
  reports.hybrid ||= {};
  reports.hybrid17 ||= {};
  reports.balanced ||= {};
  reports.scout ||= {};
  return reports;
}

async function freezeHistoricalDailyReports(dynamicDaily) {
  const today = dayKey(Date.now());
  const frozen = await getFrozenDailyReports();
  let changed = false;

  const mergeMode = (modeKey, rows) => {
    frozen[modeKey] ||= {};
    rows.forEach((row) => {
      if (row.key === today) return;
      if (!frozen[modeKey][row.key]) {
        frozen[modeKey][row.key] = row;
        changed = true;
      }
    });
  };

  mergeMode("hybrid", dynamicDaily.hybrid || []);
  mergeMode("hybrid17", dynamicDaily.hybrid17 || []);
  mergeMode("balanced", dynamicDaily.balanced || []);
  mergeMode("scout", dynamicDaily.scout || []);

  if (changed) {
    await chrome.storage.local.set({ frozenDailyReports: frozen });
  }

  const compose = (modeKey, liveRows) => {
    const frozenRows = Object.values(frozen[modeKey] || {});
    const currentRow = (liveRows || []).find((row) => row.key === today);
    return [...frozenRows, ...(currentRow ? [currentRow] : [])].sort(
      (a, b) => new Date(b.newest || 0) - new Date(a.newest || 0)
    );
  };

  return {
    hybrid: compose("hybrid", dynamicDaily.hybrid),
    hybrid17: compose("hybrid17", dynamicDaily.hybrid17),
    balanced: compose("balanced", dynamicDaily.balanced),
    scout: compose("scout", dynamicDaily.scout),
  };
}

async function freezeHistoricalCycles(dynamicCyclesByMode) {
  const frozen = await getFrozenCycleReports();
  let changed = false;

  const mergeMode = (modeKey, rows) => {
    frozen[modeKey] ||= {};
    (rows || []).forEach((row) => {
      if (row.records < 50) return;
      const key = `cycle-${row.cycle}`;
      if (!frozen[modeKey][key]) {
        frozen[modeKey][key] = { ...row, key };
        changed = true;
      }
    });
  };

  mergeMode("hybrid", dynamicCyclesByMode.hybrid);
  mergeMode("hybrid17", dynamicCyclesByMode.hybrid17);
  mergeMode("balanced", dynamicCyclesByMode.balanced);
  mergeMode("scout", dynamicCyclesByMode.scout);

  if (changed) {
    await chrome.storage.local.set({ frozenCycleReports: frozen });
  }

  const compose = (modeKey, liveRows) => {
    const frozenRows = Object.values(frozen[modeKey] || {});
    return frozenRows.sort((a, b) => new Date(b.newest || 0) - new Date(a.newest || 0));
  };

  return {
    hybrid: compose("hybrid", dynamicCyclesByMode.hybrid),
    hybrid17: compose("hybrid17", dynamicCyclesByMode.hybrid17),
    balanced: compose("balanced", dynamicCyclesByMode.balanced),
    scout: compose("scout", dynamicCyclesByMode.scout),
  };
}

function recentQuality(entries, size = 20) {
  const sample = entries
    .slice()
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
    .slice(0, size);
  const wins = sample.filter((entry) => entry.win).length;
  return {
    total: sample.length,
    winRate: sample.length ? wins / sample.length : 0,
    roi: sample.length ? sample.reduce((sum, entry) => sum + entry.pnl, 0) / sample.length : 0,
  };
}

function recentLossPressure(entries, size = 8) {
  const sample = entries
    .slice()
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
    .slice(0, size);
  let lossStreak = 0;
  for (const entry of sample) {
    if (entry.win) break;
    lossStreak += 1;
  }
  return {
    total: sample.length,
    losses: sample.filter((entry) => !entry.win).length,
    lossStreak,
  };
}

function buildLiveSignal(data) {
  const hybridRecent = recentQuality(data.entries, 20);
  const hybridFast = recentQuality(data.entries, 10);
  const hybridLossPressure = recentLossPressure(data.entries, 8);
  const hybridNear =
    data.hybrid.projection.regime !== "SOBRECALENTADO" &&
    data.hybrid.projection.score >= 48 &&
    data.hybrid.projection.expected >= 0.43 &&
    data.hybrid.confidence >= 48 &&
    hybridLossPressure.lossStreak < 2;
  const hybridOk =
    data.hybrid.decision === "ENTER" &&
    data.hybrid.projection.regime !== "SOBRECALENTADO" &&
    data.hybrid.projection.score >= 50 &&
    data.hybrid.projection.expected >= 0.43 &&
    data.hybrid.confidence >= 50 &&
    hybridLossPressure.lossStreak < 2 &&
    hybridLossPressure.losses <= 5 &&
    (hybridRecent.total < 8 || (hybridRecent.winRate >= 0.42 && hybridRecent.roi >= -0.18)) &&
    (hybridFast.total < 5 || hybridFast.roi >= -0.24);

  if (hybridOk) {
    return {
      action: "ENTRAR",
      mode: "HYBRID",
      confidence: data.hybrid.confidence,
      note: `Hybrid habilitado. Nivel ${data.hybrid.tier}, fuente ${data.hybrid.source}, score ${data.hybrid.projection.score.toFixed(0)} y calidad reciente ${fmtPct(hybridRecent.winRate)}.`,
    };
  }
  if (hybridNear) {
    return {
      action: "PREPARAR",
      mode: "HYBRID",
      confidence: data.hybrid.confidence,
      note: `Hybrid estÃ¡ cerca. Nivel ${data.hybrid.tier}, fuente ${data.hybrid.source}, expected ${fmtPct(data.hybrid.projection.expected)} y confianza ${data.hybrid.confidence.toFixed(0)}%.`,
    };
  }
  return {
    action: "ESPERAR",
    mode: "NINGUNO",
    confidence: data.hybrid.confidence,
    note: "Hybrid sigue esperando. El sistema solo activa entrada cuando el contexto mezcla frecuencia util con limpieza suficiente.",
  };
}

function modeReason(strategyRow, labels) {
  const failed = (strategyRow?.checks || []).filter((check) => !check.passed);
  if (!failed.length) return labels.ok;
  return failed
    .slice(0, 3)
    .map((check) => `${check.label}: ${check.detail}`)
    .join(" · ");
}

function render(data, stats) {
  const autoBetLab = {
    baseStake: 1000,
    galeStake: 3000,
    cashout: 1.5,
    lastEntry: data.entries.length ? data.entries[data.entries.length - 1] : null,
    pendingGale: data.pendingGale || null,
  };
  const autoBetStatus = autoBetLab.pendingGale
    ? "WAIT_GALE"
    : data.signal.action === "ENTRAR" || data.signal.action === "ENTER"
      ? "ARMED"
      : data.signal.action === "PREPARAR"
        ? "READY"
        : "OFF";
  const autoBetGuard = autoBetLab.pendingGale
    ? "GALE"
    : data.hybrid.decision === "ENTER"
      ? "LISTO"
      : "BLOQ";
  const nextStake =
    autoBetLab.pendingGale ||
    (autoBetLab.lastEntry && autoBetLab.lastEntry.outcome === "LOSS")
      ? autoBetLab.galeStake
      : autoBetLab.baseStake;

  document.getElementById("stat-total").textContent = String(stats.totalRounds ?? 0);
  document.getElementById("stat-hit-rate").textContent = fmtPct(stats.targetHitRate ?? 0);
  document.getElementById("stat-avg").textContent = `${(stats.avgMultiplier ?? 0).toFixed(2)}x`;
  document.getElementById("stat-streak").textContent = String(stats.currentLowStreak ?? 0);
  document.getElementById("live-status").textContent = data.rounds.length
    ? `Capturando en vivo · ${data.rounds.length} rondas almacenadas`
    : "Esperando primeras rondas";
  document.getElementById("entry-total").textContent = String(data.entryStats.total);
  document.getElementById("entry-wins").textContent = String(data.entryStats.wins);
  document.getElementById("entry-win-rate").textContent = String(data.entryStats.gales ?? 0);
  document.getElementById("entry-roi").textContent = fmtUnits(data.entryStats.roi);
  document.getElementById("autobet-status").textContent = autoBetStatus;
  document.getElementById("autobet-status-note").textContent = autoBetLab.pendingGale
    ? "Hay un gale pendiente bajo la logica actual"
    : data.hybrid.decision === "ENTER"
      ? `Hybrid habilitado por ${data.hybrid.source}`
      : "Modo visual sin ejecucion real";
  document.getElementById("autobet-base-stake").textContent = String(autoBetLab.baseStake);
  document.getElementById("autobet-gale-stake").textContent = String(autoBetLab.galeStake);
  document.getElementById("autobet-cashout").textContent = `${autoBetLab.cashout.toFixed(2)}x`;
  document.getElementById("autobet-last-signal").textContent = autoBetLab.lastEntry
    ? fmtTime(autoBetLab.lastEntry.time)
    : "-";
  document.getElementById("autobet-last-signal-note").textContent = autoBetLab.lastEntry
    ? `${autoBetLab.lastEntry.sourceMode} · ${autoBetLab.lastEntry.outcome || "PENDING"}`
    : "Aun sin referencia";
  document.getElementById("autobet-next-stake").textContent = String(nextStake);
  document.getElementById("autobet-next-stake-note").textContent = autoBetLab.pendingGale
    ? "Proximo intento visual con gale x3"
    : "Sin cronologia real de autoapuesta";
  document.getElementById("autobet-mode").textContent = "ARMED";
  document.getElementById("autobet-guard").textContent = autoBetGuard;
  document.getElementById("autobet-guard-note").textContent = autoBetLab.pendingGale
    ? "Esperaria la siguiente oportunidad valida"
    : data.hybrid.decision === "ENTER"
      ? "La senal actual habilitaria un intento"
      : "Esperando una senal operativa";
  document.getElementById("strict-total").textContent = String(data.entryStats.total);
  document.getElementById("strict-note").textContent = `${fmtPct(data.entryStats.successRate ?? 0)} sin perdida · ROI ${fmtUnits(data.entryStats.roi)} · ${data.hybrid.source}`;
  document.getElementById("balanced-total").textContent = String(data.balancedStats.total);
  document.getElementById("balanced-note").textContent = `${fmtPct(data.balancedStats.winRate)} · ROI ${fmtUnits(data.balancedStats.roi)}`;
  document.getElementById("scout-total").textContent = String(data.scoutStats.total);
  document.getElementById("scout-note").textContent = `${fmtPct(data.scoutStats.winRate)} · ROI ${fmtUnits(data.scoutStats.roi)}`;
  document.getElementById("scout-per-hour").textContent = data.cadence.hybrid.perHour.toFixed(1);
  document.getElementById("scout-last-hour").textContent = String(data.cadence.hybrid.lastHour);
  document.getElementById("scout-last-30m").textContent = String(data.cadence.hybrid.last30m);
  const sourceBreakdown = [
    ["BALANCED", data.hybridSources.balanced],
    ["SCOUT-LIMPIO", data.hybridSources.scout],
    ["DUAL", data.hybridSources.dual],
  ].sort((a, b) => b[1] - a[1]);
  document.getElementById("best-mode").textContent = sourceBreakdown[0]?.[1] ? sourceBreakdown[0][0] : "-";
  document.getElementById("best-mode-note").textContent = sourceBreakdown[0]?.[1]
    ? `${sourceBreakdown[0][1]} entradas HYBRID`
    : "Esperando senales";
  const hybridState = data.hybrid.decision === "ENTER" ? "ACTIVO" : data.signal.action === "PREPARAR" ? "CERCA" : "ESPERA";
  const balancedState = data.balanced.decision === "ENTER" ? "ACTIVO" : "ESPERA";
  const scoutState = data.scout.decision === "ENTER" ? "ACTIVO" : "ESPERA";
  const relationshipSummary =
    hybridState === "ACTIVO"
      ? `HYBRID ya esta habilitado y su fuente principal ahora mismo es ${data.hybrid.source}.`
      : balancedState === "ACTIVO" && scoutState === "ACTIVO"
        ? "Balanced y Scout limpio estÃ¡n alineados, pero HYBRID todavÃ­a espera una confirmaciÃ³n final."
        : balancedState === "ACTIVO"
          ? "Balanced aporta limpieza, pero HYBRID aun no toma la entrada sin apoyo suficiente del contexto."
          : scoutState === "ACTIVO"
            ? "Scout ve movimiento, pero HYBRID todavÃ­a no lo considera lo bastante limpio para convertirlo en entrada."
            : "Ninguna fuente esta suficientemente alineada; HYBRID sigue esperando.";
  document.getElementById("mode-relationship-card").innerHTML = `<div class="stat" style="height:100%;padding:18px;"><div class="row"><strong>Lectura actual</strong><span class="${hybridState === "ACTIVO" ? "good" : hybridState === "CERCA" ? "warn" : ""}">${data.signal.action}</span></div><div class="sub" style="margin-top:12px;">${relationshipSummary}</div><div class="grid-4" style="margin-top:16px;"><div class="stat"><div class="label">Hybrid</div><div class="value ${hybridState === "ACTIVO" ? "good" : hybridState === "CERCA" ? "warn" : ""}" style="font-size:26px;">${hybridState}</div></div><div class="stat"><div class="label">Balanced</div><div class="value ${balancedState === "ACTIVO" ? "good" : balancedState === "ESPERA" ? "warn" : ""}" style="font-size:26px;">${balancedState}</div></div><div class="stat"><div class="label">Scout limpio</div><div class="value ${scoutState === "ACTIVO" ? "good" : "warn"}" style="font-size:26px;">${scoutState}</div></div><div class="stat"><div class="label">Fuente</div><div class="value" style="font-size:26px;">${data.hybrid.source}</div></div></div></div>`;
  document.getElementById("mode-reasons-card").innerHTML = [
    ["Hybrid", hybridState, hybridState === "ACTIVO" ? `HYBRID entra con fuente ${data.hybrid.source}.` : `Fuente actual: ${data.hybrid.source} · score ${data.hybrid.projection.score.toFixed(0)} · expected ${fmtPct(data.hybrid.projection.expected)}`],
    ["Balanced", balancedState, modeReason(data.balanced, { ok: "Balanced aporta una base suficientemente limpia para HYBRID." })],
    ["Scout limpio", scoutState, modeReason(data.scout, { ok: "Scout aporta frecuencia util sin necesidad de abrir el sistema completo." })],
  ]
    .map(
      ([label, state, note]) =>
        `<div class="stat" style="padding:16px;"><div class="row"><strong>${label}</strong><span class="${state === "ACTIVO" ? "good" : state === "ESPERA" ? "warn" : "bad"}">${state}</span></div><div class="sub" style="margin-top:10px;">${note}</div></div>`
    )
    .join("");
  const strictVisible = visibleEntryStats(data.entries);
  const balancedVisible = visibleEntryStats(data.balancedEntries);
  const scoutVisible = visibleEntryStats(data.scoutEntries);
  const hybridDisplayEntries = data.pendingGale
    ? [
        {
          ...data.pendingGale,
          actualDisplay: `${data.pendingGale.actual.toFixed(2)}x`,
          outcome: "PENDING",
          pnl: 0,
          sourceMode: `${data.pendingGale.sourceMode} + GALE`,
        },
        ...data.entries,
      ]
    : data.entries;
  const summaryCards = (stats) => [
    `<div class="stat"><div class="label">Mostradas</div><div class="value">${stats.total}</div><div class="sub">Ultimos 50 registros</div></div>`,
    `<div class="stat"><div class="label">Ganadas</div><div class="value good">${stats.wins}</div><div class="sub">Resultados WIN</div></div>`,
    `<div class="stat"><div class="label">Gales</div><div class="value warn">${stats.gales ?? 0}</div><div class="sub">Cierres en segundo ingreso</div></div>`,
    `<div class="stat"><div class="label">Perdidas</div><div class="value bad">${stats.losses}</div><div class="sub">${fmtUnits(stats.net)} neto visible</div></div>`,
  ].join("");
  document.getElementById("scout-summary").innerHTML = summaryCards(strictVisible);
  document.getElementById("balanced-summary").innerHTML = summaryCards(balancedVisible);
  document.getElementById("strict-summary").innerHTML = summaryCards(scoutVisible);

  const lastEntry = data.entries.length ? data.entries[data.entries.length - 1] : null;
  const decisionText = data.signal.action;
  const decisionColor = data.signal.action === "ENTRAR" ? "#4ade80" : data.signal.action === "PREPARAR" ? "#38bdf8" : "#facc15";
  document.getElementById("exec-decision").textContent = decisionText;
  document.getElementById("exec-decision").style.color = decisionColor;
  document.getElementById("exec-summary").textContent = data.pendingGale
    ? `Hay un gale pendiente desde ${fmtTime(data.pendingGale.time)}. Próximo intento disponible desde ${fmtTime(data.pendingGale.galeAt)}.`
    : data.signal.action === "ENTRAR"
      ? `Senal viva ${data.signal.mode}. ${data.signal.note}`
      : `Sin senal viva. ${data.signal.note}`;
  document.getElementById("exec-mode").textContent = `Modo ${data.signal.mode === "NINGUNO" ? data.prem.mode : data.signal.mode}`;
  document.getElementById("exec-confidence").textContent = `${data.signal.confidence.toFixed(0)}%`;
  document.getElementById("exec-win-rate").textContent = fmtPct(data.entryStats.successRate ?? 0);
  document.getElementById("exec-last-result").textContent = lastEntry ? lastEntry.outcome || (lastEntry.win ? "WIN" : "LOSS") : "-";
  document.getElementById("exec-last-result").className = `value ${lastEntry ? (lastEntry.outcome === "LOSS" ? "miss" : lastEntry.outcome === "GALE" ? "warn" : "hit") : ""}`;
  document.getElementById("exec-last-note").textContent = lastEntry
    ? `${fmtTime(lastEntry.time)} Â· ${(lastEntry.actualDisplay || `${lastEntry.actual.toFixed(2)}x`)} Â· ${lastEntry.sourceMode} Â· ${fmtUnits(lastEntry.pnl)}`
    : "Todavia no hay entradas registradas";
  document.getElementById("exec-readiness").textContent = `${data.prem.readiness}%`;

  const projectionColor = data.proj.tone === "good" ? "#4ade80" : data.proj.tone === "bad" ? "#f87171" : "#facc15";
  document.getElementById("projection-card").innerHTML = `<div class="stat" style="padding:18px;"><div class="row"><div><div class="label">Motor Atlas</div><div class="value" style="color:${projectionColor};">${data.proj.score.toFixed(0)}</div></div><div style="text-align:right;"><div class="label">Regimen</div><div style="font-size:24px;font-weight:800;color:${projectionColor};margin-top:8px;">${data.proj.regime}</div></div></div><div class="bar-track" style="margin-top:14px;"><div class="bar-fill" style="width:${data.proj.score}%;background:linear-gradient(90deg,#f87171,#facc15,#4ade80);"></div></div><div class="sub" style="margin-top:14px;">${data.proj.summary}</div><div class="sub" style="margin-top:10px;">Hit rate estimado: <strong style="color:#f4f4f5;">${fmtPct(data.proj.expected)}</strong></div></div>`;

  const snap = snapshot(data.rounds, data.rounds.length);
  document.getElementById("projection-factors").innerHTML = !snap
    ? `<div class="stat"><div class="sub">Aun no hay suficientes rondas para desglosar Atlas.</div></div>`
    : [
        ["Compresion", fmtPct(snap.compression), snap.compression >= data.calibrationData.atlas.compressionMin],
        ["Shock risk", fmtPct(snap.shockRisk), snap.shockRisk <= data.calibrationData.atlas.shockMax],
        ["Sequia 1.5x", `${snap.dry15} rondas`, snap.dry15 >= data.calibrationData.atlas.dry15Min && snap.dry15 <= data.calibrationData.atlas.dry15Max],
        ["Burst reciente", fmtPct(snap.burstRisk), snap.burstRisk <= data.calibrationData.atlas.burstMax],
      ]
        .map(
          ([label, detail, passed]) =>
            `<div class="stat"><div class="row"><strong>${label}</strong><span class="${passed ? "good" : "bad"}">${detail}</span></div><div class="sub">Factor central del modelo Atlas.</div></div>`
        )
        .join("");

  const strategyColor = data.strategy.decision === "ENTER" ? "#4ade80" : "#facc15";
  document.getElementById("strategy-card").innerHTML = `<div class="stat" style="padding:18px;"><div class="row"><div><div class="label">Decision Atlas</div><div class="value" style="color:${strategyColor};">${data.strategy.decision}</div></div><div style="text-align:right;"><div class="label">Confianza</div><div style="font-size:30px;font-weight:900;color:${strategyColor};margin-top:8px;">${data.strategy.confidence.toFixed(0)}%</div></div></div></div>`;
  document.getElementById("strategy-checks").innerHTML = data.strategy.checks
    .map(
      (check) =>
        `<div class="stat" style="padding:14px;"><div class="row"><strong>${check.label}</strong><span class="${check.passed ? "good" : "bad"}">${check.passed ? "OK" : "NO"}</span></div><div class="sub">${check.detail}</div></div>`
    )
    .join("");

  const premiumColor = data.prem.tone === "good" ? "#4ade80" : data.prem.tone === "bad" ? "#f87171" : "#facc15";
  document.getElementById("premium-card").innerHTML = `<div class="stat" style="padding:18px;"><div class="row"><div><div class="label">Estado premium</div><div class="value" style="color:${premiumColor};">${data.prem.mode}</div></div><div style="text-align:right;"><div class="label">Readiness</div><div style="font-size:30px;font-weight:900;color:${premiumColor};margin-top:8px;">${data.prem.readiness}%</div></div></div></div>`;
  document.getElementById("guardrail-cards").innerHTML = [
    ...data.prem.checks.map(
      (check) =>
        `<div class="stat" style="padding:14px;"><div class="row"><strong>${check.label}</strong><span class="${check.passed ? "good" : "bad"}">${check.passed ? "OK" : "NO"}</span></div><div class="sub">${check.detail}</div></div>`
    ),
    ...data.prem.warnings.map(
      (warning) =>
        `<div class="stat" style="padding:14px;"><div class="row"><strong>Advertencia</strong><span class="bad">Riesgo</span></div><div class="sub">${warning}</div></div>`
    ),
  ].join("");

  document.getElementById("distribution-bars").innerHTML = [
    ["<1.5x", 0, 1.5],
    ["1.5x-1.99x", 1.5, 2],
    ["2x-4.99x", 2, 5],
    ["5x-9.99x", 5, 10],
    ["10x+", 10, null],
  ]
    .map(([label, min, max]) => {
      const count = data.rounds.filter((round) =>
        max === null ? round.multiplier >= min : round.multiplier >= min && round.multiplier < max
      ).length;
      const pct = data.rounds.length ? count / data.rounds.length : 0;
      return `<div><div class="row"><strong>${label}</strong><span class="muted">${count} Â· ${fmtPct(pct)}</span></div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(
        pct * 100,
        2
      )}%"></div></div></div>`;
    })
    .join("");

  document.getElementById("atlas-thresholds").innerHTML = [
    ["Compresion minima", fmtPct(data.calibrationData.atlas.compressionMin)],
    ["Shock maximo", fmtPct(data.calibrationData.atlas.shockMax)],
    ["Burst maximo", fmtPct(data.calibrationData.atlas.burstMax)],
    ["Sequia 1.5x", `${data.calibrationData.atlas.dry15Min}-${data.calibrationData.atlas.dry15Max} rondas`],
    ["Dry 5x minimo", `${data.calibrationData.atlas.dry5Min} rondas`],
    ["Presion media max", fmtPct(data.calibrationData.atlas.mediumHitMax)],
    ["Volatilidad util", `${data.calibrationData.atlas.vol6Max.toFixed(2)}x`],
    ["Bias abs max", fmtPct(data.calibrationData.atlas.biasAbsMax)],
    ["Score enter", `${data.calibrationData.atlas.scoreEnter}`],
    ["Consenso actual", `${data.consensus.score.toFixed(0)}%`],
  ]
    .map(
      ([label, detail]) =>
        `<div class="stat" style="padding:14px;"><div class="row"><strong>${label}</strong><span class="mono">${detail}</span></div><div class="sub">Umbral adaptativo aprendido por Atlas.</div></div>`
    )
    .join("");

  document.getElementById("equity-summary").innerHTML = `<div class="grid-4" style="margin-top:16px;"><div class="stat"><div class="label">Equity final</div><div class="value ${data.equity.finalEquity >= 0 ? "good" : "bad"}">${fmtUnits(data.equity.finalEquity)}</div><div class="sub">Resultado acumulado de Atlas</div></div><div class="stat"><div class="label">Drawdown mÃ¡ximo</div><div class="value ${data.equity.maxDrawdown <= 4 ? "good" : "bad"}">${data.equity.maxDrawdown.toFixed(2)}u</div><div class="sub">PresiÃ³n mÃ¡xima histÃ³rica</div></div><div class="stat"><div class="label">Mejor pico</div><div class="value">${fmtUnits(data.equity.peakEquity)}</div><div class="sub">MÃ¡ximo equity alcanzado</div></div><div class="stat"><div class="label">Entradas</div><div class="value">${data.entries.length}</div><div class="sub">SeÃ±ales validadas por consenso</div></div></div>`;
  const recentCurve = data.equity.curve.slice(-30);
  const maxAbs = Math.max(1, ...recentCurve.map((point) => Math.max(Math.abs(point.equity), 1)));
  document.getElementById("equity-chart").innerHTML = recentCurve.length
    ? `<div class="sparkline">${recentCurve
        .map((point) => `<div class="sparkbar ${point.pnl < 0 ? "loss" : ""}" title="${fmtTime(point.time)} Â· Equity ${fmtUnits(point.equity)} Â· DD ${point.drawdown.toFixed(2)}u" style="height:${Math.max(14, (Math.abs(point.equity) / maxAbs) * 120)}px"></div>`)
        .join("")}</div><div class="sub">Ãšltimas ${recentCurve.length} entradas aprobadas por Atlas.</div>`
    : `<div class="stat" style="margin-top:16px;"><div class="sub">TodavÃ­a no hay suficientes entradas para dibujar la curva.</div></div>`;

  document.getElementById("report-cards").innerHTML = [
    `<div class="stat" style="padding:16px;"><div class="row"><strong>Veredicto</strong><span class="${data.prem.mode === "OPERABLE" ? "good" : data.prem.mode === "OBSERVACION" ? "warn" : "bad"}">${data.prem.mode}</span></div><div class="sub">${data.report.verdict}</div></div>`,
    ...data.report.strengths.map((item) => `<div class="stat" style="padding:16px;"><div class="row"><strong>Fortaleza</strong><span class="good">OK</span></div><div class="sub">${item}</div></div>`),
    ...data.report.cautions.map((item) => `<div class="stat" style="padding:16px;"><div class="row"><strong>PrecauciÃ³n</strong><span class="bad">AtenciÃ³n</span></div><div class="sub">${item}</div></div>`),
  ].join("");

  document.getElementById("window-summary").innerHTML = [25, 50, 100, 200]
    .map((size) => {
      const sample = data.rounds.slice(-size);
      const values = sample.map((round) => round.multiplier);
      return `<div class="stat" style="padding:14px;"><div class="label">Ult. ${size}</div><div class="value" style="font-size:28px;">${fmtPct(
        sample.length ? sample.filter((round) => round.multiplier >= 1.5).length / sample.length : 0
      )}</div><div class="sub">Promedio ${avg(values).toFixed(2)}x Â· Mediana ${med(values).toFixed(2)}x</div></div>`;
    })
    .join("");

  table(
    "opportunity-table",
    ["Hora", "Score", "Regimen", "Hit rate esp.", "Resultado"],
    data.rounds.slice(-30).map((round, offset) => {
      const index = data.rounds.length - 30 + offset;
      const proj = projection(data.rounds, index, calibration(data.rounds));
      return `<tr><td>${fmtTime(round.createdAt)}</td><td class="mono">${proj.score.toFixed(0)}</td><td>${proj.regime}</td><td class="mono">${fmtPct(
        proj.expected
      )}</td><td class="mono ${round.multiplier >= 1.5 ? "hit" : "miss"}">${round.multiplier.toFixed(2)}x</td></tr>`;
    })
  );

  table(
    "strategy-log-table",
    ["Hora", "Decision", "Conf.", "Regimen", "Resultado"],
    data.rounds.slice(-40).map((round, offset) => {
      const index = data.rounds.length - 40 + offset;
      const strategy = atlasStrategy(data.rounds, index, calibration(data.rounds));
      return `<tr><td>${fmtTime(round.createdAt)}</td><td class="${strategy.decision === "ENTER" ? "hit" : ""}">${strategy.decision}</td><td class="mono">${strategy.confidence.toFixed(
        0
      )}%</td><td>${strategy.projection.regime}</td><td class="mono ${round.multiplier >= 1.5 ? "hit" : "miss"}">${round.multiplier.toFixed(2)}x</td></tr>`;
    })
  );

  table("scout-table", ["Hora", "Nivel", "Fuente", "Regimen", "Score", "Confianza", "Consenso", "Hit rate esp.", "Resultado", "WIN/LOSS", "P&L"], entryRows(hybridDisplayEntries.map((entry) => ({ ...entry, consensus: entry.consensus ?? 100 }))));
  table("balanced-table", ["Hora", "Fuente", "Regimen", "Score", "Confianza", "Consenso", "Hit rate esp.", "Resultado", "WIN/LOSS", "P&L"], entryRows(data.balancedEntries.map((entry) => ({ ...entry, sourceMode: "BALANCED", consensus: entry.consensus ?? 0 }))));
  table("strict-table", ["Hora", "Fuente", "Regimen", "Score", "Confianza", "Consenso", "Hit rate esp.", "Resultado", "WIN/LOSS", "P&L"], entryRows(data.scoutEntries.map((entry) => ({ ...entry, sourceMode: "SCOUT-LIMPIO", consensus: entry.consensus ?? 0 }))));
  const dailyRows = (rows) =>
    rows.map(
      (row) =>
        `<tr><td class="mono">${row.day}</td><td class="mono">${row.total}</td><td class="mono good">${row.wins}</td><td class="mono warn">${row.gales ?? 0}</td><td class="mono bad">${row.losses}</td><td class="mono">${fmtPct(row.successRate ?? row.winRate)}</td><td class="mono ${row.net >= 0 ? "good" : "bad"}">${fmtUnits(row.net)}</td><td class="mono">${fmtTime(row.oldest)} -> ${fmtTime(row.newest)}</td></tr>`
    );
  table("scout-daily-table", ["Dia", "Total", "Ganadas", "Gales", "Perdidas", "No-loss rate", "Neto", "Rango"], dailyRows(data.daily.hybrid));
  table("balanced-daily-table", ["Dia", "Total", "Ganadas", "Gales", "Perdidas", "No-loss rate", "Neto", "Rango"], dailyRows(data.daily.balanced));
  table("strict-daily-table", ["Dia", "Total", "Ganadas", "Gales", "Perdidas", "No-loss rate", "Neto", "Rango"], dailyRows(data.daily.scout));
  document.getElementById("profit-cycle-current").innerHTML = [
    `<div class="stat"><div class="label">Ciclo actual</div><div class="value ${data.currentGainCycle.net >= 0 ? "good" : "bad"}">${fmtUnits(data.currentGainCycle.net)}</div><div class="sub">Avance hacia +5.00u</div></div>`,
    `<div class="stat"><div class="label">Operaciones del ciclo</div><div class="value">${data.currentGainCycle.entries}</div><div class="sub">${data.currentGainCycle.wins || 0} WIN · ${data.currentGainCycle.gales || 0} GALE · ${data.currentGainCycle.losses || 0} LOSS</div></div>`,
    `<div class="stat"><div class="label">Inicio del ciclo</div><div class="value" style="font-size:24px;">${data.currentGainCycle.startedAt ? fmtTime(data.currentGainCycle.startedAt) : "-"}</div><div class="sub">${data.currentGainCycle.startedAt ? dayLabel(data.currentGainCycle.startedAt) : "Esperando primer registro"}</div></div>`,
    `<div class="stat"><div class="label">Tiempo transcurrido</div><div class="value" style="font-size:24px;">${data.currentGainCycle.entries ? formatDurationMs(data.currentGainCycle.durationMs) : "-"}</div><div class="sub">${data.pendingGale ? `Gale pendiente · ${formatDurationMs(data.pendingGale.elapsedMs)}` : "Duración del ciclo abierto"}</div></div>`,
  ].join("");
  table(
    "profit-cycles-table",
    ["Ciclo", "Inicio", "Cierre", "Duracion", "Ops", "Ganadas", "Gales", "Perdidas", "Neto", "Prom./op"],
    data.gainCycles.slice(0, 50).map(
      (cycle) =>
        `<tr><td class="mono">#${cycle.cycle}</td><td class="mono">${fmtDateTime(cycle.startedAt)}</td><td class="mono">${fmtDateTime(cycle.completedAt)}</td><td class="mono">${formatDurationMs(cycle.durationMs)}</td><td class="mono">${cycle.entries}</td><td class="mono good">${cycle.wins}</td><td class="mono warn">${cycle.gales ?? 0}</td><td class="mono bad">${cycle.losses}</td><td class="mono ${cycle.net >= 5 ? "good" : ""}">${fmtUnits(cycle.net)}</td><td class="mono ${cycle.avgPerEntry >= 0 ? "good" : "bad"}">${fmtUnits(cycle.avgPerEntry)}</td></tr>`
    )
  );
  const hybridOpenCycle = data.openCycles?.hybrid;
  const openCycleCards = [
    hybridOpenCycle
      ? `<div class="stat"><div class="label">Hybrid abierto</div><div class="value" style="font-size:24px;">${hybridOpenCycle.records}/50</div><div class="sub">${hybridOpenCycle.wins}W · ${hybridOpenCycle.gales ?? 0}G · ${hybridOpenCycle.losses}L · ${fmtUnits(hybridOpenCycle.net)}</div></div>`
      : `<div class="stat"><div class="label">Hybrid abierto</div><div class="value" style="font-size:24px;">-</div><div class="sub">Sin ciclo abierto</div></div>`,
    `<div class="stat"><div class="label">No-loss rate actual</div><div class="value" style="font-size:24px;">${hybridOpenCycle ? fmtPct(hybridOpenCycle.successRate ?? hybridOpenCycle.winRate) : "0.0%"}</div><div class="sub">Del ciclo Hybrid en curso</div></div>`,
    `<div class="stat"><div class="label">Rango actual</div><div class="value" style="font-size:24px;">${hybridOpenCycle ? `${hybridOpenCycle.records}` : "0"}</div><div class="sub">${hybridOpenCycle ? `${fmtDateTime(hybridOpenCycle.oldest)} -> ${fmtDateTime(hybridOpenCycle.newest)}` : "Esperando senales"}</div></div>`,
    `<div class="stat"><div class="label">Historico cerrado</div><div class="value" style="font-size:24px;">${(data.cycles?.hybrid || []).length}</div><div class="sub">Ciclos Hybrid congelados</div></div>`,
  ].join("");
  document.getElementById("cycle-open-summary").innerHTML = openCycleCards;

  const cycles = [...(data.cycles?.hybrid || [])].sort((a, b) => new Date(b.newest || 0) - new Date(a.newest || 0));
  table(
    "cycles-table",
    ["Ciclo", "Registros", "Ganadas", "Gales", "Perdidas", "No-loss rate", "Neto", "Rango"],
    cycles.map(
      (cycle) =>
        `<tr><td class="mono">#${cycle.cycle}</td><td class="mono">${cycle.records}</td><td class="mono good">${cycle.wins}</td><td class="mono warn">${cycle.gales ?? 0}</td><td class="mono bad">${cycle.losses}</td><td class="mono">${fmtPct(cycle.successRate ?? cycle.winRate)}</td><td class="mono ${cycle.net >= 0 ? "good" : "bad"}">${fmtUnits(cycle.net)}</td><td class="mono">${fmtDateTime(cycle.oldest)} -> ${fmtDateTime(cycle.newest)}</td></tr>`
    )
  );

  const hybrid17 = data.hybrid17 || {
    entries: [],
    entryStats: { total: 0, wins: 0, gales: 0, losses: 0, successRate: 0, roi: 0 },
    daily: [],
    gainCycles: [],
    currentGainCycle: { net: 0, entries: 0, wins: 0, gales: 0, losses: 0, durationMs: 0, startedAt: null },
    openCycle: null,
    cycles: [],
    pendingGale: null,
  };
  document.getElementById("hybrid17-summary").innerHTML = [
    `<div class="stat"><div class="label">Operaciones</div><div class="value">${hybrid17.entryStats.total || 0}</div><div class="sub">Cierres reales a 1.7x</div></div>`,
    `<div class="stat"><div class="label">Ganadas</div><div class="value good">${hybrid17.entryStats.wins || 0}</div><div class="sub">WIN con +0.85u</div></div>`,
    `<div class="stat"><div class="label">Gales</div><div class="value warn">${hybrid17.entryStats.gales || 0}</div><div class="sub">GALE con +1.86u</div></div>`,
    `<div class="stat"><div class="label">ROI/op</div><div class="value ${hybrid17.entryStats.roi >= 0 ? "good" : "bad"}">${fmtUnits(hybrid17.entryStats.roi || 0)}</div><div class="sub">${fmtPct(hybrid17.entryStats.successRate || 0)} sin perdida</div></div>`,
  ].join("");
  table(
    "hybrid17-table",
    ["Hora", "Nivel", "Fuente", "Regimen", "Score", "Confianza", "Consenso", "Hit rate esp.", "Resultado", "WIN/LOSS", "P&L"],
    entryRows((hybrid17.entries || []).slice().reverse().slice(0, 50).reverse().map((entry) => ({ ...entry, consensus: entry.consensus ?? 100 })))
  );
  table("hybrid17-daily-table", ["Dia", "Total", "Ganadas", "Gales", "Perdidas", "No-loss rate", "Neto", "Rango"], dailyRows(hybrid17.daily || []));
  document.getElementById("hybrid17-profit-cycle-current").innerHTML = [
    `<div class="stat"><div class="label">Ciclo actual</div><div class="value ${hybrid17.currentGainCycle.net >= 0 ? "good" : "bad"}">${fmtUnits(hybrid17.currentGainCycle.net || 0)}</div><div class="sub">Avance hacia +5.00u</div></div>`,
    `<div class="stat"><div class="label">Operaciones del ciclo</div><div class="value">${hybrid17.currentGainCycle.entries || 0}</div><div class="sub">${hybrid17.currentGainCycle.wins || 0} WIN · ${hybrid17.currentGainCycle.gales || 0} GALE · ${hybrid17.currentGainCycle.losses || 0} LOSS</div></div>`,
    `<div class="stat"><div class="label">Inicio del ciclo</div><div class="value" style="font-size:24px;">${hybrid17.currentGainCycle.startedAt ? fmtTime(hybrid17.currentGainCycle.startedAt) : "-"}</div><div class="sub">${hybrid17.currentGainCycle.startedAt ? dayLabel(hybrid17.currentGainCycle.startedAt) : "Esperando primer registro"}</div></div>`,
    `<div class="stat"><div class="label">Tiempo transcurrido</div><div class="value" style="font-size:24px;">${hybrid17.currentGainCycle.entries ? formatDurationMs(hybrid17.currentGainCycle.durationMs) : "-"}</div><div class="sub">${hybrid17.pendingGale ? `Gale pendiente · ${formatDurationMs(hybrid17.pendingGale.elapsedMs)}` : "Duracion del ciclo abierto"}</div></div>`,
  ].join("");
  table(
    "hybrid17-profit-cycles-table",
    ["Ciclo", "Inicio", "Cierre", "Duracion", "Ops", "Ganadas", "Gales", "Perdidas", "Neto", "Prom./op"],
    (hybrid17.gainCycles || []).slice(0, 50).map(
      (cycle) =>
        `<tr><td class="mono">#${cycle.cycle}</td><td class="mono">${fmtDateTime(cycle.startedAt)}</td><td class="mono">${fmtDateTime(cycle.completedAt)}</td><td class="mono">${formatDurationMs(cycle.durationMs)}</td><td class="mono">${cycle.entries}</td><td class="mono good">${cycle.wins}</td><td class="mono warn">${cycle.gales ?? 0}</td><td class="mono bad">${cycle.losses}</td><td class="mono ${cycle.net >= 5 ? "good" : ""}">${fmtUnits(cycle.net)}</td><td class="mono ${cycle.avgPerEntry >= 0 ? "good" : "bad"}">${fmtUnits(cycle.avgPerEntry)}</td></tr>`
    )
  );
  document.getElementById("hybrid17-cycle-open-summary").innerHTML = [
    hybrid17.openCycle
      ? `<div class="stat"><div class="label">Hybrid 1.7x abierto</div><div class="value" style="font-size:24px;">${hybrid17.openCycle.records}/50</div><div class="sub">${hybrid17.openCycle.wins}W · ${hybrid17.openCycle.gales ?? 0}G · ${hybrid17.openCycle.losses}L · ${fmtUnits(hybrid17.openCycle.net)}</div></div>`
      : `<div class="stat"><div class="label">Hybrid 1.7x abierto</div><div class="value" style="font-size:24px;">-</div><div class="sub">Sin ciclo abierto</div></div>`,
    `<div class="stat"><div class="label">No-loss rate actual</div><div class="value" style="font-size:24px;">${hybrid17.openCycle ? fmtPct(hybrid17.openCycle.successRate ?? hybrid17.openCycle.winRate) : "0.0%"}</div><div class="sub">Del ciclo 1.7x en curso</div></div>`,
    `<div class="stat"><div class="label">Rango actual</div><div class="value" style="font-size:24px;">${hybrid17.openCycle ? `${hybrid17.openCycle.records}` : "0"}</div><div class="sub">${hybrid17.openCycle ? `${fmtDateTime(hybrid17.openCycle.oldest)} -> ${fmtDateTime(hybrid17.openCycle.newest)}` : "Esperando senales"}</div></div>`,
    `<div class="stat"><div class="label">Historico cerrado</div><div class="value" style="font-size:24px;">${(hybrid17.cycles || []).length}</div><div class="sub">Ciclos 1.7x congelados</div></div>`,
  ].join("");
  table(
    "hybrid17-cycles-table",
    ["Ciclo", "Registros", "Ganadas", "Gales", "Perdidas", "No-loss rate", "Neto", "Rango"],
    (hybrid17.cycles || []).map(
      (cycle) =>
        `<tr><td class="mono">#${cycle.cycle}</td><td class="mono">${cycle.records}</td><td class="mono good">${cycle.wins}</td><td class="mono warn">${cycle.gales ?? 0}</td><td class="mono bad">${cycle.losses}</td><td class="mono">${fmtPct(cycle.successRate ?? cycle.winRate)}</td><td class="mono ${cycle.net >= 0 ? "good" : "bad"}">${fmtUnits(cycle.net)}</td><td class="mono">${fmtDateTime(cycle.oldest)} -> ${fmtDateTime(cycle.newest)}</td></tr>`
    )
  );

  table(
    "validation-table",
    ["Bloque", "Rondas", "Senales", "Hit rate", "ROI/senal", "DD max"],
    data.validation.map(
      (block) =>
        `<tr><td>${block.label}</td><td class="mono">${block.rounds}</td><td class="mono">${block.signals}</td><td class="mono">${fmtPct(
          block.hitRate
        )}</td><td class="mono ${block.roi >= 0 ? "good" : "bad"}">${fmtUnits(block.roi)}</td><td class="mono ${
          block.draw <= 2 ? "good" : "bad"
        }">${block.draw.toFixed(2)}u</td></tr>`
    )
  );

  document.getElementById("robustness-cards").innerHTML = `<div class="stat" style="padding:14px;"><div class="row"><strong>Estabilidad por bloques</strong><span class="${
    data.rob.stability >= 0.6 ? "good" : "bad"
  }">${fmtPct(data.rob.stability)}</span></div><div class="sub">${data.rob.positiveBlocks}/${data.rob.totalBlocks} bloques positivos</div></div><div class="stat" style="padding:14px;"><div class="row"><strong>Lift banda alta</strong><span class="${
    data.rob.topLift >= 0 ? "good" : "bad"
  }">${fmtPct(data.rob.topLift)}</span></div><div class="sub">Ventaja de la banda premium frente al baseline</div></div><div class="stat" style="padding:14px;"><div class="row"><strong>Drawdown</strong><span class="${
    data.rob.rule.draw <= 3 ? "good" : "bad"
  }">${data.rob.rule.draw.toFixed(2)}u</span></div><div class="sub">Presion maxima del Motor Atlas</div></div><div class="stat" style="padding:14px;"><div class="row"><strong>Walk-forward</strong><span class="${
    data.wf.summary.stability >= 0.5 ? "good" : "bad"
  }">${fmtPct(data.wf.summary.stability)}</span></div><div class="sub">${data.wf.summary.positive}/${data.wf.summary.tests} ventanas positivas fuera de muestra</div></div>`;

  table(
    "score-bands-table",
    ["Banda", "Oportunidades", "Hit rate", "ROI/senal", "Neto"],
    data.bands.map(
      (band) =>
        `<tr><td>${band.label}</td><td class="mono">${band.op}</td><td class="mono">${fmtPct(band.hitRate)}</td><td class="mono ${
          band.roi >= 0 ? "good" : "bad"
        }">${fmtUnits(band.roi)}</td><td class="mono ${band.net >= 0 ? "good" : "bad"}">${fmtUnits(band.net)}</td></tr>`
    )
  );

  table(
    "audit-table",
    ["Metrica", "Estado", "Detalle"],
    [
      {
        metric: "Suficiencia muestra",
        status: data.rounds.length >= 300 ? "Fuerte" : data.rounds.length >= 180 ? "Media" : "Debil",
        detail: `${data.rounds.length} rondas`,
      },
      {
        metric: "Lift premium",
        status: data.rob.topHit > data.rob.baseline ? "Positivo" : "Negativo",
        detail: `${fmtPct(data.rob.topHit)} vs ${fmtPct(data.rob.baseline)}`,
      },
      {
        metric: "Consistencia",
        status: data.rob.stability >= 0.6 ? "Estable" : data.rob.stability >= 0.4 ? "Variable" : "Inestable",
        detail: `${data.rob.positiveBlocks}/${data.rob.totalBlocks} bloques`,
      },
      {
        metric: "Drawdown Atlas",
        status: data.rob.rule.draw <= 3 ? "Sano" : data.rob.rule.draw <= 5 ? "Moderado" : "Alto",
        detail: `${data.rob.rule.draw.toFixed(2)}u`,
      },
      {
        metric: "Walk-forward",
        status: data.wf.summary.stability >= 0.6 ? "Fuerte" : data.wf.summary.stability >= 0.4 ? "Mixto" : "Debil",
        detail: `${data.wf.summary.positive}/${data.wf.summary.tests} ventanas`,
      },
    ].map((row) => `<tr><td>${row.metric}</td><td>${row.status}</td><td class="mono">${row.detail}</td></tr>`)
  );

  table(
    "walkforward-table",
    ["Ventana", "Train", "Test", "Senales", "Hit rate", "ROI/senal", "DD max"],
    data.wf.windows.map(
      (window) =>
        `<tr><td>${window.label}</td><td class="mono">${window.train}</td><td class="mono">${window.test}</td><td class="mono">${window.signals}</td><td class="mono">${fmtPct(
          window.hitRate
        )}</td><td class="mono ${window.roi >= 0 ? "good" : "bad"}">${fmtUnits(window.roi)}</td><td class="mono ${
          window.draw <= 2 ? "good" : "bad"
        }">${window.draw.toFixed(2)}u</td></tr>`
    )
  );

  table(
    "regime-table",
    ["Regimen", "Senales", "Hit rate", "ROI/senal", "Neto"],
    data.regimes.map(
      (regime) =>
        `<tr><td>${regime.regime}</td><td class="mono">${regime.signals}</td><td class="mono">${fmtPct(regime.hitRate)}</td><td class="mono ${
          regime.roi >= 0 ? "good" : "bad"
        }">${fmtUnits(regime.roi)}</td><td class="mono ${regime.net >= 0 ? "good" : "bad"}">${fmtUnits(regime.net)}</td></tr>`
    )
  );

  table(
    "rules-table",
    ["Regla", "Senales", "Hit rate", "ROI/senal", "Neto", "DD max"],
    data.rules.map(
      (rule) =>
        `<tr><td><div><strong>${rule.label}</strong></div><div class="sub" style="margin-top:4px;">${rule.description}</div></td><td class="mono">${rule.signals}</td><td class="mono">${fmtPct(
          rule.hitRate
        )}</td><td class="mono ${rule.roi >= 0 ? "good" : "bad"}">${fmtUnits(rule.roi)}</td><td class="mono ${
          rule.net >= 0 ? "good" : "bad"
        }">${fmtUnits(rule.net)}</td><td class="mono ${rule.draw <= 2 ? "good" : "bad"}">${rule.draw.toFixed(2)}u</td></tr>`
    )
  );

  table(
    "rounds-table",
    ["Hora", "Multiplicador", "Fuente", "Objetivo 1.5x"],
    data.rounds.slice(0, 40).map(
      (round) =>
        `<tr><td>${fmtTime(round.createdAt)}</td><td class="mono ${round.multiplier >= 1.5 ? "hit" : "miss"}">${round.multiplier.toFixed(
          2
        )}x</td><td>${round.source}</td><td class="${round.multiplier >= 1.5 ? "hit" : "miss"}">${round.multiplier >= 1.5 ? "HIT" : "MISS"}</td></tr>`
    )
  );
}

async function refreshDashboard() {
  return performDashboardRefresh(true);
}

const DASHBOARD_REFRESH_MS = 2000;
let refreshInFlight = false;
let refreshQueued = false;
let scheduledRefresh = null;
let lastDashboardSignature = "";

function dashboardSignature(rounds, stats) {
  if (!rounds.length) return `0|${stats?.totalRounds ?? 0}|${stats?.lastCapturedAt ?? ""}`;
  const latest = rounds[0] || rounds[rounds.length - 1] || {};
  return [
    rounds.length,
    latest.createdAt || latest.capturedAt || latest.id || latest.multiplier || "",
    stats?.totalRounds ?? "",
    stats?.lastCapturedAt ?? "",
  ].join("|");
}

async function performDashboardRefresh(force = false) {
  if (refreshInFlight) {
    refreshQueued = true;
    return;
  }

  refreshInFlight = true;
  try {
    const response = await sendMessage({ type: "GET_DATA" });
    if (!response?.ok) return;

    const rounds = response.rounds ?? [];
    const stats = response.stats ?? {};
    const signature = dashboardSignature(rounds, stats);

    if (!force && signature === lastDashboardSignature) {
      return;
    }

    let data = build(rounds);
    const frozenHybridEntries = await freezeHybridEntries(data.entries);
    const frozenHybrid17Entries = await freezeHybrid17Entries(data.hybrid17Candidates || []);
    data = rebuildHybridFromFrozen(data, frozenHybridEntries, frozenHybrid17Entries);
    data.daily = await freezeHistoricalDailyReports(data.daily);
    data.cycles = await freezeHistoricalCycles(data.cycles);
    render(data, stats);
    lastDashboardSignature = signature;
  } catch (error) {
    console.log("[Aviator Research] dashboard refresh failed:", error?.message ?? error);
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      queueDashboardRefresh({ immediate: true });
    }
  }
}

function queueDashboardRefresh(options = {}) {
  const { immediate = false, force = false } = options;

  if (scheduledRefresh) {
    clearTimeout(scheduledRefresh);
    scheduledRefresh = null;
  }

  if (immediate) {
    return performDashboardRefresh(force);
  }

  scheduledRefresh = setTimeout(() => {
    scheduledRefresh = null;
    performDashboardRefresh(force);
  }, 150);
}

function exportReport() {
  refreshDashboard().then(async () => {
    const response = await sendMessage({ type: "GET_DATA" });
    if (!response?.ok) return;
    let data = build(response.rounds ?? []);
    const frozenHybridEntries = await freezeHybridEntries(data.entries);
    const frozenHybrid17Entries = await freezeHybrid17Entries(data.hybrid17Candidates || []);
    data = rebuildHybridFromFrozen(data, frozenHybridEntries, frozenHybrid17Entries);
    data.daily = await freezeHistoricalDailyReports(data.daily);
    data.cycles = await freezeHistoricalCycles(data.cycles);
    const payload = {
      generatedAt: new Date().toISOString(),
      summary: {
        rounds: data.rounds.length,
        hybridEntries: data.entryStats.total,
        hybridWinRate: data.entryStats.winRate,
        hybridRoi: data.entryStats.roi,
        balancedEntries: data.balancedStats.total,
        balancedWinRate: data.balancedStats.winRate,
        balancedRoi: data.balancedStats.roi,
        scoutEntries: data.scoutStats.total,
        scoutWinRate: data.scoutStats.winRate,
        scoutRoi: data.scoutStats.roi,
        mode: data.prem.mode,
        decision: data.signal.action,
        regime: data.proj.regime,
      },
      atlasThresholds: data.calibrationData.atlas,
      robustness: data.rob,
      walkForward: data.wf,
      cycles: data.cycles,
      openCycles: data.openCycles,
      daily: data.daily,
      regimes: data.regimes,
      balancedRegimes: data.balancedRegimes,
      scoutRegimes: data.scoutRegimes,
      report: data.report,
      lastHybridEntries: data.entries.slice(-25),
      lastBalancedEntries: data.balancedEntries.slice(-25),
      lastScoutEntries: data.scoutEntries.slice(-25),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `atlas-report-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });
}

document.getElementById("refresh-btn").addEventListener("click", refreshDashboard);
document.getElementById("export-json-btn").addEventListener("click", () => sendMessage({ type: "EXPORT_JSON" }));
document.getElementById("export-csv-btn").addEventListener("click", () => sendMessage({ type: "EXPORT_CSV" }));
document.getElementById("export-report-btn").addEventListener("click", exportReport);
document.getElementById("clear-btn").addEventListener("click", async () => {
  if (!confirm("Esto borrara todas las rondas almacenadas en esta extension. Â¿Continuar?")) return;
  await sendMessage({ type: "CLEAR_DATA" });
  await refreshDashboard();
});

queueDashboardRefresh({ immediate: true, force: true });
setInterval(() => queueDashboardRefresh(), DASHBOARD_REFRESH_MS);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "local" &&
    (
      changes.researchRounds ||
      changes.researchSettings ||
      changes.frozenHybridEntries ||
      changes.frozenHybrid17Entries ||
      changes.frozenDailyReports ||
      changes.frozenCycleReports
    )
  ) {
    queueDashboardRefresh();
  }
});
window.addEventListener("focus", () => queueDashboardRefresh({ immediate: true }));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) queueDashboardRefresh({ immediate: true });
});



