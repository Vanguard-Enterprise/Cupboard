"use client";

import { useActionState } from "react";
import { syncStoreAction } from "@/lib/actions";

// Kicks off an immediate catalog sync. The backend already runs syncs on its own
// schedule; this just lets an operator force one after editing products upstream.
export function SyncButton() {
  const [state, action, pending] = useActionState(syncStoreAction, {});
  return (
    <div className="flex flex-col gap-1">
      <form action={action}>
        <button
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Syncing…" : "Sync now"}
        </button>
      </form>
      {state.error && <p className="text-xs text-red-400">{state.error}</p>}
    </div>
  );
}
