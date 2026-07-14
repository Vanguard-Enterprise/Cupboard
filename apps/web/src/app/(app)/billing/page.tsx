import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { ManageBillingButton, UpgradeButtons } from "./billing-actions";
import { FlagBanner } from "./flag-banner";

type Subscription = {
  plan: string;
  status: "none" | "active" | "trialing" | "past_due" | "canceled" | string;
  current_period_end: string | null;
  effective_plan: string;
};

async function fetchSubscription(): Promise<Subscription | null> {
  const res = await apiFetch("/billing/subscription");
  if (!res.ok) return null;
  return res.json();
}

const PLAN_META: Record<string, { name: string; price: string }> = {
  free: { name: "Free", price: "$0/month" },
  team: { name: "Team", price: "$10/month" },
  enterprise: { name: "Enterprise", price: "$50/month" },
};

const STATUS_STYLES: Record<string, string> = {
  active: "bg-green-900 text-green-300",
  trialing: "bg-green-900 text-green-300",
  past_due: "bg-yellow-900 text-yellow-300",
  canceled: "bg-neutral-800 text-neutral-400",
  none: "bg-neutral-800 text-neutral-400",
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ flag?: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.BillingManage)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to billing.</p>;
  }
  const { flag } = await searchParams;
  const sub = await fetchSubscription();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Your organization&apos;s plan and payment settings. Checkout and management happen on
          Stripe; changes flow back here once Stripe confirms them.
        </p>
      </div>

      <FlagBanner flag={flag} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-300">Plan</h2>
        {!sub ? (
          <p className="text-sm text-neutral-500">Could not load your subscription right now.</p>
        ) : (
          <PlanCard sub={sub} />
        )}
      </section>

      {/* The Services section (one-off purchases) lands here in PR2 slice 2. */}
    </div>
  );
}

function PlanCard({ sub }: { sub: Subscription }) {
  const meta = PLAN_META[sub.plan] ?? { name: sub.plan, price: "" };
  // Mirrors the tenant's checkout guard: anything other than no subscription (or a
  // canceled one) is a live subscription, managed through the Portal.
  const hasLiveSubscription = sub.status !== "none" && sub.status !== "canceled";

  return (
    <div className="flex max-w-xl flex-col gap-4 rounded border border-neutral-800 px-4 py-3">
      <div className="flex items-center gap-3">
        <div>
          <div className="text-lg font-semibold">{meta.name}</div>
          {meta.price && <div className="text-sm text-neutral-400">{meta.price}</div>}
        </div>
        {sub.status !== "none" && (
          <span
            className={`ml-auto rounded px-2 py-0.5 text-xs ${STATUS_STYLES[sub.status] ?? "bg-neutral-800 text-neutral-400"}`}
          >
            {sub.status.replace("_", " ")}
          </span>
        )}
      </div>

      {sub.current_period_end && sub.status !== "canceled" && (
        <p className="text-sm text-neutral-400">
          Renews {new Date(sub.current_period_end).toLocaleString()}
        </p>
      )}

      {sub.status === "past_due" && (
        <p className="text-sm text-yellow-300">
          Payment is past due. Paid features stay on for a short grace window while Stripe
          retries; update your payment method to keep them.
        </p>
      )}

      {sub.effective_plan !== sub.plan && (
        <p className="text-sm text-neutral-500">
          Currently gated as {PLAN_META[sub.effective_plan]?.name ?? sub.effective_plan}.
        </p>
      )}

      {hasLiveSubscription ? <ManageBillingButton /> : <UpgradeButtons />}
    </div>
  );
}
