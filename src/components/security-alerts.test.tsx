// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecurityAlerts } from "./security-alerts";
import { securityAlertStorageKey } from "@/lib/security-alerts";

beforeEach(() => {
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Security alerts", () => {
  it("shows sample alerts and switches the evidence panel", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);

    expect(screen.getByText("SEC-2041")).toBeTruthy();
    expect(
      screen.getByText(/accepted a connection from outside the organization/i),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", {
        name: /Console password has not been rotated/i,
      }),
    );
    expect(screen.getByText("SEC-2038")).toBeTruthy();
    expect(
      screen.getByText(/stored RCON credential is 186 days old/i),
    ).toBeTruthy();
  });

  it("filters alerts by search and severity", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);

    const search = screen.getByRole("searchbox", { name: "Search alerts" });
    await user.type(search, "Dustbowl");
    expect(screen.getByText("1 alert")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Console password has not been rotated/i,
      }),
    ).toBeTruthy();

    await user.clear(search);
    await user.click(
      screen.getByRole("combobox", { name: "Filter by severity" }),
    );
    await user.click(screen.getByRole("option", { name: "Critical" }));
    expect(screen.getByText("1 alert")).toBeTruthy();
    expect(
      screen.queryByText("Console password has not been rotated"),
    ).toBeNull();

    await user.click(
      screen.getByRole("combobox", { name: "Filter by severity" }),
    );
    await user.click(screen.getByRole("option", { name: "All severities" }));
    await user.click(
      screen.getByRole("combobox", { name: "Filter by status" }),
    );
    await user.click(screen.getByRole("option", { name: "Acknowledged" }));
    expect(screen.getByText("1 alert")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Webhook secret is stored in a host file/i,
      }),
    ).toBeTruthy();
  });

  it("acknowledges and reopens an alert in browser storage", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);

    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));
    expect(screen.getByRole("status").textContent).toContain(
      "Alert acknowledged.",
    );
    expect(
      JSON.parse(localStorage.getItem(securityAlertStorageKey)!),
    ).toContain("SEC-2041");

    await user.click(screen.getByRole("button", { name: "Reopen alert" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Acknowledge alert" }),
    ).toBeTruthy();
    expect(
      JSON.parse(localStorage.getItem(securityAlertStorageKey)!),
    ).not.toContain("SEC-2041");
  });

  it("keeps the acknowledgement in memory when browser storage fails", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);

    await user.click(
      screen.getByRole("combobox", { name: "Filter by status" }),
    );
    await user.click(screen.getByRole("option", { name: "Open" }));
    await user.click(
      screen.getByRole("combobox", { name: "Filter by severity" }),
    );
    await user.click(screen.getByRole("option", { name: "Critical" }));

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });

    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));
    expect(screen.getByText("No matching alerts")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be saved",
    );
  });
});
