"use client";

import { useMemo, useState } from "react";
import {
  CalendarIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleXIcon,
  SearchIcon,
  SearchXIcon,
} from "lucide-react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type EventType = "access" | "integration" | "organization" | "server";
type EventOutcome = "failed" | "succeeded";

type AuditEvent = {
  id: string;
  timestamp: string;
  date: string;
  time: string;
  actor: string;
  actorDetail: string;
  action: string;
  target: string;
  type: EventType;
  outcome: EventOutcome;
  source: string;
  ipAddress: string;
  userAgent: string;
  metadata: string;
};

const eventTypeLabels: Record<EventType, string> = {
  access: "Access",
  integration: "Integration",
  organization: "Organization",
  server: "Server",
};

const events: AuditEvent[] = [
  {
    id: "evt_01J7MQR8W2",
    timestamp: "2026-09-15T21:42:00-04:00",
    date: "Sep 15, 2026",
    time: "9:42 PM",
    actor: "Demo operator",
    actorDetail: "operator@example.com",
    action: "Updated connection settings",
    target: "Rusty Moose East",
    type: "server",
    outcome: "succeeded",
    source: "Dashboard",
    ipAddress: "198.51.100.24",
    userAgent: "Chrome 140 on macOS",
    metadata: "A2S query port changed from 28017 to 28019",
  },
  {
    id: "evt_01J7MP6TNS",
    timestamp: "2026-09-15T20:16:00-04:00",
    date: "Sep 15, 2026",
    time: "8:16 PM",
    actor: "Cupboard automation",
    actorDetail: "System actor",
    action: "Restarted server",
    target: "Staging sandbox",
    type: "server",
    outcome: "succeeded",
    source: "Approved action",
    ipAddress: "Internal",
    userAgent: "Cupboard worker/1.0",
    metadata: "Approved by Demo operator",
  },
  {
    id: "evt_01J7MHRG4A",
    timestamp: "2026-09-15T18:03:00-04:00",
    date: "Sep 15, 2026",
    time: "6:03 PM",
    actor: "Maya Chen",
    actorDetail: "maya@example.com",
    action: "Accepted invitation",
    target: "Operator team",
    type: "access",
    outcome: "succeeded",
    source: "Invitation link",
    ipAddress: "203.0.113.82",
    userAgent: "Safari 19 on macOS",
    metadata: "Assigned role: Operator",
  },
  {
    id: "evt_01J7M9CSQP",
    timestamp: "2026-09-15T15:27:00-04:00",
    date: "Sep 15, 2026",
    time: "3:27 PM",
    actor: "Demo operator",
    actorDetail: "operator@example.com",
    action: "Replaced RCON credential",
    target: "Glacier Network 2",
    type: "integration",
    outcome: "succeeded",
    source: "Dashboard",
    ipAddress: "198.51.100.24",
    userAgent: "Chrome 140 on macOS",
    metadata: "Credential: RCON, value redacted",
  },
  {
    id: "evt_01J7M2ATQF",
    timestamp: "2026-09-15T12:10:00-04:00",
    date: "Sep 15, 2026",
    time: "12:10 PM",
    actor: "Cupboard automation",
    actorDetail: "System actor",
    action: "Created backup",
    target: "Rusty Moose East",
    type: "server",
    outcome: "failed",
    source: "Scheduled task",
    ipAddress: "Internal",
    userAgent: "Cupboard worker/1.0",
    metadata: "Connection timed out after 30 seconds",
  },
  {
    id: "evt_01J7KZQJX9",
    timestamp: "2026-09-14T23:48:00-04:00",
    date: "Sep 14, 2026",
    time: "11:48 PM",
    actor: "Eli Morgan",
    actorDetail: "eli@example.com",
    action: "Changed member role",
    target: "Maya Chen",
    type: "access",
    outcome: "succeeded",
    source: "Dashboard",
    ipAddress: "192.0.2.44",
    userAgent: "Firefox 142 on Linux",
    metadata: "Role changed from Viewer to Operator",
  },
  {
    id: "evt_01J7KHA3V6",
    timestamp: "2026-09-14T18:31:00-04:00",
    date: "Sep 14, 2026",
    time: "6:31 PM",
    actor: "Demo operator",
    actorDetail: "operator@example.com",
    action: "Created API token",
    target: "Deploy bot",
    type: "integration",
    outcome: "succeeded",
    source: "Dashboard",
    ipAddress: "198.51.100.24",
    userAgent: "Chrome 140 on macOS",
    metadata: "Scopes: deploy:read, deploy:write",
  },
  {
    id: "evt_01J7JS4Y1D",
    timestamp: "2026-09-14T10:22:00-04:00",
    date: "Sep 14, 2026",
    time: "10:22 AM",
    actor: "Unknown user",
    actorDetail: "No signed-in account",
    action: "Completed login challenge",
    target: "operator@example.com",
    type: "access",
    outcome: "failed",
    source: "Sign-in page",
    ipAddress: "203.0.113.19",
    userAgent: "Firefox 142 on Windows",
    metadata: "Challenge expired after 10 minutes",
  },
  {
    id: "evt_01J7H0BNR7",
    timestamp: "2026-09-13T16:05:00-04:00",
    date: "Sep 13, 2026",
    time: "4:05 PM",
    actor: "Demo operator",
    actorDetail: "operator@example.com",
    action: "Updated organization profile",
    target: "Cupboard",
    type: "organization",
    outcome: "succeeded",
    source: "Dashboard",
    ipAddress: "198.51.100.24",
    userAgent: "Chrome 140 on macOS",
    metadata: "Changed field: Public support URL",
  },
];

function OutcomeBadge({ outcome }: { outcome: EventOutcome }) {
  if (outcome === "failed") {
    return (
      <Badge
        variant="destructive"
        className="h-5 gap-1 px-1 text-[11px] [&>svg]:size-2.5!"
      >
        <CircleXIcon aria-hidden="true" />
        Failed
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="h-5 gap-1 border-primary/30 bg-primary/10 px-1 text-[11px] text-primary [&>svg]:size-2.5!"
    >
      <CheckCircle2Icon aria-hidden="true" />
      Succeeded
    </Badge>
  );
}

function EventDetails({ event }: { event: AuditEvent }) {
  const details = [
    ["Actor", `${event.actor} · ${event.actorDetail}`],
    ["Target", event.target],
    ["Source", event.source],
    ["IP address", event.ipAddress],
    ["User agent", event.userAgent],
    ["Event ID", event.id],
  ];
  const metadata = [
    ["Category", eventTypeLabels[event.type]],
    ["Context", event.metadata],
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/50">
      <dl className="divide-y divide-border/50 px-5">
        {details.map(([label, value]) => (
          <div
            key={label}
            className="grid grid-cols-[6.75rem_minmax(0,1fr)] gap-4 py-3 text-sm"
          >
            <dt className="text-text-muted">{label}</dt>
            <dd
              className={
                label === "Event ID" || label === "IP address"
                  ? "break-all font-mono text-xs text-foreground"
                  : "break-words leading-5 text-foreground"
              }
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <section className="border-t border-border/50 px-5 py-4">
        <h3 className="text-xs font-medium text-text-muted">Event metadata</h3>
        <dl className="mt-2 divide-y divide-border/50">
          {metadata.map(([label, value]) => (
            <div
              key={label}
              className="grid grid-cols-[6.75rem_minmax(0,1fr)] gap-4 py-3 text-sm"
            >
              <dt className="text-text-muted">{label}</dt>
              <dd className="break-words leading-5 text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

export function AuditLog() {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<EventType | "all">("all");
  const [outcome, setOutcome] = useState<EventOutcome | "all">("all");
  const [actor, setActor] = useState("all");
  const [action, setAction] = useState("all");
  const [target, setTarget] = useState("all");
  const [dateRange, setDateRange] = useState<DateRange>();
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null);

  const filteredEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return events.filter((event) => {
      const matchesQuery =
        !normalizedQuery ||
        [
          event.actor,
          event.actorDetail,
          event.action,
          event.target,
          event.source,
          event.id,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);
      return (
        matchesQuery &&
        (type === "all" || event.type === type) &&
        (outcome === "all" || event.outcome === outcome) &&
        (actor === "all" || event.actor === actor) &&
        (action === "all" || event.action === action) &&
        (target === "all" || event.target === target) &&
        (!dateRange?.from ||
          event.timestamp.slice(0, 10) >=
            format(dateRange.from, "yyyy-MM-dd")) &&
        (!dateRange?.from ||
          event.timestamp.slice(0, 10) <=
            format(dateRange.to ?? dateRange.from, "yyyy-MM-dd"))
      );
    });
  }, [outcome, query, type, actor, action, target, dateRange]);
  const filtersActive = Boolean(
    query.trim() ||
    type !== "all" ||
    outcome !== "all" ||
    actor !== "all" ||
    action !== "all" ||
    target !== "all" ||
    dateRange?.from,
  );

  function clearFilters() {
    setQuery("");
    setType("all");
    setOutcome("all");
    setActor("all");
    setAction("all");
    setTarget("all");
    setDateRange(undefined);
  }

  const filters = [
    {
      label: "Event type",
      shortLabel: "Type",
      value: type,
      onChange: (value: string) => setType(value as EventType | "all"),
      options: Object.entries(eventTypeLabels),
    },
    {
      label: "Actor",
      shortLabel: "Actor",
      value: actor,
      onChange: setActor,
      options: [...new Set(events.map((event) => event.actor))].map((value) => [
        value,
        value,
      ]),
    },
    {
      label: "Action",
      shortLabel: "Action",
      value: action,
      onChange: setAction,
      options: [...new Set(events.map((event) => event.action))].map(
        (value) => [value, value],
      ),
    },
    {
      label: "Target",
      shortLabel: "Target",
      value: target,
      onChange: setTarget,
      options: [...new Set(events.map((event) => event.target))].map(
        (value) => [value, value],
      ),
    },
    {
      label: "Outcome",
      shortLabel: "Outcome",
      value: outcome,
      onChange: (value: string) => setOutcome(value as EventOutcome | "all"),
      options: [
        ["succeeded", "Succeeded"],
        ["failed", "Failed"],
      ],
    },
  ];

  return (
    <section aria-label="Organization audit events" className="@container">
      <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3">
        <div
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
          aria-label="Event filters"
        >
          {filters.map((filter) => (
            <Select
              key={filter.label}
              value={filter.value}
              onValueChange={filter.onChange}
            >
              <SelectTrigger
                aria-label={filter.label}
                className={`max-w-full gap-2 border-transparent px-2.5 shadow-none data-[size=default]:h-11 sm:data-[size=default]:h-9 ${filter.value !== "all" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-surface-elevated"}`}
              >
                <SelectValue>
                  {filter.value === "all"
                    ? filter.shortLabel
                    : filter.options.find(
                        ([value]) => value === filter.value,
                      )?.[1]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value="all">
                  All{" "}
                  {filter.label === "Event type"
                    ? "event types"
                    : `${filter.label.toLowerCase()}s`}
                </SelectItem>
                {filter.options.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className="h-11 max-w-full gap-2 sm:h-9"
              >
                <CalendarIcon aria-hidden="true" className="size-4" />
                {dateRange?.from
                  ? `${format(dateRange.from, "MMM d, yyyy")}${dateRange.to && dateRange.to.getTime() !== dateRange.from.getTime() ? ` – ${format(dateRange.to, "MMM d, yyyy")}` : ""}`
                  : "Select date range"}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="max-h-[var(--radix-popover-content-available-height)] w-auto max-w-[calc(100vw-2rem)] overflow-y-auto p-3"
              aria-label="Filter by date range"
            >
              <p className="text-sm font-medium">Date range</p>
              <p className="text-xs text-muted-foreground">
                Select a start and end date. Times are in EDT.
              </p>
              <Calendar
                mode="range"
                selected={dateRange}
                onSelect={setDateRange}
                defaultMonth={dateRange?.from ?? new Date(2026, 8, 15)}
                className="[--cell-size:min(2.75rem,calc((100vw-6rem)/7))] sm:[--cell-size:2.25rem]"
              />
              <Button variant="ghost" onClick={() => setDateRange(undefined)}>
                Clear dates
              </Button>
            </PopoverContent>
          </Popover>
          {filtersActive && (
            <Button
              variant="ghost"
              onClick={clearFilters}
              className="h-11 text-muted-foreground sm:h-9"
            >
              Clear filters
            </Button>
          )}
        </div>
        <div className="w-full sm:w-64">
          <label
            htmlFor="audit-search"
            className="mb-1.5 block text-xs text-muted-foreground"
          >
            Search events
          </label>
          <div className="relative">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-muted"
              aria-hidden="true"
            />
            <Input
              id="audit-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search actors, actions, targets…"
              className="h-11 pl-9 sm:h-9"
            />
          </div>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {filteredEvents.length ? (
          <>
            <div className="hidden @[880px]:block">
              <Table className="table-fixed">
                <TableCaption className="sr-only">
                  Organization audit events, newest first. Times in EDT.
                </TableCaption>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[10%] pl-4 text-xs">Type</TableHead>
                    <TableHead className="w-[13%] text-xs">
                      Date <span className="text-text-muted">EDT</span>
                    </TableHead>
                    <TableHead className="w-[16%] text-xs">Actor</TableHead>
                    <TableHead className="w-[20%] text-xs">Action</TableHead>
                    <TableHead className="w-[16%] text-xs">Target</TableHead>
                    <TableHead className="pr-4 text-xs">Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEvents.map((event) => (
                    <TableRow
                      key={event.id}
                      onClick={() => setSelectedEvent(event)}
                      className="cursor-pointer hover:bg-surface-elevated/80 focus-within:bg-surface-elevated/80"
                    >
                      <TableCell className="py-3 pl-4 text-xs text-muted-foreground">
                        {eventTypeLabels[event.type]}
                      </TableCell>
                      <TableCell className="py-3">
                        <time dateTime={event.timestamp}>
                          <span className="block text-xs">{event.date}</span>
                          <span className="mt-1 block text-xs tabular-nums text-text-muted">
                            {event.time}
                          </span>
                        </time>
                      </TableCell>
                      <TableCell className="py-3">
                        <span
                          className="block truncate text-sm"
                          title={event.actor}
                        >
                          {event.actor}
                        </span>
                        <span
                          className="mt-1 block truncate text-xs text-text-muted"
                          title={event.actorDetail}
                        >
                          {event.actorDetail}
                        </span>
                      </TableCell>
                      <TableCell className="py-3">
                        <span className="mb-1.5 block whitespace-normal text-sm">
                          {event.action}
                        </span>
                        <OutcomeBadge outcome={event.outcome} />
                      </TableCell>
                      <TableCell className="py-3">
                        <span
                          className="block truncate text-sm"
                          title={event.target}
                        >
                          {event.target}
                        </span>
                      </TableCell>
                      <TableCell className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          <span
                            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                            title={event.metadata}
                          >
                            {event.metadata}
                          </span>
                          <button
                            type="button"
                            aria-label={`View event: ${event.action} for ${event.target}`}
                            aria-haspopup="dialog"
                            onClick={(clickEvent) => {
                              clickEvent.stopPropagation();
                              setSelectedEvent(event);
                            }}
                            className="flex size-8 shrink-0 items-center justify-center rounded text-text-muted outline-none hover:bg-surface-elevated hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <ChevronRightIcon
                              className="size-4"
                              aria-hidden="true"
                            />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <ul className="divide-y divide-border @[880px]:hidden">
              {filteredEvents.map((event) => (
                <li key={event.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedEvent(event)}
                    className="flex min-h-11 w-full items-start gap-3 px-4 py-4 text-left outline-none transition-colors hover:bg-surface-elevated/80 focus-visible:bg-surface-elevated/80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-label={`View event: ${event.action} for ${event.target}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-foreground">
                          {event.action}
                        </p>
                        <OutcomeBadge outcome={event.outcome} />
                      </div>
                      <p className="mt-1.5 truncate text-sm text-foreground">
                        {event.target}
                      </p>
                      <p className="mt-2 text-xs text-text-muted">
                        {event.actor} · {event.date} at {event.time}
                      </p>
                    </div>
                    <ChevronRightIcon
                      className="mt-1 size-4 shrink-0 text-text-muted/60"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="flex min-h-72 flex-col items-center justify-center px-6 py-12 text-center">
            <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface-elevated">
              <SearchXIcon
                className="size-5 text-text-muted"
                aria-hidden="true"
              />
            </div>
            <h2 className="mt-4 text-base font-semibold">No matching events</h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Try another search or clear your filters.
            </p>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between gap-4 text-xs text-muted-foreground">
        <p role="status">
          {filteredEvents.length}{" "}
          {filteredEvents.length === 1 ? "result" : "results"}
          {filtersActive ? ` of ${events.length} events` : ""}
        </p>
        <p>Newest first · Times in EDT</p>
      </div>
      <Sheet
        open={selectedEvent !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedEvent(null);
        }}
      >
        <SheetContent
          className="m-0 w-full gap-0 data-[side=right]:right-0! data-[side=right]:w-full! data-[side=right]:sm:max-w-[28.75rem]"
          closeButtonClassName="size-11 lg:size-7"
          overlayClassName="supports-backdrop-filter:backdrop-blur-[1px]"
        >
          {selectedEvent ? (
            <>
              <SheetHeader className="gap-3 px-5 py-4 pr-16 lg:pr-12">
                <div className="flex items-start justify-between gap-3">
                  <SheetTitle className="leading-5">
                    {selectedEvent.action}
                  </SheetTitle>
                  <OutcomeBadge outcome={selectedEvent.outcome} />
                </div>
                <time
                  dateTime={selectedEvent.timestamp}
                  className="font-mono text-xs text-text-muted"
                >
                  {selectedEvent.date} at {selectedEvent.time} EDT
                </time>
                <SheetDescription className="sr-only">
                  Audit event operational details.
                </SheetDescription>
              </SheetHeader>
              <EventDetails event={selectedEvent} />
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}
