import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { AutoRefresh } from "./auto-refresh";
import { ConnectForm } from "./connect-form";
import { ImportButton } from "./import-button";
import { ImportControl } from "./import-control";
import { ImportScopeForm } from "./import-scope-form";
import { OutboundSyncForm } from "./outbound-sync-form";
import { SyncToggle } from "./sync-toggle";

type BmConnection = {
  id: string;
  bm_org_id: string;
  status: "connected" | "error" | "disabled";
  last_error: string | null;
  sync_enabled: boolean;
  sync_bans_outbound: boolean;
  settings: unknown;
  last_tail_at: string | null;
  last_scan_at: string | null;
  sync_error: string | null;
  created_at: string;
  updated_at: string;
};

type BmConflict = {
  id: string;
  entity_type: string;
  external_id: string;
  local_id: string | null;
  direction: "inbound" | "outbound";
  local_snapshot: Record<string, unknown> | null;
  remote_snapshot: Record<string, unknown> | null;
  resolution: "local_won" | "remote_won" | "manual_pending" | "manual_resolved";
  created_at: string;
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

type BmOutbox = {
  pending: number;
  needs_verify: number;
  failed: number;
  abandoned: number;
};

type BmStatus = {
  configured: boolean;
  connection: BmConnection | null;
  latest_job: BmImportJob | null;
  ban_lists: BmBanList[];
  conflicts: BmConflict[];
  outbox: BmOutbox;
};

async function fetchStatus(): Promise<BmStatus | "error"> {
  try {
    const res = await apiFetch("/integrations/bm");
    if (!res.ok) return "error";
    return res.json();
  } catch {
    return "error";
  }
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
  servers_imported: "Servers imported",
  servers_skipped_unconfigured: "Servers skipped (unconfigured)",
  servers_skipped_disabled: "Servers skipped (disabled)",
  servers_skipped_incomplete: "Servers skipped (incomplete)",
  players_matched: "Players matched",
  players_skipped_no_steam: "Players skipped (no steam id)",
  players_skipped_disabled: "Players skipped (disabled)",
  notes_imported: "Notes imported",
  notes_skipped_empty: "Notes skipped (empty)",
  notes_skipped_disabled: "Notes skipped (disabled)",
  sync_conflicts: "Sync conflicts",
};

const CONFLICT_RESOLUTION_STYLES: Record<BmConflict["resolution"], string> = {
  local_won: "bg-neutral-800 text-neutral-400",
  remote_won: "bg-neutral-800 text-neutral-400",
  manual_pending: "bg-yellow-900 text-yellow-300",
  manual_resolved: "bg-green-900 text-green-300",
};

// Small dependency-free "3m ago" formatter; "-" for null. Only needs coarse buckets
// since this page polls every few seconds anyway.
function relativeTime(iso: string | null): string {
  if (!iso) return "-";
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function conflictSummary(c: BmConflict): string {
  const reason = c.remote_snapshot?.reason;
  return typeof reason === "string" && reason ? reason : "-";
}

// `settings` is an opaque jsonb blob; only pull out the one key the page needs.
function targetBanList(settings: unknown): string | null {
  if (typeof settings !== "object" || settings === null) return null;
  const value = (settings as Record<string, unknown>).target_ban_list;
  return typeof value === "string" ? value : null;
}

// Import subset gates default to enabled; only an explicit `false` in settings turns
// one off.
function importScopeFlag(settings: unknown, key: string): boolean {
  if (typeof settings !== "object" || settings === null) return true;
  return (settings as Record<string, unknown>)[key] !== false;
}

export default async function BattlemetricsPage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.IntegrationsManage)) {
    return (
      <p className="text-sm text-neutral-400">You don&apos;t have access to integrations.</p>
    );
  }

  const statusResult = await fetchStatus();
  const loadFailed = statusResult === "error";
  const status = loadFailed ? null : statusResult;
  const connection = status?.connection ?? null;
  const latestJob = status?.latest_job ?? null;
  const banLists = status?.ban_lists ?? [];
  const conflicts = status?.conflicts ?? [];
  const writableBanLists = banLists.filter((l) => !l.subscribed || l.perm_create);
  const outbox = status?.outbox ?? { pending: 0, needs_verify: 0, failed: 0, abandoned: 0 };
  const outboxVisible =
    outbox.pending > 0 || outbox.needs_verify > 0 || outbox.failed > 0 || outbox.abandoned > 0;
  const jobActive = latestJob?.status === "queued" || latestJob?.status === "running";
  // A paused job still occupies the live-job slot (Run import stays disabled) but isn't
  // progressing, so it shouldn't force the fast 3s poll on its own.
  const hasLiveJob = jobActive || latestJob?.status === "paused";
  const syncOnly = !jobActive && !loadFailed && !!connection?.sync_enabled;
  const phaseCountEntries = Object.entries(latestJob?.phase_counts ?? {});

  return (
    <div className="flex flex-col gap-8">
      <AutoRefresh
        active={jobActive || loadFailed || !!connection?.sync_enabled}
        intervalMs={syncOnly ? 15000 : 3000}
      />

      <div>
        <h1 className="text-2xl font-semibold">BattleMetrics</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Connect a BattleMetrics organization to import its ban lists into Cupboard.
        </p>
      </div>

      {loadFailed && (
        <p className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          Could not load the integration status right now (service error). This page
          retries automatically.
        </p>
      )}
      {!loadFailed && (!status || !status.configured) && (
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
        <ImportScopeForm
          servers={importScopeFlag(connection?.settings, "import_servers")}
          players={importScopeFlag(connection?.settings, "import_players")}
          notes={importScopeFlag(connection?.settings, "import_notes")}
          disabled={!connection}
        />
        <div className="flex flex-wrap items-start gap-2">
          <ImportButton disabled={!connection || hasLiveJob} />
          <ImportControl status={latestJob?.status ?? null} />
        </div>
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

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-300">Sync</h2>
        <p className="text-xs text-neutral-500">
          New BattleMetrics bans arrive within about a minute; edits and deletes
          reconcile within about 15 minutes.
        </p>
        <SyncToggle enabled={!!connection?.sync_enabled} disabled={!connection} />
        {connection?.sync_enabled && (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap gap-4 text-sm text-neutral-400">
              <span>Last tail poll: {relativeTime(connection.last_tail_at)}</span>
              <span>Last re-scan: {relativeTime(connection.last_scan_at)}</span>
            </div>
            {connection.sync_error && (
              <p className="text-sm text-red-400">{connection.sync_error}</p>
            )}
          </div>
        )}

        <div>
          <h3 className="text-xs font-medium text-neutral-400">Outbound</h3>
          <div className="mt-2">
            <OutboundSyncForm
              enabled={!!connection?.sync_bans_outbound}
              targetBanList={targetBanList(connection?.settings)}
              options={writableBanLists}
              disabled={!connection}
            />
          </div>
        </div>

        {outboxVisible && (
          <p className="text-sm text-neutral-400">
            Push queue: {outbox.pending} pending, {outbox.needs_verify} awaiting verification,{" "}
            <span className={outbox.failed > 0 ? "text-red-400" : undefined}>
              {outbox.failed} failed
            </span>
            ,{" "}
            <span className={outbox.abandoned > 0 ? "text-yellow-400" : undefined}>
              {outbox.abandoned} abandoned
            </span>
          </p>
        )}
      </section>

      {conflicts.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-neutral-300">Sync conflicts</h2>
          <div className="overflow-hidden rounded border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Ban</th>
                  <th className="px-3 py-2">Direction</th>
                  <th className="px-3 py-2">Resolution</th>
                  <th className="px-3 py-2">Summary</th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c) => (
                  <tr key={c.id} className="border-t border-neutral-800">
                    <td className="px-3 py-2 text-neutral-400">
                      {relativeTime(c.created_at)}
                    </td>
                    <td className="px-3 py-2">{c.external_id}</td>
                    <td className="px-3 py-2 text-neutral-400">{c.direction}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${CONFLICT_RESOLUTION_STYLES[c.resolution]}`}
                      >
                        {c.resolution}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-neutral-400">{conflictSummary(c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
