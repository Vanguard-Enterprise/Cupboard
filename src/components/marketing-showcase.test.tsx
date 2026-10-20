// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { MarketingShowcase } from "./marketing-showcase";

afterEach(cleanup);

describe("marketing performance showcase", () => {
  it("changes the monitoring state through the keyboard-accessible switch", async () => {
    const user = userEvent.setup();
    render(<MarketingShowcase />);
    const toggle = screen.getByRole("switch", { name: "Machine monitoring" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    toggle.focus();
    await user.keyboard(" ");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Paused")).toBeTruthy();
    await user.keyboard(" ");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
  it("changes the illustrated report when a time range is selected", async () => {
    const user = userEvent.setup();
    render(<MarketingShowcase />);
    expect(
      screen.getByRole("button", { name: "1W" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "12M" }));
    expect(
      screen.getByRole("button", { name: "12M" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "1W" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe(
      "Reading 14: 289 frames per second",
    );
  });
  it("lets keyboard users inspect readings and keeps the selection in bounds", async () => {
    const user = userEvent.setup();
    render(<MarketingShowcase />);
    const chart = screen.getByRole("slider", {
      name: "Inspect server performance",
    });
    chart.focus();
    await user.keyboard("{Home}{ArrowLeft}");
    expect(chart.getAttribute("aria-valuenow")).toBe("1");
    expect(chart.getAttribute("aria-valuetext")).toBe(
      "Reading 1: 198 frames per second",
    );
    await user.keyboard("{ArrowRight}");
    expect(chart.getAttribute("aria-valuetext")).toBe(
      "Reading 2: 194 frames per second",
    );
    await user.keyboard("{End}{ArrowRight}");
    expect(chart.getAttribute("aria-valuenow")).toBe("14");
    expect(screen.getByText("Reading 14 of 14")).toBeTruthy();
  });
});
