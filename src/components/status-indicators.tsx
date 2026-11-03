import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import type { ComponentStatus, OverallStatus } from "@/lib/status-page";
import { cn } from "@/lib/utils";

export type Tone = OverallStatus["tone"];

export const toneClass: Record<Tone, string> = {
  operational: "text-primary",
  degraded: "text-warning",
  down: "text-destructive",
  maintenance: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

export const toneTile: Record<Tone, string> = {
  operational: "border-primary/40 bg-primary/10 text-primary",
  degraded: "border-warning/40 bg-warning/10 text-warning",
  down: "border-destructive/40 bg-destructive/10 text-destructive",
  maintenance: "border-border-strong bg-surface-elevated text-foreground",
  unknown: "border-border bg-surface-elevated text-muted-foreground",
};

export function ToneIcon({
  tone,
  className,
}: {
  tone: Tone;
  className?: string;
}) {
  const Icon =
    tone === "operational"
      ? CircleCheckIcon
      : tone === "degraded"
        ? TriangleAlertIcon
        : tone === "down"
          ? CircleAlertIcon
          : tone === "maintenance"
            ? WrenchIcon
            : CircleHelpIcon;
  return <Icon aria-hidden="true" className={className} />;
}

export function StatusDot({ status }: { status: ComponentStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "operational" && "bg-primary",
        status === "degraded" && "bg-warning",
        status === "down" && "bg-destructive",
        status === "maintenance" && "bg-foreground/70",
        status === "unknown" && "bg-border-strong",
      )}
    />
  );
}
