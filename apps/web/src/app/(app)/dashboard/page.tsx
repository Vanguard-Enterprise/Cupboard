import type { ReactNode } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpRightIcon,
  BellIcon,
  CreditCardIcon,
  FlagIcon,
  GaugeIcon,
  InboxIcon,
  RefreshCwIcon,
  ServerIcon,
  TicketIcon,
  UsersIcon,
} from "lucide-react";
import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageSearch, type PageSearchItem } from "@/components/page-search";

type ServerSnapshot = {
  id: string;
  name: string;
  connection_status: "unknown" | "connected" | "degraded" | "down";
  info_players?: number | null;
  info_max_players?: number | null;
  info_map?: string | null;
  last_seen_at?: string | null;
};
type PlayerSnapshot = { online: boolean };
type ReportSnapshot = {
  id: string;
  subject?: string | null;
  target_name?: string | null;
  report_type?: string | null;
  reported_at?: string | null;
};
type TicketSnapshot = {
  id: string;
  status: string;
  subject: string;
  type?: string;
  updated_at?: string;
  last_message_at?: string | null;
};

async function readJson<T>(path: string): Promise<T | null> {
  const response = await apiFetch(path);
  if (!response.ok) return null;
  return response.json() as Promise<T>;
}

async function loadSnapshot(permissions: string[]) {
  const [servers, players, reports, ticketBody] = await Promise.all([
    can(permissions, Permission.ServersView)
      ? readJson<ServerSnapshot[]>("/fleet/servers")
      : Promise.resolve(null),
    can(permissions, Permission.PlayersView)
      ? readJson<PlayerSnapshot[]>("/players")
      : Promise.resolve(null),
    can(permissions, Permission.PlayersView)
      ? readJson<ReportSnapshot[]>("/reports?limit=100")
      : Promise.resolve(null),
    can(permissions, Permission.SupportRespond)
      ? readJson<{ tickets?: TicketSnapshot[] }>("/tickets")
      : Promise.resolve(null),
  ]);

  return {
    servers,
    players,
    reports,
    tickets: ticketBody?.tickets ?? null,
  };
}

function SignalBar({ segments }: { segments: { value: number; className: string }[] }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total === 0) {
    return (
      <div className="flex h-1.5 gap-1 overflow-hidden rounded-full" aria-hidden="true">
        {[0, 1, 2].map((segment) => <span key={segment} className="h-full flex-1 rounded-full bg-muted-foreground/20" />)}
      </div>
    );
  }
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      {segments.map((segment, index) => (
        <span
          key={`${segment.className}-${index}`}
          className={segment.className}
          style={{ width: `${total ? (segment.value / total) * 100 : 0}%` }}
        />
      ))}
    </div>
  );
}

function TinyBars({ values, className = "bg-muted-foreground/70" }: { values: number[]; className?: string }) {
  const max = Math.max(...values, 1);
  if (values.length === 0) {
    return (
      <div className="flex h-7 items-end gap-1" aria-hidden="true">
        {[28, 46, 34, 58, 42, 52, 38].map((height, index) => <span key={index} className="min-w-1 flex-1 rounded-t-sm bg-muted-foreground/20" style={{ height: `${height}%` }} />)}
      </div>
    );
  }
  return (
    <div className="flex h-7 items-end gap-1" aria-hidden="true">
      {values.slice(-8).map((value, index) => (
        <span key={`${value}-${index}`} className={`min-w-1 flex-1 rounded-t-sm ${className}`} style={{ height: `${Math.max(12, (value / max) * 100)}%` }} />
      ))}
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  visual,
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  visual: ReactNode;
}) {
  return (
    <Card className="border border-border bg-card py-0 shadow-none ring-0">
      <CardContent className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
          <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-foreground">
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
        </div>
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
          </div>
          <div className="w-20 shrink-0">{visual}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function PlayerLoadChart({ servers }: { servers: ServerSnapshot[] | null }) {
  const values = servers?.map((server) => server.info_players ?? 0).slice(0, 8) ?? [];
  const hasTelemetry = values.some((value) => value > 0);
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 36 - (value / max) * 28;
    return `${x},${y}`;
  }).join(" ");

  return (
    <div className="relative h-60 overflow-hidden rounded-lg border border-border bg-surface-subtle p-3 data-grid">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Current player load</span>
        <span className="tabular-nums">{hasTelemetry ? `${values.reduce((sum, value) => sum + value, 0).toLocaleString()} online` : "Awaiting telemetry"}</span>
      </div>
      <svg className="absolute inset-x-3 top-12 bottom-6 h-auto w-[calc(100%-1.5rem)] overflow-visible" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Current player load by server">
        {[8, 18, 28, 36].map((y) => <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="var(--border)" strokeWidth="0.7" vectorEffect="non-scaling-stroke" />)}
        {!hasTelemetry && <polyline points="0,34 16,31 31,33 48,29 65,32 82,28 100,31" fill="none" stroke="var(--muted-foreground)" strokeOpacity="0.28" strokeDasharray="1 3" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />}
        {hasTelemetry && <polyline points={points} fill="none" stroke="var(--foreground)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
        {hasTelemetry && values.map((value, index) => {
          const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
          const y = 36 - (value / max) * 28;
          return <circle key={`${value}-${index}`} cx={x} cy={y} r="1.7" fill="var(--foreground)" />;
        })}
      </svg>
      {!hasTelemetry && <div className="absolute inset-0 flex items-center justify-center"><span className="rounded-md border border-border bg-background/80 px-3 py-1.5 text-xs text-muted-foreground">No player telemetry yet</span></div>}
      <div className="absolute inset-x-3 bottom-2 flex justify-between text-[10px] text-muted-foreground/70">
        <span>fleet</span><span>server 1</span><span>server {values.length}</span>
      </div>
    </div>
  );
}

function FleetAvailability({ servers }: { servers: ServerSnapshot[] | null }) {
  if (!servers || servers.length === 0) {
    return (
      <div className="relative">
        <div className="grid grid-cols-2 gap-2 opacity-45 blur-[2px] sm:grid-cols-3" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((index) => <div key={index} className="telemetry-skeleton h-12 rounded-lg border border-border bg-surface-subtle p-2" style={{ animationDelay: `${index * 180}ms` }}><div className="h-2 w-3/4 rounded bg-muted-foreground/15" /><div className="mt-2 h-1.5 w-1/2 rounded bg-muted-foreground/10" /></div>)}
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="rounded-md border border-border bg-background/90 px-3 py-1.5 text-center text-xs text-muted-foreground shadow-sm backdrop-blur-sm">Waiting for fleet telemetry</p>
        </div>
      </div>
    );
  }

  const statusClasses: Record<ServerSnapshot["connection_status"], string> = {
    connected: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
    degraded: "border-amber-300/25 bg-amber-300/10 text-amber-200",
    down: "border-red-400/25 bg-red-400/10 text-red-300",
    unknown: "border-border bg-muted/30 text-muted-foreground",
  };

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {servers.slice(0, 6).map((server) => (
        <div key={server.id} className={`min-w-0 rounded-lg border px-2.5 py-2 ${statusClasses[server.connection_status]}`} title={`${server.name}: ${server.connection_status}`}>
          <div className="flex items-center gap-1.5">
            <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
            <span className="truncate text-[11px] font-medium">{server.name}</span>
          </div>
          <div className="mt-1 truncate text-[10px] opacity-75">{server.connection_status}</div>
        </div>
      ))}
    </div>
  );
}

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) return null;

  const snapshot = await loadSnapshot(session.permissions);
  const connectedServers = snapshot.servers?.filter((server) => server.connection_status === "connected").length ?? 0;
  const degradedServers = snapshot.servers?.filter((server) => server.connection_status === "degraded").length ?? 0;
  const downServers = snapshot.servers?.filter((server) => server.connection_status === "down").length ?? 0;
  const onlinePlayers = snapshot.players?.filter((player) => player.online).length ?? 0;
  const openTickets = snapshot.tickets?.filter((ticket) => !["closed", "resolved"].includes(ticket.status)).length ?? 0;
  const pendingTickets = snapshot.tickets?.filter((ticket) => ticket.status === "pending").length ?? 0;
  const quickActions: PageSearchItem[] = [
    ...(can(session.permissions, Permission.ServersManage) ? [{ title: "Add server", url: "/servers", icon: <ServerIcon /> }] : []),
    ...(can(session.permissions, Permission.ServersView) ? [{ title: "Performance", url: "/perf", icon: <GaugeIcon /> }] : []),
    ...(can(session.permissions, Permission.SupportRespond) ? [{ title: "Support", url: "/tickets", icon: <TicketIcon /> }] : []),
    ...(can(session.permissions, Permission.BillingManage) ? [{ title: "Billing", url: "/billing", icon: <CreditCardIcon /> }] : []),
  ];
  const playerValues = snapshot.servers?.map((server) => server.info_players ?? 0) ?? [];
  const reportCount = snapshot.reports?.length ?? 0;
  const reportTypeCounts = snapshot.reports?.reduce<Record<string, number>>((counts, report) => {
    const type = report.report_type ?? "report";
    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {}) ?? {};
  const ticketCounts = snapshot.tickets?.reduce<Record<string, number>>((counts, ticket) => {
    counts[ticket.status] = (counts[ticket.status] ?? 0) + 1;
    return counts;
  }, {}) ?? {};
  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Welcome back, {session.user.display_name}</h1>
        </div>
        <div className="flex items-center gap-2">
          {can(session.permissions, Permission.SupportRespond) && (
            <Button asChild variant="ghost" size="icon-sm" className="relative" aria-label={`Open tickets${openTickets ? ` (${openTickets})` : ""}`}>
              <Link href="/tickets">
                <BellIcon aria-hidden="true" />
                {openTickets > 0 && <span className="absolute -end-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-foreground text-[9px] font-semibold text-background">{openTickets > 9 ? "9+" : openTickets}</span>}
              </Link>
            </Button>
          )}
          <Button asChild variant="ghost" size="icon-sm" aria-label="Refresh dashboard">
            <Link href="/dashboard"><RefreshCwIcon aria-hidden="true" /></Link>
          </Button>
          <PageSearch items={quickActions} enableShortcut={false} trigger="button" label="Quick actions" />
        </div>
      </header>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="Operations summary">
        <MetricCard label="Servers" value={snapshot.servers ? String(snapshot.servers.length) : "—"} detail={snapshot.servers ? `${connectedServers} connected` : "No server access"} icon={ServerIcon} visual={<SignalBar segments={[{ value: connectedServers, className: "bg-emerald-400" }, { value: degradedServers, className: "bg-amber-300" }, { value: downServers, className: "bg-red-400" }]} />} />
        <MetricCard label="Online players" value={snapshot.players ? onlinePlayers.toLocaleString() : "—"} detail={snapshot.players ? "Current server load" : "No player access"} icon={UsersIcon} visual={<TinyBars values={playerValues} />} />
        <MetricCard label="Reports" value={snapshot.reports ? String(reportCount) : "—"} detail={snapshot.reports ? "Latest 100 reports" : "No report access"} icon={FlagIcon} visual={<SignalBar segments={Object.entries(reportTypeCounts).map(([, value]) => ({ value, className: "bg-muted-foreground/60" }))} />} />
        <MetricCard label="Open tickets" value={snapshot.tickets ? String(openTickets) : "—"} detail={snapshot.tickets ? `${pendingTickets} pending` : "No support access"} icon={InboxIcon} visual={<SignalBar segments={Object.entries(ticketCounts).map(([status, value]) => ({ value, className: status === "pending" ? "bg-amber-300" : "bg-muted-foreground/60" }))} />} />
      </section>

      <section className="grid gap-3 xl:grid-cols-8">
        <Card className="border border-border bg-card shadow-none ring-0 xl:col-span-5">
          <CardHeader className="border-b border-border pb-3">
            <div>
              <CardTitle className="text-sm">Player load</CardTitle>
              <CardDescription className="mt-1 text-xs">Live telemetry by connected server.</CardDescription>
            </div>
            <CardAction className="self-center"><Button asChild variant="ghost" size="sm"><Link href="/perf">Performance<ArrowUpRightIcon aria-hidden="true" /></Link></Button></CardAction>
          </CardHeader>
          <CardContent className="p-4">
            <PlayerLoadChart servers={snapshot.servers} />
          </CardContent>
        </Card>

        <Card className="border border-border bg-card shadow-none ring-0 xl:col-span-3">
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="text-sm">Support pulse</CardTitle>
            <CardDescription className="mt-1 text-xs">Queue health and current fleet availability.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 p-4">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border border-border bg-surface-subtle p-2.5"><div className="text-lg font-semibold tabular-nums">{snapshot.tickets ? openTickets : "—"}</div><div className="mt-0.5 text-[10px] text-muted-foreground">Open</div></div>
              <div className="rounded-lg border border-border bg-surface-subtle p-2.5"><div className="text-lg font-semibold tabular-nums">{snapshot.tickets ? pendingTickets : "—"}</div><div className="mt-0.5 text-[10px] text-muted-foreground">Pending</div></div>
              <div className="rounded-lg border border-border bg-surface-subtle p-2.5"><div className="text-lg font-semibold tabular-nums">{snapshot.tickets ? (snapshot.tickets.length - openTickets) : "—"}</div><div className="mt-0.5 text-[10px] text-muted-foreground">Resolved</div></div>
            </div>
            <div className="border-t border-border pt-4">
              <div className="mb-2 flex items-center justify-between gap-3"><span className="text-xs font-medium">Fleet availability</span>{snapshot.servers && snapshot.servers.length > 0 && <span className="text-[11px] text-muted-foreground">{`${connectedServers}/${snapshot.servers.length} online`}</span>}</div>
              <FleetAvailability servers={snapshot.servers} />
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
