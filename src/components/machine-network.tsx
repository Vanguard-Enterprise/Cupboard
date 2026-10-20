"use client";

import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/api-client";
import {
  machineStatus,
  observed,
  type Machine,
  type MachineHistory,
} from "@/lib/machines";

function rate(value: number | null | undefined) {
  if (value == null) return "—";
  const unit = value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B/s", "KiB/s", "MiB/s"][unit]}`;
}

export function MachineNetwork({
  machine,
  now,
  organization,
}: {
  machine: Machine;
  now: number;
  organization: string;
}) {
  const [history, setHistory] = useState<MachineHistory | null>(null);
  const [failed, setFailed] = useState(false);
  const connected = machineStatus(machine, now) === "Connected";
  const hasHealth = !!machine.health;
  useEffect(() => {
    if (!connected || !hasHealth) return;
    let active = true;
    async function load() {
      try {
        const result = await apiRequest<MachineHistory>(
          `machines/${machine.id}/history`,
          undefined,
          organization,
        );
        if (
          !Array.isArray(result.samples) ||
          !Number.isFinite(result.windowEnd)
        )
          throw Error("Invalid history");
        if (active) {
          setHistory(result);
          setFailed(false);
        }
      } catch {
        if (active) setFailed(true);
      }
    }
    void load();
    const interval = setInterval(() => void load(), 30000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [machine.id, machine.enrolledAt, connected, hasHealth, organization]);

  if (machineStatus(machine, now) !== "Connected" || !machine.health)
    return (
      <div
        aria-label={`${machine.name} Network: unavailable`}
        className="space-y-2 py-2"
      >
        <span className="sr-only">
          Last seen {observed(machine.lastSeenAt)}
        </span>
        <Skeleton className="h-3 w-20 motion-reduce:animate-none" />
        <Skeleton className="h-8 w-full motion-reduce:animate-none" />
      </div>
    );

  const end = history?.windowEnd ?? now;
  const samples = (history?.samples ?? []).filter(
    (sample) => sample.at >= end - 300000 && sample.at <= end,
  );
  const span = Math.min(300000, Math.max(60000, end - (samples[0]?.at ?? end)));
  const start = end - span;
  const max = Math.max(
    1,
    ...samples.flatMap((s) => [
      s.networkReceiveBytesPerSecond ?? 0,
      s.networkSendBytesPerSecond ?? 0,
    ]),
  );
  const series = (
    key: "networkReceiveBytesPerSecond" | "networkSendBytesPerSecond",
  ) => {
    let previous: number | null = null;
    return samples
      .map((sample) => {
        const value = sample[key];
        if (value == null) {
          previous = null;
          return "";
        }
        const command =
          previous == null || sample.at - previous > 90000 ? "M" : "L";
        previous = sample.at;
        return `${command}${Math.max(0, Math.min(180, (180 * (sample.at - start)) / span))},${30 - (28 * value) / max}${command === "M" ? "l0,0" : ""}`;
      })
      .join(" ");
  };
  const receive = rate(machine.health?.networkReceiveBytesPerSecond);
  const send = rate(machine.health?.networkSendBytesPerSecond);
  const hasSamples = samples.some(
    (s) =>
      s.networkReceiveBytesPerSecond != null ||
      s.networkSendBytesPerSecond != null,
  );
  return (
    <div
      className="space-y-1 py-1"
      title={`Combined network traffic across non-loopback interfaces · Last ${Math.ceil(span / 60000)} minutes`}
    >
      <div className="flex flex-wrap gap-x-3 text-[10px] tabular-nums">
        <span className="text-primary">↓ In {receive}</span>
        <span className="text-chart-2">↑ Out {send}</span>
      </div>
      {hasSamples && !failed ? (
        <svg
          viewBox="0 0 180 32"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${machine.name} network over the last ${Math.ceil(span / 60000)} minutes. In ${receive}, out ${send}.`}
          className="h-8 w-full"
        >
          <path
            d={series("networkReceiveBytesPerSecond")}
            fill="none"
            stroke="var(--primary)"
            strokeWidth="1.5"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={series("networkSendBytesPerSecond")}
            fill="none"
            stroke="var(--chart-2)"
            strokeWidth="1.5"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : (
        <div className="flex h-8 items-center text-[10px] text-muted-foreground">
          {failed ? "History unavailable" : "Waiting for network history"}
        </div>
      )}
    </div>
  );
}
