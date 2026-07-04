"use client";

import { useActionState } from "react";
import { updateBmImportScopeAction } from "@/lib/actions";

// Which BM entity types the next import pulls in. Defaults come from the connection's
// persisted settings (absent = enabled); saving always sends all three flags so
// unchecking one never falls back to a stale default for the others.
export function ImportScopeForm({
  servers,
  players,
  notes,
  disabled,
}: {
  servers: boolean;
  players: boolean;
  notes: boolean;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(updateBmImportScopeAction, {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-4 text-sm text-neutral-300">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="import_servers"
            defaultChecked={servers}
            disabled={disabled}
            className="h-4 w-4"
          />
          Servers
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="import_players"
            defaultChecked={players}
            disabled={disabled}
            className="h-4 w-4"
          />
          Players
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="import_notes"
            defaultChecked={notes}
            disabled={disabled}
            className="h-4 w-4"
          />
          Notes
        </label>
        <button
          disabled={disabled || pending}
          className="rounded bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save import scope"}
        </button>
      </div>
      <p className="text-xs text-neutral-500">Scope applies to the next import run.</p>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </form>
  );
}
