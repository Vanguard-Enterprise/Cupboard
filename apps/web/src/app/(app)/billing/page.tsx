import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { ManageBillingButton, PurchaseButton, UpgradeButtons } from "./billing-actions";
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

type ServiceItem = {
  key: string;
  name: string;
  description: string;
  price_amount: number;
  currency: string;
};

type Purchase = {
  id: string;
  service_key: string;
  status: "paid" | "refunded";
  // Nullable on the wire: some Stripe object variants carry no amount/currency.
  amount: number | null;
  currency: string | null;
  purchased_at: string;
};

type Services = { services: ServiceItem[]; purchases: Purchase[] };

async function fetchServices(): Promise<Services | null> {
  const res = await apiFetch("/billing/services");
  if (!res.ok) return null;
  return res.json();
}

/** Amounts arrive in cents; whole-dollar prices drop the trailing .00. Purchases may
 * carry no amount/currency (Stripe object variants), rendered as a quiet placeholder. */
function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null || currency === null) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
  }).format(amount / 100);
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
  const [sub, services] = await Promise.all([fetchSubscription(), fetchServices()]);

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

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-300">Services</h2>
        {!services ? (
          <p className="text-sm text-neutral-500">Could not load services right now.</p>
        ) : (
          <>
            {services.services.length === 0 ? (
              <p className="text-sm text-neutral-500">No services available.</p>
            ) : (
              <div className="flex flex-wrap gap-4">
                {services.services.map((svc) => (
                  <ServiceCard key={svc.key} service={svc} />
                ))}
              </div>
            )}
            <PurchaseHistory purchases={services.purchases} services={services.services} />
          </>
        )}
      </section>
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

function ServiceCard({ service }: { service: ServiceItem }) {
  return (
    <div className="flex w-full max-w-xl flex-col gap-3 rounded border border-neutral-800 px-4 py-3">
      <div className="flex items-baseline gap-3">
        <div className="text-lg font-semibold">{service.name}</div>
        <div className="ml-auto text-sm text-neutral-400">
          {formatAmount(service.price_amount, service.currency)} one-time
        </div>
      </div>
      <p className="text-sm text-neutral-400">{service.description}</p>
      <p className="text-sm text-neutral-500">
        Purchase is self-serve; after payment our team handles fulfillment manually and will
        reach out to you.
      </p>
      <PurchaseButton service={service.key} />
    </div>
  );
}

const PURCHASE_STATUS_STYLES: Record<Purchase["status"], string> = {
  paid: "bg-green-900 text-green-300",
  refunded: "bg-neutral-800 text-neutral-400",
};

function PurchaseHistory({
  purchases,
  services,
}: {
  purchases: Purchase[];
  services: ServiceItem[];
}) {
  if (purchases.length === 0) {
    return <p className="text-sm text-neutral-500">No purchases yet.</p>;
  }
  const names = new Map(services.map((s) => [s.key, s.name]));
  return (
    <div className="overflow-hidden rounded border border-neutral-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-neutral-900 text-neutral-400">
          <tr>
            <th className="px-3 py-2">Service</th>
            <th className="px-3 py-2">Amount</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Purchased</th>
          </tr>
        </thead>
        <tbody>
          {purchases.map((p) => (
            <tr key={p.id} className="border-t border-neutral-800">
              <td className="px-3 py-2">{names.get(p.service_key) ?? p.service_key}</td>
              <td className="px-3 py-2 text-neutral-400">
                {formatAmount(p.amount, p.currency)}
              </td>
              <td className="px-3 py-2">
                <span
                  className={`rounded px-2 py-0.5 text-xs ${PURCHASE_STATUS_STYLES[p.status] ?? "bg-neutral-800 text-neutral-400"}`}
                >
                  {p.status}
                </span>
              </td>
              <td className="px-3 py-2 text-neutral-400">
                {new Date(p.purchased_at).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
