import { getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { AutoRefresh } from "./auto-refresh";
import { BmTabs } from "./bm-tabs";
import { ConnectForm } from "./connect-form";
import { ImportButton } from "./import-button";
import { ImportControl } from "./import-control";
import { ImportScopeForm } from "./import-scope-form";
import { OutboundSyncForm } from "./outbound-sync-form";
import { SyncToggle } from "./sync-toggle";
import {
  CONNECTION_STATUS_STYLES,
  EMPTY_OUTBOX,
  JOB_STATUS_STYLES,
  PHASE_COUNT_LABELS,
  fetchStatus,
  importScopeFlag,
  isConflictReviewable,
  relativeTime,
  targetBanList,
} from "./shared";

type StepState = "complete" | "current" | "locked" | "upcoming";

function stepState(
  index: number,
  complete: boolean,
  locked: boolean,
  currentIndex: number,
): StepState {
  if (complete) return "complete";
  if (locked) return "locked";
  return index === currentIndex ? "current" : "upcoming";
}

function Step({
  n,
  title,
  state,
  lockedNote,
  children,
}: {
  n: number;
  title: string;
  state: StepState;
  lockedNote?: string;
  children: React.ReactNode;
}) {
  const complete = state === "complete";
  const current = state === "current";
  const locked = state === "locked";
  return (
    <section
      className={`rounded border p-5 ${current ? "border-indigo-700" : "border-neutral-800"} ${locked ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
            complete
              ? "bg-green-900 text-green-300"
              : current
                ? "bg-indigo-600 text-white"
                : "bg-neutral-800 text-neutral-400"
          }`}
        >
          {complete ? "✓" : n}
        </span>
        <h2 className="text-base font-medium text-neutral-100">{title}</h2>
        <span className="ms-auto text-xs">
          {complete && (
            <span className="rounded bg-green-900 px-2 py-0.5 text-green-300">Complete</span>
          )}
          {current && (
            <span className="rounded bg-indigo-950 px-2 py-0.5 text-indigo-300">Current step</span>
          )}
          {locked && (
            <span className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-400">Locked</span>
          )}
        </span>
      </div>
      {locked ? (
        lockedNote && <p className="mt-3 text-sm text-neutral-500">{lockedNote}</p>
      ) : (
        <div className="mt-4">{children}</div>
      )}
    </section>
  );
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
  const outbox = status?.outbox ?? EMPTY_OUTBOX;
  const outboxVisible =
    outbox.pending > 0 || outbox.needs_verify > 0 || outbox.failed > 0 || outbox.abandoned > 0;
  const unresolved = status?.unresolved_conflicts ?? 0;
  const jobActive = latestJob?.status === "queued" || latestJob?.status === "running";
  // A paused job still occupies the live-job slot (Run import stays disabled) but isn't
  // progressing, so it shouldn't force the fast 3s poll on its own.
  const hasLiveJob = jobActive || latestJob?.status === "paused";
  const syncOnly = !jobActive && !loadFailed && !!connection?.sync_enabled;
  const phaseCountEntries = Object.entries(latestJob?.phase_counts ?? {});

  const connected = !!connection;
  const importDone = latestJob?.status === "completed";
  // Step 4 opens once ANY import has ever completed (the latest one alone misleads
  // after a failed re-run), or if sync is already configured either direction: the
  // toggles must never become unreachable for an operator who had them.
  const syncUnlocked =
    (status?.has_completed_import ?? false) ||
    !!connection?.sync_enabled ||
    !!connection?.sync_bans_outbound;
  const completes = [connected, banLists.length > 0, importDone, !!connection?.sync_enabled];
  // Current step = the first incomplete one. `-1` once every step is complete.
  const currentIndex = completes.findIndex((c) => !c);

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

      <BmTabs active="setup" unresolved={unresolved} />

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

      <Step n={1} title="Connect" state={stepState(0, connected, false, currentIndex)}>
        {connection ? (
          <div className="flex flex-col gap-3">
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
            <details>
              <summary className="cursor-pointer text-xs text-neutral-500">
                Edit connection
              </summary>
              <div className="mt-3">
                <ConnectForm />
              </div>
            </details>
          </div>
        ) : (
          <ConnectForm />
        )}
      </Step>

      <Step
        n={2}
        title="Scope and discovery"
        state={stepState(1, banLists.length > 0, !connected, currentIndex)}
        lockedNote="Connect a BattleMetrics organization first."
      >
        <div className="flex flex-col gap-4">
          <ImportScopeForm
            servers={importScopeFlag(connection?.settings, "import_servers")}
            players={importScopeFlag(connection?.settings, "import_players")}
            notes={importScopeFlag(connection?.settings, "import_notes")}
            disabled={!connection}
          />
          {banLists.length > 0 ? (
            <div className="overflow-hidden rounded border border-neutral-800">
              <table className="w-full text-start text-sm">
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
          ) : (
            <p className="text-sm text-neutral-500">
              No ban lists discovered yet. Run an import to discover the org&apos;s ban lists.
            </p>
          )}
        </div>
      </Step>

      <Step
        n={3}
        title="Import"
        state={stepState(2, importDone, !connected, currentIndex)}
        lockedNote="Connect a BattleMetrics organization first."
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start gap-2">
            <ImportButton disabled={!connection || hasLiveJob} />
            <ImportControl status={latestJob?.status ?? null} />
          </div>
          {latestJob && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm">
                <span
                  className={`rounded px-2 py-0.5 text-xs ${JOB_STATUS_STYLES[latestJob.status]}`}
                >
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
        </div>
      </Step>

      <Step
        n={4}
        title="Sync"
        state={stepState(3, !!connection?.sync_enabled, !syncUnlocked, currentIndex)}
        lockedNote="Run a full import first, then sync keeps Cupboard and BattleMetrics aligned."
      >
        <div className="flex flex-col gap-3">
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
        </div>
      </Step>
    </div>
  );
}
