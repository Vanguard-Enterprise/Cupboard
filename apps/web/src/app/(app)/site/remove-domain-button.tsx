"use client";

import { useActionState } from "react";
import { removeDomainAction } from "@/lib/actions";

// Disconnects one domain. Destructive, so it confirms first; the confirm lives in the
// form's onSubmit so a cancel just prevents the action from ever firing.
export function RemoveDomainButton({ domainId, domain }: { domainId: string; domain: string }) {
  const [state, action, pending] = useActionState(removeDomainAction, {});
  return (
    <div className="flex flex-col items-end gap-1">
      <form
        action={action}
        onSubmit={(e) => {
          if (!confirm(`Remove ${domain}? Visitors using this domain will stop reaching your site.`)) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="domain_id" value={domainId} />
        <button
          disabled={pending}
          className="rounded border border-red-900 px-2 py-1 text-xs text-red-400 hover:bg-red-950 disabled:opacity-50"
        >
          {pending ? "Removing…" : "Remove"}
        </button>
      </form>
      {state.error && <p className="text-xs text-red-400">{state.error}</p>}
    </div>
  );
}
