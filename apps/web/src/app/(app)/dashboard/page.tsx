import { getSession } from "@/lib/api";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) return null; // layout already redirects

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Welcome, {session.user.display_name}</h1>
        <p className="mt-1 text-sm text-neutral-400">
          You have {session.permissions.length} permission
          {session.permissions.length === 1 ? "" : "s"} in this organization.
        </p>
      </div>
      <section className="rounded border border-neutral-800 p-4">
        <h2 className="mb-2 text-sm font-medium text-neutral-300">Your permissions</h2>
        <div className="flex flex-wrap gap-2">
          {session.permissions.length === 0 && (
            <span className="text-sm text-neutral-500">No permissions in this org.</span>
          )}
          {session.permissions.map((p) => (
            <span
              key={p}
              className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs text-neutral-300"
            >
              {p}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
