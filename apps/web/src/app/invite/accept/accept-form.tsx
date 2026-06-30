"use client";

import { useActionState } from "react";
import { acceptInviteAction } from "@/lib/actions";

export function AcceptForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(acceptInviteAction, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <p className="text-sm text-neutral-400">
        Set a password to finish joining. (If you already have a Cupboard account with this
        email, leave it blank and you&apos;ll just be added.)
      </p>
      <input
        name="display_name"
        placeholder="Your name (optional)"
        className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
      />
      <input
        name="password"
        type="password"
        minLength={8}
        placeholder="Password (new accounts only)"
        className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
      />
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-indigo-600 px-3 py-2 font-medium hover:bg-indigo-500 disabled:opacity-50"
      >
        {pending ? "Joining…" : "Accept invitation"}
      </button>
    </form>
  );
}
