import { relativeTime, type Entitlement } from "./shared";

const STATUS_STYLES: Record<Entitlement["status"], string> = {
  active: "bg-green-900 text-green-300",
  expired: "bg-neutral-800 text-neutral-400",
  revoked: "bg-neutral-800 text-neutral-400",
  refunded: "bg-red-900 text-red-300",
  chargeback: "bg-amber-900 text-amber-300",
};

function kindLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, " ");
}

// Read-only mirror of the provider's entitlement state: grants come from checkout webhooks
// and a periodic reconcile job, not from anything an operator does in Cupboard.
export function EntitlementsTable({ entitlements }: { entitlements: Entitlement[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-neutral-300">Entitlements</h2>
      <div className="overflow-hidden rounded border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-900 text-neutral-400">
            <tr>
              <th className="px-3 py-2">Steam ID</th>
              <th className="px-3 py-2">Product</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Updated</th>
            </tr>
          </thead>
          <tbody>
            {entitlements.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-neutral-500">
                  No entitlements yet.
                </td>
              </tr>
            )}
            {entitlements.map((e, i) => (
              <tr key={`${e.steam_id ?? "unknown"}-${i}`} className="border-t border-neutral-800">
                <td className="px-3 py-2 font-mono text-xs text-neutral-300">
                  {e.steam_id ?? "-"}
                </td>
                <td className="px-3 py-2 text-neutral-200">{e.product_name ?? "-"}</td>
                <td className="px-3 py-2 text-neutral-400">{kindLabel(e.kind)}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[e.status]}`}>
                    {e.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-neutral-500">{e.source}</td>
                <td className="px-3 py-2 text-neutral-400">{relativeTime(e.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-500">
        Entitlements come from the provider: checkout webhooks and a periodic reconcile job keep
        them in sync. Cupboard reads them here and does not grant or revoke them directly.
      </p>
    </section>
  );
}
