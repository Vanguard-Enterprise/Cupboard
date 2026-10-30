export type AlertSeverity = "critical" | "warning" | "info";

export type AlertChannel = {
  id: string;
  kind: "discord" | "webhook";
  name: string;
  destination: string;
  createdAt: number;
  lastDeliveryAt: number | null;
  lastDeliveryOk: boolean | null;
  lastError: string | null;
};

export type AlertDelivery = {
  channelId: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  error: string | null;
  completedAt: number | null;
  channelName: string;
};

export type AlertEvent = {
  id: string;
  event: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  createdAt: number;
  deliveries: AlertDelivery[];
};

export type AlertRoutes = Record<string, string[]>;

export type AlertState = {
  revision: number;
  retentionDays: number;
  routes: AlertRoutes;
  channels: AlertChannel[];
  events: AlertEvent[];
};

export const alertGroups: {
  title: string;
  events: {
    key: string;
    title: string;
    description: string;
    severity: AlertSeverity;
  }[];
}[] = [
  {
    title: "Game servers",
    events: [
      {
        key: "server.offline",
        title: "Server offline",
        description:
          "RCON and A2S health checks both fail for a server that was reachable.",
        severity: "critical",
      },
      {
        key: "server.recovered",
        title: "Server back online",
        description: "An offline server passes a health check again.",
        severity: "info",
      },
    ],
  },
  {
    title: "Machines",
    events: [
      {
        key: "machine.offline",
        title: "Machine stopped reporting",
        description:
          "An enrolled agent has not sent a health report for 90 seconds.",
        severity: "critical",
      },
      {
        key: "machine.recovered",
        title: "Machine reporting again",
        description: "The agent on a silent machine sends a report.",
        severity: "info",
      },
    ],
  },
  {
    title: "Pelican",
    events: [
      {
        key: "pelican.failed",
        title: "Pelican check failed",
        description:
          "Cupboard cannot refresh your Pelican server inventory, for example after a key is revoked.",
        severity: "warning",
      },
      {
        key: "pelican.recovered",
        title: "Pelican check recovered",
        description: "A failing Pelican connection refreshes successfully.",
        severity: "info",
      },
    ],
  },
  {
    title: "Members",
    events: [
      {
        key: "member.joined",
        title: "Member joined",
        description: "Someone accepts an invitation to this organization.",
        severity: "info",
      },
      {
        key: "member.removed",
        title: "Member removed",
        description: "An administrator removes an active member.",
        severity: "warning",
      },
    ],
  },
];

export const retentionOptions = [7, 30, 90] as const;

const routeSet = (routes: AlertRoutes, event: string) =>
  new Set(routes[event] ?? []);

/** Drop empty and unknown entries and sort channel IDs for stable comparison. */
export function normalizeRoutes(
  routes: AlertRoutes,
  channelIds: string[],
): AlertRoutes {
  const known = new Set(channelIds);
  const result: AlertRoutes = {};
  for (const group of alertGroups) {
    for (const { key } of group.events) {
      const ids = [...routeSet(routes, key)].filter((id) => known.has(id));
      if (ids.length) result[key] = ids.sort();
    }
  }
  return result;
}

export function sameRoutes(a: AlertRoutes, b: AlertRoutes) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reapply the operator's unsaved additions and removals on top of a newer saved
 * state, so refreshes and channel changes do not discard routing edits.
 */
export function rebaseRoutes(
  previous: AlertRoutes,
  draft: AlertRoutes,
  next: AlertRoutes,
  channelIds: string[],
): AlertRoutes {
  const result: AlertRoutes = {};
  for (const group of alertGroups) {
    for (const { key } of group.events) {
      const before = routeSet(previous, key);
      const edited = routeSet(draft, key);
      const ids = routeSet(next, key);
      for (const id of edited) if (!before.has(id)) ids.add(id);
      for (const id of before) if (!edited.has(id)) ids.delete(id);
      result[key] = [...ids];
    }
  }
  return normalizeRoutes(result, channelIds);
}

export function channelRouteCount(routes: AlertRoutes, channelId: string) {
  return Object.values(routes).filter((ids) => ids.includes(channelId)).length;
}

export function exportFileName(organizationName: string, at: Date) {
  const slug =
    organizationName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "organization";
  return `cupboard-${slug}-${at.toISOString().slice(0, 10)}.json`;
}
