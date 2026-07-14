// Permission string constants mirroring the backend catalog (crates/domain). Used to
// gate navigation and routes. The backend remains the source of truth and enforcer;
// these only drive what the UI shows.
export const Permission = {
  OrgManage: "org.manage",
  StaffManage: "staff.manage",
  RolesManage: "roles.manage",
  BansView: "bans.view",
  BansCreate: "bans.create",
  BansRevoke: "bans.revoke",
  PlayersView: "players.view",
  PlayersViewPii: "players.view_pii",
  ServersView: "servers.view",
  ServersManage: "servers.manage",
  StoreManage: "store.manage",
  SitesEdit: "sites.edit",
  BillingManage: "billing.manage",
  IntegrationsManage: "integrations.manage",
  ApiManage: "api.manage",
} as const;

export type Perm = (typeof Permission)[keyof typeof Permission];

export function can(permissions: string[], perm: Perm): boolean {
  return permissions.includes(perm);
}
