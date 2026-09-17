import { implementedPages, implementedPageEntries } from "./implemented-pages";

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
            title: implementedPages["connections"].navigationLabel,
          },
          {
            id: "credentials",
            title: implementedPages["credentials"].navigationLabel,
          },
        ],
      },
      {
        title: "Security",
        icon: "security",
        sections: [
          {
            id: "security-alerts",
            title: implementedPages["security-alerts"].navigationLabel,
          },
          {
            id: "audit-log",
            title: implementedPages["audit-log"].navigationLabel,
          },
          {
            id: "access",
            title: implementedPages["access"].navigationLabel,
          },
        ],
      },
      {
        title: "Settings",
        icon: "settings",
        sections: [
          {
            id: "organization",
            title: implementedPages["organization"].navigationLabel,
          },
          {
            id: "billing",
            title: implementedPages["billing"].navigationLabel,
          },
          {
            id: "preferences",
            title: implementedPages["preferences"].navigationLabel,
          },
        ],
      },
    ],
  },
];

export function navigationHref(id: string): string | undefined {
  return implementedPageEntries.find(
    ([key, page]) => key === id && page.kind === "organization",
  )?.[1].href;
}
