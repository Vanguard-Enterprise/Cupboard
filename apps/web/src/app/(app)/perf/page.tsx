import Link from "next/link";
import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";

type Sample = {
  at: string;
  fps: number;
  entities: number;
  players: number;
  memory_mb: number;
};

type Recommendation = {
  rule: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
};

type ServerRow = { server_id: string; latest: Sample };
type Detail = { latest: Sample | null; series: Sample[]; recommendations: Recommendation[] };
type Server = { id: string; name: string };

// Series color: the validated dark-surface blue (dataviz reference palette, slot 1).
const SERIES = "#3987e5";

const SEVERITY_STYLES: Record<Recommendation["severity"], string> = {
  critical: "bg-red-950 text-red-300",
  warning: "bg-yellow-950 text-yellow-300",
  info: "bg-neutral-800 text-neutral-300",
};

async function fetchJson<T>(path: string): Promise<T | null> {
  const res = await apiFetch(path);
  if (!res.ok) return null;
  return res.json();
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-neutral-800 px-4 py-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** Minimal single-series SVG line chart: 2px line, recessive grid, min/max y labels,
 * last-value direct label, native <title> tooltips per point, no legend (the title
 * names the one series). */
function LineChart({
  title,
  points,
  format,
}: {
  title: string;
  points: { at: string; v: number }[];
  format: (v: number) => string;
}) {
  const W = 560;
  const H = 150;
  const PAD = { top: 18, right: 56, bottom: 20, left: 8 };
  if (points.length < 2) {
    return (
      <div className="rounded border border-neutral-800 p-4">
        <div className="text-sm text-neutral-300">{title}</div>
        <p className="mt-4 text-sm text-neutral-500">Not enough data yet.</p>
      </div>
    );
  }
  const vs = points.map((p) => p.v);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;
  const t0 = new Date(points[0].at).getTime();
  const t1 = new Date(points[points.length - 1].at).getTime() || t0 + 1;
  const x = (at: string) =>
    PAD.left + ((new Date(at).getTime() - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
  const path = points.map((p) => `${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const time = (at: string) =>
    new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="rounded border border-neutral-800 p-4">
      <div className="text-sm text-neutral-300">{title}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label={title}>
        {/* recessive grid: top/bottom bounds only */}
        {[PAD.top, H - PAD.bottom].map((gy) => (
          <line key={gy} x1={PAD.left} x2={W - PAD.right} y1={gy} y2={gy} stroke="#262626" strokeWidth="1" />
        ))}
        <text x={W - PAD.right + 6} y={PAD.top + 4} fontSize="11" fill="#737373">
          {format(hi)}
        </text>
        <text x={W - PAD.right + 6} y={H - PAD.bottom + 4} fontSize="11" fill="#737373">
          {format(lo)}
        </text>
        <text x={PAD.left} y={H - 4} fontSize="11" fill="#737373">
          {time(points[0].at)}
        </text>
        <text x={W - PAD.right} y={H - 4} fontSize="11" fill="#737373" textAnchor="end">
          {time(last.at)}
        </text>
        <polyline points={path} fill="none" stroke={SERIES} strokeWidth="2" strokeLinejoin="round" />
        {/* last-value direct label (text ink, colored mark carries identity) */}
        <circle cx={x(last.at)} cy={y(last.v)} r="3" fill={SERIES} />
        <text x={x(last.at) + 8} y={y(last.v) + 4} fontSize="12" fill="#e5e5e5">
          {format(last.v)}
        </text>
        {/* native tooltips: generous invisible hit targets per point */}
        {points.map((p, i) => (
          <circle key={i} cx={x(p.at)} cy={y(p.v)} r="9" fill="transparent">
            <title>{`${time(p.at)} — ${format(p.v)}`}</title>
          </circle>
        ))}
      </svg>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-neutral-500">View as table</summary>
        <div className="mt-2 max-h-40 overflow-y-auto">
          <table className="w-full text-left text-xs text-neutral-400">
            <tbody>
              {points.map((p, i) => (
                <tr key={i}>
                  <td className="pr-4">{time(p.at)}</td>
                  <td className="tabular-nums">{format(p.v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export default async function PerfPage({
  searchParams,
}: {
  searchParams: Promise<{ server?: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.ServersView)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to performance.</p>;
  }
  const { server } = await searchParams;
  const [servers, reporting] = await Promise.all([
    fetchJson<Server[]>("/fleet/servers"),
    fetchJson<ServerRow[]>("/perf/servers"),
  ]);
  const serverName = (id: string) => servers?.find((s) => s.id === id)?.name ?? "unknown";
  const selected = server ?? reporting?.[0]?.server_id ?? null;
  const detail = selected ? await fetchJson<Detail>(`/perf/servers/${selected}?minutes=60`) : null;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Performance</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Server performance over the last hour, with rule-based recommendations. Data comes
          from the Cupboard plugin&apos;s perf sampler (or the CupboardPerf mod).
        </p>
      </div>

      {!reporting || reporting.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No perf data yet. Install the Cupboard plugin (with performance samples enabled)
          on a server and data appears within a minute.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 text-sm">
            {reporting.map((r) => (
              <Link
                key={r.server_id}
                href={`/perf?server=${r.server_id}`}
                className={`rounded px-2 py-1 ${selected === r.server_id ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900"}`}
              >
                {serverName(r.server_id)}
              </Link>
            ))}
          </div>

          {detail?.latest && (
            <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile label="FPS" value={detail.latest.fps.toFixed(0)} />
              <StatTile label="Players" value={String(detail.latest.players)} />
              <StatTile label="Entities" value={detail.latest.entities.toLocaleString()} />
              <StatTile
                label="Memory"
                value={`${(detail.latest.memory_mb / 1024).toFixed(1)} GB`}
              />
            </section>
          )}

          {detail && detail.recommendations.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium text-neutral-300">Recommendations</h2>
              <div className="flex flex-col gap-2">
                {detail.recommendations.map((r, i) => (
                  <div key={i} className="rounded border border-neutral-800 p-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${SEVERITY_STYLES[r.severity]}`}
                      >
                        {r.severity}
                      </span>
                      <span className="text-sm text-neutral-100">{r.title}</span>
                    </div>
                    <p className="mt-1 text-sm text-neutral-400">{r.detail}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
          {detail && detail.recommendations.length === 0 && (
            <p className="text-sm text-neutral-500">No recommendations — looking healthy.</p>
          )}

          {detail && (
            <section className="grid gap-4 lg:grid-cols-2">
              <LineChart
                title="Server FPS"
                points={detail.series.map((s) => ({ at: s.at, v: s.fps }))}
                format={(v) => v.toFixed(0)}
              />
              <LineChart
                title="Entities"
                points={detail.series.map((s) => ({ at: s.at, v: s.entities }))}
                format={(v) => Math.round(v).toLocaleString()}
              />
              <LineChart
                title="Memory (managed heap, MB)"
                points={detail.series.map((s) => ({ at: s.at, v: s.memory_mb }))}
                format={(v) => v.toFixed(0)}
              />
              <LineChart
                title="Players online"
                points={detail.series.map((s) => ({ at: s.at, v: s.players }))}
                format={(v) => Math.round(v).toString()}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
