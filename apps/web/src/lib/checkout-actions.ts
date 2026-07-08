"use server";

// Server Action for the storefront player checkout flow. Every gateway call is server-side;
// the browser only ever follows the redirect this returns (either to the provider's hosted
// checkout on success, or back to the product page with an error flag). The player token is
// read from the httpOnly cb_player_access cookie and never reaches client JavaScript, and
// the return/cancel URLs are built from the verified x-cb-site-host header (never client
// input), mirroring the tenant-resolution discipline in lib/player-actions.ts.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { gatewayBase } from "@/lib/api";

const ACCESS = "cb_player_access";

// The checkout response is one of two steps. "final" carries the provider's hosted-checkout
// URL; "needs_provider_auth" (Tebex) carries a basket-auth URL whose embedded returnUrl
// already points back at our continue leg, so the browser is redirected to redirect_url in
// BOTH cases and this action never has to branch on step.
type CheckoutResponse = {
  redirect_url?: unknown;
  step?: "final" | "needs_provider_auth";
  session_id?: string;
};

/** Begin a purchase: ask the gateway to open a hosted checkout session for this product and
 * send the browser to the provider. A signed-out player is sent to login; any failure sends
 * the player back to the product page with an error flag. */
export async function startCheckout(productExternalId: string): Promise<void> {
  const token = (await cookies()).get(ACCESS)?.value;
  // redirect() throws NEXT_REDIRECT; keep it out of the try/catch-free fetch path below.
  if (!token) redirect("/login");

  const host = (await headers()).get("x-cb-site-host");
  let target: string | null = null;

  if (host) {
    // Absolute URLs on the storefront's own host: the provider redirects the browser back
    // here after (return) or instead of (cancel) paying. The host header is a bare host
    // (middleware strips any port), so https is always well-formed.
    const returnUrl = `https://${host}/store/checkout/return`;
    const cancelUrl = `https://${host}/store/${productExternalId}`;
    const res = await fetch(`${gatewayBase()}/player/checkout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        product_external_id: productExternalId,
        quantity: 1,
        return_url: returnUrl,
        cancel_url: cancelUrl,
      }),
      cache: "no-store",
    }).catch(() => null);
    if (res && res.ok) {
      const body = (await res.json().catch(() => null)) as CheckoutResponse | null;
      if (body && typeof body.redirect_url === "string") target = body.redirect_url;
    }
  }

  // redirect() throws NEXT_REDIRECT; keep it out of any try/catch above.
  if (!target) redirect(`/store/${productExternalId}?error=1`);
  redirect(target);
}
