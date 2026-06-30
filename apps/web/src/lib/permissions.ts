// Permission string constants mirroring the backend catalog (crates/domain). Used to
// gate navigation and routes. The backend remains the source of truth and enforcer;
// these only drive what the UI shows.
export const Permission = {
  OrgManage: "org.manage",
  StaffManage: "staff.manage",
  RolesManage: "roles.manage",
  BansView: "bans.view",
  PlayersView: "players.view",
  ServersView: "servers.view",
  BillingManage: "billing.manage",
} as const;

export type Perm = (typeof Permission)[keyof typeof Permission];

export function can(permissions: string[], perm: Perm): boolean {
  return permissions.includes(perm);
}
