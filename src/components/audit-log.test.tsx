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
    expect(
      document.querySelector('label[for="audit-search"]')?.className,
    ).not.toContain("sr-only");
    expect(search.className).toContain("h-11");
    expect(search.className).toContain("lg:h-9");
    expect(search.parentElement?.parentElement?.className).toContain(
      "lg:flex-row",
    );
    expect(search.parentElement?.parentElement?.className).not.toContain(
      "md:flex-row",
    );
    for (const select of ["Event type", "Outcome"]) {
      const trigger = screen.getByRole("combobox", { name: select });
      expect(trigger.className).toContain("data-[size=default]:h-11");
      expect(trigger.className).toContain("lg:data-[size=default]:h-9");
      expect(trigger.className).toContain("lg:w-");
    }
    expect(screen.queryByText(/results?$/)).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Source" })).toBeTruthy();
    expect(
      screen.getByRole("table").parentElement?.parentElement?.className,
    ).toContain("2xl:block");
    expect(screen.getByRole("list").className).toContain("2xl:hidden");

    await user.type(search, "credential");

    expect(screen.getByText("1 result")).toBeTruthy();
    expect(
      screen.getAllByText("Replaced RCON credential").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Updated organization profile")).toBeNull();

    const eventRow = screen.getByRole("row", {
      name: "View event: Replaced RCON credential for Glacier Network 2",
    });
    await user.click(eventRow);

    const dialog = screen.getByRole("dialog", {
      name: "Replaced RCON credential",
    });
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

    eventRow.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("dialog", { name: "Replaced RCON credential" }),
    ).toBeTruthy();
    await user.keyboard("{Escape}");
  });

  it("shows an empty state and clears all filters", async () => {
    const user = userEvent.setup();
    render(<AuditLog />);

    await user.click(screen.getByRole("combobox", { name: "Event type" }));
    await user.click(screen.getByRole("option", { name: "Access" }));
    await user.click(screen.getByRole("combobox", { name: "Outcome" }));
    await user.click(screen.getByRole("option", { name: "Failed" }));
    await user.type(screen.getByLabelText("Search events"), "not-an-event");
    expect(screen.getByText("0 results")).toBeTruthy();
    expect(screen.getByText("No matching events")).toBeTruthy();
    expect(
      screen.getByText("Try another search or clear your filters."),
    ).toBeTruthy();

    const clearFilters = screen.getByRole("button", { name: "Clear filters" });
    expect(clearFilters.className).toContain("h-11");
    expect(clearFilters.className).toContain("lg:h-8");
    await user.click(clearFilters);
    expect(screen.queryByText(/results?$/)).toBeNull();
    expect(screen.getByLabelText("Search events").getAttribute("value")).toBe(
      "",
    );
    expect(
      screen.getByRole("combobox", { name: "Event type" }).textContent,
    ).toContain("All event types");
    expect(
      screen.getByRole("combobox", { name: "Outcome" }).textContent,
    ).toContain("All outcomes");
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
    expect(screen.getByText("3 results")).toBeTruthy();

    const outcome = screen.getByRole("combobox", { name: "Outcome" });
    await user.click(outcome);
    expect(screen.getByRole("option", { name: "Succeeded" })).toBeTruthy();
    fireEvent.pointerDown(screen.getByLabelText("Search events"));
    expect(screen.queryByRole("option", { name: "Succeeded" })).toBeNull();

    await user.click(outcome);
    await user.click(screen.getByRole("option", { name: "Failed" }));
    expect(screen.getByText("1 result")).toBeTruthy();
    expect(
      screen.getAllByText("Completed login challenge").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Changed member role")).toBeNull();
  });
});
