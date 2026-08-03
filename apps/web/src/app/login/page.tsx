"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useActionState } from "react";
import { loginAction } from "@/lib/actions";

const DISCORD_START = "/api/auth/discord/start";

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, {});

  // A full navigation is intentional here. The session cookies are written by the
  // Server Action response; navigating only after the client receives that response
  // guarantees the protected layout sees them and avoids an intermittent App Router
  // 404 during the action's redirect flight.
  useEffect(() => {
    if (state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.redirectTo]);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Sign in to Cupboard</h1>
      <form action={action} className="flex flex-col gap-3">
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
          placeholder="Password"
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2"
        />
        {state.error && <p className="text-sm text-red-400">{state.error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <a
        href={DISCORD_START}
        className="rounded border border-neutral-700 px-3 py-2 text-center hover:bg-neutral-900"
      >
        Continue with Discord
      </a>
      <p className="text-sm text-neutral-400">
        No account?{" "}
        <Link href="/signup" className="text-indigo-400 hover:underline">
          Create one
        </Link>
      </p>
    </main>
  );
}
