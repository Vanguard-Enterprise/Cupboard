export type ComponentKind = "url" | "machine" | "server";
export type ComponentHealth = "operational" | "degraded" | "down" | "unknown";
export type ComponentStatus = ComponentHealth | "maintenance";

export type StatusComponent = {
  id: string;
  name: string;
  kind: ComponentKind;
  sourceId: string;
  sourceName: string | null;
  /** A machine tag id; empty when the target is ungrouped. */
  tagId: string;
  /** The tag's name, resolved by the server. */
  groupName: string;
  public: boolean;
  health: ComponentHealth;
  observedAt: number | null;
  /** The last URL check in words, for operators only. */
  detail: string | null;
};

export type MaintenanceWindow = {
  id: string;
  title: string;
  message: string;
  startsAt: number;
  endsAt: number;
  completedAt: number | null;
  componentIds: string[];
  createdAt: number;
};

export type StatusSource = {
  id: string;
  name: string;
  kind: Exclude<ComponentKind, "url">;
  /** Machine tag ids, used to suggest a group. */
  tags: string[];
};
export type StatusTag = { id: string; name: string };

export type StatusTheme = "dark" | "light";
export type StatusFont =
  | "geist"
  | "inter"
  | "manrope"
  | "ibm-plex-sans"
  | "space-grotesk"
  | "source-serif"
  | "jetbrains-mono";
export type StatusLink = { label: string; url: string };

/** How the public page looks. Saved with the page; the logo uploads separately. */
export type Branding = {
  theme: StatusTheme;
  accentColor: string;
  font: StatusFont;
  links: StatusLink[];
  footerText: string;
  poweredBy: boolean;
};

export const statusFonts: { id: StatusFont; label: string }[] = [
  { id: "geist", label: "Geist" },
  { id: "inter", label: "Inter" },
  { id: "manrope", label: "Manrope" },
  { id: "ibm-plex-sans", label: "IBM Plex Sans" },
  { id: "space-grotesk", label: "Space Grotesk" },
  { id: "source-serif", label: "Source Serif" },
  { id: "jetbrains-mono", label: "JetBrains Mono" },
];

export const accentPresets = [
  "#7cb58d",
  "#4f8fd6",
  "#8b6cd9",
  "#d9658f",
  "#e4572e",
  "#e0a526",
  "#2fa39a",
  "#f3f4f6",
];

export const maxLinks = 3;

export function validColor(value: string) {
  return /^#[0-9a-f]{6}$/.test(value);
}

/** Dark text on light accents and white text on dark ones, by relative luminance. */
export function accentForeground(color: string) {
  if (!validColor(color)) return "#0e0f11";
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Pick whichever of the two text colors contrasts more with the accent.
  return (luminance + 0.05) / 0.0548 >= 1.05 / (luminance + 0.05)
    ? "#0e0f11"
    : "#ffffff";
}

export function publicLogoPath(slug: string, version: number) {
  return `/app-api/public/status/${slug}/logo?v=${version}`;
}

/** The published page as visitors receive it: public targets by display name only. */
export type PublicStatus = Branding & {
  name: string;
  announcement: string;
  supportUrl: string;
  logoVersion: number | null;
  updatedAt: number;
  components: {
    id: string;
    name: string;
    groupName: string;
    health: ComponentHealth;
    observedAt: number | null;
  }[];
  maintenance: MaintenanceWindow[];
};

export type StatusPageState = Branding & {
  revision: number;
  logoVersion: number | null;
  name: string;
  slug: string;
  published: boolean;
  announcement: string;
  supportUrl: string;
  components: StatusComponent[];
  maintenance: MaintenanceWindow[];
  sources: StatusSource[];
  tags: StatusTag[];
};

/** Editable copy of the page. Components keep their ids so maintenance links survive. */
export type ComponentDraft = {
  id: string | null;
  name: string;
  kind: ComponentKind;
  sourceId: string;
  tagId: string;
  public: boolean;
};
export type PageDraft = Branding & {
  name: string;
  slug: string;
  slugEdited: boolean;
  published: boolean;
  announcement: string;
  supportUrl: string;
  components: ComponentDraft[];
};

export type MaintenancePhase = "scheduled" | "active" | "completed";

export const maxComponents = 50;

export function slugify(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "status";
}

export function validSlug(slug: string) {
  return /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(slug);
}

export function publicPath(slug: string) {
  return `/status/${slug}`;
}

export function draftOf(state: StatusPageState): PageDraft {
  return {
    name: state.name,
    slug: state.slug,
    slugEdited: state.revision > 0,
    published: state.published,
    announcement: state.announcement,
    supportUrl: state.supportUrl,
    theme: state.theme,
    accentColor: state.accentColor,
    font: state.font,
    links: state.links.map((link) => ({ ...link })),
    footerText: state.footerText,
    poweredBy: state.poweredBy,
    components: state.components.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      sourceId: c.sourceId,
      tagId: c.tagId,
      public: c.public,
    })),
  };
}

export function sameDraft(a: PageDraft, b: PageDraft) {
  return (
    a.name === b.name &&
    a.slug === b.slug &&
    a.published === b.published &&
    a.announcement === b.announcement &&
    a.supportUrl === b.supportUrl &&
    a.theme === b.theme &&
    a.accentColor === b.accentColor &&
    a.font === b.font &&
    a.footerText === b.footerText &&
    a.poweredBy === b.poweredBy &&
    JSON.stringify(a.links) === JSON.stringify(b.links) &&
    JSON.stringify(a.components) === JSON.stringify(b.components)
  );
}

export function maintenancePhase(
  window: MaintenanceWindow,
  now: number,
): MaintenancePhase {
  if (window.completedAt !== null || window.endsAt <= now) return "completed";
  if (window.startsAt <= now) return "active";
  return "scheduled";
}

export function activeMaintenance(
  maintenance: MaintenanceWindow[],
  now: number,
) {
  return maintenance.filter((w) => maintenancePhase(w, now) === "active");
}

/** The status the public page shows: maintenance overrides live health. */
export function componentStatus(
  component: Pick<StatusComponent, "id" | "health">,
  maintenance: MaintenanceWindow[],
  now: number,
): ComponentStatus {
  const underMaintenance = activeMaintenance(maintenance, now).some(
    (w) => w.componentIds.length === 0 || w.componentIds.includes(component.id),
  );
  return underMaintenance ? "maintenance" : component.health;
}

export const statusLabel: Record<ComponentStatus, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Unavailable",
  unknown: "Unknown",
  maintenance: "Under maintenance",
};

export type OverallStatus = {
  tone: "operational" | "degraded" | "down" | "maintenance" | "unknown";
  title: string;
  detail: string;
};

export function overallStatus(
  components: StatusComponent[],
  maintenance: MaintenanceWindow[],
  now: number,
  publicOnly = false,
): OverallStatus {
  const considered = publicOnly
    ? components.filter((c) => c.public)
    : components;
  if (considered.length === 0)
    return {
      tone: "unknown",
      title: "No targets yet",
      detail: "Add the servers and machines you want to show.",
    };
  const statuses = considered.map((c) => ({
    name: c.name,
    status: componentStatus(c, maintenance, now),
  }));
  const count = (status: ComponentStatus) =>
    statuses.filter((s) => s.status === status).length;
  const down = count("down");
  const degraded = count("degraded");
  const inMaintenance = count("maintenance");
  const unknown = count("unknown");
  const plural = (n: number, noun: string) =>
    `${n} ${noun}${n === 1 ? "" : "s"}`;
  if (down > 0)
    return {
      tone: "down",
      title: `${plural(down, "target")} unavailable`,
      detail: statuses
        .filter((s) => s.status === "down")
        .map((s) => s.name)
        .join(", "),
    };
  if (degraded > 0)
    return {
      tone: "degraded",
      title: `${plural(degraded, "target")} degraded`,
      detail: statuses
        .filter((s) => s.status === "degraded")
        .map((s) => s.name)
        .join(", "),
    };
  if (inMaintenance > 0)
    return {
      tone: "maintenance",
      title: "Maintenance in progress",
      detail: `${plural(inMaintenance, "target")} under maintenance.`,
    };
  if (unknown === considered.length)
    return {
      tone: "unknown",
      title: "Waiting for the first check",
      detail: "Targets show a status after their first health report.",
    };
  return {
    tone: "operational",
    title: "All targets operational",
    detail:
      unknown > 0
        ? `${plural(unknown, "target")} still waiting for a first check.`
        : `${plural(considered.length, "target")} reporting normally.`,
  };
}

export function groupComponents<T extends { groupName: string }>(
  components: T[],
) {
  const groups = new Map<string, T[]>();
  for (const component of components) {
    const list = groups.get(component.groupName) ?? [];
    list.push(component);
    groups.set(component.groupName, list);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
}

export function moveComponent<T>(list: T[], from: number, to: number) {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= list.length ||
    to >= list.length
  )
    return list;
  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

/** A URL target address: http or https with a host. The server checks the rest. */
export function validTargetUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !!url.hostname
    );
  } catch {
    return false;
  }
}

/** Sources that are not yet shown as a component. */
export function unusedSources(
  sources: StatusSource[],
  components: ComponentDraft[],
) {
  const used = new Set(components.map((c) => `${c.kind}:${c.sourceId}`));
  return sources.filter((s) => !used.has(`${s.kind}:${s.id}`));
}

/** Format for a datetime-local input in the browser's zone. */
export function localDateTimeValue(at: number) {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseLocalDateTime(value: string) {
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

export function windowLabel(window: MaintenanceWindow, now: number) {
  const phase = maintenancePhase(window, now);
  const start = new Date(window.startsAt);
  const end = new Date(window.endsAt);
  const sameDay = start.toDateString() === end.toDateString();
  const day = (d: Date) =>
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const range = sameDay
    ? `${day(start)}, ${time(start)} to ${time(end)}`
    : `${day(start)}, ${time(start)} to ${day(end)}, ${time(end)}`;
  return { phase, range };
}

export function affectedNames(
  window: MaintenanceWindow,
  components: Pick<StatusComponent, "id" | "name">[],
) {
  if (window.componentIds.length === 0) return "All targets";
  const names = components
    .filter((c) => window.componentIds.includes(c.id))
    .map((c) => c.name);
  if (names.length === 0) return "Removed targets";
  return names.join(", ");
}
