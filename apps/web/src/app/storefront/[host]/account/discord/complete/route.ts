// Discord link landing. After the player authorizes Discord, the central login host 302s
// the browser to https://{host}/account/discord/complete?code=XYZ; the middleware rewrites
// it here. We finalize the link server-side UNDER THE PLAYER'S SESSION (the code is bound to
// the player who started the flow, and the backend only links when the completing session
// matches), then 303 the browser to their account with the outcome.
import { NextRequest, NextResponse } from "next/server";
import { gatewayBase } from "@/lib/api";

const ACCESS = "cb_player_access";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code");
  const token = request.cookies.get(ACCESS)?.value;
  const fail = NextResponse.redirect(new URL("/account?discord=error", request.url), 303);

  if (!token) return NextResponse.redirect(new URL("/login", request.url), 303);
  if (!code) return fail;

  const res = await fetch(gatewayBase() + "/auth/player/discord/complete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ code }),
    cache: "no-store",
  }).catch(() => null);
  if (!res || !res.ok) return fail;

  const body = (await res.json().catch(() => null)) as { outcome?: unknown } | null;
  const outcome = body && typeof body.outcome === "string" ? body.outcome : "error";
  return NextResponse.redirect(new URL(`/account?discord=${outcome}`, request.url), 303);
}
