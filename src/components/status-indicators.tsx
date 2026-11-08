import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import type { ComponentStatus, OverallStatus } from "@/lib/status-page";
import { cn } from "@/lib/utils";

export type Tone = OverallStatus["tone"];

/**
 * Status text colors. Unknown and maintenance use secondary text so the
 * glyph and label stay above 3:1 on cards in both themes.
 */
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

/**
 * Each state has its own shape, so status survives without color: a check,
 * a triangle, a cross, a wrench, and a dashed circle for "not reported".
 */
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
          ? CircleXIcon
          : tone === "maintenance"
            ? WrenchIcon
            : CircleDashedIcon;
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
        status === "maintenance" && "bg-muted-foreground",
        // Hollow, in secondary text color: reads as "no reading" at 3:1 or better.
        status === "unknown" && "border-[1.5px] border-muted-foreground",
      )}
    />
  );
}
