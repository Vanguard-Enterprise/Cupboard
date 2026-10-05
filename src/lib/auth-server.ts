import {
  backendSessionCookieName,
  browserSessionCookieName,
} from "./session-cookie";
import { cookies } from "next/headers";
import { backendUrl } from "./api-proxy";
import type { Identity } from "./api-client";
export async function getIdentity(): Promise<Identity | null> {
  const session = (await cookies()).get(browserSessionCookieName())?.value;
  if (!session) return null;
  const response = await fetch(backendUrl("auth/me"), {
    headers: { cookie: `${backendSessionCookieName}=${session}` },
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok)
    throw new Error("Could not load your account. Try again shortly.");
  return response.json() as Promise<Identity>;
}
