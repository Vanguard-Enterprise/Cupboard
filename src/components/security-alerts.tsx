"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  Clock3Icon,
  SearchIcon,
  ServerIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
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

function subscribeToAcknowledgements(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === securityAlertStorageKey) callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("cupboard-security-alerts-saved", callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("cupboard-security-alerts-saved", callback);
  };
}

function acknowledgementSnapshot() {
  try {
    return window.localStorage.getItem(securityAlertStorageKey) ?? "";
  } catch {
    return storageUnavailable;
  }
}

const serverAcknowledgementSnapshot = () => null;

function severityLabel(severity: AlertSeverity) {
  return `${severity.slice(0, 1).toUpperCase()}${severity.slice(1)}`;
}

function AlertSeverityBadge({ severity }: { severity: AlertSeverity }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-3.5 rounded px-1 py-0 text-[9px] font-medium",
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
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-4 border-b border-border/35 py-2 last:border-0">
      <dt className="text-xs text-text-muted/75">{label}</dt>
      <dd
        className={cn(
          "text-sm text-foreground/90",
          mono && "font-mono text-xs",
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
}: {
  alert: SecurityAlert;
  acknowledged: boolean;
  onToggleAcknowledged: () => void;
}) {
  return (
    <article
      aria-labelledby="selected-alert-title"
      className="flex h-full min-w-0 flex-col"
    >
      <div className="shrink-0 border-b border-border px-5 py-3.5 sm:px-6">
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <AlertSeverityBadge severity={alert.severity} />
          <Badge
            variant="outline"
            className={cn(
              "h-4 rounded px-1.5 py-0 text-[10px] font-medium",
              acknowledged
                ? "border-primary/25 bg-primary/[0.07] text-primary"
                : "border-border-strong text-muted-foreground",
            )}
          >
            {acknowledged ? "Acknowledged" : "Open"}
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

      <div className="flex-1 space-y-3.5 px-5 pt-5 pb-3.5 sm:px-6">
        <section aria-labelledby="evidence-heading">
          <h3
            id="evidence-heading"
            className="mb-1.5 text-xs font-semibold text-muted-foreground"
          >
            Evidence
          </h3>
          <p className="text-sm leading-5 text-text-muted">{alert.evidence}</p>
        </section>
        <section aria-labelledby="impact-heading">
          <h3
            id="impact-heading"
            className="mb-1.5 text-xs font-semibold text-muted-foreground"
          >
            Why it matters
          </h3>
          <p className="text-sm leading-5 text-text-muted">{alert.impact}</p>
        </section>
        <section
          aria-labelledby="next-step-heading"
          className="rounded-lg border border-primary/15 bg-primary/[0.06] p-2.5"
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
        className="mt-auto shrink-0 border-t border-border bg-card px-6 py-4"
      >
        <div className="flex min-h-10 flex-wrap items-center gap-3">
          <Button
            type="button"
            variant={acknowledged ? "outline" : "default"}
            onClick={onToggleAcknowledged}
            className="min-h-10 sm:min-h-8"
          >
            {acknowledged ? "Reopen alert" : "Acknowledge alert"}
          </Button>
          {acknowledged && (
            <p role="status" className="text-xs text-text-muted/70">
              Alert acknowledged.
            </p>
          )}
        </div>
      </footer>
    </article>
  );
}

export function SecurityAlerts() {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(securityAlerts[0].id);
  const [sessionAcknowledgedIds, setSessionAcknowledgedIds] =
    useState<Set<string> | null>(null);
  const storedAcknowledgements = useSyncExternalStore(
    subscribeToAcknowledgements,
    acknowledgementSnapshot,
    serverAcknowledgementSnapshot,
  );
  const [saveError, setSaveError] = useState("");
  const persistedState = useMemo(() => {
    const fallback = new Set<string>(initiallyAcknowledgedAlertIds);
    if (storedAcknowledgements === null || storedAcknowledgements === "") {
      return { ids: fallback, error: "" };
    }
    if (storedAcknowledgements === storageUnavailable) {
      return {
        ids: fallback,
        error:
          "Saved acknowledgement state could not be loaded in this browser.",
      };
    }
    try {
      const parsed = JSON.parse(storedAcknowledgements) as unknown;
      if (!Array.isArray(parsed)) throw new Error("Invalid stored state");
      return {
        ids: new Set(
          parsed.filter(
            (id): id is string =>
              typeof id === "string" && knownAlertIds.has(id),
          ),
        ),
        error: "",
      };
    } catch {
      return {
        ids: fallback,
        error:
          "Saved acknowledgement state could not be loaded in this browser.",
      };
    }
  }, [storedAcknowledgements]);
  const acknowledgedIds = sessionAcknowledgedIds ?? persistedState.ids;
  const storageError = saveError || persistedState.error;

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
        return matchesStatus && matchesSeverity && matchesQuery;
      })
      .sort(
        (left, right) =>
          severityOrder[left.severity] - severityOrder[right.severity],
      );
  }, [acknowledgedIds, query, severity, status]);

  const selectedAlert =
    visibleAlerts.find((alert) => alert.id === selectedId) ?? visibleAlerts[0];
  const openAlerts = securityAlerts.filter(
    (alert) => !acknowledgedIds.has(alert.id),
  );
  const affectedServers = new Set(openAlerts.map((alert) => alert.server)).size;

  function toggleAcknowledged(alert: SecurityAlert) {
    const next = new Set(acknowledgedIds);
    const wasAcknowledged = next.has(alert.id);
    if (wasAcknowledged) next.delete(alert.id);
    else next.add(alert.id);

    setSaveError("");
    try {
      window.localStorage.setItem(
        securityAlertStorageKey,
        JSON.stringify([...next]),
      );
      window.dispatchEvent(new Event("cupboard-security-alerts-saved"));
      setSessionAcknowledgedIds(null);
    } catch {
      setSessionAcknowledgedIds(next);
      setSaveError(
        "The acknowledgement changed for this session but could not be saved in this browser.",
      );
    }
  }

  const metrics = [
    {
      label: "Unresolved alerts",
      value: String(openAlerts.length),
      detail: `${openAlerts.filter((alert) => alert.severity === "critical").length} critical`,
      icon: CircleAlertIcon,
      iconClassName: "text-destructive",
    },
    {
      label: "Acknowledged",
      value: String(acknowledgedIds.size),
      detail: `of ${securityAlerts.length} alerts`,
      icon: CheckCircle2Icon,
      iconClassName: "text-primary",
    },
    {
      label: "Affected servers",
      value: String(affectedServers),
      detail: "With open alerts",
      icon: ServerIcon,
      iconClassName: "text-warning",
    },
    {
      label: "Last evaluation",
      value: "2m",
      detail: "Sample snapshot",
      icon: Clock3Icon,
      iconClassName: "text-muted-foreground",
    },
  ] as const;

  return (
    <div className="space-y-4">
      <section
        aria-label="Security alert summary"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        {metrics.map(({ label, value, detail, icon: Icon, iconClassName }) => (
          <div
            key={label}
            className="flex h-[88px] flex-col rounded-xl border border-border bg-card px-5 py-3.5"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-muted-foreground">
                {label}
              </p>
              <Icon
                className={cn("size-4", iconClassName)}
                aria-hidden="true"
              />
            </div>
            <div className="mt-auto flex items-baseline gap-2 pt-2">
              <p className="font-mono text-[2rem] leading-none font-semibold tracking-tight tabular-nums">
                {value}
              </p>
              <p className="text-[10px] leading-none font-normal text-text-muted">
                {detail}
              </p>
            </div>
          </div>
        ))}
      </section>

      <section
        aria-label="Security alert review"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="border-b border-border px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-baseline gap-1.5">
              <h2 className="text-base font-semibold">Alert queue</h2>
              <p className="text-xs text-text-muted">
                {visibleAlerts.length}{" "}
                {visibleAlerts.length === 1 ? "alert" : "alerts"}
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-[11rem_auto_auto]">
              <label className="relative min-w-0 sm:mr-1.5">
                <span className="sr-only">Search alerts</span>
                <SearchIcon
                  className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-muted"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search alerts"
                  className="h-9 pl-8"
                />
              </label>
              <Select
                value={status}
                onValueChange={(value) => setStatus(value as StatusFilter)}
              >
                <SelectTrigger
                  className="h-9 w-full sm:w-36"
                  aria-label="Filter by status"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="acknowledged">Acknowledged</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={severity}
                onValueChange={(value) => setSeverity(value as SeverityFilter)}
              >
                <SelectTrigger
                  className="h-9 w-full sm:w-36"
                  aria-label="Filter by severity"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  <SelectItem value="all">All severities</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="grid min-h-[580px] xl:grid-cols-[minmax(28rem,1.16fr)_minmax(24rem,0.84fr)]">
          <div className="border-b border-border xl:border-r xl:border-b-0">
            {visibleAlerts.length ? (
              <div role="list" aria-label="Security alerts">
                {visibleAlerts.map((alert) => {
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
                        aria-pressed={isSelected}
                        onClick={() => {
                          setSelectedId(alert.id);
                          setSaveError("");
                        }}
                        className={cn(
                          "block min-h-[100px] w-full border-l-2 border-l-transparent px-4 py-3.5 text-left outline-none transition-colors hover:bg-surface-elevated/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          isSelected &&
                            "border-l-primary/70 bg-surface-elevated/55 hover:bg-surface-elevated/55",
                        )}
                      >
                        <span className="block min-w-0">
                          <span className="flex items-center justify-between gap-3">
                            <span
                              className={cn(
                                "flex flex-wrap items-center gap-2",
                                acknowledged && "opacity-70",
                              )}
                            >
                              <AlertSeverityBadge severity={alert.severity} />
                              {acknowledged && (
                                <span className="text-xs text-text-muted">
                                  Acknowledged
                                </span>
                              )}
                            </span>
                            <span
                              className={cn(
                                "shrink-0 text-xs text-text-muted",
                                acknowledged && "text-text-muted/70",
                              )}
                            >
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
                  <EmptyTitle>No matching alerts</EmptyTitle>
                  <EmptyDescription>
                    Change the search or filters to see another part of the
                    queue.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>

          {selectedAlert ? (
            <AlertDetail
              alert={selectedAlert}
              acknowledged={acknowledgedIds.has(selectedAlert.id)}
              onToggleAcknowledged={() => toggleAcknowledged(selectedAlert)}
            />
          ) : (
            <Empty className="min-h-80 border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ShieldAlertIcon />
                </EmptyMedia>
                <EmptyTitle>No alert selected</EmptyTitle>
                <EmptyDescription>
                  Change the filters to review an alert and its evidence.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        {storageError && (
          <p
            role="alert"
            className="border-t border-border px-4 py-2.5 text-xs text-destructive sm:px-5"
          >
            {storageError}
          </p>
        )}
      </section>
    </div>
  );
}
