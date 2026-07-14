// Status banners for the ?flag= breadcrumbs Stripe return URLs carry (decision J). The
// return page is never the source of truth (the webhook is), so these only acknowledge
// the handoff outcome. The services slice adds more flags to this map.

type Banner = { tone: "success" | "neutral"; message: string };

const BANNERS: Record<string, Banner> = {
  checkout_success: {
    tone: "success",
    message: "Subscription checkout completed; your plan updates as soon as payment is confirmed.",
  },
  checkout_cancel: { tone: "neutral", message: "Checkout canceled." },
  service_success: {
    tone: "success",
    message: "Purchase completed; our team will reach out to begin work.",
  },
  service_cancel: { tone: "neutral", message: "Purchase canceled." },
};

const TONE_STYLES: Record<Banner["tone"], string> = {
  success: "border-green-900 bg-green-950 text-green-300",
  neutral: "border-neutral-800 text-neutral-300",
};

export function FlagBanner({ flag }: { flag?: string }) {
  const banner = flag ? BANNERS[flag] : undefined;
  if (!banner) return null;
  return (
    <div className={`rounded border px-4 py-3 text-sm ${TONE_STYLES[banner.tone]}`}>
      {banner.message}
    </div>
  );
}
