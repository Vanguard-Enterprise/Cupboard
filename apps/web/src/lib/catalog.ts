// Server-only storefront store data: resolve a public host to its store catalog. Mirrors
// lib/site.ts: unauthenticated public passthrough via the gateway (tenant service backs it
// with a short-TTL Redis cache), React.cache() dedupes calls within one request, any 4xx
// means "no store here" (render the storefront 404, not a 500).
import "server-only";
import { cache } from "react";
import { gatewayBase } from "@/lib/api";

export type CatalogCategory = {
  external_id: string;
  slug: string | null;
  name: string;
  description: string | null;
  image_url: string | null;
  sort_order: number;
};

export type CatalogProduct = {
  external_id: string;
  slug: string | null;
  name: string;
  description: string | null;
  image_url: string | null;
  price_minor: number;
  price_final_minor: number | null;
  currency: string;
  kind: "single" | "subscription";
  interval_value: number | null;
  interval_scale: string | null;
  category_ids: string[];
  available: boolean;
  sort_order: number;
};

export type Catalog = {
  store_name: string | null;
  currency: string | null;
  categories: CatalogCategory[];
  products: CatalogProduct[];
};

export const fetchCatalog = cache(async (host: string): Promise<Catalog | null> => {
  const res = await fetch(
    `${gatewayBase()}/public/store/catalog?host=${encodeURIComponent(host)}`,
    { cache: "no-store" },
  );
  // Any 4xx means "no store for this host" (no site, no connected store, or store pages
  // disabled): render the storefront 404, not a 500.
  if (res.status >= 400 && res.status < 500) return null;
  if (!res.ok) {
    throw new Error(`catalog fetch failed: ${res.status}`);
  }
  return (await res.json()) as Catalog;
});

/** Format integer minor units (cents) as a currency string; defaults to USD when empty. */
export function formatPrice(minor: number, currency: string): string {
  const code = currency?.trim() || "USD";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(
    minor / 100,
  );
}

/** "per 1 month" style label for a subscription, or null for non-subscriptions / when the
 * interval is unknown. */
export function intervalLabel(product: CatalogProduct): string | null {
  if (
    product.kind !== "subscription" ||
    product.interval_value == null ||
    !product.interval_scale
  ) {
    return null;
  }
  const n = product.interval_value;
  const scale = n === 1 ? product.interval_scale : `${product.interval_scale}s`;
  return `per ${n} ${scale}`;
}
