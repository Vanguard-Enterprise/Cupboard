import {
  CalendarIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  InfoIcon,
  MegaphoneIcon,
  SparklesIcon,
  TriangleAlertIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import type {
  AnnouncementIcon,
  AnnouncementTone,
  OverallStatus,
} from "@/lib/status-page";
import { cn } from "@/lib/utils";

export type Tone = OverallStatus["tone"];

/**
 * Public status pages: lines players act on (times, plans, reading ages,
 * labels) are 13 pixels.
 */
export const metaSize = "text-[0.8125rem] leading-5";
export const metaText = `${metaSize} text-muted-foreground`;
/**
 * Focus never follows the brand accent: a near-white or near-black accent
 * would hide it. The page's own text color always contrasts with its
 * background, in both themes.
 */
export const statusFocus =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-foreground";

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

/** The announcement glyphs an operator can choose, with their names. */
export const announcementIconOptions: Record<
  AnnouncementIcon,
  { label: string; Icon: LucideIcon }
> = {
  megaphone: { label: "Megaphone", Icon: MegaphoneIcon },
  info: { label: "Information", Icon: InfoIcon },
  alert: { label: "Warning", Icon: TriangleAlertIcon },
  wrench: { label: "Maintenance", Icon: WrenchIcon },
  calendar: { label: "Event", Icon: CalendarIcon },
  sparkles: { label: "News", Icon: SparklesIcon },
};

/** Announcement colors: semantic tokens, readable on both status themes. */
export const announcementToneOptions: Record<
  AnnouncementTone,
  { label: string; text: string; fill: string; panel: string }
> = {
  neutral: {
    label: "Neutral",
    text: "text-muted-foreground",
    fill: "bg-muted-foreground",
    panel: "",
  },
  info: {
    label: "Blue",
    text: "text-info",
    fill: "bg-info",
    panel: "border-info/40 bg-info/10",
  },
  success: {
    label: "Green",
    text: "text-success",
    fill: "bg-success",
    panel: "border-success/40 bg-success/10",
  },
  warning: {
    label: "Amber",
    text: "text-warning",
    fill: "bg-warning",
    panel: "border-warning/40 bg-warning/10",
  },
  danger: {
    label: "Red",
    text: "text-destructive",
    fill: "bg-destructive",
    panel: "border-destructive/40 bg-destructive/10",
  },
};

export function AnnouncementGlyph({
  icon,
  tone,
  className,
}: {
  icon: AnnouncementIcon;
  tone: AnnouncementTone;
  className?: string;
}) {
  const { Icon } =
    announcementIconOptions[icon] ?? announcementIconOptions.megaphone;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        (announcementToneOptions[tone] ?? announcementToneOptions.neutral).text,
        className,
      )}
    />
  );
}
