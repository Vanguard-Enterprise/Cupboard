import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";

type HookTiming = { plugin: string; total_ms: number };
type NamedTiming = { name: string; total_ms: number };
type PerfTimings = {
  invoke_execution: NamedTiming[];
  server_update: NamedTiming[];
  rpc_calls: NamedTiming[];
  work_queue: NamedTiming[];
  console_commands: NamedTiming[];
  timewarnings: NamedTiming[];
};
type NetworkUpdate = { message_type: string; count: number; bytes: number };
type PlayerPerf = {
  steam_id: string;
  ip?: string | null;
  ping_ms?: number | null;
  packet_loss?: number | null;
  client_fps?: number | null;
  client_memory_mb?: number | null;
};

type Sample = {
  at: string;
  fps: number;
  fps_avg?: number | null;
  frame_ms?: number | null;
  frame_ms_avg?: number | null;
  frame_ms_max?: number | null;
  entities: number;
  players: number;
  memory_mb: number;
  managed_memory_mb?: number | null;
  gc_gen0: number;
  gc_gen1: number;
  gc_gen2: number;
  memory_collections?: number | null;
  memory_allocations?: number | null;
  gc_triggered?: number | null;
  task_load_balancer?: number | null;
  task_invoke_handler?: number | null;
  task_workshop_skins_queue?: number | null;
  network_bytes_received?: number | null;
  network_bytes_sent?: number | null;
  network_packet_loss?: number | null;
  players_joining?: number | null;
  players_queued?: number | null;
  hooks: HookTiming[];
  timings?: PerfTimings;
  network_updates: NetworkUpdate[];
  player_metrics: PlayerPerf[];
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

// Ordinary performance data stays neutral; semantic color is reserved for severity badges.
const SERIES = "var(--foreground)";
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

function display(value: number | null | undefined, digits = 0) {
  return value == null ? "—" : value.toFixed(digits);
}

function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <Card size="sm">
      <CardContent className="pt-3">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {detail && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
      </CardContent>
    </Card>
  );
}

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
      <Card>
        <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Not enough data yet.</p></CardContent>
      </Card>
    );
  }
  const values = points.map((p) => p.v);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) { hi += 1; lo -= 1; }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;
  const t0 = new Date(points[0].at).getTime();
  const t1 = new Date(points[points.length - 1].at).getTime() || t0 + 1;
  const x = (at: string) => PAD.left + ((new Date(at).getTime() - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
  const path = points.map((p) => `${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label={title}>
          {[PAD.top, H - PAD.bottom].map((gy) => (
            <line key={gy} x1={PAD.left} x2={W - PAD.right} y1={gy} y2={gy} stroke="currentColor" strokeOpacity=".12" />
          ))}
          <text x={W - PAD.right + 6} y={PAD.top + 4} fontSize="11" fill="currentColor" opacity=".55">{format(hi)}</text>
          <text x={W - PAD.right + 6} y={H - PAD.bottom + 4} fontSize="11" fill="currentColor" opacity=".55">{format(lo)}</text>
          <text x={PAD.left} y={H - 4} fontSize="11" fill="currentColor" opacity=".55">{time(points[0].at)}</text>
          <text x={W - PAD.right} y={H - 4} fontSize="11" fill="currentColor" opacity=".55" textAnchor="end">{time(last.at)}</text>
          <polyline points={path} fill="none" stroke={SERIES} strokeWidth="2" strokeLinejoin="round" />
          <circle cx={x(last.at)} cy={y(last.v)} r="3" fill={SERIES} />
          <text x={x(last.at) + 8} y={y(last.v) + 4} fontSize="12" fill="currentColor">{format(last.v)}</text>
          {points.map((p, i) => (
            <circle key={i} cx={x(p.at)} cy={y(p.v)} r="9" fill="transparent">
              <title>{`${time(p.at)} — ${format(p.v)}`}</title>
            </circle>
          ))}
        </svg>
      </CardContent>
    </Card>
  );
}

function TimingTable({ title, rows }: { title: string; rows: NamedTiming[] }) {
  return (
    <Card className="gap-0">
      <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{rows.length} entries in the latest sample</CardDescription></CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No entries reported.</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>Name</TableHead><TableHead className="text-end">Total ms</TableHead></TableRow></TableHeader>
            <TableBody>{rows.map((row) => <TableRow key={row.name}><TableCell className="font-mono text-xs">{row.name}</TableCell><TableCell className="text-end tabular-nums">{row.total_ms.toFixed(2)}</TableCell></TableRow>)}</TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function LatestDiagnostics({ sample }: { sample: Sample }) {
  const timings = sample.timings ?? {
    invoke_execution: [], server_update: [], rpc_calls: [], work_queue: [], console_commands: [], timewarnings: [],
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-0">
          <CardHeader><CardTitle>Memory, GC, and queues</CardTitle><CardDescription>Latest perf-mod sample</CardDescription></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableBody>
                <TableRow><TableCell>Process memory</TableCell><TableCell className="text-end tabular-nums">{sample.memory_mb.toFixed(0)} MB</TableCell></TableRow>
                <TableRow><TableCell>Managed heap</TableCell><TableCell className="text-end tabular-nums">{display(sample.managed_memory_mb)} MB</TableCell></TableRow>
                <TableRow><TableCell>GC collections (gen 0 / 1 / 2)</TableCell><TableCell className="text-end tabular-nums">{sample.gc_gen0} / {sample.gc_gen1} / {sample.gc_gen2}</TableCell></TableRow>
                <TableRow><TableCell>Memory collections / allocations</TableCell><TableCell className="text-end tabular-nums">{display(sample.memory_collections)} / {display(sample.memory_allocations)}</TableCell></TableRow>
                <TableRow><TableCell>GC triggered</TableCell><TableCell className="text-end tabular-nums">{display(sample.gc_triggered)}</TableCell></TableRow>
                <TableRow><TableCell>Task queues (load / invoke / skins)</TableCell><TableCell className="text-end tabular-nums">{display(sample.task_load_balancer)} / {display(sample.task_invoke_handler)} / {display(sample.task_workshop_skins_queue)}</TableCell></TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card className="gap-0">
          <CardHeader><CardTitle>Network and connection queue</CardTitle><CardDescription>Latest server counters</CardDescription></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableBody>
                <TableRow><TableCell>Bytes received / sent</TableCell><TableCell className="text-end tabular-nums">{display(sample.network_bytes_received)} / {display(sample.network_bytes_sent)}</TableCell></TableRow>
                <TableRow><TableCell>Server packet loss</TableCell><TableCell className="text-end tabular-nums">{display(sample.network_packet_loss)}</TableCell></TableRow>
                <TableRow><TableCell>Players online</TableCell><TableCell className="text-end tabular-nums">{sample.players}</TableCell></TableRow>
                <TableRow><TableCell>Joining / queued</TableCell><TableCell className="text-end tabular-nums">{display(sample.players_joining)} / {display(sample.players_queued)}</TableCell></TableRow>
                <TableRow><TableCell>Network message types</TableCell><TableCell className="text-end tabular-nums">{sample.network_updates.length}</TableCell></TableRow>
                <TableRow><TableCell>Player telemetry records</TableCell><TableCell className="text-end tabular-nums">{sample.player_metrics.length}</TableCell></TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <TimingTable title="Invoke execution" rows={timings.invoke_execution} />
        <TimingTable title="Server updates" rows={timings.server_update} />
        <TimingTable title="RPC calls" rows={timings.rpc_calls} />
        <TimingTable title="Work queue" rows={timings.work_queue} />
        <TimingTable title="Console commands" rows={timings.console_commands} />
        <TimingTable title="Time warnings" rows={timings.timewarnings} />
      </div>

      <Card className="gap-0">
        <CardHeader><CardTitle>Plugin hook times</CardTitle><CardDescription>Top hooks reported by the perf mod</CardDescription></CardHeader>
        <CardContent className="p-0">
          {sample.hooks.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No plugin hook timings reported.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Plugin</TableHead><TableHead className="text-end">Total ms</TableHead></TableRow></TableHeader>
              <TableBody>{sample.hooks.map((hook) => <TableRow key={hook.plugin}><TableCell>{hook.plugin}</TableCell><TableCell className="text-end tabular-nums">{hook.total_ms.toFixed(2)}</TableCell></TableRow>)}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="gap-0">
        <CardHeader><CardTitle>Network update breakdown</CardTitle><CardDescription>Message counts and bytes for the latest sample window</CardDescription></CardHeader>
        <CardContent className="p-0">
          {sample.network_updates.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No network update breakdown reported.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Message type</TableHead><TableHead className="text-end">Count</TableHead><TableHead className="text-end">Bytes</TableHead></TableRow></TableHeader>
              <TableBody>{sample.network_updates.map((row) => <TableRow key={row.message_type}><TableCell className="font-mono text-xs">{row.message_type}</TableCell><TableCell className="text-end tabular-nums">{row.count.toLocaleString()}</TableCell><TableCell className="text-end tabular-nums">{row.bytes.toLocaleString()}</TableCell></TableRow>)}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="gap-0">
        <CardHeader><CardTitle>Player telemetry</CardTitle><CardDescription>Client FPS, memory, latency, and packet loss from the latest sample</CardDescription></CardHeader>
        <CardContent className="p-0">
          {sample.player_metrics.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No player telemetry reported.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Steam ID</TableHead><TableHead>IP</TableHead><TableHead className="text-end">Client FPS</TableHead><TableHead className="text-end">Memory MB</TableHead><TableHead className="text-end">Ping ms</TableHead><TableHead className="text-end">Packet loss</TableHead></TableRow></TableHeader>
              <TableBody>{sample.player_metrics.map((row) => <TableRow key={row.steam_id}><TableCell className="font-mono text-xs">{row.steam_id}</TableCell><TableCell className="font-mono text-xs">{row.ip ?? "—"}</TableCell><TableCell className="text-end tabular-nums">{display(row.client_fps)}</TableCell><TableCell className="text-end tabular-nums">{display(row.client_memory_mb)}</TableCell><TableCell className="text-end tabular-nums">{display(row.ping_ms)}</TableCell><TableCell className="text-end tabular-nums">{display(row.packet_loss)}</TableCell></TableRow>)}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default async function PerfPage({ searchParams }: { searchParams: Promise<{ server?: string }> }) {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.ServersView)) return <p className="text-sm text-muted-foreground">You don&apos;t have access to performance.</p>;

  const { server } = await searchParams;
  const [servers, reporting] = await Promise.all([
    fetchJson<Server[]>("/fleet/servers"),
    fetchJson<ServerRow[]>("/perf/servers"),
  ]);
  const serverName = (id: string) => servers?.find((item) => item.id === id)?.name ?? "unknown";
  const selected = server ?? reporting?.[0]?.server_id ?? null;
  const detail = selected ? await fetchJson<Detail>(`/perf/servers/${selected}?minutes=60`) : null;
  const latest = detail?.latest;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Performance</h1>
        <p className="mt-1 text-sm text-muted-foreground">Complete recent server telemetry from CupboardPerf, including Rust.ServerMetrics-style timings, network, queues, and player diagnostics.</p>
      </div>

      {!reporting || reporting.length === 0 ? (
        <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">No perf data yet. Install and configure CupboardPerf on a server; CupboardLink does not emit performance data.</p></CardContent></Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 text-sm">
            {reporting.map((row) => <Link key={row.server_id} href={`/perf?server=${row.server_id}`} className={`rounded-md px-3 py-1.5 ${selected === row.server_id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60"}`}>{serverName(row.server_id)}</Link>)}
          </div>

          {latest && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
                <StatTile label="FPS" value={latest.fps.toFixed(0)} detail={`avg ${display(latest.fps_avg)}`} />
                <StatTile label="Frame time" value={`${display(latest.frame_ms_avg, 2)} ms`} detail={`max ${display(latest.frame_ms_max, 2)} ms`} />
                <StatTile label="Players" value={latest.players.toLocaleString()} detail={`queue ${display(latest.players_joining)}/${display(latest.players_queued)}`} />
                <StatTile label="Entities" value={latest.entities.toLocaleString()} />
                <StatTile label="Process memory" value={`${(latest.memory_mb / 1024).toFixed(1)} GB`} />
                <StatTile label="Managed heap" value={`${display(latest.managed_memory_mb, 0)} MB`} />
                <StatTile label="Net in" value={`${display(latest.network_bytes_received)}`} detail="bytes/sample" />
                <StatTile label="Net out" value={`${display(latest.network_bytes_sent)}`} detail="bytes/sample" />
              </div>
              <section className="grid gap-4 lg:grid-cols-2">
                <LineChart title="Server FPS" points={detail?.series.map((item) => ({ at: item.at, v: item.fps })) ?? []} format={(v) => v.toFixed(0)} />
                <LineChart title="Average frame time (ms)" points={detail?.series.filter((item) => item.frame_ms_avg != null).map((item) => ({ at: item.at, v: item.frame_ms_avg as number })) ?? []} format={(v) => v.toFixed(2)} />
                <LineChart title="Maximum frame time (ms)" points={detail?.series.filter((item) => item.frame_ms_max != null).map((item) => ({ at: item.at, v: item.frame_ms_max as number })) ?? []} format={(v) => v.toFixed(2)} />
                <LineChart title="Entities" points={detail?.series.map((item) => ({ at: item.at, v: item.entities })) ?? []} format={(v) => Math.round(v).toLocaleString()} />
                <LineChart title="Players online" points={detail?.series.map((item) => ({ at: item.at, v: item.players })) ?? []} format={(v) => Math.round(v).toString()} />
                <LineChart title="Process memory (MB)" points={detail?.series.map((item) => ({ at: item.at, v: item.memory_mb })) ?? []} format={(v) => v.toFixed(0)} />
                <LineChart title="Managed heap (MB)" points={detail?.series.filter((item) => item.managed_memory_mb != null).map((item) => ({ at: item.at, v: item.managed_memory_mb as number })) ?? []} format={(v) => v.toFixed(0)} />
                <LineChart title="Network bytes received" points={detail?.series.filter((item) => item.network_bytes_received != null).map((item) => ({ at: item.at, v: item.network_bytes_received as number })) ?? []} format={(v) => Math.round(v).toLocaleString()} />
                <LineChart title="Network bytes sent" points={detail?.series.filter((item) => item.network_bytes_sent != null).map((item) => ({ at: item.at, v: item.network_bytes_sent as number })) ?? []} format={(v) => Math.round(v).toLocaleString()} />
                <LineChart title="Server packet loss" points={detail?.series.filter((item) => item.network_packet_loss != null).map((item) => ({ at: item.at, v: item.network_packet_loss as number })) ?? []} format={(v) => Math.round(v).toLocaleString()} />
                <LineChart title="Invoke handler queue" points={detail?.series.filter((item) => item.task_invoke_handler != null).map((item) => ({ at: item.at, v: item.task_invoke_handler as number })) ?? []} format={(v) => Math.round(v).toLocaleString()} />
                <LineChart title="Gen-2 collections" points={detail?.series.map((item) => ({ at: item.at, v: item.gc_gen2 })) ?? []} format={(v) => Math.round(v).toLocaleString()} />
              </section>
              {detail && <LatestDiagnostics sample={latest} />}
            </>
          )}

          {detail && detail.recommendations.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium">Recommendations</h2>
              {detail.recommendations.map((recommendation, index) => <div key={index} className="rounded-lg border border-border p-3"><div className="flex items-center gap-2"><span className={`rounded px-2 py-0.5 text-xs ${SEVERITY_STYLES[recommendation.severity]}`}>{recommendation.severity}</span><span className="text-sm">{recommendation.title}</span></div><p className="mt-1 text-sm text-muted-foreground">{recommendation.detail}</p></div>)}
            </section>
          )}
        </>
      )}
    </div>
  );
}
