// Tebex basket-auth return leg. After a player authorizes their basket on Tebex, Tebex 302s
// the browser here (the returnUrl embedded in the basket-auth link points at this route). We
// exchange the checkout session server-side for the Tebex hosted-checkout URL and 303 the
// browser onward to pay. The player token is read from the httpOnly cb_player_access cookie
// and never reaches client JavaScript; a signed-out player is sent to login, any failure
// back to the store. Mirrors the shape of login/complete/route.ts.
import { NextRequest, NextResponse } from "next/server";
import { gatewayBase } from "@/lib/api";

const ACCESS = "cb_player_access";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ host: string; session: string }> },
): Promise<NextResponse> {
  const token = request.cookies.get(ACCESS)?.value;
  if (!token) return NextResponse.redirect(new URL("/login", request.url), 303);

  const { session } = await params;
  const fail = NextResponse.redirect(new URL("/store?error=1", request.url), 303);

  const res = await fetch(`${gatewayBase()}/player/checkout/${session}/continue`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  }).catch(() => null);
  if (!res || !res.ok) return fail;

  const body = (await res.json().catch(() => null)) as { redirect_url?: unknown } | null;
  if (!body || typeof body.redirect_url !== "string") return fail;

  try {
    return NextResponse.redirect(new URL(body.redirect_url), 303);
  } catch {
    // redirect_url wasn't a valid absolute URL; don't send the browser to a broken target.
    return fail;
  }
}
