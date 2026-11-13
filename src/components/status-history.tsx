"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { RefreshCwIcon } from "lucide-react";
import {
  DAY_MS,
  HOUR_MS,
  bucketSeries,
  bucketTone,
  durationLabel,
  statusLabel,
  timeParts,
  uptimeLabel,
  uptimeShare,
  type HealthBucket,
  type StatusIncident,
  type TargetHistory,
  type TimeFormat,
} from "@/lib/status-page";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import {
  metaSize,
  metaText,
  statusFocus as focusRing,
} from "@/components/status-indicators";
/** Bars use the status colors; days without samples recede into the card. */
const barColor: Record<ReturnType<typeof bucketTone>, string> = {
  operational: "bg-primary",
  degraded: "bg-warning",
  down: "bg-destructive",
  maintenance: "bg-muted-foreground/60",
  unknown: "bg-border-strong",
  empty: "bg-border",
};
const DAYS = 90;

type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; history: TargetHistory };

/**
 * One target's history under its row: uptime over four spans, a 90-day
 * strip, response times for URL targets, and recent incidents. It loads when
 * the row opens, never with the page.
 */
export function TargetHistoryPanel({
  load,
  format,
}: {
  load: () => Promise<TargetHistory>;
  format: TimeFormat;
}) {
  const [result, setResult] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    load().then(
      (history) => current && setResult({ state: "ready", history }),
      () => current && setResult({ state: "error" }),
    );
    return () => {
      current = false;
    };
  }, [load, attempt]);

  if (result.state === "loading")
    return (
      <div className="space-y-3 pt-1" aria-busy="true">
        <span className="sr-only">Loading history</span>
        <div className="grid grid-cols-2 gap-3 @min-[30rem]:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
        <Skeleton className="h-8" />
      </div>
    );
  if (result.state === "error")
    return (
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <p className={metaText}>History isn&apos;t available right now.</p>
        <button
          type="button"
          onClick={() => {
            setResult({ state: "loading" });
            setAttempt((n) => n + 1);
          }}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md border border-border-strong px-3 font-medium transition-[background-color] hover:bg-surface-elevated [@media(any-pointer:coarse)]:min-h-11",
            metaSize,
            focusRing,
          )}
        >
          <RefreshCwIcon aria-hidden="true" className="size-3.5" />
          Retry
        </button>
      </div>
    );
  return <HistoryView history={result.history} format={format} />;
}

function HistoryView({
  history,
  format,
}: {
  history: TargetHistory;
  format: TimeFormat;
}) {
  const { now, hours, days, incidents } = history;
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const since = (count: number) =>
    days.filter((d) => d.start > today - count * DAY_MS);
  const spans: [string, HealthBucket[]][] = [
    ["24 hours", hours],
    ["7 days", since(7)],
    ["30 days", since(30)],
    ["90 days", since(DAYS)],
  ];
  const latency = hours.some((h) => h.latencyMs !== null);
  return (
    <div className="space-y-5 pt-1">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 @min-[30rem]:grid-cols-4">
        {spans.map(([label, buckets]) => (
          <div key={label}>
            <dt className={metaText}>{label}</dt>
            <dd className="text-sm font-semibold tabular-nums">
              {uptimeLabel(uptimeShare(buckets))}
              {uptimeShare(buckets) !== null && (
                <span className="sr-only"> uptime</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <DayStrip days={days} now={now} format={format} />
      {latency && <ResponseChart hours={hours} now={now} format={format} />}
      <Incidents incidents={incidents} now={now} format={format} />
    </div>
  );
}

/** "Nov 10" for a UTC day bucket. */
function dayLabel(start: number, format: TimeFormat) {
  return new Date(start).toLocaleDateString(format.locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function bucketText(bucket: HealthBucket | undefined) {
  const tone = bucketTone(bucket);
  if (!bucket || tone === "empty") return "No data";
  const share = uptimeShare([bucket]);
  if (share === null) return statusLabel[tone];
  return bucket.maintenance > 0
    ? `${uptimeLabel(share)} up, with maintenance`
    : `${uptimeLabel(share)} up`;
}

/**
 * Ninety bars, one per UTC day. Hovering a bar, or moving through them with
 * the arrow keys, names its day and uptime in the line above.
 */
function DayStrip({
  days,
  now,
  format,
}: {
  days: HealthBucket[];
  now: number;
  format: TimeFormat;
}) {
  const series = bucketSeries(days, now, DAY_MS, DAYS);
  const [active, setActive] = useState<number | null>(null);
  const label = useId();
  const shown = active === null ? null : series[active];
  const strip = useRef<HTMLDivElement | null>(null);
  const keys = (event: KeyboardEvent) => {
    const step =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    // Narrow strips hide the oldest bars; keys stay on the ones shown.
    const bars = [...(strip.current?.children ?? [])];
    const first = Math.max(
      0,
      bars.findIndex((bar) => getComputedStyle(bar).display !== "none"),
    );
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? first : series.length - 1);
    } else if (step) {
      event.preventDefault();
      setActive((i) =>
        Math.min(
          series.length - 1,
          Math.max(first, (i ?? series.length) + step),
        ),
      );
    }
  };
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p id={label} className={cn(metaSize, "font-medium")}>
          Last <span className="@max-[30rem]:hidden">90</span>
          <span className="@min-[30rem]:hidden">30</span> days
        </p>
        <p aria-live="polite" className={cn(metaText, "tabular-nums")}>
          {shown
            ? `${dayLabel(shown.start, format)}: ${bucketText(shown.bucket)}`
            : ""}
        </p>
      </div>
      <div
        ref={strip}
        tabIndex={0}
        role="group"
        aria-labelledby={label}
        aria-describedby={`${label}-keys`}
        onKeyDown={keys}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
        className={cn("mt-2 flex h-8 gap-0.5 rounded-xs", focusRing)}
      >
        {series.map(({ start, bucket }, index) => (
          <div
            key={start}
            onMouseEnter={() => setActive(index)}
            className={cn(
              "min-w-0 flex-1 rounded-xs transition-opacity",
              barColor[bucketTone(bucket)],
              // Phones show the last 30 days, so each bar stays visible.
              index < DAYS - 30 && "@max-[30rem]:hidden",
              active !== null && active !== index && "opacity-60",
            )}
          />
        ))}
      </div>
      <span id={`${label}-keys`} className="sr-only">
        Use the arrow keys to read each day.
      </span>
      <div className={cn(metaText, "mt-1 flex justify-between")}>
        <span className="@max-[30rem]:hidden">90 days ago</span>
        <span className="@min-[30rem]:hidden">30 days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}

/** A round axis top: 100, 200, 250, 500, 1000, ... */
function niceMax(value: number) {
  const scale = 10 ** Math.floor(Math.log10(Math.max(1, value)));
  const step = [1, 2, 2.5, 5, 10].find((n) => n * scale >= value) ?? 10;
  return step * scale;
}

/** Mean URL response time per hour over the last day, as one line. */
function ResponseChart({
  hours,
  now,
  format,
}: {
  hours: HealthBucket[];
  now: number;
  format: TimeFormat;
}) {
  const series = bucketSeries(hours, now, HOUR_MS, 24);
  const values = series.map((s) => s.bucket?.latencyMs ?? null);
  const measured = values.filter((v): v is number => v !== null);
  const top = niceMax(Math.max(...measured));
  const average = Math.round(
    measured.reduce((sum, v) => sum + v, 0) / measured.length,
  );
  const [active, setActive] = useState<number | null>(null);
  const width = 240;
  const height = 64;
  const x = (i: number) => (i / (series.length - 1)) * width;
  const y = (v: number) => height - (v / top) * height;
  // Hours without a measurement break the line rather than bridge it.
  let path = "";
  values.forEach((v, i) => {
    if (v === null) return;
    path += `${i > 0 && values[i - 1] !== null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  const shown = active === null ? null : series[active];
  const hourText = (start: number) => timeParts(start, now, format).time;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className={cn(metaSize, "font-medium")}>Response time</p>
        <p aria-live="polite" className={cn(metaText, "tabular-nums")}>
          {shown
            ? `${hourText(shown.start)}: ${
                shown.bucket?.latencyMs == null
                  ? "No data"
                  : `${shown.bucket.latencyMs} ms`
              }`
            : `Average ${average} ms`}
        </p>
      </div>
      <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <div
          aria-hidden="true"
          className={cn(
            metaText,
            "flex h-16 flex-col justify-between text-right tabular-nums",
          )}
        >
          <span className="-mt-2.5">{top} ms</span>
          <span className="-mb-2.5">0</span>
        </div>
        <div
          className="relative h-16"
          onMouseLeave={() => setActive(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - box.left) / box.width;
            setActive(
              Math.min(
                series.length - 1,
                Math.max(0, Math.round(ratio * (series.length - 1))),
              ),
            );
          }}
        >
          <svg
            role="img"
            aria-label={`Response time over the last 24 hours, averaging ${average} milliseconds`}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible"
          >
            {[0, 0.5, 1].map((f) => (
              <line
                key={f}
                x1={0}
                x2={width}
                y1={height * f}
                y2={height * f}
                vectorEffect="non-scaling-stroke"
                className="stroke-border"
                strokeWidth={1}
              />
            ))}
            <path
              d={path}
              fill="none"
              vectorEffect="non-scaling-stroke"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              className="stroke-primary"
            />
            {active !== null && (
              <line
                x1={x(active)}
                x2={x(active)}
                y1={0}
                y2={height}
                vectorEffect="non-scaling-stroke"
                strokeWidth={1}
                className="stroke-muted-foreground"
              />
            )}
          </svg>
          {/* A measured hour between two gaps has no line to sit on. */}
          {values.map((v, i) =>
            v !== null &&
            (values[i - 1] ?? null) === null &&
            (values[i + 1] ?? null) === null ? (
              <span
                key={i}
                aria-hidden="true"
                className="pointer-events-none absolute size-1.5 -translate-1/2 rounded-full bg-primary"
                style={{
                  left: `${(i / (series.length - 1)) * 100}%`,
                  top: `${(y(v) / height) * 100}%`,
                }}
              />
            ) : null,
          )}
          {active !== null && values[active] !== null && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute size-2 -translate-1/2 rounded-full bg-primary ring-2 ring-card"
              style={{
                left: `${(active / (series.length - 1)) * 100}%`,
                top: `${(y(values[active]) / height) * 100}%`,
              }}
            />
          )}
        </div>
        <div className={cn(metaText, "col-start-2 mt-1 flex justify-between")}>
          <span>24 hours ago</span>
          <span>Now</span>
        </div>
      </div>
    </div>
  );
}

function Incidents({
  incidents,
  now,
  format,
}: {
  incidents: StatusIncident[];
  now: number;
  format: TimeFormat;
}) {
  const when = (at: number) => {
    const parts = timeParts(at, now, format);
    return `${parts.day}, ${parts.time} ${parts.zone}`;
  };
  return (
    <div>
      <p className={cn(metaSize, "font-medium")}>Recent incidents</p>
      {incidents.length === 0 ? (
        <p className={cn(metaText, "mt-1")}>
          No incidents in the last 90 days.
        </p>
      ) : (
        <ul className="mt-1 divide-y divide-border">
          {incidents.map((incident) => {
            const label = statusLabel[incident.worst];
            return (
              <li
                key={incident.startedAt}
                className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5"
              >
                <span className="text-sm">
                  {incident.endedAt === null
                    ? `${label} now`
                    : `${label} for ${durationLabel(incident.endedAt - incident.startedAt)}`}
                </span>
                <time
                  dateTime={new Date(incident.startedAt).toISOString()}
                  className={cn(metaText, "tabular-nums")}
                >
                  {incident.endedAt === null ? "Since " : ""}
                  {when(incident.startedAt)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
