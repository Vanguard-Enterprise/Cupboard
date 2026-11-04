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
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  GlobeIcon,
  GripVerticalIcon,
  HardDriveIcon,
  ImageIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { apiRequest, type Identity } from "@/lib/api-client";
import {
  accentPresets,
  affectedNames,
  componentStatus,
  draftOf,
  groupComponents,
  localDateTimeValue,
  maintenancePhase,
  maxComponents,
  maxLinks,
  moveComponent,
  overallStatus,
  parseLocalDateTime,
  publicPath,
  sameDraft,
  slugify,
  statusFonts,
  statusLabel,
  unusedSources,
  validColor,
  validSlug,
  validTargetUrl,
  windowLabel,
  type ComponentDraft,
  type ComponentKind,
  type MaintenanceWindow,
  type PageDraft,
  type PublicStatus,
  type StatusComponent,
  type StatusFont,
  type StatusPageState,
  type StatusSource,
} from "@/lib/status-page";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  StatusDot,
  ToneIcon,
  toneClass,
  toneTile,
} from "@/components/status-indicators";
import { PublicStatusView } from "@/components/public-status-page";
import { statusFontFamily } from "@/components/status-fonts";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The request could not be completed.";

function KindIcon({ kind }: { kind: ComponentKind }) {
  const Icon =
    kind === "server"
      ? ServerIcon
      : kind === "machine"
        ? HardDriveIcon
        : GlobeIcon;
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
  kind: ComponentKind;
  /** The chosen machine or game server when adding one. */
  sourceLabel: string | null;
  url: string;
  name: string;
  tagId: string;
  public: boolean;
  error: string;
};

const kindLabel: Record<ComponentKind, string> = {
  url: "Website",
  machine: "Machine",
  server: "Game server",
};

function sameUrl(a: string, b: string) {
  try {
    return new URL(a.trim()).href === new URL(b.trim()).href;
  } catch {
    return a.trim() === b.trim();
  }
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
  const logoInput = useRef<HTMLInputElement | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const logoUrl = useStatusLogo(organization.id, state?.logoVersion ?? null);

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
  const tagName = (id: string) =>
    state.tags.find((tag) => tag.id === id)?.name ?? "";
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

  async function save(event?: FormEvent) {
    event?.preventDefault();
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
    const accentColor = draft.accentColor.trim().toLowerCase();
    if (!validColor(accentColor)) {
      setSaveError(
        "Enter the accent color as a six-digit hex code, such as #7cb58d.",
      );
      return;
    }
    const links = draft.links.map((link) => ({
      label: link.label.trim(),
      url: link.url.trim(),
    }));
    if (links.some((link) => !link.label || !link.url)) {
      setSaveError("Give each header link a label and an HTTPS address.");
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
          theme: draft.theme,
          accentColor,
          font: draft.font,
          links,
          footerText: draft.footerText,
          poweredBy: draft.poweredBy,
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

  async function uploadLogo(file: File) {
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Choose an image no larger than 2 MiB.");
      return;
    }
    setLogoBusy(true);
    try {
      const response = await fetch("/app-api/status-page/logo", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Cupboard-Request": "1",
          "X-Cupboard-Organization": organization.id,
        },
        body: file,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          typeof result?.error === "string"
            ? result.error
            : "The logo could not be uploaded.",
        );
      adopt(result as StatusPageState);
      toast.success("Logo updated.");
    } catch (cause) {
      toast.error(message(cause));
    } finally {
      setLogoBusy(false);
      if (logoInput.current) logoInput.current.value = "";
    }
  }

  async function removeLogo() {
    setLogoBusy(true);
    try {
      adopt(
        await apiRequest<StatusPageState>(
          "status-page/logo/remove",
          {},
          organization.id,
        ),
      );
      toast.success("Logo removed.");
    } catch (cause) {
      toast.error(message(cause));
    } finally {
      setLogoBusy(false);
    }
  }

  async function copyUrl() {
    try {
      await copyText(publicUrl);
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
      return fail("Choose at least one affected target, or select all.");
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
    if (!componentForm || !draft) return;
    const form = componentForm;
    const name = form.name.trim();
    const fail = (error: string) =>
      setComponentForm((current) =>
        current ? { ...current, error } : current,
      );
    if (form.index === null && draft.components.length >= maxComponents)
      return fail(`A status page can list up to ${maxComponents} targets.`);
    let sourceId: string;
    if (form.kind === "url") {
      sourceId = form.url.trim();
      if (!validTargetUrl(sourceId))
        return fail("Enter a complete http or https address.");
      if (
        draft.components.some(
          (c, i) =>
            i !== form.index &&
            c.kind === "url" &&
            sameUrl(c.sourceId, sourceId),
        )
      )
        return fail("That address is already a target.");
    } else if (form.index === null) {
      const source = available.find(
        (s) => s.kind === form.kind && sourceLabel(s) === form.sourceLabel,
      );
      if (!source)
        return fail(
          form.kind === "machine"
            ? "Choose a machine to show."
            : "Choose a game server to show.",
        );
      sourceId = source.id;
    } else {
      sourceId = draft.components[form.index].sourceId;
    }
    if (!name) return fail("Enter a display name.");
    const values = { name, sourceId, tagId: form.tagId, public: form.public };
    if (form.index === null) {
      updateComponents((list) => [
        ...list,
        { id: null, kind: form.kind, ...values },
      ]);
    } else {
      updateComponents((list) =>
        list.map((c, i) => (i === form.index ? { ...c, ...values } : c)),
      );
    }
    setComponentForm(null);
  }

  function chooseSource(source: StatusSource) {
    setComponentForm((current) =>
      current
        ? {
            ...current,
            sourceLabel: sourceLabel(source),
            name:
              current.name.trim() === "" ||
              available.some((s) => s.name === current.name)
                ? source.name
                : current.name,
            // A machine's first tag is the natural group.
            tagId:
              current.tagId ||
              (source.tags.find((id) => state!.tags.some((t) => t.id === id)) ??
                ""),
            error: "",
          }
        : current,
    );
    setSourceOpen(false);
  }

  function move(from: number, to: number) {
    updateComponents((list) => moveComponent(list, from, to));
  }

  const sourceName = (component: ComponentDraft) =>
    component.kind === "url"
      ? component.sourceId
      : (state.sources.find(
          (s) => s.kind === component.kind && s.id === component.sourceId,
        )?.name ?? null);

  const hiddenCount = draft.components.filter((c) => !c.public).length;
  // The preview renders exactly what visitors would get after saving.
  const previewOf = (): PublicStatus => ({
    name: draft.name.trim() || state.name,
    announcement: draft.announcement.trim(),
    supportUrl: draft.supportUrl.trim(),
    theme: draft.theme,
    accentColor: draft.accentColor.trim().toLowerCase(),
    font: draft.font,
    links: draft.links
      .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
      .filter((link) => link.label && link.url),
    footerText: draft.footerText.trim(),
    poweredBy: draft.poweredBy,
    logoVersion: state.logoVersion,
    updatedAt: checkedAt ?? now,
    components: draft.components
      .filter((c) => c.public)
      .map((c) => {
        const live = components.find(
          (s) => s.kind === c.kind && s.sourceId === c.sourceId,
        );
        return {
          id: c.id ?? `${c.kind}:${c.sourceId}`,
          name: c.name,
          groupName: tagName(c.tagId),
          health: live?.health ?? "unknown",
          observedAt: live?.observedAt ?? null,
        };
      }),
    maintenance: state.maintenance,
  });

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
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-2xl font-semibold tracking-tight">Status</h1>
              <Badge variant="outline" className="gap-1">
                {state.published ? (
                  <GlobeIcon aria-hidden="true" />
                ) : (
                  <EyeOffIcon aria-hidden="true" />
                )}
                {state.published ? "Public" : "Not published"}
              </Badge>
            </div>
            <div className="mt-1 flex min-w-0 items-center text-sm text-muted-foreground">
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
          {(["overview", "targets", "settings"] as const).map((value) => (
            <TabsTrigger
              key={value}
              value={value}
              className="h-full flex-none rounded-none px-3 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:after:bottom-[-1px] data-[state=active]:after:bg-primary dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent dark:data-[state=active]:text-foreground"
            >
              {value === "overview"
                ? "Overview"
                : value === "targets"
                  ? "Targets"
                  : "Settings"}
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
            <Section id="targets" title="Targets">
              {components.length === 0 ? (
                <div className="border-t border-border px-5 py-8 text-center md:px-6">
                  <p className="text-sm font-medium">No targets yet</p>
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
                      Add targets
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
                                    ? `Removed ${kindLabel[component.kind].toLowerCase()}`
                                    : component.sourceName !== component.name
                                      ? component.sourceName
                                      : kindLabel[component.kind]}
                                  {component.detail
                                    ? ` · ${component.detail}`
                                    : ""}
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

            <Section id="maintenance" title="Maintenance windows">
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

        <TabsContent value="targets" className="mt-4">
          <fieldset disabled={!canManage} className="space-y-6">
            <Section
              id="component-setup"
              title="Targets"
              action={
                canManage && (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 px-4 [@media(any-pointer:coarse)]:min-h-11"
                    onClick={() =>
                      setComponentForm({
                        index: null,
                        kind: "url",
                        sourceLabel: null,
                        url: "",
                        name: "",
                        tagId: "",
                        public: true,
                        error: "",
                      })
                    }
                  >
                    <PlusIcon aria-hidden="true" />
                    Add target
                  </Button>
                )
              }
            >
              {draft.components.length === 0 ? (
                <div className="border-t border-border px-5 py-8 text-center md:px-6">
                  <p className="text-sm font-medium">No targets yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Add a website, machine, or game server to show it on the
                    page.
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
                          {tagName(component.tagId) && (
                            <Badge variant="outline">
                              {tagName(component.tagId)}
                            </Badge>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {sourceName(component) === null
                            ? `Removed ${kindLabel[component.kind].toLowerCase()}`
                            : sourceName(component) !== component.name
                              ? sourceName(component)
                              : kindLabel[component.kind]}
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
                                  i === index ? { ...c, public: !c.public } : c,
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
                                kind: component.kind,
                                sourceLabel: null,
                                url:
                                  component.kind === "url"
                                    ? component.sourceId
                                    : "",
                                name: component.name,
                                tagId: component.tagId,
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
          </fieldset>
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          <form onSubmit={save} className="space-y-6" noValidate>
            <fieldset disabled={!canManage} className="space-y-6">
              <Section id="page-setup" title="Page setup">
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
                      placeholder="Optional notice shown above the targets, such as a wipe date."
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
                  </div>
                  <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-surface-elevated/40 px-4 py-3 md:col-span-2">
                    <div className="space-y-1">
                      <Label htmlFor="status-published">Publish page</Label>
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

              <Section id="branding" title="Branding">
                <div className="grid gap-5 border-t border-border px-5 py-5 md:grid-cols-2 md:px-6">
                  <div className="space-y-2 md:col-span-2">
                    <p className="text-sm leading-none font-medium">Logo</p>
                    <div className="flex flex-wrap items-center gap-4">
                      <span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-elevated">
                        {logoUrl ? (
                          // A same-origin object URL for the re-encoded PNG.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={logoUrl}
                            alt="Current logo"
                            className="max-h-12 max-w-12 object-contain"
                          />
                        ) : (
                          <ImageIcon
                            aria-hidden="true"
                            className="size-5 text-muted-foreground"
                          />
                        )}
                      </span>
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            className="h-10 px-4 [@media(any-pointer:coarse)]:min-h-11"
                            disabled={logoBusy}
                            onClick={() => logoInput.current?.click()}
                          >
                            {logoBusy ? (
                              <Spinner aria-hidden="true" />
                            ) : (
                              <UploadIcon aria-hidden="true" />
                            )}
                            {state.logoVersion === null
                              ? "Upload logo"
                              : "Replace logo"}
                          </Button>
                          {state.logoVersion !== null && (
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-10 px-3 [@media(any-pointer:coarse)]:min-h-11"
                              disabled={logoBusy}
                              onClick={() => void removeLogo()}
                            >
                              Remove
                            </Button>
                          )}
                        </div>
                        <p className="text-xs leading-5 text-muted-foreground">
                          PNG, JPEG, WebP, GIF, or SVG up to 2 MiB. Saves right
                          away.
                        </p>
                      </div>
                      <input
                        ref={logoInput}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                        className="sr-only"
                        tabIndex={-1}
                        aria-label="Logo file"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadLogo(file);
                        }}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label id="status-theme-label">Theme</Label>
                    <ToggleGroup
                      type="single"
                      value={draft.theme}
                      onValueChange={(value) => {
                        if (value === "dark" || value === "light")
                          updateDraft({ theme: value });
                      }}
                      aria-labelledby="status-theme-label"
                      spacing={0}
                      className="w-full rounded-lg bg-surface-elevated p-1"
                    >
                      {(["dark", "light"] as const).map((theme) => (
                        <ToggleGroupItem
                          key={theme}
                          value={theme}
                          className="h-8 flex-1 gap-1.5 rounded-md px-3 text-xs text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground [@media(any-pointer:coarse)]:min-h-11"
                        >
                          {theme === "dark" ? (
                            <MoonIcon aria-hidden="true" />
                          ) : (
                            <SunIcon aria-hidden="true" />
                          )}
                          {theme === "dark" ? "Dark" : "Light"}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
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
                        className="w-full border-border bg-input-background data-[size=default]:h-11 sm:data-[size=default]:h-10 dark:bg-input-background"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper">
                        {statusFonts.map((font) => (
                          <SelectItem
                            key={font.id}
                            value={font.id}
                            className="min-h-11 sm:min-h-8"
                          >
                            <span
                              style={{ fontFamily: statusFontFamily[font.id] }}
                            >
                              {font.label}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="status-accent">Accent color</Label>
                    <div className="flex flex-wrap items-center gap-3">
                      <div
                        role="radiogroup"
                        aria-label="Accent presets"
                        className="flex flex-wrap gap-2"
                      >
                        {accentPresets.map((color) => {
                          const selected =
                            draft.accentColor.trim().toLowerCase() === color;
                          return (
                            <button
                              key={color}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              aria-label={color}
                              onClick={() =>
                                updateDraft({ accentColor: color })
                              }
                              className={cn(
                                "size-8 rounded-full border border-border-strong transition-shadow focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [@media(any-pointer:coarse)]:size-11",
                                selected &&
                                  "ring-2 ring-foreground ring-offset-2 ring-offset-card",
                              )}
                              style={{ background: color }}
                            />
                          );
                        })}
                      </div>
                      <div className="flex h-10 w-36 items-center gap-2 rounded-lg border border-input bg-input-background px-3 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
                        <span
                          aria-hidden="true"
                          className="size-4 shrink-0 rounded-sm border border-border-strong"
                          style={{
                            background: validColor(
                              draft.accentColor.trim().toLowerCase(),
                            )
                              ? draft.accentColor.trim().toLowerCase()
                              : "transparent",
                          }}
                        />
                        <input
                          id="status-accent"
                          maxLength={7}
                          spellCheck={false}
                          autoComplete="off"
                          value={draft.accentColor}
                          aria-invalid={
                            !validColor(draft.accentColor.trim().toLowerCase())
                          }
                          onChange={(e) =>
                            updateDraft({ accentColor: e.target.value })
                          }
                          className="h-full min-w-0 flex-1 bg-transparent font-mono text-sm outline-none"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="space-y-3 md:col-span-2">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm leading-none font-medium">
                        Header links
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 px-3 [@media(any-pointer:coarse)]:min-h-11"
                        disabled={draft.links.length >= maxLinks}
                        onClick={() =>
                          updateDraft({
                            links: [...draft.links, { label: "", url: "" }],
                          })
                        }
                      >
                        <PlusIcon aria-hidden="true" />
                        Add link
                      </Button>
                    </div>
                    {draft.links.map((link, index) => (
                      <div
                        key={index}
                        className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto]"
                      >
                        <Input
                          aria-label={`Link ${index + 1} label`}
                          maxLength={40}
                          placeholder="Website"
                          value={link.label}
                          onChange={(e) =>
                            updateDraft({
                              links: draft.links.map((l, i) =>
                                i === index
                                  ? { ...l, label: e.target.value }
                                  : l,
                              ),
                            })
                          }
                          className="col-start-1 row-start-1 h-10 sm:col-start-auto sm:row-start-auto"
                        />
                        <Input
                          aria-label={`Link ${index + 1} address`}
                          type="url"
                          maxLength={300}
                          placeholder="https://"
                          value={link.url}
                          onChange={(e) =>
                            updateDraft({
                              links: draft.links.map((l, i) =>
                                i === index ? { ...l, url: e.target.value } : l,
                              ),
                            })
                          }
                          className="col-span-2 row-start-2 h-10 sm:col-span-1 sm:row-start-auto"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="col-start-2 row-start-1 size-10 sm:col-start-auto sm:row-start-auto [@media(any-pointer:coarse)]:size-11"
                          aria-label={`Remove link ${index + 1}`}
                          onClick={() =>
                            updateDraft({
                              links: draft.links.filter((_, i) => i !== index),
                            })
                          }
                        >
                          <XIcon aria-hidden="true" />
                        </Button>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-2 md:col-span-2">
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
                  <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-surface-elevated/40 px-4 py-3 md:col-span-2">
                    <div className="space-y-1">
                      <Label htmlFor="status-powered-by">
                        Show Powered by Cupboard
                      </Label>
                    </div>
                    <Switch
                      id="status-powered-by"
                      checked={draft.poweredBy}
                      onCheckedChange={(poweredBy) =>
                        updateDraft({ poweredBy })
                      }
                    />
                  </div>
                </div>
              </Section>

              <Section id="preview" title="Public preview">
                <div className="border-t border-border">
                  <div className="max-h-[42rem] overflow-y-auto">
                    <PublicStatusView
                      embedded
                      data={previewOf()}
                      logoUrl={logoUrl}
                      now={now}
                    />
                  </div>
                  {hiddenCount > 0 && (
                    <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground md:px-6">
                      {hiddenCount} hidden{" "}
                      {hiddenCount === 1 ? "target is" : "targets are"} not
                      shown publicly.
                    </p>
                  )}
                </div>
              </Section>
            </fieldset>
          </form>
        </TabsContent>
      </Tabs>

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
            type="button"
            className="h-10 px-4 [@media(any-pointer:coarse)]:min-h-11"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? "Saving changes..." : "Save changes"}
          </Button>
        </div>
      )}

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
                {componentForm?.index === null ? "Add target" : "Edit target"}
              </DialogTitle>
              <DialogDescription>
                {componentForm?.index === null
                  ? "Watch a website, machine, or game server, grouped by your machine tags."
                  : "Change how this target appears on the page."}
              </DialogDescription>
            </DialogHeader>
            {componentForm?.index === null && (
              <div className="space-y-2">
                <Label id="component-kind-label">Type</Label>
                <ToggleGroup
                  type="single"
                  value={componentForm.kind}
                  onValueChange={(kind) => {
                    if (
                      kind === "url" ||
                      kind === "machine" ||
                      kind === "server"
                    )
                      setComponentForm((current) =>
                        current
                          ? { ...current, kind, sourceLabel: null, error: "" }
                          : current,
                      );
                  }}
                  aria-labelledby="component-kind-label"
                  spacing={0}
                  className="w-full rounded-lg bg-surface-elevated p-1"
                >
                  {(["url", "machine", "server"] as const).map((kind) => (
                    <ToggleGroupItem
                      key={kind}
                      value={kind}
                      className="h-8 flex-1 gap-1.5 rounded-md px-3 text-xs text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground [@media(any-pointer:coarse)]:min-h-11"
                    >
                      {kind === "url" ? (
                        <GlobeIcon aria-hidden="true" />
                      ) : kind === "machine" ? (
                        <HardDriveIcon aria-hidden="true" />
                      ) : (
                        <ServerIcon aria-hidden="true" />
                      )}
                      {kindLabel[kind]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            )}
            {componentForm?.kind === "url" && (
              <div className="space-y-2">
                <Label htmlFor="component-url">Address</Label>
                <Input
                  id="component-url"
                  type="url"
                  maxLength={300}
                  placeholder="https://play.example.com"
                  value={componentForm.url}
                  onChange={(e) =>
                    setComponentForm((current) =>
                      current
                        ? { ...current, url: e.target.value, error: "" }
                        : current,
                    )
                  }
                  className="h-10"
                />
              </div>
            )}
            {componentForm?.index === null && componentForm.kind !== "url" && (
              <div className="space-y-2">
                <Label htmlFor="component-source">
                  {kindLabel[componentForm.kind]}
                </Label>
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
                    <Command>
                      <CommandInput
                        placeholder={
                          componentForm.kind === "machine"
                            ? "Search machines"
                            : "Search game servers"
                        }
                      />
                      <CommandList>
                        <CommandEmpty>
                          {componentForm.kind === "machine"
                            ? "No machines left to add."
                            : "No game servers left to add."}
                        </CommandEmpty>
                        {available
                          .filter((s) => s.kind === componentForm.kind)
                          .map((source) => (
                            <CommandItem
                              key={`${source.kind}:${source.id}`}
                              value={sourceLabel(source)}
                              onSelect={() => chooseSource(source)}
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
            </div>
            <div className="space-y-2">
              <Label htmlFor="component-group">Group</Label>
              <Select
                value={componentForm?.tagId || "none"}
                onValueChange={(value) =>
                  setComponentForm((current) =>
                    current
                      ? { ...current, tagId: value === "none" ? "" : value }
                      : current,
                  )
                }
              >
                <SelectTrigger
                  id="component-group"
                  className="w-full border-border bg-input-background data-[size=default]:h-11 sm:data-[size=default]:h-10 dark:bg-input-background"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value="none" className="min-h-11 sm:min-h-8">
                    No group
                  </SelectItem>
                  {state.tags.map((tag) => (
                    <SelectItem
                      key={tag.id}
                      value={tag.id}
                      className="min-h-11 sm:min-h-8"
                    >
                      {tag.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                {componentForm?.index === null ? "Add target" : "Apply"}
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
                Affected targets show Under maintenance while the window is
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
              <legend className="text-sm font-medium">Affected targets</legend>
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
                All targets
              </label>
              {!maintenanceForm?.all && (
                <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border p-3">
                  {components.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Save targets first to pick specific ones.
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
              The window closes now. Affected targets return to their live
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
