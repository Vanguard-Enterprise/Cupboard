import Link from "next/link";
import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";

type Report = {
  id: string;
  server_id: string;
  reporter_player_id: string | null;
  target_player_id: string | null;
  reporter_name: string | null;
  target_name: string | null;
  subject: string | null;
  message: string | null;
  report_type: string | null;
  reported_at: string;
};

type Server = { id: string; name: string };

async function fetchServers(): Promise<Server[]> {
  const res = await apiFetch("/fleet/servers");
  if (!res.ok) return [];
  return res.json();
}

async function fetchReports(serverId: string | null): Promise<Report[]> {
  const params = new URLSearchParams({ limit: "100" });
  if (serverId) params.set("server_id", serverId);
  const res = await apiFetch(`/reports?${params}`);
  if (!res.ok) return [];
  return res.json();
}

function PlayerCell({ id, name }: { id: string | null; name: string | null }) {
  if (id) {
    return (
      <Link href={`/players/${id}`} className="text-indigo-400 hover:text-indigo-300">
        {name ?? "unknown"}
      </Link>
    );
  }
  return <span className="text-neutral-500">{name ?? "—"}</span>;
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ server?: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.PlayersView)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to reports.</p>;
  }
  const { server } = await searchParams;
  const serverId = server ?? null;
  const [servers, reports] = await Promise.all([fetchServers(), fetchReports(serverId)]);
  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? "unknown";

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="mt-1 text-sm text-neutral-400">
          In-game F7 reports, streamed by the Cupboard plugin. Repeated reports against one
          player are a strong review signal.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Link
          href="/reports"
          className={`rounded px-2 py-1 ${serverId === null ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900"}`}
        >
          All servers
        </Link>
        {servers.map((s) => (
          <Link
            key={s.id}
            href={`/reports?server=${s.id}`}
            className={`rounded px-2 py-1 ${serverId === s.id ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900"}`}
          >
            {s.name}
          </Link>
        ))}
      </div>

      {reports.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No reports yet{serverId ? " for this server" : ""}. They appear when a server runs
          the Cupboard plugin.
        </p>
      ) : (
        <div className="overflow-hidden rounded border border-neutral-800">
          <table className="w-full text-start text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-3 py-2">Time</th>
                {!serverId && <th className="px-3 py-2">Server</th>}
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Reporter</th>
                <th className="px-3 py-2">Subject</th>
                <th className="px-3 py-2">Message</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id} className="border-t border-neutral-800 align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-400">
                    {new Date(r.reported_at).toLocaleString()}
                  </td>
                  {!serverId && (
                    <td className="px-3 py-2 text-neutral-400">{serverName(r.server_id)}</td>
                  )}
                  <td className="px-3 py-2">
                    <span className="rounded bg-red-950 px-2 py-0.5 text-xs text-red-300">
                      {r.report_type ?? "report"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <PlayerCell id={r.target_player_id} name={r.target_name} />
                  </td>
                  <td className="px-3 py-2">
                    <PlayerCell id={r.reporter_player_id} name={r.reporter_name} />
                  </td>
                  <td className="px-3 py-2 text-neutral-300">{r.subject ?? "—"}</td>
                  <td className="px-3 py-2 break-all text-neutral-400">{r.message ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
