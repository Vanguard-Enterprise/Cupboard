"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ChevronDownIcon,
  DatabaseIcon,
  ServerIcon,
  UsersIcon,
} from "lucide-react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "@/components/ui/table";
import { useOrganization } from "@/components/organization-provider";

// Fixed design data until server-side metering is available. Keep the displayed
// date range tied to these records rather than implying this is today's usage.
const activity = [
  { date: "Aug 17", checks: 38, actions: 11 },
  { date: "Aug 18", checks: 43, actions: 13 },
  { date: "Aug 19", checks: 40, actions: 12 },
  { date: "Aug 20", checks: 47, actions: 15 },
  { date: "Aug 21", checks: 45, actions: 14 },
  { date: "Aug 22", checks: 51, actions: 17 },
  { date: "Aug 23", checks: 49, actions: 16 },
  { date: "Aug 24", checks: 55, actions: 19 },
  { date: "Aug 25", checks: 53, actions: 18 },
  { date: "Aug 26", checks: 57, actions: 20 },
  { date: "Aug 27", checks: 52, actions: 17 },
  { date: "Aug 28", checks: 59, actions: 22 },
  { date: "Aug 29", checks: 56, actions: 19 },
  { date: "Aug 30", checks: 62, actions: 24 },
  { date: "Aug 31", checks: 58, actions: 21 },
  { date: "Sep 1", checks: 64, actions: 23 },
  { date: "Sep 2", checks: 42, actions: 14 },
  { date: "Sep 3", checks: 48, actions: 18 },
  { date: "Sep 4", checks: 45, actions: 17 },
  { date: "Sep 5", checks: 54, actions: 22 },
  { date: "Sep 6", checks: 52, actions: 19 },
  { date: "Sep 7", checks: 61, actions: 25 },
  { date: "Sep 8", checks: 58, actions: 21 },
  { date: "Sep 9", checks: 64, actions: 24 },
  { date: "Sep 10", checks: 60, actions: 20 },
  { date: "Sep 11", checks: 69, actions: 28 },
  { date: "Sep 12", checks: 66, actions: 26 },
  { date: "Sep 13", checks: 72, actions: 23 },
  { date: "Sep 14", checks: 78, actions: 31 },
  { date: "Sep 15", checks: 71, actions: 16 },
] as const;

type Timeframe = "7d" | "14d" | "30d";

const timeframes = [
  { value: "7d", label: "7 days", days: 7 },
  { value: "14d", label: "14 days", days: 14 },
  { value: "30d", label: "30 days", days: 30 },
] as const;

const resources = [
  {
    label: "Managed servers",
    used: 3,
    limit: 5,
    unit: "",
    remaining: "2 servers available",
    icon: ServerIcon,
  },
  {
    label: "Team members",
    used: 8,
    limit: 10,
    unit: "",
    remaining: "2 seats available",
    icon: UsersIcon,
  },
  {
    label: "File storage",
    used: 7.4,
    limit: 25,
    unit: " GB",
    remaining: "17.6 GB available",
    icon: DatabaseIcon,
  },
] as const;

const activityConfig = {
  checks: { label: "Server checks", color: "var(--chart-2)" },
  actions: { label: "AI actions", color: "var(--chart-1)" },
} satisfies ChartConfig;

function BillingDetails() {
  const { profile, ready, storageError } = useOrganization();
  const address = [
    profile.addressLine1,
    profile.addressLine2,
    [profile.city, profile.region, profile.postalCode]
      .filter(Boolean)
      .join(", "),
    profile.country,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <section
      aria-labelledby="billing-details-heading"
      className="space-y-6 pt-8"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 id="billing-details-heading" className="text-base font-semibold">
            Billing details
          </h2>
          <p className="text-sm text-muted-foreground">
            Your organization&apos;s saved billing contact and address.
          </p>
        </div>
        <Button
          variant="outline"
          asChild
          className="min-h-10 [@media(any-pointer:coarse)]:min-h-11"
        >
          <Link href="/dashboard/organization/settings/profile#billing-heading">
            Edit billing details
          </Link>
        </Button>
      </div>
      {!ready ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading billing details...
        </p>
      ) : storageError ? (
        <Alert variant="destructive">
          <AlertDescription>
            Saved billing details could not be loaded. Open the organization
            profile to review them.
          </AlertDescription>
        </Alert>
      ) : (
        <dl className="divide-y divide-border text-sm">
          {[
            ["Legal name", profile.legalName],
            ["Billing email", profile.billingEmail],
            ["Billing address", address],
          ].map(([label, value]) => (
            <div
              key={label}
              className="grid gap-2 py-4 first:pt-0 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-6"
            >
              <dt className="text-muted-foreground">{label}</dt>
              <dd
                className={`min-w-0 whitespace-pre-line break-words ${value ? "" : "text-text-muted"}`}
              >
                {value || "Not provided"}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function OrganizationUsage() {
  const [timeframe, setTimeframe] = useState<Timeframe>("14d");
  const selectedTimeframe = timeframes.find(
    (option) => option.value === timeframe,
  )!;
  const visibleActivity = activity.slice(-selectedTimeframe.days);
  const dateRange = `${visibleActivity[0].date} – ${visibleActivity.at(-1)!.date}`;
  const totals = visibleActivity.reduce(
    (sum, day) => ({
      checks: sum.checks + day.checks,
      actions: sum.actions + day.actions,
    }),
    { checks: 0, actions: 0 },
  );

  return (
    <div className="divide-y divide-border">
      <section aria-labelledby="capacity-heading" className="space-y-6 pb-8">
        <div className="space-y-1">
          <h2 id="capacity-heading" className="text-base font-semibold">
            Usage & limits
          </h2>
          <p className="text-sm text-muted-foreground">
            Resource usage and remaining capacity.
          </p>
        </div>
        <div className="grid divide-y divide-border rounded-xl border border-border bg-card sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {resources.map(
            ({ label, used, limit, unit, remaining, icon: Icon }) => {
              const percent = Math.round((used / limit) * 100);
              return (
                <div key={label} className="min-w-0 space-y-4 p-5">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <h3>{label}</h3>
                  </div>
                  <p className="tabular-nums">
                    <span className="text-2xl font-semibold tracking-tight">
                      {used}
                      {unit}
                    </span>
                    <span className="ml-2 text-sm text-muted-foreground">
                      of {limit}
                      {unit}
                    </span>
                  </p>
                  <Progress
                    value={percent}
                    aria-label={`${label} capacity`}
                    aria-valuetext={`${used} of ${limit}${unit}; ${percent}% used`}
                    className="h-1.5 bg-surface-elevated [&_[data-slot=progress-indicator]]:motion-reduce:transition-none"
                  />
                  <p className="text-xs text-muted-foreground">{remaining}</p>
                </div>
              );
            },
          )}
        </div>
      </section>

      <section aria-labelledby="activity-heading" className="space-y-6 py-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h2 id="activity-heading" className="text-base font-semibold">
              Organization activity
            </h2>
            <p className="text-sm text-muted-foreground">{dateRange}</p>
          </div>
          <ToggleGroup
            type="single"
            value={timeframe}
            onValueChange={(value) => {
              if (value) setTimeframe(value as Timeframe);
            }}
            aria-label="Activity timeframe"
            size="sm"
            spacing={0}
            className="w-fit rounded-lg bg-surface-elevated p-1"
          >
            {timeframes.map((option) => (
              <ToggleGroupItem
                key={option.value}
                value={option.value}
                aria-label={option.label}
                className="h-8 rounded-md px-3 text-xs text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground [@media(any-pointer:coarse)]:min-h-11"
              >
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="rounded-xl border border-border bg-card">
          <dl className="grid grid-cols-2 gap-6 border-b border-border p-5">
            <div>
              <dt className="flex items-center gap-2 text-xs text-muted-foreground">
                <span
                  className="size-2 rounded-sm bg-chart-2"
                  aria-hidden="true"
                />
                Server checks
              </dt>
              <dd className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
                {totals.checks.toLocaleString("en-US")}
              </dd>
            </div>
            <div>
              <dt className="flex items-center gap-2 text-xs text-muted-foreground">
                <span
                  className="size-2 rounded-sm bg-primary"
                  aria-hidden="true"
                />
                AI actions
              </dt>
              <dd className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
                {totals.actions.toLocaleString("en-US")}
              </dd>
            </div>
          </dl>
          <p id="activity-summary" className="sr-only">
            {dateRange}: {totals.checks} server checks and {totals.actions} AI
            actions over {selectedTimeframe.days} days. Daily values are
            available in Show daily activity.
          </p>
          <div className="px-2 pt-5 sm:px-4">
            <ChartContainer
              config={activityConfig}
              className="h-[240px] w-full [&_.recharts-cartesian-grid_line]:opacity-50"
              initialDimension={{ width: 750, height: 240 }}
              role="img"
              aria-label={`Daily server checks and AI actions, ${dateRange}`}
              aria-describedby="activity-summary"
            >
              <AreaChart
                accessibilityLayer
                data={visibleActivity}
                margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={10}
                  minTickGap={38}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  width={42}
                />
                <ChartTooltip
                  cursor={false}
                  content={<ChartTooltipContent indicator="line" />}
                />
                <Area
                  dataKey="checks"
                  type="monotone"
                  fill="var(--color-checks)"
                  fillOpacity={0.06}
                  stroke="var(--color-checks)"
                  strokeWidth={2}
                  isAnimationActive={false}
                />
                <Area
                  dataKey="actions"
                  type="monotone"
                  fill="var(--color-actions)"
                  fillOpacity={0.08}
                  stroke="var(--color-actions)"
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ChartContainer>
          </div>
          <Collapsible className="border-t border-border">
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                className="group h-11 w-full justify-between rounded-t-none px-5 text-xs text-muted-foreground"
              >
                Show daily activity
                <ChevronDownIcon
                  className="size-4 group-data-[state=open]:rotate-180"
                  aria-hidden="true"
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="px-3 pb-3 sm:px-5">
              <Table>
                <TableCaption>Daily activity, {dateRange}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Date</TableHead>
                    <TableHead scope="col" className="text-right">
                      Server checks
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      AI actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleActivity.map((day) => (
                    <TableRow key={day.date}>
                      <TableCell>{day.date}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {day.checks}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {day.actions}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </section>
      <BillingDetails />
    </div>
  );
}
