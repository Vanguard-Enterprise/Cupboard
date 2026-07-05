"use client";

import { useActionState } from "react";
import { createSiteAction } from "@/lib/actions";
import { ThemePicker } from "./theme-picker";

// Shown before the tenant has a site yet. Client component so it can surface inline
// validation errors (including the 409 slug-taken conflict) via useActionState.
export function CreateSiteForm() {
  const [state, action, pending] = useActionState(createSiteAction, {});

  return (
    <form action={action} className="flex flex-col gap-4 rounded border border-neutral-800 p-5">
      <label className="flex flex-col gap-1 text-xs text-neutral-400">
        Slug
        <input
          name="slug"
          required
          minLength={3}
          maxLength={40}
          pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
          placeholder="my-server"
          className="w-64 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
        />
        <span className="text-neutral-600">
          3-40 chars: lowercase letters, digits, and inner hyphens. This becomes your
          site&apos;s URL.
        </span>
      </label>
      <ThemePicker defaultValue="ember" />
      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create site"}
        </button>
      </div>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </form>
  );
}
