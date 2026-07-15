"use client";

import { useActionState } from "react";
import { createTicketBindCodeAction } from "@/lib/actions";

// Discord setup-code generator (the ingest-token reveal pattern): the plaintext code is
// shown exactly once, expires in 15 minutes, and a newly minted code invalidates the
// previous one.
export function GenerateBindCode() {
  const [state, action, pending] = useActionState(createTicketBindCodeAction, {});

  return (
    <div className="flex flex-col gap-2">
      <form action={action}>
        <button
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Generating…" : "Generate setup code"}
        </button>
      </form>
      {state.code && (
        <div className="flex flex-col gap-1">
          <code
            className="max-w-md break-all rounded bg-neutral-900 px-2 py-1 text-sm text-green-300"
            title="Run /cupboard setup with this code; it won't be shown again"
          >
            {state.code}
          </code>
          <span className="text-xs text-neutral-500">
            Copy this code now; it won&apos;t be shown again and expires
            {state.expiresAt ? ` ${new Date(state.expiresAt).toLocaleString()}` : " in 15 minutes"}.
            Generating a new code invalidates this one.
          </span>
        </div>
      )}
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </div>
  );
}
