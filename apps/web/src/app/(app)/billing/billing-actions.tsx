"use client";

import { useActionState } from "react";
import { openBillingPortalAction, startPlanCheckoutAction } from "@/lib/actions";

// Hosted-redirect handoff buttons. On success the server action redirects the browser to
// Stripe, so these only ever render the pending state or an inline error.

/** Upgrade buttons for orgs without a live subscription; the plan rides on the submit
 * button, so one form covers both tiers. */
export function UpgradeButtons() {
  const [state, action, pending] = useActionState(startPlanCheckoutAction, {});
  return (
    <div className="flex flex-col gap-2">
      <form action={action} className="flex flex-wrap gap-2">
        <button
          name="plan"
          value="team"
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          Upgrade to Team ($10/month)
        </button>
        <button
          name="plan"
          value="enterprise"
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          Upgrade to Enterprise ($50/month)
        </button>
      </form>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </div>
  );
}

/** Portal handoff for orgs that already have a subscription (plan changes, cancel,
 * payment method all live there). */
export function ManageBillingButton() {
  const [state, action, pending] = useActionState(openBillingPortalAction, {});
  return (
    <div className="flex flex-col gap-2">
      <form action={action}>
        <button
          disabled={pending}
          className="rounded bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          Manage billing
        </button>
      </form>
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </div>
  );
}
