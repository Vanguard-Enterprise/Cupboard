import { Fragment } from "react";
import { getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { AutoRefresh } from "../auto-refresh";
import { BmTabs } from "../bm-tabs";
import { ResolveConflictForm } from "../resolve-conflict-form";
import {
  CONFLICT_RESOLUTION_STYLES,
  fetchStatus,
  isConflictReviewable,
  relativeTime,
} from "../shared";

// The ban-shaped fields both snapshots may carry. Nulls (and fields the snapshot omits)
// are skipped; timestamps render in the viewer's locale.
const SNAPSHOT_FIELDS: { key: string; label: string; date?: boolean }[] = [
  { key: "status", label: "Status" },
  { key: "reason", label: "Reason" },
  { key: "expires_at", label: "Expires", date: true },
  { key: "revoked_at", label: "Revoked", date: true },
  { key: "revoke_reason", label: "Revoke reason" },
];

function snapshotRows(
  snapshot: Record<string, unknown> | null,
): { label: string; value: string }[] {
  if (!snapshot) return [];
  const rows: { label: string; value: string }[] = [];
  for (const field of SNAPSHOT_FIELDS) {
    const raw = snapshot[field.key];
    if (raw === null || raw === undefined || raw === "") continue;
    let value = String(raw);
    if (field.date) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) value = parsed.toLocaleString();
    }
    rows.push({ label: field.label, value });
  }
  return rows;
}

function SnapshotCard({
  title,
  snapshot,
}: {
  title: string;
  snapshot: Record<string, unknown> | null;
}) {
  const rows = snapshotRows(snapshot);
  return (
    <div className="rounded border border-neutral-800 p-3">
      <div className="text-xs font-medium text-neutral-400">{title}</div>
      {rows.length > 0 ? (
        <dl className="mt-2 flex flex-col gap-1 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="flex gap-2">
              <dt className="w-28 shrink-0 text-neutral-500">{r.label}</dt>
              <dd className="text-neutral-200">{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-neutral-500">-</p>
      )}
    </div>
  );
}

export default async function BattlemetricsConflictsPage() {
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
  const conflicts = status?.conflicts ?? [];
  const unresolved = status?.unresolved_conflicts ?? 0;

  return (
    <div className="flex flex-col gap-8">
      <AutoRefresh active intervalMs={15000} />

      <div>
        <h1 className="text-2xl font-semibold">Sync conflicts</h1>
        <p className="mt-1 text-sm text-neutral-400">
          When BattleMetrics edits a ban a moderator had revoked here, the revoke
          stands (the edited fields are still recorded on the ban) and the conflict is
          logged. Keep revoked to acknowledge that outcome, or Accept BattleMetrics to
          lift the revoke and let the ban run as BattleMetrics has it.
        </p>
      </div>

      <BmTabs active="conflicts" unresolved={unresolved} />

      {loadFailed && (
        <p className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          Could not load the integration status right now (service error). This page
          retries automatically.
        </p>
      )}

      {loadFailed ? null : conflicts.length === 0 ? (
        <p className="text-sm text-neutral-500">No sync conflicts. Everything is aligned.</p>
      ) : (
        <div className="overflow-hidden rounded border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Ban</th>
                <th className="px-3 py-2">Direction</th>
                <th className="px-3 py-2">Resolution</th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map((c) => {
                const reviewable = isConflictReviewable(c.resolution);
                return (
                  <Fragment key={c.id}>
                    <tr className="border-t border-neutral-800">
                      <td className="px-3 py-2 text-neutral-400">{relativeTime(c.created_at)}</td>
                      <td className="px-3 py-2">{c.external_id}</td>
                      <td className="px-3 py-2 text-neutral-400">{c.direction}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${CONFLICT_RESOLUTION_STYLES[c.resolution]}`}
                        >
                          {reviewable ? "awaiting review" : c.resolution}
                        </span>
                      </td>
                    </tr>
                    {reviewable && (
                      <tr className="border-t border-neutral-900 bg-neutral-950/50">
                        <td colSpan={4} className="px-3 py-3">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <SnapshotCard title="Local at conflict time" snapshot={c.local_snapshot} />
                            <SnapshotCard title="BattleMetrics" snapshot={c.remote_snapshot} />
                          </div>
                          <div className="mt-3">
                            <ResolveConflictForm id={c.id} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
