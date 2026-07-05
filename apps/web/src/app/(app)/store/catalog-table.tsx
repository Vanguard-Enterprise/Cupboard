import type { StoreProduct } from "./shared";

function formatPrice(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

function formatInterval(value: number | null, scale: string | null): string | null {
  if (!value || !scale) return null;
  return `${value} ${scale}${value === 1 ? "" : "s"}`;
}

function kindLabel(product: StoreProduct): string {
  if (product.kind === "subscription") {
    const interval = formatInterval(product.interval_value, product.interval_scale);
    return interval ? `Subscription (${interval})` : "Subscription";
  }
  return product.kind.charAt(0).toUpperCase() + product.kind.slice(1).replace(/_/g, " ");
}

// Read-only mirror of the provider's catalog. There is no create/edit here on purpose:
// products are managed on the provider's own dashboard, not in Cupboard.
export function CatalogTable({ products }: { products: StoreProduct[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-neutral-300">Catalog</h2>
      <div className="overflow-hidden rounded border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-900 text-neutral-400">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Price</th>
              <th className="px-3 py-2">Available</th>
              <th className="px-3 py-2">External ID</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.external_id} className="border-t border-neutral-800">
                <td className="px-3 py-2">
                  {p.name}
                  <div className="text-xs text-neutral-500">{p.slug}</div>
                </td>
                <td className="px-3 py-2 text-neutral-400">{kindLabel(p)}</td>
                <td className="px-3 py-2">
                  {p.price_final_minor != null && p.price_final_minor < p.price_minor ? (
                    <>
                      <span className="text-neutral-200">
                        {formatPrice(p.price_final_minor, p.currency)}
                      </span>{" "}
                      <span className="text-neutral-500 line-through">
                        {formatPrice(p.price_minor, p.currency)}
                      </span>
                    </>
                  ) : (
                    <span className="text-neutral-200">{formatPrice(p.price_minor, p.currency)}</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {p.available ? (
                    <span className="text-neutral-400">yes</span>
                  ) : (
                    <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                      Sold out
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-neutral-500">{p.external_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-500">
        The catalog refreshes automatically every 5 minutes. Make changes on your
        provider&apos;s dashboard: Cupboard mirrors the catalog and does not edit it.
      </p>
    </section>
  );
}
