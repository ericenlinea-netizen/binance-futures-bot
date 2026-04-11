import { useMemo, useState } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2_000, refetchOnWindowFocus: false } },
});

type CurrentSignal = {
  signal: "ENTER" | "WAIT";
  confidence: number;
  streak: number;
  hitRate10: number;
  hitRate20: number;
  hitRate50: number;
  totalRounds: number;
  reason: string;
};

type ResearchResponse = {
  overview: {
    totalRounds: number;
    hitRate15: number;
    avgMultiplier: number;
    medianMultiplier: number;
    volatility: number;
    bestWinStreak15: number;
    worstLossStreak15: number;
  };
  windows: {
    label: string;
    size: number;
    samples: number;
    hitRate15: number;
    avgMultiplier: number;
    medianMultiplier: number;
    volatility: number;
  }[];
  distribution: {
    label: string;
    min: number;
    max: number | null;
    count: number;
    percentage: number;
  }[];
  ruleResults: {
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
  }[];
  recentRounds: {
    id: number;
    createdAt: string;
    multiplier: number;
    outcome15: "HIT" | "MISS";
    band: string;
    trailingLossesBefore: number;
  }[];
};

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  }
  return response.json() as Promise<T>;
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatUnits(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}u`;
}

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-[1.4rem] border border-white/8 bg-[#131313] p-4 shadow-[0_20px_70px_rgba(0,0,0,0.28)]">
      <p className="text-[11px] uppercase tracking-[0.28em] text-zinc-500">{label}</p>
      <p className={cn("mt-2 text-3xl font-black tracking-tight text-zinc-100", accent)}>{value}</p>
      {sub ? <p className="mt-1 text-xs text-zinc-500">{sub}</p> : null}
    </div>
  );
}

function CurrentSignalPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ["signal"],
    queryFn: () => fetchJson<CurrentSignal>("/api/signal"),
    refetchInterval: 3_000,
  });

  if (isLoading || !data) {
    return <div className="min-h-[260px] rounded-[1.8rem] border border-white/8 bg-[#141414] p-6 animate-pulse" />;
  }

  const isEnter = data.signal === "ENTER";
  return (
    <section
      className={cn(
        "rounded-[1.8rem] border p-6",
        isEnter
          ? "border-emerald-400/20 bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.22),_transparent_42%),linear-gradient(180deg,#151515,#0d0d0d)]"
          : "border-amber-300/15 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.18),_transparent_40%),linear-gradient(180deg,#151515,#0d0d0d)]",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.32em] text-zinc-500">Hipótesis actual</p>
          <h2 className={cn("mt-3 text-5xl font-black tracking-tight", isEnter ? "text-emerald-300" : "text-amber-200")}>
            {isEnter ? "ENTRAR 1.5x" : "ESPERAR"}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">{data.reason}</p>
        </div>
        <div className="rounded-[1.3rem] border border-white/8 bg-black/25 px-5 py-4 text-right">
          <p className="text-[11px] uppercase tracking-[0.28em] text-zinc-500">Confianza</p>
          <p className={cn("mt-2 text-4xl font-black", isEnter ? "text-emerald-300" : "text-amber-200")}>
            {data.confidence.toFixed(0)}%
          </p>
        </div>
      </div>

      <div className="mt-5 h-3 overflow-hidden rounded-full bg-white/6">
        <div
          className={cn("h-full rounded-full transition-all duration-500", isEnter ? "bg-emerald-400" : "bg-amber-300")}
          style={{ width: `${data.confidence}%` }}
        />
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-4">
        <StatCard label="Racha baja" value={String(data.streak)} sub="Rondas seguidas por debajo de 1.5x" />
        <StatCard label="Ventana 10" value={formatPct(data.hitRate10)} sub="Éxitos recientes a 1.5x" />
        <StatCard label="Ventana 20" value={formatPct(data.hitRate20)} sub="Estabilidad de la secuencia" />
        <StatCard label="Ventana 50" value={formatPct(data.hitRate50)} sub={`${data.totalRounds} rondas acumuladas`} />
      </div>
    </section>
  );
}

function ManualCapturePanel() {
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (multiplier: number) =>
      fetchJson("/api/rounds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ multiplier }),
      }),
    onSuccess: () => {
      setMessage("Ronda agregada al estudio.");
      setError(null);
      setValue("");
      qc.invalidateQueries();
    },
    onError: (err) => {
      setMessage(null);
      setError(err instanceof Error ? err.message : "No se pudo registrar la ronda");
    },
  });

  return (
    <section className="rounded-[1.8rem] border border-white/8 bg-[#111111] p-6">
      <p className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">Carga manual</p>
      <h3 className="mt-2 text-2xl font-black tracking-tight text-zinc-100">Registrar una ronda</h3>
      <p className="mt-2 text-sm leading-6 text-zinc-400">
        Mientras afinamos la captura automática, este formulario te deja alimentar la muestra real del estudio.
      </p>

      <form
        className="mt-5 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const multiplier = Number.parseFloat(value);
          if (!Number.isFinite(multiplier) || multiplier < 1) {
            setError("Ingresa un multiplicador válido mayor o igual a 1.0.");
            setMessage(null);
            return;
          }
          mutation.mutate(multiplier);
        }}
      >
        <div className="flex gap-3">
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            type="number"
            min="1"
            step="0.01"
            placeholder="Ej: 1.67"
            className="flex-1 rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-zinc-100 outline-none transition focus:border-cyan-300/40"
          />
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded-2xl bg-cyan-300 px-4 py-3 text-sm font-bold text-black transition hover:bg-cyan-200 disabled:opacity-50"
          >
            {mutation.isPending ? "Guardando..." : "Agregar"}
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {[1.01, 1.25, 1.5, 1.78, 2, 3, 5, 10].map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setValue(preset.toFixed(2))}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/10"
            >
              {preset.toFixed(2)}x
            </button>
          ))}
        </div>

        {message ? <p className="text-sm text-emerald-300">{message}</p> : null}
        {error ? <p className="text-sm text-red-300">{error}</p> : null}
      </form>
    </section>
  );
}

function SequenceChart({ rounds }: { rounds: ResearchResponse["recentRounds"] }) {
  const data = useMemo(
    () =>
      [...rounds]
        .reverse()
        .map((round, index) => ({ idx: index + 1, multiplier: round.multiplier, hit: round.outcome15 === "HIT" })),
    [rounds],
  );

  return (
    <section className="rounded-[1.8rem] border border-white/8 bg-[#111111] p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">Secuencia reciente</p>
          <h3 className="mt-2 text-2xl font-black tracking-tight text-zinc-100">Últimas 24 rondas observadas</h3>
        </div>
        <div className="rounded-full border border-amber-200/20 bg-amber-200/10 px-3 py-1 text-xs font-medium text-amber-200">
          Línea objetivo: 1.5x
        </div>
      </div>

      <div className="mt-5 h-[280px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 16, left: -18, bottom: 0 }}>
            <defs>
              <linearGradient id="study-gradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#34d399" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#2a2a2a" strokeDasharray="4 4" />
            <XAxis dataKey="idx" tick={{ fill: "#71717a", fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#71717a", fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{
                backgroundColor: "#0c0c0c",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: "16px",
                color: "#fafafa",
              }}
              formatter={(value: number) => [`${value.toFixed(2)}x`, "Multiplicador"]}
            />
            <ReferenceLine y={1.5} stroke="#fbbf24" strokeDasharray="6 6" />
            <Area
              type="monotone"
              dataKey="multiplier"
              stroke="#34d399"
              fill="url(#study-gradient)"
              strokeWidth={2.5}
              dot={(props) => {
                const { cx, cy, payload } = props;
                if (typeof cx !== "number" || typeof cy !== "number") return null;
                return <circle cx={cx} cy={cy} r={4} fill={payload.hit ? "#34d399" : "#f87171"} />;
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function RuleTable({ rules }: { rules: ResearchResponse["ruleResults"] }) {
  return (
    <section className="rounded-[1.8rem] border border-white/8 bg-[#111111] p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">Reglas experimentales</p>
          <h3 className="mt-2 text-2xl font-black tracking-tight text-zinc-100">Pruebas de entrada a 1.5x</h3>
        </div>
        <p className="max-w-xl text-right text-sm leading-6 text-zinc-400">
          Cada regla se evalúa como hipótesis de investigación. El retorno usa una apuesta base de 1 unidad:
          ganar suma `+0.5u`, perder resta `-1u`.
        </p>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-white/8 text-left text-[11px] uppercase tracking-[0.24em] text-zinc-500">
              <th className="px-3 py-3">Regla</th>
              <th className="px-3 py-3 text-right">Señales</th>
              <th className="px-3 py-3 text-right">Hit rate</th>
              <th className="px-3 py-3 text-right">ROI/señal</th>
              <th className="px-3 py-3 text-right">Neto</th>
              <th className="px-3 py-3 text-right">Peor racha</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id} className="border-b border-white/6 align-top text-zinc-200">
                <td className="px-3 py-4">
                  <p className="font-semibold text-zinc-100">{rule.label}</p>
                  <p className="mt-1 max-w-md text-xs leading-5 text-zinc-500">{rule.description}</p>
                </td>
                <td className="px-3 py-4 text-right font-mono">{rule.signals}</td>
                <td className="px-3 py-4 text-right font-mono">{formatPct(rule.hitRate)}</td>
                <td
                  className={cn(
                    "px-3 py-4 text-right font-mono font-bold",
                    rule.roiPerSignal > 0 ? "text-emerald-300" : rule.roiPerSignal < 0 ? "text-red-300" : "text-zinc-300",
                  )}
                >
                  {formatUnits(rule.roiPerSignal)}
                </td>
                <td
                  className={cn(
                    "px-3 py-4 text-right font-mono font-bold",
                    rule.netUnits > 0 ? "text-emerald-300" : rule.netUnits < 0 ? "text-red-300" : "text-zinc-300",
                  )}
                >
                  {formatUnits(rule.netUnits)}
                </td>
                <td className="px-3 py-4 text-right font-mono text-zinc-400">{rule.maxLossStreak}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DistributionPanel({ distribution }: { distribution: ResearchResponse["distribution"] }) {
  return (
    <section className="rounded-[1.8rem] border border-white/8 bg-[#111111] p-6">
      <p className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">Distribución</p>
      <h3 className="mt-2 text-2xl font-black tracking-tight text-zinc-100">Rangos de multiplicadores</h3>

      <div className="mt-5 space-y-4">
        {distribution.map((bin, index) => (
          <div key={bin.label}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-zinc-200">{bin.label}</span>
              <span className="text-xs text-zinc-500">
                {bin.count} rondas · {formatPct(bin.percentage)}
              </span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-white/6">
              <div
                className={cn(
                  "h-full rounded-full",
                  index === 0 && "bg-[#f87171]",
                  index === 1 && "bg-[#fb923c]",
                  index === 2 && "bg-[#facc15]",
                  index === 3 && "bg-[#38bdf8]",
                  index === 4 && "bg-[#8b5cf6]",
                )}
                style={{ width: `${Math.max(bin.percentage * 100, 3)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function WindowPanel({ windows }: { windows: ResearchResponse["windows"] }) {
  return (
    <section className="rounded-[1.8rem] border border-white/8 bg-[#111111] p-6">
      <p className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">Ventanas</p>
      <h3 className="mt-2 text-2xl font-black tracking-tight text-zinc-100">Comportamiento por bloques</h3>

      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {windows.map((window) => (
          <div key={window.label} className="rounded-[1.4rem] border border-white/8 bg-black/20 p-4">
            <p className="text-[11px] uppercase tracking-[0.28em] text-zinc-500">{window.label}</p>
            <p className="mt-2 text-3xl font-black text-zinc-100">{formatPct(window.hitRate15)}</p>
            <div className="mt-3 space-y-2 text-sm text-zinc-400">
              <div className="flex justify-between">
                <span>Promedio</span>
                <span className="font-mono text-zinc-200">{window.avgMultiplier.toFixed(2)}x</span>
              </div>
              <div className="flex justify-between">
                <span>Mediana</span>
                <span className="font-mono text-zinc-200">{window.medianMultiplier.toFixed(2)}x</span>
              </div>
              <div className="flex justify-between">
                <span>Volatilidad</span>
                <span className="font-mono text-zinc-200">{window.volatility.toFixed(2)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RecentRoundsTable({ rounds }: { rounds: ResearchResponse["recentRounds"] }) {
  return (
    <section className="rounded-[1.8rem] border border-white/8 bg-[#111111] p-6">
      <p className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">Rondas recientes</p>
      <h3 className="mt-2 text-2xl font-black tracking-tight text-zinc-100">Bitácora de observación</h3>

      <div className="mt-5 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-white/8 text-left text-[11px] uppercase tracking-[0.24em] text-zinc-500">
              <th className="px-3 py-3">Hora</th>
              <th className="px-3 py-3 text-right">Multiplicador</th>
              <th className="px-3 py-3 text-right">Banda</th>
              <th className="px-3 py-3 text-right">Racha baja previa</th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((round) => (
              <tr key={round.id} className="border-b border-white/6 text-zinc-200">
                <td className="px-3 py-3 text-zinc-400">
                  {new Date(round.createdAt).toLocaleTimeString("es-CO", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </td>
                <td
                  className={cn(
                    "px-3 py-3 text-right font-mono font-bold",
                    round.outcome15 === "HIT" ? "text-emerald-300" : "text-red-300",
                  )}
                >
                  {round.multiplier.toFixed(2)}x
                </td>
                <td className="px-3 py-3 text-right text-zinc-400">{round.band}</td>
                <td className="px-3 py-3 text-right font-mono text-zinc-300">{round.trailingLossesBefore}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Dashboard() {
  const { data: research, isLoading, error } = useQuery({
    queryKey: ["research"],
    queryFn: () => fetchJson<ResearchResponse>("/api/research"),
    refetchInterval: 4_000,
  });

  if (error) {
    return <div className="min-h-screen bg-[#0a0a0a] text-red-300 p-8">No se pudo cargar el panel de investigación.</div>;
  }

  if (isLoading || !research) {
    return <div className="min-h-screen bg-[#0a0a0a] text-white p-8">Cargando panel de investigación...</div>;
  }

  const bestRule = research.ruleResults[0];

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.08),_transparent_28%),linear-gradient(180deg,#090909,#050505)] text-white">
      <header className="border-b border-white/6 bg-black/20 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-5">
          <div>
            <p className="text-[11px] uppercase tracking-[0.36em] text-zinc-500">Aviator Research Lab</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-zinc-100">
              Estudio de entradas experimentales a 1.5x
            </h1>
          </div>
          <div className="flex items-center gap-3 rounded-full border border-emerald-300/15 bg-emerald-300/10 px-4 py-2 text-sm text-emerald-200">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-300 animate-pulse" />
            Monitoreo en vivo
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-7xl flex-col gap-5 px-5 py-6">
        <section className="grid gap-5 xl:grid-cols-[1.4fr_0.8fr]">
          <CurrentSignalPanel />
          <div className="flex flex-col gap-5">
            <ManualCapturePanel />
            <section className="rounded-[1.8rem] border border-white/8 bg-[#111111] p-6">
              <p className="text-[11px] uppercase tracking-[0.3em] text-zinc-500">Mejor regla provisional</p>
              <h3 className="mt-2 text-2xl font-black tracking-tight text-zinc-100">{bestRule?.label ?? "Sin datos"}</h3>
              <p className="mt-2 text-sm leading-6 text-zinc-400">{bestRule?.description}</p>
              {bestRule ? (
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <StatCard label="Hit rate" value={formatPct(bestRule.hitRate)} />
                  <StatCard
                    label="ROI/señal"
                    value={formatUnits(bestRule.roiPerSignal)}
                    accent={bestRule.roiPerSignal > 0 ? "text-emerald-300" : "text-red-300"}
                  />
                </div>
              ) : null}
            </section>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Total rondas" value={String(research.overview.totalRounds)} sub="Base empírica actual" />
          <StatCard label="Hit rate 1.5x" value={formatPct(research.overview.hitRate15)} sub="Entrar siempre, sin filtro" />
          <StatCard label="Promedio" value={`${research.overview.avgMultiplier.toFixed(2)}x`} sub={`Mediana ${research.overview.medianMultiplier.toFixed(2)}x`} />
          <StatCard
            label="Rachas"
            value={`${research.overview.worstLossStreak15}/${research.overview.bestWinStreak15}`}
            sub="Peor racha baja / mejor racha alta"
          />
        </section>

        <SequenceChart rounds={research.recentRounds} />
        <RuleTable rules={research.ruleResults} />

        <section className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
          <DistributionPanel distribution={research.distribution} />
          <WindowPanel windows={research.windows} />
        </section>

        <RecentRoundsTable rounds={research.recentRounds} />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  );
}
