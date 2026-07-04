import Link from "next/link";
import { getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { AutoRefresh } from "../auto-refresh";
import { BmTabs } from "../bm-tabs";
import { RetryOutboxForm } from "../retry-outbox-form";
import {
  CONNECTION_STATUS_STYLES,
  EMPTY_OUTBOX,
  JOB_STATUS_STYLES,
  fetchStatus,
  isConflictReviewable,
  relativeTime,
} from "../shared";

function StatTile({
  label,
  value,
  href,
  accent,
}: {
  label: string;
  value: string;
  href?: string;
  accent?: "red" | "yellow";
}) {
  const valueColor =
    accent === "red" ? "text-red-400" : accent === "yellow" ? "text-yellow-400" : "";
  const inner = (
    <div className="rounded border border-neutral-800 px-4 py-3 hover:border-neutral-700">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueColor}`}>{value}</div>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export default async function BattlemetricsStatusPage() {
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
  const outbox = status?.outbox ?? EMPTY_OUTBOX;
  const unresolved = status?.unresolved_conflicts ?? 0;

  return (
    <div className="flex flex-col gap-8">
      <AutoRefresh active intervalMs={15000} />

      <div>
        <h1 className="text-2xl font-semibold">BattleMetrics status</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Live operator view of the connection, sync freshness, and push queue. Refreshes
          every 15 seconds.
        </p>
      </div>

      <BmTabs active="status" unresolved={unresolved} />

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
        {connection ? (
          <div className="rounded border border-neutral-800 p-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-neutral-400">Org {connection.bm_org_id}</span>
              <span
                className={`rounded px-2 py-0.5 text-xs ${CONNECTION_STATUS_STYLES[connection.status]}`}
              >
                {connection.status}
              </span>
              <span className="text-neutral-500">
                inbound sync {connection.sync_enabled ? "on" : "off"}
              </span>
              <span className="text-neutral-500">
                outbound sync {connection.sync_bans_outbound ? "on" : "off"}
              </span>
            </div>
            {connection.last_error && (
              <p className="mt-2 text-sm text-red-400">{connection.last_error}</p>
            )}
            {connection.sync_error && (
              <p className="mt-2 text-sm text-red-400">{connection.sync_error}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-neutral-500">
            No connection yet.{" "}
            <Link href="/integrations/battlemetrics" className="text-indigo-400 hover:underline">
              Set one up
            </Link>
            .
          </p>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Ban lists" value={String(banLists.length)} />
        <StatTile
          label="Unresolved conflicts"
          value={String(unresolved)}
          href="/integrations/battlemetrics/conflicts"
          accent={unresolved > 0 ? "yellow" : undefined}
        />
        <StatTile
          label="Queue failed"
          value={String(outbox.failed)}
          accent={outbox.failed > 0 ? "red" : undefined}
        />
        <StatTile
          label="Queue abandoned"
          value={String(outbox.abandoned)}
          accent={outbox.abandoned > 0 ? "yellow" : undefined}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-300">Sync freshness</h2>
        <div className="rounded border border-neutral-800 p-4 text-sm">
          <div className="flex flex-wrap gap-6 text-neutral-400">
            <span>Last tail poll: {relativeTime(connection?.last_tail_at ?? null)}</span>
            <span>Last re-scan: {relativeTime(connection?.last_scan_at ?? null)}</span>
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            New BattleMetrics bans arrive within about a minute; edits and deletes reconcile
            within about 15 minutes.
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-neutral-300">Push queue</h2>
          {outbox.failed > 0 && <RetryOutboxForm />}
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Pending" value={String(outbox.pending)} />
          <StatTile label="Awaiting verification" value={String(outbox.needs_verify)} />
          <StatTile
            label="Failed"
            value={String(outbox.failed)}
            accent={outbox.failed > 0 ? "red" : undefined}
          />
          <StatTile
            label="Abandoned"
            value={String(outbox.abandoned)}
            accent={outbox.abandoned > 0 ? "yellow" : undefined}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-300">Latest import</h2>
        {latestJob ? (
          <div className="rounded border border-neutral-800 p-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span
                className={`rounded px-2 py-0.5 text-xs ${JOB_STATUS_STYLES[latestJob.status]}`}
              >
                {latestJob.status}
              </span>
              <span className="text-neutral-400">phase: {latestJob.phase}</span>
              <span className="text-neutral-500">
                started {relativeTime(latestJob.started_at)}
              </span>
              <span className="text-neutral-500">
                finished {relativeTime(latestJob.finished_at)}
              </span>
            </div>
            {latestJob.error && <p className="mt-2 text-sm text-red-400">{latestJob.error}</p>}
          </div>
        ) : (
          <p className="text-sm text-neutral-500">No import has run yet.</p>
        )}
      </section>
    </div>
  );
}
