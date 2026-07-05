"use client";

import { useActionState } from "react";
import { retryBmOutboxAction } from "@/lib/actions";

// Requeues failed outbound pushes. A single-button Server Action form matching the other
// integration controls; renders a one-line result after submitting.
export function RetryOutboxForm() {
  const [state, action, pending] = useActionState(retryBmOutboxAction, {});
  return (
    <div className="flex flex-col gap-1">
      <form action={action}>
        <button
          disabled={pending}
          className="rounded bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50"
        >
          {pending ? "Requeuing…" : "Retry failed pushes"}
        </button>
      </form>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
      {typeof state.requeued === "number" && (
        <p className="text-sm text-neutral-400">Requeued {state.requeued} push(es).</p>
      )}
    </div>
  );
}
