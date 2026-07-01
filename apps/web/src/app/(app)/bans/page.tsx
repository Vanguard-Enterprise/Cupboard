import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { revokeBanAction } from "@/lib/actions";
import { BanForm } from "./ban-form";

type Ban = {
  id: string;
  subject_type: string;
  subject_value: string | null;
  scope: string;
  reason: string | null;
  issued_at: string;
  expires_at: string | null;
  status: "active" | "expired" | "revoked";
};

async function fetchBans(): Promise<Ban[]> {
  const res = await apiFetch("/bans");
  if (!res.ok) return [];
  return res.json();
}

const STATUS_STYLES: Record<Ban["status"], string> = {
  active: "bg-red-900 text-red-300",
  revoked: "bg-neutral-800 text-neutral-400",
  expired: "bg-neutral-800 text-neutral-500",
};

export default async function BansPage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.BansView)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to bans.</p>;
  }
  const canCreate = can(session.permissions, Permission.BansCreate);
  const canRevoke = can(session.permissions, Permission.BansRevoke);
  const bans = await fetchBans();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Bans</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Identifier-level bans. Enforced over RCON — a banned Steam ID is kicked on sight
          across your servers.
        </p>
      </div>

      {canCreate && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-neutral-300">Ban a Steam ID</h2>
          <BanForm />
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-neutral-300">Ban list</h2>
        {bans.length === 0 ? (
          <p className="text-sm text-neutral-500">No bans yet.</p>
        ) : (
          <div className="overflow-hidden rounded border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-3 py-2">Subject</th>
                  <th className="px-3 py-2">Scope</th>
                  <th className="px-3 py-2">Reason</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Issued</th>
                  {canRevoke && <th className="px-3 py-2"></th>}
                </tr>
              </thead>
              <tbody>
                {bans.map((b) => (
                  <tr key={b.id} className="border-t border-neutral-800">
                    <td className="px-3 py-2 font-mono">
                      <span className="text-neutral-500">{b.subject_type}:</span>{" "}
                      {b.subject_value ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-neutral-400">{b.scope}</td>
                    <td className="px-3 py-2 text-neutral-400">{b.reason ?? "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[b.status]}`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-neutral-400">
                      {new Date(b.issued_at).toLocaleString()}
                    </td>
                    {canRevoke && (
                      <td className="px-3 py-2 text-right">
                        {b.status === "active" && (
                          <form action={revokeBanAction}>
                            <input type="hidden" name="ban_id" value={b.id} />
                            <button className="text-xs text-indigo-400 hover:text-indigo-300">
                              Revoke
                            </button>
                          </form>
                        )}
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
