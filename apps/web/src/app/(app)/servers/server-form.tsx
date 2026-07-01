"use client";

import { useActionState } from "react";
import { createServerAction } from "@/lib/actions";

// Add-server form. Client component so it can surface inline validation errors and a
// pending state via useActionState.
export function ServerForm() {
  const [state, action, pending] = useActionState(createServerAction, {});
  return (
    <div className="flex flex-col gap-2">
      <form action={action} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Name
          <input
            name="name"
            required
            placeholder="Main US"
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          RCON host
          <input
            name="rcon_host"
            required
            placeholder="10.0.0.1"
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          RCON port
          <input
            name="rcon_port"
            type="number"
            required
            min={1}
            max={65535}
            defaultValue={28016}
            className="w-28 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          RCON password
          <input
            name="rcon_password"
            type="password"
            required
            placeholder="••••••••"
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Query port <span className="text-neutral-600">(optional)</span>
          <input
            name="query_port"
            type="number"
            min={1}
            max={65535}
            className="w-28 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add server"}
        </button>
      </form>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
      {state.ok && <p className="text-sm text-green-400">Server added.</p>}
    </div>
  );
}
