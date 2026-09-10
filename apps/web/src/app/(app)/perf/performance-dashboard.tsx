"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  BoxesIcon,
  Clock3Icon,
  CpuIcon,
  GaugeIcon,
  InfoIcon,
  NetworkIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  TimerIcon,
  UsersIcon,
  WifiIcon,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
  steam_id?: string | null;
  ip?: string | null;
  ping_ms?: number | null;
  packet_loss?: number | null;
  client_fps?: number | null;
  client_memory_mb?: number | null;
};

export type PerfSample = {
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
};

type LatestSample = PerfSample & {
  timings: PerfTimings;
  network_updates: NetworkUpdate[];
  player_metrics: PlayerPerf[];
};

type Recommendation = {
  rule: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
};

export type PerfServerRow = { server_id: string; latest: PerfSample };
export type PerfDetail = {
  latest: LatestSample | null;
  series: PerfSample[];
  recommendations: Recommendation[];
};
export type PerfServer = { id: string; name: string };

type ChartDatum = Record<string, number | string | null> & { at: string };
type ChartSeries = { key: string; label: string; color: string; dashed?: boolean };

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const RANGE_OPTIONS = [
  { value: 15, label: "15m" },
  { value: 30, label: "30m" },
  { value: 60, label: "1h" },
  { value: 120, label: "2h" },
];

const SEVERITY_VARIANT = {
  critical: "destructive",
  warning: "secondary",
  info: "outline",
} as const;

function display(value: number | null | undefined, digits = 0) {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function compact(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatBytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let amount = Math.abs(value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const signed = value < 0 ? -amount : amount;
  return `${signed.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatMbps(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(2)} Mbit`;
}

function average(values: Array<number | null | undefined>) {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value));
  return valid.length ? valid.reduce((total, value) => total + value, 0) / valid.length : null;
}

function percentile(values: Array<number | null | undefined>, percent: number) {
  const valid = values
    .filter((value): value is number => value != null && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!valid.length) return null;
  const index = Math.min(valid.length - 1, Math.max(0, Math.ceil((percent / 100) * valid.length) - 1));
  return valid[index];
}

function mode(values: Array<number | null | undefined>) {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value));
  if (!valid.length) return null;
  const counts = new Map<number, number>();
  let result = valid[0];
  let highestCount = 0;
  for (const value of valid) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > highestCount) {
      result = value;
      highestCount = count;
    }
  }
  return result;
}

function sampleAge(at: string) {
  return Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
}

function relativeSampleTime(at: string) {
  const seconds = sampleAge(at);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function timeLabel(at: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}

function timeTooltip(at: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(at));
}

function freshness(at: string) {
  const seconds = sampleAge(at);
  if (seconds < 90) return { label: "Live", variant: "default" as const };
  if (seconds < 300) return { label: "Delayed", variant: "secondary" as const };
  return { label: "Stale", variant: "destructive" as const };
}

function rows(
  series: PerfSample[],
  fields: Record<string, (sample: PerfSample) => number | null | undefined>,
): ChartDatum[] {
  return series.map((sample) => {
    const row: ChartDatum = { at: sample.at };
    for (const [key, getValue] of Object.entries(fields)) row[key] = getValue(sample) ?? null;
    return row;
  });
}

function entityRateRows(series: PerfSample[]): ChartDatum[] {
  return series.slice(1).map((sample, index) => {
    const previous = series[index];
    const seconds = (new Date(sample.at).getTime() - new Date(previous.at).getTime()) / 1000;
    return {
      at: sample.at,
      rate: seconds > 0 ? (sample.entities - previous.entities) / seconds : null,
    };
  });
}

function hookRateData(series: PerfSample[]) {
  const totals = new Map<string, number>();
  for (const sample of series) {
    for (const hook of sample.hooks) totals.set(hook.plugin, Math.max(totals.get(hook.plugin) ?? 0, hook.total_ms));
  }
  const plugins = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([plugin]) => plugin);
  const specs = plugins.map((plugin, index) => ({
    key: `hook_${index}`,
    label: plugin,
    color: CHART_COLORS[index % CHART_COLORS.length],
  }));
  const data = series.slice(1).map((sample, index) => {
    const previous = series[index];
    const seconds = (new Date(sample.at).getTime() - new Date(previous.at).getTime()) / 1000;
    const row: ChartDatum = { at: sample.at };
    specs.forEach((spec, specIndex) => {
      const plugin = plugins[specIndex];
      const current = sample.hooks.find((hook) => hook.plugin === plugin)?.total_ms;
      const before = previous.hooks.find((hook) => hook.plugin === plugin)?.total_ms;
      row[spec.key] = current != null && before != null && current >= before && seconds > 0
        ? (current - before) / seconds
        : null;
    });
    return row;
  });
  return { data, specs };
}

function MetricChart({
  title,
  description,
  data,
  series,
  valueFormatter = compact,
}: {
  title: string;
  description: string;
  data: ChartDatum[];
  series: ChartSeries[];
  valueFormatter?: (value: number) => string;
}) {
  const config = Object.fromEntries(
    series.map((item) => [item.key, { label: item.label, color: item.color }]),
  ) satisfies ChartConfig;
  const chartId = React.useId().replace(/:/g, "");
  const hasValues = data.some((row) => series.some((item) => typeof row[item.key] === "number"));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {!hasValues ? (
          <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
            No samples in this range.
          </div>
        ) : (
          <ChartContainer id={chartId} config={config} className="h-64 w-full aspect-auto">
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
              <defs>
                {series.map((item) => (
                  <linearGradient key={item.key} id={`${chartId}-${item.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={`var(--color-${item.key})`} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={`var(--color-${item.key})`} stopOpacity={0.02} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="at"
                tickFormatter={(value) => timeLabel(String(value))}
                tickLine={false}
                axisLine={false}
                minTickGap={42}
              />
              <YAxis
                tickFormatter={(value) => valueFormatter(Number(value))}
                tickLine={false}
                axisLine={false}
                width={52}
                domain={["auto", "auto"]}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      const at = payload?.[0]?.payload?.at;
                      return at ? timeTooltip(String(at)) : "";
                    }}
                    formatter={(value, name) => (
                      <>
                        <span
                          className="size-2.5 shrink-0 rounded-sm"
                          style={{ backgroundColor: `var(--color-${String(name)})` }}
                        />
                        <span className="flex-1 text-muted-foreground">
                          {config[String(name)]?.label ?? String(name)}
                        </span>
                        <span className="font-mono font-medium tabular-nums text-foreground">
                          {valueFormatter(Number(Array.isArray(value) ? value[0] : value))}
                        </span>
                      </>
                    )}
                  />
                }
              />
              {series.length > 1 && <ChartLegend content={<ChartLegendContent className="flex-wrap" />} />}
              {series.map((item) => (
                <Area
                  key={item.key}
                  dataKey={item.key}
                  name={item.key}
                  type="monotone"
                  stroke={`var(--color-${item.key})`}
                  fill={`url(#${chartId}-${item.key})`}
                  fillOpacity={1}
                  strokeWidth={2}
                  strokeDasharray={item.dashed ? "5 5" : undefined}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function StatTile({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex min-h-28 flex-col justify-between">
        <div className="flex items-center justify-between gap-3 text-muted-foreground">
          <span className="text-xs">{label}</span>
          <span className="[&_svg]:size-4">{icon}</span>
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
          {detail && <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function Recommendations({ recommendations }: { recommendations: Recommendation[] }) {
  if (!recommendations.length) return null;
  return (
    <section aria-labelledby="recommendations-title" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <AlertTriangleIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 id="recommendations-title" className="text-sm font-medium">Needs attention</h2>
        <Badge variant="secondary">{recommendations.length}</Badge>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {recommendations.map((recommendation) => (
          <Card key={`${recommendation.rule}-${recommendation.title}`} size="sm">
            <CardHeader>
              <CardTitle>{recommendation.title}</CardTitle>
              <CardAction>
                <Badge variant={SEVERITY_VARIANT[recommendation.severity]}>{recommendation.severity}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{recommendation.detail}</CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function DiagnosticTable({
  title,
  description,
  values,
}: {
  title: string;
  description: string;
  values: Array<{ label: string; value: string }>;
}) {
  return (
    <Card className="gap-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableBody>
            {values.map((item) => (
              <TableRow key={item.label}>
                <TableCell>{item.label}</TableCell>
                <TableCell className="text-end font-mono text-xs tabular-nums">{item.value}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function TimingTable({ title, rows: timingRows }: { title: string; rows: NamedTiming[] }) {
  const sorted = [...timingRows].sort((a, b) => b.total_ms - a.total_ms);
  return (
    <Card className="gap-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{sorted.length} entries in the latest sample</CardDescription>
      </CardHeader>
      <CardContent className="max-h-80 overflow-auto p-0">
        {!sorted.length ? (
          <p className="p-4 text-sm text-muted-foreground">No entries reported.</p>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow><TableHead>Name</TableHead><TableHead className="text-end">Total ms</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((item, index) => (
                <TableRow key={`${item.name}-${index}`}>
                  <TableCell className="max-w-0 truncate font-mono text-xs" title={item.name}>{item.name}</TableCell>
                  <TableCell className="text-end font-mono text-xs tabular-nums">{item.total_ms.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function PluginTable({ hooks }: { hooks: HookTiming[] }) {
  const sorted = [...hooks].sort((a, b) => b.total_ms - a.total_ms);
  return (
    <Card className="gap-0">
      <CardHeader>
        <CardTitle>Plugin hook totals</CardTitle>
        <CardDescription>Highest cumulative hook cost reported in the latest sample</CardDescription>
      </CardHeader>
      <CardContent className="max-h-96 overflow-auto p-0">
        {!sorted.length ? (
          <p className="p-4 text-sm text-muted-foreground">No plugin hook timings reported.</p>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow><TableHead>Plugin</TableHead><TableHead className="text-end">Total ms</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((hook, index) => (
                <TableRow key={`${hook.plugin}-${index}`}>
                  <TableCell>{hook.plugin}</TableCell>
                  <TableCell className="text-end font-mono text-xs tabular-nums">{hook.total_ms.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function NetworkUpdateTable({ updates }: { updates: NetworkUpdate[] }) {
  const sorted = [...updates].sort((a, b) => b.bytes - a.bytes);
  const totalBytes = sorted.reduce((total, update) => total + update.bytes, 0);
  return (
    <Card className="gap-0">
      <CardHeader>
        <CardTitle>Network update breakdown</CardTitle>
        <CardDescription>Message types ranked by bytes in the latest sample</CardDescription>
      </CardHeader>
      <CardContent className="max-h-[32rem] overflow-auto p-0">
        {!sorted.length ? (
          <p className="p-4 text-sm text-muted-foreground">No network update breakdown reported.</p>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>Message type</TableHead>
                <TableHead className="text-end">Count</TableHead>
                <TableHead className="text-end">Bytes</TableHead>
                <TableHead className="text-end">Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((update, index) => (
                <TableRow key={`${update.message_type}-${index}`}>
                  <TableCell className="max-w-0 truncate font-mono text-xs" title={update.message_type}>{update.message_type}</TableCell>
                  <TableCell className="text-end font-mono text-xs tabular-nums">{update.count.toLocaleString()}</TableCell>
                  <TableCell className="text-end font-mono text-xs tabular-nums">{formatBytes(update.bytes)}</TableCell>
                  <TableCell className="text-end font-mono text-xs tabular-nums">
                    {totalBytes > 0 ? `${((update.bytes / totalBytes) * 100).toFixed(1)}%` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function PlayerDiagnostics({ players }: { players: PlayerPerf[] }) {
  const [query, setQuery] = React.useState("");
  const filtered = React.useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return players;
    return players.filter((player) =>
      [player.steam_id, player.ip].some((value) => value?.toLowerCase().includes(term)),
    );
  }, [players, query]);

  return (
    <Card className="gap-0">
      <CardHeader>
        <CardTitle>Player diagnostics</CardTitle>
        <CardDescription>Client performance and connection data from the latest sample</CardDescription>
        <CardAction>
          <InputGroup className="w-48 sm:w-64">
            <InputGroupAddon><SearchIcon /></InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Steam ID or IP"
              aria-label="Filter player diagnostics"
            />
          </InputGroup>
        </CardAction>
      </CardHeader>
      <CardContent className="max-h-[36rem] overflow-auto p-0">
        {!players.length ? (
          <p className="p-4 text-sm text-muted-foreground">No player telemetry reported.</p>
        ) : !filtered.length ? (
          <p className="p-4 text-sm text-muted-foreground">No players match this filter.</p>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>Steam ID</TableHead>
                <TableHead>IP</TableHead>
                <TableHead className="text-end">FPS</TableHead>
                <TableHead className="text-end">Memory</TableHead>
                <TableHead className="text-end">Ping</TableHead>
                <TableHead className="text-end">Packet loss</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((player, index) => (
                <TableRow key={`${player.steam_id ?? "redacted"}-${index}`}>
                  <TableCell className="font-mono text-xs">{player.steam_id ?? "Redacted"}</TableCell>
                  <TableCell className="font-mono text-xs">{player.ip ?? "—"}</TableCell>
                  <TableCell className="text-end font-mono text-xs tabular-nums">{display(player.client_fps, 0)}</TableCell>
                  <TableCell className="text-end font-mono text-xs tabular-nums">{player.client_memory_mb == null ? "—" : `${display(player.client_memory_mb)} MB`}</TableCell>
                  <TableCell className="text-end font-mono text-xs tabular-nums">{player.ping_ms == null ? "—" : `${display(player.ping_ms)} ms`}</TableCell>
                  <TableCell className="text-end font-mono text-xs tabular-nums">{display(player.packet_loss)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function PerformanceDashboard({
  servers,
  reporting,
  selectedServerId,
  minutes,
  detail,
}: {
  servers: PerfServer[];
  reporting: PerfServerRow[];
  selectedServerId: string;
  minutes: number;
  detail: PerfDetail | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isRefreshing, startRefresh] = React.useTransition();

  React.useEffect(() => {
    const refreshTimer = window.setInterval(() => startRefresh(() => router.refresh()), 30_000);
    return () => window.clearInterval(refreshTimer);
  }, [router]);

  const navigate = React.useCallback((key: "server" | "minutes", value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set(key, value);
    router.push(`${pathname}?${next.toString()}`);
  }, [pathname, router, searchParams]);

  const latest = detail?.latest;
  const serverMap = React.useMemo(() => new Map(servers.map((server) => [server.id, server.name])), [servers]);
  const serverName = serverMap.get(selectedServerId) ?? "Unknown server";
  const hookRates = React.useMemo(() => hookRateData(detail?.series ?? []), [detail?.series]);

  if (!latest || !detail) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">Performance</h1>
        <Card><CardContent className="py-8 text-sm text-muted-foreground">The selected server has no recent performance data.</CardContent></Card>
      </div>
    );
  }

  const status = freshness(latest.at);
  const playerFps = latest.player_metrics.map((player) => player.client_fps);
  const playerPing = latest.player_metrics.map((player) => player.ping_ms);
  const playerMemory = latest.player_metrics.map((player) => player.client_memory_mb);
  const playerLoss = latest.player_metrics.map((player) => player.packet_loss);
  const lowestFps = detail.series.length ? Math.min(...detail.series.map((sample) => sample.fps)) : null;

  const fpsData = rows(detail.series, {
    fps: (sample) => sample.fps,
    average: (sample) => sample.fps_avg,
  });
  const frameData = rows(detail.series, {
    average: (sample) => sample.frame_ms_avg ?? sample.frame_ms,
    maximum: (sample) => sample.frame_ms_max,
  });
  const playerData = rows(detail.series, {
    connected: (sample) => sample.players,
    joining: (sample) => sample.players_joining,
    queued: (sample) => sample.players_queued,
  });
  const memoryData = rows(detail.series, {
    process: (sample) => sample.memory_mb,
    managed: (sample) => sample.managed_memory_mb,
  });
  const entityData = rows(detail.series, { entities: (sample) => sample.entities });
  const taskData = rows(detail.series, {
    load_balancer: (sample) => sample.task_load_balancer,
    invoke_handler: (sample) => sample.task_invoke_handler,
    skins: (sample) => sample.task_workshop_skins_queue,
  });
  const trafficData = rows(detail.series, {
    received: (sample) => sample.network_bytes_received == null ? null : sample.network_bytes_received / 1024 / 1024 * 8,
    sent: (sample) => sample.network_bytes_sent == null ? null : sample.network_bytes_sent / 1024 / 1024 * 8,
  });
  const packetLossData = rows(detail.series, { loss: (sample) => sample.network_packet_loss });
  const memoryActivityData = rows(detail.series, {
    allocations: (sample) => sample.memory_allocations,
    collections: (sample) => sample.memory_collections,
    triggered: (sample) => sample.gc_triggered,
  });
  const gcData = rows(detail.series, {
    gen0: (sample) => sample.gc_gen0,
    gen1: (sample) => sample.gc_gen1,
    gen2: (sample) => sample.gc_gen2,
  });

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">Performance</h1>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Server health, runtime costs, network activity, and player diagnostics from CupboardPerf.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><ServerIcon className="size-3.5" />{serverName}</span>
            <span className="inline-flex items-center gap-1.5">
              <Clock3Icon className="size-3.5" />
              <span suppressHydrationWarning>Last sample {relativeSampleTime(latest.at)}</span>
            </span>
            <span>{detail.series.length.toLocaleString()} samples</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={selectedServerId} onValueChange={(value) => navigate("server", value)}>
            <SelectTrigger className="w-52" aria-label="Server">
              <ServerIcon />
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {reporting.map((row) => (
                <SelectItem key={row.server_id} value={row.server_id}>
                  {serverMap.get(row.server_id) ?? "Unknown server"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ButtonGroup aria-label="Chart range">
            {RANGE_OPTIONS.map((range) => (
              <Button
                key={range.value}
                variant={range.value === minutes ? "secondary" : "outline"}
                size="sm"
                onClick={() => navigate("minutes", String(range.value))}
                aria-pressed={range.value === minutes}
              >
                {range.label}
              </Button>
            ))}
          </ButtonGroup>
          <Button
            variant="outline"
            size="sm"
            onClick={() => startRefresh(() => router.refresh())}
            disabled={isRefreshing}
          >
            <RefreshCwIcon className={isRefreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </div>
      </header>

      <Recommendations recommendations={detail.recommendations} />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8" aria-label="Current server metrics">
        <StatTile icon={<GaugeIcon />} label="Server FPS" value={display(latest.fps)} detail={`Average ${display(latest.fps_avg)} · low ${display(lowestFps)}`} />
        <StatTile icon={<TimerIcon />} label="Frame time" value={`${display(latest.frame_ms_avg ?? latest.frame_ms, 2)} ms`} detail={`Maximum ${display(latest.frame_ms_max, 2)} ms`} />
        <StatTile icon={<UsersIcon />} label="Players" value={latest.players.toLocaleString()} detail={`${display(latest.players_joining)} joining, ${display(latest.players_queued)} queued`} />
        <StatTile icon={<BoxesIcon />} label="Entities" value={latest.entities.toLocaleString()} />
        <StatTile icon={<CpuIcon />} label="Process memory" value={formatBytes(latest.memory_mb * 1024 * 1024)} />
        <StatTile icon={<ActivityIcon />} label="Managed heap" value={latest.managed_memory_mb == null ? "—" : `${display(latest.managed_memory_mb)} MB`} />
        <StatTile icon={<ArrowDownToLineIcon />} label="Network received" value={formatBytes(latest.network_bytes_received)} detail="Latest sample" />
        <StatTile icon={<ArrowUpFromLineIcon />} label="Network sent" value={formatBytes(latest.network_bytes_sent)} detail="Latest sample" />
      </section>

      <Tabs defaultValue="overview" className="min-w-0 gap-6">
        <TabsList variant="line" className="h-auto! max-w-full flex-wrap justify-start">
          <TabsTrigger value="overview"><ActivityIcon />Overview</TabsTrigger>
          <TabsTrigger value="runtime"><CpuIcon />Runtime</TabsTrigger>
          <TabsTrigger value="network"><NetworkIcon />Network</TabsTrigger>
          <TabsTrigger value="players"><UsersIcon />Players</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-6">
          <SectionHeading title="Server overview" description={`Core server metrics across the last ${RANGE_OPTIONS.find((range) => range.value === minutes)?.label ?? `${minutes}m`}.`} />
          <section className="grid gap-4 lg:grid-cols-2">
            <MetricChart
              title="Frame rate"
              description="Instant and rolling average FPS"
              data={fpsData}
              series={[
                { key: "fps", label: "Instant", color: CHART_COLORS[0] },
                { key: "average", label: "Average", color: CHART_COLORS[1], dashed: true },
              ]}
              valueFormatter={(value) => `${value.toFixed(0)} FPS`}
            />
            <MetricChart
              title="Frame time"
              description="Average and worst frame duration"
              data={frameData}
              series={[
                { key: "average", label: "Average", color: CHART_COLORS[0] },
                { key: "maximum", label: "Maximum", color: CHART_COLORS[1], dashed: true },
              ]}
              valueFormatter={(value) => `${value.toFixed(2)} ms`}
            />
            <MetricChart
              title="Player count"
              description="Connected, joining, and queued players"
              data={playerData}
              series={[
                { key: "connected", label: "Connected", color: CHART_COLORS[0] },
                { key: "joining", label: "Joining", color: CHART_COLORS[1] },
                { key: "queued", label: "Queued", color: CHART_COLORS[2], dashed: true },
              ]}
              valueFormatter={(value) => Math.round(value).toString()}
            />
            <MetricChart
              title="Memory"
              description="Process working set and managed heap"
              data={memoryData}
              series={[
                { key: "process", label: "Process", color: CHART_COLORS[0] },
                { key: "managed", label: "Managed", color: CHART_COLORS[1], dashed: true },
              ]}
              valueFormatter={(value) => `${value.toFixed(0)} MB`}
            />
            <MetricChart
              title="Entities"
              description="Total networked entity count"
              data={entityData}
              series={[{ key: "entities", label: "Entities", color: CHART_COLORS[0] }]}
              valueFormatter={(value) => Math.round(value).toLocaleString()}
            />
            <MetricChart
              title="Entity change rate"
              description="Net entity change per second"
              data={entityRateRows(detail.series)}
              series={[{ key: "rate", label: "Entities / sec", color: CHART_COLORS[0] }]}
              valueFormatter={(value) => `${value.toFixed(1)}/s`}
            />
          </section>
        </TabsContent>

        <TabsContent value="runtime" className="flex flex-col gap-6">
          <SectionHeading title="Runtime costs" description="Memory pressure, task queues, plugin hooks, and named server timing breakdowns." />
          <section className="grid gap-4 lg:grid-cols-2">
            <MetricChart
              title="Memory activity"
              description="Allocation, collection, and forced-GC counters"
              data={memoryActivityData}
              series={[
                { key: "allocations", label: "Allocations", color: CHART_COLORS[0] },
                { key: "collections", label: "Collections", color: CHART_COLORS[1] },
                { key: "triggered", label: "GC triggered", color: CHART_COLORS[2], dashed: true },
              ]}
            />
            <MetricChart
              title="GC collections"
              description="Cumulative collections by generation"
              data={gcData}
              series={[
                { key: "gen0", label: "Gen 0", color: CHART_COLORS[0] },
                { key: "gen1", label: "Gen 1", color: CHART_COLORS[1] },
                { key: "gen2", label: "Gen 2", color: CHART_COLORS[2] },
              ]}
            />
            <MetricChart
              title="Task queues"
              description="Pending work by server task family"
              data={taskData}
              series={[
                { key: "invoke_handler", label: "Invoke handler", color: CHART_COLORS[0] },
                { key: "load_balancer", label: "Load balancer", color: CHART_COLORS[1] },
                { key: "skins", label: "Skins queue", color: CHART_COLORS[2] },
              ]}
              valueFormatter={(value) => Math.round(value).toString()}
            />
            <MetricChart
              title="Plugin hook rate"
              description="Milliseconds of hook work per second for the top five plugins"
              data={hookRates.data}
              series={hookRates.specs}
              valueFormatter={(value) => `${value.toFixed(2)} ms/s`}
            />
          </section>
          <section className="grid gap-4 lg:grid-cols-2">
            <DiagnosticTable
              title="Memory and GC snapshot"
              description="Latest CupboardPerf sample"
              values={[
                { label: "Process memory", value: formatBytes(latest.memory_mb * 1024 * 1024) },
                { label: "Managed heap", value: latest.managed_memory_mb == null ? "—" : `${display(latest.managed_memory_mb)} MB` },
                { label: "GC collections, gen 0 / 1 / 2", value: `${latest.gc_gen0} / ${latest.gc_gen1} / ${latest.gc_gen2}` },
                { label: "Memory collections", value: display(latest.memory_collections) },
                { label: "Memory allocations", value: display(latest.memory_allocations) },
                { label: "GC triggered", value: display(latest.gc_triggered) },
              ]}
            />
            <PluginTable hooks={latest.hooks} />
          </section>
          <section className="grid gap-4 lg:grid-cols-2">
            <TimingTable title="Invoke execution" rows={latest.timings.invoke_execution} />
            <TimingTable title="Server updates" rows={latest.timings.server_update} />
            <TimingTable title="RPC calls" rows={latest.timings.rpc_calls} />
            <TimingTable title="Object work queue" rows={latest.timings.work_queue} />
            <TimingTable title="Console commands" rows={latest.timings.console_commands} />
            <TimingTable title="Miscellaneous time warnings" rows={latest.timings.timewarnings} />
          </section>
        </TabsContent>

        <TabsContent value="network" className="flex flex-col gap-6">
          <SectionHeading title="Network" description="Traffic, packet loss, connection queues, and the latest message breakdown." />
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile icon={<ArrowDownToLineIcon />} label="Received" value={formatBytes(latest.network_bytes_received)} detail="Latest sample" />
            <StatTile icon={<ArrowUpFromLineIcon />} label="Sent" value={formatBytes(latest.network_bytes_sent)} detail="Latest sample" />
            <StatTile icon={<WifiIcon />} label="Packet loss" value={display(latest.network_packet_loss)} detail="Server counter" />
            <StatTile icon={<UsersIcon />} label="Connection queue" value={`${display(latest.players_joining)} / ${display(latest.players_queued)}`} detail="Joining / queued" />
          </section>
          <section className="grid gap-4 lg:grid-cols-2">
            <MetricChart
              title="Network traffic"
              description="Received and sent traffic per sample"
              data={trafficData}
              series={[
                { key: "received", label: "Received", color: CHART_COLORS[0] },
                { key: "sent", label: "Sent", color: CHART_COLORS[1], dashed: true },
              ]}
              valueFormatter={formatMbps}
            />
            <MetricChart
              title="Packet loss"
              description="Server packet-loss counter"
              data={packetLossData}
              series={[{ key: "loss", label: "Packet loss", color: CHART_COLORS[0] }]}
              valueFormatter={(value) => value.toFixed(0)}
            />
          </section>
          <NetworkUpdateTable updates={latest.network_updates} />
        </TabsContent>

        <TabsContent value="players" className="flex flex-col gap-6">
          <SectionHeading title="Player telemetry" description="Client FPS, memory, latency, packet loss, and FPS percentiles from the latest sample." />
          <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
            <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Player diagnostics are a latest-sample view. Server charts above retain up to two hours of history.
          </div>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8" aria-label="Player metric summary">
            <StatTile icon={<GaugeIcon />} label="Average FPS" value={display(average(playerFps), 0)} detail={`${latest.player_metrics.length} reports`} />
            <StatTile icon={<ActivityIcon />} label="1st percentile" value={display(percentile(playerFps, 1), 0)} detail="Client FPS" />
            <StatTile icon={<ActivityIcon />} label="Median FPS" value={display(percentile(playerFps, 50), 0)} detail="50th percentile" />
            <StatTile icon={<ActivityIcon />} label="99th percentile" value={display(percentile(playerFps, 99), 0)} detail="Client FPS" />
            <StatTile icon={<WifiIcon />} label="Average latency" value={average(playerPing) == null ? "—" : `${display(average(playerPing))} ms`} />
            <StatTile icon={<TimerIcon />} label="Common latency" value={mode(playerPing) == null ? "—" : `${display(mode(playerPing))} ms`} detail="Most frequent" />
            <StatTile icon={<CpuIcon />} label="Average memory" value={average(playerMemory) == null ? "—" : `${display(average(playerMemory))} MB`} />
            <StatTile icon={<WifiIcon />} label="Average packet loss" value={display(average(playerLoss), 1)} />
          </section>
          <PlayerDiagnostics players={latest.player_metrics} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
