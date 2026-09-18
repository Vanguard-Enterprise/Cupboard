"use client";

import { useState } from "react";
import {
  ActivityIcon,
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

const limits = [
  { resource: "Servers", percent: 60, value: "3 of 5" },
  { resource: "Members", percent: 80, value: "8 of 10" },
  { resource: "Storage", percent: 30, value: "7.4 of 25 GB" },
] as const;

const activityConfig = {
  checks: { label: "Server checks", color: "var(--chart-2)" },
  actions: { label: "AI actions", color: "var(--chart-1)" },
} satisfies ChartConfig;

const metrics = [
  {
    label: "Managed servers",
    value: "3",
    detail: "2 online",
    icon: ServerIcon,
  },
  {
    label: "Team members",
    value: "8",
    detail: "2 seats available",
    icon: UsersIcon,
  },
  {
    label: "File storage",
    value: "7.4 GB",
    detail: "30% used",
    icon: DatabaseIcon,
  },
] as const;

export function OrganizationUsage() {
  const [timeframe, setTimeframe] = useState<Timeframe>("14d");
  const selectedTimeframe = timeframes.find(
    (option) => option.value === timeframe,
  )!;
  const visibleActivity = activity.slice(-selectedTimeframe.days);

  return (
    <div className="space-y-5">
      <section aria-label="Usage summary" className="grid gap-4 sm:grid-cols-3">
        {metrics.map(({ label, value, detail, icon: Icon }) => (
          <div
            key={label}
            className="flex min-h-[116px] flex-col rounded-xl border border-border bg-card px-5 py-5"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-base font-medium text-muted-foreground">
                {label}
              </p>
              <Icon
                className="size-5 shrink-0 text-text-muted"
                aria-hidden="true"
              />
            </div>
            <div className="mt-auto flex items-baseline gap-2.5 pt-3">
              <p className="font-mono text-4xl font-semibold tracking-tight tabular-nums">
                {value}
              </p>
              <p className="whitespace-nowrap text-xs text-text-muted">
                {detail}
              </p>
            </div>
          </div>
        ))}
      </section>

      <section
        aria-labelledby="activity-heading"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="flex flex-col gap-3 border-b border-border px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <ActivityIcon className="size-5 text-primary" aria-hidden="true" />
            <h2 id="activity-heading" className="text-lg font-semibold">
              Organization activity
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-5 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-[2px] bg-chart-2" />
                Server checks
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-[2px] bg-primary" />
                AI actions
              </span>
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
              className="bg-surface-elevated p-1"
            >
              {timeframes.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  aria-label={option.label}
                  className="h-7 min-w-9 rounded-md px-2.5 text-xs text-text-muted data-[state=on]:bg-primary/15 data-[state=on]:text-primary data-[state=on]:ring-1 data-[state=on]:ring-primary/50"
                >
                  {option.value}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <p id="activity-summary" className="sr-only">
            Server checks and AI actions for the selected{" "}
            {selectedTimeframe.days}
            -day period ending September 15.
          </p>
        </div>
        <div className="px-4 py-4 sm:px-6 sm:py-5">
          <ChartContainer
            config={activityConfig}
            className="h-[360px] w-full text-[13px] [&_.recharts-cartesian-axis-tick_text]:opacity-70 [&_.recharts-cartesian-grid_line]:opacity-50"
            initialDimension={{ width: 1120, height: 360 }}
            role="img"
            aria-label={`Area chart of daily server checks and AI actions for the last ${selectedTimeframe.days} days`}
            aria-describedby="activity-summary"
          >
            <AreaChart
              accessibilityLayer
              data={visibleActivity}
              margin={{ top: 14, right: 18, left: -10, bottom: 8 }}
            >
              <defs>
                <linearGradient id="checks-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="var(--color-checks)"
                    stopOpacity={0.24}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--color-checks)"
                    stopOpacity={0}
                  />
                </linearGradient>
                <linearGradient id="actions-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="var(--color-actions)"
                    stopOpacity={0.32}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--color-actions)"
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
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
                fill="url(#checks-fill)"
                stroke="var(--color-checks)"
                strokeWidth={2}
              />
              <Area
                dataKey="actions"
                type="monotone"
                fill="url(#actions-fill)"
                stroke="var(--color-actions)"
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        </div>
      </section>

      <section
        aria-labelledby="capacity-heading"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="border-b border-border px-6 py-4">
          <h2 id="capacity-heading" className="text-lg font-semibold">
            Plan capacity
          </h2>
        </div>
        <div className="grid gap-5 px-6 py-5">
          {limits.map((limit) => (
            <div key={limit.resource} className="py-0.5">
              <p className="mb-2 text-sm font-medium">{limit.resource}</p>
              <div className="grid grid-cols-[minmax(6rem,1fr)_10.75rem] items-center gap-10">
                <Progress
                  value={limit.percent}
                  aria-label={`${limit.resource} capacity`}
                  aria-valuetext={`${limit.percent}% used`}
                  className="h-2 bg-surface-elevated"
                />
                <p className="text-right font-mono text-sm text-muted-foreground tabular-nums">
                  {limit.value} <span aria-hidden="true">·</span>{" "}
                  {limit.percent}%
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
