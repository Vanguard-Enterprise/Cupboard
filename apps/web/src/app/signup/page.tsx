"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signupAction } from "@/lib/actions";

export default function SignupPage() {
  const [state, action, pending] = useActionState(signupAction, {});
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Create your Cupboard account</h1>
      <form action={action} className="flex flex-col gap-3">
        <input
          name="display_name"
          required
          placeholder="Your name"
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
        />
        <input
          name="email"
          type="email"
          required
          placeholder="Email"
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
        />
        <input
          name="password"
          type="password"
          required
          minLength={8}
          placeholder="Password (min 8 chars)"
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
        />
        {state.error && <p className="text-sm text-red-400">{state.error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create account"}
        </button>
      </form>
      <p className="text-sm text-neutral-400">
        Already have an account?{" "}
        <Link href="/login" className="text-indigo-400 hover:underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
