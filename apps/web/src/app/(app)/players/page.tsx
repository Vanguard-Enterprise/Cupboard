import Link from "next/link";
import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";

type PlayerRow = {
  player_id: string;
  display_id: number;
  name: string | null;
  ip: string | null;
  online: boolean;
  server_id: string;
  connected_at: string;
  last_seen_at: string;
};

async function fetchPlayers(): Promise<PlayerRow[]> {
  const res = await apiFetch("/players");
  if (!res.ok) return [];
  return res.json();
}

export default async function PlayersPage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.PlayersView)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to players.</p>;
  }
  const canPii = can(session.permissions, Permission.PlayersViewPii);
  const players = await fetchPlayers();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Players</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Everyone your servers have seen, most-recently-active first.
          {!canPii && " IPs are hidden — you lack players.view_pii."}
        </p>
      </div>

      {players.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No players observed yet. Add a server and wait for the next poll.
        </p>
      ) : (
        <div className="overflow-hidden rounded border border-neutral-800">
          <table className="w-full text-start text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">IP</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.player_id} className="border-t border-neutral-800">
                  <td className="px-3 py-2 text-neutral-500">{p.display_id}</td>
                  <td className="px-3 py-2">
                    <Link href={`/players/${p.player_id}`} className="text-indigo-400 hover:text-indigo-300">
                      {p.name ?? "—"}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-neutral-400">
                    {canPii ? (p.ip ?? "—") : "hidden"}
                  </td>
                  <td className="px-3 py-2">
                    {p.online ? (
                      <span className="rounded bg-green-900 px-2 py-0.5 text-xs text-green-300">
                        online
                      </span>
                    ) : (
                      <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                        offline
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-neutral-400">
                    {new Date(p.last_seen_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
