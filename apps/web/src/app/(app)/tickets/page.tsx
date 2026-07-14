import Link from "next/link";
import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { STATUS_STYLES, TICKET_STATUSES, TYPE_STYLES, typeLabel, type Ticket } from "./shared";

async function fetchTickets(status?: string, type?: string): Promise<Ticket[]> {
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (type) qs.set("type", type);
  const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
  const res = await apiFetch(`/tickets${suffix}`);
  if (!res.ok) return [];
  const body = await res.json();
  return Array.isArray(body?.tickets) ? body.tickets : [];
}

/** A filter link row: "All" plus one link per value, the active one highlighted. Filters
 * combine via query params, so each link preserves the other dimension. */
function FilterRow({
  label,
  param,
  values,
  current,
  other,
}: {
  label: string;
  param: string;
  values: readonly { value: string; text: string }[];
  current?: string;
  other: string;
}) {
  const href = (value?: string) => {
    const qs = new URLSearchParams(other);
    if (value) qs.set(param, value);
    return qs.size > 0 ? `/tickets?${qs.toString()}` : "/tickets";
  };
  const cls = (active: boolean) =>
    `rounded px-2 py-0.5 ${active ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`;
  return (
    <div className="flex items-center gap-1 text-xs">
      <span className="mr-1 text-neutral-500">{label}</span>
      <Link href={href()} className={cls(!current)}>
        All
      </Link>
      {values.map((v) => (
        <Link key={v.value} href={href(v.value)} className={cls(current === v.value)}>
          {v.text}
        </Link>
      ))}
    </div>
  );
}

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; type?: string }>;
}) {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.SupportRespond)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to tickets.</p>;
  }
  const { status, type } = await searchParams;
  const tickets = await fetchTickets(status, type);

  const statusOther = new URLSearchParams(type ? { type } : {}).toString();
  const typeOther = new URLSearchParams(status ? { status } : {}).toString();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Tickets</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Support requests and ban appeals from your players, opened on your site or via
          Discord.
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-6">
          <FilterRow
            label="Status"
            param="status"
            values={TICKET_STATUSES.map((s) => ({ value: s, text: s }))}
            current={status}
            other={statusOther}
          />
          <FilterRow
            label="Type"
            param="type"
            values={[
              { value: "general", text: "general" },
              { value: "ban_appeal", text: "ban appeal" },
            ]}
            current={type}
            other={typeOther}
          />
        </div>

        {tickets.length === 0 ? (
          <p className="text-sm text-neutral-500">No tickets.</p>
        ) : (
          <div className="overflow-hidden rounded border border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-3 py-2">Subject</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Assignee</th>
                  <th className="px-3 py-2">Updated</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.id} className="border-t border-neutral-800">
                    <td className="px-3 py-2">
                      <Link
                        href={`/tickets/${t.id}`}
                        className="text-indigo-400 hover:text-indigo-300"
                      >
                        {t.subject}
                      </Link>
                      {t.category && (
                        <span className="ml-2 text-xs text-neutral-500">{t.category}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${TYPE_STYLES[t.type] ?? "bg-neutral-800 text-neutral-300"}`}
                      >
                        {typeLabel(t.type)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[t.status] ?? "bg-neutral-800 text-neutral-300"}`}
                      >
                        {t.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-neutral-400">
                      {t.assignee_user_id ? (
                        t.assignee_user_id === session.user.id ? (
                          "you"
                        ) : (
                          <span className="font-mono text-xs" title={t.assignee_user_id}>
                            {t.assignee_user_id.slice(0, 8)}
                          </span>
                        )
                      ) : (
                        "unassigned"
                      )}
                    </td>
                    <td className="px-3 py-2 text-neutral-400">
                      {new Date(t.last_message_at ?? t.updated_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
