"use client";

import { useActionState, useState } from "react";
import { connectStoreAction } from "@/lib/actions";

// Connect form. Client component so it can surface inline validation errors (bad key,
// multiple stores, provider not configured) via useActionState, and so the field set can
// switch on the selected provider. On a "specify the store id" error the inputs are left
// as-is (uncontrolled, no reset) so the operator can just add the store id and resubmit.
export function ConnectForm() {
  const [state, action, pending] = useActionState(connectStoreAction, {});
  const [provider, setProvider] = useState<"paynow" | "tebex">("paynow");

  return (
    <form action={action} className="flex flex-col gap-4 rounded border border-neutral-800 p-5">
      <div>
        <div className="text-xs text-neutral-400">Provider</div>
        <div className="mt-2 flex flex-wrap gap-3">
          <label
            className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm text-neutral-100 ${
              provider === "paynow" ? "border-indigo-700 bg-neutral-900" : "border-neutral-800"
            }`}
          >
            <input
              type="radio"
              name="provider"
              value="paynow"
              checked={provider === "paynow"}
              onChange={() => setProvider("paynow")}
              className="h-4 w-4"
            />
            PayNow
          </label>
          <label
            className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm text-neutral-100 ${
              provider === "tebex" ? "border-indigo-700 bg-neutral-900" : "border-neutral-800"
            }`}
          >
            <input
              type="radio"
              name="provider"
              value="tebex"
              checked={provider === "tebex"}
              onChange={() => setProvider("tebex")}
              className="h-4 w-4"
            />
            Tebex
          </label>
        </div>
      </div>

      {provider === "tebex" ? (
        <>
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            Tebex public token
            <input
              name="store_id"
              required
              placeholder="t66x-abcd..."
              className="w-96 max-w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
            />
            <span className="text-neutral-600">
              Your store&apos;s public (project) token from the Tebex creator panel.
            </span>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            Game Server secret key
            <input
              name="api_key"
              type="password"
              required
              placeholder="••••••••"
              className="w-96 max-w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
            />
            <span className="text-neutral-600">
              Stored encrypted: it will never be shown again after you save it.
            </span>
          </label>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            API key
            <input
              name="api_key"
              type="password"
              required
              placeholder="••••••••"
              className="w-96 max-w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
            />
            <span className="text-neutral-600">
              Stored encrypted: it will never be shown again after you save it.
            </span>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-400">
            Store ID <span className="text-neutral-600">(optional)</span>
            <input
              name="store_id"
              placeholder="12345"
              className="w-64 max-w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
            />
            <span className="text-neutral-600">
              Only needed when your key can access multiple stores.
            </span>
          </label>
        </>
      )}

      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Connecting…" : "Connect"}
        </button>
      </div>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </form>
  );
}
