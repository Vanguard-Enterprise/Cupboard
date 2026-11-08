"use client";

import {
  Fragment,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  CalendarClockIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  GlobeIcon,
  GripVerticalIcon,
  HardDriveIcon,
  ImageIcon,
  LockIcon,
  MegaphoneIcon,
  MonitorIcon,
  MonitorSmartphoneIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  SmartphoneIcon,
  SunIcon,
  TimerIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { apiRequest, type Identity } from "@/lib/api-client";
import {
  accentForeground,
  accentPresets,
  accentTextContrast,
  affectedNames,
  componentStatus,
  contrastRatio,
  draftOf,
  durationLabel,
  groupComponents,
  hiddenOnlyWindow,
  maintenancePhase,
  maxComponents,
  maxLinks,
  moveComponent,
  publicMaintenance,
  publicPath,
  activeMaintenance,
  atText,
  publicSummary,
  relativeTime,
  sameDraft,
  slugify,
  statusBackgrounds,
  statusFonts,
  statusLabel,
  timeParts,
  unusedSources,
  validColor,
  validSlug,
  validTargetUrl,
  windowEnd,
  windowLabel,
  type ComponentDraft,
  type ComponentKind,
  type ComponentStatus,
  type MaintenanceWindow,
  type PageDraft,
  type PublicStatus,
  type StatusComponent,
  type StatusFont,
  type StatusPageState,
  type StatusSource,
  type StatusTheme,
} from "@/lib/status-page";
import { copyText } from "@/lib/clipboard";
import { StatusLogoEditor } from "@/components/status-logo-editor";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import { Input, InputFrame, InputFrameControl } from "@/components/ui/input";
import { Empty, EmptyMedia } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  TimeField,
  TimeFieldMessage,
  describeTime,
  timeOn,
  timeTextAt,
  timeExample,
  type TimeIssue,
} from "@/components/ui/time-field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUnsavedChanges } from "@/components/ui/unsaved-changes";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ToneIcon, toneClass } from "@/components/status-indicators";
import { PublicStatusView } from "@/components/public-status-page";
import { statusFontFamily } from "@/components/status-fonts";

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

/** Product copy for a failed request. Transport errors never reach the screen. */
function friendly(error: unknown) {
  if (error instanceof TypeError)
    return "Couldn't reach Cupboard. Check your connection and try again.";
  return error instanceof Error && error.message
    ? error.message
    : "The request could not be completed.";
}

/** The current time, read in event handlers rather than during render. */
const clock = () => Date.now();

/**
 * The public headline for `state`, as the one message after Publish or
 * Unpublish: "Players see a not-found page." or "Players see: ...".
 */
function playersSee(state: StatusPageState) {
  const { title } = publicSummary(
    state.components.filter((c) => c.public),
    state.maintenance,
    clock(),
    { published: state.published, stale: false },
  );
  return state.published ? `Players see: ${title}.` : `${title}.`;
}

const sentenceCase = (text: string) =>
  text ? text[0].toUpperCase() + text.slice(1) : text;

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function joinList(items: string[], max = 3) {
  if (items.length <= 1) return items.join("");
  if (items.length <= max)
    return `${items.slice(0, -1).join(", ")}${items.length > 2 ? "," : ""} and ${items[items.length - 1]}`;
  return `${items.slice(0, max - 1).join(", ")}, and ${items.length - max + 1} more`;
}

/** How often a website target is probed (`URL_INTERVAL_MS` in the backend). */
const WEBSITE_CHECK_SECONDS = 60;
/** How far a held row leans out of its gap: inside a row's 8 px padding. */
const DRAG_LEAN = 8;
/** A passed row drops back under the held one when its slide ends; this is
    the fallback when no transition runs (reduced motion), with room for a
    slow render before the 120 ms slide starts. */
const DRAG_SETTLE_MS = 400;

/** Touch screens get 44 pixel targets; pointers keep the compact size. */
const touch = "[@media(any-pointer:coarse)]:min-h-11";
const touchIcon = "[@media(any-pointer:coarse)]:size-11";
/**
 * A button that is busy keeps focus (a disabled one drops it to the page),
 * so it is marked `aria-disabled` and ignores presses instead (claude D-80).
 */
const busyLook = "aria-disabled:pointer-events-none aria-disabled:opacity-70";
/**
 * Phone sheet footers: buttons grow from their label's width instead of
 * splitting the row in half, and wrap to a second row before any label is cut.
 */
const fitFooter =
  "group-data-[scrollable=true]/dialog:max-sm:flex-wrap group-data-[scrollable=true]/dialog:max-sm:*:flex-auto";

const kindLabel: Record<ComponentKind, string> = {
  url: "Website",
  machine: "Machine",
  server: "Game server",
};
const exampleName: Record<ComponentKind, string> = {
  url: "Such as Forum",
  machine: "Such as EU host",
  server: "Such as EU main",
};
const kindIcon: Record<ComponentKind, LucideIcon> = {
  url: GlobeIcon,
  machine: HardDriveIcon,
  server: ServerIcon,
};

/** Dark and Light lock the page; System follows each visitor's device. */
const themeOption: Record<StatusTheme, { label: string; Icon: LucideIcon }> = {
  dark: { label: "Dark", Icon: MoonIcon },
  light: { label: "Light", Icon: SunIcon },
  system: { label: "System", Icon: MonitorIcon },
};

const accentNames = [
  "Sage",
  "Blue",
  "Violet",
  "Rose",
  "Vermilion",
  "Amber",
  "Teal",
  "White",
];

/** Worst first: what an operator should look at before anything else. */
const severity: Record<ComponentStatus, number> = {
  down: 0,
  degraded: 1,
  unknown: 2,
  maintenance: 3,
  operational: 4,
};

const draftLabels: Partial<Record<keyof PageDraft, string>> = {
  name: "page name",
  slug: "public address",
  supportUrl: "support link",
  theme: "theme",
  accentColor: "accent color",
  font: "font",
  links: "header links",
  footerText: "footer text",
  poweredBy: "Powered by Cupboard",
};

function sameUrl(a: string, b: string) {
  try {
    return new URL(a.trim()).href === new URL(b.trim()).href;
  } catch {
    return a.trim() === b.trim();
  }
}

function validHttps(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !!url.hostname;
  } catch {
    return false;
  }
}

/** A display name suggested from a website address: "play.example.com". */
function hostName(value: string) {
  const address = withScheme(value);
  try {
    return validTargetUrl(address)
      ? new URL(address).hostname.replace(/^www\./, "")
      : "";
  } catch {
    return "";
  }
}

/** Operators paste bare hosts ("forum.example.com"): those mean https. */
function withScheme(value: string) {
  const text = value.trim();
  if (!text || /^[a-z][a-z\d+.-]*:/i.test(text)) return text;
  return validTargetUrl(`https://${text}`) && text.includes(".")
    ? `https://${text}`
    : text;
}

const componentKey = (c: { kind: ComponentKind; sourceId: string }) =>
  `${c.kind}:${c.sourceId}`;

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * True when the draft differs from the saved page it was built on. Publishing
 * and the announcement go live at once, so they never count as edits.
 */
function hasEdits(draft: PageDraft, base: StatusPageState) {
  return editedSince(draft, draftOf(base));
}
function editedSince(draft: PageDraft, from: PageDraft) {
  return !sameDraft(
    { ...draft, published: from.published, announcement: from.announcement },
    from,
  );
}

/** Order keys like `primary`, slotting the rest in after their neighbour in `secondary`. */
function mergeOrder(primary: string[], secondary: string[], keep: Set<string>) {
  const out = primary.filter((key) => keep.has(key));
  secondary.forEach((key, i) => {
    if (!keep.has(key) || out.includes(key)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const before = out.indexOf(secondary[j]);
      if (before >= 0) {
        at = before + 1;
        break;
      }
    }
    out.splice(at, 0, key);
  });
  return out;
}

/** The operator's choices on a target, laid over the latest copy. */
const pickTarget = (c: ComponentDraft) => ({
  name: c.name,
  tagId: c.tagId,
  public: c.public,
});

/** A target both sessions decided on, named as the operator knows it. */
export type TargetDecision =
  /** Changed here, removed elsewhere: saving adds it back. */
  | { kind: "restored"; name: string }
  /** Removed here, changed elsewhere (`now` is its name there): saving removes it. */
  | { kind: "removed"; name: string; now: string }
  /** Both sides changed different fields: both changes are kept. */
  | { kind: "combined"; name: string; now: string }
  /** Both sides changed the same field differently: the operator's `fields` win. */
  | { kind: "clash"; name: string; fields: string }
  /** Both sides added it with different choices: the operator's `fields` win. */
  | { kind: "added"; name: string; now: string; fields: string };

/** What "Load latest, keep my edits" did where both sessions made a decision. */
export type Rebase = {
  draft: PageDraft;
  /** Every field and target both sides changed, for counting. */
  overlaps: string[];
  /** Fields where the operator's edit replaces the other session's. */
  replaced: string[];
  /** Targets both sides decided on, in page order. */
  targets: TargetDecision[];
};

const targetFields = ["name", "tagId", "public"] as const;

/** "name and visibility (shown to players)": the operator's choices that win. */
function choices(
  mine: ComponentDraft,
  keys: readonly (typeof targetFields)[number][],
) {
  const words = keys.map((key) =>
    key === "name"
      ? "name"
      : key === "tagId"
        ? "group"
        : `visibility (${mine.public ? "shown to" : "hidden from"} players)`,
  );
  return joinList(words, words.length);
}

/**
 * Three-way merge for "Load latest, keep my edits": fields the operator
 * changed since `base` keep their value, everything else follows `latest`.
 * Targets merge one by one (by kind and source), so a target another session
 * added, renamed, or removed is not lost, and every target both sides decided
 * on is named. Header links have no identity, so they merge as one list and a
 * label never pairs with a URL neither side chose.
 */
export function rebaseDraft(
  base: PageDraft,
  mine: PageDraft,
  latest: PageDraft,
): Rebase {
  const replaced = new Set<string>();
  const targets: TargetDecision[] = [];
  function pick<T>(was: T, edited: T, now: T, label: string): T {
    if (sameJson(edited, was)) return now;
    if (!sameJson(now, was) && !sameJson(now, edited)) replaced.add(label);
    return edited;
  }
  const field = <K extends keyof PageDraft>(key: K) =>
    pick(base[key], mine[key], latest[key], draftLabels[key] ?? String(key));

  const slug = pick(
    { slug: base.slug, slugEdited: base.slugEdited },
    { slug: mine.slug, slugEdited: mine.slugEdited },
    { slug: latest.slug, slugEdited: latest.slugEdited },
    "public address",
  );

  const byKey = (list: ComponentDraft[]) =>
    new Map(list.map((c) => [componentKey(c), c]));
  const was = byKey(base.components);
  const edited = byKey(mine.components);
  const now = byKey(latest.components);
  const changed = (a: ComponentDraft, b: ComponentDraft) =>
    a.name !== b.name || a.tagId !== b.tagId || a.public !== b.public;
  const keep = new Set<string>();
  for (const [key, c] of now) {
    const before = was.get(key);
    if (edited.has(key) || !before) keep.add(key);
    // Removed here, changed elsewhere: the removal stands, and is named by
    // the name the operator removed.
    else if (changed(before, c))
      targets.push({ kind: "removed", name: before.name, now: c.name });
  }
  for (const [key, c] of edited) {
    if (now.has(key)) continue;
    const before = was.get(key);
    if (!before) keep.add(key);
    // Changed here, removed elsewhere: saving adds it back, and is named.
    else if (changed(before, c)) {
      keep.add(key);
      targets.push({ kind: "restored", name: c.name });
    }
  }
  const keysOf = (list: ComponentDraft[]) => list.map(componentKey);
  const reordered = !sameJson(
    keysOf(base.components).filter((key) => edited.has(key)),
    keysOf(mine.components).filter((key) => was.has(key)),
  );
  const order = reordered
    ? mergeOrder(keysOf(mine.components), keysOf(latest.components), keep)
    : mergeOrder(keysOf(latest.components), keysOf(mine.components), keep);
  if (
    reordered &&
    !sameJson(keysOf(base.components), keysOf(latest.components))
  )
    replaced.add("target order");
  const components = order.map((key): ComponentDraft => {
    const before = was.get(key);
    const mineC = edited.get(key);
    const nowC = now.get(key);
    if (!mineC) return nowC!;
    if (!nowC) return before ? { ...mineC, id: null } : mineC;
    if (!before) {
      // Both sessions added it: the operator's choices win on the saved row,
      // and differing choices are named.
      const differ = targetFields.filter((k) => mineC[k] !== nowC[k]);
      if (differ.length)
        targets.push({
          kind: "added",
          name: mineC.name,
          now: nowC.name,
          fields: choices(mineC, differ),
        });
      return { ...mineC, id: nowC.id };
    }
    if (!changed(before, mineC) || !changed(before, nowC))
      return changed(before, mineC) ? { ...nowC, ...pickTarget(mineC) } : nowC;
    // Both sides changed this target: combine independent fields, and name it.
    const clash = targetFields.filter(
      (k) =>
        mineC[k] !== before[k] && nowC[k] !== before[k] && mineC[k] !== nowC[k],
    );
    const merged = {
      ...nowC,
      name: mineC.name !== before.name ? mineC.name : nowC.name,
      tagId: mineC.tagId !== before.tagId ? mineC.tagId : nowC.tagId,
      public: mineC.public !== before.public ? mineC.public : nowC.public,
    };
    targets.push(
      clash.length
        ? { kind: "clash", name: mineC.name, fields: choices(mineC, clash) }
        : { kind: "combined", name: mineC.name, now: merged.name },
    );
    return merged;
  });

  const draft: PageDraft = {
    ...latest,
    name: field("name"),
    ...slug,
    supportUrl: field("supportUrl"),
    theme: field("theme"),
    accentColor: field("accentColor"),
    font: field("font"),
    links: field("links"),
    footerText: field("footerText"),
    poweredBy: field("poweredBy"),
    components,
  };
  const replacedList = [...replaced];
  return {
    draft,
    overlaps: [...replacedList, ...targets.map((t) => t.name)],
    replaced: replacedList,
    targets,
  };
}

/** Loads the saved logo through the organization-scoped endpoint. */
function useStatusLogo(organization: string, version: number | null) {
  const [logo, setLogo] = useState<{ version: number; url: string } | null>(
    null,
  );
  useEffect(() => {
    if (version === null) return;
    let url = "";
    let canceled = false;
    void fetch("/app-api/status-page/logo", {
      headers: { "X-Cupboard-Organization": organization },
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (canceled || !blob) return;
        url = URL.createObjectURL(blob);
        setLogo({ version, url });
      })
      .catch(() => {});
    return () => {
      canceled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [organization, version]);
  return logo && logo.version === version ? logo.url : null;
}

/**
 * Radio-style toggle groups select as the arrow keys move focus, like native
 * radios, so the tab stop always lands back on the chosen option. Items carry
 * their value in `data-value`.
 */
function selectOnArrow(select: (value: string) => void) {
  // Radix moves focus after the keydown, so select when that focus lands.
  return {
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
      event.currentTarget.dataset.arrowed = String(
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(event.key),
      );
    },
    onFocus: (event: ReactFocusEvent<HTMLElement>) => {
      const group = event.currentTarget;
      if (group.dataset.arrowed !== "true") return;
      group.dataset.arrowed = "false";
      const value = (event.target as HTMLElement).dataset.value;
      if (value) select(value);
    },
  };
}

/** The nearest ancestor that scrolls vertically, or the document. */
function scrollParent(element: HTMLElement): Element {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    )
      return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** Focus the element tagged with `data-focus-key`, if it is still there. */
function focusByKey(...keys: (string | null | undefined)[]) {
  window.requestAnimationFrame(() => {
    for (const key of keys) {
      if (!key) continue;
      const element = [
        ...document.querySelectorAll<HTMLElement>("[data-focus-key]"),
      ].find((el) => el.dataset.focusKey === key);
      if (element) {
        element.focus();
        return;
      }
    }
  });
}

type Errors = Record<string, string>;

/** Label, control, and an error tied to the control with aria-describedby. */
function Field({
  id,
  label,
  aside,
  error,
  hint,
  warning = false,
  quietHint = false,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  /** A short fact at the end of the label row, describing the control. */
  aside?: ReactNode;
  error?: string;
  hint?: ReactNode;
  /** The hint warns about an effect of the change, not how to fill the field. */
  warning?: boolean;
  /** The hint repeats what the field already shows, so only screen readers get it. */
  quietHint?: boolean;
  className?: string;
  children: (aria: {
    id: string;
    "aria-invalid"?: true;
    "aria-describedby"?: string;
  }) => ReactNode;
}) {
  const described = [
    error && `${id}-error`,
    hint && `${id}-hint`,
    aside && `${id}-aside`,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      {aside ? (
        // The fact sits right after its label, where it is read as part of
        // it (claude D-114), not at the far end of the row.
        <div className="flex items-center gap-2">
          <Label htmlFor={id}>{label}</Label>
          <span id={`${id}-aside`} className="shrink-0">
            {aside}
          </span>
        </div>
      ) : (
        <Label htmlFor={id}>{label}</Label>
      )}
      {children({
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": described || undefined,
      })}
      {error && <FieldMessage id={`${id}-error`}>{error}</FieldMessage>}
      {hint &&
        (warning ? (
          <p
            id={`${id}-hint`}
            className="flex items-start gap-1.5 text-[13px] leading-5 text-warning"
          >
            <TriangleAlertIcon
              aria-hidden="true"
              className="mt-px size-3.5 shrink-0"
            />
            <span>{hint}</span>
          </p>
        ) : (
          <p
            id={`${id}-hint`}
            className={cn(
              "text-[13px] leading-5 text-muted-foreground",
              quietHint && "sr-only",
            )}
          >
            {hint}
          </p>
        ))}
    </div>
  );
}

function FieldMessage({
  id,
  alert,
  children,
}: {
  id: string;
  /** Say it as it appears, for a message that follows no typing. */
  alert?: boolean;
  children: ReactNode;
}) {
  return (
    <p
      id={id}
      role={alert ? "alert" : undefined}
      className="flex items-start gap-1.5 text-[13px] leading-5 text-destructive"
    >
      <CircleAlertIcon
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0"
      />
      <span>{children}</span>
    </p>
  );
}

/** A failed action, in the dialog or row that holds its retry (claude D-80). */
function ActionError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-1.5 text-sm text-destructive"
    >
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * A focusable scroll region that fades its last line while more sits below,
 * so a list cut by a short screen never reads as complete (a11y D-76).
 */
function ScrollCue({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const check = () =>
      setMore(
        element.scrollHeight - element.scrollTop - element.clientHeight > 2,
      );
    check();
    element.addEventListener("scroll", check, { passive: true });
    const observer = new ResizeObserver(check);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => {
      element.removeEventListener("scroll", check);
      observer.disconnect();
    };
  }, [children]);
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      tabIndex={0}
      data-more={more || undefined}
      className="min-h-0 shrink overflow-y-auto rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring data-[more]:[mask-image:linear-gradient(to_bottom,black_calc(100%-1.75rem),transparent)]"
    >
      {children}
    </div>
  );
}

function Card({
  id,
  title,
  meta,
  action,
  children,
  className,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border border-border bg-card",
        className,
      )}
    >
      {/* The action stays on the title row at every width; a long count
          wraps under the title instead of pushing the action down. */}
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h2 id={`${id}-heading`} className="text-base font-semibold">
            {title}
          </h2>
          {meta && (
            <span className="text-sm text-muted-foreground">{meta}</span>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

function Tag({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "draft";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-2 text-[13px] leading-none font-medium",
        tone === "muted" && "border-border-strong text-muted-foreground",
        tone === "draft" && "border-primary/50 text-primary",
      )}
    >
      {tone === "draft" && (
        <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
      )}
      {children}
    </span>
  );
}

/** "Thu, Nov 7 at 19:00 UTC", in the operator's own zone. */
function moment(at: number, now: number) {
  const parts = timeParts(at, now);
  return `${parts.day} at ${parts.time} ${parts.zone}`;
}

function Time({
  at,
  now,
  className,
  relative = true,
}: {
  at: number;
  now: number;
  className?: string;
  relative?: boolean;
}) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={moment(at, now)}
      className={className}
    >
      {relative ? relativeTime(at, now) : moment(at, now)}
    </time>
  );
}

/* ------------------------------------------------------------------ */
/* Forms                                                               */
/* ------------------------------------------------------------------ */

const durationPresets = [
  { label: "30 min", ms: 30 * 60_000 },
  { label: "1 hour", ms: 60 * 60_000 },
  { label: "2 hours", ms: 2 * 60 * 60_000 },
  { label: "4 hours", ms: 4 * 60 * 60_000 },
];
const MAX_WINDOW_MS = 30 * 24 * 60 * 60_000;

type MaintenanceForm = {
  window: MaintenanceWindow | null;
  title: string;
  message: string;
  startDate: Date | null;
  startTime: string;
  /** A preset length, or null to pick the end by hand. */
  duration: number | null;
  endDate: Date | null;
  endTime: string;
  all: boolean;
  componentIds: string[];
  search: string;
  errors: Errors;
};

type ComponentForm = {
  index: number | null;
  kind: ComponentKind;
  /** The chosen machine or game server when adding one. */
  source: StatusSource | null;
  url: string;
  /** What the operator typed. Empty means "use the suggested name". */
  name: string;
  tagId: string;
  public: boolean;
  errors: Errors;
};

type PendingLogo =
  | { kind: "upload"; blob: Blob; url: string; source: string }
  | { kind: "remove" };

const dayStart = (at: number) => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};
/**
 * What makes typed time text unusable on its day: a time daylight saving
 * skips, or a zone label the time can't have there ("7:00 PM EST" on a summer
 * day, codex D-39). The message is the one the field shows. Unreadable text
 * is left to the form's own "Enter a start time" message.
 */
const timeError = (date: Date | null, time: string) => {
  if (!date || !time.trim()) return null;
  const issue = describeTime(time, date);
  return issue?.tone === "error" && issue.kind !== "format"
    ? { kind: issue.kind, message: issue.message }
    : null;
};
/**
 * The instant a field names, or null while it names none. An invalid time is
 * no value, never another instant: "1:30 AM EST" picks the second 1:30 on a
 * day it happens twice (codex D-31), and "7:00 PM EST" on a day in EDT is
 * nothing at all (codex D-39).
 */
const atTime = (date: Date | null, time: string) =>
  date && !timeError(date, time) ? timeOn(date, time) : null;

function windowRange(form: MaintenanceForm) {
  const start = atTime(form.startDate, form.startTime);
  const end =
    form.duration !== null
      ? start === null
        ? null
        : start + form.duration
      : atTime(form.endDate, form.endTime);
  return { start, end };
}

/** Which typed time, if any, is invalid on its day, and why. */
function invalidField(form: MaintenanceForm) {
  const start = timeError(form.startDate, form.startTime);
  if (start) return { field: "start" as const, ...start };
  const end =
    form.duration === null ? timeError(form.endDate, form.endTime) : null;
  if (end) return { field: "end" as const, ...end };
  return null;
}

/**
 * "Starts in 2 days and lasts 2 hours." The line that catches date slips.
 * It never states a time the operator didn't choose: while a typed time is
 * one daylight saving skips, or has a zone label it can't have, it says so
 * instead of any instant.
 * `endError` is true when the field already shows the end-before-start error.
 */
function scheduleSummary(form: MaintenanceForm, now: number, endError = false) {
  const invalid = invalidField(form);
  // The field says what is wrong; the summary only says why it is empty.
  if (invalid) return `Fix the ${invalid.field} time to see when it runs.`;
  const { start, end } = windowRange(form);
  if (start === null) return "Enter a start time to see when it runs.";
  const starts =
    start <= now
      ? `Started ${relativeTime(start, now)}, on ${moment(start, now)}.`
      : `Starts ${relativeTime(start, now)}, on ${moment(start, now)}.`;
  if (end === null) return starts;
  // The start still reads; the field error says what is wrong with the end.
  if (end <= start)
    return endError ? starts : `${starts} The end is before the start.`;
  const length = durationLabel(end - start);
  if (end <= now) return `This window ended ${relativeTime(end, now)}.`;
  if (start <= now)
    return `Started ${relativeTime(start, now)} and ends ${relativeTime(end, now)}, at ${moment(end, now)}.`;
  return `Starts ${relativeTime(start, now)}, on ${moment(start, now)}, and lasts ${length}.`;
}

/** The schedule as a screen reader should hear it when it changes. */
function spokenSchedule(form: MaintenanceForm, now: number) {
  if (invalidField(form)) return "";
  const { start, end } = windowRange(form);
  if (start === null || end === null || end <= start) return "";
  return `Starts ${moment(start, now)} and lasts ${durationLabel(end - start)}.`;
}

/**
 * The operator's zone by name ("America/New_York"), never an abbreviation:
 * EDT or EST depends on the day, and the summary and fields already say which
 * applies, so this line can never contradict them (a11y D-77, claude D-83).
 */
function zoneName(now: number) {
  return (
    Intl.DateTimeFormat().resolvedOptions().timeZone || timeParts(now, now).zone
  );
}

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

/** What Save would change, in the words the save bar and leave prompt use. */
function pendingChanges(
  draft: PageDraft,
  base: StatusPageState,
  published: boolean,
  logo: boolean,
) {
  const saved = draftOf(base);
  const savedByKey = new Map(saved.components.map((c) => [componentKey(c), c]));
  const slug = draft.slugEdited ? draft.slug : slugify(draft.name);
  const slugBreaksLinks = published && base.revision > 0 && slug !== base.slug;
  const items: string[] = [];
  const draftKeys = new Set(draft.components.map(componentKey));
  const added = draft.components.filter(
    (c) => !savedByKey.has(componentKey(c)),
  ).length;
  const removed = saved.components.filter(
    (c) => !draftKeys.has(componentKey(c)),
  ).length;
  const edited = draft.components.filter((c) => {
    const before = savedByKey.get(componentKey(c));
    return (
      before &&
      (before.name !== c.name ||
        before.tagId !== c.tagId ||
        before.public !== c.public)
    );
  }).length;
  const kept = saved.components
    .filter((c) => draftKeys.has(componentKey(c)))
    .map(componentKey);
  const order = draft.components
    .map(componentKey)
    .filter((key) => savedByKey.has(key));
  if (added) items.push(plural(added, "new target"));
  if (removed) items.push(`${plural(removed, "target")} removed`);
  if (edited) items.push(`${plural(edited, "target")} changed`);
  if (JSON.stringify(kept) !== JSON.stringify(order))
    items.push("target order");
  for (const key of Object.keys(draftLabels) as (keyof PageDraft)[]) {
    const differs =
      key === "slug"
        ? slug !== base.slug
        : JSON.stringify(draft[key]) !== JSON.stringify(saved[key]);
    if (differs)
      items.push(
        key === "slug" && slugBreaksLinks
          ? "public address (old links stop working)"
          : draftLabels[key]!,
      );
  }
  if (logo) items.push("logo");
  return items;
}

/** The save bar's account of a rebase, in full: it is the only warning. */
export function mergeNotice(merged: Pick<Rebase, "replaced" | "targets">): {
  text: string;
  items: string[];
  warn: boolean;
} {
  const items: string[] = [];
  if (merged.replaced.length)
    items.push(
      `Your ${joinList(merged.replaced, merged.replaced.length)} ${merged.replaced.length === 1 ? "replaces" : "replace"} the other session's.`,
    );
  for (const t of merged.targets) {
    if (t.kind === "restored")
      items.push(`${t.name} was removed elsewhere. Saving adds it back.`);
    else if (t.kind === "removed")
      items.push(
        t.now === t.name
          ? `${t.name} was changed elsewhere. Saving removes it.`
          : `${t.name} was renamed ${t.now} elsewhere. Saving removes it.`,
      );
    else if (t.kind === "combined")
      items.push(
        t.now === t.name
          ? `${t.name} changed in both sessions. Both changes are kept.`
          : `${t.name} changed in both sessions. Both changes are kept, as ${t.now}.`,
      );
    else if (t.kind === "clash")
      items.push(
        `${t.name} changed in both sessions. Saving uses your ${t.fields}.`,
      );
    else
      items.push(
        t.now === t.name
          ? `${t.name} was also added elsewhere. Saving uses your ${t.fields}.`
          : `${t.name} was also added elsewhere, as ${t.now}. Saving uses your ${t.fields}.`,
      );
  }
  return items.length
    ? { text: "", items, warn: true }
    : {
        text: "Loaded the latest version with your edits on top.",
        items: [],
        warn: false,
      };
}

export function StatusPageAdmin({ identity }: { identity: Identity }) {
  const organization = identity.organization!;
  const canView = identity.permissions.includes("infrastructure.view");
  const canManage = identity.permissions.includes("infrastructure.manage");
  const [state, setState] = useState<StatusPageState | null>(null);
  // The draft and the saved page it was built on. Polls refresh `state` for
  // live status, but while there are edits the base keeps its revision, so
  // Save is checked against the version the operator started from.
  const [edit, setEdit] = useState<{
    base: StatusPageState;
    draft: PageDraft;
  } | null>(null);
  const draft = edit?.draft ?? null;
  const base = edit?.base ?? null;
  const setDraft = useCallback(
    (update: (draft: PageDraft) => PageDraft) =>
      setEdit((value) =>
        value ? { ...value, draft: update(value.draft) } : value,
      ),
    [],
  );
  const [loadError, setLoadError] = useState("");
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const phoneScreen = useMedia(PHONE_QUERY);
  // The server renders no origin so the address matches after hydration.
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
  const [tab, setTab] = useState("overview");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // The Public pill's popover, and where focus goes when it closes when that
  // is not the pill itself (the title link, after Publish).
  const [pillOpen, setPillOpen] = useState(false);
  const pillReturn = useRef<string | null>(null);

  // Save bar
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Errors>({});
  const [saveError, setSaveError] = useState("");
  // A Save that went through: the bar says "Saved" where the operator
  // pressed Save, at the height it had, then leaves (a11y D-R8-01, D-R8-02,
  // claude D-95, codex D-49). Never a toast.
  const [savedBar, setSavedBar] = useState<{
    height: number;
    /** Fixed to the screen edge (phones): it can shrink from its top. */
    fixed: boolean;
    leaving: boolean;
  } | null>(null);
  const [conflict, setConflict] = useState(false);
  // What "Load latest, keep my edits" did. `warn` when it overrode, restored,
  // or removed something the other session decided.
  const [notice, setNoticeState] = useState<{
    text: string;
    items?: string[];
    warn: boolean;
  } | null>(null);
  const setNotice = (text: string, warn = false) =>
    setNoticeState(text ? { text, warn } : null);
  // The merge notice whose whole list is open on a phone (a11y D-71). A new
  // notice starts collapsed again.
  const [openNotice, setOpenNotice] = useState<typeof notice>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);

  // Live actions
  const [publishOpen, setPublishOpen] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [announcing, setAnnouncing] = useState<{
    text: string;
    error: string;
  } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Dialogs
  const [componentForm, setComponentForm] = useState<ComponentForm | null>(
    null,
  );
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceSearch, setSourceSearch] = useState("");
  const [maintenanceForm, setMaintenanceForm] =
    useState<MaintenanceForm | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [completing, setCompleting] = useState<MaintenanceWindow | null>(null);
  const [removing, setRemoving] = useState<MaintenanceWindow | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  // Why the open confirmation's action failed, shown in it (claude D-80).
  const [confirmError, setConfirmError] = useState("");
  const [publishError, setPublishError] = useState("");
  const returnFocus = useRef<string | null>(null);

  // Targets
  // A row being dragged sits in the open gap at `to`, offset by `dy`, and
  // leans a few pixels toward the pointer. The rows it passes slide aside by
  // its height, so the list always shows the order a drop would make, and
  // nothing is ever covered. Nothing changes until the drop.
  const [drag, setDrag] = useState<{
    group: string;
    from: number;
    to: number;
    dy: number;
    height: number;
    /** Passed rows still sliding to their new place, drawn above the held one. */
    settling: number[];
  } | null>(null);
  const pointerDrag = useRef<{
    group: string;
    from: number;
    pointerId: number;
    grip: HTMLElement;
    x: number;
    y: number;
    clientY: number;
    moved: boolean;
    to: number;
    /** Row tops and heights in the group when the drag began. */
    tops: number[];
    heights: number[];
    scroller: Element;
    scrollTop: number;
    /** The edge-scroll loop's animation frame. */
    frame: number;
    /** Passed rows still sliding, by position, with the timer that lands them. */
    settling: Map<number, number>;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  // Logo
  const logoInput = useRef<HTMLInputElement | null>(null);
  const [logoError, setLogoError] = useState("");
  const [logoRemoveOpen, setLogoRemoveOpen] = useState(false);
  const [logoDrop, setLogoDrop] = useState(false);
  // The image open in the logo editor. Picked files own their object URL.
  const [logoEditing, setLogoEditing] = useState<{
    url: string;
    owned: boolean;
  } | null>(null);
  const [pendingLogo, setPendingLogo] = useState<PendingLogo | null>(null);
  const logoUrl = useStatusLogo(organization.id, state?.logoVersion ?? null);
  // The sheet's width choice. Beside the editor the preview is always the
  // phone frame at real size, so every word is readable; Desktop preview
  // opens the desktop page at real size in the sheet (claude D-50, D-62).
  const [previewWidth, setPreviewWidth] = useState<"desktop" | "phone">(
    "phone",
  );

  // Object URLs for picked files and staged logos live until the page closes;
  // a staged logo can be reopened in the editor at any point before saving.
  const objectUrls = useRef(new Set<string>());
  const ownUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    objectUrls.current.add(url);
    return url;
  };
  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  const pageChanged = edit !== null && hasEdits(edit.draft, edit.base);
  const dirty = pageChanged || pendingLogo !== null;
  // Another session saved the page (settings or logo) after this draft,
  // including a staged logo, was started.
  const behind =
    dirty && state !== null && state.revision !== edit!.base.revision;
  // A staged logo holds the base revision like any other edit. Polls read it
  // here because `adopt` is stable across renders.
  const logoStaged = useRef<PendingLogo | null>(null);
  useEffect(() => {
    logoStaged.current = pendingLogo;
  }, [pendingLogo]);
  // The draft as last rendered, for requests that finish after more typing.
  const currentDraft = useRef<PageDraft | null>(null);
  useEffect(() => {
    currentDraft.current = edit?.draft ?? null;
  }, [edit]);

  const adopt = useCallback((next: StatusPageState) => {
    setState(next);
    setEdit((value) => {
      if (!value || (!logoStaged.current && !hasEdits(value.draft, value.base)))
        return { base: next, draft: draftOf(next) };
      return {
        // The same revision is the same saved page with newer health. A newer
        // revision never replaces the base under the operator's edits.
        base: next.revision === value.base.revision ? next : value.base,
        // Live fields are never drafted: always follow the server.
        draft: {
          ...value.draft,
          published: next.published,
          announcement: next.announcement,
        },
      };
    });
    setCheckedAt(Date.now());
    setNow(Date.now());
  }, []);

  const load = useCallback(async () => {
    if (!canView) return;
    setRefreshing(true);
    try {
      adopt(
        await apiRequest<StatusPageState>(
          "status-page",
          undefined,
          organization.id,
        ),
      );
      setLoadError("");
      setRefreshFailed(false);
    } catch (cause) {
      setLoadError(friendly(cause));
      setRefreshFailed(true);
    } finally {
      setRefreshing(false);
    }
  }, [adopt, canView, organization.id]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  // Leaving with unsaved edits asks first, through the workspace guard:
  // links, the command menu, organization switch and sign out, Back, reload,
  // and closing the tab. Its prompt names what is pending.
  const leaveLine =
    edit && state && dirty
      ? pendingChanges(edit.draft, edit.base, state.published, !!pendingLogo)
      : [];
  useUnsavedChanges(dirty && canManage, {
    changes: leaveLine.length
      ? `${sentenceCase(joinList(leaveLine))}.`
      : undefined,
  });

  // The save bar never hides the control in focus: while it is pinned, the
  // scroller's scroll-padding-bottom matches its height, the page reserves
  // that space, and a control that receives focus under it scrolls clear.
  const barRef = useRef<HTMLDivElement | null>(null);
  // What the bar takes at the page end: the padding a fixed bar needs, or
  // the height a bar in the flow has.
  const [barSpace, setBarSpace] = useState({ pad: 0, end: 0 });
  const savedShown = savedBar !== null && !dirty && !saveError && !conflict;
  const barShown =
    !!edit &&
    canManage &&
    (dirty || !!saveError || conflict || behind || savedShown);
  // While "Saved" shows, the page keeps the space it had when Save was
  // pressed, so a phone bar can shrink to one line and nothing moves.
  // Set before the browser lays out the shrunken bar, so its resize is
  // never measured.
  const holdSpace = useRef(false);
  const holdFixed = savedShown && !!savedBar?.fixed;
  useLayoutEffect(() => {
    holdSpace.current = holdFixed;
  }, [holdFixed]);
  useEffect(() => {
    const bar = barRef.current;
    if (!barShown || !bar) return;
    const root = document.documentElement;
    const before = root.style.scrollPaddingBottom;
    const measure = () => {
      const position = getComputedStyle(bar).position;
      const pinned = position === "fixed" || position === "sticky";
      const height = pinned ? bar.offsetHeight + 16 : 0;
      if (!holdSpace.current) {
        root.style.scrollPaddingBottom = pinned ? `${height}px` : before;
        // A fixed bar covers the page end, so reserve its height there too.
        setBarSpace(
          position === "fixed"
            ? { pad: height, end: height }
            : { pad: 0, end: bar.offsetHeight },
        );
        // Bottom toasts (phones and tablets) sit above a pinned bar: a
        // fixed one at the screen edge, or a sticky one 1rem above it (the
        // Toaster reads this).
        root.style.setProperty(
          "--cupboard-bottom-bar",
          position === "fixed"
            ? `${bar.offsetHeight}px`
            : position === "sticky"
              ? `${bar.offsetHeight + 16}px`
              : "0px",
        );
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    window.addEventListener("resize", measure);
    const focusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || bar.contains(target)) return;
      if (
        target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')
      )
        return;
      window.requestAnimationFrame(() => {
        const position = getComputedStyle(bar).position;
        if (position !== "fixed" && position !== "sticky") return;
        const top = bar.getBoundingClientRect().top;
        const rect = target.getBoundingClientRect();
        if (
          rect.bottom <= top - 8 ||
          rect.top >= bar.getBoundingClientRect().bottom
        )
          return;
        scrollParent(target).scrollBy({ top: rect.bottom - top + 16 });
      });
    };
    document.addEventListener("focusin", focusIn);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("focusin", focusIn);
      root.style.scrollPaddingBottom = before;
      root.style.removeProperty("--cupboard-bottom-bar");
    };
  }, [barShown]);

  // When the bar goes (Saved leaving, Discard), the space it took at the page
  // end stays, empty, so the browser never clamps the scroll and moves the
  // field in focus (claude D-97, codex D-50, a11y D-R9-01). It goes with the
  // tab, when the bar comes back, or once it is scrolled out of view, where
  // letting it go moves nothing.
  const [heldSpace, setHeldSpace] = useState<{
    height: number;
    tab: string;
  } | null>(null);
  const [wasShown, setWasShown] = useState(barShown);
  if (barShown !== wasShown) {
    setWasShown(barShown);
    setHeldSpace(
      barShown || barSpace.end === 0 ? null : { height: barSpace.end, tab },
    );
  }
  if (heldSpace && heldSpace.tab !== tab) setHeldSpace(null);
  const spaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!heldSpace) return;
    let frame = 0;
    const check = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const space = spaceRef.current;
        if (!space) return;
        const scroller = scrollParent(space);
        const bottom =
          scroller === document.scrollingElement ||
          scroller === document.documentElement
            ? window.innerHeight
            : scroller.getBoundingClientRect().bottom;
        if (space.getBoundingClientRect().top >= bottom) setHeldSpace(null);
      });
    };
    window.addEventListener("scroll", check, { capture: true, passive: true });
    window.addEventListener("resize", check);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", check, { capture: true });
      window.removeEventListener("resize", check);
    };
  }, [heldSpace]);

  // Where the operator was before reaching the save bar. When the bar goes
  // away under focus (after Save or Discard), focus returns there instead of
  // dropping to the page and scrolling it (claude D-81).
  const lastFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const record = (event: FocusEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        !barRef.current?.contains(target) &&
        !target.closest(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [data-sonner-toaster]',
        )
      )
        lastFocus.current = target;
    };
    document.addEventListener("focusin", record);
    return () => document.removeEventListener("focusin", record);
  }, []);
  useEffect(() => {
    if (barShown) return;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const back = lastFocus.current;
      const fallback = document.querySelector<HTMLElement>(
        '[role="tab"][data-state="active"]',
      );
      (back?.isConnected ? back : fallback)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [barShown]);

  // "Saved" stays 6 seconds, or until the next edit, then the bar fades
  // away (at once with reduced motion). It holds nothing to act on, so a
  // pointer resting on it doesn't keep it (claude D-103).
  // The next edit ends "Saved" for good, so Discard can't bring it back.
  // Adjusted while rendering, as React recommends for a changed value.
  const [wasDirty, setWasDirty] = useState(dirty);
  if (dirty !== wasDirty) {
    setWasDirty(dirty);
    if (dirty && savedBar) setSavedBar(null);
  }
  const savedLeaving = savedBar?.leaving ?? false;
  useEffect(() => {
    if (!savedShown) return;
    const timer = window.setTimeout(
      () => {
        if (savedLeaving) setSavedBar(null);
        else setSavedBar((value) => value && { ...value, leaving: true });
      },
      savedLeaving ? 200 : 6000,
    );
    return () => window.clearTimeout(timer);
  }, [savedShown, savedLeaving]);
  // Save and Discard go when the bar says "Saved" or closes: focus goes back
  // to where the operator was, without scrolling, never into the
  // confirmation. Called before the bar changes, so focus never drops to the
  // page between the two (claude D-102, a11y D-R9-04).
  function focusFromBar() {
    const active = document.activeElement;
    if (active && active !== document.body && !barRef.current?.contains(active))
      return;
    const back = lastFocus.current;
    const fallback = document.querySelector<HTMLElement>(
      '[role="tab"][data-state="active"]',
    );
    (back?.isConnected ? back : fallback)?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (!focusTarget) return;
    const frame = window.requestAnimationFrame(() => {
      const element = document.getElementById(focusTarget);
      element?.scrollIntoView({ block: "center" });
      element?.focus();
      setFocusTarget(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusTarget, tab]);

  if (!canView) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 md:p-6">
        <h2 className="text-base font-semibold">
          Infrastructure viewing required
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask an owner or administrator for infrastructure access to see the
          status page for {organization.name}.
        </p>
      </div>
    );
  }

  if (!state || !draft || !base) {
    return loadError ? (
      <div
        role="alert"
        className="mx-auto max-w-md rounded-xl border border-border bg-card p-6 text-center"
      >
        <CircleAlertIcon
          aria-hidden="true"
          className="mx-auto size-6 text-destructive"
        />
        <h2 className="mt-3 text-base font-semibold">
          Couldn&apos;t load the status page
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
        <Button
          className={cn("mt-5 h-10 px-4", touch)}
          disabled={refreshing}
          onClick={() => void load()}
        >
          {refreshing && <Spinner aria-hidden="true" />}
          Try again
        </Button>
      </div>
    ) : (
      <AdminSkeleton />
    );
  }

  const components = state.components;
  const slug = draft.slugEdited ? draft.slug : slugify(draft.name);
  const savedUrl = `${origin}${publicPath(state.slug)}`;
  const windows = state.maintenance.map((w) => ({
    window: w,
    phase: maintenancePhase(w, now),
  }));
  const current = windows.filter((w) => w.phase === "active");
  const upcoming = windows
    .filter((w) => w.phase === "scheduled")
    .sort((a, b) => a.window.startsAt - b.window.startsAt);
  const hasWindows = current.length > 0 || upcoming.length > 0;
  const past = windows
    .filter((w) => w.phase === "completed")
    .sort((a, b) => windowEnd(b.window) - windowEnd(a.window));
  const tagName = (id: string) =>
    state.tags.find((tag) => tag.id === id)?.name ?? "";
  const available = unusedSources(state.sources, draft.components);
  const saved = draftOf(base);
  // A published page's old address stops working when the slug changes.
  const slugBreaksLinks =
    state.published && base.revision > 0 && slug !== base.slug;
  const savedByKey = new Map(saved.components.map((c) => [componentKey(c), c]));

  /* ---------------- Draft changes ---------------- */

  // A merge warning stays until Save or Discard; it is the operator's only
  // record of what the merge decided. Routine notices give way to the summary.
  const keepWarning = () =>
    setNoticeState((value) => (value?.warn ? value : null));

  function updateDraft(change: Partial<PageDraft>, ...clear: string[]) {
    setDraft((value) => ({ ...value, ...change }));
    setSaveError("");
    keepWarning();
    if (clear.length)
      setFieldErrors((errors) => {
        const next = { ...errors };
        for (const key of clear) delete next[key];
        return next;
      });
  }
  function updateComponents(
    update: (components: ComponentDraft[]) => ComponentDraft[],
  ) {
    setDraft((value) => ({ ...value, components: update(value.components) }));
    setSaveError("");
    keepWarning();
  }

  const changes = pendingChanges(draft, base, state.published, !!pendingLogo);

  function chooseTheme(value: string) {
    if (value in themeOption) updateDraft({ theme: value as StatusTheme });
  }

  /* ---------------- Settings validation and save ---------------- */

  const fieldIds: Record<string, string> = {
    name: "status-name",
    slug: "status-slug",
    supportUrl: "status-support",
    accentColor: "status-accent",
  };
  const idOf = (key: string) =>
    fieldIds[key] ??
    key.replace(/^link-(\d+)-(label|url)$/, "status-link-$1-$2");

  function validate(): [string, string][] {
    const errors: [string, string][] = [];
    if (!draft!.name.trim()) errors.push(["name", "Enter a page name."]);
    if (!validSlug(slug))
      errors.push([
        "slug",
        "Use 1 to 40 lower-case letters, digits, and hyphens. Start and end with a letter or digit.",
      ]);
    if (draft!.supportUrl.trim() && !validHttps(draft!.supportUrl))
      errors.push([
        "supportUrl",
        "Enter a complete https:// link, or leave it empty.",
      ]);
    if (!validColor(draft!.accentColor.trim().toLowerCase()))
      errors.push([
        "accentColor",
        "Enter a six-digit hex code, such as #7cb58d.",
      ]);
    draft!.links.forEach((link, i) => {
      if (!link.label.trim())
        errors.push([`link-${i}-label`, "Give this link a label."]);
      if (!validHttps(link.url))
        errors.push([
          `link-${i}-url`,
          "Enter a complete https:// address, such as https://discord.gg/yourserver.",
        ]);
    });
    return errors;
  }

  /**
   * `next` is the saved page. Edits typed after `sent` was sent (while Save
   * was pending) stay as the new draft on top of it; without `sent`, or with
   * no later edits, nothing is left to protect.
   */
  function settle(next: StatusPageState, sent?: PageDraft) {
    setState(next);
    setEdit((value) => {
      const saved = draftOf(next);
      if (!sent || !value || !editedSince(value.draft, sent))
        return { base: next, draft: saved };
      return { base: next, draft: rebaseDraft(sent, value.draft, saved).draft };
    });
    setCheckedAt(clock());
    setNotice("");
    setConflict(false);
  }

  async function save() {
    if (!state || !draft || !base || saving) return;
    const errors = validate();
    if (errors.length > 0) {
      setFieldErrors(Object.fromEntries(errors));
      setSaveError("");
      setTab("settings");
      setFocusTarget(idOf(errors[0][0]));
      return;
    }
    if (behind) {
      setConflict(true);
      return;
    }
    setFieldErrors({});
    // "Saved" keeps the height the bar had when Save was pressed ("Saving
    // changes..." can wrap it at 834 with the sidebar open).
    const height = barRef.current?.offsetHeight ?? 0;
    const fixed =
      !!barRef.current && getComputedStyle(barRef.current).position === "fixed";
    setSaving(true);
    // Fields stay editable while Save runs: what was sent is kept apart so
    // edits typed in the meantime survive as the next draft.
    const sent = draft;
    const sentLogo = pendingLogo;
    let next = state;
    let pageSaved = false;
    try {
      // The page goes first and is revision-checked against the draft's base.
      // The logo only goes live once the rest of the draft is saved, so a
      // taken address or a conflict never publishes half of one Save.
      // A page that was never saved has no row yet, and a logo can't create
      // one, so its first Save always writes the page.
      if (pageChanged || base.revision === 0) {
        next = await apiRequest<StatusPageState>(
          "status-page",
          {
            revision: base.revision,
            name: draft.name.trim(),
            slug,
            published: state.published,
            announcement: state.announcement,
            supportUrl: draft.supportUrl.trim(),
            theme: draft.theme,
            accentColor: draft.accentColor.trim().toLowerCase(),
            font: draft.font,
            links: draft.links.map((link) => ({
              label: link.label.trim(),
              url: link.url.trim(),
            })),
            footerText: draft.footerText,
            poweredBy: draft.poweredBy,
            components: draft.components,
          },
          organization.id,
        );
        pageSaved = true;
      }
      if (sentLogo) {
        // Revision-checked too: against the page this Save just wrote, or the
        // draft's base when only the logo changed.
        const revision = pageSaved ? next.revision : base.revision;
        try {
          next =
            sentLogo.kind === "upload"
              ? await postLogo(sentLogo.blob, revision)
              : await apiRequest<StatusPageState>(
                  "status-page/logo/remove",
                  { revision },
                  organization.id,
                );
          // A logo staged while this one uploaded stays staged.
          setPendingLogo((value) => (value === sentLogo ? null : value));
        } catch (cause) {
          if (!pageSaved) throw cause;
          // Say exactly what happened: the page is saved, the logo is still
          // staged and goes with the next Save.
          settle(next, sent);
          setSaveError(
            `Saved, except the ${sentLogo.kind === "upload" ? "new logo" : "logo removal"}. ${friendly(cause)}`,
          );
          return;
        }
      }
      // Edits typed while Save ran stay unsaved: say what was saved and what
      // is not, in the bar that stays, never a bare "saved" beside it.
      const typed = currentDraft.current ?? sent;
      const laterLogo =
        logoStaged.current !== null && logoStaged.current !== sentLogo;
      const newer = editedSince(typed, sent)
        ? pendingChanges(
            rebaseDraft(sent, typed, draftOf(next)).draft,
            next,
            next.published,
            laterLogo,
          )
        : laterLogo
          ? ["logo"]
          : [];
      settle(next, sent);
      setSaveError("");
      if (newer.length)
        setNotice(
          `Saved your earlier changes. Not saved yet: ${joinList(newer, newer.length)}.`,
        );
      else {
        // Focus goes back to the field before Save and Discard go, so it
        // never rests on the page in between (claude D-102, a11y D-R9-04).
        focusFromBar();
        setSavedBar({ height, fixed, leaving: false });
      }
    } catch (cause) {
      const text = friendly(cause);
      if (text.includes("another session")) setConflict(true);
      else setSaveError(text);
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (!state) return;
    focusFromBar();
    setEdit({ base: state, draft: draftOf(state) });
    setPendingLogo(null);
    setFieldErrors({});
    setSaveError("");
    setNotice("");
    setConflict(false);
    setDiscardOpen(false);
    announce("Unsaved changes discarded.");
  }

  /** After a conflict: load the latest page and lay the operator's edits on top. */
  async function reloadKeepingEdits() {
    if (!base || !draft) return;
    const from = base;
    setSaving(true);
    try {
      const latest = await apiRequest<StatusPageState>(
        "status-page",
        undefined,
        organization.id,
      );
      // Rebased from the draft as it is now, so nothing typed while the
      // latest version loaded is lost.
      const merged = rebaseDraft(
        draftOf(from),
        currentDraft.current ?? draft,
        draftOf(latest),
      );
      setEdit({ base: latest, draft: merged.draft });
      setState(latest);
      setCheckedAt(clock());
      setConflict(false);
      setSaveError("");
      // A logo staged now (even one staged while the latest version loaded)
      // replaces a logo the other session changed.
      const replaced =
        logoStaged.current && latest.logoVersion !== from.logoVersion
          ? [...merged.replaced, "logo"]
          : merged.replaced;
      setNoticeState(mergeNotice({ ...merged, replaced }));
    } catch (cause) {
      setSaveError(friendly(cause));
    } finally {
      setSaving(false);
    }
  }

  async function reloadDiscarding() {
    setDiscardOpen(false);
    setPendingLogo(null);
    setConflict(false);
    setNotice("");
    setFieldErrors({});
    try {
      const latest = await apiRequest<StatusPageState>(
        "status-page",
        undefined,
        organization.id,
      );
      settle(latest);
    } catch (cause) {
      setSaveError(friendly(cause));
    }
  }

  /** Overview actions go live at once and never touch the draft. */
  async function commitLive(
    change: { published?: boolean; announcement?: string },
    done: string | ((next: StatusPageState) => string),
    fail: (message: string) => void,
  ) {
    if (!state || liveBusy) return false;
    setLiveBusy(true);
    try {
      const saved = draftOf(state);
      const next = await apiRequest<StatusPageState>(
        "status-page",
        {
          revision: state.revision,
          name: state.name,
          slug: state.slug,
          published: state.published,
          announcement: state.announcement,
          supportUrl: state.supportUrl,
          theme: state.theme,
          accentColor: state.accentColor,
          font: state.font,
          links: state.links,
          footerText: state.footerText,
          poweredBy: state.poweredBy,
          components: saved.components,
          ...change,
        },
        organization.id,
      );
      const from = state.revision;
      setState(next);
      setEdit((value) => {
        if (
          !value ||
          (!logoStaged.current && !hasEdits(value.draft, value.base))
        )
          return { base: next, draft: draftOf(next) };
        return {
          // This session's own live change moves the base along with it, as
          // long as the base was current; otherwise the conflict stands.
          base: value.base.revision === from ? next : value.base,
          draft: {
            ...value.draft,
            published: next.published,
            announcement: next.announcement,
          },
        };
      });
      // The page shows the change where it happened (the Published pill,
      // the announcement, Visit status page); screen readers hear it.
      announce(typeof done === "string" ? done : done(next));
      return true;
    } catch (cause) {
      // Shown where the operator retries, never only in a toast.
      fail(friendly(cause));
      return false;
    } finally {
      setLiveBusy(false);
    }
  }

  /* ---------------- Logo (staged until Save changes) ---------------- */

  function editLogoFile(file: File | undefined) {
    if (logoInput.current) logoInput.current.value = "";
    if (!file) return;
    // Shown on the tile until the next file, so the reason stays while the
    // operator picks another. Never also in a toast (a11y D-84, codex D-45).
    const problem = !file.type.startsWith("image/")
      ? "Choose a PNG, JPEG, WebP, GIF, or SVG image."
      : file.size > 20 * 1024 * 1024
        ? "Choose an image no larger than 20 MB."
        : "";
    setLogoError(problem);
    if (problem) return;
    setLogoEditing({ url: ownUrl(file), owned: true });
  }

  async function postLogo(png: Blob, revision: number) {
    const response = await fetch("/app-api/status-page/logo", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        // The page revision this logo replaces; the server refuses a stale one.
        "X-Cupboard-Logo-Revision": String(revision),
        "X-Cupboard-Request": "1",
        "X-Cupboard-Organization": organization.id,
      },
      body: png,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        typeof result?.error === "string"
          ? result.error
          : "The logo could not be uploaded.",
      );
    return result as StatusPageState;
  }

  function stageLogo(png: Blob) {
    if (!logoEditing) return false;
    setPendingLogo({
      kind: "upload",
      blob: png,
      url: ownUrl(png),
      // Reopening a staged logo edits the original image again. The saved
      // logo's URL belongs to its loader, so keep the cropped copy instead.
      source: logoEditing.owned ? logoEditing.url : ownUrl(png),
    });
    announce("Logo ready. Save changes to put it on the page.");
    return true;
  }

  const shownLogo =
    pendingLogo?.kind === "upload"
      ? pendingLogo.url
      : pendingLogo?.kind === "remove"
        ? null
        : logoUrl;

  async function copyUrl() {
    try {
      await copyText(savedUrl);
      setCopyFailed(false);
      setCopied(true);
      announce("Public address copied.");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Beside the address in the pill, which is selected for the operator
      // to copy: never only in a toast that leaves before it is read.
      setCopyFailed(true);
    }
  }

  function announce(text: string) {
    // A changed string is what screen readers notice; nudge repeats.
    setAnnouncement((previous) => (previous === text ? `${text} ` : text));
  }

  /* ---------------- Maintenance ---------------- */

  function openSchedule(window: MaintenanceWindow | null, focusKey: string) {
    returnFocus.current = focusKey;
    const start = window ? window.startsAt : Math.ceil(now / 900_000) * 900_000;
    const end = window ? window.endsAt : start + 60 * 60_000;
    const length = end - start;
    setMaintenanceForm({
      window,
      title: window?.title ?? "",
      message: window?.message ?? "",
      startDate: dayStart(start),
      startTime: timeTextAt(start),
      duration: durationPresets.some((p) => p.ms === length) ? length : null,
      endDate: dayStart(end),
      endTime: timeTextAt(end),
      all: window ? window.componentIds.length === 0 : true,
      componentIds: window?.componentIds ?? [],
      search: "",
      errors: {},
    });
  }

  function patchMaintenance(
    change: Partial<MaintenanceForm>,
    ...clear: string[]
  ) {
    setMaintenanceForm((form) => {
      if (!form) return form;
      const errors = { ...(change.errors ?? form.errors) };
      for (const key of clear) delete errors[key];
      if (!change.errors) delete errors.general;
      return { ...form, ...change, errors };
    });
  }

  async function submitMaintenance(event: FormEvent) {
    event.preventDefault();
    if (!maintenanceForm || maintenanceBusy) return;
    const form = maintenanceForm;
    const title = form.title.trim();
    const { start, end } = windowRange(form);
    const errors: [string, string][] = [];
    if (!title) errors.push(["title", "Enter a title."]);
    // A skipped time or a wrong zone label is no value (codex D-39): say why
    // in the field's own words instead of asking for a time.
    const startInvalid = timeError(form.startDate, form.startTime)?.message;
    const endInvalid =
      form.duration === null
        ? timeError(form.endDate, form.endTime)?.message
        : undefined;
    if (startInvalid) errors.push(["start-time", startInvalid]);
    else if (start === null)
      errors.push([
        form.startDate ? "start-time" : "start-date",
        form.startDate
          ? `Enter a start time, such as ${timeExample()}.`
          : "Choose a start date.",
      ]);
    if (endInvalid) errors.push(["end-time", endInvalid]);
    else if (form.duration === null && end === null)
      errors.push([
        form.endDate ? "end-time" : "end-date",
        form.endDate
          ? `Enter an end time, such as ${timeExample()}.`
          : "Choose an end date.",
      ]);
    if (start !== null && end !== null) {
      if (end <= start)
        errors.push(["end-time", "The window must end after it starts."]);
      else if (end - start > MAX_WINDOW_MS)
        errors.push([
          "end-date",
          "A maintenance window can last up to 30 days.",
        ]);
      else if (!form.window && end <= now)
        errors.push([
          form.duration === null ? "end-time" : "start-time",
          "This window would already be over. Pick a later time.",
        ]);
    }
    if (!form.all && form.componentIds.length === 0)
      errors.push(["targets", "Choose at least one affected target."]);
    if (errors.length > 0) {
      patchMaintenance({ errors: Object.fromEntries(errors) });
      focusByKey(`maintenance-${errors[0][0]}`);
      return;
    }
    setMaintenanceBusy(true);
    try {
      const next = await apiRequest<StatusPageState>(
        form.window
          ? `status-page/maintenance/${form.window.id}`
          : "status-page/maintenance",
        {
          title,
          message: form.message,
          startsAt: start,
          endsAt: end,
          componentIds: form.all ? [] : form.componentIds,
        },
        organization.id,
      );
      adopt(next);
      setMaintenanceForm(null);
      // The window's row shows it; focus goes back to the opener.
      announce(
        form.window ? "Maintenance window updated." : "Maintenance scheduled.",
      );
    } catch (cause) {
      patchMaintenance({ errors: { general: friendly(cause) } });
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function runAction(path: string, done: string, clear: () => void) {
    if (actionBusy) return;
    setActionBusy(true);
    setConfirmError("");
    try {
      adopt(await apiRequest<StatusPageState>(path, {}, organization.id));
      clear();
      announce(done);
    } catch (cause) {
      setConfirmError(friendly(cause));
    } finally {
      setActionBusy(false);
    }
  }

  /* ---------------- Targets ---------------- */

  function openComponent(index: number | null, focusKey: string) {
    returnFocus.current = focusKey;
    setSourceSearch("");
    if (index === null) {
      setComponentForm({
        index: null,
        kind: "url",
        source: null,
        url: "",
        name: "",
        tagId: "",
        public: true,
        errors: {},
      });
      return;
    }
    const component = draft!.components[index];
    setComponentForm({
      index,
      kind: component.kind,
      source: null,
      url: component.kind === "url" ? component.sourceId : "",
      name: component.name,
      tagId: component.tagId,
      public: component.public,
      errors: {},
    });
  }

  /**
   * The name a target gets when the operator leaves Display name empty: the
   * website's host or the machine or server's own name. It is shown as the
   * field's placeholder and never written into the field, so typing always
   * starts from an empty field.
   */
  function suggestedName(form: ComponentForm) {
    if (form.kind === "url") return hostName(form.url);
    if (form.source) return form.source.name;
    if (form.index !== null)
      return sourceName(draft!.components[form.index]) ?? "";
    return "";
  }

  function chooseKind(kind: string) {
    if (kind === "url" || kind === "machine" || kind === "server")
      patchComponent({ kind, source: null, errors: {} });
  }

  function patchComponent(change: Partial<ComponentForm>, ...clear: string[]) {
    setComponentForm((form) => {
      if (!form) return form;
      const errors = { ...(change.errors ?? form.errors) };
      for (const key of clear) delete errors[key];
      if (!change.errors) delete errors.general;
      return { ...form, ...change, errors };
    });
  }

  function submitComponent(event: FormEvent) {
    event.preventDefault();
    if (!componentForm || !draft) return;
    const form = componentForm;
    const name = form.name.trim() || suggestedName(form);
    const errors: [string, string][] = [];
    if (form.index === null && draft.components.length >= maxComponents)
      errors.push([
        "general",
        `A status page can list up to ${maxComponents} targets. Remove one first.`,
      ]);
    let sourceId = "";
    if (form.kind === "url") {
      sourceId = form.url.trim();
      if (!validTargetUrl(sourceId))
        errors.push([
          "url",
          "Enter a complete address that starts with http:// or https://.",
        ]);
      else if (
        draft.components.some(
          (c, i) =>
            i !== form.index &&
            c.kind === "url" &&
            sameUrl(c.sourceId, sourceId),
        )
      )
        errors.push(["url", "That address is already a target."]);
    } else if (form.index === null) {
      if (!form.source)
        errors.push([
          "source",
          form.kind === "machine"
            ? "Choose a machine to show."
            : "Choose a game server to show.",
        ]);
      else sourceId = form.source.id;
    } else {
      sourceId = draft.components[form.index].sourceId;
    }
    if (!name) errors.push(["name", "Enter the name players will see."]);
    if (errors.length > 0) {
      patchComponent({ errors: Object.fromEntries(errors) });
      focusByKey(`component-${errors[0][0]}`);
      return;
    }
    const values = { name, sourceId, tagId: form.tagId, public: form.public };
    const key = componentKey({ kind: form.kind, sourceId });
    if (form.index === null) {
      updateComponents((list) => [
        ...list,
        { id: null, kind: form.kind, ...values },
      ]);
      announce(`Added ${name}. Save changes to put it on the page.`);
    } else {
      updateComponents((list) =>
        list.map((c, i) => (i === form.index ? { ...c, ...values } : c)),
      );
      announce(`Updated ${name}. Save changes to apply it.`);
    }
    returnFocus.current = `actions-${key}`;
    setComponentForm(null);
  }

  function chooseSource(source: StatusSource) {
    setComponentForm((form) =>
      form
        ? {
            ...form,
            source,
            // A machine's first tag is the natural group.
            tagId:
              form.tagId ||
              (source.tags.find((id) => state!.tags.some((t) => t.id === id)) ??
                ""),
            errors: {},
          }
        : form,
    );
    setSourceOpen(false);
    focusByKey("component-source");
  }

  /* Live drag. The grip owns the pointer while it is down; rows keep their
     DOM order and move with transforms until the drop commits one move. */

  function scrollOf(scroller: Element) {
    return scroller === document.scrollingElement ||
      scroller === document.documentElement
      ? window.scrollY
      : scroller.scrollTop;
  }

  function startDrag(
    event: ReactPointerEvent<HTMLElement>,
    group: string,
    from: number,
  ) {
    const grip = event.currentTarget;
    const list = grip.closest("ul");
    if (!list) return;
    const rows = [
      ...list.querySelectorAll<HTMLElement>(":scope > li[data-position]"),
    ].sort((a, b) => Number(a.dataset.position) - Number(b.dataset.position));
    const rects = rows.map((row) => row.getBoundingClientRect());
    const scroller = scrollParent(list);
    pointerDrag.current = {
      group,
      from,
      pointerId: event.pointerId,
      grip,
      x: event.clientX,
      y: event.clientY,
      clientY: event.clientY,
      moved: false,
      to: from,
      tops: rects.map((rect) => rect.top),
      heights: rects.map((rect) => rect.height),
      scroller,
      scrollTop: scrollOf(scroller),
      frame: 0,
      settling: new Map(),
    };
    // Near the top or bottom of the screen the page scrolls under a held
    // row, so a long group can be crossed without letting go.
    const edge = () => {
      const current = pointerDrag.current;
      if (!current) return;
      if (current.moved) {
        const zone = 48;
        const step =
          current.clientY < zone
            ? -12
            : current.clientY > window.innerHeight - zone
              ? 12
              : 0;
        if (step) {
          const before = scrollOf(current.scroller);
          current.scroller.scrollBy({ top: step });
          if (scrollOf(current.scroller) !== before) dragTo(current.clientY);
        }
      }
      current.frame = window.requestAnimationFrame(edge);
    };
    pointerDrag.current.frame = window.requestAnimationFrame(edge);
  }

  /** Works out where the dragged row lands and puts it in that gap. */
  function dragTo(clientY: number) {
    const current = pointerDrag.current;
    if (!current) return;
    current.clientY = clientY;
    const { tops, heights, from } = current;
    const last = tops.length - 1;
    // Where the pointer would put the row, kept inside its group: rows
    // reorder only within one.
    const travel = Math.min(
      Math.max(
        clientY - current.y + scrollOf(current.scroller) - current.scrollTop,
        tops[0] - tops[from],
      ),
      tops[last] + heights[last] - heights[from] - tops[from],
    );
    // A row slides aside once the held row's leading edge covers half of
    // it, so a passed row is never hidden under the one being dragged
    // (a11y D-R11-01). The test uses each row's place when the drag began,
    // so turning back returns it at the same point.
    const top = tops[from] + travel;
    const bottom = top + heights[from];
    let to = from;
    for (let i = from + 1; i <= last; i++)
      if (bottom >= tops[i] + heights[i] / 2) to = i;
    for (let i = from - 1; i >= 0; i--)
      if (top <= tops[i] + heights[i] / 2) to = i;
    // The held row stays in the gap that opened for it and leans toward the
    // pointer by at most DRAG_LEAN pixels, inside the passed row's padding,
    // so it never covers a name, status or address (claude D-119).
    const slot =
      to > from
        ? tops[to] + heights[to] - tops[from] - heights[from]
        : to < from
          ? tops[to] - tops[from]
          : 0;
    const dy = slot + Math.min(Math.max(travel - slot, -DRAG_LEAN), DRAG_LEAN);
    // Rows that change place at this move slide over the held row while
    // the two cross, then settle back under it.
    if (to !== current.to) {
      const moved = (position: number, at: number) =>
        (position > from && position <= at) ||
        (position < from && position >= at);
      for (let i = 0; i <= last; i++) {
        if (i === from || moved(i, current.to) === moved(i, to)) continue;
        window.clearTimeout(current.settling.get(i));
        current.settling.set(
          i,
          window.setTimeout(() => landRow(i), DRAG_SETTLE_MS),
        );
      }
    }
    current.to = to;
    setDrag({
      group: current.group,
      from,
      to,
      dy,
      height: heights[from],
      settling: [...current.settling.keys()],
    });
  }

  /** A passed row has reached its new place: it goes back under the held row. */
  function landRow(position: number) {
    const current = pointerDrag.current;
    if (!current?.settling.has(position)) return;
    window.clearTimeout(current.settling.get(position));
    current.settling.delete(position);
    setDrag(
      (value) => value && { ...value, settling: [...current.settling.keys()] },
    );
  }

  function endDrag(commit: boolean) {
    const current = pointerDrag.current;
    if (!current) return;
    pointerDrag.current = null;
    window.cancelAnimationFrame(current.frame);
    for (const timer of current.settling.values()) window.clearTimeout(timer);
    setDrag(null);
    if (current.grip.hasPointerCapture?.(current.pointerId))
      current.grip.releasePointerCapture(current.pointerId);
    if (!current.moved) return;
    if (!commit) announce("Move cancelled.");
    else if (current.to !== current.from)
      reorderInGroup(current.group, current.from, current.to);
  }

  /** Reorders inside one group, so the list always matches the public page. */
  function reorderInGroup(group: string, from: number, to: number) {
    const list = draft!.components;
    const positions = list
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => tagName(c.tagId) === group)
      .map(({ i }) => i);
    if (to < 0 || to >= positions.length || from === to) return;
    const items = moveComponent(
      positions.map((i) => list[i]),
      from,
      to,
    );
    const next = [...list];
    positions.forEach((p, k) => (next[p] = items[k]));
    updateComponents(() => next);
    announce(
      `${items[to].name} moved to position ${to + 1} of ${items.length}${group ? ` in ${group}` : ""}.`,
    );
  }

  function removeComponent(index: number) {
    if (!draft) return;
    const list = draft.components;
    const removed = list[index];
    const group = tagName(removed.tagId);
    const peers = list.filter((c) => tagName(c.tagId) === group);
    const at = peers.indexOf(removed);
    const neighbor = peers[at + 1] ?? peers[at - 1] ?? null;
    updateComponents((items) => items.filter((_, i) => i !== index));
    announce(`Removed ${removed.name}. Save changes to take it off the page.`);
    focusByKey(neighbor && `actions-${componentKey(neighbor)}`, "add-target");
  }

  const sourceName = (component: ComponentDraft) =>
    component.kind === "url"
      ? component.sourceId
      : (state.sources.find(
          (s) => s.kind === component.kind && s.id === component.sourceId,
        )?.name ?? null);

  const liveOf = (component: ComponentDraft) =>
    components.find(
      (c) => c.kind === component.kind && c.sourceId === component.sourceId,
    ) ?? null;

  const hiddenCount = draft.components.filter((c) => !c.public).length;

  // The preview renders what visitors would get after saving: public targets
  // only, and the same maintenance the public endpoint returns.
  const previewData = (): PublicStatus => {
    const shown = draft.components
      .filter((c) => c.public)
      .map((c) => {
        const live = liveOf(c);
        return {
          id: c.id ?? componentKey(c),
          name: c.name,
          groupName: tagName(c.tagId),
          health: live?.health ?? ("unknown" as const),
          observedAt: live?.observedAt ?? null,
        };
      });
    return {
      name: draft.name.trim() || state.name,
      announcement: state.announcement,
      supportUrl: draft.supportUrl.trim(),
      theme: draft.theme,
      accentColor: validColor(draft.accentColor.trim().toLowerCase())
        ? draft.accentColor.trim().toLowerCase()
        : state.accentColor,
      font: draft.font,
      links: draft.links
        .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
        .filter((link) => link.label && link.url),
      footerText: draft.footerText.trim(),
      poweredBy: draft.poweredBy,
      logoVersion: shownLogo ? (state.logoVersion ?? 0) : null,
      updatedAt: checkedAt ?? now,
      components: shown,
      maintenance: publicMaintenance(
        state.maintenance,
        shown.map((c) => c.id),
        now,
      ),
    };
  };

  const previewed = previewData();
  const preview = (
    <PreviewFrame
      data={previewed}
      logoUrl={shownLogo}
      now={now}
      // Under 640 pixels the toggle is hidden: the screen is a phone already.
      width={phoneScreen ? "phone" : previewWidth}
    />
  );
  const sidePreview = (
    <PreviewFrame
      data={previewed}
      logoUrl={shownLogo}
      now={now}
      width="phone"
    />
  );

  // The Overview's first card: setup steps on an empty page, else targets.
  const setup = (
    <SetupCard
      canManage={canManage}
      published={state.published}
      onAdd={() => {
        setTab("targets");
        openComponent(null, "add-target");
      }}
      onSettings={() => setTab("settings")}
    />
  );
  const healthCard = (
    <TargetHealth
      components={components}
      maintenance={state.maintenance}
      now={now}
      checkedAt={checkedAt}
      stale={refreshFailed}
      refreshing={refreshing}
      onRetry={() => void load()}
      onManage={() => setTab("targets")}
      phone={phoneScreen}
    />
  );

  const conflicted = conflict || behind;
  const showBar =
    canManage && (dirty || !!saveError || conflicted || savedShown);
  const errorCount = Object.keys(fieldErrors).length;
  // The bar with nothing to report but the edits themselves.
  const quietBar =
    !conflicted && errorCount === 0 && !saveError && !notice?.warn;

  /* ---------------- Render ---------------- */

  return (
    <div
      className="space-y-6"
      style={
        showBar && barSpace.pad ? { paddingBottom: barSpace.pad } : undefined
      }
    >
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {/* Header: the title, a link to the public page while it is public,
          and the Public pill, which holds the saved address, Copy, and
          Publish or Unpublish. Visiting is the title, previewing happens in
          the editors, and scheduling in the Maintenance card, so the header
          carries nothing else (the operator's round 11 notes). */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight">
          {state.published ? (
            <a
              href={publicPath(state.slug)}
              target="_blank"
              rel="noreferrer"
              data-focus-key="visit"
              className="group/title inline-flex items-center gap-1.5 rounded-md underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [@media(any-pointer:coarse)]:min-h-11"
            >
              Status page
              <ArrowUpRightIcon
                aria-hidden="true"
                className="size-5 shrink-0 text-muted-foreground transition-colors group-hover/title:text-foreground"
              />
              {/* Not the same name as the sidebar's Status page, which
                  opens this admin page (a11y round 11, 3.2.4). */}
              <span className="sr-only">, public page, opens in a new tab</span>
            </a>
          ) : (
            "Status page"
          )}
        </h1>
        <PublicationPill
          published={state.published}
          canManage={canManage}
          url={savedUrl}
          open={pillOpen}
          onOpenChange={(open) => {
            setPillOpen(open);
            if (!open) {
              setCopyFailed(false);
              setPublishError("");
            }
          }}
          returnFocusRef={pillReturn}
          busy={liveBusy}
          publishError={publishError}
          copied={copied}
          copyFailed={copyFailed}
          onCopy={() => void copyUrl()}
          onPublish={() => {
            setPublishError("");
            // Publishing goes live at once and never saves drafted edits.
            // The title becomes the link to the page: focus follows it.
            void commitLive(
              { published: true },
              (next) => `Status page published. ${playersSee(next)}`,
              setPublishError,
            ).then((done) => {
              if (!done) return;
              pillReturn.current = "visit";
              setPillOpen(false);
            });
          }}
          onUnpublish={() => {
            setPillOpen(false);
            setPublishOpen(true);
          }}
        />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center gap-1 border-b border-border sm:gap-2">
          <TabsList
            variant="line"
            className="h-10 min-w-0 flex-1 justify-start gap-0 rounded-none p-0 [@media(any-pointer:coarse)]:h-[45px]"
          >
            {(
              [
                ["overview", "Overview", false],
                [
                  "targets",
                  "Targets",
                  draft.components.length !== saved.components.length ||
                    JSON.stringify(draft.components) !==
                      JSON.stringify(saved.components),
                ],
                [
                  "settings",
                  "Settings",
                  pendingLogo !== null ||
                    !sameDraft(
                      { ...draft, components: saved.components },
                      saved,
                    ) ||
                    errorCount > 0,
                ],
              ] as const
            ).map(([value, label, changed]) => (
              <TabsTrigger
                key={value}
                value={value}
                className="h-full flex-none rounded-none px-2 sm:px-3 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:after:bottom-[-1px] data-[state=active]:after:bg-primary dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent dark:data-[state=active]:text-foreground"
              >
                {label}
                {changed && (
                  <>
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-primary"
                    />
                    <span className="sr-only">(unsaved changes)</span>
                  </>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          {/* Preview lives where public-facing edits happen: Targets and
              Settings, at every width, with unsaved changes and on a
              private page. Wide Settings shows its own preview column. */}
          {(tab === "targets" || tab === "settings") && (
            <Button
              type="button"
              variant="ghost"
              data-focus-key="preview-page"
              className={cn(
                "h-9 shrink-0 px-3 max-sm:size-11 max-sm:px-0",
                touch,
                tab === "settings" && "xl:hidden",
              )}
              onClick={() => {
                returnFocus.current = "preview-page";
                setPreviewOpen(true);
              }}
            >
              <MonitorSmartphoneIcon aria-hidden="true" />
              {/* Phones keep the name and show the glyph: the three tabs
                  and a worded button don't fit 320 pixels. */}
              <span className="max-sm:sr-only">Preview</span>
            </Button>
          )}
        </div>

        {/* ---------------- Overview ---------------- */}
        <TabsContent value="overview" className="mt-5 space-y-6">
          {/* The true status of every target leads (or the setup steps on
              an empty page), full width; Maintenance and the Announcement
              sit side by side below it on wide screens. DOM order is
              reading order at every width (a11y D-30). */}
          {components.length > 0 ? healthCard : setup}
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <Card
              id="maintenance"
              title="Maintenance"
              action={
                // Empty, the card's own button sits under its message.
                canManage &&
                hasWindows && (
                  <Button
                    type="button"
                    variant="ghost"
                    data-focus-key="schedule"
                    aria-label="Schedule maintenance"
                    className={cn("h-9 px-3", touch)}
                    onClick={() => openSchedule(null, "schedule")}
                  >
                    <PlusIcon aria-hidden="true" />
                    Schedule
                  </Button>
                )
              }
            >
              {!hasWindows ? (
                // Stacked like the Machines empty state: icon, message, then
                // the button below (claude D-118). Compact padding keeps it
                // close to one window's height (claude D-117).
                <Empty className="gap-0 rounded-none border-0 px-4 py-4 md:px-5">
                  {/* The tile a window row carries, so the empty card
                      reads as the same list with nothing in it. */}
                  <EmptyMedia
                    variant="icon"
                    className="mb-2 border border-border-strong bg-surface-elevated text-foreground/80"
                  >
                    <CalendarClockIcon aria-hidden="true" />
                  </EmptyMedia>
                  {/* A paragraph, not a heading: the card's Maintenance
                      heading already names the section. */}
                  <p className="text-sm font-medium">
                    No maintenance scheduled
                  </p>
                  {canManage && (
                    <Button
                      type="button"
                      variant="outline"
                      data-focus-key="schedule-empty"
                      className={cn("mt-3 h-9 px-3", touch)}
                      onClick={() => openSchedule(null, "schedule-empty")}
                    >
                      <PlusIcon aria-hidden="true" />
                      Schedule maintenance
                    </Button>
                  )}
                </Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {[...current, ...upcoming].map(({ window, phase }) => (
                    <MaintenanceRow
                      key={window.id}
                      window={window}
                      phase={phase}
                      now={now}
                      components={components}
                      canManage={canManage}
                      onEdit={() => openSchedule(window, `window-${window.id}`)}
                      onComplete={() => {
                        returnFocus.current = `window-${window.id}`;
                        setCompleting(window);
                      }}
                      onRemove={() => {
                        returnFocus.current = `window-${window.id}`;
                        setRemoving(window);
                      }}
                    />
                  ))}
                </ul>
              )}
              {past.length > 0 && (
                <Collapsible className="group/past border-t border-border">
                  <CollapsibleTrigger
                    data-focus-key="past-windows"
                    className={cn(
                      "flex h-11 w-full items-center gap-2 px-4 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-surface-elevated/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5",
                    )}
                  >
                    <ChevronRightIcon
                      aria-hidden="true"
                      className="size-4 transition-transform group-data-[state=open]/past:rotate-90"
                    />
                    Past windows
                    <span className="ml-auto text-xs tabular-nums">
                      {past.length}
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ul className="divide-y divide-border border-t border-border">
                      {past.map(({ window, phase }) => (
                        <MaintenanceRow
                          key={window.id}
                          window={window}
                          phase={phase}
                          now={now}
                          components={components}
                          canManage={canManage}
                          onRemove={() => {
                            returnFocus.current = "past-windows";
                            setRemoving(window);
                          }}
                        />
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </Card>

            <Card
              id="announcement"
              title="Announcement"
              action={
                canManage && (
                  <Button
                    type="button"
                    variant="ghost"
                    data-focus-key="announcement"
                    aria-label={
                      state.announcement
                        ? "Edit announcement"
                        : "Post an announcement"
                    }
                    className={cn("h-9 px-3", touch)}
                    onClick={() => {
                      returnFocus.current = "announcement";
                      setAnnouncing({
                        text: state.announcement,
                        error: "",
                      });
                    }}
                  >
                    {state.announcement ? (
                      <>
                        <PencilIcon aria-hidden="true" />
                        Edit
                      </>
                    ) : (
                      <>
                        <MegaphoneIcon aria-hidden="true" />
                        Post
                      </>
                    )}
                  </Button>
                )
              }
            >
              <div className="px-4 py-4 md:px-5">
                {state.announcement ? (
                  <p className="text-sm whitespace-pre-line">
                    {state.announcement}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No announcement.
                  </p>
                )}
              </div>
            </Card>
          </div>
        </TabsContent>

        {/* ---------------- Targets ---------------- */}
        <TabsContent value="targets" className="mt-5">
          <fieldset disabled={!canManage} className="min-w-0 space-y-4">
            <legend className="sr-only">Targets</legend>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground tabular-nums">
                {draft.components.length > 0 &&
                  `${plural(draft.components.length, "target")}${hiddenCount ? `, ${hiddenCount} hidden` : ""}`}
              </p>
              {canManage && (
                <Button
                  type="button"
                  variant="outline"
                  data-focus-key="add-target"
                  className={cn("h-10 px-4", touch)}
                  onClick={() => openComponent(null, "add-target")}
                >
                  <PlusIcon aria-hidden="true" />
                  Add target
                </Button>
              )}
            </div>

            {draft.components.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border-strong px-5 py-10 text-center">
                <p className="text-sm font-medium">No targets yet</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                  Add a website, machine, or game server.
                </p>
              </div>
            ) : (
              // Contained so long addresses truncate instead of widening the
              // whole workspace column on tablets.
              <div className="overflow-hidden rounded-xl border border-border bg-card [contain:inline-size]">
                {groupComponents(
                  draft.components.map((component, index) => ({
                    component,
                    index,
                    groupName: tagName(component.tagId),
                  })),
                ).map((group) => {
                  const hidden = group.items.filter(
                    (item) => !item.component.public,
                  ).length;
                  return (
                    <section
                      key={group.name || "(ungrouped)"}
                      aria-label={group.name || "Ungrouped targets"}
                      className="border-b border-border last:border-b-0"
                    >
                      <div className="flex items-baseline gap-2 border-b border-border bg-surface-elevated/50 px-4 py-2 md:px-5">
                        <h2 className="text-xs font-medium text-foreground">
                          {group.name || "No group"}
                        </h2>
                        <span className="text-xs text-muted-foreground">
                          {plural(group.items.length, "target")}
                          {hidden ? `, ${hidden} hidden` : ""}
                        </span>
                      </div>
                      <ul className="divide-y divide-border">
                        {group.items.map(({ component, index }, position) => {
                          const key = componentKey(component);
                          const before = savedByKey.get(key);
                          const live = liveOf(component);
                          const status: ComponentStatus | null =
                            live && component.id
                              ? componentStatus(live, state.maintenance, now)
                              : null;
                          const source = sourceName(component);
                          const statusText = status
                            ? statusLabel[status]
                            : "Checked after saving";
                          const KindGlyph = kindIcon[component.kind];
                          const changed = !before
                            ? "New"
                            : before.name !== component.name ||
                                before.tagId !== component.tagId ||
                                before.public !== component.public
                              ? "Edited"
                              : null;
                          const dragging =
                            drag?.group === group.name ? drag : null;
                          const lifted = dragging?.from === position;
                          // Rows the dragged one passes slide by its height.
                          const shift = !dragging
                            ? 0
                            : lifted
                              ? dragging.dy
                              : position > dragging.from &&
                                  position <= dragging.to
                                ? -dragging.height
                                : position < dragging.from &&
                                    position >= dragging.to
                                  ? dragging.height
                                  : 0;
                          const settling =
                            !lifted && !!dragging?.settling.includes(position);
                          return (
                            <li
                              key={key}
                              data-group={group.name}
                              data-position={position}
                              data-dragging={lifted || undefined}
                              data-settling={settling || undefined}
                              onTransitionEnd={(event) => {
                                if (
                                  settling &&
                                  event.target === event.currentTarget &&
                                  event.propertyName === "transform"
                                )
                                  landRow(position);
                              }}
                              style={
                                dragging
                                  ? { transform: `translateY(${shift}px)` }
                                  : undefined
                              }
                              className={cn(
                                "relative flex min-h-16 items-center gap-2 bg-card py-2 pr-2 pl-4 md:gap-3 md:pr-3 md:pl-2",
                                // Rows slide only while a drag is on, so the
                                // drop itself never animates backwards. The
                                // held row and the row it passes move to their
                                // slots together, instantly with reduced motion.
                                dragging &&
                                  "transition-transform duration-120 ease-out motion-reduce:transition-none",
                                lifted &&
                                  "z-10 cursor-grabbing rounded-lg bg-surface-elevated shadow-xl ring-1 ring-border-strong",
                                // A passed row crosses above the held one, so
                                // its text is never hidden mid-slide.
                                settling && "z-20",
                              )}
                            >
                              {canManage && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-sm"
                                      className="hidden size-8 shrink-0 cursor-grab touch-none text-muted-foreground active:cursor-grabbing md:inline-flex [@media(any-pointer:coarse)]:size-11"
                                      aria-label={`Reorder ${component.name}`}
                                      aria-describedby="reorder-hint"
                                      onPointerDown={(event) => {
                                        if (event.button !== 0) return;
                                        event.preventDefault();
                                        event.currentTarget.focus();
                                        event.currentTarget.setPointerCapture?.(
                                          event.pointerId,
                                        );
                                        startDrag(event, group.name, position);
                                      }}
                                      onPointerMove={(event) => {
                                        const current = pointerDrag.current;
                                        if (
                                          !current ||
                                          current.pointerId !== event.pointerId
                                        )
                                          return;
                                        if (
                                          !current.moved &&
                                          Math.hypot(
                                            event.clientX - current.x,
                                            event.clientY - current.y,
                                          ) < 5
                                        )
                                          return;
                                        current.moved = true;
                                        dragTo(event.clientY);
                                      }}
                                      onPointerUp={(event) => {
                                        if (
                                          pointerDrag.current?.pointerId ===
                                          event.pointerId
                                        )
                                          endDrag(true);
                                      }}
                                      onPointerCancel={() => endDrag(false)}
                                      onKeyDown={(event) => {
                                        // Escape puts a dragged row back.
                                        if (
                                          event.key === "Escape" &&
                                          pointerDrag.current
                                        ) {
                                          event.preventDefault();
                                          endDrag(false);
                                          return;
                                        }
                                        if (pointerDrag.current) return;
                                        if (
                                          event.key === "ArrowUp" ||
                                          event.key === "ArrowDown"
                                        ) {
                                          event.preventDefault();
                                          reorderInGroup(
                                            group.name,
                                            position,
                                            position +
                                              (event.key === "ArrowUp"
                                                ? -1
                                                : 1),
                                          );
                                        }
                                      }}
                                    >
                                      <GripVerticalIcon aria-hidden="true" />
                                    </Button>
                                  </TooltipTrigger>
                                  {/* Out of the way while a row is dragged.
                                      Mounted in the main landmark, so all
                                      page content stays in one (a11y
                                      D-R12-02). */}
                                  <TooltipContent
                                    container={mainLandmark()}
                                    className={cn(drag && "hidden")}
                                  >
                                    Drag to reorder
                                  </TooltipContent>
                                </Tooltip>
                              )}
                              <span className="flex size-5 shrink-0 items-center justify-center">
                                {status ? (
                                  <ToneIcon
                                    tone={status}
                                    className={cn("size-4", toneClass[status])}
                                  />
                                ) : (
                                  <ToneIcon
                                    tone="unknown"
                                    className="size-4 text-muted-foreground"
                                  />
                                )}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                  <p className="min-w-0 truncate text-sm font-medium">
                                    {component.name}
                                  </p>
                                  {!component.public && <Tag>Hidden</Tag>}
                                  {changed && <Tag tone="draft">{changed}</Tag>}
                                </div>
                                <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[13px] leading-5 text-muted-foreground">
                                  <span
                                    className={cn(
                                      "shrink-0 font-medium md:hidden",
                                      status
                                        ? toneClass[status]
                                        : "text-muted-foreground",
                                    )}
                                  >
                                    {statusText}
                                  </span>
                                  <KindGlyph
                                    aria-hidden="true"
                                    className="size-3.5 shrink-0"
                                  />
                                  {source !== null &&
                                    source !== component.name && (
                                      <span className="sr-only">
                                        {kindLabel[component.kind]}:
                                      </span>
                                    )}
                                  <span
                                    className={cn(
                                      "min-w-0 truncate",
                                      component.kind === "url" && "font-mono",
                                    )}
                                  >
                                    {source === null
                                      ? `Removed ${kindLabel[component.kind].toLowerCase()}`
                                      : source !== component.name
                                        ? source
                                        : kindLabel[component.kind]}
                                  </span>
                                </p>
                              </div>
                              {/* From md the status reads as its own column
                                  beside the row's actions. */}
                              <span
                                className={cn(
                                  "hidden w-28 shrink-0 text-right text-[13px] font-medium md:block",
                                  status
                                    ? toneClass[status]
                                    : "text-muted-foreground",
                                )}
                              >
                                {statusText}
                              </span>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className={cn(
                                      "size-11 shrink-0 md:size-9",
                                      touchIcon,
                                      !component.public &&
                                        "text-muted-foreground",
                                    )}
                                    aria-pressed={component.public}
                                    aria-label={`Show ${component.name} on the public page`}
                                    onClick={() => {
                                      updateComponents((list) =>
                                        list.map((c, i) =>
                                          i === index
                                            ? { ...c, public: !c.public }
                                            : c,
                                        ),
                                      );
                                      announce(
                                        `${component.name} ${component.public ? "hidden from" : "shown on"} the public page after you save.`,
                                      );
                                    }}
                                  >
                                    {component.public ? (
                                      <EyeIcon aria-hidden="true" />
                                    ) : (
                                      <EyeOffIcon aria-hidden="true" />
                                    )}
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {component.public
                                    ? "Shown to players"
                                    : "Hidden from players"}
                                </TooltipContent>
                              </Tooltip>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    data-focus-key={`actions-${key}`}
                                    className={cn(
                                      "size-11 shrink-0 md:size-9",
                                      touchIcon,
                                    )}
                                    aria-label={`Actions for ${component.name}`}
                                  >
                                    <MoreHorizontalIcon aria-hidden="true" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                  align="end"
                                  className="min-w-44"
                                >
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      openComponent(index, `actions-${key}`)
                                    }
                                  >
                                    <PencilIcon aria-hidden="true" />
                                    Edit
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={position === 0}
                                    onSelect={() =>
                                      reorderInGroup(
                                        group.name,
                                        position,
                                        position - 1,
                                      )
                                    }
                                  >
                                    <ArrowUpIcon aria-hidden="true" />
                                    Move up
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={
                                      position === group.items.length - 1
                                    }
                                    onSelect={() =>
                                      reorderInGroup(
                                        group.name,
                                        position,
                                        position + 1,
                                      )
                                    }
                                  >
                                    <ArrowDownIcon aria-hidden="true" />
                                    Move down
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onSelect={() => removeComponent(index)}
                                  >
                                    <Trash2Icon aria-hidden="true" />
                                    Remove
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}
              </div>
            )}
            <p id="reorder-hint" className="sr-only">
              Press Arrow Up or Arrow Down to move this target within its group.
            </p>
          </fieldset>
        </TabsContent>

        {/* ---------------- Settings ---------------- */}
        <TabsContent value="settings" className="mt-5">
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
              className="min-w-0"
              noValidate
            >
              <fieldset disabled={!canManage} className="min-w-0 space-y-6">
                <legend className="sr-only">Status page settings</legend>

                <Card id="page-setup" title="Page">
                  <div className="grid gap-5 px-4 py-5 md:px-5">
                    <Field
                      id="status-name"
                      label="Page name"
                      error={fieldErrors.name}
                    >
                      {(aria) => (
                        <Input
                          {...aria}
                          maxLength={80}
                          value={draft.name}
                          onChange={(e) =>
                            updateDraft({ name: e.target.value }, "name")
                          }
                          className="h-10"
                        />
                      )}
                    </Field>
                    <Field
                      id="status-slug"
                      label="Public address"
                      error={fieldErrors.slug}
                      warning={slugBreaksLinks}
                      hint={
                        slugBreaksLinks
                          ? `Links to ${publicPath(base.slug)} stop working after you save.`
                          : undefined
                      }
                    >
                      {(aria) => (
                        <InputFrame className="gap-0 px-0">
                          <span className="shrink-0 pl-3 font-mono text-xs text-muted-foreground">
                            /status/
                          </span>
                          <InputFrameControl
                            {...aria}
                            maxLength={40}
                            spellCheck={false}
                            autoComplete="off"
                            value={slug}
                            onChange={(e) =>
                              updateDraft(
                                {
                                  slug: e.target.value
                                    .toLowerCase()
                                    .replace(/[^a-z0-9-]/g, "-"),
                                  slugEdited: true,
                                },
                                "slug",
                              )
                            }
                            className="px-1 font-mono"
                          />
                        </InputFrame>
                      )}
                    </Field>
                    <Field
                      id="status-support"
                      label="Support link"
                      error={fieldErrors.supportUrl}
                    >
                      {(aria) => (
                        <Input
                          {...aria}
                          type="url"
                          inputMode="url"
                          maxLength={300}
                          value={draft.supportUrl}
                          onChange={(e) =>
                            updateDraft(
                              { supportUrl: e.target.value },
                              "supportUrl",
                            )
                          }
                          placeholder="https://discord.gg/your-server"
                          className="h-10"
                        />
                      )}
                    </Field>
                  </div>
                </Card>

                <Card id="branding" title="Branding">
                  <div className="grid gap-6 px-4 py-5 md:px-5">
                    <div className="space-y-2">
                      <p className="text-sm leading-none font-medium">Logo</p>
                      <div className="flex flex-wrap items-center gap-4">
                        <div className="relative shrink-0">
                          <button
                            type="button"
                            data-focus-key="logo"
                            aria-label={shownLogo ? "Edit logo" : "Add logo"}
                            aria-describedby={cn(
                              logoError && "logo-error",
                              "logo-hint",
                            )}
                            onClick={() => {
                              returnFocus.current = "logo";
                              if (pendingLogo?.kind === "upload")
                                setLogoEditing({
                                  url: pendingLogo.source,
                                  owned: true,
                                });
                              else if (shownLogo)
                                setLogoEditing({
                                  url: shownLogo,
                                  owned: false,
                                });
                              else logoInput.current?.click();
                            }}
                            onDragOver={(event) => {
                              if (!canManage) return;
                              event.preventDefault();
                              setLogoDrop(true);
                            }}
                            onDragLeave={() => setLogoDrop(false)}
                            onDrop={(event) => {
                              event.preventDefault();
                              setLogoDrop(false);
                              if (canManage)
                                editLogoFile(event.dataTransfer.files[0]);
                            }}
                            className={cn(
                              "group/logo relative flex h-20 w-36 items-center justify-center overflow-hidden rounded-xl border bg-surface-elevated transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-default",
                              shownLogo
                                ? "border-border"
                                : "border-dashed border-input hover:border-muted-foreground",
                              logoError && "border-destructive",
                              logoDrop && "border-ring bg-ring/10",
                            )}
                          >
                            {shownLogo ? (
                              <>
                                {/* A same-origin object URL for the re-encoded PNG. */}
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={shownLogo}
                                  alt="Current logo"
                                  className="max-h-12 max-w-28 object-contain"
                                />
                                <span
                                  aria-hidden="true"
                                  className="absolute inset-0 flex items-center justify-center gap-1.5 bg-background/80 text-xs font-medium opacity-0 transition-opacity group-hover/logo:opacity-100 group-focus-visible/logo:opacity-100 group-disabled/logo:hidden"
                                >
                                  <PencilIcon className="size-3.5" />
                                  Edit
                                </span>
                              </>
                            ) : (
                              <span className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
                                <ImageIcon
                                  aria-hidden="true"
                                  className="size-5"
                                />
                                Add logo
                              </span>
                            )}
                          </button>
                          {shownLogo && canManage && (
                            <Popover
                              open={logoRemoveOpen}
                              onOpenChange={setLogoRemoveOpen}
                            >
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <PopoverTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="icon-sm"
                                      aria-label="Remove logo"
                                      className={cn(
                                        "absolute -top-2.5 -right-2.5 size-8 rounded-full bg-popover text-muted-foreground shadow-sm hover:text-destructive dark:bg-popover",
                                        touchIcon,
                                      )}
                                    >
                                      <Trash2Icon aria-hidden="true" />
                                    </Button>
                                  </PopoverTrigger>
                                </TooltipTrigger>
                                <TooltipContent>Remove logo</TooltipContent>
                              </Tooltip>
                              <PopoverContent
                                align="start"
                                className="w-72 space-y-3 p-3"
                              >
                                <div className="space-y-1">
                                  <p className="text-sm font-medium">
                                    Remove the logo?
                                  </p>
                                  <p className="text-[13px] leading-5 text-muted-foreground">
                                    Your page shows its initial instead.
                                  </p>
                                </div>
                                <div className="flex justify-end gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className={cn("h-9 px-3", touch)}
                                    onClick={() => setLogoRemoveOpen(false)}
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="destructive-solid"
                                    className={cn("h-9 px-3", touch)}
                                    onClick={() => {
                                      setPendingLogo(
                                        state.logoVersion === null
                                          ? null
                                          : { kind: "remove" },
                                      );
                                      setLogoRemoveOpen(false);
                                      setLogoError("");
                                      announce(
                                        "Logo removed. Save changes to update the page.",
                                      );
                                      focusByKey("logo");
                                    }}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              </PopoverContent>
                            </Popover>
                          )}
                        </div>
                        <div className="min-w-0 flex-1 basis-40 space-y-1.5">
                          {pendingLogo && (
                            <Tag
                              tone={
                                pendingLogo.kind === "upload"
                                  ? "draft"
                                  : "muted"
                              }
                            >
                              {pendingLogo.kind === "upload"
                                ? "New logo"
                                : "Logo removed"}
                            </Tag>
                          )}
                          {logoError && (
                            <FieldMessage id="logo-error" alert>
                              {logoError}
                            </FieldMessage>
                          )}
                          {/* A refused file says the formats in its
                              error; screen readers hear them up front. */}
                          <p id="logo-hint" className="sr-only">
                            PNG, JPEG, WebP, GIF, or SVG, up to 20 MB
                          </p>
                        </div>
                        <input
                          ref={logoInput}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                          className="sr-only"
                          tabIndex={-1}
                          aria-label="Logo file"
                          onChange={(event) =>
                            editLogoFile(event.target.files?.[0])
                          }
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label id="status-theme-label">Theme</Label>
                      <ToggleGroup
                        type="single"
                        value={draft.theme}
                        onValueChange={chooseTheme}
                        {...selectOnArrow(chooseTheme)}
                        aria-labelledby="status-theme-label"
                        spacing={2}
                        className="grid w-full grid-cols-3 gap-2"
                      >
                        {(["dark", "light", "system"] as const).map((theme) => (
                          <ThemeCard
                            key={theme}
                            theme={theme}
                            accent={previewed.accentColor}
                          />
                        ))}
                      </ToggleGroup>
                      {draft.theme === "system" && (
                        <p className="text-[13px] leading-5 text-muted-foreground">
                          Matches each visitor&apos;s device.
                        </p>
                      )}
                    </div>

                    <AccentField
                      value={draft.accentColor}
                      theme={draft.theme}
                      error={fieldErrors.accentColor}
                      onChange={(accentColor) =>
                        updateDraft({ accentColor }, "accentColor")
                      }
                    />

                    <div className="space-y-2">
                      <Label htmlFor="status-font">Font</Label>
                      <Select
                        value={draft.font}
                        onValueChange={(font) =>
                          updateDraft({ font: font as StatusFont })
                        }
                      >
                        <SelectTrigger
                          id="status-font"
                          className="w-full bg-input-background data-[size=default]:h-10 dark:bg-input-background [@media(any-pointer:coarse)]:data-[size=default]:h-11"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          {statusFonts.map((font) => (
                            <SelectItem
                              key={font.id}
                              value={font.id}
                              className="min-h-9 [@media(any-pointer:coarse)]:min-h-11"
                            >
                              <span
                                style={{
                                  fontFamily: statusFontFamily[font.id],
                                }}
                              >
                                {font.label}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </Card>

                <Card id="links" title="Header and footer">
                  <div className="grid gap-6 px-4 py-5 md:px-5">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm leading-none font-medium">
                          Header links{" "}
                          <span className="ml-1 font-normal text-muted-foreground tabular-nums">
                            {draft.links.length} of {maxLinks}
                          </span>
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          data-focus-key="add-link"
                          className={cn("h-9 px-3", touch)}
                          disabled={draft.links.length >= maxLinks}
                          onClick={() => {
                            updateDraft({
                              links: [...draft.links, { label: "", url: "" }],
                            });
                            setFocusTarget(
                              `status-link-${draft.links.length}-label`,
                            );
                          }}
                        >
                          <PlusIcon aria-hidden="true" />
                          Add link
                        </Button>
                      </div>
                      {draft.links.map((link, index) => (
                        <fieldset
                          key={index}
                          aria-labelledby={`status-link-${index}-legend`}
                          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-3 border-t border-border pt-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto]"
                        >
                          <span
                            id={`status-link-${index}-legend`}
                            className="sr-only"
                          >
                            Link {index + 1}
                          </span>
                          {(["label", "url"] as const).map((part) => {
                            const id = `status-link-${index}-${part}`;
                            const error = fieldErrors[`link-${index}-${part}`];
                            return (
                              <div
                                key={part}
                                className={cn(
                                  "min-w-0 space-y-1.5",
                                  part === "url" &&
                                    "col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto",
                                )}
                              >
                                <Label
                                  id={`${id}-label`}
                                  htmlFor={id}
                                  className="text-xs text-muted-foreground"
                                >
                                  {part === "label" ? "Label" : "Address"}
                                </Label>
                                <Input
                                  id={id}
                                  aria-labelledby={`status-link-${index}-legend ${id}-label`}
                                  aria-invalid={error ? true : undefined}
                                  aria-describedby={
                                    error ? `${id}-error` : undefined
                                  }
                                  type={part === "url" ? "url" : "text"}
                                  inputMode={part === "url" ? "url" : undefined}
                                  maxLength={part === "url" ? 300 : 40}
                                  placeholder={
                                    part === "url" ? "https://" : "Website"
                                  }
                                  value={link[part]}
                                  onChange={(e) =>
                                    updateDraft(
                                      {
                                        links: draft.links.map((l, i) =>
                                          i === index
                                            ? { ...l, [part]: e.target.value }
                                            : l,
                                        ),
                                      },
                                      `link-${index}-${part}`,
                                    )
                                  }
                                  className="h-10"
                                />
                                {error && (
                                  <FieldMessage id={`${id}-error`}>
                                    {error}
                                  </FieldMessage>
                                )}
                              </div>
                            );
                          })}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(
                              "col-start-2 row-start-1 mt-6 size-10 sm:col-start-auto sm:row-start-auto",
                              touchIcon,
                            )}
                            aria-label={`Remove link ${index + 1}`}
                            onClick={() => {
                              updateDraft(
                                {
                                  links: draft.links.filter(
                                    (_, i) => i !== index,
                                  ),
                                },
                                `link-${index}-label`,
                                `link-${index}-url`,
                              );
                              focusByKey("add-link");
                            }}
                          >
                            <XIcon aria-hidden="true" />
                          </Button>
                        </fieldset>
                      ))}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="status-footer">Footer text</Label>
                      <Input
                        id="status-footer"
                        maxLength={200}
                        value={draft.footerText}
                        onChange={(e) =>
                          updateDraft({ footerText: e.target.value })
                        }
                        placeholder={`© ${organization.name}`}
                        className="h-10"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <Label htmlFor="status-powered-by">
                        Show Powered by Cupboard
                      </Label>
                      <Switch
                        id="status-powered-by"
                        checked={draft.poweredBy}
                        onCheckedChange={(poweredBy) =>
                          updateDraft({ poweredBy })
                        }
                        size="lg"
                        className="after:-inset-y-2.5"
                      />
                    </div>
                  </div>
                </Card>
              </fieldset>
            </form>

            <section
              aria-labelledby="preview-heading"
              className="sticky top-4 hidden min-w-0 overflow-hidden rounded-xl border border-border bg-card xl:block"
            >
              <PreviewHeader
                id="preview-heading"
                onExpand={() => {
                  returnFocus.current = "preview-full";
                  setPreviewWidth("desktop");
                  setPreviewOpen(true);
                }}
              />
              <div
                tabIndex={0}
                role="group"
                aria-label="Scrollable preview"
                className="max-h-[calc(100dvh-9rem)] overflow-y-auto bg-background p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                {sidePreview}
              </div>
            </section>
          </div>
        </TabsContent>
      </Tabs>

      {showBar && (
        <div
          ref={barRef}
          role="region"
          aria-label={savedShown ? "Changes saved" : "Unsaved changes"}
          // In the page's flow, "Saved" keeps the height the bar had, so
          // nothing under or beside it moves. Fixed to a phone's edge, it
          // shrinks to one line from its top while the page keeps the space
          // (claude D-101).
          style={
            savedShown && !savedBar?.fixed
              ? { minHeight: savedBar?.height }
              : undefined
          }
          className={cn(
            // Pinned only when the viewport is tall enough to spare it: below
            // 30rem (short windows, 400% zoom) it sits after the content.
            "z-40 border-border-strong bg-surface-elevated px-4 pt-3 shadow-lg",
            "max-sm:border-t max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]",
            "max-sm:[@media(min-height:30rem)]:fixed max-sm:[@media(min-height:30rem)]:inset-x-0 max-sm:[@media(min-height:30rem)]:bottom-0",
            // Pinned, it never takes more than half the screen: the merge
            // list scrolls inside, title and actions stay (a11y D-71).
            "max-sm:[@media(min-height:30rem)]:flex max-sm:[@media(min-height:30rem)]:max-h-[50dvh] max-sm:[@media(min-height:30rem)]:flex-col",
            "max-sm:[@media(max-height:30rem)]:rounded-xl max-sm:[@media(max-height:30rem)]:border",
            "sm:rounded-xl sm:border sm:pb-3 sm:[@media(min-height:30rem)]:sticky sm:[@media(min-height:30rem)]:bottom-4",
            // Beside the Settings preview the bar stays in the editor column.
            tab === "settings" && "xl:max-w-[34rem]",
            savedShown && "flex flex-col justify-center",
            "transition-[opacity,translate] duration-200 motion-reduce:transition-none",
            savedLeaving && "translate-y-2 opacity-0",
          )}
        >
          {/* Always here while the bar is, and empty until a Save goes
              through, so "Saved" is said once, by every screen reader. */}
          <p
            role="status"
            className={
              savedShown
                ? "flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
                : "sr-only"
            }
          >
            {savedShown && (
              <>
                <span className="flex items-center gap-1.5 self-center font-medium">
                  <CircleCheckIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-primary"
                  />
                  Saved<span className="sr-only">.</span>
                </span>{" "}
                <span className="text-[13px] leading-5 text-muted-foreground">
                  {state.published
                    ? "Visitors see it now."
                    : "Visitors see it once the page is published."}
                </span>
              </>
            )}
          </p>
          {!savedShown && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3 max-sm:min-h-0 max-sm:flex-col max-sm:flex-nowrap max-sm:items-stretch">
              <div
                className={cn(
                  "min-w-0 flex-1 basis-56",
                  // A merge warning gets the bar's full width, actions below.
                  notice?.warn && !conflicted && "basis-full",
                  "max-sm:flex max-sm:min-h-0 max-sm:basis-auto max-sm:flex-col",
                )}
              >
                {/* The plain "Unsaved changes" summary is not spoken: the
                    edit that made it already said what changed, and a live
                    region mounted full is voiced by some screen readers on
                    the first edit (a11y D-R11-02). Only what the operator
                    did not just do is said here: a conflict, errors, a
                    failed save, or a merge result. */}
                {quietBar && (
                  <p className="text-sm font-medium">Unsaved changes</p>
                )}
                <div
                  aria-live="polite"
                  className="max-sm:flex max-sm:min-h-0 max-sm:flex-col"
                >
                  {conflicted ? (
                    <>
                      <p className="flex items-center gap-1.5 text-sm font-medium text-warning">
                        <TriangleAlertIcon
                          aria-hidden="true"
                          className="size-4 shrink-0"
                        />
                        Changed in another session
                      </p>
                      <p className="text-[13px] leading-5 text-muted-foreground">
                        Your edits aren&apos;t saved yet.
                      </p>
                    </>
                  ) : errorCount > 0 ? (
                    <>
                      <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                        <CircleAlertIcon
                          aria-hidden="true"
                          className="size-4 shrink-0"
                        />
                        {errorCount === 1
                          ? "1 field needs attention"
                          : `${errorCount} fields need attention`}
                      </p>
                    </>
                  ) : saveError ? (
                    <p
                      role="alert"
                      className="flex items-start gap-1.5 text-sm text-destructive"
                    >
                      <CircleAlertIcon
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0"
                      />
                      {saveError}
                    </p>
                  ) : notice?.warn ? (
                    <>
                      <p className="flex items-center gap-1.5 text-sm font-medium text-warning">
                        <TriangleAlertIcon
                          aria-hidden="true"
                          className="size-4 shrink-0"
                        />
                        Check the merged changes
                      </p>
                      {/* Wraps in full: this is the warning that Save replaces
                      or restores another session's work. One decision per
                      line, so each can be checked. */}
                      {notice.text && (
                        <p className="text-[13px] leading-5 text-pretty text-muted-foreground">
                          {notice.text}
                        </p>
                      )}
                      {(() => {
                        // On phones the bar is pinned over the page, so the list
                        // scrolls inside the bar's cap, and a long one shows
                        // three decisions until Show all (a11y D-71).
                        const items = notice.items ?? [];
                        const folds = phoneScreen && items.length > 3;
                        const open = !folds || openNotice === notice;
                        const list = (
                          <ul
                            id="merge-decisions"
                            className="mt-1 list-disc space-y-0.5 pl-5 text-[0.8125rem] text-pretty text-muted-foreground marker:text-warning"
                          >
                            {(open ? items : items.slice(0, 3)).map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        );
                        if (!phoneScreen) return list;
                        return (
                          <>
                            <ScrollCue label="Merged changes">{list}</ScrollCue>
                            {folds && (
                              <Button
                                type="button"
                                variant="link"
                                aria-expanded={open}
                                aria-controls="merge-decisions"
                                className={cn(
                                  "mt-1 h-10 shrink-0 self-start px-0 text-sm",
                                  touch,
                                )}
                                onClick={() =>
                                  setOpenNotice(open ? null : notice)
                                }
                              >
                                {open
                                  ? "Show fewer"
                                  : `Show all ${items.length} changes`}
                              </Button>
                            )}
                          </>
                        );
                      })()}
                    </>
                  ) : notice?.text ? (
                    <p className="text-[13px] leading-5 text-pretty text-muted-foreground">
                      {notice.text}
                    </p>
                  ) : null}
                </div>
                {quietBar && !notice?.text && changes.length > 0 && (
                  <p className="text-[13px] leading-5 text-pretty text-muted-foreground">
                    {`${sentenceCase(joinList(changes))}.`}
                  </p>
                )}
              </div>
              <div className="flex w-full gap-2 sm:ml-auto sm:w-auto">
                {errorCount > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn("h-10 px-3", touch)}
                    onClick={() => {
                      const first = validate()[0];
                      setTab("settings");
                      if (first) setFocusTarget(idOf(first[0]));
                    }}
                  >
                    Show
                  </Button>
                )}
                {conflicted ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      className={cn(
                        "h-10 flex-1 px-4 sm:flex-none",
                        touch,
                        busyLook,
                      )}
                      aria-disabled={saving || undefined}
                      onClick={() => {
                        if (!saving) setDiscardOpen(true);
                      }}
                    >
                      Discard my edits
                    </Button>
                    <Button
                      type="button"
                      className={cn(
                        "h-10 flex-1 px-4 sm:flex-none",
                        touch,
                        busyLook,
                      )}
                      aria-disabled={saving || undefined}
                      onClick={() => {
                        if (!saving) void reloadKeepingEdits();
                      }}
                    >
                      {saving && <Spinner aria-hidden="true" />}
                      Load latest, keep my edits
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      className={cn(
                        "h-10 flex-1 px-4 sm:flex-none",
                        touch,
                        busyLook,
                      )}
                      aria-disabled={saving || undefined}
                      disabled={!dirty}
                      onClick={() => {
                        if (!saving) discard();
                      }}
                    >
                      Discard
                    </Button>
                    <Button
                      type="button"
                      className={cn(
                        "h-10 flex-1 px-4 sm:flex-none",
                        touch,
                        busyLook,
                      )}
                      aria-disabled={saving || undefined}
                      disabled={!dirty}
                      onClick={() => void save()}
                    >
                      {saving && <Spinner aria-hidden="true" />}
                      {saving ? "Saving changes..." : "Save changes"}
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {!showBar && heldSpace && (
        // The space the bar took, kept so its leaving moves nothing.
        <div
          ref={spaceRef}
          aria-hidden="true"
          style={{ height: heldSpace.height }}
        />
      )}

      <Sheet open={previewOpen} onOpenChange={setPreviewOpen}>
        <SheetContent
          side="right"
          // Wide enough for the desktop page at real size on a laptop.
          className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[66rem]"
          closeButtonClassName={touchIcon}
          // Titled and nothing more: the frame shows what it shows.
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            // Back to the Preview or Desktop preview that opened it.
            event.preventDefault();
            focusByKey(returnFocus.current, "preview-page");
          }}
        >
          <SheetHeader className="border-b border-border pr-14">
            <SheetTitle>Public preview</SheetTitle>
            {/* Under 640 pixels the sheet is a phone already: no toggle. */}
            <div className="pt-2 max-sm:hidden">
              <WidthToggle width={previewWidth} onWidth={setPreviewWidth} />
            </div>
          </SheetHeader>
          <div
            tabIndex={0}
            role="group"
            aria-label="Scrollable preview"
            className="min-h-0 flex-1 overflow-y-auto bg-background p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            {preview}
          </div>
        </SheetContent>
      </Sheet>

      <StatusLogoEditor
        file={logoEditing?.url ?? null}
        onOpenChange={(open) => {
          if (!open) setLogoEditing(null);
        }}
        onReturnFocus={() => focusByKey(returnFocus.current, "logo")}
        onSave={async (png) => stageLogo(png)}
        onChooseFile={() => logoInput.current?.click()}
        accent={previewed.accentColor}
        pageName={draft.name || state.name}
      />

      {/* ---------------- Target dialog ---------------- */}
      <Dialog
        open={componentForm !== null}
        onOpenChange={(open) => {
          if (!open) setComponentForm(null);
        }}
      >
        <DialogContent
          scrollable
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusByKey(returnFocus.current, "add-target");
          }}
        >
          <form onSubmit={submitComponent} className="contents" noValidate>
            <DialogHeader>
              <DialogTitle>
                {componentForm?.index === null ? "Add target" : "Edit target"}
              </DialogTitle>
              <DialogDescription>
                Players see it after you save changes.
              </DialogDescription>
            </DialogHeader>
            {componentForm && (
              <DialogBody>
                {componentForm.index === null && (
                  <div className="space-y-2">
                    <Label id="component-kind-label">Type</Label>
                    <ToggleGroup
                      type="single"
                      value={componentForm.kind}
                      onValueChange={chooseKind}
                      {...selectOnArrow(chooseKind)}
                      aria-labelledby="component-kind-label"
                      variant="segmented"
                    >
                      {(["url", "machine", "server"] as const).map((kind) => {
                        const Glyph = kindIcon[kind];
                        return (
                          <ToggleGroupItem
                            key={kind}
                            value={kind}
                            data-value={kind}
                            className="h-8 gap-1.5"
                          >
                            <Glyph aria-hidden="true" />
                            {kindLabel[kind]}
                          </ToggleGroupItem>
                        );
                      })}
                    </ToggleGroup>
                  </div>
                )}
                {componentForm.kind === "url" && (
                  <Field
                    id="component-url"
                    label="Address"
                    error={componentForm.errors.url}
                    aside={
                      // The probe schedule, as a glanceable fact beside the
                      // label; screen readers hear it whole.
                      <span className="inline-flex items-center gap-1 text-[13px] leading-5 text-muted-foreground tabular-nums">
                        <TimerIcon aria-hidden="true" className="size-3.5" />
                        <span aria-hidden="true">{WEBSITE_CHECK_SECONDS}s</span>
                        <span className="sr-only">
                          Checked every {WEBSITE_CHECK_SECONDS} seconds
                        </span>
                      </span>
                    }
                  >
                    {(aria) => (
                      <Input
                        {...aria}
                        data-focus-key="component-url"
                        type="url"
                        inputMode="url"
                        maxLength={300}
                        placeholder="https://play.example.com"
                        value={componentForm.url}
                        onChange={(e) =>
                          patchComponent({ url: e.target.value }, "url")
                        }
                        onBlur={(e) => {
                          const url = withScheme(e.target.value);
                          if (url !== e.target.value) patchComponent({ url });
                        }}
                        className="h-10"
                      />
                    )}
                  </Field>
                )}
                {componentForm.index === null &&
                  componentForm.kind !== "url" && (
                    <Field
                      id="component-source"
                      label={kindLabel[componentForm.kind]}
                      error={componentForm.errors.source}
                    >
                      {(aria) => (
                        <Popover
                          open={sourceOpen}
                          onOpenChange={(open) => {
                            setSourceOpen(open);
                            if (!open) setSourceSearch("");
                          }}
                        >
                          <PopoverTrigger asChild>
                            <Button
                              {...aria}
                              type="button"
                              variant="outline"
                              role="combobox"
                              data-focus-key="component-source"
                              aria-expanded={sourceOpen}
                              className={cn(
                                "h-10 w-full justify-between border-input px-3 font-normal dark:border-input",
                                touch,
                              )}
                            >
                              {componentForm.source ? (
                                <span className="truncate">
                                  {componentForm.source.name}
                                </span>
                              ) : (
                                <span className="text-text-muted">
                                  {componentForm.kind === "machine"
                                    ? "Choose a machine"
                                    : "Choose a game server"}
                                </span>
                              )}
                              <ChevronsUpDownIcon
                                aria-hidden="true"
                                className="size-4 text-muted-foreground"
                              />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent
                            align="start"
                            className="w-[var(--radix-popover-trigger-width)] p-0"
                          >
                            <SourcePicker
                              kind={
                                componentForm.kind as Exclude<
                                  ComponentKind,
                                  "url"
                                >
                              }
                              sources={available.filter(
                                (s) => s.kind === componentForm.kind,
                              )}
                              total={
                                state.sources.filter(
                                  (s) => s.kind === componentForm.kind,
                                ).length
                              }
                              chosen={componentForm.source}
                              search={sourceSearch}
                              onSearch={setSourceSearch}
                              onChoose={chooseSource}
                            />
                          </PopoverContent>
                        </Popover>
                      )}
                    </Field>
                  )}
                <Field
                  id="component-name"
                  label="Display name"
                  error={componentForm.errors.name}
                  // The placeholder shows the suggestion; screen readers hear it.
                  quietHint
                  hint={
                    suggestedName(componentForm)
                      ? `Leave empty to use ${suggestedName(componentForm)}.`
                      : undefined
                  }
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      data-focus-key="component-name"
                      maxLength={80}
                      // An example, never a value that looks like a default,
                      // until there is a real suggestion (claude D-55).
                      placeholder={
                        suggestedName(componentForm) ||
                        exampleName[componentForm.kind]
                      }
                      value={componentForm.name}
                      onChange={(e) =>
                        patchComponent({ name: e.target.value }, "name")
                      }
                      className="h-10"
                    />
                  )}
                </Field>
                <div className="space-y-2">
                  <Label htmlFor="component-group">Group</Label>
                  <Select
                    value={componentForm.tagId || "none"}
                    onValueChange={(value) =>
                      patchComponent({ tagId: value === "none" ? "" : value })
                    }
                  >
                    <SelectTrigger
                      id="component-group"
                      className="w-full bg-input-background data-[size=default]:h-10 dark:bg-input-background [@media(any-pointer:coarse)]:data-[size=default]:h-11"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem
                        value="none"
                        className="min-h-9 [@media(any-pointer:coarse)]:min-h-11"
                      >
                        No group
                      </SelectItem>
                      {state.tags.map((tag) => (
                        <SelectItem
                          key={tag.id}
                          value={tag.id}
                          className="min-h-9 [@media(any-pointer:coarse)]:min-h-11"
                        >
                          {tag.name}
                        </SelectItem>
                      ))}
                      {/* Groups are machine tags; only an empty catalog
                          needs to say where they come from. */}
                      {state.tags.length === 0 && (
                        <SelectItem
                          value="no-tags"
                          disabled
                          className="min-h-9 text-[13px] whitespace-normal text-muted-foreground [@media(any-pointer:coarse)]:min-h-11"
                        >
                          Add tags on Machines to make groups.
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex min-h-10 items-center gap-3 text-sm">
                  <Checkbox
                    checked={componentForm.public}
                    onCheckedChange={(checked) =>
                      patchComponent({ public: checked === true })
                    }
                  />
                  Show on the public page
                </label>
                {componentForm.errors.general && (
                  <p
                    role="alert"
                    className="flex items-start gap-1.5 text-sm text-destructive"
                  >
                    <CircleAlertIcon
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0"
                    />
                    {componentForm.errors.general}
                  </p>
                )}
              </DialogBody>
            )}
            <DialogFooter className={fitFooter}>
              <Button
                type="button"
                variant="outline"
                className={cn("h-10 px-4", touch)}
                onClick={() => setComponentForm(null)}
              >
                Cancel
              </Button>
              <Button type="submit" className={cn("h-10 px-4", touch)}>
                {componentForm?.index === null ? "Add target" : "Update target"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------------- Maintenance dialog ---------------- */}
      <Dialog
        open={maintenanceForm !== null}
        onOpenChange={(open) => {
          if (!open && !maintenanceBusy) setMaintenanceForm(null);
        }}
      >
        <DialogContent
          scrollable
          className="sm:max-w-lg"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusByKey(returnFocus.current, "schedule", "schedule-empty");
          }}
        >
          {maintenanceForm && (
            <MaintenanceFields
              form={maintenanceForm}
              now={now}
              components={components}
              unsavedTargets={draft.components.some((c) => c.id === null)}
              busy={maintenanceBusy}
              onChange={patchMaintenance}
              onSubmit={submitMaintenance}
              onCancel={() => setMaintenanceForm(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* ---------------- Announcement dialog ---------------- */}
      <Dialog
        open={announcing !== null}
        onOpenChange={(open) => {
          if (!open && !liveBusy) setAnnouncing(null);
        }}
      >
        <DialogContent
          scrollable
          className="sm:max-w-lg"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusByKey(returnFocus.current, "announcement");
          }}
        >
          <form
            className="contents"
            noValidate
            onSubmit={async (event) => {
              event.preventDefault();
              if (!announcing) return;
              const text = announcing.text.trim();
              setAnnouncing((value) => value && { ...value, error: "" });
              if (
                await commitLive(
                  { announcement: text },
                  text ? "Announcement posted." : "Announcement removed.",
                  (error) =>
                    setAnnouncing((value) => value && { ...value, error }),
                )
              )
                setAnnouncing(null);
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {state.announcement
                  ? "Edit announcement"
                  : "Post an announcement"}
              </DialogTitle>
              <DialogDescription>
                Goes live on your page when you post it.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <div className="space-y-2">
                <Label htmlFor="status-announcement">Announcement</Label>
                <Textarea
                  id="status-announcement"
                  maxLength={500}
                  rows={4}
                  value={announcing?.text ?? ""}
                  aria-describedby="status-announcement-count"
                  onChange={(e) =>
                    setAnnouncing((value) =>
                      value ? { text: e.target.value, error: "" } : value,
                    )
                  }
                  placeholder="Wipe day is Thursday at 19:00 UTC."
                />
                <p
                  id="status-announcement-count"
                  className="text-right text-[13px] text-muted-foreground tabular-nums"
                >
                  {announcing?.text.length ?? 0} of 500
                </p>
              </div>
              {state.announcement && (
                <div className="border-t border-border pt-4">
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(
                      "-ml-3 h-10 px-3 text-destructive hover:text-destructive",
                      touch,
                    )}
                    disabled={liveBusy}
                    onClick={async () => {
                      setAnnouncing(
                        (value) => value && { ...value, error: "" },
                      );
                      if (
                        await commitLive(
                          { announcement: "" },
                          "Announcement removed.",
                          (error) =>
                            setAnnouncing(
                              (value) => value && { ...value, error },
                            ),
                        )
                      )
                        setAnnouncing(null);
                    }}
                  >
                    <Trash2Icon aria-hidden="true" />
                    Remove announcement
                  </Button>
                </div>
              )}
              {announcing?.error && (
                <ActionError>{announcing.error}</ActionError>
              )}
            </DialogBody>
            <DialogFooter className={fitFooter}>
              <Button
                type="button"
                variant="outline"
                className={cn("h-10 px-4", touch)}
                disabled={liveBusy}
                onClick={() => setAnnouncing(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className={cn("h-10 px-4", touch, busyLook)}
                aria-disabled={liveBusy || undefined}
                disabled={!announcing?.text.trim()}
              >
                {liveBusy && <Spinner aria-hidden="true" />}
                {state.announcement
                  ? "Update announcement"
                  : "Post announcement"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={publishOpen}
        onOpenChange={(open) => {
          if (open || liveBusy) return;
          setPublishOpen(false);
          setConfirmError("");
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // Back to the pill that opened it, which now says Private if the
            // page was unpublished.
            event.preventDefault();
            focusByKey("publication");
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Unpublish the status page?</AlertDialogTitle>
            <AlertDialogDescription>
              Players at {publicPath(state.slug)} see a not-found page.
              Everything stays saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmError && <ActionError>{confirmError}</ActionError>}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={liveBusy}
              className={cn("h-10 px-4", touch)}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive-solid"
              className={cn("h-10 px-4", touch, busyLook)}
              aria-disabled={liveBusy || undefined}
              onClick={async (event) => {
                event.preventDefault();
                setConfirmError("");
                if (
                  await commitLive(
                    { published: false },
                    (next) => `Status page unpublished. ${playersSee(next)}`,
                    setConfirmError,
                  )
                )
                  setPublishOpen(false);
              }}
            >
              {liveBusy ? "Unpublishing..." : "Unpublish page"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={completing !== null}
        onOpenChange={(open) => {
          if (open || actionBusy) return;
          setCompleting(null);
          setConfirmError("");
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusByKey(returnFocus.current, "schedule", "schedule-empty");
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Mark {completing?.title} as complete?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Affected targets go back to their live status.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmError && <ActionError>{confirmError}</ActionError>}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={actionBusy}
              className={cn("h-10 px-4", touch)}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn("h-10 px-4", touch, busyLook)}
              aria-disabled={actionBusy || undefined}
              onClick={(event) => {
                event.preventDefault();
                if (completing)
                  void runAction(
                    `status-page/maintenance/${completing.id}/complete`,
                    "Maintenance marked complete.",
                    () => setCompleting(null),
                  );
              }}
            >
              {actionBusy ? "Completing..." : "Mark complete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (open || actionBusy) return;
          setRemoving(null);
          setConfirmError("");
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusByKey(returnFocus.current, "schedule", "schedule-empty");
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing?.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves the page and its history. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmError && <ActionError>{confirmError}</ActionError>}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={actionBusy}
              className={cn("h-10 px-4", touch)}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive-solid"
              className={cn("h-10 px-4", touch, busyLook)}
              aria-disabled={actionBusy || undefined}
              onClick={(event) => {
                event.preventDefault();
                if (removing)
                  void runAction(
                    `status-page/maintenance/${removing.id}/remove`,
                    "Maintenance window deleted.",
                    () => setRemoving(null),
                  );
              }}
            >
              {actionBusy ? "Deleting..." : "Delete window"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your edits?</AlertDialogTitle>
            <AlertDialogDescription>
              {changes.length > 0
                ? `${sentenceCase(joinList(changes))} will be lost.`
                : "Your edits will be lost."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={cn("h-10 px-4", touch)}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive-solid"
              className={cn("h-10 px-4", touch)}
              onClick={(event) => {
                event.preventDefault();
                void reloadDiscarding();
              }}
            >
              Discard and reload
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview pieces                                                     */
/* ------------------------------------------------------------------ */

function AdminSkeleton() {
  // Same shape as the header: identity, then the action row (its own rows on
  // phones), then the tabs.
  return (
    <div aria-label="Loading status page" role="status" className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1 basis-72 space-y-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:flex-nowrap">
          <Skeleton className="h-10 flex-1 sm:w-40 sm:flex-none" />
          <Skeleton className="size-10" />
          <Skeleton className="h-10 basis-full sm:w-52 sm:basis-auto" />
        </div>
      </div>
      <div className="flex gap-4 border-b border-border pb-2.5">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-14" />
        <Skeleton className="h-5 w-16" />
      </div>
      <Skeleton className="h-32 w-full rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Skeleton className="h-80 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    </div>
  );
}

/** An address broken only after a slash, never mid-word (claude D-100). */
function SlashBreaks({ text }: { text: string }) {
  return text.split(/(?<=\/)/).map((part, index) => (
    <Fragment key={index}>
      {index > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

/**
 * Whether the page is public, as a pill beside the title that opens the
 * page's publishing controls: the saved address with Copy, and Unpublish
 * (confirmed), or Publish page while it is private. "Public" folds to its
 * globe where a fine pointer can hover and opens on hover, on keyboard focus,
 * and while its popover is open; touch screens always show the word. The
 * word keeps its width reserved, so opening it moves nothing. "Private" never
 * folds: an abnormal state stays spelled out.
 */
function PublicationPill({
  published,
  canManage,
  url,
  open,
  onOpenChange,
  returnFocusRef,
  busy,
  publishError,
  copied,
  copyFailed,
  onCopy,
  onPublish,
  onUnpublish,
}: {
  published: boolean;
  canManage: boolean;
  url: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: { current: string | null };
  busy: boolean;
  publishError: string;
  copied: boolean;
  copyFailed: boolean;
  onCopy: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
}) {
  const word = published ? "Public" : "Private";
  const Glyph = published ? GlobeIcon : LockIcon;
  const address = useRef<HTMLParagraphElement | null>(null);
  // A failed copy selects the whole address, so Ctrl+C or the system menu
  // copies it in one step.
  useEffect(() => {
    if (!copyFailed || !address.current) return;
    const range = document.createRange();
    range.selectNodeContents(address.current);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [copyFailed]);
  const shape =
    "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[13px] leading-none font-medium whitespace-nowrap";
  // Folds where a fine pointer can hover; opens on hover, keyboard focus,
  // and while the popover is open. Written out whole so Tailwind sees it.
  const fold = [
    "overflow-hidden transition-[max-width,opacity] duration-150 ease-out motion-reduce:transition-none",
    "[@media(hover:hover)_and_(pointer:fine)]:max-w-0 [@media(hover:hover)_and_(pointer:fine)]:opacity-0",
    "group-hover/pill:max-w-20 group-hover/pill:opacity-100",
    "group-focus-visible/pill:max-w-20 group-focus-visible/pill:opacity-100",
    "group-data-[state=open]/pill:max-w-20 group-data-[state=open]/pill:opacity-100",
  ];
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/* The expanded pill, invisible, holds the space in the same grid cell
          so a folded pill opening never moves anything beside it. */}
      <span className="inline-grid">
        <span
          aria-hidden="true"
          className={cn(shape, "invisible [grid-area:1/1]")}
        >
          <Glyph className="size-3.5" />
          {word}
          <ChevronDownIcon className="size-3" />
        </span>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-focus-key="publication"
            // The visible word starts the name (2.5.3), folded or not.
            aria-label={`${word}, ${canManage ? "address and publishing" : "address"}`}
            className={cn(
              shape,
              "gap-0 px-[5px]",
              "group/pill relative justify-self-start transition-colors outline-none [grid-area:1/1] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              // A 44 pixel tall target on touch screens.
              "[@media(any-pointer:coarse)]:before:absolute [@media(any-pointer:coarse)]:before:-inset-x-1 [@media(any-pointer:coarse)]:before:-inset-y-2.5",
              // Public sits on the sage tint, folded or not, so the globe
              // alone reads as a state and not as a picker (claude D-110).
              published
                ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 data-[state=open]:bg-primary/15"
                : "border-border-strong text-muted-foreground hover:text-foreground data-[state=open]:text-foreground",
            )}
          >
            <Glyph aria-hidden="true" className="size-3.5 shrink-0" />
            {/* The word and the chevron fold together: at rest the pill is
                only a state, and it shows that it opens once it expands.
                The padding is inside the folding part, so the folded globe
                sits centred in its tint. */}
            <span
              data-fold={published || undefined}
              className={cn(published && fold)}
            >
              <span className="inline-flex items-center gap-1 pr-[3px] pl-1">
                <span>{word}</span>
                <ChevronDownIcon
                  aria-hidden="true"
                  className="size-3 shrink-0 opacity-70 transition-transform group-data-[state=open]/pill:rotate-180 motion-reduce:transition-none"
                />
              </span>
            </span>
          </button>
        </PopoverTrigger>
      </span>
      <PopoverContent
        align="start"
        // Named, not titled: the pill above already says the word, so the
        // popover opens straight on the address (claude D-116).
        aria-label={`${word} page`}
        // 20rem, or the screen less its 16 pixel margins on a 320 phone.
        className="w-[min(20rem,calc(100vw-2rem))] gap-3 p-3"
        onCloseAutoFocus={(event) => {
          const key = returnFocusRef.current;
          if (!key) return;
          returnFocusRef.current = null;
          event.preventDefault();
          focusByKey(key, "publication");
        }}
      >
        {/* The saved address and Copy, Public or Private and for every
            role: a private address is still the one to share once it
            goes live (codex D-C11-01). */}
        <div className="flex items-start gap-2">
          <p
            ref={address}
            className="min-w-0 flex-1 rounded-md bg-surface-elevated px-2.5 py-2 font-mono text-xs leading-5 break-words select-all"
          >
            <SlashBreaks text={url} />
          </p>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Copy public address"
            className={cn("size-9 shrink-0", touchIcon)}
            onClick={onCopy}
          >
            {copied ? (
              <CheckIcon aria-hidden="true" className="text-primary" />
            ) : (
              <CopyIcon aria-hidden="true" />
            )}
          </Button>
        </div>
        {copyFailed && (
          <p
            role="alert"
            className="flex items-start gap-1.5 text-[13px] leading-5 text-destructive"
          >
            <CircleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span>Copy failed. The address is selected: copy it.</span>
          </p>
        )}
        {published ? (
          canManage && (
            <div className="-mx-3 border-t border-border px-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                className={cn(
                  "-ml-2 h-9 px-2 text-destructive hover:text-destructive",
                  touch,
                )}
                onClick={onUnpublish}
              >
                <EyeOffIcon aria-hidden="true" />
                Unpublish page
              </Button>
            </div>
          )
        ) : (
          <>
            <p className="text-[13px] leading-5 text-muted-foreground">
              Players see a not-found page at this address.
            </p>
            {canManage && (
              // Publishing is what unblocks everything else, so it is the
              // popover's one filled button (claude D-52).
              <Button
                type="button"
                className={cn("h-9 w-full px-3", touch, busyLook)}
                aria-disabled={busy || undefined}
                aria-describedby={publishError ? "publish-error" : undefined}
                onClick={() => {
                  if (!busy) onPublish();
                }}
              >
                {busy ? (
                  <Spinner aria-hidden="true" />
                ) : (
                  <GlobeIcon aria-hidden="true" />
                )}
                Publish page
              </Button>
            )}
            {publishError && (
              <div id="publish-error">
                <ActionError>
                  Couldn&apos;t publish the page. {publishError}
                </ActionError>
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function SetupCard({
  canManage,
  published,
  onAdd,
  onSettings,
}: {
  canManage: boolean;
  published: boolean;
  onAdd: () => void;
  onSettings: () => void;
}) {
  const steps = [
    {
      title: "Add a target",
      text: "",
      action: canManage && (
        <Button
          type="button"
          data-focus-key="setup-add"
          className={cn("h-9 px-3", touch)}
          onClick={onAdd}
        >
          <PlusIcon aria-hidden="true" />
          Add target
        </Button>
      ),
    },
    {
      title: "Brand the page",
      text: "Logo, theme, and links.",
      action: (
        <Button
          type="button"
          variant="outline"
          className={cn("h-9 px-3", touch)}
          onClick={onSettings}
        >
          Open settings
        </Button>
      ),
    },
    {
      title: published ? "Share the address" : "Publish",
      text: published
        ? "It's live. Share the address."
        : "Open Private beside the title.",
      action: null,
    },
  ];
  return (
    <Card id="setup" title="Set up your status page">
      <ol className="divide-y divide-border">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4 md:px-5"
          >
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border-strong text-xs font-medium text-muted-foreground tabular-nums"
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1 basis-48">
              <p className="text-sm font-medium">{step.title}</p>
              {step.text && (
                <p className="text-sm text-muted-foreground">{step.text}</p>
              )}
            </div>
            {step.action}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * The Overview's first card: the true status of every target, hidden ones
 * included, from each target's observed health. Maintenance is shown beside
 * the health in words and never stands in for it, so a target that is down
 * during a window still needs attention. What players are told stays on the
 * public page and in the editors' preview.
 */
function TargetHealth({
  components,
  maintenance,
  now,
  checkedAt,
  stale,
  refreshing,
  onRetry,
  onManage,
  phone,
}: {
  components: StatusComponent[];
  maintenance: MaintenanceWindow[];
  now: number;
  checkedAt: number | null;
  stale: boolean;
  refreshing: boolean;
  onRetry: () => void;
  onManage: () => void;
  /** On phones Manage targets closes the card as a row of its own. */
  phone: boolean;
}) {
  // Worst first: what an operator should look at before anything else.
  const rows = components
    .map((component) => ({
      component,
      health: component.health,
      maintained:
        componentStatus(component, maintenance, now) === "maintenance",
    }))
    .sort((a, b) => severity[a.health] - severity[b.health]);
  const attention = rows.filter((r) => r.health !== "operational");
  const working = rows.filter(
    (r) => r.health === "operational" && r.maintained,
  );
  const online = rows.filter(
    (r) => r.health === "operational" && !r.maintained,
  );
  const hidden = rows.filter((r) => !r.component.public).length;
  // A window running on any target is said beside the count, so a healthy
  // headline never hides it (claude D-111). The latest end is when the
  // maintenance is over.
  const running = activeMaintenance(maintenance, now).filter((w) =>
    rows.some(
      (r) =>
        w.componentIds.length === 0 || w.componentIds.includes(r.component.id),
    ),
  );
  const runningUntil = running.length
    ? Math.max(...running.map(windowEnd))
    : null;
  const tone: ComponentStatus = attention[0]?.health ?? "operational";
  const headline = attention.length
    ? `${plural(attention.length, "target")} ${attention.length === 1 ? "needs" : "need"} attention`
    : rows.length === 1
      ? "Your target is operational"
      : `All ${rows.length} targets operational`;
  // A headline a refresh changes is said once; the first one never is.
  const [heard, setHeard] = useState({ headline, spoken: "" });
  if (headline !== heard.headline) setHeard({ headline, spoken: headline });

  const row = ({ component, health, maintained }: (typeof rows)[number]) => (
    <li key={component.id} className="flex items-start gap-3 px-4 py-3 md:px-5">
      <ToneIcon
        tone={health}
        className={cn("mt-0.5 size-4 shrink-0", toneClass[health])}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 text-sm font-medium break-words">
            {component.name}
          </p>
          {!component.public && <Tag>Hidden</Tag>}
          {maintained && (
            <Tag>
              <CalendarClockIcon aria-hidden="true" className="size-3" />
              Maintenance
            </Tag>
          )}
        </div>
        <p className="mt-0.5 text-[13px] leading-5 break-words text-muted-foreground">
          {component.detail ??
            (component.sourceName === null
              ? `Removed ${kindLabel[component.kind].toLowerCase()}`
              : component.sourceName !== component.name
                ? component.sourceName
                : kindLabel[component.kind])}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p
          className={cn("text-[13px] leading-5 font-medium", toneClass[health])}
        >
          {statusLabel[health]}
        </p>
        {component.observedAt !== null && (
          <Time
            at={component.observedAt}
            now={now}
            className="text-[13px] leading-5 text-muted-foreground"
          />
        )}
      </div>
    </li>
  );
  return (
    <section
      aria-labelledby="health-heading"
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-card"
    >
      {/* On phones Manage targets is the card's last row, so it never
          squeezes the headline or sits alone under it (claude D-115). */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-4 pb-4 md:px-5 md:pt-5">
        <div className="min-w-0 flex-1 basis-[20rem]">
          <h2
            id="health-heading"
            className={cn(
              "flex items-start gap-2.5 text-xl font-semibold tracking-tight text-balance sm:text-2xl",
              stale && "text-muted-foreground",
            )}
          >
            <ToneIcon
              tone={tone}
              className={cn(
                "mt-0.5 size-6 shrink-0 sm:mt-1",
                toneClass[tone],
                stale && "opacity-60",
              )}
            />
            {headline}
          </h2>
          <p role="status" className="sr-only">
            {heard.spoken}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-5 text-muted-foreground sm:pl-[2.125rem]">
            <span className="tabular-nums">
              {plural(rows.length, "target")}
              {hidden ? `, ${hidden} hidden` : ""}.
            </span>
            {runningUntil !== null && (
              <span className="flex items-center gap-1.5 text-foreground/80">
                <CalendarClockIcon aria-hidden="true" className="size-3.5" />
                <span>
                  {/* Short enough for one line on phones (claude D-120). */}
                  Maintenance until{" "}
                  <time
                    dateTime={new Date(runningUntil).toISOString()}
                    className="whitespace-nowrap"
                  >
                    {atText(runningUntil, now)}
                  </time>
                  .
                </span>
              </span>
            )}
            {checkedAt !== null &&
              (stale ? (
                // A failed refresh is a fact about this connection, so the
                // card keeps the last known status and says when it was read.
                <span className="flex flex-wrap items-center gap-x-1.5">
                  <TriangleAlertIcon
                    aria-hidden="true"
                    className="size-3.5 text-warning"
                  />
                  <span>
                    Couldn&apos;t refresh. Last checked{" "}
                    <Time at={checkedAt} now={now} relative={false} />.
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn("h-7 px-2", touch)}
                    disabled={refreshing}
                    onClick={onRetry}
                  >
                    <RefreshCwIcon
                      aria-hidden="true"
                      className={cn(refreshing && "animate-spin")}
                    />
                    Retry
                  </Button>
                </span>
              ) : (
                <span>
                  Updated{" "}
                  <time dateTime={new Date(checkedAt).toISOString()}>
                    {atText(checkedAt, now)}
                  </time>
                  .
                </span>
              ))}
          </div>
        </div>
        {!phone && (
          <Button
            type="button"
            variant="ghost"
            className={cn("-mt-1 h-9 shrink-0 px-3", touch)}
            onClick={onManage}
          >
            Manage targets
          </Button>
        )}
      </div>
      {attention.length > 0 && (
        <div className="border-t border-border">
          <h3
            id="attention-heading"
            className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground md:px-5"
          >
            Needs attention
          </h3>
          <ul
            aria-labelledby="attention-heading"
            className="divide-y divide-border"
          >
            {attention.map(row)}
          </ul>
        </div>
      )}
      {working.length > 0 && (
        <div className="border-t border-border">
          <h3
            id="working-heading"
            className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground md:px-5"
          >
            Under maintenance
          </h3>
          <ul
            aria-labelledby="working-heading"
            className="divide-y divide-border"
          >
            {working.map(row)}
          </ul>
        </div>
      )}
      {online.length > 0 && (
        <Collapsible className="group/online border-t border-border">
          <CollapsibleTrigger className="flex h-11 w-full items-center gap-2 px-4 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-surface-elevated/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:px-5">
            <ChevronRightIcon
              aria-hidden="true"
              className="size-4 transition-transform group-data-[state=open]/online:rotate-90"
            />
            <ToneIcon tone="operational" className="size-4 text-primary" />
            {online.length === 1
              ? "1 target operational"
              : `${online.length} targets operational`}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="divide-y divide-border border-t border-border">
              {online.map(row)}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      {phone && (
        <button
          type="button"
          onClick={onManage}
          className="flex h-11 w-full items-center justify-between gap-2 border-t border-border px-4 text-left text-sm font-medium transition-colors outline-none hover:bg-surface-elevated/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          Manage targets
          <ChevronRightIcon
            aria-hidden="true"
            className="size-4 text-muted-foreground"
          />
        </button>
      )}
    </section>
  );
}

function MaintenanceRow({
  window,
  phase,
  now,
  components,
  canManage,
  onEdit,
  onComplete,
  onRemove,
}: {
  window: MaintenanceWindow;
  phase: "scheduled" | "active" | "completed";
  now: number;
  components: StatusComponent[];
  canManage: boolean;
  onEdit?: () => void;
  onComplete?: () => void;
  onRemove: () => void;
}) {
  const { range } = windowLabel(window, now);
  // "9:00 PM UTC" never breaks across lines on a phone.
  const rangeText = range.replace(
    /(\d{1,2}:\d{2})\s?([AP]M)?\s(\S+)/g,
    (_, time: string, half: string | undefined, zone: string) =>
      [time, half, zone].filter(Boolean).join("\u00a0"),
  );
  const end = windowEnd(window);
  const privateOnly = hiddenOnlyWindow(window, components);
  // The range already shows the length, so the timing is one phrase.
  const timing =
    phase === "active"
      ? `Ends ${relativeTime(end, now)}`
      : phase === "scheduled"
        ? `Starts ${relativeTime(window.startsAt, now)}`
        : `Ended ${relativeTime(end, now)}`;
  return (
    <li className="flex items-start gap-3 px-4 py-3 md:px-5">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-elevated text-muted-foreground">
        <CalendarClockIcon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 text-sm font-medium break-words">
            {window.title}
          </p>
          {/* Only a running window gets a badge: the timing line already
              says Starts or Ended, and past windows sit under their own
              heading. */}
          {phase === "active" && (
            <Badge
              variant="outline"
              className="h-[22px] border-foreground/40 text-[13px] text-foreground"
            >
              In progress
            </Badge>
          )}
          {privateOnly && <Tag>Hidden</Tag>}
        </div>
        <p className="mt-0.5 text-[13px] leading-5 text-foreground/80">
          {timing}
        </p>
        <p className="text-[13px] leading-5 text-muted-foreground">
          <time dateTime={new Date(window.startsAt).toISOString()}>
            {rangeText}
          </time>
        </p>
        <p className="text-[13px] leading-5 break-words text-muted-foreground">
          {affectedNames(window, components)}
        </p>
        {canManage && phase === "active" && onComplete && (
          <Button
            type="button"
            variant="outline"
            className={cn("mt-2.5 h-9 px-3", touch)}
            onClick={onComplete}
          >
            <CheckIcon aria-hidden="true" />
            Mark complete
          </Button>
        )}
      </div>
      {canManage && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-focus-key={`window-${window.id}`}
              className={cn("size-9 shrink-0", touchIcon)}
              aria-label={`Actions for ${window.title}`}
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {onEdit && (
              <DropdownMenuItem onSelect={onEdit}>
                <PencilIcon aria-hidden="true" />
                Edit
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2Icon aria-hidden="true" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Dialog pieces                                                       */
/* ------------------------------------------------------------------ */

function SourcePicker({
  kind,
  sources,
  total,
  chosen,
  search,
  onSearch,
  onChoose,
}: {
  kind: Exclude<ComponentKind, "url">;
  sources: StatusSource[];
  total: number;
  chosen: StatusSource | null;
  search: string;
  onSearch: (value: string) => void;
  onChoose: (source: StatusSource) => void;
}) {
  const noun = kind === "machine" ? "machines" : "game servers";
  const href =
    kind === "machine"
      ? "/dashboard/infrastructure/machines"
      : "/dashboard/servers";
  return (
    <Command>
      <CommandInput
        value={search}
        onValueChange={onSearch}
        placeholder={
          kind === "machine" ? "Search machines" : "Search game servers"
        }
      />
      <CommandList>
        <CommandEmpty>
          {sources.length > 0 ? (
            <span className="flex flex-col items-center gap-2">
              No {noun} match &ldquo;{search}&rdquo;.
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn("h-8", touch)}
                onClick={() => onSearch("")}
              >
                Clear search
              </Button>
            </span>
          ) : (
            <span className="flex flex-col items-center gap-2 px-2">
              {total > 0
                ? `Every one of your ${noun} is already on this page.`
                : `You have no ${noun} yet.`}
              <a
                href={href}
                className="text-primary underline-offset-4 hover:underline"
              >
                Go to {kind === "machine" ? "Machines" : "Game servers"}
              </a>
            </span>
          )}
        </CommandEmpty>
        {sources.map((source) => (
          <CommandItem
            key={`${source.kind}:${source.id}`}
            value={`${source.name} ${source.id}`}
            onSelect={() => onChoose(source)}
            className="min-h-9 [@media(any-pointer:coarse)]:min-h-11"
          >
            {source.kind === "server" ? (
              <ServerIcon aria-hidden="true" />
            ) : (
              <HardDriveIcon aria-hidden="true" />
            )}
            {source.name}
            {chosen?.id === source.id && (
              <CheckIcon aria-hidden="true" className="ml-auto" />
            )}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}

function MaintenanceFields({
  form,
  now,
  components,
  unsavedTargets,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: MaintenanceForm;
  now: number;
  components: StatusComponent[];
  unsavedTargets: boolean;
  busy: boolean;
  onChange: (change: Partial<MaintenanceForm>, ...clear: string[]) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  const [startIssue, setStartIssue] = useState<TimeIssue | null>(null);
  const [endIssue, setEndIssue] = useState<TimeIssue | null>(null);
  const summary = scheduleSummary(form, now, !!form.errors["end-time"]);
  const errors = form.errors;
  // A submit error that repeats the field's own message is shown once, as
  // the field's message, so a repeated hour keeps its choice beside it.
  const owned = (key: string, issue: TimeIssue | null) =>
    !!issue && errors[key] === issue.message;
  const startOwned = owned("start-time", startIssue);
  const endOwned = owned("end-time", endIssue);
  const err = (key: string) =>
    (key === "start-time" && startOwned) || (key === "end-time" && endOwned)
      ? undefined
      : errors[key];
  const aria = (key: string, extra?: string) => ({
    "aria-invalid": errors[key] ? (true as const) : undefined,
    "aria-describedby":
      [err(key) && `maintenance-${key}-error`, extra]
        .filter(Boolean)
        .join(" ") || undefined,
  });
  const query = form.search.trim().toLowerCase();
  const matching = components.filter(
    (c) => !query || c.name.toLowerCase().includes(query),
  );
  const groups = groupComponents(matching);
  const selected = new Set(form.componentIds);
  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(form.componentIds);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onChange({ componentIds: [...next] }, "targets");
  };
  const range = windowRange(form);
  const scheduled =
    !invalidField(form) &&
    range.start !== null &&
    range.end !== null &&
    range.end > range.start;
  function chooseLength(value: string) {
    if (!value) return;
    if (value === "custom") {
      const { start, end } = range;
      const until = end ?? (start === null ? null : start + 60 * 60_000);
      onChange(
        until === null
          ? { duration: null }
          : {
              duration: null,
              endDate: dayStart(until),
              endTime: timeTextAt(until),
            },
        "end-time",
        "end-date",
      );
    } else onChange({ duration: Number(value) }, "end-time", "end-date");
  }
  const zone = zoneName(now);
  const affectsHiddenOnly =
    !form.all &&
    form.componentIds.length > 0 &&
    components.filter((c) => selected.has(c.id)).every((c) => !c.public);
  return (
    <form onSubmit={onSubmit} className="contents" noValidate>
      <DialogHeader>
        <DialogTitle>
          {form.window ? "Edit maintenance window" : "Schedule maintenance"}
        </DialogTitle>
        <DialogDescription>
          Players see it as soon as you save.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-2">
          <Label htmlFor="maintenance-title">Title</Label>
          <Input
            id="maintenance-title"
            data-focus-key="maintenance-title"
            maxLength={120}
            value={form.title}
            {...aria("title")}
            onChange={(e) => onChange({ title: e.target.value }, "title")}
            placeholder="Monthly wipe"
            className="h-10"
          />
          {err("title") && (
            <FieldMessage id="maintenance-title-error">
              {err("title")}
            </FieldMessage>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="maintenance-message">Message</Label>
          <Textarea
            id="maintenance-message"
            maxLength={2000}
            rows={3}
            value={form.message}
            onChange={(e) => onChange({ message: e.target.value })}
            placeholder="Optional details for players"
          />
        </div>

        {/* A container, so date and time stack when the dialog is too
            narrow for a whole date beside the time (claude D-63). */}
        <fieldset className="@container min-w-0 space-y-3">
          <legend className="text-sm font-medium">When</legend>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,8rem)] gap-3 @max-[22rem]:grid-cols-1">
            <div className="min-w-0 space-y-1.5">
              <Label
                htmlFor="maintenance-start-date"
                className="text-xs text-muted-foreground"
              >
                Start date
              </Label>
              <DatePicker
                id="maintenance-start-date"
                data-focus-key="maintenance-start-date"
                value={form.startDate}
                min={form.window ? undefined : new Date(now)}
                {...aria("start-date")}
                onChange={(startDate) =>
                  onChange(
                    { startDate },
                    "start-date",
                    "start-time",
                    "end-time",
                  )
                }
              />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label
                htmlFor="maintenance-start-time"
                className="text-xs text-muted-foreground"
              >
                Start time
              </Label>
              <TimeField
                id="maintenance-start-time"
                // The schedule summary already speaks the new time.
                announceSteps={false}
                data-focus-key="maintenance-start-time"
                value={form.startTime}
                date={form.startDate}
                onIssueChange={setStartIssue}
                {...aria("start-time", "maintenance-zone")}
                onChange={(startTime) =>
                  onChange({ startTime }, "start-time", "end-time")
                }
              />
            </div>
          </div>
          {(err("start-date") || err("start-time")) && (
            <FieldMessage
              id={
                err("start-date")
                  ? "maintenance-start-date-error"
                  : "maintenance-start-time-error"
              }
            >
              {err("start-date") ?? err("start-time")}
            </FieldMessage>
          )}
          {startIssue && !err("start-time") && (
            <TimeFieldMessage issue={startIssue} />
          )}

          <div className="space-y-1.5">
            <p
              id="maintenance-length-label"
              className="text-xs font-medium text-muted-foreground"
            >
              Length
            </p>
            <ToggleGroup
              type="single"
              value={form.duration === null ? "custom" : String(form.duration)}
              onValueChange={chooseLength}
              {...selectOnArrow(chooseLength)}
              aria-labelledby="maintenance-length-label"
              variant="segmented"
              className="grid grid-cols-5"
            >
              {[...durationPresets, { label: "Custom", ms: -1 }].map(
                (preset) => {
                  const value = preset.ms === -1 ? "custom" : String(preset.ms);
                  return (
                    <ToggleGroupItem
                      key={preset.label}
                      value={value}
                      data-value={value}
                      aria-label={preset.ms === -1 ? "Custom end" : undefined}
                      className="h-8 px-1"
                    >
                      {preset.label}
                    </ToggleGroupItem>
                  );
                },
              )}
            </ToggleGroup>
          </div>

          {form.duration === null && (
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,8rem)] gap-3 @max-[22rem]:grid-cols-1">
              <div className="min-w-0 space-y-1.5">
                <Label
                  htmlFor="maintenance-end-date"
                  className="text-xs text-muted-foreground"
                >
                  End date
                </Label>
                <DatePicker
                  id="maintenance-end-date"
                  data-focus-key="maintenance-end-date"
                  value={form.endDate}
                  min={form.startDate ?? undefined}
                  {...aria("end-date")}
                  onChange={(endDate) =>
                    onChange({ endDate }, "end-date", "end-time")
                  }
                />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label
                  htmlFor="maintenance-end-time"
                  className="text-xs text-muted-foreground"
                >
                  End time
                </Label>
                <TimeField
                  id="maintenance-end-time"
                  announceSteps={false}
                  data-focus-key="maintenance-end-time"
                  value={form.endTime}
                  date={form.endDate}
                  onIssueChange={setEndIssue}
                  {...aria("end-time", "maintenance-zone")}
                  onChange={(endTime) =>
                    onChange({ endTime }, "end-time", "end-date")
                  }
                />
              </div>
            </div>
          )}
          {(err("end-date") || err("end-time")) && (
            <FieldMessage
              id={
                err("end-date")
                  ? "maintenance-end-date-error"
                  : "maintenance-end-time-error"
              }
            >
              {err("end-date") ?? err("end-time")}
            </FieldMessage>
          )}
          {form.duration === null && endIssue && !err("end-time") && (
            <TimeFieldMessage issue={endIssue} />
          )}

          <div className="rounded-lg border border-border bg-surface-elevated/50 px-3 py-2.5">
            {/* Spoken when the operator changes the window: absolute times
                only, so the 30-second clock never re-announces it. */}
            <p aria-live="polite" className="sr-only">
              {spokenSchedule(form, now)}
            </p>
            <p
              data-testid="maintenance-summary"
              className={cn(
                "text-sm",
                // Not a schedule yet: read as guidance, not as a result.
                !scheduled && "text-muted-foreground",
              )}
            >
              {summary}
            </p>
            <p
              id="maintenance-zone"
              className="mt-0.5 text-[13px] leading-5 text-muted-foreground"
            >
              Your time zone, {zone}. Players see theirs.
            </p>
          </div>
        </fieldset>

        <fieldset className="min-w-0 space-y-3">
          <legend
            id="maintenance-targets-legend"
            className="text-sm font-medium"
          >
            Affected targets
          </legend>
          <RadioGroup
            aria-labelledby="maintenance-targets-legend"
            value={form.all ? "all" : "some"}
            onValueChange={(value) =>
              onChange({ all: value === "all" }, "targets")
            }
            className="gap-1"
          >
            <label className="flex min-h-10 items-center gap-3 text-sm [@media(any-pointer:coarse)]:min-h-11">
              <RadioGroupItem value="all" />
              All targets
            </label>
            <label
              className={cn(
                "flex min-h-10 items-center gap-3 text-sm [@media(any-pointer:coarse)]:min-h-11",
                components.length === 0 && "text-muted-foreground",
              )}
            >
              <RadioGroupItem value="some" disabled={components.length === 0} />
              Specific targets
            </label>
          </RadioGroup>
          {components.length === 0 && (
            <p className="text-[13px] leading-5 text-muted-foreground">
              Save targets first to pick them here.
            </p>
          )}
          {!form.all && components.length > 0 && (
            <div
              className={cn(
                "space-y-2 rounded-lg border p-3",
                err("targets") ? "border-destructive" : "border-border",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p
                  id="maintenance-targets-count"
                  className="text-[13px] text-muted-foreground tabular-nums"
                >
                  {form.componentIds.length} of {components.length} selected
                </p>
                {components.length > 5 && (
                  <div className="relative min-w-0 flex-1 basis-40">
                    <SearchIcon
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      aria-label="Search targets"
                      value={form.search}
                      onChange={(e) => onChange({ search: e.target.value })}
                      className="h-8 pl-8 text-sm [@media(any-pointer:coarse)]:h-11"
                      placeholder="Search targets"
                    />
                  </div>
                )}
              </div>
              {/* What blocks or limits the choice sits above the list, where
                  it is seen before scrolling through targets. */}
              {err("targets") && (
                <FieldMessage id="maintenance-targets-error">
                  {err("targets")}
                </FieldMessage>
              )}
              {affectsHiddenOnly && (
                <p className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[13px] leading-5 text-warning">
                  <EyeOffIcon
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                  Players won&apos;t see this: every chosen target is hidden.
                </p>
              )}
              {/* One scroll region at every width: the dialog body scrolls,
                  the list never does, and choosing Specific targets never
                  moves the scroll, so Title stays put (claude D-40). */}
              <div className="space-y-3">
                {groups.map((group) => {
                  const ids = group.items.map((c) => c.id);
                  const count = ids.filter((id) => selected.has(id)).length;
                  return (
                    <div
                      key={group.name || "(ungrouped)"}
                      className="space-y-1"
                    >
                      <label className="flex min-h-9 items-center gap-3 text-xs font-medium text-muted-foreground [@media(any-pointer:coarse)]:min-h-11">
                        <Checkbox
                          data-focus-key={
                            group === groups[0]
                              ? "maintenance-targets"
                              : undefined
                          }
                          aria-describedby={
                            err("targets")
                              ? "maintenance-targets-error"
                              : undefined
                          }
                          checked={
                            count === 0
                              ? false
                              : count === ids.length
                                ? true
                                : "indeterminate"
                          }
                          onCheckedChange={(checked) =>
                            toggle(ids, checked === true)
                          }
                        />
                        {group.name || "No group"}
                        <span className="font-normal tabular-nums">
                          {count}/{ids.length}
                        </span>
                      </label>
                      <div className="space-y-0.5 pl-7">
                        {group.items.map((component) => (
                          <label
                            key={component.id}
                            className="flex min-h-9 items-center gap-3 text-sm [@media(any-pointer:coarse)]:min-h-11"
                          >
                            <Checkbox
                              checked={selected.has(component.id)}
                              onCheckedChange={(checked) =>
                                toggle([component.id], checked === true)
                              }
                            />
                            <span className="min-w-0 truncate">
                              {component.name}
                            </span>
                            {!component.public && <Tag>Hidden</Tag>}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {groups.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No targets match &ldquo;{form.search}&rdquo;.
                  </p>
                )}
              </div>
            </div>
          )}
          {unsavedTargets && (
            <p className="text-[13px] leading-5 text-muted-foreground">
              Unsaved targets show here once saved.
            </p>
          )}
        </fieldset>
        {errors.general && (
          <p
            role="alert"
            className="flex items-start gap-1.5 text-sm text-destructive"
          >
            <CircleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0"
            />
            {errors.general}
          </p>
        )}
      </DialogBody>
      <DialogFooter className={fitFooter}>
        <Button
          type="button"
          variant="outline"
          className={cn("h-10 px-4", touch)}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          className={cn("h-10 px-4", touch)}
          disabled={busy}
        >
          {busy && <Spinner aria-hidden="true" />}
          {busy
            ? "Saving window..."
            : form.window
              ? "Save window"
              : "Schedule maintenance"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Settings pieces                                                     */
/* ------------------------------------------------------------------ */

function ThemeCard({ theme, accent }: { theme: StatusTheme; accent: string }) {
  const { label, Icon } = themeOption[theme];
  const sketch = (light: boolean) => (
    <div
      className={cn(
        "flex h-full flex-1 flex-col gap-1 bg-background p-1.5",
        light && "theme-light",
      )}
    >
      <span
        className="h-0.5 w-full rounded-full"
        style={{ background: accent }}
      />
      <span className="mt-0.5 h-1.5 w-2/3 rounded-sm bg-foreground/70" />
      <span className="h-3 w-full rounded-sm border border-border bg-card" />
      <span className="h-3 w-full rounded-sm border border-border bg-card" />
    </div>
  );
  return (
    <ToggleGroupItem
      value={theme}
      data-value={theme}
      // Selected: a sage border and a check. Focus: the shared offset ring.
      className="group/theme relative h-auto min-w-0 flex-col items-stretch gap-0 overflow-hidden rounded-lg border border-border bg-transparent p-0 text-xs text-muted-foreground hover:bg-surface-elevated/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card data-[state=on]:border-primary data-[state=on]:bg-transparent data-[state=on]:text-foreground"
    >
      <span aria-hidden="true" className="flex h-16 border-b border-border">
        {theme === "system" ? (
          <>
            {sketch(false)}
            {sketch(true)}
          </>
        ) : (
          sketch(theme === "light")
        )}
      </span>
      <span className="flex h-9 items-center justify-center gap-1.5 [@media(any-pointer:coarse)]:h-11">
        <Icon aria-hidden="true" className="size-3.5" />
        {label}
      </span>
      <span
        aria-hidden="true"
        className="absolute top-1.5 right-1.5 hidden size-4 items-center justify-center rounded-full bg-primary text-primary-foreground group-data-[state=on]/theme:flex"
      >
        <CheckIcon className="size-3" />
      </span>
    </ToggleGroupItem>
  );
}

function AccentField({
  value,
  theme,
  error,
  onChange,
}: {
  value: string;
  theme: StatusTheme;
  error?: string;
  onChange: (value: string) => void;
}) {
  const color = value.trim().toLowerCase();
  const valid = validColor(color);
  const preset = accentPresets.includes(color) ? color : "";
  const checks = (
    theme === "system" ? (["dark", "light"] as const) : [theme]
  ).map((background) => ({
    background,
    ratio: valid ? contrastRatio(color, statusBackgrounds[background]) : null,
  }));
  return (
    <div className="space-y-2">
      <Label htmlFor="status-accent">Accent color</Label>
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          type="single"
          value={preset}
          onValueChange={(next) => {
            if (next) onChange(next);
          }}
          {...selectOnArrow(onChange)}
          aria-label="Accent presets"
          spacing={2}
          className="flex flex-wrap gap-2"
        >
          {accentPresets.map((swatch, index) => (
            <Tooltip key={swatch}>
              <TooltipTrigger asChild>
                <ToggleGroupItem
                  value={swatch}
                  data-value={swatch}
                  aria-label={`${accentNames[index] ?? "Preset"} (${swatch})`}
                  // Selected: a check and an inner edge, keyed on
                  // aria-checked because the tooltip owns data-state. Focus:
                  // the shared sage ring, offset outside the swatch. In
                  // forced colors the swatch keeps its color (the color is
                  // the content) with a CanvasText edge; selected adds a
                  // Highlight edge and a HighlightText check on Highlight,
                  // and focus is a CanvasText outline (claude D-64, codex
                  // D-40, a11y D-70).
                  className="size-8 min-w-0 rounded-full border border-border-strong p-0 hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card aria-checked:shadow-[inset_0_0_0_2px_var(--color-card)] aria-checked:border-foreground [@media(any-pointer:coarse)]:size-11 forced-color-adjust-none forced-colors:border-[CanvasText] forced-colors:aria-checked:border-2 forced-colors:aria-checked:border-[Highlight] forced-colors:aria-checked:shadow-none forced-colors:focus-visible:ring-0 forced-colors:focus-visible:ring-offset-0 forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-solid forced-colors:focus-visible:outline-offset-2 forced-colors:focus-visible:outline-[color:CanvasText]"
                  style={{ background: swatch }}
                >
                  {preset === swatch && (
                    <span
                      data-slot="accent-check"
                      className="grid size-5 place-items-center rounded-full text-(--swatch-check) forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]"
                      style={
                        {
                          "--swatch-check": accentForeground(swatch),
                        } as CSSProperties
                      }
                    >
                      <CheckIcon aria-hidden="true" className="size-4" />
                    </span>
                  )}
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>{accentNames[index]}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        <InputFrame className={cn("w-36", error && "border-destructive")}>
          <span
            aria-hidden="true"
            // Keeps the chosen color in forced colors, like the presets.
            className="size-4 shrink-0 rounded-sm border border-border-strong forced-color-adjust-none forced-colors:border-[CanvasText]"
            style={{ background: valid ? color : "transparent" }}
          />
          <InputFrameControl
            id="status-accent"
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={cn(
              error && "status-accent-error",
              "status-accent-contrast",
            )}
            onChange={(e) => onChange(e.target.value)}
            className="font-mono"
          />
        </InputFrame>
      </div>
      {error && <FieldMessage id="status-accent-error">{error}</FieldMessage>}
      {/* A verdict an operator can act on, in one line; the ratios are one
          press away for those who want them (codex D-47). */}
      {valid &&
        (() => {
          const weak = checks.filter((c) => c.ratio !== null && c.ratio < 3);
          const pages = (list: typeof checks) =>
            `${joinList(list.map((c) => c.background))} pages`;
          const ratio = (r: number) => `${r.toFixed(1)}:1`;
          return (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p
                id="status-accent-contrast"
                className={cn(
                  "flex items-start gap-1.5 text-[13px] leading-5",
                  weak.length > 0 ? "text-warning" : "text-muted-foreground",
                )}
              >
                {weak.length > 0 ? (
                  <TriangleAlertIcon
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                ) : (
                  <CheckIcon
                    aria-hidden="true"
                    className="mt-0.5 size-3.5 shrink-0 text-primary"
                  />
                )}
                <span>
                  {weak.length > 0
                    ? `Fades on ${pages(weak)}. Try a stronger color.`
                    : `Stands out on ${pages(checks)}.`}
                </span>
              </p>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Contrast ratios"
                    className={cn(
                      "h-7 px-2 text-[13px] text-muted-foreground",
                      touch,
                    )}
                  >
                    Ratios
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-60 p-3">
                  <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[13px] leading-5">
                    {checks.map(({ background, ratio: r }) => (
                      <Fragment key={background}>
                        <dt className="text-muted-foreground">
                          {background === "dark" ? "Dark" : "Light"} pages
                        </dt>
                        <dd
                          className={cn(
                            "text-right tabular-nums",
                            r! < 3 && "text-warning",
                          )}
                        >
                          {ratio(r!)}
                        </dd>
                      </Fragment>
                    ))}
                    <dt className="text-muted-foreground">Button text</dt>
                    <dd className="text-right tabular-nums">
                      {ratio(accentTextContrast(color))}
                    </dd>
                  </dl>
                  <p className="mt-2 border-t border-border pt-2 text-[13px] leading-5 text-muted-foreground">
                    The top bar and button need 3:1.
                  </p>
                </PopoverContent>
              </Popover>
            </div>
          );
        })()}
    </div>
  );
}

function WidthToggle({
  width,
  onWidth,
}: {
  width: "desktop" | "phone";
  onWidth: (width: "desktop" | "phone") => void;
}) {
  const choose = (value: string) => {
    if (value === "desktop" || value === "phone") onWidth(value);
  };
  return (
    <ToggleGroup
      type="single"
      value={width}
      onValueChange={choose}
      {...selectOnArrow(choose)}
      aria-label="Preview width"
      variant="segmented"
      className="w-auto bg-surface-elevated"
    >
      {(
        [
          ["desktop", "Desktop", MonitorIcon],
          ["phone", "Phone", SmartphoneIcon],
        ] as const
      ).map(([value, label, Icon]) => (
        <ToggleGroupItem
          key={value}
          value={value}
          data-value={value}
          className="h-7 gap-1.5 px-2.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface-elevated"
        >
          <Icon aria-hidden="true" className="size-3.5" />
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function PreviewHeader({ id, onExpand }: { id: string; onExpand: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-4 py-3">
      <h2 id={id} className="min-w-0 text-base font-semibold">
        Public preview
      </h2>
      {/* The column fits the phone frame at real size; the desktop page
          opens at real size in the sheet rather than as an unreadable
          thumbnail here (claude D-62). */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-focus-key="preview-full"
        className={cn("h-8 px-2.5 text-xs", touch)}
        onClick={onExpand}
      >
        <MonitorIcon aria-hidden="true" />
        Desktop preview
      </Button>
    </div>
  );
}

/** Screens narrower than Tailwind's `sm`: previews show the phone frame. */
/** The page's main landmark, for overlays that should stay inside it. */
function mainLandmark() {
  if (typeof document === "undefined") return undefined;
  return document.getElementById("main-content") ?? undefined;
}

const PHONE_QUERY = "(max-width: 639px)";

/** A media query's current answer; false on the server. */
function useMedia(query: string) {
  return useSyncExternalStore(
    (change) => {
      const list = window.matchMedia?.(query);
      list?.addEventListener("change", change);
      return () => list?.removeEventListener("change", change);
    },
    () => window.matchMedia?.(query).matches ?? false,
    () => false,
  );
}
/** The desktop preview is laid out at this width, then scaled to fit. */
const DESKTOP_PREVIEW = 1024;

/**
 * The real public view, inert: no links in the tab order, no landmarks.
 * Desktop renders the page at a real desktop width and scales the frame down
 * to the space available, so container queries pick the desktop layout.
 */
function PreviewFrame({
  data,
  logoUrl,
  now,
  width,
}: {
  data: PublicStatus;
  logoUrl: string | null;
  now: number;
  width: "desktop" | "phone";
}) {
  const outer = useRef<HTMLDivElement | null>(null);
  const inner = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ available: 0, height: 0 });
  useEffect(() => {
    const frame = outer.current;
    const page = inner.current;
    if (!frame || !page) return;
    const measure = () =>
      setBox({ available: frame.clientWidth, height: page.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(page);
    return () => observer.disconnect();
  }, []);
  const scaled = width === "desktop" && box.available > 0 && box.height > 0;
  const scale = scaled ? Math.min(1, box.available / DESKTOP_PREVIEW) : 1;
  return (
    <div
      ref={outer}
      data-preview-scale={scale.toFixed(2)}
      className={cn(
        "mx-auto overflow-hidden rounded-lg border border-border",
        width === "phone" ? "w-[360px] max-w-full" : "w-full",
      )}
      style={scaled ? { height: Math.ceil(box.height * scale) + 2 } : undefined}
    >
      <div
        ref={inner}
        inert
        className="@container origin-top-left"
        style={
          scaled
            ? { width: DESKTOP_PREVIEW, transform: `scale(${scale})` }
            : undefined
        }
      >
        <PublicStatusView embedded data={data} logoUrl={logoUrl} now={now} />
      </div>
    </div>
  );
}
