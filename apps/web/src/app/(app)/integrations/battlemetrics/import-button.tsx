"use client";

import { useActionState } from "react";
import { startBmImportAction } from "@/lib/actions";

// Kicks off an import job. Disabled by the server (no connection yet, or a job is
// already queued/running) so the only client-side state is the in-flight submit and
// any error the backend surfaces (e.g. "an import is already queued or running").
export function ImportButton({ disabled }: { disabled: boolean }) {
  const [state, action, pending] = useActionState(startBmImportAction, {});
  return (
    <div className="flex flex-col gap-1">
      <form action={action}>
        <button
          disabled={disabled || pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Starting…" : "Run import"}
        </button>
      </form>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </div>
  );
}
