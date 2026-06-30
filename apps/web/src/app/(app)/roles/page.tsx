import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";

type Role = { id: string; name: string; immutable: boolean; permissions: string[] };

export default async function RolesPage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.RolesManage)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to role management.</p>;
  }

  const res = await apiFetch("/auth/roles");
  const roles: Role[] = res.ok ? await res.json() : [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Roles</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Default templates plus any custom roles. The Owner role is immutable.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {roles.map((r) => (
          <section key={r.id} className="rounded border border-neutral-800 p-4">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="font-medium">{r.name}</h2>
              {r.immutable && (
                <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                  immutable
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {r.permissions.map((p) => (
                <span
                  key={p}
                  className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs text-neutral-300"
                >
                  {p}
                </span>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
