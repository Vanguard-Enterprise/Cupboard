// Server-only storefront data access: resolve a public host to its site. Unauthenticated
// by design (public pages); goes to the gateway's /public/* passthrough, which the
// tenant service backs with a short-TTL Redis cache. React.cache() dedupes the
// layout/page/metadata calls within one request.
import "server-only";
import { cache } from "react";
import { gatewayBase } from "@/lib/api";

export type ResolvedSite = {
  site_id: string;
  tenant_id: string;
  slug: string;
  theme_id: string;
  config: Record<string, unknown>;
  published: boolean;
};

export const resolveSite = cache(async (host: string): Promise<ResolvedSite | null> => {
  const res = await fetch(
    `${gatewayBase()}/public/sites/resolve?host=${encodeURIComponent(host)}`,
    { cache: "no-store" },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`site resolve failed: ${res.status}`);
  }
  return (await res.json()) as ResolvedSite;
});
