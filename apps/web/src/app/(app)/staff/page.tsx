import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { MembersTable, type StaffMember } from "./members-table";
import { type PendingInvite } from "./pending-invites-dialog";

type Role = { id: string; name: string };

type LoadResult<T> = { data: T; ok: boolean };

async function fetchJson<T>(path: string): Promise<LoadResult<T>> {
  const res = await apiFetch(path);
  if (!res.ok) return { data: [] as unknown as T, ok: false };
  return { data: await res.json(), ok: true };
}

export default async function StaffPage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.StaffManage)) {
    return (
      <Alert variant="destructive">
        <AlertDescription>You don&apos;t have access to staff management.</AlertDescription>
      </Alert>
    );
  }

  const [membersResult, rolesResult, invitesResult] = await Promise.all([
    fetchJson<StaffMember[]>("/auth/members"),
    fetchJson<Role[]>("/auth/roles"),
    fetchJson<PendingInvite[]>("/auth/invites"),
  ]);
  const loadError = !membersResult.ok || !rolesResult.ok || !invitesResult.ok;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary/80">Administration / Access</p>
        <h1 className="text-3xl font-semibold tracking-tight">Members</h1>
        <p className="text-muted-foreground">
          Invite teammates, assign roles, and control organization access.
        </p>
      </header>

      {loadError ? (
        <Alert variant="destructive">
          <AlertTitle>Some member data couldn&apos;t be loaded</AlertTitle>
          <AlertDescription>
            Refresh the page to try again. Member management is unavailable until all data loads safely.
          </AlertDescription>
        </Alert>
      ) : (
        <MembersTable
          members={membersResult.data}
          roles={rolesResult.data}
          invites={invitesResult.data}
        />
      )}
    </div>
  );
}
