export const organizationTeamKey =
  "cupboard:organization:local-preview:team:v1";
export const organizationTeamChangedEvent = "cupboard-team-saved";

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
};

export type OrganizationUser = {
  id: string;
  name: string;
  email: string;
  roleId: string;
  status: OrganizationUserStatus;
  lastActiveAt: string | null;
};

export type OrganizationTeamSettings = {
  users: OrganizationUser[];
  roles: OrganizationRole[];
};

const allPermissions = permissionDefinitions.map(({ id }) => id);

export const defaultOrganizationTeam: OrganizationTeamSettings = {
  roles: [
    {
      id: "owner",
      name: "Owner",
      description: "Full access, including billing, users, and security.",
      permissions: [...allPermissions],
      system: true,
    },
    {
      id: "administrator",
      name: "Administrator",
      description: "Manage servers, users, integrations, and settings.",
      permissions: allPermissions.filter(
        (permission) => permission !== "billing.manage",
      ),
      system: true,
    },
    {
      id: "operator",
      name: "Operator",
      description: "Run servers and handle player moderation.",
      permissions: ["servers.view", "servers.manage", "players.moderate"],
      system: true,
    },
    {
      id: "viewer",
      name: "Viewer",
      description: "Read server status without changing live systems.",
      permissions: ["servers.view"],
      system: true,
    },
  ],
  users: [
    {
      id: "user-demo-operator",
      name: "Demo operator",
      email: "operator@example.com",
      roleId: "owner",
      status: "active",
      lastActiveAt: "2026-09-17T20:42:00-04:00",
    },
    {
      id: "user-maya-chen",
      name: "Maya Chen",
      email: "maya@example.com",
      roleId: "operator",
      status: "active",
      lastActiveAt: "2026-09-17T18:12:00-04:00",
    },
    {
      id: "user-priya-shah",
      name: "Priya Shah",
      email: "priya@example.com",
      roleId: "administrator",
      status: "active",
      lastActiveAt: "2026-09-16T14:25:00-04:00",
    },
    {
      id: "user-noah-williams",
      name: "Noah Williams",
      email: "noah@example.com",
      roleId: "viewer",
      status: "invited",
      lastActiveAt: null,
    },
    {
      id: "user-lena-ortiz",
      name: "Lena Ortiz",
      email: "lena@example.com",
      roleId: "viewer",
      status: "suspended",
      lastActiveAt: "2026-09-02T09:08:00-04:00",
    },
  ],
};

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
      typeof candidate.roleId !== "string" ||
      !roleIds.has(candidate.roleId) ||
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
      roleId: candidate.roleId,
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
