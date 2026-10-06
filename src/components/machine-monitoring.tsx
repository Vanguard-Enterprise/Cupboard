"use client";

import Image from "next/image";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ActivityIcon, ClockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MachineStatCards } from "@/components/machine-stat-cards";
import {
  machineLocation,
  machineStatus,
  observed,
  type Machine,
} from "@/lib/machines";

export function MachineMonitoring({
  machine,
  now,
  organization,
  manage,
  onEdit,
  onEnroll,
}: {
  machine: Machine;
  now: number;
  organization: string;
  manage: boolean;
  onEdit: () => void;
  onEnroll: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const status = machineStatus(machine, now);
  const health = machine.health;
  const old = status === "Stale";
  return (
    <div className="space-y-6">
      {old && (
        <div
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning"
        >
          Machine unreachable. Last seen {observed(machine.lastSeenAt)}.
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{machine.name}</h1>
        <div className="flex flex-wrap items-center gap-4">
          {health && !old && (
            <span
              className="flex items-center gap-2 text-xs text-muted-foreground"
              title="Uptime at the latest report"
            >
              <ClockIcon className="size-3.5" />
              {Math.floor(health.uptimeSeconds / 86400)}d{" "}
              {Math.floor((health.uptimeSeconds % 86400) / 3600)}h{" "}
              {Math.floor((health.uptimeSeconds % 3600) / 60)}m uptime
            </span>
          )}
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => setDetailsOpen(true)}
          >
            Machine details
          </Button>
        </div>
      </div>
      {health && !old && (
        <MachineStatCards
          organization={organization}
          key={`${machine.id}:${machine.enrolledAt}`}
          machine={machine}
        />
      )}
      {health && old && (
        <div className="grid gap-4 md:grid-cols-2">
          {["CPU", "Network", "Memory", "Storage"].map((label) => (
            <section
              key={label}
              aria-label={label}
              className="space-y-5 rounded-lg border bg-card p-5"
            >
              <h2 className="text-sm text-muted-foreground">{label}</h2>
              <Skeleton className="h-7 w-24 motion-reduce:animate-none" />
              <Skeleton className="h-36 w-full motion-reduce:animate-none" />
              <span className="sr-only">
                Unavailable. Last seen {observed(machine.lastSeenAt)}
              </span>
            </section>
          ))}
        </div>
      )}
      <div className="grid items-start gap-5">
        <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Machine details</DialogTitle>
              <DialogDescription>{machine.name}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <p className="break-all font-mono text-xs text-muted-foreground">
                {machine.address}
              </p>
              <Badge
                variant="outline"
                className={
                  status === "Connected"
                    ? "border-primary/30 text-primary"
                    : old
                      ? "border-warning/30 text-warning"
                      : "text-muted-foreground"
                }
              >
                {status}
              </Badge>
            </div>
            <dl className="grid grid-cols-2 gap-4 text-sm ">
              {[
                ["Provider", machine.provider || "Not set"],
                ["Location", machineLocation(machine) || "Unknown"],
                ...(health
                  ? [
                      ["Hostname", health.hostname],
                      ["Operating system", health.os],
                      ["Agent version", health.agentVersion],
                    ]
                  : []),
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 flex items-center gap-2 break-words">
                    {label === "Location" &&
                      health?.geolocation &&
                      machineLocation(machine) && (
                        <Image
                          src={`/images/flags/${health.geolocation.countryCode}.svg`}
                          width={20}
                          height={14}
                          alt=""
                          unoptimized
                        />
                      )}
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            {machine.notes && (
              <div className="border-t pt-4">
                <h3 className="text-xs text-muted-foreground">Notes</h3>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                  {machine.notes}
                </p>
              </div>
            )}
            {manage && (
              <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    setDetailsOpen(false);
                    onEdit();
                  }}
                >
                  Edit machine
                </Button>
                <Button
                  variant={machine.enrolled ? "ghost" : "default"}
                  className="min-h-11"
                  onClick={() => {
                    setDetailsOpen(false);
                    onEnroll();
                  }}
                >
                  {machine.enrolled ? "Replace agent" : "Enroll agent"}
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
        {!health && (
          <div className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center">
            <ActivityIcon className="mb-4 size-7 text-muted-foreground" />
            <h2 className="text-base font-semibold">
              {machine.enrolled
                ? "Waiting for the first report"
                : "Connect this machine"}
            </h2>
            <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
              {machine.enrolled
                ? "The agent is enrolled. Run it on the machine to start reporting CPU load, memory, disk, and uptime."
                : "Enroll the Linux agent to see CPU load, memory, disk, and uptime here."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
