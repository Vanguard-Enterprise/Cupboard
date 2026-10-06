"use client";

import { useEffect, useState } from "react";
import { Area, AreaChart, XAxis, YAxis, Tooltip } from "recharts";
import { ChartContainer } from "@/components/ui/chart";
import { apiRequest } from "@/lib/api-client";
import {
  bytes,
  observed,
  type Machine,
  type MachineHistory,
} from "@/lib/machines";

const timeLabel = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function MachineStatCards({ machine }: { machine: Machine }) {
  const [history, setHistory] = useState<MachineHistory | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const result = await apiRequest<MachineHistory>(
          `machines/${machine.id}/history`,
        );
        if (
          !Array.isArray(result.samples) ||
          !Number.isFinite(result.windowEnd)
        )
          throw Error("Invalid history");
        if (active) {
          setHistory(result);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    }
    void load();
    const poll = setInterval(() => void load(), 30000);
    return () => {
      active = false;
      clearInterval(poll);
    };
  }, [machine.id, machine.enrolledAt]);
  const health = machine.health!;
  const end = history?.windowEnd ?? machine.lastSeenAt ?? 0;
  const start = end - 3600000;

  const data: {
    at: number;
    cpu: number | null;
    receive: number | null;
    send: number | null;
  }[] = [];
  for (const sample of history?.samples ?? []) {
    const previous = data.at(-1);
    if (previous && sample.at - previous.at > 90000)
      data.push({ at: previous.at + 1, cpu: null, receive: null, send: null });
    data.push({
      at: sample.at,
      cpu: sample.cpu,
      receive: sample.networkReceiveBytesPerSecond ?? null,
      send: sample.networkSendBytesPerSecond ?? null,
    });
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Last hour</span>
        {error && (
          <span role="status">
            History unavailable. Retrying automatically.
          </span>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {(["cpu", "network"] as const).map((metric) => {
          const network = metric === "network";
          const available = data.some((point) =>
            network
              ? point.receive != null || point.send != null
              : point.cpu != null,
          );
          return (
            <section
              key={metric}
              aria-label={network ? "Network" : "CPU"}
              className="min-w-0 overflow-hidden rounded-lg border bg-card"
            >
              <div className="space-y-2 px-5 pt-5">
                <h2 className="text-sm text-muted-foreground">
                  {network ? "Network" : "CPU"}
                </h2>
                {network ? (
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <div>
                      <p className="text-xl font-semibold tabular-nums">
                        {rate(health.networkReceiveBytesPerSecond)}
                      </p>
                      <p className="text-xs text-primary">Receive</p>
                    </div>
                    <div>
                      <p className="text-xl font-semibold tabular-nums">
                        {rate(health.networkSendBytesPerSecond)}
                      </p>
                      <p className="text-xs text-chart-2">Send</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-2xl font-semibold tabular-nums">
                      {health.cpuUsagePercent == null
                        ? "—"
                        : health.cpuUsagePercent.toFixed(1) + "%"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {health.cpuCount} logical CPUs
                    </p>
                  </>
                )}
              </div>
              {available ? (
                <div>
                  <ChartContainer
                    className="mt-4 h-40 w-full aspect-auto"
                    config={{
                      cpu: { label: "CPU", color: "var(--primary)" },
                      receive: { label: "Receive", color: "var(--primary)" },
                      send: { label: "Send", color: "var(--chart-2)" },
                    }}
                  >
                    <AreaChart
                      accessibilityLayer
                      data={data}
                      margin={{ top: 8, right: 16, bottom: 0, left: 16 }}
                    >
                      <XAxis
                        dataKey="at"
                        type="number"
                        domain={[start, end]}
                        hide
                      />
                      <YAxis hide domain={network ? [0, "auto"] : [0, 100]} />
                      <Tooltip
                        content={({ active, payload }) => {
                          const point = payload?.[0]?.payload as
                            (typeof data)[number] | undefined;
                          if (!active || !point) return null;
                          return (
                            <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
                              <p>{observed(point.at)}</p>
                              {network ? (
                                <>
                                  <p>Receive: {rate(point.receive)}</p>
                                  <p>Send: {rate(point.send)}</p>
                                </>
                              ) : (
                                <p>
                                  CPU:{" "}
                                  {point.cpu == null
                                    ? "No reading"
                                    : point.cpu.toFixed(1) + "%"}
                                </p>
                              )}
                            </div>
                          );
                        }}
                      />
                      {(network ? ["receive", "send"] : ["cpu"]).map((key) => (
                        <Area
                          key={key}
                          type="linear"
                          dataKey={key}
                          stroke={
                            key === "send" ? "var(--chart-2)" : "var(--primary)"
                          }
                          fill={
                            key === "send" ? "var(--chart-2)" : "var(--primary)"
                          }
                          fillOpacity={0.08}
                          strokeWidth={1.5}
                          isAnimationActive={false}
                          connectNulls={false}
                          dot={data.length === 1 ? { r: 3 } : false}
                        />
                      ))}
                    </AreaChart>
                  </ChartContainer>
                  <div className="flex justify-between px-4 pb-4 text-[10px] tabular-nums text-muted-foreground">
                    <span>{timeLabel(start)}</span>
                    <span>{timeLabel(end)}</span>
                  </div>
                </div>
              ) : (
                <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
                  {error
                    ? "Chart unavailable"
                    : history
                      ? "Waiting for history"
                      : "Loading history..."}
                </div>
              )}
            </section>
          );
        })}
        <Capacity
          label="Memory"
          total={health.memoryTotalBytes}
          available={health.memoryAvailableBytes}
        />
        <Capacity
          label="Storage"
          total={health.diskTotalBytes}
          available={health.diskAvailableBytes}
        />
      </div>
    </div>
  );
}

function rate(value: number | null | undefined) {
  if (value == null) return "—";
  const index =
    value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${["B/s", "KiB/s", "MiB/s", "GiB/s"][index]}`;
}

function Capacity({
  label,
  total,
  available,
}: {
  label: string;
  total: number;
  available: number;
}) {
  const used = total - available;
  const percent = total > 0 ? (100 * used) / total : 0;
  return (
    <section aria-label={label} className="rounded-lg border bg-card p-5">
      <h2 className="text-sm text-muted-foreground">{label}</h2>
      <div className="mt-4 flex flex-wrap items-center gap-6">
        <div
          role="meter"
          aria-label={label + " used"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${bytes(used)} of ${bytes(total)} used`}
          className="relative size-32 shrink-0"
        >
          <svg
            viewBox="0 0 120 120"
            className="size-full -rotate-90"
            aria-hidden="true"
          >
            <circle
              cx="60"
              cy="60"
              r="50"
              fill="none"
              stroke="var(--muted)"
              strokeWidth="9"
            />
            <circle
              cx="60"
              cy="60"
              r="50"
              fill="none"
              stroke="var(--primary)"
              strokeWidth="9"
              pathLength="100"
              strokeDasharray={`${percent} ${100 - percent}`}
              strokeLinecap={percent > 0 && percent < 100 ? "round" : "butt"}
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-xl font-semibold tabular-nums">
            {percent.toFixed(0)}%
          </span>
        </div>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Used</dt>
            <dd className="text-xl font-semibold tabular-nums">
              {bytes(used)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Available</dt>
            <dd className="tabular-nums">
              {bytes(available)}{" "}
              <span className="text-muted-foreground">/ {bytes(total)}</span>
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
