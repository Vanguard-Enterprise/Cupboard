// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TargetHistoryPanel } from "./status-history";
import {
  DAY_MS,
  HOUR_MS,
  type HealthBucket,
  type TargetHistory,
} from "@/lib/status-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const now = Date.UTC(2026, 10, 12, 15, 30);
const today = Math.floor(now / DAY_MS) * DAY_MS;
const bucket = (start: number, counts: Partial<HealthBucket> = {}) => ({
  start,
  operational: 0,
  degraded: 0,
  down: 0,
  maintenance: 0,
  unknown: 0,
  latencyMs: null,
  latencyCount: 0,
  ...counts,
});
const format = { timeZone: "UTC", locale: "en-US" };

const history: TargetHistory = {
  now,
  // A full hour of fast checks, then this partial hour's one slow check.
  hours: [
    bucket(today + 14 * HOUR_MS, {
      operational: 60,
      latencyMs: 100,
      latencyCount: 60,
    }),
    bucket(today + 15 * HOUR_MS, {
      operational: 30,
      latencyMs: 1000,
      latencyCount: 1,
    }),
  ],
  days: [
    bucket(today, { operational: 900 }),
    bucket(today - DAY_MS, { operational: 1380, down: 60 }),
    bucket(today - 60 * DAY_MS, { operational: 1440 }),
  ],
  incidents: [
    {
      startedAt: today - DAY_MS + 3 * HOUR_MS,
      endedAt: today - DAY_MS + 4 * HOUR_MS,
      worst: "down",
    },
  ],
};

describe("TargetHistoryPanel", () => {
  it("shows uptime, the day strip, response times, and incidents once loaded", async () => {
    render(<TargetHistoryPanel load={async () => history} format={format} />);
    expect(screen.getByText("Loading history")).toBeTruthy();
    const strip = await screen.findByRole("group", { name: /Last/ });
    expect(strip.children).toHaveLength(90);
    expect(screen.getByText("24 hours")).toBeTruthy();
    expect(screen.getByText("90 days")).toBeTruthy();
    expect(screen.queryByText("Loading history")).toBeNull();
  });

  it("weights the response average by checks and reads each hour by keyboard", async () => {
    render(<TargetHistoryPanel load={async () => history} format={format} />);
    const chart = await screen.findByRole("group", { name: "Response time" });
    const said = () =>
      chart.parentElement!.parentElement!.querySelector("[aria-live]")!
        .textContent;
    // 60 checks at 100 ms and one at 1000 ms average 115, not 550.
    expect(said()).toBe("Average 115 ms");
    expect(chart.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(chart, { key: "End" });
    expect(said()).toContain("1000 ms");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(said()).toContain("100 ms");
    fireEvent.keyDown(chart, { key: "Home" });
    expect(said()).toContain("No data");
    fireEvent.blur(chart);
    expect(said()).toBe("Average 115 ms");
  });

  it("offers Retry when the history can't load, and loads again", async () => {
    const user = userEvent.setup();
    const load = vi
      .fn<() => Promise<TargetHistory>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(history);
    render(<TargetHistoryPanel load={load} format={format} />);
    expect(
      await screen.findByText("History isn't available right now."),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("group", { name: /Last/ })).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps the arrow keys on the days a narrow strip shows", async () => {
    render(<TargetHistoryPanel load={async () => history} format={format} />);
    const strip = await screen.findByRole("group", { name: /Last/ });
    // A narrow container hides the 60 oldest days.
    const bars = [...strip.children];
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element, pseudo) =>
        bars.indexOf(element) >= 0 && bars.indexOf(element) < 60
          ? ({ display: "none" } as CSSStyleDeclaration)
          : real(element, pseudo),
    );
    const said = () =>
      strip.parentElement!.querySelector("[aria-live]")!.textContent;
    fireEvent.keyDown(strip, { key: "Home" });
    // The oldest day shown is 29 days back, not 89.
    const oldest = new Date(today - 29 * DAY_MS).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    expect(said()).toContain(oldest);
    fireEvent.keyDown(strip, { key: "ArrowLeft" });
    expect(said()).toContain(oldest);
    fireEvent.keyDown(strip, { key: "End" });
    expect(said()).toContain(
      new Date(today).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
    );
  });
});
