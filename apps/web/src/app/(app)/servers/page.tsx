import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { Card, CardContent } from "@/components/ui/card";
import { ServersTable, type PerfRow, type Server } from "./servers-table";

async function fetchJson<T>(path: string): Promise<T | null> {
  const res = await apiFetch(path);
  if (!res.ok) return null;
  return res.json();
}

export default async function ServersPage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.ServersView)) {
    return <p className="text-sm text-muted-foreground">You don&apos;t have access to servers.</p>;
  }

  const [servers, perfRows] = await Promise.all([
    fetchJson<Server[]>("/fleet/servers"),
    fetchJson<PerfRow[]>("/perf/servers"),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Servers</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Keep an eye on your servers, players, and performance.
        </p>
      </header>

      <Card className="gap-0 py-0">
        <CardContent className="p-0">
          <ServersTable
            servers={servers ?? []}
            perfRows={perfRows ?? []}
            manage={can(session.permissions, Permission.ServersManage)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
