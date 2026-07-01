import Link from "next/link";
import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { dismissEvasionAction, actionEvasionAction } from "@/lib/actions";

type Alert = {
  id: string;
  status: "open" | "dismissed" | "actioned";
  via_kind: string | null;
  detected_at: string;
  suspect_player: string;
  suspect_display_id: number;
  ban_id: string;
  ban_subject: string | null;
  ban_reason: string | null;
};

async function fetchAlerts(): Promise<Alert[]> {
  const res = await apiFetch("/evasion");
  if (!res.ok) return [];
  return res.json();
}

const STATUS_STYLES: Record<Alert["status"], string> = {
  open: "bg-yellow-900 text-yellow-300",
  actioned: "bg-red-900 text-red-300",
  dismissed: "bg-neutral-800 text-neutral-400",
};

export default async function EvasionPage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.BansView)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to evasion alerts.</p>;
  }
  const canAct = can(session.permissions, Permission.BansCreate);
  const alerts = await fetchAlerts();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Evasion alerts</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Raised when a connecting player is linked (shared IP or family-share owner) to a
          player you&apos;ve banned. Alerts flag; they never auto-ban.
        </p>
      </div>

      {alerts.length === 0 ? (
        <p className="text-sm text-neutral-500">No evasion alerts.</p>
      ) : (
        <div className="overflow-hidden rounded border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-3 py-2">Suspect</th>
                <th className="px-3 py-2">Evading ban</th>
                <th className="px-3 py-2">Via</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Detected</th>
                {canAct && <th className="px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id} className="border-t border-neutral-800">
                  <td className="px-3 py-2">
                    <Link
                      href={`/players/${a.suspect_player}`}
                      className="text-indigo-400 hover:text-indigo-300"
                    >
                      Player #{a.suspect_display_id}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-neutral-400">
                    <span className="font-mono">{a.ban_subject ?? "—"}</span>
                    {a.ban_reason ? ` · ${a.ban_reason}` : ""}
                  </td>
                  <td className="px-3 py-2 text-neutral-400">{a.via_kind ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[a.status]}`}>
                      {a.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-neutral-400">
                    {new Date(a.detected_at).toLocaleString()}
                  </td>
                  {canAct && (
                    <td className="px-3 py-2 text-right">
                      {a.status === "open" && (
                        <div className="flex justify-end gap-3">
                          <form action={actionEvasionAction}>
                            <input type="hidden" name="alert_id" value={a.id} />
                            <button className="text-xs text-red-400 hover:text-red-300">
                              Mark actioned
                            </button>
                          </form>
                          <form action={dismissEvasionAction}>
                            <input type="hidden" name="alert_id" value={a.id} />
                            <button className="text-xs text-neutral-400 hover:text-neutral-200">
                              Dismiss
                            </button>
                          </form>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
