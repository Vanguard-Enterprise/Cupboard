import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { GaugeIcon } from "lucide-react";
import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import {
  PerformanceDashboard,
  type PerfDetail,
  type PerfServer,
  type PerfServerRow,
} from "./performance-dashboard";

const ALLOWED_RANGES = new Set([15, 30, 60, 120]);

async function fetchJson<T>(path: string): Promise<T | null> {
  const response = await apiFetch(path);
  if (!response.ok) return null;
  return response.json();
}

export default async function PerfPage({
  searchParams,
}: {
  searchParams: Promise<{ server?: string; minutes?: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.ServersView)) {
    return <p className="text-sm text-muted-foreground">You don&apos;t have access to performance.</p>;
  }

  const query = await searchParams;
  const requestedMinutes = Number(query.minutes);
  const minutes = ALLOWED_RANGES.has(requestedMinutes) ? requestedMinutes : 60;
  const [servers, reporting] = await Promise.all([
    fetchJson<PerfServer[]>("/fleet/servers"),
    fetchJson<PerfServerRow[]>("/perf/servers"),
  ]);

  if (!reporting?.length) {
    return (
      <div className="flex flex-col gap-8">
        <header>
          <h1 className="text-2xl font-semibold">Performance</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Server health, runtime costs, network activity, and player diagnostics from CupboardPerf.
          </p>
        </header>
        <Empty className="min-h-72 border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><GaugeIcon /></EmptyMedia>
            <EmptyTitle>No performance samples yet</EmptyTitle>
            <EmptyDescription>
              Install and configure CupboardPerf on a server to start collecting data. CupboardLink does not emit performance samples.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const selected = reporting.some((row) => row.server_id === query.server)
    ? query.server as string
    : reporting[0].server_id;
  const detail = await fetchJson<PerfDetail>(`/perf/servers/${selected}?minutes=${minutes}`);

  return (
    <PerformanceDashboard
      servers={servers ?? []}
      reporting={reporting}
      selectedServerId={selected}
      minutes={minutes}
      detail={detail}
    />
  );
}
