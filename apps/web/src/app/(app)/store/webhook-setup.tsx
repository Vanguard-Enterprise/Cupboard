"use client";

import { useActionState, useState } from "react";
import { setWebhookSecretAction } from "@/lib/actions";

// Tebex manual-webhook setup. Tebex has the operator register a webhook endpoint in their
// creator panel and shows them a signing secret once; we cannot fetch it for them, so this
// section surfaces the URL to register and takes the secret they paste back. Rendered only
// for a Tebex connection (the parent guards on provider).
export function WebhookSetup({
  webhookUrl,
  webhookConfigured,
}: {
  webhookUrl: string | null;
  webhookConfigured: boolean;
}) {
  const [state, action, pending] = useActionState(setWebhookSecretAction, {});
  const [copied, setCopied] = useState(false);

  async function copyUrl() {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context / denied); the URL is still selectable.
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded border border-neutral-800 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-medium text-neutral-100">Webhook setup</h2>
        {webhookConfigured && (
          <span className="rounded bg-green-900 px-2 py-0.5 text-xs text-green-300">
            Webhook configured
          </span>
        )}
      </div>

      {webhookUrl === null ? (
        <p className="text-sm text-neutral-500">
          Webhook delivery isn&apos;t configured on this deployment; the store still reconciles
          entitlements periodically.
        </p>
      ) : (
        <>
          <div className="rounded border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-300">
            <p>Register this endpoint in your Tebex creator panel:</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="block w-fit max-w-full break-all rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100">
                {webhookUrl}
              </code>
              <button
                type="button"
                onClick={copyUrl}
                className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-neutral-500">
              <li>
                In your Tebex creator panel, add this URL as a webhook endpoint subscribed to
                payment events.
              </li>
              <li>Copy the webhook secret Tebex shows you and paste it below.</li>
              <li>Save, then trigger validation in Tebex.</li>
            </ol>
          </div>

          <form action={action} className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-400">
              Webhook secret
              <input
                name="secret"
                type="password"
                required
                placeholder="••••••••"
                className="w-96 max-w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
              />
              <span className="text-neutral-600">
                Stored encrypted: it will never be shown again after you save it.
              </span>
            </label>
            <div>
              <button
                type="submit"
                disabled={pending}
                className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
              >
                {pending ? "Saving…" : "Save webhook secret"}
              </button>
            </div>
            {state.error && <p className="text-sm text-red-400">{state.error}</p>}
            {state.ok && <p className="text-sm text-green-400">Webhook secret saved.</p>}
          </form>
        </>
      )}
    </section>
  );
}
