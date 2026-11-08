// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatePicker, firstWeekday } from "./date-picker";

beforeAll(() => {
  // Radix measures popovers with ResizeObserver, which jsdom lacks.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Phones, tablets, and short windows get the sheet; wider ones a popover. */
const queries: string[] = [];
function phone(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => {
    queries.push(query);
    return {
      matches,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    };
  });
}

function Field({
  initial,
  min,
  onPick,
}: {
  initial: Date | null;
  min?: Date;
  onPick?: (date: Date) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div>
      <label htmlFor="start-date">Start date</label>
      <DatePicker
        id="start-date"
        value={value}
        min={min}
        onChange={(date) => {
          setValue(date);
          onPick?.(date);
        }}
      />
    </div>
  );
}

const nov5 = new Date(2026, 10, 5);

describe("DatePicker", () => {
  it("says the chosen date in its accessible name", () => {
    render(<Field initial={nov5} />);
    const trigger = screen.getByRole("button", {
      name: "Start date, Thursday, November 5, 2026",
    });
    expect(trigger.textContent).toContain("Thu, Nov 5, 2026");
    // The visible label still finds it.
    expect(screen.getByLabelText("Start date")).toBe(trigger);
  });

  it("names an empty field as having no date", () => {
    render(<Field initial={null} />);
    expect(
      screen.getByRole("button", { name: "Start date, no date chosen" }),
    ).toBeTruthy();
  });

  it("opens on the chosen day with focus on it, not the month buttons", async () => {
    const user = userEvent.setup();
    render(<Field initial={nov5} />);
    const trigger = screen.getByLabelText("Start date");
    trigger.focus();
    await user.keyboard("{Enter}");
    const popover = await screen.findByRole("dialog", { name: "Start date" });
    expect(
      within(popover).getByRole("grid", { name: "November 2026" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement?.closest("td")?.dataset.day).toBe(
        "2026-11-05",
      ),
    );
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(
      /November 5th, 2026, selected/,
    );
    // Sentence-case month buttons.
    expect(
      within(popover).getByRole("button", { name: "Previous month" }),
    ).toBeTruthy();
    expect(
      within(popover).getByRole("button", { name: "Next month" }),
    ).toBeTruthy();
  });

  it("can't go to months before the earliest day", async () => {
    const user = userEvent.setup();
    render(<Field initial={nov5} min={new Date(2026, 10, 5, 14, 30)} />);
    await user.click(screen.getByLabelText("Start date"));
    const popover = await screen.findByRole("dialog", { name: "Start date" });
    const previous = within(popover).getByRole("button", {
      name: "Previous month",
    });
    expect(
      previous.hasAttribute("disabled") ||
        previous.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    const day4 = popover.querySelector<HTMLButtonElement>(
      'td[data-day="2026-11-04"] button',
    );
    expect(day4?.disabled).toBe(true);
    const next = within(popover).getByRole("button", { name: "Next month" });
    expect(next.hasAttribute("disabled")).toBe(false);
  });

  it("picks a day, closes, and returns focus to the field", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Field initial={nov5} onPick={onPick} />);
    const trigger = screen.getByLabelText("Start date");
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "Start date" });
    await waitFor(() =>
      expect(document.activeElement?.closest("td")?.dataset.day).toBe(
        "2026-11-05",
      ),
    );
    await user.keyboard("{ArrowRight}{Enter}");
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 10, 6));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(trigger.textContent).toContain("Fri, Nov 6, 2026");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a titled sheet on phones and short windows", async () => {
    phone(true);
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Field initial={nov5} onPick={onPick} />);
    const trigger = screen.getByLabelText("Start date");
    await user.click(trigger);
    const sheet = await screen.findByRole("dialog", { name: "Start date" });
    expect(sheet.dataset.slot).toBe("date-picker-sheet");
    expect(sheet.dataset.scrollable).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() =>
      expect(document.activeElement?.closest("td")?.dataset.day).toBe(
        "2026-11-05",
      ),
    );
    await user.click(
      sheet.querySelector<HTMLButtonElement>(
        'td[data-day="2026-11-12"] button',
      )!,
    );
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 10, 12));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes only the sheet on Escape and puts focus back on the field", async () => {
    phone(true);
    const user = userEvent.setup();
    render(<Field initial={nov5} />);
    const trigger = screen.getByLabelText("Start date");
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Start date" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(trigger.textContent).toContain("Thu, Nov 5, 2026");
  });

  it("uses a popover on wide screens", async () => {
    phone(false);
    const user = userEvent.setup();
    render(<Field initial={nov5} />);
    await user.click(screen.getByLabelText("Start date"));
    const popover = await screen.findByRole("dialog", { name: "Start date" });
    expect(popover.dataset.slot).toBe("popover-content");
  });

  it("uses the sheet below 1024px, so a tablet calendar never covers the form", async () => {
    phone(true);
    const user = userEvent.setup();
    render(<Field initial={nov5} />);
    await user.click(screen.getByLabelText("Start date"));
    await screen.findByRole("dialog", { name: "Start date" });
    expect(queries).toContain("(max-width: 1023px), (max-height: 480px)");
  });

  it("starts the week on the locale's first day", () => {
    expect(firstWeekday("en-US")).toBe(0);
    expect(firstWeekday("en-CA")).toBe(0);
    expect(firstWeekday("en-GB")).toBe(1);
    expect(firstWeekday("de-DE")).toBe(1);
    expect(firstWeekday("fr")).toBe(1);
    expect(firstWeekday("ar-EG")).toBe(6);
    expect(firstWeekday("not a locale")).toBe(1);
  });

  it("lays the calendar out from the locale's first weekday", async () => {
    phone(false);
    const user = userEvent.setup();
    const { unmount } = render(<Field initial={nov5} />);
    await user.click(screen.getByLabelText("Start date"));
    const calendar = await screen.findByRole("dialog", { name: "Start date" });
    const headers = () =>
      [...calendar.querySelectorAll("thead th")].map((th) =>
        th.getAttribute("aria-label"),
      );
    // jsdom's navigator.language is en-US: Sunday first, like US calendars.
    expect(navigator.language).toBe("en-US");
    expect(headers()[0]).toBe("Sunday");
    expect(headers()[6]).toBe("Saturday");
    // Nov 1, 2026 is a Sunday, so it opens the first row.
    expect(
      calendar.querySelector("tbody tr td")?.getAttribute("data-day"),
    ).toBe("2026-11-01");
    unmount();
  });

  it("takes an explicit first weekday", async () => {
    phone(false);
    const user = userEvent.setup();
    render(
      <div>
        <label htmlFor="d">Start date</label>
        <DatePicker id="d" value={nov5} onChange={() => {}} weekStartsOn={1} />
      </div>,
    );
    await user.click(screen.getByLabelText("Start date"));
    const calendar = await screen.findByRole("dialog", { name: "Start date" });
    expect(calendar.querySelector("thead th")?.getAttribute("aria-label")).toBe(
      "Monday",
    );
  });
});
