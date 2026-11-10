import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import type { OverallStatus } from "@/lib/status-page";

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
