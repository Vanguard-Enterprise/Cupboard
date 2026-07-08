import Link from "next/link";
import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { BanForm } from "../../bans/ban-form";

type Profile = {
  player: {
    id: string;
    display_id: number;
    status: string;
    first_seen_at: string | null;
    last_seen_at: string | null;
  };
  identifiers: { type: string; value: string | null; last_seen_at: string }[];
  names: { name: string | null; last_seen_at: string }[];
  recent_sessions: {
    server_id: string;
    name: string | null;
    ip: string | null;
    connected_at: string;
    disconnected_at: string | null;
  }[];
  links: {
    other_player_id: string;
    other_display_id: number;
    confidence: number;
    signals: string;
  }[];
  playtime: Playtime[];
  reports_against: Report[];
};

type ChatMessage = {
  id: string;
  channel: number;
  message: string;
  sent_at: string;
};

type Playtime = { server_id: string; total_secs: number; sessions: number };
type Report = {
  id: string;
  reporter_player_id: string | null;
  reporter_name: string | null;
  subject: string | null;
  message: string | null;
  report_type: string | null;
  reported_at: string;
};

type Entitlement = {
  steam_id: string | null;
  product_name: string | null;
  kind: "single" | "subscription";
  status: "active" | "expired" | "revoked" | "refunded" | "chargeback";
  granted_at: string | null;
  expires_at: string | null;
  source: "webhook" | "reconcile";
  updated_at: string;
};

function formatPlaytime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Short calendar date, or a muted placeholder for a null/absent timestamp. */
function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "-";
}

/** Colored chip classes for an entitlement status: active is positive (green), expired is
 * neutral, revoked/chargeback are negative (red), refunded is a caution (amber). */
function statusChipClass(status: Entitlement["status"]): string {
  switch (status) {
    case "active":
      return "bg-green-950 text-green-300";
    case "expired":
      return "bg-neutral-800 text-neutral-300";
    case "refunded":
      return "bg-amber-950 text-amber-300";
    case "revoked":
    case "chargeback":
      return "bg-red-950 text-red-300";
    default:
      return "bg-neutral-800 text-neutral-300";
  }
}

export default async function PlayerProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.PlayersView)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to players.</p>;
  }
  const canPii = can(session.permissions, Permission.PlayersViewPii);

  const res = await apiFetch(`/players/${id}`);
  if (res.status === 404) {
    return <p className="text-sm text-neutral-400">Player not found.</p>;
  }
  if (!res.ok) {
    return <p className="text-sm text-red-400">Failed to load player.</p>;
  }
  const profile: Profile = await res.json();
  const chatRes = await apiFetch(`/chat?player_id=${id}&limit=25`);
  const chat: ChatMessage[] = chatRes.ok ? await chatRes.json() : [];
  const steamId = profile.identifiers.find((i) => i.type === "steam")?.value ?? null;
  const canBan = can(session.permissions, Permission.BansCreate);

  // Entitlements are only fetched (and only shown) for operators with store.manage, and only
  // when the player has a Steam identity to key the purchase history on.
  const canStore = can(session.permissions, Permission.StoreManage);
  let entitlements: Entitlement[] = [];
  if (steamId && canStore) {
    const entRes = await apiFetch(`/store/entitlements?steam_id=${encodeURIComponent(steamId)}`);
    entitlements = entRes.ok ? (await entRes.json()).entitlements : [];
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link href="/players" className="text-sm text-indigo-400 hover:text-indigo-300">
          ← Players
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {profile.names[0]?.name ?? `Player #${profile.player.display_id}`}
        </h1>
        <p className="mt-1 text-sm text-neutral-400">
          Cupboard Player #{profile.player.display_id} · {profile.player.status} · first seen{" "}
          {profile.player.first_seen_at
            ? new Date(profile.player.first_seen_at).toLocaleString()
            : "—"}
          {profile.playtime.length > 0 && (
            <>
              {" · "}
              {formatPlaytime(profile.playtime.reduce((a, p) => a + p.total_secs, 0))} played
              {" over "}
              {profile.playtime.reduce((a, p) => a + p.sessions, 0)} session(s)
            </>
          )}
          {profile.reports_against.length > 0 && (
            <span className="ml-2 rounded bg-red-950 px-2 py-0.5 text-xs text-red-300">
              {profile.reports_against.length} report(s)
            </span>
          )}
        </p>
      </div>

      {canBan && steamId && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-neutral-300">Ban this player</h2>
          <BanForm subjectValue={steamId} playerId={profile.player.id} label="Ban player" />
        </section>
      )}

      {steamId && canStore && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-neutral-300">Entitlements</h2>
          {entitlements.length === 0 ? (
            <p className="text-sm text-neutral-500">No purchases</p>
          ) : (
            <div className="overflow-hidden rounded border border-neutral-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-neutral-900 text-neutral-400">
                  <tr>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Kind</th>
                    <th className="px-3 py-2">Granted</th>
                    <th className="px-3 py-2">Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {entitlements.map((e, i) => (
                    <tr key={i} className="border-t border-neutral-800">
                      <td className="px-3 py-2">
                        {e.product_name ?? (
                          <span className="text-neutral-500">Unknown product</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${statusChipClass(e.status)}`}
                        >
                          {e.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-neutral-400">
                        {e.kind === "subscription" ? "Subscription" : "One-time"}
                      </td>
                      <td className="px-3 py-2 text-neutral-400">{formatDate(e.granted_at)}</td>
                      <td className="px-3 py-2 text-neutral-400">{formatDate(e.expires_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-neutral-300">Identifiers</h2>
        <div className="overflow-hidden rounded border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Value</th>
                <th className="px-3 py-2">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {profile.identifiers.map((idr, i) => (
                <tr key={i} className="border-t border-neutral-800">
                  <td className="px-3 py-2 uppercase text-neutral-400">{idr.type}</td>
                  <td className="px-3 py-2 font-mono">{idr.value ?? "—"}</td>
                  <td className="px-3 py-2 text-neutral-400">
                    {new Date(idr.last_seen_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-neutral-300">Recent sessions</h2>
        <div className="overflow-hidden rounded border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">IP</th>
                <th className="px-3 py-2">Connected</th>
                <th className="px-3 py-2">Ended</th>
              </tr>
            </thead>
            <tbody>
              {profile.recent_sessions.map((s, i) => (
                <tr key={i} className="border-t border-neutral-800">
                  <td className="px-3 py-2">{s.name ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-neutral-400">
                    {canPii ? (s.ip ?? "—") : "hidden"}
                  </td>
                  <td className="px-3 py-2 text-neutral-400">
                    {new Date(s.connected_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-neutral-400">
                    {s.disconnected_at ? new Date(s.disconnected_at).toLocaleString() : "online"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {profile.links.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-neutral-300">Linked players (possible alts)</h2>
          <div className="overflow-hidden rounded border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-3 py-2">Player</th>
                  <th className="px-3 py-2">Confidence</th>
                  <th className="px-3 py-2">Shared signals</th>
                </tr>
              </thead>
              <tbody>
                {profile.links.map((l) => (
                  <tr key={l.other_player_id} className="border-t border-neutral-800">
                    <td className="px-3 py-2">
                      <Link
                        href={`/players/${l.other_player_id}`}
                        className="text-indigo-400 hover:text-indigo-300"
                      >
                        Player #{l.other_display_id}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-neutral-400">
                      {Math.round(l.confidence * 100)}%
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-neutral-500">{l.signals}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {profile.names.length > 1 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-neutral-300">Known names</h2>
          <p className="text-sm text-neutral-400">
            {profile.names.map((n) => n.name).filter(Boolean).join(", ")}
          </p>
        </section>
      )}

      {profile.reports_against.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-neutral-300">Reports against this player</h2>
          <div className="overflow-hidden rounded border border-neutral-800">
            <table className="w-full text-left text-sm">
              <tbody>
                {profile.reports_against.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-800 first:border-t-0 align-top">
                    <td className="whitespace-nowrap px-3 py-2 text-neutral-400">
                      {new Date(r.reported_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <span className="rounded bg-red-950 px-2 py-0.5 text-xs text-red-300">
                        {r.report_type ?? "report"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-neutral-300">{r.subject ?? "—"}</td>
                    <td className="px-3 py-2 break-all text-neutral-400">{r.message ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-neutral-500">
                      by {r.reporter_name ?? "unknown"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {chat.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-neutral-300">Recent chat</h2>
          <div className="overflow-hidden rounded border border-neutral-800">
            <table className="w-full text-left text-sm">
              <tbody>
                {chat.map((m) => (
                  <tr key={m.id} className="border-t border-neutral-800 first:border-t-0 align-top">
                    <td className="whitespace-nowrap px-3 py-2 text-neutral-400">
                      {new Date(m.sent_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-neutral-500">
                      {m.channel === 1 ? "team" : "global"}
                    </td>
                    <td className="px-3 py-2 break-all">{m.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
