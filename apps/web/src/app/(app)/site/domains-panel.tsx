import { AddDomainForm } from "./add-domain-form";
import { RemoveDomainButton } from "./remove-domain-button";
import { RetryDomainButton } from "./retry-domain-button";

// `disabled` domains are never returned by the API, so the statuses handled here are
// only the ones that can actually reach the UI.
export type DomainStatus =
  | "pending_dns"
  | "dns_ok"
  | "issuing"
  | "active"
  | "failed_dns"
  | "failed_issuance";

export type Domain = {
  id: string;
  domain: string;
  status: DomainStatus;
  last_error: string | null;
  last_checked_at: string | null;
  created_at: string;
};

const STATUS_STYLES: Record<DomainStatus, string> = {
  active: "bg-green-900 text-green-300",
  pending_dns: "bg-amber-900 text-amber-300",
  dns_ok: "bg-amber-900 text-amber-300",
  issuing: "bg-amber-900 text-amber-300",
  failed_dns: "bg-red-900 text-red-300",
  failed_issuance: "bg-red-900 text-red-300",
};

const STATUS_LABELS: Record<DomainStatus, string> = {
  active: "Active",
  pending_dns: "Setting up",
  dns_ok: "Setting up",
  issuing: "Setting up",
  failed_dns: "DNS not found",
  failed_issuance: "Certificate failed",
};

const FAILED_STATUSES: DomainStatus[] = ["failed_dns", "failed_issuance"];
const SETTING_UP_STATUSES: DomainStatus[] = ["pending_dns", "dns_ok", "issuing"];

// Small dependency-free "3m ago" formatter; "-" for null. Good enough since domain
// health is only checked periodically anyway.
function relativeTime(iso: string | null): string {
  if (!iso) return "-";
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function DomainsPanel({
  domains,
  edgeTarget,
}: {
  domains: Domain[];
  edgeTarget: string | null;
}) {
  return (
    <section className="flex flex-col gap-4 rounded border border-neutral-800 p-5">
      <div>
        <h2 className="text-base font-medium text-neutral-100">Custom domains</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Connect your own domain so your storefront shows up under your brand instead of
          the default address.
        </p>
      </div>

      <div className="rounded border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-300">
        <p>Point a CNAME record for your domain at:</p>
        {edgeTarget ? (
          <code className="mt-2 block w-fit rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100">
            {edgeTarget}
          </code>
        ) : (
          <p className="mt-2 text-neutral-500">Contact support for your edge target.</p>
        )}
        <p className="mt-2 text-xs text-neutral-500">
          It can take a few minutes after DNS is set for your domain to become active.
        </p>
      </div>

      <AddDomainForm />

      {domains.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No custom domains yet. Your site is always available at its default address.
        </p>
      ) : (
        <div className="overflow-hidden rounded border border-neutral-800">
          <table className="w-full text-start text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-3 py-2">Domain</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Last checked</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.id} className="border-t border-neutral-800">
                  <td className="px-3 py-2 font-mono text-xs text-neutral-200">{d.domain}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[d.status]}`}>
                      {STATUS_LABELS[d.status]}
                    </span>
                    {SETTING_UP_STATUSES.includes(d.status) && (
                      <div className="mt-1 text-xs text-neutral-500">{d.status}</div>
                    )}
                    {d.last_error && <div className="mt-1 text-xs text-red-400">{d.last_error}</div>}
                  </td>
                  <td className="px-3 py-2 text-neutral-400">{relativeTime(d.last_checked_at)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-2">
                      {FAILED_STATUSES.includes(d.status) && <RetryDomainButton domainId={d.id} />}
                      <RemoveDomainButton domainId={d.id} domain={d.domain} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
