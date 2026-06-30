import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { InviteForm } from "./invite-form";

type Member = {
  membership_id: string;
  display_name: string;
  email: string | null;
  status: string;
  roles: string[];
};
type Role = { id: string; name: string };
type Invite = { id: string; email: string; status: string };

async function fetchJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) return [] as unknown as T;
  return res.json();
}

export default async function StaffPage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.StaffManage)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to staff management.</p>;
  }

  const [members, roles, invites] = await Promise.all([
    fetchJson<Member[]>("/auth/members"),
    fetchJson<Role[]>("/auth/roles"),
    fetchJson<Invite[]>("/auth/invites"),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Staff</h1>
        <p className="mt-1 text-sm text-neutral-400">Invite teammates and manage their roles.</p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-300">Invite staff</h2>
        <InviteForm roles={roles} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-neutral-300">Members</h2>
        <div className="overflow-hidden rounded border border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Roles</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.membership_id} className="border-t border-neutral-800">
                  <td className="px-3 py-2">{m.display_name}</td>
                  <td className="px-3 py-2 text-neutral-400">{m.email ?? "—"}</td>
                  <td className="px-3 py-2">{m.roles.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {invites.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-neutral-300">Pending invites</h2>
          <ul className="text-sm text-neutral-400">
            {invites.map((i) => (
              <li key={i.id}>
                {i.email} — {i.status}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
