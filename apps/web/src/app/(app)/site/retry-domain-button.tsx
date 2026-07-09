"use client";

import { useActionState } from "react";
import { retryDomainAction } from "@/lib/actions";

// Re-queues DNS/certificate checks for a domain stuck in a failed status.
export function RetryDomainButton({ domainId }: { domainId: string }) {
  const [state, action, pending] = useActionState(retryDomainAction, {});
  return (
    <div className="flex flex-col items-end gap-1">
      <form action={action}>
        <input type="hidden" name="domain_id" value={domainId} />
        <button
          disabled={pending}
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
        >
          {pending ? "Retrying…" : "Retry"}
        </button>
      </form>
      {state.error && <p className="text-xs text-red-400">{state.error}</p>}
    </div>
  );
}
