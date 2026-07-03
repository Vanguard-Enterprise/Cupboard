"use client";

import { useActionState, useEffect, useRef } from "react";
import { connectBattlemetricsAction } from "@/lib/actions";

// Connect/reconnect form. Client component so it can surface inline validation errors
// and a pending state via useActionState. The token is write-only: on success the form
// clears so nothing lingers in the DOM.
export function ConnectForm() {
  const [state, action, pending] = useActionState(connectBattlemetricsAction, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <div className="flex flex-col gap-2">
      <form ref={formRef} action={action} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Organization ID
          <input
            name="bm_org_id"
            required
            placeholder="123456"
            className="w-40 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Personal access token
          <input
            name="token"
            type="password"
            required
            placeholder="••••••••"
            className="w-64 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Connecting…" : "Connect"}
        </button>
      </form>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
      {state.ok && <p className="text-sm text-green-400">Connected.</p>}
    </div>
  );
}
