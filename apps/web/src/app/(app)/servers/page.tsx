import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { deleteServerAction } from "@/lib/actions";
import { ServerForm } from "./server-form";

type Server = {
  id: string;
  name: string;
  game: string;
  rcon_host: string;
  rcon_port: number;
  query_port: number | null;
  enabled: boolean;
  connection_status: "unknown" | "connected" | "degraded" | "down";
  last_seen_at: string | null;
};

async function fetchServers(): Promise<Server[]> {
  const res = await apiFetch("/fleet/servers");
  if (!res.ok) return [];
  return res.json();
}

const STATUS_STYLES: Record<Server["connection_status"], string> = {
  connected: "bg-green-900 text-green-300",
  degraded: "bg-yellow-900 text-yellow-300",
  down: "bg-red-900 text-red-300",
  unknown: "bg-neutral-800 text-neutral-400",
};

export default async function ServersPage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.ServersView)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to servers.</p>;
  }
  const manage = can(session.permissions, Permission.ServersManage);
  const servers = await fetchServers();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Servers</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Game-server connections. Cupboard dials out to RCON to track players and enforce
          bans — no install required.
        </p>
      </div>

      {manage && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-neutral-300">Add a server</h2>
          <ServerForm />
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-neutral-300">Connections</h2>
        {servers.length === 0 ? (
          <p className="text-sm text-neutral-500">No servers yet.</p>
        ) : (
          <div className="overflow-hidden rounded border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">RCON</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Last seen</th>
                  <th className="px-3 py-2">Enabled</th>
                  {manage && <th className="px-3 py-2"></th>}
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.id} className="border-t border-neutral-800">
                    <td className="px-3 py-2">{s.name}</td>
                    <td className="px-3 py-2 text-neutral-400">
                      {s.rcon_host}:{s.rcon_port}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[s.connection_status]}`}
                      >
                        {s.connection_status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-neutral-400">
                      {s.last_seen_at ? new Date(s.last_seen_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2 text-neutral-400">{s.enabled ? "yes" : "no"}</td>
                    {manage && (
                      <td className="px-3 py-2 text-right">
                        <form action={deleteServerAction}>
                          <input type="hidden" name="server_id" value={s.id} />
                          <button className="text-xs text-red-400 hover:text-red-300">
                            Remove
                          </button>
                        </form>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
