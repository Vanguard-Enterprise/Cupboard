"use client";

import { useActionState } from "react";
import { confirmPrivacyJobAction } from "@/lib/actions";

// Confirm button for an erase job in awaiting_confirm. The dry-run counts render next to
// it (server-side); this only carries the destructive click and surfaces auth's refusals
// as-is (e.g. the job moved on under someone else's confirm).
export function ConfirmJob({ jobId }: { jobId: string }) {
  const [state, action, pending] = useActionState(confirmPrivacyJobAction, {});
  return (
    <form action={action} className="flex flex-col items-start gap-1">
      <input type="hidden" name="job_id" value={jobId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-red-900 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-800 disabled:opacity-50"
      >
        {pending ? "Confirming…" : "Confirm erasure"}
      </button>
      {state.error && <p className="text-xs text-red-400">{state.error}</p>}
    </form>
  );
}
