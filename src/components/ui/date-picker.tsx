"use client";

import * as React from "react";
import { cn } from "cn";
import { CalendarIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const dayLabel = (date: Date) =>
  date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const spokenDay = (date: Date) =>
  date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

/**
 * Phones, tablets, and windows too short for a popover beside the field (a
 * laptop at 400% zoom, a phone on its side) get the calendar in a sheet with
 * its own title instead: a popover there covers the form's other fields and
 * actions or loses its month header off screen. Phones get a bottom sheet;
 * from 640px it is a centered layer over the form.
 */
const SHEET_QUERY = "(max-width: 1023px), (max-height: 480px)";

/** CLDR territories whose week starts on Sunday or Saturday; others Monday. */
const SUNDAY_FIRST = new Set(
  "AG AS BD BR BS BT BW BZ CA CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW".split(
    " ",
  ),
);
const SATURDAY_FIRST = new Set(
  "AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY".split(" "),
);

type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The first day of the week for a locale (0 is Sunday): from the browser's
 * week data where it has it, else from the locale's region, else Monday.
 */
function firstWeekday(locale?: string): Weekday {
  try {
    const tag =
      locale ??
      (typeof navigator !== "undefined" ? navigator.language : undefined) ??
      Intl.DateTimeFormat().resolvedOptions().locale;
    const intl = new Intl.Locale(tag) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = intl.getWeekInfo?.() ?? intl.weekInfo;
    if (info?.firstDay) return (info.firstDay % 7) as Weekday;
    const region = intl.maximize().region;
    if (region && SUNDAY_FIRST.has(region)) return 0;
    if (region && SATURDAY_FIRST.has(region)) return 6;
  } catch {
    // An unreadable locale tag falls through to Monday.
  }
  return 1;
}

function useSheet() {
  return React.useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const query = window.matchMedia(SHEET_QUERY);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.(SHEET_QUERY).matches,
    () => false,
  );
}

/** Focus the chosen day, else today, else the first day that can be picked. */
function focusDay(container: HTMLElement | null) {
  if (!container) return;
  const day =
    container.querySelector<HTMLButtonElement>(
      "td[data-selected] button:not([disabled])",
    ) ??
    container.querySelector<HTMLButtonElement>(
      "td[data-today] button:not([disabled])",
    ) ??
    container.querySelector<HTMLButtonElement>(
      "td:not([data-outside]) button[data-day]:not([disabled])",
    );
  day?.focus();
}

/**
 * A date field that opens Cupboard's calendar, never the browser's native
 * picker. The trigger reads like an input, shows the weekday so date slips
 * are easy to catch, and says the chosen date in its accessible name. The
 * calendar opens on the chosen day with focus there, and months before `min`
 * cannot be reached. Wide screens get a popover; phones and short windows a
 * sheet titled with the field's label.
 */
function DatePicker({
  id,
  value,
  onChange,
  min,
  label,
  placeholder = "Choose a date",
  weekStartsOn,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "value" | "onChange"> & {
  value: Date | null;
  onChange: (date: Date) => void;
  /** Days before this one cannot be picked. */
  min?: Date;
  /**
   * The field's name, used as the sheet title on phones. Defaults to the
   * text of the field's `<label>`.
   */
  label?: string;
  placeholder?: string;
  /** First column of the calendar (0 is Sunday). Defaults to the locale's. */
  weekStartsOn?: Weekday;
}) {
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState(label ?? "");
  const sheet = useSheet();
  const trigger = React.useRef<HTMLButtonElement>(null);
  const spoken = value ? spokenDay(value) : "no date chosen";
  // The accessible name is the field's label plus the chosen date, so a
  // screen reader hears "Start date, Thursday, November 5, 2026". The label
  // is the caller's `<label for>`, read once the field is in the document;
  // the <label> still associates with the field for clicks and queries.
  React.useLayoutEffect(() => {
    const element = trigger.current;
    if (!element) return;
    const name = label ?? element.labels?.[0]?.textContent?.trim();
    if (name) element.setAttribute("aria-label", `${name}, ${spoken}`);
    else element.removeAttribute("aria-label");
  }, [label, spoken]);
  const earliest = React.useMemo(
    () =>
      min
        ? new Date(min.getFullYear(), min.getMonth(), min.getDate())
        : undefined,
    [min],
  );

  const openChange = (next: boolean) => {
    if (next)
      setTitle(
        label ??
          trigger.current?.labels?.[0]?.textContent?.trim() ??
          "Choose a date",
      );
    setOpen(next);
  };

  const calendar = (
    <Calendar
      mode="single"
      required
      selected={value ?? undefined}
      defaultMonth={value ?? earliest}
      startMonth={earliest}
      disabled={earliest ? { before: earliest } : undefined}
      weekStartsOn={weekStartsOn ?? firstWeekday()}
      labels={{
        labelPrevious: () => "Previous month",
        labelNext: () => "Next month",
      }}
      onSelect={(date) => {
        if (!date) return;
        onChange(date);
        setOpen(false);
      }}
      className={
        sheet
          ? // 44px days; 40px under 360px so seven fit beside the sheet's padding.
            "mx-auto bg-transparent p-0 [--cell-size:--spacing(11)] max-[359px]:[--cell-size:--spacing(10)]"
          : "[--cell-size:--spacing(9)] [@media(any-pointer:coarse)]:[--cell-size:--spacing(11)]"
      }
    />
  );

  const button = (
    <Button
      ref={trigger}
      id={id}
      type="button"
      variant="outline"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={sheet ? () => openChange(true) : undefined}
      className={cn(
        "h-10 w-full justify-start gap-2 border-input px-3 font-normal hover:border-input-hover dark:border-input dark:bg-input-background dark:hover:border-input-hover [@media(any-pointer:coarse)]:h-11",
        "aria-invalid:border-destructive",
        className,
      )}
      {...props}
    >
      <CalendarIcon aria-hidden="true" className="text-muted-foreground" />
      {value ? (
        <span className="truncate">{dayLabel(value)}</span>
      ) : (
        <span className="truncate text-text-muted">{placeholder}</span>
      )}
    </Button>
  );

  if (sheet)
    return (
      <>
        {button}
        <Dialog open={open} onOpenChange={openChange}>
          <DialogContent
            scrollable
            aria-describedby={undefined}
            className="sm:max-w-sm"
            data-slot="date-picker-sheet"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              focusDay(event.currentTarget as HTMLElement);
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus();
            }}
          >
            <DialogHeader className="pr-10">
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
            <DialogBody className="pb-2">{calendar}</DialogBody>
          </DialogContent>
        </Dialog>
      </>
    );

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="max-h-(--radix-popover-content-available-height) w-auto max-w-[calc(100vw-1rem)] overflow-y-auto p-1"
        aria-label={title || "Choose a date"}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusDay(event.currentTarget as HTMLElement);
        }}
      >
        {calendar}
      </PopoverContent>
    </Popover>
  );
}

export { DatePicker, firstWeekday };
