"use client";

import { usePreviewStorage } from "./preview-storage";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  ArrowLeftIcon,
  Clock3Icon,
  SearchIcon,
  ServerIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  initiallyAcknowledgedAlertIds,
  securityAlerts,
  securityAlertStorageKey,
  type AlertSeverity,
  type SecurityAlert,
} from "@/lib/security-alerts";

type StatusFilter = "all" | "open" | "acknowledged";
type SeverityFilter = "all" | AlertSeverity;
type PendingFocusTarget = {
  id: string;
  previousIndex?: number;
};

const severityStyles: Record<AlertSeverity, string> = {
  critical: "border-destructive/25 bg-destructive/[0.07] text-destructive",
  high: "border-warning/25 bg-warning/[0.07] text-warning",
  medium: "border-border-strong bg-surface-elevated text-foreground",
  low: "border-border bg-transparent text-muted-foreground",
};

const severityOrder: Record<AlertSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const knownAlertIds = new Set(securityAlerts.map((alert) => alert.id));

const storageUnavailable = "storage-unavailable";

const serverAcknowledgementSnapshot = () => null;

function parseAcknowledgementSnapshot(snapshot: string | null) {
  const fallback = new Set<string>(initiallyAcknowledgedAlertIds);
  if (snapshot === null || snapshot === "") {
    return { ids: fallback, error: "" };
  }
  if (snapshot === storageUnavailable) {
    return {
      ids: fallback,
      error: "Saved acknowledgement state could not be loaded in this browser.",
    };
  }
  try {
    const parsed = JSON.parse(snapshot) as unknown;
    if (!Array.isArray(parsed)) throw new Error("Invalid stored state");
    return {
      ids: new Set(
        parsed.filter(
          (id): id is string => typeof id === "string" && knownAlertIds.has(id),
        ),
      ),
      error: "",
    };
  } catch {
    return {
      ids: fallback,
      error: "Saved acknowledgement state could not be loaded in this browser.",
    };
  }
}

function severityLabel(severity: AlertSeverity) {
  return `${severity.slice(0, 1).toUpperCase()}${severity.slice(1)}`;
}

function AlertSeverityBadge({ severity }: { severity: AlertSeverity }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-6 rounded-md px-2 py-0 text-xs font-medium",
        severityStyles[severity],
      )}
    >
      {severityLabel(severity)}
    </Badge>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 border-b border-border/35 py-2 last:border-0 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-sm text-foreground/90",
          mono && "break-all font-mono text-xs",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function AlertDetail({
  alert,
  acknowledged,
  onToggleAcknowledged,
  detailRef,
  onDetailFocus,
  onBack,
}: {
  alert: SecurityAlert;
  acknowledged: boolean;
  onToggleAcknowledged: () => void;
  detailRef: RefObject<HTMLElement | null>;
  onDetailFocus: () => void;
  onBack: () => void;
}) {
  return (
    <article
      ref={detailRef}
      data-alert-id={alert.id}
      tabIndex={-1}
      aria-labelledby="selected-alert-title"
      onFocusCapture={onDetailFocus}
      className="flex h-full min-w-0 flex-col outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div className="border-b border-border px-4 py-2 xl:hidden">
        <Button variant="ghost" onClick={onBack} className="min-h-11">
          <ArrowLeftIcon aria-hidden="true" /> Back to alerts
        </Button>
      </div>
      <div className="shrink-0 border-b border-border px-5 py-5 sm:px-6">
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <AlertSeverityBadge severity={alert.severity} />
          <Badge
            variant="outline"
            className={cn(
              "h-6 rounded-md px-2 py-0 text-xs font-medium",
              acknowledged
                ? "border-border text-muted-foreground"
                : "border-border-strong text-muted-foreground",
            )}
          >
            {acknowledged ? "Acknowledged" : "Needs review"}
          </Badge>
          <span className="ml-auto font-mono text-xs text-text-muted">
            {alert.id}
          </span>
        </div>
        <h2
          id="selected-alert-title"
          className="max-w-2xl text-xl font-semibold tracking-tight"
        >
          {alert.title}
        </h2>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <ServerIcon className="size-3.5" aria-hidden="true" />
            {alert.server}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Clock3Icon className="size-3.5" aria-hidden="true" />
            Last seen {alert.lastSeen}
          </span>
        </div>
      </div>

      <div className="flex-1 space-y-6 px-5 py-6 sm:px-6">
        <section aria-labelledby="evidence-heading">
          <h3 id="evidence-heading" className="mb-2 text-sm font-semibold">
            Evidence
          </h3>
          <p className="text-sm leading-6 text-muted-foreground">
            {alert.evidence}
          </p>
        </section>
        <section aria-labelledby="impact-heading">
          <h3 id="impact-heading" className="mb-2 text-sm font-semibold">
            Why it matters
          </h3>
          <p className="text-sm leading-6 text-muted-foreground">
            {alert.impact}
          </p>
        </section>
        <section
          aria-labelledby="next-step-heading"
          className="rounded-lg border border-border bg-surface-elevated/50 p-4"
        >
          <div className="flex gap-2">
            <ShieldCheckIcon
              className="mt-0.5 size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <div>
              <h3 id="next-step-heading" className="text-sm font-semibold">
                Recommended next step
              </h3>
              <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                {alert.recommendation}
              </p>
            </div>
          </div>
        </section>

        <dl className="border-y border-border/35">
          <DetailRow label="Affected server" value={alert.server} />
          <DetailRow label="Address" value={alert.address} mono />
          <DetailRow label="Detection source" value={alert.source} />
          <DetailRow label="First detected" value={alert.detectedAt} />
        </dl>
      </div>

      <footer
        aria-live="polite"
        className="sticky bottom-0 mt-auto shrink-0 border-t border-border bg-card px-5 py-4 sm:px-6"
      >
        <div className="flex min-h-10 flex-wrap items-center gap-3">
          <Button
            type="button"
            variant={acknowledged ? "outline" : "default"}
            onClick={onToggleAcknowledged}
            className="min-h-11 xl:min-h-10"
          >
            {acknowledged ? "Mark as needs review" : "Acknowledge alert"}
          </Button>
        </div>
      </footer>
    </article>
  );
}

export function SecurityAlerts() {
  const storage = usePreviewStorage(
    securityAlertStorageKey,
    "cupboard-security-alerts-saved",
  );
  const {
    subscribe: subscribeToAcknowledgements,
    snapshot: acknowledgementSnapshot,
  } = storage;
  const [status, setStatus] = useState<StatusFilter>("open");
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [query, setQuery] = useState("");
  const [server, setServer] = useState("all");
  const [mobileDetailId, setMobileDetailId] = useState<string | null>(null);
  const mobileDetail = mobileDetailId !== null;
  const [selectedId, setSelectedId] = useState(securityAlerts[0].id);
  const pendingFocusTarget = useRef<PendingFocusTarget | null>(null);
  const focusedAlert = useRef<PendingFocusTarget | null>(null);
  const alertRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const statusFilterRef = useRef<HTMLButtonElement>(null);
  const detailPanelRef = useRef<HTMLElement>(null);
  const [sessionAcknowledgementOverrides, setSessionAcknowledgementOverrides] =
    useState<Map<string, boolean>>(() => new Map());
  const storedAcknowledgements = useSyncExternalStore(
    subscribeToAcknowledgements,
    acknowledgementSnapshot,
    serverAcknowledgementSnapshot,
  );
  const [saveError, setSaveError] = useState("");
  const persistedState = useMemo(
    () => parseAcknowledgementSnapshot(storedAcknowledgements),
    [storedAcknowledgements],
  );
  const effectiveSessionOverrides = useMemo(
    () =>
      new Map(
        [...sessionAcknowledgementOverrides].filter(
          ([id, acknowledged]) => persistedState.ids.has(id) !== acknowledged,
        ),
      ),
    [persistedState.ids, sessionAcknowledgementOverrides],
  );
  const acknowledgedIds = useMemo(() => {
    const ids = new Set(persistedState.ids);
    for (const [id, acknowledged] of effectiveSessionOverrides) {
      if (acknowledged) ids.add(id);
      else ids.delete(id);
    }
    return ids;
  }, [effectiveSessionOverrides, persistedState.ids]);
  const storageError =
    (effectiveSessionOverrides.size ? saveError : "") || persistedState.error;

  useEffect(
    () =>
      subscribeToAcknowledgements(() => {
        const latestPersistedState = parseAcknowledgementSnapshot(
          acknowledgementSnapshot(),
        );
        if (latestPersistedState.error) return;
        setSessionAcknowledgementOverrides((currentOverrides) => {
          const remainingOverrides = new Map(
            [...currentOverrides].filter(
              ([id, acknowledged]) =>
                latestPersistedState.ids.has(id) !== acknowledged,
            ),
          );
          return remainingOverrides.size === currentOverrides.size
            ? currentOverrides
            : remainingOverrides;
        });
      }),
    [acknowledgementSnapshot, subscribeToAcknowledgements],
  );

  const visibleAlerts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return securityAlerts
      .filter((alert) => {
        const acknowledged = acknowledgedIds.has(alert.id);
        const matchesStatus =
          status === "all" ||
          (status === "acknowledged" ? acknowledged : !acknowledged);
        const matchesSeverity =
          severity === "all" || alert.severity === severity;
        const matchesQuery =
          !normalizedQuery ||
          [alert.title, alert.id, alert.server, alert.source].some((value) =>
            value.toLowerCase().includes(normalizedQuery),
          );
        return (
          matchesStatus &&
          matchesSeverity &&
          matchesQuery &&
          (server === "all" || alert.server === server)
        );
      })
      .sort(
        (left, right) =>
          severityOrder[left.severity] - severityOrder[right.severity],
      );
  }, [acknowledgedIds, query, severity, status, server]);

  // Reveal the queue before restoring focus when an acknowledgement removes the detail.
  if (
    mobileDetailId &&
    !visibleAlerts.some((alert) => alert.id === mobileDetailId)
  ) {
    setMobileDetailId(null);
  }

  const selectedAlert =
    visibleAlerts.find((alert) => alert.id === selectedId) ?? visibleAlerts[0];
  const selectedAlertIndex = selectedAlert
    ? visibleAlerts.findIndex((alert) => alert.id === selectedAlert.id)
    : -1;
  const openAlerts = securityAlerts.filter(
    (alert) => !acknowledgedIds.has(alert.id),
  );
  const affectedServers = new Set(securityAlerts.map((alert) => alert.server))
    .size;

  useEffect(() => {
    const clearFocusedAlert = (event: FocusEvent | PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest("[data-alert-id]")) {
        focusedAlert.current = null;
      }
    };
    document.addEventListener("focusin", clearFocusedAlert);
    document.addEventListener("pointerdown", clearFocusedAlert);
    return () => {
      document.removeEventListener("focusin", clearFocusedAlert);
      document.removeEventListener("pointerdown", clearFocusedAlert);
    };
  }, []);

  useLayoutEffect(() => {
    const pendingTarget = pendingFocusTarget.current;
    if (pendingTarget) {
      if (pendingTarget.id === "detail") {
        pendingFocusTarget.current = null;
        detailPanelRef.current?.focus({ preventScroll: true });
        detailPanelRef.current?.scrollIntoView({ block: "start" });
        return;
      }
      let target =
        pendingTarget.id === "status-filter"
          ? statusFilterRef.current
          : alertRowRefs.current.get(pendingTarget.id);

      if (!target && pendingTarget.previousIndex !== undefined) {
        const replacement =
          visibleAlerts[pendingTarget.previousIndex] ??
          visibleAlerts[pendingTarget.previousIndex - 1];
        if (replacement) {
          setSelectedId(replacement.id);
          target = alertRowRefs.current.get(replacement.id);
        } else {
          target = statusFilterRef.current;
        }
      }

      pendingFocusTarget.current = null;
      target?.focus();
      return;
    }

    const previousFocus = focusedAlert.current;
    if (
      previousFocus?.previousIndex !== undefined &&
      !visibleAlerts.some((alert) => alert.id === previousFocus.id)
    ) {
      const replacement =
        visibleAlerts[previousFocus.previousIndex] ??
        visibleAlerts[previousFocus.previousIndex - 1];
      focusedAlert.current = null;
      if (replacement) {
        setSelectedId(replacement.id);
        alertRowRefs.current.get(replacement.id)?.focus();
      } else {
        statusFilterRef.current?.focus();
      }
    }
  }, [visibleAlerts, mobileDetail, selectedId]);

  function toggleAcknowledged(alert: SecurityAlert) {
    const next = new Set(acknowledgedIds);
    const wasAcknowledged = next.has(alert.id);
    const willBeAcknowledged = !wasAcknowledged;
    const leavesCurrentFilter =
      (!wasAcknowledged && status === "open") ||
      (wasAcknowledged && status === "acknowledged");
    if (leavesCurrentFilter) {
      const currentIndex = visibleAlerts.findIndex(
        (visibleAlert) => visibleAlert.id === alert.id,
      );
      const remainingAlerts = visibleAlerts.filter(
        (visibleAlert) => visibleAlert.id !== alert.id,
      );
      const nextAlert =
        remainingAlerts[currentIndex] ?? remainingAlerts[currentIndex - 1];
      if (nextAlert) setSelectedId(nextAlert.id);
      pendingFocusTarget.current = {
        id: nextAlert?.id ?? "status-filter",
      };
    }
    if (wasAcknowledged) next.delete(alert.id);
    else next.add(alert.id);

    setSaveError("");
    try {
      storage.set(JSON.stringify([...next]));
      setSessionAcknowledgementOverrides(new Map());
      toast.success(
        willBeAcknowledged
          ? "Alert acknowledged."
          : "Alert marked as needs review.",
      );
    } catch {
      const nextOverrides = new Map(effectiveSessionOverrides);
      if (persistedState.ids.has(alert.id) === willBeAcknowledged) {
        nextOverrides.delete(alert.id);
      } else {
        nextOverrides.set(alert.id, willBeAcknowledged);
      }
      setSessionAcknowledgementOverrides(nextOverrides);
      if (nextOverrides.size) {
        setSaveError(
          "The acknowledgement changed for this session but could not be saved in this browser.",
        );
      }
    }
  }

  function selectAlert(alertId: string) {
    setSelectedId(alertId);
    if (!window.matchMedia?.("(max-width: 1279px)").matches) return;
    pendingFocusTarget.current = { id: "detail" };
    setMobileDetailId(alertId);
  }

  function backToAlerts() {
    pendingFocusTarget.current = { id: selectedAlert?.id ?? "status-filter" };
    setMobileDetailId(null);
  }

  const hasFilters = Boolean(
    query.trim() || severity !== "all" || server !== "all",
  );
  function clearFilters() {
    setQuery("");
    setSeverity("all");
    setServer("all");
    statusFilterRef.current?.focus();
  }

  const statusTabs = [
    { value: "open", label: "Needs review", count: openAlerts.length },
    {
      value: "acknowledged",
      label: "Acknowledged",
      count: acknowledgedIds.size,
    },
    { value: "all", label: "All", count: securityAlerts.length },
  ] as const;

  return (
    <div className="space-y-4">
      <dl
        aria-label="Security alert summary"
        className={cn(
          "flex flex-wrap gap-x-6 gap-y-2 text-sm",
          mobileDetail && "hidden xl:flex",
        )}
      >
        <div className="flex items-baseline gap-2">
          <dt className="text-muted-foreground">Needs review</dt>
          <dd className="font-semibold tabular-nums">{openAlerts.length}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-muted-foreground">Critical findings</dt>
          <dd className="font-semibold tabular-nums text-destructive">
            {
              securityAlerts.filter((alert) => alert.severity === "critical")
                .length
            }
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-muted-foreground">Affected servers</dt>
          <dd className="font-semibold tabular-nums">{affectedServers}</dd>
        </div>
      </dl>

      <Tabs
        value={status}
        onValueChange={(value) => setStatus(value as StatusFilter)}
        className="gap-0"
      >
        <section
          aria-label="Security alert review"
          className="overflow-clip rounded-xl border border-border bg-card"
        >
          <div
            className={cn(
              "border-b border-border px-4 pt-3 sm:px-5",
              mobileDetail && "hidden xl:block",
            )}
          >
            <TabsList
              aria-label="Alert status"
              variant="line"
              className="h-auto min-h-11 w-full justify-start gap-0 p-0 sm:w-auto sm:gap-2"
            >
              {statusTabs.map((tab) => (
                <TabsTrigger
                  key={tab.value}
                  value={tab.value}
                  ref={status === tab.value ? statusFilterRef : undefined}
                  className="min-h-11 gap-1 px-1 text-xs sm:gap-1.5 sm:px-3 sm:text-sm data-[state=active]:text-foreground dark:data-[state=active]:text-foreground after:bg-primary motion-reduce:transition-none"
                >
                  {tab.label}{" "}
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {tab.count}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="grid gap-3 py-4 lg:grid-cols-[minmax(12rem,1fr)_auto_auto]">
              <label className="min-w-0 self-end">
                <span className="sr-only">Search alerts</span>
                <span className="relative block">
                  <SearchIcon
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
                    aria-hidden="true"
                  />
                  <Input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search by title, server, source or ID"
                    className="h-11 pl-9 xl:h-10"
                  />
                </span>
              </label>
              <div>
                <span
                  id="severity-label"
                  className="mb-1.5 block text-xs text-muted-foreground"
                >
                  Severity
                </span>
                <Select
                  value={severity}
                  onValueChange={(value) =>
                    setSeverity(value as SeverityFilter)
                  }
                >
                  <SelectTrigger
                    className="w-full data-[size=default]:h-11 lg:w-40 xl:data-[size=default]:h-10"
                    aria-label="Filter by severity"
                    aria-describedby="severity-label"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectItem value="all" className="min-h-11 xl:min-h-8">
                      All severities
                    </SelectItem>
                    <SelectItem
                      value="critical"
                      className="min-h-11 xl:min-h-8"
                    >
                      Critical
                    </SelectItem>
                    <SelectItem value="high" className="min-h-11 xl:min-h-8">
                      High
                    </SelectItem>
                    <SelectItem value="medium" className="min-h-11 xl:min-h-8">
                      Medium
                    </SelectItem>
                    <SelectItem value="low" className="min-h-11 xl:min-h-8">
                      Low
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <span
                  id="server-label"
                  className="mb-1.5 block text-xs text-muted-foreground"
                >
                  Server
                </span>
                <Select value={server} onValueChange={setServer}>
                  <SelectTrigger
                    aria-label="Filter by server"
                    aria-describedby="server-label"
                    className="w-full data-[size=default]:h-11 lg:w-44 xl:data-[size=default]:h-10"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectItem value="all" className="min-h-11 xl:min-h-8">
                      All servers
                    </SelectItem>
                    {[...new Set(securityAlerts.map((alert) => alert.server))]
                      .sort()
                      .map((name) => (
                        <SelectItem
                          key={name}
                          value={name}
                          className="min-h-11 xl:min-h-8"
                        >
                          {name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex min-h-11 items-center justify-between gap-3 pb-3">
              <p className="text-xs text-muted-foreground">
                {visibleAlerts.length}{" "}
                {visibleAlerts.length === 1 ? "alert" : "alerts"}
                <span className="mx-2" aria-hidden="true">
                  ·
                </span>
                Highest severity first
              </p>
              {hasFilters && (
                <Button
                  variant="ghost"
                  onClick={clearFilters}
                  className="min-h-11 xl:min-h-9"
                >
                  Clear filters
                </Button>
              )}
            </div>
          </div>

          <TabsContent value={status} className="m-0">
            <div
              className={cn(
                "grid xl:min-h-[580px]",
                selectedAlert &&
                  "xl:grid-cols-[minmax(20rem,0.85fr)_minmax(0,1.15fr)]",
              )}
            >
              <div
                className={cn(
                  "min-w-0",
                  selectedAlert && "xl:border-r xl:border-border",
                  mobileDetail && "hidden xl:block",
                )}
              >
                {visibleAlerts.length ? (
                  <div role="list" aria-label="Security alerts">
                    {visibleAlerts.map((alert, alertIndex) => {
                      const isSelected = alert.id === selectedAlert?.id;
                      const acknowledged = acknowledgedIds.has(alert.id);
                      return (
                        <div
                          role="listitem"
                          key={alert.id}
                          className="border-b border-border last:border-b-0"
                        >
                          <button
                            type="button"
                            ref={(node) => {
                              if (node)
                                alertRowRefs.current.set(alert.id, node);
                              else alertRowRefs.current.delete(alert.id);
                            }}
                            data-alert-id={alert.id}
                            aria-pressed={isSelected}
                            onFocus={() => {
                              focusedAlert.current = {
                                id: alert.id,
                                previousIndex: alertIndex,
                              };
                            }}
                            onClick={() => selectAlert(alert.id)}
                            className={cn(
                              "block min-h-[100px] w-full border-l-2 border-l-transparent px-4 py-4 text-left outline-none transition-colors motion-reduce:transition-none hover:bg-surface-elevated/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              isSelected &&
                                "border-l-primary/70 bg-surface-elevated/55 hover:bg-surface-elevated/55",
                            )}
                          >
                            <span className="block min-w-0">
                              <span className="flex items-center justify-between gap-3">
                                <span className="flex flex-wrap items-center gap-2">
                                  <AlertSeverityBadge
                                    severity={alert.severity}
                                  />
                                  {acknowledged && (
                                    <span className="text-xs text-text-muted">
                                      Acknowledged
                                    </span>
                                  )}
                                </span>
                                <span className="shrink-0 text-xs text-text-muted">
                                  {alert.lastSeen}
                                </span>
                              </span>
                              <span
                                className={cn(
                                  "mt-2.5 block text-sm leading-5 font-medium",
                                  acknowledged
                                    ? "text-muted-foreground"
                                    : "text-foreground",
                                )}
                              >
                                {alert.title}
                              </span>
                              <span
                                className={cn(
                                  "mt-2 block text-xs",
                                  acknowledged
                                    ? "text-text-muted"
                                    : "text-foreground/80",
                                )}
                              >
                                {alert.server}
                              </span>
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <Empty className="min-h-80 border-0">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <ShieldCheckIcon />
                      </EmptyMedia>
                      <EmptyTitle>
                        {hasFilters
                          ? "No matching alerts"
                          : status === "open"
                            ? "No alerts need review"
                            : "No acknowledged alerts"}
                      </EmptyTitle>
                      <EmptyDescription>
                        {hasFilters
                          ? "Try another search or clear the filters."
                          : status === "open"
                            ? "All findings have been acknowledged. They may still need a fix."
                            : "Alerts you acknowledge will appear here."}
                      </EmptyDescription>
                    </EmptyHeader>
                    {hasFilters ? (
                      <Button
                        variant="outline"
                        onClick={clearFilters}
                        className="min-h-11"
                      >
                        Clear filters
                      </Button>
                    ) : status === "open" ? (
                      <Button
                        variant="outline"
                        onClick={() => setStatus("acknowledged")}
                        className="min-h-11"
                      >
                        View acknowledged alerts
                      </Button>
                    ) : null}
                  </Empty>
                )}
              </div>

              <div
                className={cn(
                  "min-w-0",
                  mobileDetail ? "block" : "hidden xl:block",
                  !selectedAlert && "xl:hidden",
                )}
              >
                {selectedAlert ? (
                  <AlertDetail
                    alert={selectedAlert}
                    acknowledged={acknowledgedIds.has(selectedAlert.id)}
                    onToggleAcknowledged={() =>
                      toggleAcknowledged(selectedAlert)
                    }
                    detailRef={detailPanelRef}
                    onBack={backToAlerts}
                    onDetailFocus={() => {
                      focusedAlert.current = {
                        id: selectedAlert.id,
                        previousIndex: selectedAlertIndex,
                      };
                    }}
                  />
                ) : null}
              </div>
            </div>
          </TabsContent>
          {storageError && (
            <div className="border-t border-border px-4 py-2.5 sm:px-5">
              <Alert variant="destructive">
                <AlertDescription>{storageError}</AlertDescription>
              </Alert>
            </div>
          )}
        </section>
      </Tabs>
    </div>
  );
}
