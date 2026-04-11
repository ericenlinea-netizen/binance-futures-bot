import { analyzeRounds, CONFIDENCE_THRESHOLD, MIN_STREAK } from "./signal-engine";

type HistoricalRound = {
  id: number;
  multiplier: number;
  createdAt: Date;
};

type WindowSummary = {
  label: string;
  size: number;
  samples: number;
  hitRate15: number;
  avgMultiplier: number;
  medianMultiplier: number;
  volatility: number;
};

type DistributionBin = {
  label: string;
  min: number;
  max: number | null;
  count: number;
  percentage: number;
};

type ResearchRuleResult = {
  id: string;
  label: string;
  description: string;
  signals: number;
  wins: number;
  losses: number;
  hitRate: number;
  roiPerSignal: number;
  netUnits: number;
  maxLossStreak: number;
};

type RecentRoundRow = {
  id: number;
  createdAt: string;
  multiplier: number;
  outcome15: "HIT" | "MISS";
  band: string;
  trailingLossesBefore: number;
};

export type ResearchDashboard = {
  overview: {
    totalRounds: number;
    hitRate15: number;
    avgMultiplier: number;
    medianMultiplier: number;
    volatility: number;
    bestWinStreak15: number;
    worstLossStreak15: number;
  };
  windows: WindowSummary[];
  distribution: DistributionBin[];
  ruleResults: ResearchRuleResult[];
  recentRounds: RecentRoundRow[];
};

const TARGET = 1.5;

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[middle - 1] + sorted[middle]) / 2;
  return sorted[middle]!;
}

function stdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const avg = average(values);
  const variance = average(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

function calcTrailingLosses(rounds: HistoricalRound[], idxExclusive: number, target = TARGET): number {
  let streak = 0;
  for (let idx = idxExclusive - 1; idx >= 0; idx--) {
    if (rounds[idx]!.multiplier < target) streak++;
    else break;
  }
  return streak;
}

function calcHitRateWindow(rounds: HistoricalRound[], idxExclusive: number, size: number, target = TARGET): number {
  const start = Math.max(0, idxExclusive - size);
  const sample = rounds.slice(start, idxExclusive);
  if (!sample.length) return 0;
  return sample.filter((round) => round.multiplier >= target).length / sample.length;
}

function getBand(multiplier: number): string {
  if (multiplier < 1.5) return "<1.5x";
  if (multiplier < 2) return "1.5x-1.99x";
  if (multiplier < 5) return "2x-4.99x";
  if (multiplier < 10) return "5x-9.99x";
  return "10x+";
}

function summarizeWindow(rounds: HistoricalRound[], size: number): WindowSummary {
  const sample = rounds.slice(-size);
  const values = sample.map((round) => round.multiplier);
  return {
    label: `Ult. ${size}`,
    size,
    samples: sample.length,
    hitRate15: sample.length ? sample.filter((round) => round.multiplier >= TARGET).length / sample.length : 0,
    avgMultiplier: average(values),
    medianMultiplier: median(values),
    volatility: stdDev(values),
  };
}

type RuleDefinition = {
  id: string;
  label: string;
  description: string;
  shouldEnter: (rounds: HistoricalRound[], index: number) => boolean;
};

function evaluateRule(rounds: HistoricalRound[], rule: RuleDefinition): ResearchRuleResult {
  let signals = 0;
  let wins = 0;
  let losses = 0;
  let netUnits = 0;
  let currentLossStreak = 0;
  let maxLossStreak = 0;

  for (let index = 0; index < rounds.length; index++) {
    if (!rule.shouldEnter(rounds, index)) continue;
    const currentRound = rounds[index]!;
    const isWin = currentRound.multiplier >= TARGET;

    signals++;
    if (isWin) {
      wins++;
      netUnits += 0.5;
      currentLossStreak = 0;
    } else {
      losses++;
      netUnits -= 1;
      currentLossStreak++;
      if (currentLossStreak > maxLossStreak) maxLossStreak = currentLossStreak;
    }
  }

  return {
    id: rule.id,
    label: rule.label,
    description: rule.description,
    signals,
    wins,
    losses,
    hitRate: signals ? wins / signals : 0,
    roiPerSignal: signals ? netUnits / signals : 0,
    netUnits,
    maxLossStreak,
  };
}

export function buildResearchDashboard(rounds: HistoricalRound[]): ResearchDashboard {
  const multipliers = rounds.map((round) => round.multiplier);
  let bestWinStreak15 = 0;
  let worstLossStreak15 = 0;
  let currentWinStreak = 0;
  let currentLossStreak = 0;

  for (const round of rounds) {
    if (round.multiplier >= TARGET) {
      currentWinStreak++;
      currentLossStreak = 0;
      if (currentWinStreak > bestWinStreak15) bestWinStreak15 = currentWinStreak;
    } else {
      currentLossStreak++;
      currentWinStreak = 0;
      if (currentLossStreak > worstLossStreak15) worstLossStreak15 = currentLossStreak;
    }
  }

  const bins: Omit<DistributionBin, "count" | "percentage">[] = [
    { label: "<1.5x", min: 0, max: 1.5 },
    { label: "1.5x-1.99x", min: 1.5, max: 2 },
    { label: "2x-4.99x", min: 2, max: 5 },
    { label: "5x-9.99x", min: 5, max: 10 },
    { label: "10x+", min: 10, max: null },
  ];

  const distribution = bins.map((bin) => {
    const count = rounds.filter((round) => {
      if (bin.max === null) return round.multiplier >= bin.min;
      return round.multiplier >= bin.min && round.multiplier < bin.max;
    }).length;
    return {
      ...bin,
      count,
      percentage: rounds.length ? count / rounds.length : 0,
    };
  });

  const rules: RuleDefinition[] = [
    {
      id: "streak-2",
      label: "Entrada tras 2 bajas",
      description: "Dispara entrada cuando las 2 rondas previas quedaron por debajo de 1.5x.",
      shouldEnter: (history, index) => calcTrailingLosses(history, index) >= 2,
    },
    {
      id: "streak-3",
      label: "Entrada tras 3 bajas",
      description: "Más conservadora: solo entra después de 3 pérdidas consecutivas.",
      shouldEnter: (history, index) => calcTrailingLosses(history, index) >= 3,
    },
    {
      id: "cold-window",
      label: "Ventana fría + 2 bajas",
      description: "Entra si el hit rate de las 10 previas es menor a 40% y además hay al menos 2 bajas seguidas.",
      shouldEnter: (history, index) =>
        index >= 10 &&
        calcTrailingLosses(history, index) >= 2 &&
        calcHitRateWindow(history, index, 10) < 0.4,
    },
    {
      id: "current-engine",
      label: "Motor actual 1.5x",
      description: "Usa la lógica de confianza actual del bot como hipótesis experimental.",
      shouldEnter: (history, index) => {
        if (index < 5) return false;
        const previousRounds = history
          .slice(0, index)
          .map((round) => ({ multiplier: round.multiplier }))
          .reverse()
          .slice(0, 50);
        const result = analyzeRounds(previousRounds, index, CONFIDENCE_THRESHOLD, MIN_STREAK, 0, TARGET);
        return result.signal === "ENTER";
      },
    },
  ];

  const ruleResults = rules
    .map((rule) => evaluateRule(rounds, rule))
    .sort((left, right) => right.roiPerSignal - left.roiPerSignal);

  const recentRounds = rounds.slice(-24).reverse().map((round, reverseIdx, reversed) => {
    const chronologicalIndex = rounds.length - 1 - reverseIdx;
    return {
      id: round.id,
      createdAt: round.createdAt.toISOString(),
      multiplier: round.multiplier,
      outcome15: round.multiplier >= TARGET ? "HIT" : "MISS",
      band: getBand(round.multiplier),
      trailingLossesBefore: calcTrailingLosses(rounds, chronologicalIndex),
    };
  });

  return {
    overview: {
      totalRounds: rounds.length,
      hitRate15: rounds.length ? rounds.filter((round) => round.multiplier >= TARGET).length / rounds.length : 0,
      avgMultiplier: average(multipliers),
      medianMultiplier: median(multipliers),
      volatility: stdDev(multipliers),
      bestWinStreak15,
      worstLossStreak15,
    },
    windows: [25, 50, 100, 200].map((size) => summarizeWindow(rounds, size)),
    distribution,
    ruleResults,
    recentRounds,
  };
}
