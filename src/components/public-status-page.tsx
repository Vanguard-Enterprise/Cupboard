"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  HistoryIcon,
  MegaphoneIcon,
  RefreshCwIcon,
} from "lucide-react";
import { apiRequest } from "@/lib/api-client";
import {
  accentEdges,
  accentForeground,
  activeMaintenance,
  componentStatus,
  dayName,
  durationLabel,
  groupComponents,
  maintenancePhase,
  nameList,
  onlineCount,
  publicLogoPath,
  publicMaintenance,
  publicSummary,
  relativeTime,
  statusAnnouncement,
  statusLabel,
  statusSnapshot,
  statusTabTitle,
  timeAgo,
  timeParts,
  validColor,
  windowEnd,
  type ComponentStatus,
  type MaintenanceWindow,
  type PublicStatus,
  type SummaryPart,
} from "@/lib/status-page";
import { cn } from "@/lib/utils";
import { statusFontFamily } from "@/components/status-fonts";
import { ToneIcon, toneClass, type Tone } from "@/components/status-indicators";

const REFRESH_MS = 60_000;
/** Refresh on return to the tab when the last attempt is older than this. */
const RETURN_REFRESH_MS = 30_000;
/** A row names its reading's age once it is older than this. */
const OLD_READING_MS = 3 * 60_000;
/** Healthy groups start collapsed once the page lists more targets than this. */
const COLLAPSE_AFTER = 8;
/** How long a changed row stays marked after a refresh. */
const CHANGE_CUE_MS = 5_000;
/**
 * An in-progress message longer than this (about two lines on a phone) sits
 * behind its entry's disclosure, so players reach Services sooner.
 */
const LONG_MESSAGE = 120;

/**
 * Focus never follows the brand accent: a near-white or near-black accent
 * would hide it. The page's own text color always contrasts with its
 * background, in both themes.
 */
export const statusFocus =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-foreground";

const touchTarget = "[@media(any-pointer:coarse)]:min-h-11";

const severity: ComponentStatus[] = [
  "down",
  "degraded",
  "maintenance",
  "unknown",
  "operational",
];

/**
 * Problem states carry more weight than healthy ones in rows and groups: an
 * outlined bold chip. No fill, so the label keeps 5:1 or more on the card in
 * both themes.
 */
const problemChip: Partial<Record<Tone, string>> = {
  down: "border-destructive/50 text-destructive",
  degraded: "border-warning/50 text-warning",
};
/** Lines players act on (times, plans, reading ages, labels) are 13 pixels. */
const metaSize = "text-[0.8125rem] leading-5";
const metaText = cn(metaSize, "text-muted-foreground");
/** Section headings: one size for every list on the page. */
const sectionHeading = "text-[0.9375rem] leading-6 font-semibold";
/**
 * Glyphs that lead a block (the hero's state, the announcement's megaphone)
 * hang in the left margin once the page is wide enough, so the title, the
 * announcement, and the lists share one left edge. Below that the block's
 * text is indented by `--hang` and the glyph sits in the indent at the
 * column edge, so a wrapped line lines up with the first, never under the
 * glyph. `--hang` follows the hero's type size.
 */
const hangWidth =
  "[--hang:2rem] @min-[30rem]:[--hang:2.25rem] @min-[40rem]:[--hang:2.75rem] @min-[48rem]:[--hang:3rem] @min-[50rem]:[--hang:0rem]";
const hanging =
  "absolute left-[calc(var(--hang)*-1)] @min-[50rem]:left-auto @min-[50rem]:right-full @min-[50rem]:mr-4";
/** The hero's state glyph: centered on the title's first line. */
const heroGlyph = cn(
  "top-[0.16em] size-[0.8em] @min-[50rem]:size-[0.75em]",
  hanging,
);

const subscribeNothing = () => () => {};

/**
 * Server HTML is rendered in UTC and en-US; once hydrated, times switch to
 * the visitor's own zone and locale. This keeps hydration exact.
 */
function useTimeFormat() {
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
  return hydrated
    ? {}
    : ({ timeZone: "UTC", locale: "en-US" } as {
        timeZone?: string;
        locale?: string;
      });
}

/**
 * How many times `value` has changed since the first render. Motion keys off
 * it, so a state change can show itself while the first paint stays still.
 */
function useChangeCount(value: string) {
  const [seen, setSeen] = useState({ value, count: 0 });
  if (seen.value !== value) {
    const next = { value, count: seen.count + 1 };
    setSeen(next);
    return next.count;
  }
  return seen.count;
}

export function PublicStatusPage({
  slug,
  initial,
}: {
  slug: string;
  initial: PublicStatus;
}) {
  const [data, setData] = useState(initial);
  const [now, setNow] = useState(() => initial.updatedAt);
  const [stale, setStale] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const lastAttempt = useRef(initial.updatedAt);

  const load = useCallback(async () => {
    lastAttempt.current = Date.now();
    try {
      setData(await apiRequest<PublicStatus>(`public/status/${slug}`));
      setStale(false);
    } catch {
      setStale(true);
    }
    setNow(Date.now());
  }, [slug]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastAttempt.current > RETURN_REFRESH_MS
      )
        void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // Announce what changed (a service, a maintenance phase, freshness), never
  // the ticking update time.
  const visible = publicMaintenance(
    data.maintenance,
    data.components.map((c) => c.id),
    now,
  );
  const snapshot = statusSnapshot(data.components, visible, now, stale);
  const snapshotKey = JSON.stringify(snapshot);
  const announced = useRef(snapshot);
  useEffect(() => {
    const next = JSON.parse(snapshotKey) as typeof snapshot;
    const message = statusAnnouncement(announced.current, next);
    announced.current = next;
    if (message) setLiveMessage(message);
  }, [snapshotKey]);

  // Next sets the first title from the same rule (generateMetadata); this
  // keeps it current after each refresh.
  const tone = publicSummary(data.components, visible, now).tone;
  const title = statusTabTitle(data.name, tone, stale);
  useEffect(() => {
    document.title = title;
  }, [title]);

  async function retry() {
    setRetrying(true);
    await load();
    setRetrying(false);
  }

  return (
    <PublicStatusView
      data={data}
      logoUrl={
        data.logoVersion === null
          ? null
          : publicLogoPath(slug, data.logoVersion)
      }
      now={now}
      stale={stale}
      onRetry={retry}
      retrying={retrying}
      liveMessage={liveMessage}
    />
  );
}

/**
 * The branded public page. The settings preview renders the same view, so
 * what operators see while editing is what visitors get: it applies the same
 * maintenance rule as the public endpoint. When `embedded`, the view renders
 * no landmarks, headings, or live region of its own.
 */
export function PublicStatusView({
  data,
  logoUrl,
  now,
  stale = false,
  embedded = false,
  onRetry,
  retrying = false,
  liveMessage = "",
}: {
  data: PublicStatus;
  logoUrl: string | null;
  now: number;
  stale?: boolean;
  embedded?: boolean;
  onRetry?: () => void;
  retrying?: boolean;
  liveMessage?: string;
}) {
  const id = useId();
  const accent = validColor(data.accentColor) ? data.accentColor : "#7cb58d";
  const accentText = accentForeground(accent);
  // A fill that would vanish into the page gets an edge in a deeper or
  // lighter shade of the accent, per scheme (System pages can get either).
  const edges = accentEdges(accent, data.theme);
  const components = data.components;
  const maintenance = publicMaintenance(
    data.maintenance,
    components.map((c) => c.id),
    now,
  );
  const format = useTimeFormat();
  const summary = publicSummary(components, maintenance, now, {
    format,
    stale,
  });
  const titleChanges = useChangeCount(summary.title);
  const active = activeMaintenance(maintenance, now);
  // When maintenance is the headline, its windows follow the hero directly.
  const foldMaintenance = !stale && summary.tone === "maintenance";
  // Several windows that end at different times each keep their own end, so
  // a player can tell when their server is back (codex P-19).
  const ownEnds =
    active.length > 1 && active.some((w) => w.endsAt !== summary.backBy);
  const upcoming = maintenance
    .filter((w) => maintenancePhase(w, now) === "scheduled")
    .sort((a, b) => a.startsAt - b.startsAt);
  const recent = maintenance
    .filter((w) => maintenancePhase(w, now) === "completed")
    .sort((a, b) => windowEnd(b) - windowEnd(a));
  /** What a window affects, without the verb: screen readers hear "Affects". */
  const affected = (window: MaintenanceWindow) => {
    if (window.componentIds.length === 0) return "All services";
    const names = components
      .filter((c) => window.componentIds.includes(c.id))
      .map((c) => c.name);
    return names.length > 0 ? nameList(names, 4) : "";
  };
  const when = (at: number) => timeParts(at, now, format);
  /** "Today", "Tomorrow", or "Mon, Nov 9", as the admin names days. */
  const day = (at: number) => dayName(at, now, format);
  const updated = when(data.updatedAt);
  const today = when(now).dayKey;
  const updatedText = timeText(updated, today);

  const tags = {
    header: embedded ? "div" : "header",
    main: embedded ? "div" : "main",
    footer: embedded ? "div" : "footer",
    nav: embedded ? "div" : "nav",
  } as const;
  const Header = tags.header;
  const Main = tags.main;
  const Footer = tags.footer;
  const Nav = tags.nav;
  const H1 = embedded ? "p" : "h1";
  const H2 = embedded ? "p" : "h2";
  const H3 = embedded ? "p" : "h3";
  const heroTone: Tone = summary.tone;
  const total = components.length;
  // Lines the services list already shows: screen readers still hear them
  // with the headline, sighted players read the list.
  const rest = summary.detailParts.slice(summary.answer ? 1 : 0);

  // The column centers on the area beside any scrollbar, like the bar and
  // the footer rule, so every center on the page agrees (a11y P-R6-01).
  const column = "mx-auto w-full max-w-[42rem] px-4";

  const activeList = active.length > 0 && (
    <ScheduleList
      className={foldMaintenance ? "mt-10" : "mt-3"}
      label={embedded ? undefined : "Maintenance in progress"}
    >
      {active.map((window) => {
        // The hero already says when the only end is, so the entry has no
        // time to give: its state sits on the title's line (codex P-22).
        const endInHero = foldMaintenance && !ownEnds;
        const names =
          !foldMaintenance ||
          active.length > 1 ||
          summary.counts.maintenance > 3
            ? affected(window)
            : "";
        // Ends and reach stay in view; with several windows, or a long
        // note, the operator's message waits behind the entry so players
        // reach Services sooner (codex).
        const fold =
          active.length > 1 || window.message.length > LONG_MESSAGE
            ? "message"
            : undefined;
        return (
          <ScheduleRow
            key={window.id}
            heading={H3}
            title={window.title}
            affected={names}
            message={window.message}
            compact={endInHero}
            fold={fold}
            when={
              endInHero ? (
                <span className="font-medium">In progress</span>
              ) : (
                <>
                  <span className="font-medium text-foreground">
                    Back by{" "}
                    <Time
                      at={window.endsAt}
                      text={timeText(when(window.endsAt), today)}
                    />
                  </span>{" "}
                  <Relative stack>{relativeTime(window.endsAt, now)}</Relative>
                </>
              )
            }
          />
        );
      })}
    </ScheduleList>
  );

  return (
    <div
      data-status-page={embedded ? undefined : ""}
      className={cn(
        // Breakpoints follow the page's own width, so the settings preview's
        // phone frame gets the phone layout.
        "@container flex flex-col bg-background text-foreground",
        data.theme === "light" && "theme-light",
        data.theme === "system" && "theme-system",
        // The footer sits at the bottom of a short page: the small viewport
        // height keeps it above a phone's browser bar.
        !embedded && "min-h-screen supports-[min-height:100svh]:min-h-svh",
      )}
      style={
        {
          fontFamily: statusFontFamily[data.font] ?? statusFontFamily.geist,
        } as CSSProperties
      }
    >
      <div
        aria-hidden="true"
        className="h-1 shrink-0"
        style={{ background: accent }}
      />
      <span id={`${id}-new-tab`} hidden>
        Opens in a new tab
      </span>
      <Header
        className={cn(
          column,
          "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 @min-[40rem]:flex @min-[40rem]:justify-between",
          embedded ? "pt-5" : "pt-5 @min-[48rem]:pt-8",
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          {logoUrl ? (
            // Logos are re-encoded PNGs served by Cupboard, not remote images.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt=""
              className="h-9 w-auto max-w-32 shrink-0 object-contain @min-[40rem]:max-w-40"
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold"
              style={{ background: accent, color: accentText }}
            >
              {data.name.trim().charAt(0).toUpperCase()}
            </span>
          )}
          <H1 className="min-w-0 text-base leading-tight font-semibold tracking-tight break-words @min-[40rem]:text-lg">
            {data.name}
          </H1>
        </div>
        {data.links.length > 0 && (
          <Nav
            aria-label={embedded ? undefined : `${data.name} links`}
            className="col-span-2 row-start-2 -mx-2 flex flex-wrap items-center @min-[40rem]:mx-0 @min-[40rem]:ml-auto"
          >
            {data.links.map((link) => (
              <a
                key={`${link.label}:${link.url}`}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                aria-describedby={`${id}-new-tab`}
                className={cn(
                  "inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-muted-foreground underline-offset-4 transition-[color] hover:text-foreground hover:underline",
                  touchTarget,
                  statusFocus,
                )}
              >
                {link.label}
                <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
              </a>
            ))}
          </Nav>
        )}
        {data.supportUrl && (
          <a
            href={data.supportUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Contact support"
            aria-describedby={`${id}-new-tab`}
            className={cn(
              "col-start-2 row-start-1 inline-flex h-9 shrink-0 items-center rounded-lg px-3.5 text-sm font-medium transition-[filter] hover:brightness-110",
              touchTarget,
              statusFocus,
            )}
            style={
              {
                background: accent,
                color: accentText,
                ...((edges.light || edges.dark) && {
                  "--accent-edge-light": edges.light ?? "transparent",
                  "--accent-edge-dark": edges.dark ?? "transparent",
                  boxShadow:
                    "inset 0 0 0 1px light-dark(var(--accent-edge-light), var(--accent-edge-dark))",
                }),
              } as CSSProperties
            }
          >
            <span className="@min-[40rem]:hidden">Support</span>
            <span className="hidden @min-[40rem]:inline">Contact support</span>
          </a>
        )}
      </Header>

      <Main
        className={cn(
          column,
          hangWidth,
          "flex-1",
          embedded
            ? "pt-8 pb-10"
            : "pt-12 pb-16 @min-[48rem]:pt-20 @min-[48rem]:pb-24",
        )}
      >
        {!embedded && (
          <p role="status" className="sr-only">
            {liveMessage}
          </p>
        )}
        {/* Not a landmark: its name would be the headline, which changes with
            every state (a11y P-R6-05). The h2 is the way in. */}
        <div data-status-tone={heroTone}>
          <HeroStatement
            heading={H2}
            titleKey={titleChanges}
            tone={heroTone}
            glyph={
              stale ? (
                <HistoryIcon
                  aria-hidden="true"
                  className={cn(heroGlyph, "text-muted-foreground")}
                />
              ) : undefined
            }
            title={summary.title}
            answer={summary.answer}
            rest={rest}
          >
            {stale ? (
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                <p className={metaText}>
                  Updated <Time at={data.updatedAt} text={updatedText} />{" "}
                  <Relative>{timeAgo(data.updatedAt, now)}</Relative>
                </p>
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    disabled={retrying}
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-md border border-border-strong px-3 font-medium transition-[background-color] hover:bg-surface-elevated disabled:opacity-70",
                      metaSize,
                      touchTarget,
                      statusFocus,
                    )}
                  >
                    <RefreshCwIcon
                      aria-hidden="true"
                      className={cn(
                        "size-3.5",
                        retrying && "motion-safe:animate-spin",
                      )}
                    />
                    {retrying ? "Retrying..." : "Retry"}
                  </button>
                )}
              </div>
            ) : (
              total > 0 && (
                <UpdatedLine
                  at={data.updatedAt}
                  text={updatedText}
                  answered={!!summary.answer}
                />
              )
            )}
          </HeroStatement>
          {foldMaintenance && activeList}
        </div>

        {data.announcement && (
          <div
            role="note"
            aria-label={embedded ? undefined : "Announcement"}
            className="relative mt-10 pl-(--hang)"
          >
            <MegaphoneIcon
              aria-hidden="true"
              className={cn(
                "top-1 size-4 text-muted-foreground",
                hanging,
                "left-0",
              )}
            />
            {/* Free text from the operator: its times are theirs, not
                converted to the visitor's zone like the rest of the page. */}
            <p className="min-w-0 text-[0.9375rem] leading-6 break-words whitespace-pre-line">
              {data.announcement}
            </p>
          </div>
        )}

        {!foldMaintenance && active.length > 0 && (
          <section
            aria-labelledby={embedded ? undefined : `${id}-active`}
            className="mt-12"
          >
            <H2 id={`${id}-active`} className={sectionHeading}>
              Maintenance in progress
            </H2>
            {activeList}
          </section>
        )}

        {total > 0 && (
          <section
            aria-labelledby={embedded ? undefined : `${id}-services`}
            className="group/services mt-12 @min-[48rem]:mt-14"
          >
            <div className="flex items-baseline justify-between gap-3">
              <H2 id={`${id}-services`} className={sectionHeading}>
                Services
              </H2>
              {/* Only while a group is collapsed, so some rows are out of
                  sight: with every row in view it repeats them (claude
                  P-38), the rule the group roll-ups follow. */}
              <p
                data-testid="services-count"
                className={cn(
                  metaText,
                  "hidden text-right tabular-nums group-has-[button[aria-expanded=false]]/services:block",
                )}
              >
                {stale && (
                  <span className="sr-only">
                    As of <Time at={data.updatedAt} text={updatedText} />,{" "}
                  </span>
                )}
                {summary.countText}
              </p>
            </div>
            <div className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border-strong bg-card">
              {groupComponents(components).map((group) => {
                const items = group.items.map((c) => {
                  const status = componentStatus(c, maintenance, now);
                  const next = upcoming.find(
                    (w) =>
                      w.componentIds.length === 0 ||
                      w.componentIds.includes(c.id),
                  );
                  return { component: c, status, next };
                });
                const rows = (
                  <ul
                    aria-label={
                      embedded || !group.name ? undefined : group.name
                    }
                  >
                    {items.map(({ component, status, next }) => (
                      <TargetRow
                        key={component.id}
                        name={component.name}
                        status={status}
                        stale={stale}
                        detail={
                          // The hero or the maintenance list names the end.
                          status ===
                          "maintenance" ? null : component.observedAt ===
                            null ? (
                            status === "unknown" ? (
                              "Hasn't reported yet"
                            ) : null
                          ) : status !== "unknown" &&
                            now - component.observedAt <
                              OLD_READING_MS ? null : (
                            <>
                              Last checked{" "}
                              <Time
                                at={component.observedAt}
                                text={timeAgo(component.observedAt, now)}
                              />
                            </>
                          )
                        }
                        upcoming={
                          next ? (
                            <>
                              Maintenance{" "}
                              {dayText(when(next.startsAt), today)[0]}{" "}
                              <Time
                                at={next.startsAt}
                                text={dayText(when(next.startsAt), today)[1]}
                              />
                            </>
                          ) : null
                        }
                      />
                    ))}
                  </ul>
                );
                if (!group.name) return <div key="(ungrouped)">{rows}</div>;
                return (
                  <TargetGroup
                    key={group.name}
                    name={group.name}
                    statuses={items.map((i) => i.status)}
                    stale={stale}
                    collapsible={total > COLLAPSE_AFTER}
                    heading={H3}
                  >
                    {rows}
                  </TargetGroup>
                );
              })}
            </div>
          </section>
        )}

        {upcoming.length > 0 && (
          <section
            aria-labelledby={embedded ? undefined : `${id}-upcoming`}
            className="mt-12 @min-[48rem]:mt-14"
          >
            <H2 id={`${id}-upcoming`} className={sectionHeading}>
              Upcoming maintenance
            </H2>
            <ScheduleList className="mt-3">
              {upcoming.map((window) => {
                return (
                  <ScheduleRow
                    key={window.id}
                    heading={H3}
                    title={window.title}
                    affected={affected(window)}
                    message={window.message}
                    when={
                      <>
                        <Time
                          at={window.startsAt}
                          text={day(window.startsAt)}
                          className="font-medium text-foreground"
                        />
                        <span className="@min-[40rem]:hidden">, </span>
                        <span className="@min-[40rem]:block">
                          <TimeRange window={window} when={when} day={day} />
                        </span>{" "}
                        <Relative stack>
                          {relativeTime(window.startsAt, now)}
                        </Relative>
                      </>
                    }
                  />
                );
              })}
            </ScheduleList>
          </section>
        )}

        {recent.length > 0 && (
          <section
            aria-labelledby={embedded ? undefined : `${id}-past`}
            className="mt-12 @min-[48rem]:mt-14"
          >
            <H2 id={`${id}-past`} className={sectionHeading}>
              Past maintenance
            </H2>
            <ScheduleList className="mt-3">
              {recent.map((window) => (
                <ScheduleRow
                  key={window.id}
                  heading={H3}
                  title={window.title}
                  quiet
                  // History players rarely need rests behind the row: the
                  // hours, length, reach, and note (codex P-21, a11y P-R6-04).
                  fold="details"
                  affected={affected(window)}
                  message={window.message}
                  when={
                    <Time at={window.startsAt} text={day(window.startsAt)} />
                  }
                  whenMore={
                    <>
                      <span className="@min-[40rem]:sr-only">, </span>
                      <span className="@min-[40rem]:block">
                        <TimeRange window={window} when={when} day={day} />
                      </span>
                      <span className="sr-only">. </span>
                      <span className="block">
                        Lasted{" "}
                        {durationLabel(windowEnd(window) - window.startsAt)}
                      </span>
                    </>
                  }
                />
              ))}
            </ScheduleList>
          </section>
        )}
      </Main>

      {(data.footerText || data.poweredBy) && (
        <Footer className="border-t border-border">
          {/* One 20-pixel line under the rule. The link's taller hit box
              reaches into the padding, so the footer stays one line tall
              on touch screens too (a11y P-R6-02); wrapped lines leave it
              room. Below 360 pixels the side padding and the gap between
              the two parts tighten, so a short footer text still shares
              the line with Powered by at 320 (a11y P-R7-02); a longer one
              wraps to a second centered line. */}
          <div
            className={cn(
              column,
              "flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-center @max-[22.5rem]:gap-x-4 @max-[22.5rem]:px-2 [@media(any-pointer:coarse)]:gap-y-3",
              embedded ? "py-4" : "py-5",
              metaText,
            )}
          >
            {data.footerText && (
              <p className="break-words">{data.footerText}</p>
            )}
            {data.poweredBy && (
              <p className="flex items-center gap-1">
                <span>Powered by</span>
                <Link
                  href="/"
                  className={cn(
                    "-my-1.5 inline-flex min-h-8 items-center gap-1.5 rounded-md px-1.5 font-medium text-foreground underline-offset-4 hover:underline [@media(any-pointer:coarse)]:-my-3",
                    touchTarget,
                    statusFocus,
                  )}
                >
                  <Image
                    src="/images/cupboard-logo.png"
                    alt=""
                    width={16}
                    height={16}
                    className="size-4"
                  />
                  Cupboard
                </Link>
              </p>
            )}
          </div>
        </Footer>
      )}
    </div>
  );
}

type Parts = ReturnType<typeof timeParts>;

/** The day only when it is not today, then the time and zone. */
function timeText(parts: Parts, today: string) {
  return `${parts.dayKey === today ? "" : `${parts.day}, `}${parts.time} ${parts.zone}`;
}

/** "today at 7:00 PM UTC" or "on Sat, Nov 7". */
function dayText(parts: Parts, today: string) {
  return parts.dayKey === today
    ? ["today at", `${parts.time} ${parts.zone}`]
    : ["on", parts.day];
}

/** A time and its zone never wrap apart. */
/**
 * The hero's statement: the state glyph, the headline, the one line players
 * act on, then `children` (the Updated line). Place it inside an
 * `@container` that sets `--hang` (`hangWidth`); its type follows that
 * container's width.
 */
function HeroStatement({
  heading: Heading = "h2",
  titleKey,
  tone,
  glyph,
  title,
  titleClassName,
  answer,
  rest = [],
  children,
}: {
  heading?: "h2" | "p";
  /** Changes when the headline does, so a new one settles in. */
  titleKey?: number;
  tone: Tone;
  /** Replaces the tone's glyph, such as a clock while out of date. */
  glyph?: ReactNode;
  title: string;
  titleClassName?: string;
  answer: SummaryPart[] | null;
  /** Lines the services list already shows: for screen readers only. */
  rest?: SummaryPart[][];
  children?: ReactNode;
}) {
  return (
    <div className="pl-(--hang)">
      <Heading
        key={titleKey}
        className={cn(
          "relative text-[1.75rem] leading-[1.12] font-semibold tracking-[-0.025em] text-balance break-words @min-[30rem]:text-[2rem] @min-[40rem]:text-[2.5rem] @min-[48rem]:text-[2.75rem] @min-[48rem]:leading-[1.06]",
          // A new headline settles in; the first paint never moves.
          !!titleKey &&
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300",
          titleClassName,
        )}
      >
        {glyph ?? (
          <ToneIcon tone={tone} className={cn(heroGlyph, toneClass[tone])} />
        )}
        {title}
      </Heading>
      {answer && (
        <p
          data-testid="status-answer"
          className="mt-4 text-base leading-7 font-medium @min-[40rem]:text-lg"
        >
          <Parts parts={answer} quiet />
        </p>
      )}
      {rest.length > 0 && (
        <p className="sr-only">
          {rest.map((line, index) => (
            <span key={index}>
              {index > 0 && " "}
              <Parts parts={line} />
            </span>
          ))}
        </p>
      )}
      {children}
    </div>
  );
}

/** "Updated 4:04 PM UTC" under the hero's answer. */
function UpdatedLine({
  at,
  text,
  answered,
}: {
  at: number;
  text: string;
  answered: boolean;
}) {
  return (
    <p className={cn(answered ? "mt-2" : "mt-4", metaText)}>
      Updated <Time at={at} text={text} />
    </p>
  );
}

function Time({
  at,
  text,
  className,
}: {
  at: number;
  text: string;
  className?: string;
}) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      className={cn("whitespace-nowrap tabular-nums", className)}
    >
      {text}
    </time>
  );
}

/**
 * Summary text with each marked time as a `<time>`. When `quiet`, a
 * parenthetical ("(in 2 hours)") steps back to the secondary color so the
 * time it qualifies stays the strongest part of the line. On phones it
 * takes its own line without the parentheses, so "Back by 5:30 PM UTC"
 * stays on one line and the countdown never sits alone under it as a
 * stray fragment (claude P-36, codex P-23).
 */
function Parts({
  parts,
  quiet = false,
}: {
  parts: SummaryPart[];
  quiet?: boolean;
}) {
  return parts.map((part, index) =>
    typeof part !== "string" ? (
      <Time key={index} at={part.at} text={part.text} />
    ) : quiet ? (
      part.split(/(\([^)]*\))/).map((piece, i) =>
        piece.startsWith("(") ? (
          <span
            key={`${index}-${i}`}
            className="block font-normal whitespace-nowrap text-muted-foreground @min-[30rem]:inline @min-[30rem]:font-medium"
          >
            <span className="hidden @min-[30rem]:inline">(</span>
            {piece.slice(1, -1)}
            <span className="hidden @min-[30rem]:inline">)</span>
          </span>
        ) : (
          piece
        ),
      )
    ) : (
      part
    ),
  );
}

/**
 * "(in 2 days)", kept whole. With `stack`, in a schedule's time, it takes
 * its own quiet line without the parentheses at every width, as the hero's
 * countdown does on phones, so it never sits alone under the time as a
 * stray "(in 1 hour 57 minutes)" (claude P-40).
 */
function Relative({
  stack = false,
  children,
}: {
  stack?: boolean;
  children: ReactNode;
}) {
  const paren = stack ? "hidden" : undefined;
  return (
    <span
      className={cn(
        "whitespace-nowrap text-muted-foreground",
        stack && "block",
      )}
    >
      <span className={paren}>(</span>
      {children}
      <span className={paren}>)</span>
    </span>
  );
}

/**
 * "7:00 PM to 9:00 PM UTC": the start repeats its zone only across a
 * daylight-saving change. The start's day is left to the line above; the end
 * names its day only when it differs, as the admin does ("Tomorrow, 1:00 AM
 * UTC").
 */
function TimeRange({
  window,
  when,
  day,
}: {
  window: MaintenanceWindow;
  when: (at: number) => Parts;
  day: (at: number) => string;
}) {
  const start = when(window.startsAt);
  const end = when(windowEnd(window));
  const startZone = start.zone === end.zone ? "" : ` ${start.zone}`;
  return (
    <>
      <Time at={window.startsAt} text={`${start.time}${startZone}`} /> to{" "}
      <Time
        at={windowEnd(window)}
        text={
          start.dayKey === end.dayKey
            ? `${end.time} ${end.zone}`
            : `${day(windowEnd(window))}, ${end.time} ${end.zone}`
        }
      />
    </>
  );
}

/** Maintenance as a schedule: hairlines between entries, no cards. */
function ScheduleList({
  label,
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ul
      aria-label={label}
      className={cn("divide-y divide-border border-t border-border", className)}
    >
      {children}
    </ul>
  );
}

/**
 * One maintenance window. The heading leads in reading order; on wider pages
 * the time sits in its own column to the left, like a timetable, so the
 * answer to "when" is the first thing the eye finds. A `compact` entry has
 * no time to give (the hero states its end), so its state sits on the
 * title's line instead of in a mostly empty column. With `fold`, part of the
 * entry rests behind a disclosure: the whole row is the button, and what it
 * hides is hidden from everyone, so sighted visitors and screen readers get
 * the same entry.
 */
function ScheduleRow({
  heading: Heading,
  title,
  when,
  whenMore,
  affected,
  message,
  quiet = false,
  compact = false,
  fold,
}: {
  heading: "h3" | "p";
  title: string;
  when: ReactNode;
  /** More of the time column, shown with the folded details. */
  whenMore?: ReactNode;
  affected?: string;
  message?: string;
  quiet?: boolean;
  compact?: boolean;
  /** `message` folds the operator's note; `details` everything but the day and title. */
  fold?: "message" | "details";
}) {
  const panel = useId();
  const [open, setOpen] = useState(false);
  const folds =
    fold === "details"
      ? Boolean(whenMore || affected || message)
      : fold === "message" && Boolean(message);
  const affectedLine = affected && (
    <p className={metaText}>
      <span className="sr-only">Affects </span>
      {affected}
    </p>
  );
  const messageLine = message && (
    <p className="mt-1 text-sm leading-6 break-words whitespace-pre-line text-muted-foreground">
      {message}
    </p>
  );
  const always = fold === "details" ? null : affectedLine;
  const folded =
    fold === "details" ? (
      <>
        {affectedLine}
        {messageLine}
      </>
    ) : (
      messageLine
    );
  const below = (always || folds || messageLine) && (
    <div className={cn(!compact && "@min-[40rem]:col-start-2")}>
      {always}
      {folds ? (
        <div id={panel} hidden={!open}>
          {folded}
        </div>
      ) : (
        folded
      )}
    </div>
  );
  const heading = (
    <Heading
      className={cn(
        "min-w-0 text-sm leading-6 break-words",
        !compact && "@min-[40rem]:col-start-2 @min-[40rem]:row-start-1",
        quiet ? "font-medium" : "font-semibold",
      )}
    >
      {folds ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
          className={cn(
            // The button covers the whole row, and its focus ring traces it.
            "text-left outline-none after:absolute after:inset-y-0 after:-inset-x-2 after:rounded-lg after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-solid focus-visible:after:outline-foreground",
          )}
        >
          {title}
        </button>
      ) : (
        title
      )}
    </Heading>
  );
  const chevron = folds && (
    <ChevronDownIcon
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute right-0 size-4 text-muted-foreground transition-[rotate,color] duration-150 group-hover/row:text-foreground motion-reduce:transition-none",
        quiet ? "top-4" : "top-5",
        open && "rotate-180",
      )}
    />
  );
  const row = cn(
    "relative",
    quiet ? "py-3" : "py-4",
    folds && "group/row pr-8",
  );
  if (compact)
    return (
      <li className={row}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          {heading}
          <p className={cn("ml-auto text-muted-foreground", metaSize)}>
            {when}
          </p>
        </div>
        {below}
        {chevron}
      </li>
    );
  return (
    <li
      className={cn(
        row,
        "grid grid-cols-1 gap-y-0.5 @min-[40rem]:grid-cols-[11rem_minmax(0,1fr)] @min-[40rem]:gap-x-6",
      )}
    >
      {heading}
      <p
        className={cn(
          "text-muted-foreground @min-[40rem]:col-start-1 @min-[40rem]:row-span-2 @min-[40rem]:row-start-1 @min-[40rem]:pt-0.5",
          metaSize,
        )}
      >
        {when}
        {whenMore && <span hidden={folds && !open}>{whenMore}</span>}
      </p>
      {below}
      {chevron}
    </li>
  );
}

/**
 * A service row. The state follows the name in reading order ("Rust EU Main:
 * Unavailable. Maintenance on Sat, Nov 7"), while the label still sits at the
 * row's right edge. While the page is stale, nothing in the row looks live.
 * A coming window is for screen readers here: the Upcoming maintenance list
 * names every service it affects. When the state changes after a refresh,
 * the row flashes its new color once; with reduced motion it holds a still
 * tint of that color for a few seconds instead (a11y P-R6-03).
 */
function TargetRow({
  name,
  status,
  stale,
  detail,
  upcoming,
}: {
  name: string;
  status: ComponentStatus;
  stale: boolean;
  detail: ReactNode;
  upcoming: ReactNode;
}) {
  const chip = problemChip[status];
  const tint = stale ? "text-muted-foreground" : toneClass[status];
  const changes = useChangeCount(status);
  // The change count whose cue has run its course.
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    if (changes === 0) return;
    const timer = window.setTimeout(() => setSettled(changes), CHANGE_CUE_MS);
    return () => window.clearTimeout(timer);
  }, [changes]);
  return (
    <li className="relative grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-3">
      {changes > settled && !stale && (
        <span
          key={changes}
          aria-hidden="true"
          data-status-changed=""
          className={cn(
            "pointer-events-none absolute inset-0 animate-status-flash bg-current motion-reduce:animate-none motion-reduce:opacity-10",
            toneClass[status],
          )}
        />
      )}
      <ToneIcon
        tone={status}
        className={cn("col-start-1 row-start-1 mt-0.5 size-4 shrink-0", tint)}
      />
      <p className="col-start-2 row-start-1 text-sm font-medium break-words">
        {name}
        <span className="sr-only">: </span>
      </p>
      <span
        data-status-label=""
        className={cn(
          "col-start-3 row-start-1 shrink-0",
          metaSize,
          chip && !stale
            ? cn("rounded-full border px-2 font-semibold", chip)
            : cn("font-medium", tint),
        )}
      >
        {stale && <span className="sr-only">Last known </span>}
        {statusLabel[status]}
        <span className="sr-only">.</span>
      </span>
      {detail && (
        <p className={cn("col-start-2 row-start-2", metaText)}>
          <span className="sr-only"> </span>
          {detail}
        </p>
      )}
      {upcoming && <span className="sr-only"> {upcoming}</span>}
    </li>
  );
}

/**
 * A tag group. The heading is the group's name alone, so the heading list
 * stays short. The roll-up shows only while the group is collapsed: an open
 * group's rows already say it (claude P-34). On a collapsible group it is
 * always the disclosure button's description (a11y P-16).
 */
function TargetGroup({
  name,
  statuses,
  stale,
  collapsible,
  heading: Heading,
  children,
}: {
  name: string;
  statuses: ComponentStatus[];
  stale: boolean;
  collapsible: boolean;
  heading: "h3" | "p";
  children: ReactNode;
}) {
  const worst = severity.find((s) => statuses.includes(s)) ?? "operational";
  const [open, setOpen] = useState(worst !== "operational");
  // A group opens itself when its worst state gets worse (healthy to a
  // problem, or a new problem after recovery). A visitor's collapse holds
  // while the incident stays the same.
  const [seen, setSeen] = useState(worst);
  if (seen !== worst) {
    setSeen(worst);
    if (severity.indexOf(worst) < severity.indexOf(seen)) setOpen(true);
  }
  const expanded = !collapsible || open;
  const panel = useId();
  const rollup = useId();
  const problem = !stale && (worst === "down" || worst === "degraded");
  const showRollup = collapsible && statuses.length > 1;
  return (
    <div>
      <div
        className={cn(
          "relative flex min-h-11 flex-wrap items-center gap-x-3 gap-y-0.5 px-4",
          expanded ? "pt-3 pb-0.5" : "py-2",
        )}
      >
        <Heading className="min-w-0 flex-auto text-[0.8125rem] leading-5 font-semibold text-muted-foreground">
          {collapsible ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panel}
              aria-describedby={showRollup ? rollup : undefined}
              onClick={() => setOpen(!open)}
              className={cn(
                // The button covers the whole header row, roll-up included,
                // and its focus ring traces that row.
                "flex w-full items-center gap-3 text-left outline-none transition-[color] after:absolute after:inset-0 after:content-[''] hover:text-foreground focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-foreground focus-visible:after:outline-solid",
              )}
            >
              <ChevronDownIcon
                aria-hidden="true"
                className={cn(
                  "size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                  !expanded && "-rotate-90",
                )}
              />
              <span className="min-w-0 flex-1 break-words">{name}</span>
            </button>
          ) : (
            <span className="block break-words">{name}</span>
          )}
        </Heading>
        {showRollup && (
          <span
            id={rollup}
            className={cn(
              "pointer-events-none ml-auto inline-flex min-w-0 items-center gap-1.5 tabular-nums",
              metaSize,
              problem ? "font-semibold" : "font-medium",
              stale ? "text-muted-foreground" : toneClass[worst],
              expanded && "sr-only",
            )}
          >
            <ToneIcon tone={worst} className="size-3.5" />
            {onlineCount(statuses).text}
          </span>
        )}
      </div>
      <div id={panel} hidden={!expanded}>
        {children}
      </div>
    </div>
  );
}
