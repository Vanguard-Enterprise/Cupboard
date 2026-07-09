"use client";

import { useActionState } from "react";
import { addDomainAction } from "@/lib/actions";

// Connects a new custom domain. Client component so it can surface inline validation
// errors (invalid domain, cap reached, no site yet, or the 409 already-connected case)
// via useActionState.
export function AddDomainForm() {
  const [state, action, pending] = useActionState(addDomainAction, {});

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs text-neutral-400">
        Domain
        <input
          name="domain"
          required
          placeholder="store.yourcommunity.gg"
          className="w-72 max-w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add domain"}
      </button>
      {state.error && <p className="w-full text-sm text-red-400">{state.error}</p>}
    </form>
  );
}
