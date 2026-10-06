"use client";

import { Skeleton } from "@/components/ui/skeleton";
import Image from "next/image";
import { GlobeIcon, UnplugIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  bytes,
  machineLocation,
  machineStatus,
  observed,
  type Machine,
} from "@/lib/machines";

const flagCountries = new Set(
  "AC AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BQ-BO BQ-SA BQ-SE BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ES-CT ET EU FI FJ FK FM FO FR GA GB GB-ENG GB-NIR GB-SCT GB-WLS GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU IC ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TA TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XA XC XK XO YE YT ZA ZM ZW".split(
    " ",
  ),
);

export function MachineCountry({
  machine,
  now,
}: {
  machine: Machine;
  now: number;
}) {
  const status = machineStatus(machine, now);
  const geo = machine.health?.geolocation;
  const code = geo?.countryCode;
  const valid = code && flagCountries.has(code);
  const country = valid ? machineLocation(machine) : null;
  const border = {
    Connected: "border-primary",
    Stale: "border-destructive",
    "Awaiting report": "border-warning",
    "Not enrolled": "border-muted-foreground",
  }[status];
  const description = {
    Connected: "The agent reported within the last 90 seconds.",
    Stale: "No report for over 90 seconds. The machine may still be running.",
    "Awaiting report":
      "The agent is enrolled but has not sent its first report.",
    "Not enrolled": "Connect an agent to receive health reports.",
  }[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${machine.name}: ${status}, ${country || "Country unavailable"}`}
          className="relative flex size-11 shrink-0 items-center justify-center rounded-lg bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 rounded-lg border-2 ${border} ${machine.enrolled ? "motion-safe:animate-pulse" : ""}`}
          />
          <span className={status === "Stale" ? "scale-90 opacity-50" : ""}>
            {valid ? (
              <Image
                src={`/images/flags/${code}.svg`}
                width={24}
                height={16}
                alt=""
                unoptimized
              />
            ) : (
              <GlobeIcon className="size-4 text-muted-foreground" />
            )}
          </span>
          {status === "Stale" && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-1 flex items-center justify-center rounded-md bg-card/50 backdrop-blur-[3px]"
            >
              <UnplugIcon className="size-4 text-destructive" />
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent className="block space-y-1" sideOffset={6}>
        <p className="font-medium">{status}</p>
        <p>{description}</p>
        {machine.lastSeenAt && <p>Last seen: {observed(machine.lastSeenAt)}</p>}
        <p>
          {country
            ? `${country} · Public IP ${geo?.publicIp}. IP location is approximate.`
            : "Country unavailable. Waiting for a public IP lookup from the agent."}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

export function MachineReadings({
  machine,
  metric,
  now,
}: {
  machine: Machine;
  metric: "cpu" | "memory" | "storage";
  now: number;
}) {
  const health = machine.health;
  const label = { cpu: "CPU", memory: "Memory", storage: "Storage" }[metric];
  let percent: number | null = null;
  let description = "Waiting for an agent report.";
  if (health) {
    if (metric === "cpu") {
      percent = health.cpuUsagePercent ?? null;
      description =
        percent === null
          ? "Update the agent for CPU utilization. Open machine monitoring for the 1-minute load average."
          : `${percent.toFixed(1)}% CPU utilization across ${health.cpuCount} logical CPUs.`;
    } else {
      const total =
        metric === "memory" ? health.memoryTotalBytes : health.diskTotalBytes;
      const available =
        metric === "memory"
          ? health.memoryAvailableBytes
          : health.diskAvailableBytes;
      percent = (100 * (total - available)) / total;
      description = `${bytes(total - available)} used of ${bytes(total)}${metric === "storage" ? " on the root filesystem" : ""}.`;
    }
  }
  const stale = machineStatus(machine, now) === "Stale";
  if (stale || !machine.lastSeenAt || !health)
    return (
      <div
        aria-label={`${machine.name} ${label}: unavailable`}
        className="space-y-2 py-2"
      >
        <span className="sr-only">
          Last seen {observed(machine.lastSeenAt)}
        </span>
        <Skeleton className="h-3 w-12 motion-reduce:animate-none" />
        <Skeleton className="h-1.5 w-full motion-reduce:animate-none" />
      </div>
    );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          aria-label={`${machine.name} ${label}: ${percent === null ? "No reading" : `${percent.toFixed(1)}%`}${stale ? ", stale" : ""}`}
          className="space-y-2 rounded py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex justify-between gap-2 text-xs tabular-nums">
            <span className="text-muted-foreground md:hidden">{label}</span>
            <span className={stale ? "text-muted-foreground" : ""}>
              {percent === null ? "—" : `${percent.toFixed(1)}%`}
            </span>
          </div>
          <div
            role={percent === null ? undefined : "meter"}
            aria-label={`${machine.name} ${label} usage`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={description}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            {percent !== null && (
              <div
                className={`h-full rounded-full ${stale ? "bg-muted-foreground" : "bg-primary"}`}
                style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
              />
            )}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="block space-y-1" sideOffset={6}>
        <p>{description}</p>
        {machine.lastSeenAt && (
          <p>
            {stale ? "Stale report" : "Last report"}:{" "}
            {observed(machine.lastSeenAt)}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
