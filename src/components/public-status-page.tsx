"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { CalendarClockIcon, WrenchIcon } from "lucide-react";
import { apiRequest } from "@/lib/api-client";
import {
  activeMaintenance,
  componentStatus,
  groupComponents,
  maintenancePhase,
  overallStatus,
  statusLabel,
  windowLabel,
  type MaintenanceWindow,
  type PublicStatus,
} from "@/lib/status-page";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  StatusDot,
  ToneIcon,
  toneClass,
  toneTile,
} from "@/components/status-indicators";

const REFRESH_MS = 60_000;

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

  const load = useCallback(async () => {
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
    return () => {
      window.clearInterval(timer);
      window.clearInterval(tick);
    };
  }, [load]);

  const components = data.components.map((c) => ({
    ...c,
    kind: "server" as const,
    sourceId: "",
    sourceName: null,
    public: true,
  }));
  const overall = overallStatus(components, data.maintenance, now);
  const active = activeMaintenance(data.maintenance, now);
  const upcoming = data.maintenance
    .filter((w) => maintenancePhase(w, now) === "scheduled")
    .sort((a, b) => a.startsAt - b.startsAt);
  const recent = data.maintenance.filter(
    (w) => maintenancePhase(w, now) === "completed",
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 md:py-12">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold tracking-tight">{data.name}</h1>
          {data.supportUrl && (
            <Button asChild variant="outline" className="h-9 px-3">
              <a href={data.supportUrl} target="_blank" rel="noreferrer">
                Contact support
              </a>
            </Button>
          )}
        </header>

        {data.announcement && (
          <p className="mt-6 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            {data.announcement}
          </p>
        )}

        <section
          aria-live="polite"
          className="mt-6 rounded-xl border border-border bg-card px-5 py-6 text-center md:px-8 md:py-8"
        >
          <span
            className={cn(
              "mx-auto flex size-12 items-center justify-center rounded-full border",
              toneTile[overall.tone],
            )}
          >
            <ToneIcon tone={overall.tone} className="size-6" />
          </span>
          <p className="mt-4 text-2xl font-semibold tracking-tight">
            {overall.title}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{overall.detail}</p>
          <p className="mt-3 text-xs text-muted-foreground">
            {stale ? "Refresh failed. Showing the last known state, " : ""}
            Updated {formatDistanceToNow(data.updatedAt, { addSuffix: true })}
          </p>
        </section>

        {active.map((window) => (
          <MaintenanceNotice key={window.id} window={window} now={now} active />
        ))}

        <section aria-label="Current status" className="mt-6">
          {components.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing is being tracked on this page yet.
            </p>
          ) : (
            <div className="divide-y divide-border rounded-xl border border-border bg-card">
              {groupComponents(components).map((group) => (
                <div key={group.name || "(ungrouped)"} className="py-1">
                  {group.name && (
                    <p className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                      {group.name}
                    </p>
                  )}
                  {group.items.map((component) => {
                    const status = componentStatus(
                      component,
                      data.maintenance,
                      now,
                    );
                    return (
                      <div
                        key={component.id}
                        className="flex items-center justify-between gap-3 px-4 py-3"
                      >
                        <span className="flex min-w-0 items-center gap-3 text-sm font-medium">
                          <StatusDot status={status} />
                          <span className="truncate">{component.name}</span>
                        </span>
                        <span
                          className={cn(
                            "shrink-0 text-xs font-medium",
                            toneClass[status],
                          )}
                        >
                          {statusLabel[status]}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </section>

        {upcoming.length > 0 && (
          <section aria-labelledby="upcoming-heading" className="mt-8">
            <h2 id="upcoming-heading" className="text-base font-semibold">
              Scheduled maintenance
            </h2>
            <div className="mt-3 space-y-3">
              {upcoming.map((window) => (
                <MaintenanceNotice key={window.id} window={window} now={now} />
              ))}
            </div>
          </section>
        )}

        {recent.length > 0 && (
          <section aria-labelledby="recent-heading" className="mt-8">
            <h2 id="recent-heading" className="text-base font-semibold">
              Past maintenance
            </h2>
            <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
              {recent.map((window) => (
                <li key={window.id} className="px-4 py-3">
                  <p className="text-sm font-medium">{window.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {windowLabel(window, now).range}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="mt-10 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <span>Powered by</span>
          <Link
            href="/"
            className="flex items-center gap-1.5 font-medium text-foreground"
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
        </footer>
      </div>
    </div>
  );
}

function MaintenanceNotice({
  window,
  now,
  active = false,
}: {
  window: MaintenanceWindow;
  now: number;
  active?: boolean;
}) {
  const { range } = windowLabel(window, now);
  return (
    <div
      className={cn(
        "mt-4 flex items-start gap-3 rounded-xl border px-4 py-3",
        active ? "border-warning/40 bg-warning/5" : "border-border bg-card",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border",
          active
            ? "border-warning/40 bg-warning/10 text-warning"
            : "border-border bg-surface-elevated text-muted-foreground",
        )}
      >
        {active ? (
          <WrenchIcon aria-hidden="true" className="size-4" />
        ) : (
          <CalendarClockIcon aria-hidden="true" className="size-4" />
        )}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {active ? "Maintenance in progress: " : ""}
          {window.title}
        </p>
        <p className="text-xs text-muted-foreground">{range}</p>
        {window.message && (
          <p className="mt-1 text-sm text-muted-foreground">{window.message}</p>
        )}
      </div>
    </div>
  );
}
