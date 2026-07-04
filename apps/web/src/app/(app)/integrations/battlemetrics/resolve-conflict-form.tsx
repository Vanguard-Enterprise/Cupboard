"use client";

import { useActionState } from "react";
import { resolveBmConflictAction } from "@/lib/actions";

// Resolves one sync conflict. Two submit buttons carry the `choice` value (plus a hidden
// conflict id) so a single server action covers both outcomes; they share the pending
// state since at most one is ever submitted at a time.
export function ResolveConflictForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(resolveBmConflictAction, {});
  return (
    <div className="flex flex-col gap-1">
      <form action={action} className="flex flex-wrap gap-2">
        <input type="hidden" name="id" value={id} />
        <button
          name="choice"
          value="keep_local"
          disabled={pending}
          className="rounded bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Keep local"}
        </button>
        <button
          name="choice"
          value="accept_remote"
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Accept BattleMetrics"}
        </button>
      </form>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </div>
  );
}
