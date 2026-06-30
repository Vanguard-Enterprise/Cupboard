"use client";

import { useActionState } from "react";
import { createOrgAction } from "@/lib/actions";

export default function OnboardingPage() {
  const [state, action, pending] = useActionState(createOrgAction, {});
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Create your organization</h1>
        <p className="mt-1 text-sm text-neutral-400">
          An organization is your server network&apos;s tenant — its staff, roles, and data
          live here.
        </p>
      </div>
      <form action={action} className="flex flex-col gap-3">
        <input
          name="name"
          required
          placeholder="Organization name (e.g. Acme Rust Network)"
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
        />
        {state.error && <p className="text-sm text-red-400">{state.error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create organization"}
        </button>
      </form>
    </main>
  );
}
