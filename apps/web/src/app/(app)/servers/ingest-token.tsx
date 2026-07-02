"use client";

import { useActionState } from "react";
import { issueIngestTokenAction, revokeIngestTokenAction } from "@/lib/actions";

// Per-server push-ingest token controls. Issuing rotates; the plaintext is shown exactly
// once (only its hash is stored server-side), so it renders inline for copy-paste into
// the plugin config.
export function IngestToken({ serverId, hasToken }: { serverId: string; hasToken: boolean }) {
  const [state, action, pending] = useActionState(issueIngestTokenAction, {});

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <form action={action}>
          <input type="hidden" name="server_id" value={serverId} />
          <button
            disabled={pending}
            className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
          >
            {hasToken || state.token ? "Rotate token" : "Issue token"}
          </button>
        </form>
        {(hasToken || state.token) && (
          <form action={revokeIngestTokenAction}>
            <input type="hidden" name="server_id" value={serverId} />
            <button className="text-xs text-red-400 hover:text-red-300">Revoke</button>
          </form>
        )}
      </div>
      {state.token && (
        <code
          className="max-w-64 break-all rounded bg-neutral-900 px-2 py-1 text-xs text-green-300"
          title="Copy this into the plugin config — it won't be shown again"
        >
          {state.token}
        </code>
      )}
      {state.error && <span className="text-xs text-red-400">{state.error}</span>}
    </div>
  );
}
