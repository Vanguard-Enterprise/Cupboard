"use client";

import { useActionState } from "react";
import { createInviteAction } from "@/lib/actions";

export function InviteForm({ roles }: { roles: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(createInviteAction, {});
  return (
    <div className="flex flex-col gap-2">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input
          name="email"
          type="email"
          required
          placeholder="staff@example.com"
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
        <select
          name="role_id"
          defaultValue=""
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        >
          <option value="">No role</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Inviting…" : "Send invite"}
        </button>
      </form>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
      {state.acceptUrl && (
        <p className="text-sm text-green-400">
          Invite created. Share this link (email delivery is stubbed in Phase 1):{" "}
          <code className="break-all rounded bg-neutral-800 px-1">{state.acceptUrl}</code>
        </p>
      )}
    </div>
  );
}
