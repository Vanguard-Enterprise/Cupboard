import Link from "next/link";
import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";

type ChatMessage = {
  id: string;
  server_id: string;
  player_id: string | null;
  channel: number;
  name: string | null;
  message: string;
  sent_at: string;
};

type Server = { id: string; name: string };

const CHANNEL_LABELS: Record<number, string> = {
  0: "global",
  1: "team",
};

async function fetchServers(): Promise<Server[]> {
  const res = await apiFetch("/fleet/servers");
  if (!res.ok) return [];
  return res.json();
}

async function fetchChat(serverId: string | null): Promise<ChatMessage[]> {
  const params = new URLSearchParams({ limit: "100" });
  if (serverId) params.set("server_id", serverId);
  const res = await apiFetch(`/chat?${params}`);
  if (!res.ok) return [];
  return res.json();
}

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ server?: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.PlayersView)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to chat logs.</p>;
  }
  const { server } = await searchParams;
  const serverId = server ?? null;
  const [servers, messages] = await Promise.all([fetchServers(), fetchChat(serverId)]);
  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? "unknown";

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Chat</h1>
        <p className="mt-1 text-sm text-neutral-400">
          In-game chat across your servers, captured live from the console stream. Reload for
          the latest.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Link
          href="/chat"
          className={`rounded px-2 py-1 ${serverId === null ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900"}`}
        >
          All servers
        </Link>
        {servers.map((s) => (
          <Link
            key={s.id}
            href={`/chat?server=${s.id}`}
            className={`rounded px-2 py-1 ${serverId === s.id ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900"}`}
          >
            {s.name}
          </Link>
        ))}
      </div>

      {messages.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No chat captured yet{serverId ? " for this server" : ""}.
        </p>
      ) : (
        <div className="overflow-hidden rounded border border-neutral-800">
          <table className="w-full text-start text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-3 py-2">Time</th>
                {!serverId && <th className="px-3 py-2">Server</th>}
                <th className="px-3 py-2">Channel</th>
                <th className="px-3 py-2">Player</th>
                <th className="px-3 py-2">Message</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.id} className="border-t border-neutral-800 align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-neutral-400">
                    {new Date(m.sent_at).toLocaleString()}
                  </td>
                  {!serverId && (
                    <td className="px-3 py-2 text-neutral-400">{serverName(m.server_id)}</td>
                  )}
                  <td className="px-3 py-2">
                    <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">
                      {CHANNEL_LABELS[m.channel] ?? `ch ${m.channel}`}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {m.player_id ? (
                      <Link
                        href={`/players/${m.player_id}`}
                        className="text-indigo-400 hover:text-indigo-300"
                      >
                        {m.name ?? "unknown"}
                      </Link>
                    ) : (
                      <span className="text-neutral-500">{m.name ?? "SERVER"}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 break-all">{m.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
