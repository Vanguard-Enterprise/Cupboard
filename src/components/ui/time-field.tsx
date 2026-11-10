"use client";

import * as React from "react";
import { cn } from "cn";
import { CircleAlertIcon, ClockIcon, InfoIcon } from "lucide-react";
import { InputFrame, InputFrameControl } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const DAY = 24 * 60;
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Whether the visitor's locale writes times on a 12-hour clock ("7:00 PM") or
 * a 24-hour clock ("19:00"). en-US is 12-hour; most of Europe is 24-hour.
 */
export function uses12HourClock(locale?: string) {
  const options = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
  }).resolvedOptions();
  if (options.hourCycle)
    return options.hourCycle === "h11" || options.hourCycle === "h12";
  return options.hour12 ?? false;
}

/**
 * Minutes after midnight in the locale's clock: "7:05 PM" on a 12-hour clock,
 * "19:05" on a 24-hour clock. Pass `hour12` to force one.
 */
export function formatTime(minutes: number, hour12 = uses12HourClock()) {
  const value = ((minutes % DAY) + DAY) % DAY;
  const hours = Math.floor(value / 60);
  const rest = pad(value % 60);
  if (!hour12) return `${pad(hours)}:${rest}`;
  return `${hours % 12 || 12}:${rest} ${hours < 12 ? "AM" : "PM"}`;
}

/** An example in the locale's clock for hints and errors: "7:00 PM" or "19:00". */
export const timeExample = (hour12 = uses12HourClock()) =>
  formatTime(19 * 60, hour12);

/**
 * Splits a trailing zone label off typed text: "1:30 AM EST" is "1:30 AM"
 * and "EST", "01:30 GMT+1" is "01:30" and "GMT+1". "7 pm" keeps its "pm".
 */
function splitZone(text: string): { time: string; zone: string } {
  const match =
    /^(.*\d(?:\s*[ap]\.?\s*m?\.?)?)\s+([a-z]{2,5}(?:[+\-\u2212]\d{1,2}(?::?\d{2})?)?|[+\-\u2212]\d{1,2}(?::?\d{2})?)$/i.exec(
      text.trim(),
    );
  if (!match || /^(?:[ap]\.?m?\.?)$/i.test(match[2]))
    return { time: text, zone: "" };
  return { time: match[1], zone: match[2] };
}

/**
 * Reads the ways people type a time: "19:00", "1900", "19", "7pm", "7:30 PM",
 * "7.30", "7:30 p.m.", and a zone label after it ("1:30 AM EST", which picks
 * one of the two 1:30s when clocks go back; see `timeOn`). Returns minutes
 * after midnight, or null when it is not a time.
 */
export function parseTime(text: string): number | null {
  const value = splitZone(text)
    .time.trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/\./g, (dot, at, all: string) =>
      // "7.30" is a separator; "p.m." is punctuation.
      /\d/.test(all[at - 1] ?? "") && /\d/.test(all[at + 1] ?? "") ? ":" : "",
    );
  const match = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/.exec(value);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.[0];
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hours > 23) return null;
  return hours * 60 + minutes;
}

export type LocalTime =
  | { kind: "exact"; at: number }
  /** The wall-clock time never happens: clocks jump over it. */
  | { kind: "skipped"; at: number; gapStart: number; gapEnd: number }
  /** The wall-clock time happens twice: clocks go back over it. */
  | { kind: "repeated"; at: number; later: number };

const minutesOf = (at: number) => {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
};

/**
 * Turns a calendar day and a wall-clock time into an instant in the
 * visitor's time zone and says when daylight saving makes that ambiguous.
 * `at` is what `new Date(y, m, d, 0, minutes)` gives: for a skipped time the
 * clock's later reading, for a repeated time the first occurrence.
 */
export function resolveLocalTime(date: Date, minutes: number): LocalTime {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  const at = new Date(y, m, d, 0, minutes).getTime();
  const landed = new Date(at);
  if (landed.getDate() !== d || minutesOf(at) !== minutes) {
    // Find the instant the clock jumped by bisecting the day.
    let lo = new Date(y, m, d).getTime();
    let hi = at;
    const before = new Date(lo).getTimezoneOffset();
    while (hi - lo > 60_000) {
      const mid = Math.floor((lo + hi) / 2);
      if (new Date(mid).getTimezoneOffset() === before) lo = mid;
      else hi = mid;
    }
    const gapEnd = minutesOf(hi);
    const shift = before - new Date(hi).getTimezoneOffset();
    return { kind: "skipped", at, gapStart: gapEnd - shift, gapEnd };
  }
  for (const hours of [-3, 3]) {
    const other = new Date(at + hours * 3_600_000).getTimezoneOffset();
    const shift = (other - landed.getTimezoneOffset()) * 60_000;
    if (shift === 0) continue;
    const twin = at + shift;
    const t = new Date(twin);
    if (twin !== at && t.getDate() === d && minutesOf(twin) === minutes)
      return {
        kind: "repeated",
        at: Math.min(at, twin),
        later: Math.max(at, twin),
      };
  }
  return { kind: "exact", at };
}

const zoneName = (at: number, style: "short" | "shortOffset") =>
  new Intl.DateTimeFormat(undefined, { timeZoneName: style })
    .formatToParts(at)
    .find((part) => part.type === "timeZoneName")?.value ?? "";
const zoneAt = (at: number) => zoneName(at, "short");

/**
 * The labels that tell the two readings of a repeated time apart: the zone's
 * short names ("EDT", "EST"), or its offsets ("GMT-4", "GMT-5") where the
 * locale gives both readings the same name.
 */
function occurrenceLabels(first: number, second: number): [string, string] {
  const named: [string, string] = [zoneAt(first), zoneAt(second)];
  if (named[0] && named[0] !== named[1]) return named;
  return [zoneName(first, "shortOffset"), zoneName(second, "shortOffset")];
}

const sameZone = (typed: string, at: number) => {
  const want = typed.replace("\u2212", "-").toLowerCase();
  return [zoneAt(at), zoneName(at, "shortOffset")].some(
    (name) => name.replace("\u2212", "-").toLowerCase() === want,
  );
};

/**
 * How typed text reads on a day: the instant, which of a repeated time's two
 * readings it names, and the zone label to show.
 */
function readTime(date: Date, text: string) {
  const minutes = parseTime(text);
  if (minutes === null) return null;
  const typed = splitZone(text).zone;
  const local = resolveLocalTime(date, minutes);
  if (local.kind !== "repeated")
    return {
      minutes,
      local,
      at: local.at,
      second: false,
      // A label naming the zone the time is in anyway is harmless.
      zoneFits: !typed || sameZone(typed, local.at),
      labels: null,
    };
  const labels = occurrenceLabels(local.at, local.later);
  const second = !!typed && sameZone(typed, local.later);
  return {
    minutes,
    local,
    at: second ? local.later : local.at,
    second,
    zoneFits: !typed || second || sameZone(typed, local.at),
    labels,
  };
}

/**
 * The instant typed text names on a day, or null when the text names no
 * instant there. Invalid means no value: null exactly when the text is empty
 * or `describeTime` reports an error for it (not a time, a time the clocks
 * skip, or a zone label the time can't have that day, such as "7:00 PM EST"
 * in June), never a nearby instant. A zone label after a repeated time
 * ("1:30 AM EST") picks the second reading. Use it, not `parseTime` and
 * `resolveLocalTime`, wherever a TimeField's value becomes an instant, and
 * `describeTime` for the message to show when it is null (codex D-39).
 */
export function timeOn(date: Date, text: string): number | null {
  const read = readTime(date, text);
  if (!read || !read.zoneFits || read.local.kind === "skipped") return null;
  return read.at;
}

/**
 * An instant as TimeField text, in the visitor's zone: "1:30 AM", or
 * "1:30 AM EST" for the second reading of a time that happens twice that day,
 * so loading a saved time and reading it back with `timeOn` gives the same
 * instant.
 */
export function timeTextAt(at: number, hour12 = uses12HourClock()) {
  const d = new Date(at);
  const minutes = d.getHours() * 60 + d.getMinutes();
  const text = formatTime(minutes, hour12);
  const local = resolveLocalTime(d, minutes);
  if (local.kind !== "repeated" || Math.abs(at - local.later) >= 60_000)
    return text;
  return `${text} ${occurrenceLabels(local.at, local.later)[1]}`;
}

export type TimeChoice = {
  /** What the choice shows: "1:30 AM EDT". */
  label: string;
  /** The field text that picks it. */
  text: string;
  selected: boolean;
};

export type TimeIssue = {
  /** The id to render the message with; the field already points at it. */
  id: string;
  /** `error` blocks the time; `note` explains how it is read. */
  tone: "error" | "note";
  /**
   * `format` when the text is not a time, `skipped` or `repeated` for
   * daylight saving, `zone` for a zone label the time can't have that day.
   */
  kind: "format" | "skipped" | "repeated" | "zone";
  message: string;
  /** For a time that happens twice: its two readings, in order. */
  choices?: TimeChoice[];
  /** Picks a choice; the field sets it on the issues it reports. */
  choose?: (text: string) => void;
};

const dayLabel = (date: Date) =>
  date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

/**
 * What is wrong with, or worth knowing about, a typed time on a given day.
 * Returns null for an empty field or a plain, unambiguous time.
 */
export function describeTime(
  value: string,
  date: Date | null | undefined,
  hour12 = uses12HourClock(),
): Omit<TimeIssue, "id"> | null {
  if (!value.trim()) return null;
  const minutes = parseTime(value);
  if (minutes === null)
    return {
      tone: "error",
      kind: "format",
      message: `Enter a time such as ${timeExample(hour12)}.`,
    };
  if (!date) return null;
  const read = readTime(date, value)!;
  const { local } = read;
  const time = formatTime(minutes, hour12);
  if (local.kind === "skipped")
    return {
      tone: "error",
      kind: "skipped",
      message: `Clocks skip ${formatTime(local.gapStart, hour12)} to ${formatTime(local.gapEnd, hour12)} on ${dayLabel(date)}. Choose another time.`,
    };
  const typed = splitZone(value).zone;
  if (local.kind === "repeated") {
    const [first, second] = read.labels!;
    const choices: TimeChoice[] = [
      {
        label: `${time} ${first}`,
        text: `${time} ${first}`,
        selected: read.zoneFits && !read.second,
      },
      {
        label: `${time} ${second}`,
        text: `${time} ${second}`,
        selected: read.second,
      },
    ];
    const twice = `${time} happens twice on ${dayLabel(date)} as clocks go back.`;
    // The choice sits right under the message and Tab or Enter goes to it
    // (a11y D-74, D-79), so the message only says why there is one.
    if (!read.zoneFits)
      return {
        tone: "error",
        kind: "zone",
        message: `${twice} ${typed} is neither, so choose one.`,
        choices,
      };
    return { tone: "note", kind: "repeated", message: twice, choices };
  }
  if (!read.zoneFits)
    return {
      tone: "error",
      kind: "zone",
      message: `${time} on ${dayLabel(date)} is ${zoneAt(local.at)}, not ${typed}. Remove ${typed}.`,
    };
  return null;
}

const TABBABLE =
  'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';

/**
 * Moves focus to the control before or after `from` in Tab order, within its
 * dialog (or the page), once the current render has settled. Focus stays on
 * `from` if there is none, or wherever it went in the meantime.
 */
function tabFrom(from: HTMLElement, direction: 1 | -1) {
  window.requestAnimationFrame(() => {
    // Focus moved on its own meanwhile, such as a second, repeated Tab.
    if (document.activeElement !== from) return;
    const scope =
      from.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ??
      document.body;
    const order = [...scope.querySelectorAll<HTMLElement>(TABBABLE)].filter(
      (element) =>
        element === from ||
        (element.tabIndex >= 0 &&
          !element.matches(":disabled") &&
          !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
          (element.checkVisibility?.() ?? true)),
    );
    const at = order.indexOf(from);
    order[at + direction]?.focus();
  });
}

const arrowKeys = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
];

function TimeFieldMessage({ issue }: { issue: TimeIssue }) {
  const Icon = issue.tone === "error" ? CircleAlertIcon : InfoIcon;
  const { choices, choose } = issue;
  const selected = choices?.find((choice) => choice.selected)?.text ?? "";
  // Arrow keys pick as they move, like a radio group.
  const arrowed = React.useRef(false);
  return (
    <div data-slot="time-field-message" className="space-y-2">
      <p
        id={issue.id}
        className={cn(
          "flex items-start gap-1.5 text-xs leading-5",
          issue.tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <Icon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <span>{issue.message}</span>
      </p>
      {choices && choose && (
        <ToggleGroup
          type="single"
          variant="segmented"
          data-slot="time-field-occurrence"
          aria-label={`Which ${choices[0].label.replace(/\s+\S+$/, "")}`}
          value={selected}
          onValueChange={(text) => text && choose(text)}
          onKeyDown={(event) => {
            arrowed.current = arrowKeys.includes(event.key);
          }}
          onFocus={(event) => {
            if (!arrowed.current) return;
            arrowed.current = false;
            const text = (event.target as HTMLElement).dataset.value;
            if (text) choose(text);
          }}
          className="grid grid-cols-2"
        >
          {choices.map((choice) => (
            <ToggleGroupItem
              size="sm"
              key={choice.text}
              value={choice.text}
              data-value={choice.text}
              className="tabular-nums"
            >
              {choice.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
    </div>
  );
}

/**
 * A time field typed as text in the locale's clock (12-hour in en-US): no
 * native time picker. It accepts "7pm", "1930", and "19:00"; Arrow Up and
 * Arrow Down move it by `step` minutes and skip times that daylight saving
 * removes. It checks the text on Tab, Enter, or leaving the field: an
 * unreadable time or one that doesn't happen on `date` is an error, and a
 * time that happens twice gets a note. The message shows under the field, or the parent shows
 * it where it has room by handling `onIssueChange` (render it with the
 * issue's `id`; the field already points at it). Focus has usually moved on
 * by the time a message appears, so the field also says it in its own polite
 * live region. It says each arrow-key time too, unless `announceSteps` is
 * false because the form already announces a summary that includes it.
 */
function TimeField({
  id,
  value,
  onChange,
  step = 15,
  date,
  hour12: hour12Prop,
  onIssueChange,
  announceSteps = true,
  className,
  onBlur,
  onKeyDown,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  ...props
}: Omit<React.ComponentProps<"input">, "value" | "onChange"> & {
  /** The time as the field shows it, or whatever the operator is typing. */
  value: string;
  onChange: (value: string) => void;
  step?: number;
  /** The day the time falls on, to catch daylight saving gaps and repeats. */
  date?: Date | null;
  /** Force a 12-hour or 24-hour clock instead of the locale's. */
  hour12?: boolean;
  /** Show the field's message somewhere else; it is then not shown inline. */
  onIssueChange?: (issue: TimeIssue | null) => void;
  /**
   * Say the new time after Arrow Up or Arrow Down. Turn it off when the form
   * announces a summary with the time in it, so one key press is one
   * announcement.
   */
  announceSteps?: boolean;
}) {
  const hour12 = hour12Prop ?? uses12HourClock();
  const fallbackId = React.useId();
  const baseId = id ?? fallbackId;
  // The text the field last checked. Messages show for that text only, so
  // nothing flags a time while it is still being typed.
  const [checked, setChecked] = React.useState(value);
  const [spoken, setSpoken] = React.useState("");

  const described =
    checked === value ? describeTime(value, date, hour12) : null;
  // A format error yields to the form's own message once the form flags the
  // field, so the same problem is never stated twice.
  const yields =
    described?.kind === "format" && !!ariaInvalid && ariaInvalid !== "false";
  // Picking one of a repeated time's readings sets the text and checks it.
  // A pick changes the message, so the parent always holds a fresh one.
  const choose = (text: string) => {
    onChange(text);
    setChecked(text);
  };
  const issue: TimeIssue | null =
    described && !yields
      ? {
          id: `${baseId}-issue`,
          ...described,
          ...(described.choices ? { choose } : {}),
        }
      : null;
  // The chosen reading is part of the key: both readings of a repeated time
  // share one message, and the parent must still hear which one is chosen.
  const issueKey = issue
    ? `${issue.kind}:${issue.message}:${issue.choices?.findIndex((c) => c.selected) ?? ""}`
    : "";

  // Tell the parent when the message changes (by its text, so a parent that
  // passes a new Date each render doesn't hear the same issue twice).
  const report = React.useRef({ onIssueChange, issue });
  React.useEffect(() => {
    report.current = { onIssueChange, issue };
  });
  React.useEffect(() => {
    report.current.onIssueChange?.(report.current.issue);
  }, [issueKey]);

  // A message found by a check (leaving the field, or Enter) is said once in
  // the live region: the field has usually lost focus by then, so its
  // description alone would go unheard until the operator came back.
  const checking = React.useRef(false);
  React.useEffect(() => {
    if (!checking.current) return;
    checking.current = false;
    setSpoken(report.current.issue?.message ?? "");
  }, [checked, issueKey]);

  const hintId = `${baseId}-hint`;
  const invalid =
    (!!ariaInvalid && ariaInvalid !== "false") || issue?.tone === "error";

  /** Text in the field's own words: "1:30 AM", or "1:30 AM EST" for a reading. */
  const tidy = (text: string) => {
    const minutes = parseTime(text);
    if (minutes === null) return text;
    const time = formatTime(minutes, hour12);
    const typed = splitZone(text).zone;
    if (!typed) return time;
    const read = date ? readTime(date, text) : null;
    // Keep a label that doesn't fit, so the message can say why.
    if (!read || !read.zoneFits) return `${time} ${typed}`;
    if (!read.labels) return time;
    return `${time} ${read.labels[read.second ? 1 : 0]}`;
  };

  const settle = (text: string) => {
    const next = tidy(text);
    if (next !== text) onChange(next);
    // Re-checking the same text says nothing new.
    if (next !== checked) checking.current = true;
    setChecked(next);
  };

  /**
   * Focuses the chosen reading of a repeated time once its choice renders,
   * here or wherever the parent shows the message. If it never does, focus
   * stays in the field and the next Tab moves on.
   */
  const focusChoice = () => {
    let frames = 0;
    const find = () => {
      const group = document
        .getElementById(`${baseId}-issue`)
        ?.closest('[data-slot="time-field-message"]')
        ?.querySelector('[data-slot="time-field-occurrence"]');
      const pick =
        group?.querySelector<HTMLElement>('[aria-checked="true"]') ??
        group?.querySelector<HTMLElement>('[role="radio"]');
      if (pick) pick.focus();
      else if (++frames < 10) window.requestAnimationFrame(find);
    };
    window.requestAnimationFrame(find);
  };

  const stepTo = (direction: 1 | -1) => {
    const current = parseTime(value);
    const base =
      current ??
      (() => {
        const now = new Date();
        return now.getHours() * 60 + now.getMinutes();
      })();
    // Land on the step grid first, then move by whole steps.
    let next =
      base % step === 0
        ? base + direction * step
        : direction > 0
          ? Math.ceil(base / step) * step
          : Math.floor(base / step) * step;
    next = ((next % DAY) + DAY) % DAY;
    if (date) {
      // Step over times the clocks skip on this day.
      for (let i = 0; i < DAY / step; i++) {
        if (resolveLocalTime(date, next).kind !== "skipped") break;
        next = (((next + direction * step) % DAY) + DAY) % DAY;
      }
    }
    let text = formatTime(next, hour12);
    // Stepping within the hour that repeats keeps the chosen reading.
    if (date && splitZone(value).zone) {
      const now = readTime(date, value);
      const then = readTime(date, text);
      if (now?.labels && then?.labels)
        text = `${text} ${then.labels[now.second ? 1 : 0]}`;
    }
    onChange(text);
    setChecked(text);
    if (announceSteps) setSpoken(text);
  };

  return (
    <div className="min-w-0 space-y-1.5">
      <InputFrame className={className}>
        {/* A zone label ("1:30 AM EST") says it is a time; the room goes to
            the text, so it fits the 8rem fields forms give a time. */}
        {!splitZone(value).zone && (
          <ClockIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}
        <InputFrameControl
          id={baseId}
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={20}
          placeholder={timeExample(hour12)}
          value={value}
          aria-invalid={invalid || undefined}
          aria-describedby={
            [issue && issue.id, ariaDescribedBy, hintId]
              .filter(Boolean)
              .join(" ") || undefined
          }
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => {
            settle(value);
            onBlur?.(event);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              stepTo(event.key === "ArrowUp" ? 1 : -1);
            } else if (
              (event.key === "Tab" && !event.shiftKey) ||
              event.key === "Enter"
            ) {
              // A repeated time's choice appears after the field only once
              // the text is checked, which is after Tab would have passed
              // it, so Tab goes to the choice itself (a11y D-74). Enter does
              // the same instead of submitting the form at the first reading
              // unseen (a11y D-79). Once the choice shows, both act as usual.
              const next = tidy(value);
              if (
                next !== checked &&
                describeTime(next, date, hour12)?.choices
              ) {
                event.preventDefault();
                focusChoice();
              } else if (next !== checked && event.key === "Tab") {
                // The check re-renders messages around the field. A browser
                // blurs the field before the next control takes focus, and
                // a dialog's focus trap takes focus back to itself when
                // nodes go away in that gap (a11y D-82). So the field moves
                // focus itself once the check has rendered.
                event.preventDefault();
                tabFrom(event.currentTarget, 1);
              }
              settle(value);
            } else if (
              event.key === "Tab" &&
              event.shiftKey &&
              tidy(value) !== checked
            ) {
              event.preventDefault();
              tabFrom(event.currentTarget, -1);
              settle(value);
            }
            onKeyDown?.(event);
          }}
          className="tabular-nums"
          {...props}
        />
      </InputFrame>
      <span id={hintId} className="sr-only">
        {`Type a time such as ${timeExample(hour12)}. Arrow Up and Arrow Down change it by ${step} minutes.`}
      </span>
      {/* Arrow keys change the text without typing, and a check's message
          appears after focus has left, so both are said here. */}
      <span aria-live="polite" className="sr-only" data-slot="time-field-live">
        {spoken}
      </span>
      {issue && !onIssueChange && <TimeFieldMessage issue={issue} />}
    </div>
  );
}

export { TimeField, TimeFieldMessage };
