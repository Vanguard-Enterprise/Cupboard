"use client";

import { useActionState } from "react";
import { toggleBmSyncAction } from "@/lib/actions";

// Flips inbound sync on/off. The value to send is the opposite of the server-known
// state, carried in a hidden field so the client has no state of its own beyond the
// pending flag useActionState already tracks.
export function SyncToggle({ enabled, disabled }: { enabled: boolean; disabled: boolean }) {
  const [state, action, pending] = useActionState(toggleBmSyncAction, {});
  return (
    <div className="flex flex-col gap-1">
      <form action={action}>
        <input type="hidden" name="sync_enabled" value={enabled ? "false" : "true"} />
        <button
          disabled={disabled || pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Saving…" : enabled ? "Disable inbound sync" : "Enable inbound sync"}
        </button>
      </form>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </div>
  );
}
