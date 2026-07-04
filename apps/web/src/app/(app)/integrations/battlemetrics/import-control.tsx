"use client";

import { useActionState } from "react";
import { controlBmImportAction } from "@/lib/actions";

type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

// Pause/resume/cancel the live import job. Each button is its own tiny form carrying a
// hidden `action` field so the one server action knows which control endpoint to hit;
// only the buttons valid for the job's current status render, and they share the same
// pending state since at most one of them can ever be submitted at a time.
export function ImportControl({ status }: { status: JobStatus | null }) {
  const [state, action, pending] = useActionState(controlBmImportAction, {});
  const canPause = status === "queued" || status === "running";
  const canResume = status === "paused";
  const canCancel = status === "queued" || status === "running" || status === "paused";

  if (!canPause && !canResume && !canCancel) return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {canPause && (
          <form action={action}>
            <input type="hidden" name="action" value="pause" />
            <button
              disabled={pending}
              className="rounded bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50"
            >
              {pending ? "Pausing…" : "Pause"}
            </button>
          </form>
        )}
        {canResume && (
          <form action={action}>
            <input type="hidden" name="action" value="resume" />
            <button
              disabled={pending}
              className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {pending ? "Resuming…" : "Resume"}
            </button>
          </form>
        )}
        {canCancel && (
          <form action={action}>
            <input type="hidden" name="action" value="cancel" />
            <button
              disabled={pending}
              className="rounded bg-neutral-800 px-3 py-2 text-sm font-medium hover:bg-neutral-700 disabled:opacity-50"
            >
              {pending ? "Cancelling…" : "Cancel"}
            </button>
          </form>
        )}
      </div>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </div>
  );
}
