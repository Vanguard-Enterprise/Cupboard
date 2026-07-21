"use client";

import { useActionState, useState } from "react";
import { createApiKeyAction } from "@/lib/actions";

// Create-key form. The scope picker is limited to the permissions the current operator
// holds (the server also caps against their resolved permissions). The plaintext token is
// shown exactly once (only its keyed hash is stored server-side), so it renders inline for
// copy-paste; it can never be retrieved again.
export function CreateKey({ scopes }: { scopes: string[] }) {
  const [state, action, pending] = useActionState(createApiKeyAction, {});
  // The datetime-local value has no timezone, so the RFC 3339 conversion must happen
  // here in the browser (where new Date() applies the operator's local timezone), not
  // in the server action (which would use the container's timezone). The hidden field
  // carries the converted value; the visible input stays for UX.
  const [expiresAt, setExpiresAt] = useState("");

  return (
    <div className="flex flex-col gap-3">
      <form action={action} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            Name
            <input
              name="name"
              required
              placeholder="CI deploy"
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            Expires <span className="text-neutral-600">(optional)</span>
            <input
              type="datetime-local"
              onChange={(e) => {
                const parsed = new Date(e.target.value);
                setExpiresAt(Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString());
              }}
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
            />
          </label>
          <input type="hidden" name="expires_at" value={expiresAt} />
          <button
            type="submit"
            disabled={pending}
            className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {pending ? "Creating…" : "Create key"}
          </button>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs text-neutral-400">
            Scopes <span className="text-neutral-600">(capped to your own permissions)</span>
          </legend>
          {scopes.length === 0 ? (
            <p className="text-xs text-neutral-500">You hold no grantable permissions.</p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {scopes.map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-xs text-neutral-300">
                  <input type="checkbox" name="scopes" value={scope} className="accent-indigo-600" />
                  <code>{scope}</code>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </form>

      {state.token && (
        <div className="flex flex-col gap-1">
          <code
            className="break-all rounded bg-neutral-900 px-2 py-1 text-xs text-green-300"
            title="Copy this now; it won't be shown again"
          >
            {state.token}
          </code>
          <span className="text-xs text-neutral-500">
            Copy this token now. It won&apos;t be shown again.
          </span>
        </div>
      )}
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </div>
  );
}
