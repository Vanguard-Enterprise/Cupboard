import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, listOrgs } from "@/lib/api";
import { logoutAction } from "@/lib/actions";
import { can, Permission } from "@/lib/permissions";
import { TenantSwitcher } from "./tenant-switcher";

// Protected shell. Requires a session; routes the user to onboarding when they have no
// active org. Nav links are RBAC-gated (the backend also enforces every action).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.org) redirect("/onboarding");
  const orgs = await listOrgs();
  const perms = session.permissions;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 flex-col gap-4 border-r border-neutral-800 p-4">
        <div className="text-lg font-semibold">Cupboard</div>
        <TenantSwitcher orgs={orgs} current={session.org} />
        <nav className="flex flex-col gap-1 text-sm">
          <Link href="/dashboard" className="rounded px-2 py-1 hover:bg-neutral-900">
            Dashboard
          </Link>
          {can(perms, Permission.ServersView) && (
            <Link href="/servers" className="rounded px-2 py-1 hover:bg-neutral-900">
              Servers
            </Link>
          )}
          {can(perms, Permission.StaffManage) && (
            <Link href="/staff" className="rounded px-2 py-1 hover:bg-neutral-900">
              Staff
            </Link>
          )}
          {can(perms, Permission.RolesManage) && (
            <Link href="/roles" className="rounded px-2 py-1 hover:bg-neutral-900">
              Roles
            </Link>
          )}
        </nav>
        <form action={logoutAction} className="mt-auto">
          <button className="text-sm text-neutral-400 hover:text-neutral-100">Sign out</button>
        </form>
        <div className="truncate text-xs text-neutral-500" title={session.user.email ?? ""}>
          {session.user.display_name}
        </div>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
