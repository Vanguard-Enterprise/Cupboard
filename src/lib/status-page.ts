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

export type StatusTheme = "dark" | "light" | "system";
export type StatusFont =
  | "geist"
  | "inter"
  | "manrope"
  | "ibm-plex-sans"
  | "space-grotesk"
  | "source-serif"
  | "jetbrains-mono";
export type StatusLink = { label: string; url: string };

export const logoAligns = ["left", "center", "right"] as const;
export type LogoAlign = (typeof logoAligns)[number];
export const logoSizes = ["small", "medium", "large"] as const;
export type LogoSize = (typeof logoSizes)[number];

/** How the public page looks. Saved with the page; the logo uploads separately. */
export type Branding = {
  theme: StatusTheme;
  accentColor: string;
  font: StatusFont;
  links: StatusLink[];
  footerText: string;
  poweredBy: boolean;
  /** The top bar's title; empty shows the page name. */
  headerTitle: string;
  /** When false and a logo exists, the logo stands in for the title. */
  showName: boolean;
  /** Where the logo and title sit in the top bar. */
  logoAlign: LogoAlign;
  /** How large the logo is when it stands in for the title. */
  logoSize: LogoSize;
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

/** Accent button text: always at least 4.5:1 against the accent. */
export const minimumAccentText = 4.5;

/**
 * Text color for an accent fill. Cupboard's near-black wins on light accents
 * and white on dark ones; in the narrow mid range where neither reaches
 * 4.5:1, pure black does (black or white reaches at least 4.58:1 on any
 * color).
 */
export function accentForeground(color: string) {
  if (!validColor(color)) return "#0e0f11";
  for (const text of ["#0e0f11", "#ffffff"])
    if (contrastRatio(color, text) >= minimumAccentText) {
      // Prefer whichever reaches 4.5:1 with more room.
      const other = text === "#ffffff" ? "#0e0f11" : "#ffffff";
      return contrastRatio(color, other) > contrastRatio(color, text)
        ? other
        : text;
    }
  return "#000000";
}

/** Contrast of the accent button's text against its fill. */
export function accentTextContrast(color: string) {
  return validColor(color) ? contrastRatio(color, accentForeground(color)) : 0;
}

/** WCAG relative luminance of a #rrggbb color. */
function luminance(color: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colors. */
export function contrastRatio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` mixed toward `b` by `amount` (0 to 1), in sRGB. */
function mixColor(a: string, b: string, amount: number) {
  return `#${[1, 3, 5]
    .map((i) => {
      const from = parseInt(a.slice(i, i + 2), 16);
      const to = parseInt(b.slice(i, i + 2), 16);
      return Math.round(from + (to - from) * amount)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

/** Page backgrounds of the dark and light status themes (see globals.css). */
export const statusBackgrounds = { dark: "#0e0f11", light: "#f6f7f8" };

/** An accent fill needs an edge under this contrast with the page (1.4.11). */
const minimumEdge = 3;

/**
 * The edge an accent-filled control needs on one page background: a deeper
 * (light page) or lighter (dark page) shade of the accent itself, the first
 * that holds 3:1 against the page, so the edge reads as part of the button.
 * Null when the fill already holds 3:1.
 */
export function accentEdge(accent: string, background: string) {
  if (!validColor(accent) || contrastRatio(accent, background) >= minimumEdge)
    return null;
  const toward =
    contrastRatio(background, "#000000") > contrastRatio(background, "#ffffff")
      ? "#000000"
      : "#ffffff";
  for (let step = 1; step <= 20; step++) {
    const edge = mixColor(accent, toward, step / 20);
    if (contrastRatio(edge, background) >= minimumEdge) return edge;
  }
  return toward;
}

/**
 * The accent button's edge in each scheme the visitor can get: Dark pages
 * use only `dark`, Light only `light`, System both.
 */
export function accentEdges(accent: string, theme: StatusTheme) {
  return {
    light:
      theme === "dark" ? null : accentEdge(accent, statusBackgrounds.light),
    dark: theme === "light" ? null : accentEdge(accent, statusBackgrounds.dark),
  };
}

export function publicLogoPath(slug: string, version: number) {
  return `/app-api/public/status/${slug}/logo?v=${version}`;
}

export const announcementIcons = [
  "megaphone",
  "info",
  "alert",
  "wrench",
  "calendar",
  "sparkles",
] as const;
export type AnnouncementIcon = (typeof announcementIcons)[number];
export const announcementTones = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
] as const;
export type AnnouncementTone = (typeof announcementTones)[number];
/** The title the public page's top bar shows. */
export function headerTitleOf(page: { name: string; headerTitle: string }) {
  return page.headerTitle.trim() || page.name;
}

/** The announcement's glyph and color. They go live with the announcement. */
export type AnnouncementStyle = {
  announcementIcon: AnnouncementIcon;
  announcementTone: AnnouncementTone;
};

/** The published page as visitors receive it: public targets by display name only. */
export type PublicStatus = Branding &
  AnnouncementStyle & {
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

export type StatusPageState = Branding &
  AnnouncementStyle & {
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
    showName: state.showName,
    headerTitle: state.headerTitle,
    logoAlign: state.logoAlign,
    logoSize: state.logoSize,
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
    a.showName === b.showName &&
    a.headerTitle === b.headerTitle &&
    a.logoAlign === b.logoAlign &&
    a.logoSize === b.logoSize &&
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
  // Never call the page operational while some targets have not reported.
  if (unknown > 0)
    return {
      tone: "unknown",
      title: `${considered.length - unknown} of ${plural(considered.length, "target")} operational`,
      detail: `${plural(unknown, "target")} still waiting for a first check.`,
    };
  return {
    tone: "operational",
    title: "All targets operational",
    detail: `${plural(considered.length, "target")} reporting normally.`,
  };
}

/** "A", "A and B", "A, B, and C", or "A, B, and 2 more". */
export function nameList(names: string[], max = 3) {
  if (names.length <= max) {
    if (names.length <= 2) return names.join(" and ");
    return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max - 1).join(", ")}, and ${names.length - max + 1} more`;
}

type PublicTarget = Pick<StatusComponent, "id" | "name" | "health"> & {
  observedAt?: number | null;
};

/** Text with times marked, so a page can render each time as `<time>`. */
export type SummaryPart = string | { at: number; text: string };

/**
 * The public hero in player language: the worst state names its services,
 * every other problem state is named in the detail, and the page is only
 * "online" when every service has reported and is operational. The admin's
 * "What players see" card renders the same strings.
 */
export type PublicSummary = {
  tone: OverallStatus["tone"];
  title: string;
  /** Sentences after the title, in reading order, as plain text. */
  details: string[];
  /** The same sentences with their times marked. */
  detailParts: SummaryPart[][];
  /** `details` joined: the hero's detail line word for word. */
  detail: string;
  /**
   * The one detail line players act on, shown under the title: when the
   * services under maintenance are back, the last known state while stale,
   * or "Check back soon" on an empty page. It is always `detailParts[0]`
   * without its full stop. The other lines repeat what the services list
   * shows, so the public page keeps them for screen readers only.
   */
  answer: SummaryPart[] | null;
  /** When the services under maintenance are planned to be back. */
  backBy: number | null;
  /** Online counts operational and degraded services: both can be joined. */
  counts: Record<ComponentStatus, number> & { total: number; online: number };
  /** "3 of 5 online", or "1 of 2 online, 1 under maintenance". */
  countText: string;
};

export type SummaryOptions = {
  /** Fixed zone and locale for the times, as in server-rendered HTML. */
  format?: TimeFormat;
  /** The last refresh failed: lead with that and keep the last known state. */
  stale?: boolean;
  /** False for the admin card of an unpublished page. */
  published?: boolean;
};

/** One counting rule for the hero, the Services heading, and group roll-ups. */
export function onlineCount(statuses: ComponentStatus[]) {
  const online = statuses.filter(
    (s) => s === "operational" || s === "degraded",
  ).length;
  const maintenance = statuses.filter((s) => s === "maintenance").length;
  return {
    online,
    maintenance,
    text: `${online} of ${statuses.length} online${maintenance > 0 ? `, ${maintenance} under maintenance` : ""}`,
  };
}

/** A time with its day only when it is not today: "7:15 PM UTC" or "Sat, Nov 7, 7:15 PM UTC". */
export function atText(at: number, now: number, format: TimeFormat = {}) {
  const parts = timeParts(at, now, format);
  const today = timeParts(now, now, format).dayKey;
  return `${parts.dayKey === today ? "" : `${parts.day}, `}${parts.time} ${parts.zone}`;
}

export function publicSummary(
  components: PublicTarget[],
  maintenance: MaintenanceWindow[],
  now: number,
  options: SummaryOptions = {},
): PublicSummary {
  const live = liveSummary(components, maintenance, now, options.format);
  if (options.published === false)
    return withLead(live, "unknown", "Players see a not-found page", [
      `When published: ${live.title}.`,
    ]);
  if (options.stale)
    return withLead(live, "unknown", "Status may be out of date", [
      `Last known: ${live.title}.`,
    ]);
  return live;
}

/** A summary whose title is replaced, with the live state kept in the detail. */
function withLead(
  live: PublicSummary,
  tone: PublicSummary["tone"],
  title: string,
  lead: string[],
): PublicSummary {
  const details = [...lead, ...live.details];
  return {
    ...live,
    tone,
    title,
    details,
    detailParts: [...lead.map((line) => [line]), ...live.detailParts],
    detail: details.join(" "),
    answer: answerLine([lead[0]]),
  };
}

/**
 * The answer line as the hero shows it: without its full stop, like the
 * Updated line under it (claude P-35). The details keep theirs, since screen
 * readers hear them as sentences.
 */
function answerLine(line: SummaryPart[]): SummaryPart[] {
  const last = line[line.length - 1];
  if (typeof last !== "string" || !last.endsWith(".")) return line;
  const trimmed = last.slice(0, -1);
  return trimmed ? [...line.slice(0, -1), trimmed] : line.slice(0, -1);
}

function liveSummary(
  components: PublicTarget[],
  maintenance: MaintenanceWindow[],
  now: number,
  format: TimeFormat = {},
): PublicSummary {
  const statuses = components.map((c) => ({
    ...c,
    status: componentStatus(c, maintenance, now),
  }));
  const of = (status: ComponentStatus) =>
    statuses.filter((s) => s.status === status);
  const names = (status: ComponentStatus) => of(status).map((s) => s.name);
  const count = onlineCount(statuses.map((s) => s.status));
  const counts = {
    operational: of("operational").length,
    degraded: of("degraded").length,
    down: of("down").length,
    maintenance: of("maintenance").length,
    unknown: of("unknown").length,
    total: statuses.length,
    online: count.online,
  };
  const underMaintenance = of("maintenance");
  const ends = activeMaintenance(maintenance, now)
    .filter(
      (w) =>
        w.componentIds.length === 0 ||
        underMaintenance.some((s) => w.componentIds.includes(s.id)),
    )
    .map((w) => w.endsAt);
  const backBy = ends.length > 0 ? Math.max(...ends) : null;
  // Windows ending at different times: the one end the summary names is the
  // last, and it says so (claude P-32). Each window shows its own end and
  // countdown under the hero, so the hero gives no countdown of its own: it
  // would repeat the last row word for word (claude P-37).
  const staggered = new Set(ends).size > 1;
  const build = (
    tone: PublicSummary["tone"],
    title: string,
    detailParts: SummaryPart[][],
    answered = false,
  ): PublicSummary => {
    const details = detailParts.map((line) =>
      line
        .map((part) => (typeof part === "string" ? part : part.text))
        .join(""),
    );
    return {
      tone,
      title,
      details,
      detailParts,
      detail: details.join(" "),
      answer: answered ? answerLine(detailParts[0]) : null,
      backBy: tone === "operational" ? null : backBy,
      counts,
      countText: count.text,
    };
  };
  if (counts.total === 0)
    return build(
      "unknown",
      "No services listed yet",
      [["Check back soon."]],
      true,
    );

  // "A is", "A and B are", or "4 services are": verbs agree with the subject.
  const sentence = (list: string[], one: string, many: string) => {
    if (list.length > 3) return `${list.length} services ${many}`;
    return `${nameList(list)} ${list.length === 1 ? one : many}`;
  };
  const neverReported = of("unknown").every((s) => s.observedAt == null);
  const unknownWords = neverReported
    ? (["hasn't reported yet", "haven't reported yet"] as const)
    : (["hasn't reported recently", "haven't reported recently"] as const);
  const words: Record<
    Exclude<ComponentStatus, "operational">,
    [string, string]
  > = {
    down: ["is unavailable", "are unavailable"],
    degraded: ["is degraded", "are degraded"],
    maintenance: ["is under maintenance", "are under maintenance"],
    unknown: [...unknownWords],
  };
  const order = ["down", "degraded", "maintenance", "unknown"] as const;
  const present = order.filter((status) => counts[status] > 0);
  if (present.length === 0)
    return build(
      "operational",
      counts.total === 1
        ? `${statuses[0].name} is online`
        : "All services are online",
      [],
    );
  if (counts.unknown === counts.total)
    return neverReported
      ? build("unknown", "Status not reported yet", [
          ["Services show their status after their first check."],
        ])
      : build("unknown", "Services haven't reported recently", [
          [
            "Their last status is too old to show. This page updates when they report again.",
          ],
        ]);
  const [worst, ...rest] = present;
  const say = (status: (typeof order)[number]) =>
    sentence(names(status), ...words[status]);
  const back: SummaryPart | null =
    backBy === null ? null : { at: backBy, text: atText(backBy, now, format) };
  const lines: SummaryPart[][] = [];
  // Under maintenance, the end belongs to its subject: in the title's detail
  // when maintenance is the headline, inside its own sentence otherwise.
  if (worst === "maintenance" && back)
    lines.push(
      staggered
        ? ["All back by ", back, "."]
        : ["Back by ", back, ` (${relativeTime(backBy!, now)}).`],
    );
  for (const status of rest)
    lines.push(
      status === "maintenance" && back
        ? staggered
          ? [`${say(status)}, all back by `, back, ", some sooner."]
          : [`${say(status)} until `, back, "."]
        : [`${say(status)}.`],
    );
  if (counts.operational > 0) lines.push(["Everything else is online."]);
  return build(worst, say(worst), lines, worst === "maintenance" && !!back);
}

/** The browser tab title, the same on the server and after each refresh. */
export function statusTabTitle(
  name: string,
  tone: OverallStatus["tone"],
  stale = false,
) {
  const state = stale
    ? "Out of date"
    : tone === "down"
      ? "Unavailable"
      : tone === "degraded"
        ? "Degraded"
        : tone === "maintenance"
          ? "Maintenance"
          : "";
  return [state, name, "Status"].filter(Boolean).join(" | ");
}

/** What a screen reader should hear about: states and phases, never clocks. */
export type StatusSnapshot = {
  stale: boolean;
  /** The live headline, which never contains a time. */
  headline: string;
  services: { id: string; name: string; status: ComponentStatus }[];
  windows: { id: string; title: string; phase: MaintenancePhase }[];
};

export function statusSnapshot(
  components: PublicTarget[],
  maintenance: MaintenanceWindow[],
  now: number,
  stale = false,
): StatusSnapshot {
  return {
    stale,
    headline: liveSummary(components, maintenance, now).title,
    services: components.map((c) => ({
      id: c.id,
      name: c.name,
      status: componentStatus(c, maintenance, now),
    })),
    windows: maintenance.map((w) => ({
      id: w.id,
      title: w.title,
      phase: maintenancePhase(w, now),
    })),
  };
}

const nowWords: Record<ComponentStatus, string> = {
  operational: "is back online",
  degraded: "is now degraded",
  down: "is now unavailable",
  maintenance: "is now under maintenance",
  unknown: "hasn't reported recently",
};

/**
 * One short message for the live region describing what changed between two
 * snapshots, or null when nothing a visitor cares about changed.
 */
export function statusAnnouncement(
  previous: StatusSnapshot,
  next: StatusSnapshot,
): string | null {
  const lines: string[] = [];
  if (next.stale && !previous.stale)
    return "Couldn't refresh. Status may be out of date.";
  if (!next.stale && previous.stale) lines.push("Status refreshed.");
  const before = new Map(previous.windows.map((w) => [w.id, w.phase]));
  for (const w of next.windows) {
    const was = before.get(w.id);
    if (was === w.phase) continue;
    if (w.phase === "active") lines.push(`Maintenance started: ${w.title}.`);
    else if (w.phase === "completed" && was === "active")
      lines.push(`Maintenance ended: ${w.title}.`);
    else if (w.phase === "scheduled" && was === undefined)
      lines.push(`Maintenance planned: ${w.title}.`);
  }
  const was = new Map(previous.services.map((s) => [s.id, s.status]));
  const changed = next.services.filter((s) => {
    const status = was.get(s.id);
    return status !== undefined && status !== s.status;
  });
  if (changed.length > 3)
    lines.push(
      `${changed.length} services changed status. Now: ${next.headline}.`,
    );
  else
    for (const s of changed)
      lines.push(
        // A first report is news, not a recovery.
        was.get(s.id) === "unknown" && s.status === "operational"
          ? `${s.name} is online.`
          : `${s.name} ${nowWords[s.status]}.`,
      );
  // Services added or removed can still change the headline.
  if (lines.length === 0 && next.headline !== previous.headline)
    lines.push(`Now: ${next.headline}.`);
  return lines.length > 0 ? lines.join(" ") : null;
}

/** Windows that ended this long ago drop off the public page. */
export const recentMaintenanceMs = 7 * 24 * 60 * 60 * 1000;

/** When a window actually ended or will end: completing early moves the end. */
export function windowEnd(window: MaintenanceWindow) {
  return window.completedAt === null
    ? window.endsAt
    : Math.min(window.endsAt, window.completedAt);
}

/**
 * The maintenance visitors may see, matching the public endpoint: open,
 * upcoming, or ended within a week, touching at least one public target (or
 * every target), with hidden target ids removed.
 */
export function publicMaintenance(
  maintenance: MaintenanceWindow[],
  publicIds: string[],
  now: number,
) {
  const visible = new Set(publicIds);
  return maintenance.flatMap((w) => {
    if (windowEnd(w) < now - recentMaintenanceMs) return [];
    if (w.componentIds.length === 0) return [w];
    const componentIds = w.componentIds.filter((id) => visible.has(id));
    return componentIds.length === 0 ? [] : [{ ...w, componentIds }];
  });
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

export type TimeFormat = { timeZone?: string; locale?: string };

/**
 * Date and time parts in the viewer's locale and zone. Pass a fixed zone and
 * locale where the output must be stable, such as server-rendered HTML.
 */
export function timeParts(at: number, now: number, format: TimeFormat = {}) {
  const { timeZone, locale } = format;
  const date = new Date(at);
  const year = (d: number) =>
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(d);
  const day = date.toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: year(at) === year(now) ? undefined : "numeric",
    timeZone,
  });
  const time = date.toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  const zone =
    new Intl.DateTimeFormat(locale, { timeZoneName: "short", timeZone })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
  return { day, time, zone, dayKey };
}

/**
 * "in 1 hour 41 minutes", "3 hours ago", or "just now" within a minute.
 * Countdowns under a day keep their minutes, so "in 2 hours" never stands for
 * 1:40. Ages past an hour round to whole hours: "3 hours 1 minute ago" is
 * noise to a player.
 */
export function relativeTime(at: number, now: number) {
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return seconds > 0 ? "in less than a minute" : "just now";
  const part = (n: number, unit: string) =>
    n === 0 ? "" : `${n} ${unit}${n === 1 ? "" : "s"}`;
  const pastHours = Math.round(abs / 3_600);
  const span =
    abs >= 86_400 || (seconds < 0 && pastHours >= 24)
      ? part(Math.max(1, Math.round(abs / 86_400)), "day")
      : seconds < 0 && abs >= 3_600
        ? part(pastHours, "hour")
        : [
            part(Math.floor(abs / 3_600), "hour"),
            part(Math.floor((abs % 3_600) / 60), "minute"),
          ]
            .filter(Boolean)
            .join(" ");
  return seconds > 0 ? `in ${span}` : `${span} ago`;
}

/** Relative time for something that already happened; clock skew never reads as future. */
export function timeAgo(at: number, now: number) {
  return relativeTime(Math.min(at, now), now);
}

/** "just now", "5 seconds ago", then as `timeAgo`: for a ticking Updated line. */
export function secondsAgo(at: number, now: number) {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  return timeAgo(at, now);
}

/** Minute samples of one target's state over an hour or a UTC day. */
export type HealthBucket = {
  start: number;
  operational: number;
  degraded: number;
  down: number;
  maintenance: number;
  unknown: number;
  /** Mean URL response time in the span, when one was measured. */
  latencyMs: number | null;
};
export type StatusIncident = {
  startedAt: number;
  endedAt: number | null;
  worst: "degraded" | "down";
};
/** A public target's history (`public/status/{slug}/components/{id}/history`). */
export type TargetHistory = {
  now: number;
  hours: HealthBucket[];
  days: HealthBucket[];
  incidents: StatusIncident[];
};

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Share of known, unplanned minutes the target answered (degraded counts as
 * up; maintenance and unknown minutes are left out), or null with no data.
 */
export function uptimeShare(buckets: HealthBucket[]) {
  let up = 0;
  let known = 0;
  for (const b of buckets) {
    up += b.operational + b.degraded;
    known += b.operational + b.degraded + b.down;
  }
  return known === 0 ? null : up / known;
}

/** "99.95%", never rounded up to 100 while any minute was down. */
export function uptimeLabel(share: number | null) {
  if (share === null) return "No data";
  if (share >= 1) return "100%";
  const floored = Math.floor(share * 10_000) / 100;
  return `${Math.min(floored, 99.99).toFixed(2)}%`;
}

/** A bucket's worst state, for one bar in a history strip. */
export function bucketTone(
  bucket: HealthBucket | undefined,
): ComponentStatus | "empty" {
  if (!bucket) return "empty";
  if (bucket.down > 0) return "down";
  if (bucket.degraded > 0) return "degraded";
  if (bucket.maintenance > 0) return "maintenance";
  if (bucket.operational > 0) return "operational";
  return bucket.unknown > 0 ? "unknown" : "empty";
}

/**
 * `count` consecutive spans of `size` ending with the one holding `now`,
 * oldest first, each with its bucket when one was recorded.
 */
export function bucketSeries(
  buckets: HealthBucket[],
  now: number,
  size: number,
  count: number,
) {
  const byStart = new Map(buckets.map((b) => [b.start, b]));
  const last = Math.floor(now / size) * size;
  return Array.from({ length: count }, (_, i) => {
    const start = last - (count - 1 - i) * size;
    return { start, bucket: byStart.get(start) };
  });
}

/** "1 hour", "2 hours 30 minutes", "45 minutes". */
export function durationLabel(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const part = (n: number, unit: string) =>
    n === 0 ? "" : `${n} ${unit}${n === 1 ? "" : "s"}`;
  return [
    part(days, "day"),
    part(hours, "hour"),
    days ? "" : part(rest, "minute"),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * A day as players read it: "Today", "Tomorrow", or "Sat, Nov 7". Tomorrow is
 * the next calendar day in the zone, so a 23- or 25-hour day can't skip it.
 */
export function dayName(at: number, now: number, format: TimeFormat = {}) {
  const parts = timeParts(at, now, format);
  const today = timeParts(now, now, format).dayKey;
  if (parts.dayKey === today) return "Today";
  const [y, m, d] = today.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return parts.dayKey === next ? "Tomorrow" : parts.day;
}

/**
 * "Today, 7:00 PM to 9:00 PM UTC" or "Mon, Nov 9, ...": days are named as on
 * the public page. The start keeps its own zone when a daylight-saving change
 * falls inside the window ("1:30 AM EDT to 1:30 AM EST").
 */
export function windowLabel(
  window: MaintenanceWindow,
  now: number,
  format: TimeFormat = {},
) {
  const phase = maintenancePhase(window, now);
  const start = timeParts(window.startsAt, now, format);
  const end = timeParts(windowEnd(window), now, format);
  const startText = `${dayName(window.startsAt, now, format)}, ${start.time}${start.zone === end.zone ? "" : ` ${start.zone}`}`;
  const range =
    start.dayKey === end.dayKey
      ? `${startText} to ${end.time} ${end.zone}`
      : `${startText} to ${dayName(windowEnd(window), now, format)}, ${end.time} ${end.zone}`;
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

/** Maintenance that publishes nothing because every affected target is hidden. */
export function hiddenOnlyWindow(
  window: MaintenanceWindow,
  components: Pick<StatusComponent, "id" | "public">[],
) {
  if (window.componentIds.length === 0) return false;
  return !components.some(
    (c) => c.public && window.componentIds.includes(c.id),
  );
}
