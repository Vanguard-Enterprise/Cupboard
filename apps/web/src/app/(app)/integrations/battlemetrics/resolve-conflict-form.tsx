"use client";

import { useActionState } from "react";
import { resolveBmConflictAction } from "@/lib/actions";
import type { BmConflict } from "./shared";

// Resolves one sync conflict. Two submit buttons carry the `choice` value (plus a hidden
// conflict id) so a single server action covers both outcomes; they share the pending
// state since at most one is ever submitted at a time. The labels are contextual: an
// inbound conflict (BM edited a revoked ban) keeps or lifts the local revoke; an outbound
// conflict (BM removed a ban we pushed) re-pushes it or accepts the removal.
const LABELS: Record<BmConflict["direction"], { keepLocal: string; acceptRemote: string }> = {
  inbound: { keepLocal: "Keep revoked", acceptRemote: "Accept BattleMetrics" },
  outbound: { keepLocal: "Re-push to BattleMetrics", acceptRemote: "Accept removal" },
};

export function ResolveConflictForm({
  id,
  direction,
}: {
  id: string;
  direction: BmConflict["direction"];
}) {
  const [state, action, pending] = useActionState(resolveBmConflictAction, {});
  const labels = LABELS[direction] ?? LABELS.inbound;
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
          {pending ? "Saving…" : labels.keepLocal}
        </button>
        <button
          name="choice"
          value="accept_remote"
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Saving…" : labels.acceptRemote}
        </button>
      </form>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </div>
  );
}
