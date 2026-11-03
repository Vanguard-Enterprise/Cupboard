"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarClockIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  GlobeIcon,
  GripVerticalIcon,
  HardDriveIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { toast } from "sonner";
import { apiRequest, type Identity } from "@/lib/api-client";
import {
  activeMaintenance,
  affectedNames,
  componentStatus,
  draftOf,
  groupComponents,
  localDateTimeValue,
  maintenancePhase,
  maxComponents,
  moveComponent,
  overallStatus,
  parseLocalDateTime,
  publicPath,
  sameDraft,
  slugify,
  statusLabel,
  unusedSources,
  validSlug,
  windowLabel,
  type ComponentDraft,
  type ComponentKind,
  type ComponentStatus,
  type MaintenanceWindow,
  type OverallStatus,
  type PageDraft,
  type StatusComponent,
  type StatusPageState,
  type StatusSource,
} from "@/lib/status-page";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The request could not be completed.";

type Tone = OverallStatus["tone"];
const toneClass: Record<Tone, string> = {
  operational: "text-primary",
  degraded: "text-warning",
  down: "text-destructive",
  maintenance: "text-muted-foreground",
  unknown: "text-muted-foreground",
};
const toneTile: Record<Tone, string> = {
  operational: "border-primary/40 bg-primary/10 text-primary",
  degraded: "border-warning/40 bg-warning/10 text-warning",
  down: "border-destructive/40 bg-destructive/10 text-destructive",
  maintenance: "border-border-strong bg-surface-elevated text-foreground",
  unknown: "border-border bg-surface-elevated text-muted-foreground",
};
function ToneIcon({ tone, className }: { tone: Tone; className?: string }) {
  const Icon =
    tone === "operational"
      ? CircleCheckIcon
      : tone === "degraded"
        ? TriangleAlertIcon
        : tone === "down"
          ? CircleAlertIcon
          : tone === "maintenance"
            ? WrenchIcon
            : CircleHelpIcon;
  return <Icon aria-hidden="true" className={className} />;
}

function StatusDot({ status }: { status: ComponentStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "operational" && "bg-primary",
        status === "degraded" && "bg-warning",
        status === "down" && "bg-destructive",
        status === "maintenance" && "bg-foreground/70",
        status === "unknown" && "bg-border-strong",
      )}
    />
  );
}

function KindIcon({ kind }: { kind: ComponentKind }) {
  const Icon = kind === "server" ? ServerIcon : HardDriveIcon;
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-elevated">
      <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
    </span>
  );
}

function Section({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 md:px-6">
        <div className="min-w-0 space-y-1">
          <h2 id={`${id}-heading`} className="text-base font-semibold">
            {title}
          </h2>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

type MaintenanceForm = {
  window: MaintenanceWindow | null;
  title: string;
  message: string;
  startsAt: string;
  endsAt: string;
  all: boolean;
  componentIds: string[];
  error: string;
};
type ComponentForm = {
  index: number | null;
  sourceLabel: string | null;
  name: string;
  groupName: string;
  public: boolean;
  error: string;
};

function sourceLabel(source: StatusSource) {
  return `${source.name} (${source.kind})`;
}

export function StatusPageAdmin({ identity }: { identity: Identity }) {
  const organization = identity.organization!;
  const canView = identity.permissions.includes("infrastructure.view");
  const canManage = identity.permissions.includes("infrastructure.manage");
  const [state, setState] = useState<StatusPageState | null>(null);
  const [draft, setDraft] = useState<PageDraft | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The server renders no origin so the address matches after hydration.
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
  const [tab, setTab] = useState("overview");
  const [copied, setCopied] = useState(false);
  const [componentForm, setComponentForm] = useState<ComponentForm | null>(
    null,
  );
  const [sourceOpen, setSourceOpen] = useState(false);
  const [maintenanceForm, setMaintenanceForm] =
    useState<MaintenanceForm | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [completing, setCompleting] = useState<MaintenanceWindow | null>(null);
  const [removing, setRemoving] = useState<MaintenanceWindow | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const pointerDrag = useRef<{
    index: number;
    pointerId: number;
    x: number;
    y: number;
    moved: boolean;
    target: number | null;
  } | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);

  const dirty =
    state !== null && draft !== null && !sameDraft(draft, draftOf(state));

  const adopt = useCallback((next: StatusPageState) => {
    setState((previous) => {
      setDraft((current) =>
        current && previous && !sameDraft(current, draftOf(previous))
          ? current
          : draftOf(next),
      );
      return next;
    });
    setCheckedAt(Date.now());
    setNow(Date.now());
  }, []);

  const load = useCallback(async () => {
    if (!canView) return;
    try {
      adopt(
        await apiRequest<StatusPageState>(
          "status-page",
          undefined,
          organization.id,
        ),
      );
      setLoadError("");
    } catch (cause) {
      setLoadError(message(cause));
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

  if (!state || !draft) {
    return loadError ? (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-5 text-sm text-destructive"
      >
        <p>{loadError}</p>
        <Button variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    ) : (
      <div aria-label="Loading status page" role="status" className="space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="size-12 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-4 w-72" />
          </div>
        </div>
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  const components = state.components;
  const overall = overallStatus(components, state.maintenance, now);
  const slug = draft.slugEdited ? draft.slug : slugify(draft.name);
  const publicUrl = `${origin}${publicPath(slug)}`;
  const windows = state.maintenance.map((w) => ({
    window: w,
    phase: maintenancePhase(w, now),
  }));
  const current = windows.filter((w) => w.phase === "active");
  const upcoming = windows
    .filter((w) => w.phase === "scheduled")
    .sort((a, b) => a.window.startsAt - b.window.startsAt);
  const past = windows.filter((w) => w.phase === "completed");
  const existingGroups = [
    ...new Set(draft.components.map((c) => c.groupName).filter(Boolean)),
  ];
  const available = unusedSources(state.sources, draft.components);

  function updateDraft(change: Partial<PageDraft>) {
    setDraft((current) => (current ? { ...current, ...change } : current));
    setSaveError("");
  }
  function updateComponents(
    update: (components: ComponentDraft[]) => ComponentDraft[],
  ) {
    setDraft((current) =>
      current
        ? { ...current, components: update(current.components) }
        : current,
    );
    setSaveError("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!state || !draft || saving) return;
    const name = draft.name.trim();
    if (!name) {
      setSaveError("Enter a page name.");
      nameInput.current?.focus();
      return;
    }
    if (!validSlug(slug)) {
      setSaveError(
        "Use 1 to 40 lower-case letters, digits, and hyphens for the public address.",
      );
      return;
    }
    setSaving(true);
    try {
      const next = await apiRequest<StatusPageState>(
        "status-page",
        {
          revision: state.revision,
          name,
          slug,
          published: draft.published,
          announcement: draft.announcement,
          supportUrl: draft.supportUrl,
          components: draft.components,
        },
        organization.id,
      );
      setState(next);
      setDraft(draftOf(next));
      setCheckedAt(Date.now());
      setSaveError("");
      toast.success("Status page saved.");
    } catch (cause) {
      setSaveError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  function reload() {
    setDraft(null);
    setSaveError("");
    void load();
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Copy failed. Select the address and copy it manually.");
    }
  }

  function openSchedule(window: MaintenanceWindow | null) {
    const start = window ? window.startsAt : Math.ceil(now / 900_000) * 900_000;
    const end = window ? window.endsAt : start + 60 * 60_000;
    setMaintenanceForm({
      window,
      title: window?.title ?? "",
      message: window?.message ?? "",
      startsAt: localDateTimeValue(start),
      endsAt: localDateTimeValue(end),
      all: window ? window.componentIds.length === 0 : true,
      componentIds: window?.componentIds ?? [],
      error: "",
    });
  }

  async function submitMaintenance(event: FormEvent) {
    event.preventDefault();
    if (!maintenanceForm || maintenanceBusy) return;
    const form = maintenanceForm;
    const title = form.title.trim();
    const startsAt = parseLocalDateTime(form.startsAt);
    const endsAt = parseLocalDateTime(form.endsAt);
    const fail = (error: string) =>
      setMaintenanceForm((current) =>
        current ? { ...current, error } : current,
      );
    if (!title) return fail("Enter a title for the maintenance window.");
    if (startsAt === null || endsAt === null)
      return fail("Enter when the window starts and ends.");
    if (endsAt <= startsAt) return fail("The window must end after it starts.");
    if (!form.all && form.componentIds.length === 0)
      return fail("Choose at least one affected component, or select all.");
    setMaintenanceBusy(true);
    try {
      const next = await apiRequest<StatusPageState>(
        form.window
          ? `status-page/maintenance/${form.window.id}`
          : "status-page/maintenance",
        {
          title,
          message: form.message,
          startsAt,
          endsAt,
          componentIds: form.all ? [] : form.componentIds,
        },
        organization.id,
      );
      adopt(next);
      setMaintenanceForm(null);
      toast.success(
        form.window ? "Maintenance window updated." : "Maintenance scheduled.",
      );
    } catch (cause) {
      fail(message(cause));
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function runAction(path: string, done: string, clear: () => void) {
    setActionBusy(true);
    try {
      adopt(await apiRequest<StatusPageState>(path, {}, organization.id));
      clear();
      toast.success(done);
    } catch (cause) {
      toast.error(message(cause));
    } finally {
      setActionBusy(false);
    }
  }

  function submitComponent(event: FormEvent) {
    event.preventDefault();
    if (!componentForm) return;
    const form = componentForm;
    const name = form.name.trim();
    const groupName = form.groupName.trim();
    const fail = (error: string) =>
      setComponentForm((current) =>
        current ? { ...current, error } : current,
      );
    if (!name) return fail("Enter a display name.");
    if (form.index === null) {
      const source = available.find((s) => sourceLabel(s) === form.sourceLabel);
      if (!source) return fail("Choose a server or machine to show.");
      if (draft!.components.length >= maxComponents)
        return fail(
          `A status page can list up to ${maxComponents} components.`,
        );
      updateComponents((list) => [
        ...list,
        {
          id: null,
          name,
          kind: source.kind,
          sourceId: source.id,
          groupName,
          public: form.public,
        },
      ]);
    } else {
      updateComponents((list) =>
        list.map((c, i) =>
          i === form.index ? { ...c, name, groupName, public: form.public } : c,
        ),
      );
    }
    setComponentForm(null);
  }

  function move(from: number, to: number) {
    updateComponents((list) => moveComponent(list, from, to));
  }

  const sourceName = (component: ComponentDraft) =>
    state.sources.find(
      (s) => s.kind === component.kind && s.id === component.sourceId,
    )?.name ?? null;

  const checkedLabel = checkedAt
    ? `Checked ${formatDistanceToNow(checkedAt, { addSuffix: true })}`
    : "";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <span
            className={cn(
              "flex size-12 shrink-0 items-center justify-center rounded-xl border",
              toneTile[overall.tone],
            )}
          >
            <ToneIcon tone={overall.tone} className="size-6" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {draft.name.trim() || state.name}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <Badge variant="outline" className="gap-1">
                {state.published ? (
                  <GlobeIcon aria-hidden="true" />
                ) : (
                  <EyeOffIcon aria-hidden="true" />
                )}
                {state.published ? "Public" : "Not published"}
              </Badge>
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate font-mono text-xs">{publicUrl}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Copy public address"
                      onClick={() => void copyUrl()}
                    >
                      {copied ? (
                        <CheckIcon
                          aria-hidden="true"
                          className="text-primary"
                        />
                      ) : (
                        <CopyIcon aria-hidden="true" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {copied ? "Copied" : "Copy public address"}
                  </TooltipContent>
                </Tooltip>
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {state.published && (
            <Button
              asChild
              variant="outline"
              className="h-10 px-4 [@media(any-pointer:coarse)]:min-h-11"
            >
              <a href={publicPath(state.slug)} target="_blank" rel="noreferrer">
                Visit status page
                <ExternalLinkIcon aria-hidden="true" />
              </a>
            </Button>
          )}
          {canManage && (
            <Button
              type="button"
              className="h-10 px-4 [@media(any-pointer:coarse)]:min-h-11"
              onClick={() => openSchedule(null)}
            >
              <CalendarClockIcon aria-hidden="true" />
              Schedule maintenance
            </Button>
          )}
        </div>
      </div>

      {loadError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {loadError} Showing the last loaded state.
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList
          variant="line"
          className="h-9 w-full justify-start rounded-none border-b border-border p-0"
        >
          {(["overview", "settings"] as const).map((value) => (
            <TabsTrigger
              key={value}
              value={value}
              className="h-full flex-none rounded-none px-3 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:after:bottom-[-1px] data-[state=active]:after:bg-primary"
            >
              {value === "overview" ? "Overview" : "Settings"}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-6">
          <div
            role="status"
            className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card px-5 py-4 md:px-6"
          >
            <ToneIcon
              tone={overall.tone}
              className={cn("size-7 shrink-0", toneClass[overall.tone])}
            />
            <div className="min-w-0 flex-1 basis-48">
              <p className="text-lg font-semibold">{overall.title}</p>
              <p className="truncate text-sm text-muted-foreground">
                {overall.detail}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <span>{checkedLabel}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh status"
                onClick={() => void load()}
              >
                <RefreshCwIcon aria-hidden="true" />
              </Button>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Section
              id="components"
              title="Components"
              description="Live health for everything on the page."
            >
              {components.length === 0 ? (
                <div className="border-t border-border px-5 py-8 text-center md:px-6">
                  <p className="text-sm font-medium">No components yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Add the servers and machines your players rely on.
                  </p>
                  {canManage && (
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-4 h-10 px-4"
                      onClick={() => setTab("settings")}
                    >
                      <PlusIcon aria-hidden="true" />
                      Add components
                    </Button>
                  )}
                </div>
              ) : (
                <ul className="divide-y divide-border border-t border-border">
                  {groupComponents(components).map((group) => (
                    <li key={group.name || "(ungrouped)"}>
                      {group.name && (
                        <p className="bg-surface-elevated/60 px-5 py-1.5 text-xs font-medium text-muted-foreground md:px-6">
                          {group.name}
                        </p>
                      )}
                      <ul className="divide-y divide-border">
                        {group.items.map((component) => {
                          const status = componentStatus(
                            component,
                            state.maintenance,
                            now,
                          );
                          return (
                            <li
                              key={component.id}
                              className="flex items-center gap-3 px-5 py-3 md:px-6"
                            >
                              <StatusDot status={status} />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">
                                  {component.name}
                                </p>
                                <p className="truncate text-xs text-muted-foreground">
                                  {component.sourceName === null
                                    ? `Removed ${component.kind}`
                                    : component.sourceName !== component.name
                                      ? component.sourceName
                                      : component.kind === "server"
                                        ? "Game server"
                                        : "Machine"}
                                  {component.observedAt
                                    ? ` · ${formatDistanceToNow(component.observedAt, { addSuffix: true })}`
                                    : ""}
                                </p>
                              </div>
                              <span
                                className={cn(
                                  "text-xs font-medium",
                                  toneClass[status],
                                )}
                              >
                                {statusLabel[status]}
                              </span>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    className="flex size-6 items-center justify-center text-muted-foreground"
                                    aria-label={
                                      component.public
                                        ? "Shown on the public page"
                                        : "Hidden from the public page"
                                    }
                                    role="img"
                                  >
                                    {component.public ? (
                                      <EyeIcon
                                        aria-hidden="true"
                                        className="size-4"
                                      />
                                    ) : (
                                      <EyeOffIcon
                                        aria-hidden="true"
                                        className="size-4"
                                      />
                                    )}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  {component.public
                                    ? "Shown on the public page"
                                    : "Hidden from the public page"}
                                </TooltipContent>
                              </Tooltip>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section
              id="maintenance"
              title="Maintenance windows"
              description="Planned work shows as Under maintenance instead of an outage."
            >
              <div className="border-t border-border">
                {current.length === 0 && upcoming.length === 0 ? (
                  <div className="px-5 py-8 text-center md:px-6">
                    <p className="text-sm font-medium">Nothing scheduled</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Schedule maintenance before a wipe or host work so players
                      know what to expect.
                    </p>
                  </div>
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
                        onEdit={() => openSchedule(window)}
                        onComplete={() => setCompleting(window)}
                        onRemove={() => setRemoving(window)}
                      />
                    ))}
                  </ul>
                )}
                {past.length > 0 && (
                  <Collapsible>
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-10 w-full justify-start rounded-none border-t border-border px-5 text-muted-foreground md:px-6"
                      >
                        Past windows ({past.length})
                      </Button>
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
                            onRemove={() => setRemoving(window)}
                          />
                        ))}
                      </ul>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </div>
            </Section>
          </div>
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          <form onSubmit={save} className="space-y-6" noValidate>
            <fieldset disabled={!canManage} className="space-y-6">
              <Section
                id="page-setup"
                title="Page setup"
                description="What players see at the top of the page."
              >
                <div className="grid gap-4 border-t border-border px-5 py-5 md:grid-cols-2 md:px-6">
                  <div className="space-y-2">
                    <Label htmlFor="status-name">Page name</Label>
                    <Input
                      id="status-name"
                      ref={nameInput}
                      maxLength={80}
                      value={draft.name}
                      onChange={(e) => updateDraft({ name: e.target.value })}
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="status-slug">Public address</Label>
                    <div className="flex h-10 items-center rounded-lg border border-input bg-input-background focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
                      <span className="pl-3 font-mono text-xs text-muted-foreground">
                        /status/
                      </span>
                      <input
                        id="status-slug"
                        maxLength={40}
                        value={slug}
                        aria-invalid={!validSlug(slug)}
                        onChange={(e) =>
                          updateDraft({
                            slug: e.target.value
                              .toLowerCase()
                              .replace(/[^a-z0-9-]/g, "-"),
                            slugEdited: true,
                          })
                        }
                        className="h-full min-w-0 flex-1 bg-transparent px-1 font-mono text-sm outline-none"
                      />
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      Lower-case letters, digits, and hyphens. Changing it
                      breaks links you already shared.
                    </p>
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="status-announcement">Announcement</Label>
                    <Textarea
                      id="status-announcement"
                      maxLength={500}
                      rows={2}
                      value={draft.announcement}
                      onChange={(e) =>
                        updateDraft({ announcement: e.target.value })
                      }
                      placeholder="Optional notice shown above the components, such as a wipe date."
                    />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="status-support">Support link</Label>
                    <Input
                      id="status-support"
                      type="url"
                      maxLength={300}
                      value={draft.supportUrl}
                      onChange={(e) =>
                        updateDraft({ supportUrl: e.target.value })
                      }
                      placeholder="https://discord.gg/your-server"
                      className="h-10"
                    />
                    <p className="text-xs leading-5 text-muted-foreground">
                      Where players can reach you during an outage. HTTPS only.
                    </p>
                  </div>
                  <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-surface-elevated/40 px-4 py-3 md:col-span-2">
                    <div className="space-y-1">
                      <Label htmlFor="status-published">Publish page</Label>
                      <p className="text-xs leading-5 text-muted-foreground">
                        Anyone with the address can open the page. Hidden
                        components stay private either way.
                      </p>
                    </div>
                    <Switch
                      id="status-published"
                      checked={draft.published}
                      onCheckedChange={(published) =>
                        updateDraft({ published })
                      }
                    />
                  </div>
                </div>
              </Section>

              <Section
                id="component-setup"
                title="Components"
                description="Drag to order the page. Hide anything you want to watch privately."
                action={
                  canManage && (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 px-4 [@media(any-pointer:coarse)]:min-h-11"
                      disabled={available.length === 0}
                      onClick={() =>
                        setComponentForm({
                          index: null,
                          sourceLabel: null,
                          name: "",
                          groupName: "",
                          public: true,
                          error: "",
                        })
                      }
                    >
                      <PlusIcon aria-hidden="true" />
                      Add component
                    </Button>
                  )
                }
              >
                {draft.components.length === 0 ? (
                  <div className="border-t border-border px-5 py-8 text-center md:px-6">
                    <p className="text-sm font-medium">No components yet</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {state.sources.length === 0
                        ? "Add a game server or machine first, then show it here."
                        : "Each component mirrors one saved server or machine."}
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-border border-t border-border">
                    {draft.components.map((component, index) => (
                      <li
                        key={`${component.kind}:${component.sourceId}`}
                        data-component-target={index}
                        className={cn(
                          "flex items-center gap-2 px-3 py-2.5 md:px-4",
                          dropTarget === index &&
                            "bg-primary/10 outline-2 outline-primary -outline-offset-2",
                        )}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="size-11 touch-none cursor-grab active:cursor-grabbing md:size-8"
                          aria-label={`Reorder ${component.name}`}
                          title="Drag to reorder, or use Arrow Up and Arrow Down"
                          onPointerDown={(event) => {
                            if (event.button !== 0) return;
                            event.preventDefault();
                            event.currentTarget.focus();
                            event.currentTarget.setPointerCapture(
                              event.pointerId,
                            );
                            pointerDrag.current = {
                              index,
                              pointerId: event.pointerId,
                              x: event.clientX,
                              y: event.clientY,
                              moved: false,
                              target: null,
                            };
                          }}
                          onPointerMove={(event) => {
                            const drag = pointerDrag.current;
                            if (!drag || drag.pointerId !== event.pointerId)
                              return;
                            if (
                              !drag.moved &&
                              Math.hypot(
                                event.clientX - drag.x,
                                event.clientY - drag.y,
                              ) < 5
                            )
                              return;
                            drag.moved = true;
                            const value = document
                              .elementFromPoint(event.clientX, event.clientY)
                              ?.closest<HTMLElement>("[data-component-target]")
                              ?.dataset.componentTarget;
                            const target =
                              value === undefined ? null : Number(value);
                            drag.target =
                              target !== null && target !== drag.index
                                ? target
                                : null;
                            setDropTarget(drag.target);
                          }}
                          onPointerUp={(event) => {
                            const drag = pointerDrag.current;
                            if (!drag || drag.pointerId !== event.pointerId)
                              return;
                            pointerDrag.current = null;
                            setDropTarget(null);
                            if (
                              event.currentTarget.hasPointerCapture(
                                event.pointerId,
                              )
                            )
                              event.currentTarget.releasePointerCapture(
                                event.pointerId,
                              );
                            if (drag.moved && drag.target !== null)
                              move(drag.index, drag.target);
                          }}
                          onPointerCancel={() => {
                            pointerDrag.current = null;
                            setDropTarget(null);
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key === "ArrowUp" ||
                              event.key === "ArrowDown"
                            ) {
                              event.preventDefault();
                              move(
                                index,
                                index + (event.key === "ArrowUp" ? -1 : 1),
                              );
                            }
                          }}
                        >
                          <GripVerticalIcon aria-hidden="true" />
                        </Button>
                        <KindIcon kind={component.kind} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-medium">
                              {component.name}
                            </p>
                            {component.groupName && (
                              <Badge variant="outline">
                                {component.groupName}
                              </Badge>
                            )}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {sourceName(component) === null
                              ? `Removed ${component.kind}`
                              : sourceName(component) !== component.name
                                ? sourceName(component)
                                : component.kind === "server"
                                  ? "Game server"
                                  : "Machine"}
                          </p>
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="size-11 md:size-8"
                              aria-pressed={component.public}
                              aria-label={`${component.public ? "Hide" : "Show"} ${component.name} on the public page`}
                              onClick={() =>
                                updateComponents((list) =>
                                  list.map((c, i) =>
                                    i === index
                                      ? { ...c, public: !c.public }
                                      : c,
                                  ),
                                )
                              }
                            >
                              {component.public ? (
                                <EyeIcon aria-hidden="true" />
                              ) : (
                                <EyeOffIcon
                                  aria-hidden="true"
                                  className="text-muted-foreground"
                                />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {component.public
                              ? "Shown on the public page"
                              : "Hidden from the public page"}
                          </TooltipContent>
                        </Tooltip>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="size-11 md:size-8"
                              aria-label={`Actions for ${component.name}`}
                            >
                              <MoreHorizontalIcon aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onSelect={() =>
                                setComponentForm({
                                  index,
                                  sourceLabel: null,
                                  name: component.name,
                                  groupName: component.groupName,
                                  public: component.public,
                                  error: "",
                                })
                              }
                            >
                              <PencilIcon aria-hidden="true" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={index === 0}
                              onSelect={() => move(index, index - 1)}
                            >
                              <ArrowUpIcon aria-hidden="true" />
                              Move up
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={index === draft.components.length - 1}
                              onSelect={() => move(index, index + 1)}
                            >
                              <ArrowDownIcon aria-hidden="true" />
                              Move down
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() =>
                                updateComponents((list) =>
                                  list.filter((_, i) => i !== index),
                                )
                              }
                            >
                              <Trash2Icon aria-hidden="true" />
                              Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section
                id="preview"
                title="Public preview"
                description="How the page reads with your unsaved changes."
              >
                <div className="border-t border-border bg-background px-5 py-6 md:px-6">
                  <PublicPreview
                    name={draft.name.trim() || state.name}
                    announcement={draft.announcement.trim()}
                    supportUrl={draft.supportUrl.trim()}
                    components={draft.components
                      .filter((c) => c.public)
                      .map((c) => ({
                        id: c.id ?? `${c.kind}:${c.sourceId}`,
                        name: c.name,
                        groupName: c.groupName,
                        health:
                          components.find(
                            (s) =>
                              s.kind === c.kind && s.sourceId === c.sourceId,
                          )?.health ?? "unknown",
                      }))}
                    hidden={draft.components.filter((c) => !c.public).length}
                    maintenance={state.maintenance}
                    now={now}
                  />
                </div>
              </Section>
            </fieldset>

            {(dirty || saveError) && canManage && (
              <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border-strong bg-surface-elevated px-4 py-3 shadow-lg">
                <p
                  role={saveError ? "alert" : "status"}
                  className={cn(
                    "mr-auto text-sm",
                    saveError ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {saveError || "Unsaved changes"}
                </p>
                {saveError.includes("another session") && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 px-4"
                    onClick={reload}
                  >
                    Reload
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 px-4 [@media(any-pointer:coarse)]:min-h-11"
                  disabled={saving || !dirty}
                  onClick={() => {
                    setDraft(draftOf(state));
                    setSaveError("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="h-10 px-4 [@media(any-pointer:coarse)]:min-h-11"
                  disabled={saving || !dirty}
                >
                  {saving ? "Saving changes..." : "Save changes"}
                </Button>
              </div>
            )}
          </form>
        </TabsContent>
      </Tabs>

      <Dialog
        open={componentForm !== null}
        onOpenChange={(open) => {
          if (!open) setComponentForm(null);
        }}
      >
        <DialogContent>
          <form onSubmit={submitComponent} className="space-y-4" noValidate>
            <DialogHeader>
              <DialogTitle>
                {componentForm?.index === null
                  ? "Add component"
                  : "Edit component"}
              </DialogTitle>
              <DialogDescription>
                {componentForm?.index === null
                  ? "Pick a saved server or machine and choose how it appears."
                  : "Change how this component appears on the page."}
              </DialogDescription>
            </DialogHeader>
            {componentForm?.index === null && (
              <div className="space-y-2">
                <Label htmlFor="component-source">Server or machine</Label>
                <Popover open={sourceOpen} onOpenChange={setSourceOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      role="combobox"
                      id="component-source"
                      aria-expanded={sourceOpen}
                      className="h-10 w-full justify-between px-3 font-normal"
                    >
                      {componentForm.sourceLabel ?? (
                        <span className="text-muted-foreground">
                          Choose a server or machine
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
                    <Command>
                      <CommandInput placeholder="Search servers and machines" />
                      <CommandList>
                        <CommandEmpty>
                          No matching servers or machines.
                        </CommandEmpty>
                        {(["server", "machine"] as const).map((kind) => {
                          const options = available.filter(
                            (s) => s.kind === kind,
                          );
                          if (options.length === 0) return null;
                          return (
                            <CommandGroup
                              key={kind}
                              heading={
                                kind === "server" ? "Game servers" : "Machines"
                              }
                            >
                              {options.map((source) => (
                                <CommandItem
                                  key={`${source.kind}:${source.id}`}
                                  value={sourceLabel(source)}
                                  onSelect={() => {
                                    setComponentForm((current) =>
                                      current
                                        ? {
                                            ...current,
                                            sourceLabel: sourceLabel(source),
                                            name:
                                              current.name.trim() === "" ||
                                              available.some(
                                                (s) => s.name === current.name,
                                              )
                                                ? source.name
                                                : current.name,
                                            error: "",
                                          }
                                        : current,
                                    );
                                    setSourceOpen(false);
                                  }}
                                >
                                  {source.kind === "server" ? (
                                    <ServerIcon aria-hidden="true" />
                                  ) : (
                                    <HardDriveIcon aria-hidden="true" />
                                  )}
                                  {source.name}
                                  {componentForm.sourceLabel ===
                                    sourceLabel(source) && (
                                    <CheckIcon
                                      aria-hidden="true"
                                      className="ml-auto"
                                    />
                                  )}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          );
                        })}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="component-name">Display name</Label>
              <Input
                id="component-name"
                maxLength={80}
                value={componentForm?.name ?? ""}
                onChange={(e) =>
                  setComponentForm((current) =>
                    current
                      ? { ...current, name: e.target.value, error: "" }
                      : current,
                  )
                }
                className="h-10"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                Players see this name. It does not rename the server.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="component-group">Group</Label>
              <Input
                id="component-group"
                maxLength={80}
                value={componentForm?.groupName ?? ""}
                onChange={(e) =>
                  setComponentForm((current) =>
                    current
                      ? { ...current, groupName: e.target.value }
                      : current,
                  )
                }
                placeholder="Optional, such as EU servers"
                className="h-10"
              />
              {existingGroups.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {existingGroups.map((group) => (
                    <Button
                      key={group}
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() =>
                        setComponentForm((current) =>
                          current ? { ...current, groupName: group } : current,
                        )
                      }
                    >
                      {group}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <label className="flex items-center gap-3 text-sm">
              <Checkbox
                checked={componentForm?.public ?? true}
                onCheckedChange={(checked) =>
                  setComponentForm((current) =>
                    current
                      ? { ...current, public: checked === true }
                      : current,
                  )
                }
              />
              Show on the public page
            </label>
            {componentForm?.error && (
              <p role="alert" className="text-sm text-destructive">
                {componentForm.error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="h-10 px-4"
                onClick={() => setComponentForm(null)}
              >
                Cancel
              </Button>
              <Button type="submit" className="h-10 px-4">
                {componentForm?.index === null ? "Add component" : "Apply"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={maintenanceForm !== null}
        onOpenChange={(open) => {
          if (!open && !maintenanceBusy) setMaintenanceForm(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <form onSubmit={submitMaintenance} className="space-y-4" noValidate>
            <DialogHeader>
              <DialogTitle>
                {maintenanceForm?.window
                  ? "Edit maintenance window"
                  : "Schedule maintenance"}
              </DialogTitle>
              <DialogDescription>
                Affected components show Under maintenance while the window is
                open, and the page lists it ahead of time.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="maintenance-title">Title</Label>
              <Input
                id="maintenance-title"
                maxLength={120}
                value={maintenanceForm?.title ?? ""}
                onChange={(e) =>
                  setMaintenanceForm((current) =>
                    current
                      ? { ...current, title: e.target.value, error: "" }
                      : current,
                  )
                }
                placeholder="Monthly wipe"
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maintenance-message">Message</Label>
              <Textarea
                id="maintenance-message"
                maxLength={2000}
                rows={3}
                value={maintenanceForm?.message ?? ""}
                onChange={(e) =>
                  setMaintenanceForm((current) =>
                    current ? { ...current, message: e.target.value } : current,
                  )
                }
                placeholder="Optional details for players."
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="maintenance-start">Starts</Label>
                <Input
                  id="maintenance-start"
                  type="datetime-local"
                  value={maintenanceForm?.startsAt ?? ""}
                  onChange={(e) =>
                    setMaintenanceForm((current) =>
                      current
                        ? { ...current, startsAt: e.target.value, error: "" }
                        : current,
                    )
                  }
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maintenance-end">Ends</Label>
                <Input
                  id="maintenance-end"
                  type="datetime-local"
                  value={maintenanceForm?.endsAt ?? ""}
                  onChange={(e) =>
                    setMaintenanceForm((current) =>
                      current
                        ? { ...current, endsAt: e.target.value, error: "" }
                        : current,
                    )
                  }
                  className="h-10"
                />
              </div>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                Affected components
              </legend>
              <label className="flex items-center gap-3 text-sm">
                <Checkbox
                  checked={maintenanceForm?.all ?? true}
                  onCheckedChange={(checked) =>
                    setMaintenanceForm((current) =>
                      current
                        ? { ...current, all: checked === true, error: "" }
                        : current,
                    )
                  }
                />
                All components
              </label>
              {!maintenanceForm?.all && (
                <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border p-3">
                  {components.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Save components first to pick specific ones.
                    </p>
                  ) : (
                    components.map((component) => (
                      <label
                        key={component.id}
                        className="flex items-center gap-3 text-sm"
                      >
                        <Checkbox
                          checked={
                            maintenanceForm?.componentIds.includes(
                              component.id,
                            ) ?? false
                          }
                          onCheckedChange={(checked) =>
                            setMaintenanceForm((current) => {
                              if (!current) return current;
                              const ids = new Set(current.componentIds);
                              if (checked === true) ids.add(component.id);
                              else ids.delete(component.id);
                              return {
                                ...current,
                                componentIds: [...ids],
                                error: "",
                              };
                            })
                          }
                        />
                        {component.name}
                        {!component.public && (
                          <span className="text-xs text-muted-foreground">
                            Hidden
                          </span>
                        )}
                      </label>
                    ))
                  )}
                </div>
              )}
            </fieldset>
            {maintenanceForm?.error && (
              <p role="alert" className="text-sm text-destructive">
                {maintenanceForm.error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="h-10 px-4"
                disabled={maintenanceBusy}
                onClick={() => setMaintenanceForm(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="h-10 px-4"
                disabled={maintenanceBusy}
              >
                {maintenanceBusy
                  ? "Saving window..."
                  : maintenanceForm?.window
                    ? "Save window"
                    : "Schedule maintenance"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={completing !== null}
        onOpenChange={(open) => {
          if (!open && !actionBusy) setCompleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Mark {completing?.title} as complete?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The window closes now. Affected components return to their live
              status on the public page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={actionBusy}
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
          if (!open && !actionBusy) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing?.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              The window disappears from the status page and its history. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={actionBusy}
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
    </div>
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
  return (
    <li className="flex items-start gap-3 px-5 py-3 md:px-6">
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border",
          phase === "active"
            ? "border-warning/40 bg-warning/10 text-warning"
            : "border-border bg-surface-elevated text-muted-foreground",
        )}
      >
        {phase === "active" ? (
          <WrenchIcon aria-hidden="true" className="size-4" />
        ) : (
          <CalendarClockIcon aria-hidden="true" className="size-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{window.title}</p>
          <Badge
            variant="outline"
            className={cn(
              phase === "active" && "border-warning/40 text-warning",
              phase === "completed" && "text-muted-foreground",
            )}
          >
            {phase === "active"
              ? "Happening now"
              : phase === "scheduled"
                ? "Scheduled"
                : "Completed"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{range}</p>
        <p className="truncate text-xs text-muted-foreground">
          {affectedNames(window, components)}
        </p>
      </div>
      {canManage && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-11 md:size-8"
              aria-label={`Actions for ${window.title}`}
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onEdit && (
              <DropdownMenuItem onSelect={onEdit}>
                <PencilIcon aria-hidden="true" />
                Edit
              </DropdownMenuItem>
            )}
            {onComplete && phase === "active" && (
              <DropdownMenuItem onSelect={onComplete}>
                <CheckIcon aria-hidden="true" />
                Mark complete
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

/** A compact rendering of the public page for the settings tab. */
function PublicPreview({
  name,
  announcement,
  supportUrl,
  components,
  hidden,
  maintenance,
  now,
}: {
  name: string;
  announcement: string;
  supportUrl: string;
  components: {
    id: string;
    name: string;
    groupName: string;
    health: StatusComponent["health"];
  }[];
  hidden: number;
  maintenance: MaintenanceWindow[];
  now: number;
}) {
  const overall = overallStatus(
    components.map((c) => ({
      ...c,
      kind: "server" as const,
      sourceId: "",
      sourceName: null,
      public: true,
      observedAt: null,
    })),
    maintenance,
    now,
  );
  const active = activeMaintenance(maintenance, now);
  return (
    <div className="mx-auto max-w-xl space-y-4" aria-label="Public preview">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">{name}</p>
        {supportUrl && (
          <span className="text-xs text-muted-foreground">Contact support</span>
        )}
      </div>
      {announcement && (
        <p className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          {announcement}
        </p>
      )}
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <ToneIcon
          tone={overall.tone}
          className={cn("size-5", toneClass[overall.tone])}
        />
        <p className="text-sm font-medium">{overall.title}</p>
      </div>
      {active.map((window) => (
        <p
          key={window.id}
          className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs"
        >
          <span className="font-medium">{window.title}</span>
          {window.message && (
            <span className="text-muted-foreground"> · {window.message}</span>
          )}
        </p>
      ))}
      {components.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          Public components appear here.
        </p>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border bg-card">
          {groupComponents(components).map((group) => (
            <div key={group.name || "(ungrouped)"}>
              {group.name && (
                <p className="px-4 pt-3 text-xs font-medium text-muted-foreground">
                  {group.name}
                </p>
              )}
              {group.items.map((component) => {
                const status = componentStatus(component, maintenance, now);
                return (
                  <div
                    key={component.id}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <span className="flex items-center gap-2 text-sm">
                      <StatusDot status={status} />
                      {component.name}
                    </span>
                    <span className={cn("text-xs", toneClass[status])}>
                      {statusLabel[status]}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">
          {hidden} hidden {hidden === 1 ? "component is" : "components are"} not
          shown publicly.
        </p>
      )}
    </div>
  );
}
