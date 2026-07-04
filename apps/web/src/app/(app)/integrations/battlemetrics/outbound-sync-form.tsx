"use client";

import { useActionState } from "react";
import { updateBmOutboundAction } from "@/lib/actions";

type TargetOption = { external_id: string; name: string | null; subscribed: boolean };

// Enables/disables outbound sync and, while enabled, saves target-list changes. Two
// submit buttons carry an explicit `intent` so disabling never silently discards a
// retarget (and retargeting never toggles sync off).
export function OutboundSyncForm({
  enabled,
  targetBanList,
  options,
  disabled,
}: {
  enabled: boolean;
  targetBanList: string | null;
  options: TargetOption[];
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(updateBmOutboundAction, {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Target ban list
          <select
            name="target_ban_list"
            defaultValue={targetBanList ?? ""}
            disabled={disabled}
            className="w-56 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          >
            <option value="">Choose a list</option>
            {options.map((o) => (
              <option key={o.external_id} value={o.external_id}>
                {(o.name ?? o.external_id) + (o.subscribed ? " (shared)" : "")}
              </option>
            ))}
          </select>
        </label>
        {enabled ? (
          <>
            <button
              name="intent"
              value="retarget"
              disabled={disabled || pending}
              className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save target list"}
            </button>
            <button
              name="intent"
              value="disable"
              disabled={disabled || pending}
              className="rounded bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50"
            >
              {pending ? "Saving…" : "Disable outbound sync"}
            </button>
          </>
        ) : (
          <button
            name="intent"
            value="enable"
            disabled={disabled || pending}
            className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Enable outbound sync"}
          </button>
        )}
      </div>
      {!enabled && (
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <input type="checkbox" name="backfill_existing" className="h-4 w-4" />
          Also push existing active Cupboard bans to BattleMetrics now (one-time backfill)
        </label>
      )}
      <p className="text-xs text-neutral-500">
        Cupboard bans/revokes push to the chosen BM ban list; only steam-subject bans sync
        today. Enabling outbound also enables inbound sync.
      </p>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
      {state.ok && !!state.backfilled && (
        <p className="text-sm text-green-400">queued {state.backfilled} bans for push</p>
      )}
    </form>
  );
}
