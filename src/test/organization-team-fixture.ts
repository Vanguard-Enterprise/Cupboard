import {
  permissionDefinitions,
  type OrganizationTeamSettings,
} from "@/lib/organization-team";
const allPermissions = permissionDefinitions.map(({ id }) => id);
export const defaultOrganizationTeam: OrganizationTeamSettings = {
  roles: [
    {
      id: "owner",
      position: 0,
      name: "Owner",
      description: "Full access, including billing, users, and security.",
      permissions: [...allPermissions],
      system: true,
    },
    {
      id: "administrator",
      position: 1,
      name: "Administrator",
      description: "Manage servers, users, integrations, and settings.",
      permissions: [...allPermissions],
      system: true,
    },
    {
      id: "operator",
      position: 2,
      name: "Operator",
      description: "Run servers and handle player moderation.",
      permissions: ["servers.view", "servers.manage", "players.moderate"],
      system: false,
    },
    {
      id: "viewer",
      position: 3,
      name: "Viewer",
      description: "Read server status without changing live systems.",
      permissions: ["servers.view"],
      system: false,
    },
  ],
  users: [
    {
      id: "user-demo-operator",
      name: "Demo operator",
      email: "operator@example.com",
      roleIds: ["owner"],
      status: "active",
      lastActiveAt: "2026-09-17T20:42:00-04:00",
    },
    {
      id: "user-maya-chen",
      name: "Maya Chen",
      email: "maya@example.com",
      roleIds: ["operator"],
      status: "active",
      lastActiveAt: "2026-09-17T18:12:00-04:00",
    },
    {
      id: "user-priya-shah",
      name: "Priya Shah",
      email: "priya@example.com",
      roleIds: ["administrator"],
      status: "active",
      lastActiveAt: "2026-09-16T14:25:00-04:00",
    },
    {
      id: "user-noah-williams",
      name: "Noah Williams",
      email: "noah@example.com",
      roleIds: ["viewer"],
      status: "invited",
      lastActiveAt: null,
    },
    {
      id: "user-lena-ortiz",
      name: "Lena Ortiz",
      email: "lena@example.com",
      roleIds: ["viewer"],
      status: "suspended",
      lastActiveAt: "2026-09-02T09:08:00-04:00",
    },
  ],
};
