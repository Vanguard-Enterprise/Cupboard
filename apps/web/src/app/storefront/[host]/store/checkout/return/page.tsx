// Checkout return page. The provider redirects the browser here after a successful hosted
// checkout. Fulfillment is confirmed server-side via provider webhooks, so this page does
// not (and cannot) verify the payment: it is a reassuring landing that points the player at
// their account, where the entitlement appears once the webhook lands. The layout has
// verified the host and wrapped this in the theme Shell (--sf-* variables).
export default function CheckoutReturnPage() {
  return (
    <div className="mx-auto max-w-md py-12 text-center">
      <div className="rounded-2xl border border-[var(--sf-border)] bg-[var(--sf-card)] p-8">
        <h1 className="text-2xl font-bold tracking-tight">Thanks for your purchase</h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--sf-muted)]">
          Your payment went through. It can take a moment for the purchase to appear on your
          account while we confirm it.
        </p>

        <div className="mt-8 flex flex-col gap-3">
          <a
            href="/account"
            className="rounded-lg bg-[var(--sf-primary)] px-4 py-2.5 font-medium text-[var(--sf-on-primary)] transition-opacity hover:opacity-90"
          >
            View your purchases
          </a>
          <a
            href="/store"
            className="rounded-lg border border-[var(--sf-border)] px-4 py-2.5 text-sm font-medium transition-colors hover:border-[var(--sf-primary)] hover:text-[var(--sf-primary)]"
          >
            Back to store
          </a>
        </div>
      </div>
    </div>
  );
}
