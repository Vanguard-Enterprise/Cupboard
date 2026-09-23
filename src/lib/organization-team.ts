export const permissionDefinitions = [
  {
    id: "servers.view",
    label: "View servers",
    description: "See server status, configuration, and activity.",
    group: "Servers",
  },
  {
    id: "servers.manage",
    label: "Manage servers",
    description: "Change configuration and run server actions.",
    group: "Servers",
  },
  {
    id: "players.moderate",
    label: "Moderate players",
    description: "Review reports and apply moderation actions.",
    group: "Community",
  },
  {
    id: "integrations.manage",
    label: "Manage integrations",
    description: "Connect services and manage credentials.",
    group: "Organization",
  },
  {
    id: "billing.manage",
    label: "Manage billing",
    description: "Change plans, payment methods, and billing contacts.",
    group: "Organization",
  },
  {
    id: "organization.manage",
    label: "Manage organization",
    description: "Manage users, roles, security, and organization settings.",
    group: "Organization",
  },
] as const;

export type PermissionId = (typeof permissionDefinitions)[number]["id"];
export type OrganizationUserStatus = "active" | "invited" | "suspended";

export type OrganizationRole = {
  id: string;
  name: string;
  description: string;
  permissions: PermissionId[];
  system: boolean;
  position: number;
};

export type OrganizationUser = {
  id: string;
  name: string;
  email: string;
  roleIds: string[];
  status: OrganizationUserStatus;
  lastActiveAt: string | null;
};

export type OrganizationTeamSettings = {
  users: OrganizationUser[];
  roles: OrganizationRole[];
};

const allPermissions = permissionDefinitions.map(({ id }) => id);

const permissionIds = new Set<PermissionId>(allPermissions);
const statuses = new Set<OrganizationUserStatus>([
  "active",
  "invited",
  "suspended",
]);

export function parseOrganizationTeam(raw: string): OrganizationTeamSettings {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid team");
  const settings = value as Record<string, unknown>;
  if (!Array.isArray(settings.roles) || !Array.isArray(settings.users))
    throw new Error("Invalid team");

  const roles = settings.roles.map((role): OrganizationRole => {
    if (!role || typeof role !== "object") throw new Error("Invalid role");
    const candidate = role as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      !candidate.id ||
      typeof candidate.name !== "string" ||
      !candidate.name.trim() ||
      typeof candidate.description !== "string" ||
      typeof candidate.system !== "boolean" ||
      !Number.isInteger(candidate.position) ||
      (candidate.position as number) < 0 ||
      !Array.isArray(candidate.permissions) ||
      candidate.permissions.some(
        (permission) =>
          typeof permission !== "string" ||
          !permissionIds.has(permission as PermissionId),
      )
    )
      throw new Error("Invalid role");
    return {
      id: candidate.id,
      name: candidate.name.trim(),
      description: candidate.description.trim(),
      system: candidate.system,
      position: candidate.position as number,
      permissions: [...new Set(candidate.permissions as PermissionId[])],
    };
  });

  if (
    !roles.length ||
    new Set(roles.map(({ id }) => id)).size !== roles.length ||
    new Set(roles.map(({ name }) => name.toLowerCase())).size !== roles.length
  )
    throw new Error("Invalid roles");

  const roleIds = new Set(roles.map(({ id }) => id));
  const users = settings.users.map((user): OrganizationUser => {
    if (!user || typeof user !== "object") throw new Error("Invalid user");
    const candidate = user as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      !candidate.id ||
      typeof candidate.name !== "string" ||
      !candidate.name.trim() ||
      typeof candidate.email !== "string" ||
      !candidate.email.includes("@") ||
      !Array.isArray(candidate.roleIds) ||
      !candidate.roleIds.length ||
      new Set(candidate.roleIds).size !== candidate.roleIds.length ||
      candidate.roleIds.some(
        (id) => typeof id !== "string" || !roleIds.has(id),
      ) ||
      typeof candidate.status !== "string" ||
      !statuses.has(candidate.status as OrganizationUserStatus) ||
      !(
        candidate.lastActiveAt === null ||
        (typeof candidate.lastActiveAt === "string" &&
          Number.isFinite(Date.parse(candidate.lastActiveAt)))
      )
    )
      throw new Error("Invalid user");
    return {
      id: candidate.id,
      name: candidate.name.trim(),
      email: candidate.email.trim().toLowerCase(),
      roleIds: candidate.roleIds as string[],
      status: candidate.status as OrganizationUserStatus,
      lastActiveAt: candidate.lastActiveAt as string | null,
    };
  });

  if (
    new Set(users.map(({ id }) => id)).size !== users.length ||
    new Set(users.map(({ email }) => email)).size !== users.length
  )
    throw new Error("Invalid users");

  return { roles, users };
}

export function roleAuthority(
  settings: OrganizationTeamSettings,
  memberId: string,
) {
  const member = settings.users.find((user) => user.id === memberId);
  const assigned = settings.roles.filter((role) =>
    member?.roleIds.includes(role.id),
  );
  const owner = assigned.some((role) => role.id === "owner");
  const position = Math.min(...assigned.map((role) => role.position));
  const permissions = new Set(assigned.flatMap((role) => role.permissions));
  return {
    position,
    canGrant: (role: OrganizationRole) =>
      role.id !== "owner" &&
      (owner ||
        (role.position > position &&
          role.permissions.every((permission) => permissions.has(permission)))),
    canManageUser: (user: OrganizationUser) =>
      user.id !== memberId &&
      user.roleIds.every((id) => {
        const role = settings.roles.find((candidate) => candidate.id === id);
        return Boolean(
          role && role.id !== "owner" && (owner || role.position > position),
        );
      }),
  };
}
