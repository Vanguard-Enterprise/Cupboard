// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditLog } from "./audit-log";

afterEach(cleanup);
beforeAll(() => {
  for (const method of [
    "hasPointerCapture",
    "releasePointerCapture",
    "scrollIntoView",
    "setPointerCapture",
  ]) {
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      value: method === "hasPointerCapture" ? () => false : vi.fn(),
    });
  }
});

describe("Audit log", () => {
  it("searches events and opens a redacted event detail view", async () => {
    const user = userEvent.setup();
    render(<AuditLog />);

    const search = screen.getByLabelText("Search events");
    expect(screen.getByRole("columnheader", { name: "Details" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Date EDT" })).toBeTruthy();
    expect(screen.getByText("9 results")).toBeTruthy();

    await user.type(search, "credential");

    expect(screen.getByText("1 result of 9 events")).toBeTruthy();
    expect(
      screen.getAllByText("Replaced RCON credential").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Updated organization profile")).toBeNull();

    const rowAction = within(screen.getByRole("table")).getByRole("button", {
      name: "View event: Replaced RCON credential for Glacier Network 2",
    });
    const eventRow = rowAction.closest("tr");
    expect(eventRow).toBeTruthy();
    expect(eventRow?.hasAttribute("tabindex")).toBe(false);
    await user.click(eventRow!);

    const dialog = screen.getByRole("dialog", {
      name: "Replaced RCON credential",
    });
    expect(dialog.className).toContain("data-[side=right]:right-0!");
    expect(dialog.className).toContain("m-0");
    expect(dialog.className).toContain("data-[side=right]:sm:max-w-[28.75rem]");
    expect(
      document.querySelector<HTMLElement>('[data-slot="sheet-overlay"]')
        ?.className,
    ).toContain("backdrop-blur-[1px]");
    expect(
      within(dialog).getByText("Sep 15, 2026 at 3:27 PM EDT"),
    ).toBeTruthy();
    expect(within(dialog).getByText("Succeeded")).toBeTruthy();
    expect(within(dialog).getByText("198.51.100.24").className).toContain(
      "font-mono",
    );
    expect(within(dialog).getByText("Chrome 140 on macOS")).toBeTruthy();
    expect(
      within(dialog).getByText("Credential: RCON, value redacted"),
    ).toBeTruthy();
    expect(within(dialog).getByText("evt_01J7M9CSQP").className).toContain(
      "font-mono",
    );
    const closeButton = within(dialog).getByRole("button", { name: "Close" });
    expect(closeButton.className).toContain("size-11");
    expect(closeButton.className).toContain("lg:size-7");
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Replaced RCON credential" }),
    ).toBeNull();

    rowAction.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("dialog", { name: "Replaced RCON credential" }),
    ).toBeTruthy();
    await user.keyboard("{Escape}");
  });

  it("searches visible source values", async () => {
    const user = userEvent.setup();
    render(<AuditLog />);

    await user.type(screen.getByLabelText("Search events"), "Approved action");

    expect(screen.getByText("1 result of 9 events")).toBeTruthy();
    expect(screen.getAllByText("Restarted server").length).toBeGreaterThan(0);
    expect(screen.queryByText("Updated organization profile")).toBeNull();
  });

  it("shows an empty state and clears all filters", async () => {
    const user = userEvent.setup();
    render(<AuditLog />);

    await user.click(screen.getByRole("combobox", { name: "Event type" }));
    await user.click(screen.getByRole("option", { name: "Access" }));
    await user.click(screen.getByRole("combobox", { name: "Outcome" }));
    await user.click(screen.getByRole("option", { name: "Failed" }));
    await user.type(screen.getByLabelText("Search events"), "not-an-event");
    expect(screen.getByText("0 results of 9 events")).toBeTruthy();
    expect(screen.getByText("No matching events")).toBeTruthy();
    expect(
      screen.getByText("Try another search or clear your filters."),
    ).toBeTruthy();

    const clearFilters = screen.getByRole("button", { name: "Clear filters" });
    await user.click(clearFilters);
    expect(screen.getByText("9 results")).toBeTruthy();
    expect(screen.getByLabelText("Search events").getAttribute("value")).toBe(
      "",
    );
    expect(
      screen.getByRole("combobox", { name: "Event type" }).textContent,
    ).toContain("Type");
    expect(
      screen.getByRole("combobox", { name: "Outcome" }).textContent,
    ).toContain("Outcome");
  });

  it("filters by event type and outcome with source-owned menus", async () => {
    const user = userEvent.setup();
    render(<AuditLog />);

    const eventType = screen.getByRole("combobox", { name: "Event type" });
    await user.click(eventType);
    expect(screen.getByRole("option", { name: "Access" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("option", { name: "Access" })).toBeNull();

    eventType.focus();
    await user.keyboard("{Enter}{ArrowDown}{Enter}");
    expect(screen.getByText("3 results of 9 events")).toBeTruthy();

    const outcome = screen.getByRole("combobox", { name: "Outcome" });
    await user.click(outcome);
    expect(screen.getByRole("option", { name: "Succeeded" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByLabelText("Search events"));
    expect(screen.queryByRole("option", { name: "Succeeded" })).toBeNull();

    await user.click(outcome);
    await user.click(screen.getByRole("option", { name: "Failed" }));
    expect(screen.getByText("1 result of 9 events")).toBeTruthy();
    expect(
      screen.getAllByText("Completed login challenge").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Changed member role")).toBeNull();
  });
  it("combines actor, action, target, and inclusive calendar dates", async () => {
    const user = userEvent.setup();
    render(<AuditLog />);
    for (const [filter, option] of [
      ["Actor", "Demo operator"],
      ["Action", "Updated connection settings"],
      ["Target", "Rusty Moose East"],
    ]) {
      await user.click(screen.getByRole("combobox", { name: filter }));
      await user.click(screen.getByRole("option", { name: option }));
    }
    expect(screen.getByText("1 result of 9 events")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Select date range" }));
    await user.click(
      screen.getByRole("button", { name: /Sunday, September 13th, 2026/ }),
    );
    await user.click(
      screen.getByRole("button", { name: /Tuesday, September 15th, 2026/ }),
    );
    await user.keyboard("{Escape}");
    expect(screen.getByText("1 result of 9 events")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("9 results")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Select date range" }));
    await user.click(
      screen.getByRole("button", { name: /Monday, September 14th, 2026/ }),
    );
    await user.keyboard("{Escape}");
    expect(screen.getByText("3 results of 9 events")).toBeTruthy();
    expect(screen.queryByText("Updated connection settings")).toBeNull();
  });
});
