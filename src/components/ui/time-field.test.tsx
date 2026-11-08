// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TimeField,
  TimeFieldMessage,
  describeTime,
  formatTime,
  parseTime,
  resolveLocalTime,
  timeExample,
  timeOn,
  timeTextAt,
  uses12HourClock,
  type TimeIssue,
} from "./time-field";

// Daylight saving cases rely on the America/New_York zone that
// vitest.config.mjs pins before any worker starts.
afterEach(cleanup);

// 2027 in New York: clocks skip 2:00 to 3:00 AM on Sun, Mar 14 and repeat
// 1:00 to 2:00 AM on Sun, Nov 7.
const springForward = new Date(2027, 2, 14);
const fallBack = new Date(2027, 10, 7);
const ordinary = new Date(2027, 5, 1);

describe("parseTime", () => {
  it("reads 24-hour, compact, and AM/PM times", () => {
    expect(parseTime("19:00")).toBe(19 * 60);
    expect(parseTime("1930")).toBe(19 * 60 + 30);
    expect(parseTime("7")).toBe(7 * 60);
    expect(parseTime("7pm")).toBe(19 * 60);
    expect(parseTime("7:30 PM")).toBe(19 * 60 + 30);
    expect(parseTime("7:30 p.m.")).toBe(19 * 60 + 30);
    expect(parseTime("7.30")).toBe(7 * 60 + 30);
    expect(parseTime("12am")).toBe(0);
    expect(parseTime("12 p")).toBe(12 * 60);
  });

  it("rejects values that are not times", () => {
    for (const value of [
      "",
      "24:00",
      "2500",
      "13pm",
      "9:75",
      "noon",
      "0am",
      "abc",
    ])
      expect(parseTime(value)).toBeNull();
  });
});

describe("formatTime", () => {
  it("writes the 24-hour clock and wraps around midnight", () => {
    expect(formatTime(0, false)).toBe("00:00");
    expect(formatTime(19 * 60 + 5, false)).toBe("19:05");
    expect(formatTime(-15, false)).toBe("23:45");
    expect(formatTime(24 * 60 + 30, false)).toBe("00:30");
  });

  it("writes the 12-hour clock with AM and PM", () => {
    expect(formatTime(0, true)).toBe("12:00 AM");
    expect(formatTime(12 * 60, true)).toBe("12:00 PM");
    expect(formatTime(19 * 60 + 5, true)).toBe("7:05 PM");
    expect(timeExample(true)).toBe("7:00 PM");
    expect(timeExample(false)).toBe("19:00");
  });

  it("follows the locale's clock by default", () => {
    expect(uses12HourClock("en-US")).toBe(true);
    expect(uses12HourClock("en-GB")).toBe(false);
    expect(uses12HourClock("de-DE")).toBe(false);
    expect(formatTime(19 * 60)).toBe(uses12HourClock() ? "7:00 PM" : "19:00");
  });

  it("round-trips through parseTime on both clocks", () => {
    for (const minutes of [0, 45, 12 * 60, 13 * 60 + 15, 23 * 60 + 59]) {
      expect(parseTime(formatTime(minutes, true))).toBe(minutes);
      expect(parseTime(formatTime(minutes, false))).toBe(minutes);
    }
  });
});

describe("resolveLocalTime", () => {
  it("passes ordinary times through", () => {
    const local = resolveLocalTime(ordinary, 19 * 60);
    expect(local.kind).toBe("exact");
    expect(local.at).toBe(new Date(2027, 5, 1, 19).getTime());
  });

  it("flags a time the clocks skip and names the gap", () => {
    const local = resolveLocalTime(springForward, 2 * 60 + 30);
    expect(local).toMatchObject({
      kind: "skipped",
      gapStart: 2 * 60,
      gapEnd: 3 * 60,
    });
    // Times either side of the gap are fine.
    expect(resolveLocalTime(springForward, 60 + 59).kind).toBe("exact");
    expect(resolveLocalTime(springForward, 3 * 60).kind).toBe("exact");
  });

  it("flags a time that happens twice and uses the first one", () => {
    const local = resolveLocalTime(fallBack, 60 + 30);
    expect(local.kind).toBe("repeated");
    if (local.kind !== "repeated") return;
    expect(local.later - local.at).toBe(60 * 60_000);
    expect(new Date(local.at).getTimezoneOffset()).toBe(240); // EDT
    expect(new Date(local.later).getTimezoneOffset()).toBe(300); // EST
    expect(resolveLocalTime(fallBack, 2 * 60).kind).toBe("exact");
  });
});

describe("describeTime", () => {
  it("explains unreadable, skipped, and repeated times", () => {
    expect(describeTime("", ordinary, true)).toBeNull();
    expect(describeTime("7pm", ordinary, true)).toBeNull();
    expect(describeTime("25:00", ordinary, true)).toEqual({
      tone: "error",
      kind: "format",
      message: "Enter a time such as 7:00 PM.",
    });
    expect(describeTime("abc", null, false)?.message).toBe(
      "Enter a time such as 19:00.",
    );
    expect(describeTime("2:30 AM", springForward, true)).toEqual({
      tone: "error",
      kind: "skipped",
      message:
        "Clocks skip 2:00 AM to 3:00 AM on Sun, Mar 14. Choose another time.",
    });
    expect(describeTime("1:30 AM", fallBack, true)).toEqual({
      tone: "note",
      kind: "repeated",
      message: "1:30 AM happens twice on Sun, Nov 7 as clocks go back.",
      choices: [
        { label: "1:30 AM EDT", text: "1:30 AM EDT", selected: true },
        { label: "1:30 AM EST", text: "1:30 AM EST", selected: false },
      ],
    });
  });

  it("names the reading a zone label picks, and rejects one that doesn't fit", () => {
    const second = describeTime("1:30 AM EST", fallBack, true);
    expect(second?.tone).toBe("note");
    expect(second?.choices?.map((c) => c.selected)).toEqual([false, true]);
    expect(
      describeTime("1:30 AM EDT", fallBack, true)?.choices?.map(
        (c) => c.selected,
      ),
    ).toEqual([true, false]);
    // Offsets work where a locale has no zone names.
    expect(
      describeTime("1:30 AM GMT-5", fallBack, true)?.choices?.map(
        (c) => c.selected,
      ),
    ).toEqual([false, true]);
    expect(describeTime("1:30 AM PST", fallBack, true)).toMatchObject({
      tone: "error",
      kind: "zone",
      message:
        "1:30 AM happens twice on Sun, Nov 7 as clocks go back. PST is neither, so choose one.",
    });
    expect(describeTime("1:30 AM PST", fallBack, true)?.choices).toHaveLength(
      2,
    );
    // On an ordinary day the zone it is in anyway is fine; another is not.
    expect(describeTime("7:00 PM EDT", ordinary, true)).toBeNull();
    expect(describeTime("7:00 PM EST", ordinary, true)).toEqual({
      tone: "error",
      kind: "zone",
      message: "7:00 PM on Tue, Jun 1 is EDT, not EST. Remove EST.",
    });
  });
});

describe("timeOn and timeTextAt", () => {
  const first = new Date(2027, 10, 7, 1, 30).getTime();
  const second = first + 60 * 60_000;

  it("reads parseTime's zone label without changing its minutes", () => {
    expect(parseTime("1:30 AM EST")).toBe(90);
    expect(parseTime("01:30 GMT+1")).toBe(90);
    expect(parseTime("7 pm")).toBe(19 * 60);
    expect(parseTime("7:30 p.m.")).toBe(19 * 60 + 30);
    expect(parseTime("7 pm banana")).toBeNull();
  });

  it("gives the second reading of a repeated time only when its label is named", () => {
    expect(timeOn(fallBack, "1:30 AM")).toBe(first);
    expect(timeOn(fallBack, "1:30 AM EDT")).toBe(first);
    expect(timeOn(fallBack, "1:30 AM EST")).toBe(second);
    expect(timeOn(fallBack, "1:30 am est")).toBe(second);
    expect(timeOn(ordinary, "7:00 PM")).toBe(
      new Date(2027, 5, 1, 19).getTime(),
    );
    expect(timeOn(ordinary, "soon")).toBeNull();
  });

  // codex D-39: "7:00 PM EST" on Jun 1 was read as 7:00 PM EDT (23:00Z), so
  // a time the field marked wrong still scheduled a window an hour early.
  it("gives no instant for a zone label the time can't have that day", () => {
    expect(timeOn(ordinary, "7:00 PM EST")).toBeNull();
    expect(timeOn(ordinary, "7:00 PM XYZ")).toBeNull();
    expect(timeOn(ordinary, "7:00 PM GMT+1")).toBeNull();
    expect(timeOn(fallBack, "1:30 AM PST")).toBeNull();
    // A label naming the zone it is in anyway still reads.
    expect(timeOn(ordinary, "7:00 PM EDT")).toBe(
      new Date(2027, 5, 1, 19).getTime(),
    );
    expect(timeOn(ordinary, "7:00 PM GMT-4")).toBe(
      new Date(2027, 5, 1, 19).getTime(),
    );
  });

  it("gives no instant for a time the clocks skip", () => {
    expect(timeOn(springForward, "2:30 AM")).toBeNull();
    expect(timeOn(springForward, "3:30 AM")).toBe(
      new Date(2027, 2, 14, 3, 30).getTime(),
    );
  });

  it("has a value exactly when describeTime finds no error", () => {
    const days = [ordinary, fallBack, springForward];
    const texts = [
      "",
      "7pm",
      "7:00 PM EST",
      "7:00 PM EDT",
      "7:00 PM ZZZ",
      "1:30 AM",
      "1:30 AM EST",
      "1:30 AM EDT",
      "1:30 AM PST",
      "1:30 AM GMT-5",
      "2:30 AM",
      "2:30 AM EST",
      "25:00",
      "soon",
    ];
    for (const day of days)
      for (const text of texts) {
        const error = describeTime(text, day, true)?.tone === "error";
        expect(
          timeOn(day, text) === null,
          `${text || "(empty)"} on ${day.toDateString()}`,
        ).toBe(error || !text.trim());
      }
  });

  it("writes an instant back as text that timeOn reads the same", () => {
    expect(timeTextAt(first, true)).toBe("1:30 AM");
    expect(timeTextAt(second, true)).toBe("1:30 AM EST");
    expect(timeTextAt(new Date(2027, 5, 1, 19).getTime(), true)).toBe(
      "7:00 PM",
    );
    for (const at of [first, second, first - 45 * 60_000, second + 45 * 60_000])
      expect(timeOn(new Date(at), timeTextAt(at, true))).toBe(at);
  });
});

function Harness({
  initial,
  date,
  invalid,
  onIssue,
  announceSteps,
}: {
  initial: string;
  date?: Date;
  invalid?: boolean;
  onIssue?: (issue: TimeIssue | null) => void;
  announceSteps?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <TimeField
      id="start-time"
      aria-label="Start time"
      aria-invalid={invalid || undefined}
      hour12
      date={date}
      value={value}
      onChange={setValue}
      onIssueChange={onIssue}
      announceSteps={announceSteps}
    />
  );
}

const describedBy = (field: HTMLElement) =>
  (field.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .join(" | ");

describe("TimeField", () => {
  it("steps by 15 minutes with the arrow keys and settles typed text on blur", async () => {
    const user = userEvent.setup();
    render(<Harness initial="7:07 PM" />);
    const field = screen.getByLabelText("Start time");
    expect(field.getAttribute("type")).toBe("text");
    expect(field.getAttribute("inputmode")).toBe("text");
    expect(field.getAttribute("placeholder")).toBe("7:00 PM");
    await user.click(field);
    await user.keyboard("{ArrowUp}");
    expect(field).toHaveProperty("value", "7:15 PM");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(field).toHaveProperty("value", "6:45 PM");
    await user.clear(field);
    await user.type(field, "1930");
    await user.tab();
    expect(field).toHaveProperty("value", "7:30 PM");
  });

  it("describes its format and arrow keys, and speaks each step", async () => {
    const user = userEvent.setup();
    render(<Harness initial="7:00 PM" />);
    const field = screen.getByLabelText("Start time");
    expect(describedBy(field)).toBe(
      "Type a time such as 7:00 PM. Arrow Up and Arrow Down change it by 15 minutes.",
    );
    const live = document.querySelector("[aria-live=polite]")!;
    expect(live.textContent).toBe("");
    await user.click(field);
    await user.keyboard("{ArrowUp}");
    expect(live.textContent).toBe("7:15 PM");
  });

  it("checks the time on blur, not while typing", async () => {
    const user = userEvent.setup();
    render(<Harness initial="7:00 PM" />);
    const field = screen.getByLabelText("Start time");
    await user.clear(field);
    await user.type(field, "25");
    expect(field.getAttribute("aria-invalid")).toBeNull();
    await user.tab();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(field)).toContain("Enter a time such as 7:00 PM.");
    expect(
      screen.getByText("Enter a time such as 7:00 PM.", {
        selector: "p > span",
      }),
    ).toBeTruthy();
    // Typing again clears the message until the next check.
    await user.type(field, "x");
    expect(field.getAttribute("aria-invalid")).toBeNull();
    await user.clear(field);
    await user.type(field, "8pm");
    await user.tab();
    expect(field).toHaveProperty("value", "8:00 PM");
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText("Enter a time such as 7:00 PM.")).toBeNull();
  });

  it("leaves a format error to the form once the form flags the field", async () => {
    const user = userEvent.setup();
    render(<Harness initial="abc" invalid />);
    const field = screen.getByLabelText("Start time");
    await user.click(field);
    await user.tab();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByText("Enter a time such as 7:00 PM.")).toBeNull();
  });

  it("rejects a time daylight saving skips and notes a repeated one", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <Harness initial="1:00 AM" date={springForward} />,
    );
    let field = screen.getByLabelText("Start time");
    await user.clear(field);
    await user.type(field, "230am");
    await user.tab();
    expect(field).toHaveProperty("value", "2:30 AM");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(field)).toContain(
      "Clocks skip 2:00 AM to 3:00 AM on Sun, Mar 14",
    );
    unmount();

    render(<Harness initial="1:00 AM" date={fallBack} />);
    field = screen.getByLabelText("Start time");
    await user.clear(field);
    await user.type(field, "1:30am");
    await user.tab();
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(describedBy(field)).toContain(
      "1:30 AM happens twice on Sun, Nov 7 as clocks go back.",
    );
  });

  it("lets the operator pick the second reading of a repeated time", async () => {
    const user = userEvent.setup();
    let reported: TimeIssue | null = null;
    function Form() {
      const [value, setValue] = useState("1:00 AM");
      const [issue, setIssue] = useState<TimeIssue | null>(null);
      return (
        <>
          <TimeField
            id="start-time"
            aria-label="Start time"
            hour12
            date={fallBack}
            value={value}
            onChange={setValue}
            onIssueChange={(next) => {
              reported = next;
              setIssue(next);
            }}
          />
          {issue && <TimeFieldMessage issue={issue} />}
          <output data-testid="instant">{timeOn(fallBack, value)}</output>
        </>
      );
    }
    render(<Form />);
    const field = screen.getByLabelText("Start time");
    await user.clear(field);
    await user.type(field, "1:30am");
    await user.tab();

    const which = screen.getByRole("radiogroup", { name: "Which 1:30 AM" });
    const first = screen.getByRole("radio", { name: "1:30 AM EDT" });
    const second = screen.getByRole("radio", { name: "1:30 AM EST" });
    expect(which).toBeTruthy();
    expect(first.getAttribute("aria-checked")).toBe("true");
    expect(reported!.choose).toBeTypeOf("function");

    await user.click(second);
    expect(field).toHaveProperty("value", "1:30 AM EST");
    expect(second.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("instant").textContent).toBe(
      String(new Date(2027, 10, 7, 1, 30).getTime() + 3_600_000),
    );

    // Arrow keys in the choice pick as they move, like radios.
    await user.keyboard("{ArrowLeft}");
    expect(field).toHaveProperty("value", "1:30 AM EDT");

    // Stepping inside the repeated hour keeps the reading.
    await user.click(screen.getByRole("radio", { name: "1:30 AM EST" }));
    await user.click(field);
    await user.keyboard("{ArrowUp}");
    expect(field).toHaveProperty("value", "1:45 AM EST");
    await user.keyboard("{ArrowUp}");
    expect(field).toHaveProperty("value", "2:00 AM");
  });

  // a11y D-74: the choice used to appear on blur, after Tab had gone past it.
  it("puts a repeated time's choice next in Tab order when Tab leaves the field", async () => {
    const user = userEvent.setup();
    // Inline, from the parent, and from a parent that renders it a frame
    // late (as in a real browser, where Tab would already have moved on).
    for (const mode of ["inline", "parent", "late"] as const) {
      const inline = mode === "inline";
      function Form() {
        const [value, setValue] = useState("");
        const [issue, setIssue] = useState<TimeIssue | null>(null);
        return (
          <>
            <TimeField
              id="start-time"
              aria-label="Start time"
              hour12
              date={fallBack}
              value={value}
              onChange={setValue}
              onIssueChange={
                inline
                  ? undefined
                  : mode === "late"
                    ? (next) =>
                        window.requestAnimationFrame(() => setIssue(next))
                    : setIssue
              }
            />
            {!inline && issue && <TimeFieldMessage issue={issue} />}
            <button type="button">Next</button>
          </>
        );
      }
      render(<Form />);
      await user.type(screen.getByLabelText("Start time"), "1:30am");
      await user.tab();
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("radio", { name: "1:30 AM EDT" }),
        ),
      );
      await user.tab();
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Next" }),
      );
      cleanup();
    }
  });

  it("shows a repeated time's choice on Enter instead of submitting the form (a11y D-79)", async () => {
    const user = userEvent.setup();
    const submit = vi.fn((event: { preventDefault: () => void }) =>
      event.preventDefault(),
    );
    function Form() {
      const [value, setValue] = useState("");
      return (
        <form onSubmit={submit}>
          <TimeField
            id="start-time"
            aria-label="Start time"
            hour12
            date={fallBack}
            value={value}
            onChange={setValue}
          />
          <button type="submit">Schedule</button>
        </form>
      );
    }
    render(<Form />);
    const field = screen.getByLabelText("Start time");
    await user.type(field, "1:30am{Enter}");
    // The first Enter reveals the choice and goes to it; nothing submits.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("radio", { name: "1:30 AM EDT" }),
      ),
    );
    expect(submit).not.toHaveBeenCalled();
    // Once the choice has been seen, Enter in the field submits as usual.
    await user.click(field);
    await user.keyboard("{Enter}");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("exposes no instant while its text has a zone label that doesn't fit, typed or settled", async () => {
    const user = userEvent.setup();
    function Form() {
      const [value, setValue] = useState("");
      return (
        <>
          <TimeField
            id="start-time"
            aria-label="Start time"
            hour12
            date={ordinary}
            value={value}
            onChange={setValue}
          />
          <output data-testid="instant">{timeOn(ordinary, value)}</output>
        </>
      );
    }
    render(<Form />);
    const field = screen.getByLabelText("Start time");
    await user.type(field, "7:00 PM EST");
    // Not blurred yet: still no value.
    expect(screen.getByTestId("instant").textContent).toBe("");
    await user.tab();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(field)).toContain("is EDT, not EST");
    expect(screen.getByTestId("instant").textContent).toBe("");
    await user.clear(field);
    await user.type(field, "7:00 PM");
    expect(screen.getByTestId("instant").textContent).toBe(
      String(new Date(2027, 5, 1, 19).getTime()),
    );
  });

  it("tidies a typed zone label and keeps one that doesn't fit", async () => {
    const user = userEvent.setup();
    render(<Harness initial="" date={fallBack} />);
    const field = screen.getByLabelText("Start time");
    await user.type(field, "130 am est");
    await user.tab();
    expect(field).toHaveProperty("value", "1:30 AM EST");
    await user.clear(field);
    await user.type(field, "1:30 AM PST");
    await user.tab();
    expect(field).toHaveProperty("value", "1:30 AM PST");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    await user.clear(field);
    await user.type(field, "4pm est");
    await user.tab();
    // The zone 4:00 PM is in anyway on that day: nothing to keep.
    expect(field).toHaveProperty("value", "4:00 PM");
  });

  it("steps over the hour daylight saving skips", async () => {
    const user = userEvent.setup();
    render(<Harness initial="1:45 AM" date={springForward} />);
    const field = screen.getByLabelText("Start time");
    await user.click(field);
    await user.keyboard("{ArrowUp}");
    expect(field).toHaveProperty("value", "3:00 AM");
    await user.keyboard("{ArrowDown}");
    expect(field).toHaveProperty("value", "1:45 AM");
  });

  it("hands its message to the form when asked and still points at it", async () => {
    const user = userEvent.setup();
    const onIssue = vi.fn();
    render(<Harness initial="7:00 PM" onIssue={onIssue} />);
    const field = screen.getByLabelText("Start time");
    await user.clear(field);
    await user.type(field, "nope");
    await user.tab();
    const issue = onIssue.mock.lastCall?.[0] as TimeIssue;
    expect(issue).toMatchObject({
      id: "start-time-issue",
      tone: "error",
      message: "Enter a time such as 7:00 PM.",
    });
    // Not shown inline: the form renders it where it has room.
    expect(
      screen.queryByText(issue.message, { selector: "p > span" }),
    ).toBeNull();
    expect(field.getAttribute("aria-describedby")).toContain(issue.id);
    act(() => {
      render(<TimeFieldMessage issue={issue} />);
    });
    expect(describedBy(field)).toContain("Enter a time such as 7:00 PM.");
    await user.clear(field);
    await user.type(field, "7pm");
    await user.tab();
    expect(onIssue.mock.lastCall?.[0]).toBeNull();
  });

  it("says a blur error in its live region, since focus has moved on", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness initial="7:00 PM" />
        <button type="button">Next field</button>
      </>,
    );
    const field = screen.getByLabelText("Start time");
    const live = document.querySelector('[data-slot="time-field-live"]')!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    await user.clear(field);
    await user.type(field, "abc");
    // Nothing is said while typing.
    expect(live.textContent).toBe("");
    await user.tab();
    // The field moves focus itself once its check has rendered (a11y D-82).
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Next field"),
    );
    expect(live.textContent).toBe("Enter a time such as 7:00 PM.");
    // Coming back and leaving again with the same text says nothing new.
    await user.click(field);
    await user.tab();
    expect(live.textContent).toBe("Enter a time such as 7:00 PM.");
    // A fixed time clears it silently.
    await user.click(field);
    await user.clear(field);
    await user.type(field, "8pm");
    await user.tab();
    expect(live.textContent).toBe("");
  });

  it("says the message even when the form shows it elsewhere", async () => {
    const user = userEvent.setup();
    render(<Harness initial="7:00 PM" onIssue={() => {}} />);
    const field = screen.getByLabelText("Start time");
    await user.clear(field);
    await user.type(field, "2500");
    await user.tab();
    expect(
      document.querySelector('[data-slot="time-field-live"]')!.textContent,
    ).toBe("Enter a time such as 7:00 PM.");
  });

  it("stays silent on arrow keys when the form announces its own summary", async () => {
    const user = userEvent.setup();
    render(<Harness initial="7:00 PM" announceSteps={false} />);
    const field = screen.getByLabelText("Start time");
    const live = document.querySelector('[data-slot="time-field-live"]')!;
    await user.click(field);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(field).toHaveProperty("value", "7:30 PM");
    expect(live.textContent).toBe("");
  });
});
