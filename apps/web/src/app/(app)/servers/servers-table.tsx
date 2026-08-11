"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowUpDownIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CpuIcon,
  DatabaseIcon,
  GaugeIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { deleteServerAction } from "@/lib/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export type Server = {
  id: string;
  name: string;
  game: string;
  rcon_host: string;
  rcon_port: number;
  query_port: number | null;
  enabled: boolean;
  connection_status: "unknown" | "connected" | "degraded" | "down";
  last_seen_at: string | null;
  info_hostname: string | null;
  info_map: string | null;
  info_players: number | null;
  info_max_players: number | null;
  info_queued: number | null;
  info_updated_at: string | null;
  has_ingest_token: boolean;
  ingest_token_created_at: string | null;
};

export type PerfRow = { server_id: string; latest: { fps: number; memory_mb: number } };

type SortKey = "cpu" | "memory" | "performance" | "players" | "uptime";
type SortDirection = "asc" | "desc";

function formatMemory(memoryMb: number | undefined) {
  if (memoryMb === undefined || !Number.isFinite(memoryMb)) return "N/A";
  return memoryMb >= 1024
    ? `${(memoryMb / 1024).toFixed(1)} GB`
    : `${Math.round(memoryMb).toLocaleString()} MB`;
}

function performanceFor(fps: number | undefined) {
  if (fps === undefined || !Number.isFinite(fps)) {
    return { label: "N/A", className: "border-border text-muted-foreground" };
  }
  if (fps >= 55) return { label: "Excellent", className: "border-emerald-500/30 text-emerald-400" };
  if (fps >= 40) return { label: "Good", className: "border-emerald-500/30 text-emerald-400" };
  if (fps >= 25) return { label: "Watch", className: "border-amber-500/30 text-amber-400" };
  return { label: "Critical", className: "border-red-500/30 text-red-400" };
}

function formatPlayers(server: Server) {
  if (server.info_players === null) return "N/A";
  if (server.info_max_players === null) return server.info_players.toLocaleString();
  return `${server.info_players}/${server.info_max_players}${server.info_queued ? ` · ${server.info_queued} queued` : ""}`;
}

function formatLastSeen(value: string | null) {
  if (!value) return "N/A";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function compareNullable(a: number | string | null, b: number | string | null) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  return Number(a) - Number(b);
}

function SortButton({
  label,
  sortKey,
  currentKey,
  direction,
  onSort,
  icon,
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey | null;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
  icon?: ReactNode;
}) {
  const active = currentKey === sortKey;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="-ms-2 h-7 gap-1 px-2 font-medium text-foreground hover:bg-muted"
      onClick={() => onSort(sortKey)}
    >
      {icon}
      {label}
      {active ? (direction === "asc" ? <ChevronUpIcon /> : <ChevronDownIcon />) : <ArrowUpDownIcon className="text-muted-foreground" />}
    </Button>
  );
}

export function ServersTable({
  servers,
  perfRows,
  manage,
}: {
  servers: Server[];
  perfRows: PerfRow[];
  manage: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const performance = useMemo(() => new Map(perfRows.map((row) => [row.server_id, row.latest])), [perfRows]);

  const visibleServers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const filtered = servers.filter((server) => {
      if (!normalized) return true;
      return [server.name, server.info_hostname, server.rcon_host, server.info_map, server.connection_status]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(normalized));
    });
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => {
      const aPerf = performance.get(a.id);
      const bPerf = performance.get(b.id);
      const values: Record<SortKey, number | string | null> = {
        cpu: null,
        memory: aPerf?.memory_mb ?? null,
        performance: aPerf?.fps ?? null,
        players: a.info_players,
        uptime: a.last_seen_at ? new Date(a.last_seen_at).getTime() : null,
      };
      const otherValues: Record<SortKey, number | string | null> = {
        cpu: null,
        memory: bPerf?.memory_mb ?? null,
        performance: bPerf?.fps ?? null,
        players: b.info_players,
        uptime: b.last_seen_at ? new Date(b.last_seen_at).getTime() : null,
      };
      return compareNullable(values[sortKey], otherValues[sortKey]) * (sortDirection === "asc" ? 1 : -1);
    });
  }, [performance, query, servers, sortDirection, sortKey]);

  const allVisibleSelected = visibleServers.length > 0 && visibleServers.every((server) => selected.has(server.id));
  const someVisibleSelected = visibleServers.some((server) => selected.has(server.id));
  const columnCount = manage ? 8 : 7;

  function toggleSort(nextKey: SortKey) {
    if (sortKey === nextKey) setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
    else {
      setSortKey(nextKey);
      setSortDirection("asc");
    }
  }

  function toggleVisibleSelection(checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      visibleServers.forEach((server) => (checked ? next.add(server.id) : next.delete(server.id)));
      return next;
    });
  }

  function toggleSelection(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <>
      <div className="flex flex-col gap-3 border-b border-border p-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search servers" aria-label="Search servers" className="ps-8" />
        </div>
        {manage && <Button asChild size="sm"><Link href="/servers/new"><PlusIcon data-icon="inline-start" />Add Server</Link></Button>}
      </div>

      <Table>
        <TableHeader className="bg-muted/30">
          <TableRow>
            <TableHead className="w-8 ps-2"><Checkbox checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false} onCheckedChange={toggleVisibleSelection} aria-label="Select all visible servers" /></TableHead>
            <TableHead className="min-w-56 ps-0">Server</TableHead>
            <TableHead><SortButton label="CPU" sortKey="cpu" currentKey={sortKey} direction={sortDirection} onSort={toggleSort} icon={<CpuIcon />} /></TableHead>
            <TableHead><SortButton label="Memory" sortKey="memory" currentKey={sortKey} direction={sortDirection} onSort={toggleSort} icon={<DatabaseIcon />} /></TableHead>
            <TableHead><SortButton label="Performance" sortKey="performance" currentKey={sortKey} direction={sortDirection} onSort={toggleSort} /></TableHead>
            <TableHead><SortButton label="Pop" sortKey="players" currentKey={sortKey} direction={sortDirection} onSort={toggleSort} /></TableHead>
            <TableHead><SortButton label="Uptime" sortKey="uptime" currentKey={sortKey} direction={sortDirection} onSort={toggleSort} /></TableHead>
            {manage && <TableHead className="w-10 pe-6"><span className="sr-only">Quick actions</span></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleServers.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columnCount} className="h-48 whitespace-normal text-center">
                <div className="flex flex-col items-center justify-center gap-2 px-6 py-8">
                  <ServerIcon className="size-8 text-muted-foreground/50" aria-hidden="true" />
                  <p className="font-medium">{servers.length === 0 ? "No servers connected" : "No matching servers"}</p>
                  <p className="max-w-md text-sm text-muted-foreground">{servers.length === 0 ? "Add your first server above to start collecting connection, population, and performance data." : "Try a different name, hostname, map, or status."}</p>
                </div>
              </TableCell>
            </TableRow>
          ) : visibleServers.map((server) => {
            const latest = performance.get(server.id);
            const rating = performanceFor(latest?.fps);
            return (
              <TableRow key={server.id} data-state={selected.has(server.id) ? "selected" : undefined}>
                <TableCell className="ps-2"><Checkbox checked={selected.has(server.id)} onCheckedChange={(checked) => toggleSelection(server.id, checked === true)} aria-label={`Select ${server.name}`} /></TableCell>
                <TableCell className="min-w-56 ps-0"><div className="flex items-center gap-2"><span className={`size-2 shrink-0 rounded-full ${server.connection_status === "connected" ? "bg-emerald-500 animate-pulse" : server.connection_status === "degraded" ? "bg-amber-500" : server.connection_status === "down" ? "bg-red-500" : "bg-muted-foreground"}`} aria-label={`${server.connection_status} status`} title={server.connection_status} /><div><div className="font-medium text-foreground">{server.name}</div><div className="max-w-72 truncate text-xs text-muted-foreground" title={server.info_hostname ?? server.rcon_host}>{server.info_hostname || server.rcon_host}</div></div></div></TableCell>
                <TableCell className="tabular-nums text-muted-foreground" title="CPU is not reported by the current server telemetry contract">N/A</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">{formatMemory(latest?.memory_mb)}</TableCell>
                <TableCell><div className="flex flex-col items-start gap-1"><Badge variant="outline" className={rating.className}>{rating.label}</Badge>{latest?.fps !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{latest.fps.toFixed(0)} FPS</span>}</div></TableCell>
                <TableCell className="tabular-nums text-muted-foreground">{formatPlayers(server)}</TableCell>
                <TableCell className="text-muted-foreground" title="The current API reports last heartbeat, not process uptime"><span>N/A</span>{server.last_seen_at && <div className="text-xs">seen {formatLastSeen(server.last_seen_at)}</div>}</TableCell>
                {manage && <TableCell className="pe-6"><DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-xs" aria-label={`Quick actions for ${server.name}`}><MoreHorizontalIcon /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem asChild><Link href={`/perf?server=${server.id}`}><GaugeIcon />Performance</Link></DropdownMenuItem><DropdownMenuItem asChild><Link href={`/servers/token?server=${server.id}`}><KeyRoundIcon />Ingest token</Link></DropdownMenuItem><DropdownMenuSeparator /><form action={deleteServerAction}><input type="hidden" name="server_id" value={server.id} /><DropdownMenuItem asChild variant="destructive"><button type="submit" className="flex w-full items-center gap-1.5 text-start"><Trash2Icon />Remove</button></DropdownMenuItem></form></DropdownMenuContent></DropdownMenu></TableCell>}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
