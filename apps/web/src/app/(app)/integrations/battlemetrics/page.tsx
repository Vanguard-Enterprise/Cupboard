import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { AutoRefresh } from "./auto-refresh";
import { ConnectForm } from "./connect-form";
import { ImportButton } from "./import-button";

type BmConnection = {
  id: string;
  bm_org_id: string;
  status: "connected" | "error" | "disabled";
  last_error: string | null;
  sync_enabled: boolean;
  sync_bans_outbound: boolean;
  settings: unknown;
  created_at: string;
  updated_at: string;
};

type BmImportJob = {
  id: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  phase: "servers" | "ban_lists" | "bans" | "players" | "notes" | "done";
  phase_counts: Record<string, number>;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type BmBanList = {
  external_id: string;
  name: string | null;
  owner_bm_org: string | null;
  subscribed: boolean;
  perm_create: boolean;
  import_enabled: boolean;
};

type BmStatus = {
  configured: boolean;
  connection: BmConnection | null;
  latest_job: BmImportJob | null;
  ban_lists: BmBanList[];
};

async function fetchStatus(): Promise<BmStatus | null> {
  const res = await apiFetch("/integrations/bm");
  if (!res.ok) return null;
  return res.json();
}

const CONNECTION_STATUS_STYLES: Record<BmConnection["status"], string> = {
  connected: "bg-green-900 text-green-300",
  error: "bg-red-900 text-red-300",
  disabled: "bg-neutral-800 text-neutral-400",
};

const JOB_STATUS_STYLES: Record<BmImportJob["status"], string> = {
  queued: "bg-neutral-800 text-neutral-400",
  running: "bg-blue-900 text-blue-300",
  paused: "bg-yellow-900 text-yellow-300",
  completed: "bg-green-900 text-green-300",
  failed: "bg-red-900 text-red-300",
  cancelled: "bg-neutral-800 text-neutral-400",
};

const PHASE_COUNT_LABELS: Record<string, string> = {
  ban_lists: "Ban lists",
  bans_imported: "Bans imported",
  bans_updated: "Bans updated",
  bans_unchanged: "Bans unchanged",
  bans_skipped_no_identifier: "Bans skipped (no identifier)",
};

export default async function BattlemetricsPage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.IntegrationsManage)) {
    return (
      <p className="text-sm text-neutral-400">You don&apos;t have access to integrations.</p>
    );
  }

  const status = await fetchStatus();
  const connection = status?.connection ?? null;
  const latestJob = status?.latest_job ?? null;
  const banLists = status?.ban_lists ?? [];
  const jobActive = latestJob?.status === "queued" || latestJob?.status === "running";
  const phaseCountEntries = Object.entries(latestJob?.phase_counts ?? {});

  return (
    <div className="flex flex-col gap-8">
      <AutoRefresh active={jobActive} />

      <div>
        <h1 className="text-2xl font-semibold">BattleMetrics</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Connect a BattleMetrics organization to import its ban lists into Cupboard.
        </p>
      </div>

      {(!status || !status.configured) && (
        <p className="rounded border border-yellow-900 bg-yellow-950 px-3 py-2 text-sm text-yellow-300">
          The BattleMetrics integration is not configured on this deployment.
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-300">Connection</h2>
        {connection && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-neutral-400">Org {connection.bm_org_id}</span>
            <span
              className={`rounded px-2 py-0.5 text-xs ${CONNECTION_STATUS_STYLES[connection.status]}`}
            >
              {connection.status}
            </span>
            {connection.last_error && (
              <span className="text-xs text-red-400">{connection.last_error}</span>
            )}
          </div>
        )}
        <ConnectForm />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-300">Import</h2>
        <ImportButton disabled={!connection || jobActive} />
        {latestJob && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm">
              <span className={`rounded px-2 py-0.5 text-xs ${JOB_STATUS_STYLES[latestJob.status]}`}>
                {latestJob.status}
              </span>
              <span className="text-neutral-400">phase: {latestJob.phase}</span>
            </div>
            {phaseCountEntries.length > 0 && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {phaseCountEntries.map(([key, value]) => (
                  <div key={key} className="rounded border border-neutral-800 px-3 py-2">
                    <div className="text-xs text-neutral-500">
                      {PHASE_COUNT_LABELS[key] ?? key}
                    </div>
                    <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
                  </div>
                ))}
              </div>
            )}
            {latestJob.error && <p className="text-sm text-red-400">{latestJob.error}</p>}
          </div>
        )}
      </section>

      {banLists.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-neutral-300">Ban lists</h2>
          <div className="overflow-hidden rounded border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Owner org</th>
                  <th className="px-3 py-2">Subscribed</th>
                  <th className="px-3 py-2">Import enabled</th>
                </tr>
              </thead>
              <tbody>
                {banLists.map((l) => (
                  <tr key={l.external_id} className="border-t border-neutral-800">
                    <td className="px-3 py-2">{l.name ?? l.external_id}</td>
                    <td className="px-3 py-2 text-neutral-400">{l.owner_bm_org ?? "-"}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${
                          l.subscribed
                            ? "bg-green-900 text-green-300"
                            : "bg-neutral-800 text-neutral-400"
                        }`}
                      >
                        {l.subscribed ? "subscribed" : "not subscribed"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-neutral-400">
                      {l.import_enabled ? "yes" : "no"}
                    </td>
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
