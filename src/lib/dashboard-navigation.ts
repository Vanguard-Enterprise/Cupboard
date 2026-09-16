export const dashboardNavigation = [
  {
    title: "Operations",
    items: [
      {
        title: "Game servers",
        icon: "servers",
        sections: [
          {
            id: "servers",
            title: "Server inventory",
          },
          {
            id: "server-lifecycle",
            title: "Lifecycle & wipes",
          },
          {
            id: "server-files",
            title: "Files & plugins",
          },
        ],
      },
      {
        title: "Infrastructure",
        icon: "infrastructure",
        sections: [
          {
            id: "nodes",
            title: "Machines & nodes",
          },
          {
            id: "maintenance",
            title: "Maintenance",
          },
          {
            id: "backups",
            title: "Backups & recovery",
          },
        ],
      },
      {
        title: "Observability",
        icon: "metrics",
        sections: [
          {
            id: "health",
            title: "Health & uptime",
          },
          {
            id: "performance",
            title: "Performance",
          },
          {
            id: "analytics",
            title: "Trends & reports",
          },
          {
            id: "alerts",
            title: "Alerts & incidents",
          },
        ],
      },
      {
        title: "File store",
        icon: "files",
        sections: [
          {
            id: "file-library",
            title: "Shared library",
          },
          {
            id: "file-access",
            title: "Versions & access",
          },
        ],
      },
    ],
  },
  {
    title: "Community",
    items: [
      {
        title: "Players",
        icon: "players",
        sections: [
          {
            id: "players",
            title: "Player profiles",
          },
          {
            id: "player-groups",
            title: "Groups & permissions",
          },
        ],
      },
      {
        title: "Moderation",
        icon: "moderation",
        sections: [
          {
            id: "reports",
            title: "Reports & cases",
          },
          {
            id: "sanctions",
            title: "Bans & sanctions",
          },
          {
            id: "appeals",
            title: "Appeals",
          },
        ],
      },
      {
        title: "Support",
        icon: "support",
        sections: [
          {
            id: "tickets",
            title: "Tickets",
          },
          {
            id: "knowledge-base",
            title: "Knowledge base",
          },
        ],
      },
      {
        title: "Store",
        icon: "store",
        sections: [
          {
            id: "catalog",
            title: "Products & offers",
          },
          {
            id: "orders",
            title: "Orders & fulfillment",
          },
          {
            id: "revenue",
            title: "Sales reports",
          },
        ],
      },
      {
        title: "Discord",
        icon: "discord",
        sections: [
          {
            id: "discord-connections",
            title: "Guilds & roles",
          },
          {
            id: "discord-automation",
            title: "Messages & automation",
          },
        ],
      },
    ],
  },
  {
    title: "Organization",
    items: [
      {
        title: "Members & teams",
        icon: "members",
        sections: [
          {
            id: "members",
            title: "Members & invitations",
          },
          {
            id: "teams",
            title: "Teams & roles",
          },
        ],
      },
      {
        title: "Projects",
        icon: "projects",
        sections: [
          {
            id: "projects",
            title: "Projects & tasks",
          },
          {
            id: "calendar",
            title: "Calendar",
          },
        ],
      },
      {
        title: "Integrations",
        icon: "integrations",
        sections: [
          {
            id: "connections",
            title: "Connections",
          },
          {
            id: "credentials",
            title: "Credentials & webhooks",
          },
        ],
      },
      {
        title: "Security",
        icon: "security",
        sections: [
          {
            id: "security-alerts",
            title: "Security alerts",
          },
          {
            id: "audit-log",
            title: "Audit log",
          },
          {
            id: "access",
            title: "Access & approvals",
          },
        ],
      },
      {
        title: "Settings",
        icon: "settings",
        sections: [
          {
            id: "organization",
            title: "Organization profile",
          },
          {
            id: "billing",
            title: "Billing & usage",
          },
          {
            id: "preferences",
            title: "Notifications & data",
          },
        ],
      },
    ],
  },
];

export const profilePath = "/dashboard/organization/settings/profile";
export const usagePath = "/dashboard/organization/settings/usage";
export const credentialsPath =
  "/dashboard/organization/integrations/credentials";
export const connectionsPath =
  "/dashboard/organization/integrations/connections";
export const notificationsDataPath =
  "/dashboard/organization/settings/notifications-data";

export function navigationHref(id: string): string | undefined {
  if (id === "connections") return connectionsPath;
  if (id === "organization") return profilePath;
  if (id === "billing") return usagePath;
  if (id === "credentials") return credentialsPath;
  if (id === "preferences") return notificationsDataPath;
  return undefined;
}
