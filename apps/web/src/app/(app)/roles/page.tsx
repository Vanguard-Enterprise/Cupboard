import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { RoleManager, type PermissionOption, type Role } from "./role-manager";

async function fetchJson<T>(path: string): Promise<{ data: T; ok: boolean }> {
  const res = await apiFetch(path);
  if (!res.ok) return { data: [] as unknown as T, ok: false };
  return { data: (await res.json()) as T, ok: true };
}

export default async function RolesPage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.RolesManage)) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Role management unavailable</AlertTitle>
        <AlertDescription>You don&apos;t have access to manage organization roles.</AlertDescription>
      </Alert>
    );
  }

  const [rolesResult, permissionsResult] = await Promise.all([
    fetchJson<Role[]>("/auth/roles"),
    fetchJson<PermissionOption[]>("/auth/permissions"),
  ]);

  if (!rolesResult.ok || !permissionsResult.ok) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Roles couldn&apos;t be loaded</AlertTitle>
        <AlertDescription>Refresh the page to try again. Role management is unavailable until the access catalog is loaded safely.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Roles</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage organization access.</p>
      </header>
      <RoleManager roles={rolesResult.data} permissions={permissionsResult.data} />
    </div>
  );
}
