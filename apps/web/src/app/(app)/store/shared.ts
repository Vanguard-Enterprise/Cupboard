import { apiFetch } from "@/lib/api";

export type StoreConnection = {
  provider: string;
  status: "connected" | "error" | "disconnected";
  store_external_id: string;
  store_name: string | null;
  store_currency: string | null;
  store_live: boolean | null;
  last_error: string | null;
  catalog_synced_at: string | null;
  next_catalog_sync_at: string | null;
  product_count: number;
  created_at: string;
};

export type StoreProduct = {
  external_id: string;
  slug: string | null;
  name: string;
  description: string | null;
  image_url: string | null;
  price_minor: number;
  price_final_minor: number | null;
  currency: string;
  kind: string;
  interval_value: number | null;
  interval_scale: string | null;
  category_ids: string[];
  available: boolean;
  sort_order: number;
};

export type Entitlement = {
  steam_id: string | null;
  product_name: string | null;
  kind: string;
  status: "active" | "expired" | "revoked" | "refunded" | "chargeback";
  granted_at: string | null;
  expires_at: string | null;
  source: "webhook" | "reconcile";
  updated_at: string;
};

export const PROVIDER_LABELS: Record<string, string> = {
  paynow: "PayNow",
  tebex: "Tebex",
};

export const CONNECTION_STATUS_STYLES: Record<StoreConnection["status"], string> = {
  connected: "bg-green-900 text-green-300",
  error: "bg-red-900 text-red-300",
  disconnected: "bg-neutral-800 text-neutral-400",
};

export async function fetchProducts(): Promise<StoreProduct[]> {
  const res = await apiFetch("/store/products");
  if (!res.ok) return [];
  const data = await res.json();
  return data.products ?? [];
}

export async function fetchEntitlements(): Promise<Entitlement[]> {
  const res = await apiFetch("/store/entitlements");
  if (!res.ok) return [];
  const data = await res.json();
  return data.entitlements ?? [];
}

// Small dependency-free "3m ago" formatter; "-" for null. Coarse buckets are fine since
// the catalog only refreshes every few minutes anyway.
export function relativeTime(iso: string | null): string {
  if (!iso) return "-";
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
