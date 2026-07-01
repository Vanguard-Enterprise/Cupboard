"use client";

import { useActionState } from "react";
import { createBanAction } from "@/lib/actions";

// Create-ban form. `subjectValue`/`playerId` pre-fill it when banning from a player
// profile; on the Bans page they're blank and the operator types a Steam ID.
export function BanForm({
  subjectValue = "",
  playerId,
  label = "Ban",
}: {
  subjectValue?: string;
  playerId?: string;
  label?: string;
}) {
  const [state, action, pending] = useActionState(createBanAction, {});
  return (
    <div className="flex flex-col gap-2">
      <form action={action} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Steam ID
          <input
            name="subject_value"
            required
            defaultValue={subjectValue}
            placeholder="76561198…"
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Reason
          <input
            name="reason"
            placeholder="cheating"
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        {playerId && <input type="hidden" name="player_id" value={playerId} />}
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-red-700 px-3 py-2 text-sm font-medium hover:bg-red-600 disabled:opacity-50"
        >
          {pending ? "Banning…" : label}
        </button>
      </form>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
      {state.ok && <p className="text-sm text-green-400">Ban created.</p>}
    </div>
  );
}
