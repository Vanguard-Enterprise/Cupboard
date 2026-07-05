"use client";

import { useActionState } from "react";
import { disconnectStoreAction } from "@/lib/actions";

// Disconnects the store. Destructive, so it confirms first; the confirm lives in the
// form's onSubmit so a cancel just prevents the action from ever firing.
export function DisconnectButton() {
  const [state, action, pending] = useActionState(disconnectStoreAction, {});
  return (
    <div className="flex flex-col gap-1">
      <form
        action={action}
        onSubmit={(e) => {
          if (!confirm("Disconnect your store? Catalog sync will stop until you reconnect.")) {
            e.preventDefault();
          }
        }}
      >
        <button
          disabled={pending}
          className="rounded border border-red-900 px-3 py-2 text-sm text-red-400 hover:bg-red-950 disabled:opacity-50"
        >
          {pending ? "Disconnecting…" : "Disconnect"}
        </button>
      </form>
      {state.error && <p className="text-xs text-red-400">{state.error}</p>}
    </div>
  );
}
