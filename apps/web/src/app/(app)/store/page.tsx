import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { CatalogTable } from "./catalog-table";
import { ConnectForm } from "./connect-form";
import { DisconnectButton } from "./disconnect-button";
import {
  CONNECTION_STATUS_STYLES,
  PROVIDER_LABELS,
  fetchProducts,
  relativeTime,
  type StoreConnection,
} from "./shared";
import { SyncButton } from "./sync-button";

type StoreResponse = { connection: StoreConnection | null };

export default async function StorePage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.StoreManage)) {
    return (
      <p className="text-sm text-neutral-400">You don&apos;t have access to store management.</p>
    );
  }

  const res = await apiFetch("/store");
  const loadFailed = !res.ok;
  const data: StoreResponse = loadFailed ? { connection: null } : await res.json();
  const connection = data.connection;

  const products =
    !loadFailed && connection && connection.product_count > 0 ? await fetchProducts() : [];

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Store</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Connect your PayNow store so its catalog and orders sync into Cupboard.
        </p>
      </div>

      {loadFailed && (
        <p className="rounded border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-300">
          Could not load your store connection right now (service error).
        </p>
      )}

      {!loadFailed && !connection && <ConnectForm />}

      {!loadFailed && connection && (
        <section className="flex flex-col gap-4 rounded border border-neutral-800 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-base font-medium text-neutral-100">
              {PROVIDER_LABELS[connection.provider] ?? connection.provider}
            </h2>
            <span
              className={`rounded px-2 py-0.5 text-xs ${CONNECTION_STATUS_STYLES[connection.status]}`}
            >
              {connection.status}
            </span>
            {!connection.store_live && (
              <span className="rounded bg-amber-900 px-2 py-0.5 text-xs text-amber-300">
                Test mode
              </span>
            )}
          </div>

          {connection.status === "error" && connection.last_error && (
            <p className="text-sm text-red-400">{connection.last_error}</p>
          )}

          <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
            <div>
              <div className="text-xs text-neutral-500">Store name</div>
              <div className="text-neutral-200">{connection.store_name ?? "-"}</div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Store ID</div>
              <div className="font-mono text-xs text-neutral-300">
                {connection.store_external_id}
              </div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Currency</div>
              <div className="text-neutral-200">{connection.store_currency ?? "-"}</div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Products</div>
              <div className="text-neutral-200">{connection.product_count}</div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Last synced</div>
              <div className="text-neutral-200">{relativeTime(connection.catalog_synced_at)}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <SyncButton />
            <DisconnectButton />
          </div>
        </section>
      )}

      {!loadFailed && connection && connection.product_count > 0 && (
        <CatalogTable products={products} />
      )}
    </div>
  );
}
