import {
  BotIcon,
  DatabaseIcon,
  InfoIcon,
  ServerIcon,
  UsersIcon,
} from "lucide-react";

const summary = [
  {
    label: "Managed servers",
    value: "3",
    detail: "2 online",
    icon: ServerIcon,
  },
  {
    label: "Team members",
    value: "8",
    detail: "2 seats open",
    icon: UsersIcon,
  },
  {
    label: "File storage",
    value: "7.4 GB",
    detail: "of 25 GB",
    icon: DatabaseIcon,
  },
] as const;

const meters = [
  { label: "Game servers", value: "3 of 5", percent: 60 },
  { label: "Team members", value: "8 of 10", percent: 80 },
  { label: "File storage", value: "7.4 GB of 25 GB", percent: 30 },
  { label: "AI actions", value: "284 of 500", percent: 57 },
] as const;

export function OrganizationUsage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">Current period</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A snapshot of organization usage over the last 30 days.
          </p>
        </div>
        <span className="inline-flex w-fit items-center rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
          Preview data
        </span>
      </div>

      <div className="grid overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-3">
        {summary.map(({ label, value, detail, icon: Icon }, index) => (
          <div
            key={label}
            className={`p-5 sm:p-6 ${index > 0 ? "border-t border-border sm:border-t-0 sm:border-l" : ""}`}
          >
            <div className="mb-5 flex size-9 items-center justify-center rounded-lg bg-surface-elevated text-muted-foreground">
              <Icon className="size-4" aria-hidden="true" />
            </div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <div className="mt-1 flex items-baseline gap-2">
              <p className="text-2xl font-semibold tracking-tight">{value}</p>
              <p className="text-xs text-text-muted">{detail}</p>
            </div>
          </div>
        ))}
      </div>

      <section
        aria-labelledby="plan-usage-heading"
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="border-b border-border px-6 py-5 sm:px-7">
          <div className="flex items-center gap-2">
            <BotIcon className="size-4 text-primary" aria-hidden="true" />
            <h2 id="plan-usage-heading" className="text-base font-semibold">
              Plan usage
            </h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Usage resets at the start of each 30-day period.
          </p>
        </div>
        <div className="divide-y divide-border px-6 sm:px-7">
          {meters.map(({ label, value, percent }) => (
            <div key={label} className="py-5">
              <div className="mb-2.5 flex items-center justify-between gap-4 text-sm">
                <span className="font-medium">{label}</span>
                <span className="text-muted-foreground">{value}</span>
              </div>
              <div
                role="progressbar"
                aria-label={`${label} usage`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-1.5 overflow-hidden rounded-full bg-surface-elevated"
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="flex gap-3 rounded-xl border border-border bg-card px-5 py-4 text-sm sm:px-6">
        <InfoIcon
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div>
          <p className="font-medium">Live metering is not connected</p>
          <p className="mt-1 leading-5 text-muted-foreground">
            These sample values preview the usage page. They do not affect your
            organization or enforce plan limits.
          </p>
        </div>
      </div>
    </div>
  );
}
