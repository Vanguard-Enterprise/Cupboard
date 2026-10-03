// @vitest-environment jsdom
import { render, testPreviewKey } from "@/test/preview-storage";
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { SecurityAlerts } from "./security-alerts";
import { securityAlertStorageKey as securityAlertStorageKeyBase } from "@/lib/security-alerts";

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Security alerts", () => {
  it("shows sample alerts and switches the evidence panel", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    await user.click(screen.getByRole("tab", { name: /^All / }));

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
    await user.click(screen.getByRole("tab", { name: /^All / }));

    const search = screen.getByRole("searchbox", { name: "Search alerts" });
    await user.type(search, "Dustbowl");
    expect(screen.getByText(/^1 alert/)).toBeTruthy();
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
    expect(screen.getByText(/^1 alert/)).toBeTruthy();
    expect(
      screen.queryByText("Console password has not been rotated"),
    ).toBeNull();

    await user.click(
      screen.getByRole("combobox", { name: "Filter by severity" }),
    );
    await user.click(screen.getByRole("option", { name: "All severities" }));
    await user.click(screen.getByRole("tab", { name: /^Acknowledged / }));
    expect(screen.getByText(/^1 alert/)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Webhook secret is stored in a host file/i,
      }),
    ).toBeTruthy();
  });

  it("acknowledges and reopens an alert in browser storage", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    await user.click(screen.getByRole("tab", { name: /^All / }));

    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));
    expect(toast.success).toHaveBeenCalledWith("Alert acknowledged.");
    expect(
      JSON.parse(localStorage.getItem(securityAlertStorageKey)!),
    ).toContain("SEC-2041");

    await user.click(
      screen.getByRole("button", { name: "Mark as needs review" }),
    );
    expect(toast.success).toHaveBeenCalledWith("Alert marked as needs review.");
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
    await user.click(screen.getByRole("tab", { name: /^All / }));

    await user.click(screen.getByRole("tab", { name: /^Needs review / }));
    await user.click(
      screen.getByRole("combobox", { name: "Filter by severity" }),
    );
    await user.click(screen.getByRole("option", { name: "Critical" }));

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });

    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));
    expect(screen.getByText("No matching alerts")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: /^Needs review / }),
    );
    const storageAlert = screen.getByRole("alert");
    expect(storageAlert.getAttribute("data-slot")).toBe("alert");
    expect(storageAlert.textContent).toContain("could not be saved");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("merges a failed acknowledgement with later cross-tab changes", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    await user.click(screen.getByRole("tab", { name: /^All / }));
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("Storage unavailable");
      });

    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));
    expect(
      screen.getByRole("button", { name: "Mark as needs review" }),
    ).toBeTruthy();
    setItem.mockRestore();

    act(() => {
      localStorage.setItem(
        securityAlertStorageKey,
        JSON.stringify(["SEC-2017", "SEC-2038"]),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: securityAlertStorageKey }),
      );
    });

    expect(
      screen.getByRole("button", { name: "Mark as needs review" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", {
        name: /Console password has not been rotated/i,
      }),
    );
    expect(
      screen.getByRole("button", { name: "Mark as needs review" }),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Mark as needs review" }),
    );
    expect(JSON.parse(localStorage.getItem(securityAlertStorageKey)!)).toEqual([
      "SEC-2017",
      "SEC-2041",
    ]);
  });

  it("preserves a failed reopen while merging cross-tab changes", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    await user.click(screen.getByRole("tab", { name: /^All / }));
    await user.click(
      screen.getByRole("button", {
        name: /Webhook secret is stored in a host file/i,
      }),
    );
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("Storage unavailable");
      });

    await user.click(
      screen.getByRole("button", { name: "Mark as needs review" }),
    );
    expect(
      screen.getByRole("button", { name: "Acknowledge alert" }),
    ).toBeTruthy();
    setItem.mockRestore();

    act(() => {
      localStorage.setItem(
        securityAlertStorageKey,
        JSON.stringify(["SEC-2017", "SEC-2038"]),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: securityAlertStorageKey }),
      );
    });

    expect(
      screen.getByRole("button", { name: "Acknowledge alert" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", {
        name: /Console password has not been rotated/i,
      }),
    );
    expect(
      screen.getByRole("button", { name: "Mark as needs review" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Mark as needs review" }),
    );
    expect(JSON.parse(localStorage.getItem(securityAlertStorageKey)!)).toEqual(
      [],
    );
  });

  it("retires a failed override after persisted state catches up", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    await user.click(screen.getByRole("tab", { name: /^All / }));
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("Storage unavailable");
      });

    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    setItem.mockRestore();

    act(() => {
      localStorage.setItem(
        securityAlertStorageKey,
        JSON.stringify(["SEC-2017", "SEC-2041"]),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: securityAlertStorageKey }),
      );
    });
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => {
      localStorage.setItem(
        securityAlertStorageKey,
        JSON.stringify(["SEC-2017"]),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: securityAlertStorageKey }),
      );
    });
    expect(
      screen.getByRole("button", { name: "Acknowledge alert" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(
      screen.getByRole("button", {
        name: /Console password has not been rotated/i,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));
    expect(JSON.parse(localStorage.getItem(securityAlertStorageKey)!)).toEqual([
      "SEC-2017",
      "SEC-2038",
    ]);
  });

  it("moves focus to the next alert when a filtered acknowledgement removes the selection", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    await user.click(screen.getByRole("tab", { name: /^All / }));

    await user.click(screen.getByRole("tab", { name: /^Needs review / }));
    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));

    const nextAlert = screen.getByRole("button", {
      name: /Console password has not been rotated/i,
    });
    expect(document.activeElement).toBe(nextAlert);
    expect(screen.getByText("SEC-2038")).toBeTruthy();
  });

  it("restores row focus after a cross-tab acknowledgement removes the focused alert", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    await user.click(screen.getByRole("tab", { name: /^All / }));

    await user.click(screen.getByRole("tab", { name: /^Needs review / }));

    const focusedAlert = screen.getByRole("button", {
      name: /RCON endpoint accepts public connections/i,
    });
    focusedAlert.focus();

    act(() => {
      localStorage.setItem(
        securityAlertStorageKey,
        JSON.stringify(["SEC-2017", "SEC-2041"]),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: securityAlertStorageKey }),
      );
    });

    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: /Console password has not been rotated/i,
      }),
    );
    expect(screen.getByText("SEC-2038")).toBeTruthy();
  });

  it("restores filter focus when a cross-tab acknowledgement empties the queue", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    await user.click(screen.getByRole("tab", { name: /^All / }));

    await user.click(screen.getByRole("tab", { name: /^Needs review / }));
    await user.click(
      screen.getByRole("combobox", { name: "Filter by severity" }),
    );
    await user.click(screen.getByRole("option", { name: "Critical" }));

    screen
      .getByRole("button", {
        name: /RCON endpoint accepts public connections/i,
      })
      .focus();

    act(() => {
      localStorage.setItem(
        securityAlertStorageKey,
        JSON.stringify(["SEC-2017", "SEC-2041"]),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: securityAlertStorageKey }),
      );
    });

    expect(screen.getByText("No matching alerts")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: /^Needs review / }),
    );
  });

  it("restores filter focus when an external update removes the focused detail", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    await user.click(screen.getByRole("tab", { name: /^All / }));

    await user.click(screen.getByRole("tab", { name: /^Needs review / }));
    await user.click(
      screen.getByRole("combobox", { name: "Filter by severity" }),
    );
    await user.click(screen.getByRole("option", { name: "Critical" }));
    screen.getByRole("button", { name: "Acknowledge alert" }).focus();

    act(() => {
      localStorage.setItem(
        securityAlertStorageKey,
        JSON.stringify(["SEC-2017", "SEC-2041"]),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: securityAlertStorageKey }),
      );
    });

    expect(screen.getByText("No matching alerts")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: /^Needs review / }),
    );
  });

  it("brings the selected detail into view on narrow screens", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    await user.click(screen.getByRole("tab", { name: /^All / }));

    await user.click(
      screen.getByRole("button", {
        name: /Console password has not been rotated/i,
      }),
    );

    const detail = screen.getByRole("article", {
      name: /Console password has not been rotated/i,
    });
    expect(document.activeElement).toBe(detail);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "start",
    });
  });

  it("keeps a failed-save warning visible during alert navigation", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    await user.click(screen.getByRole("tab", { name: /^All / }));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });

    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));
    await user.click(
      screen.getByRole("button", {
        name: /Console password has not been rotated/i,
      }),
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "could not be saved",
    );
  });
});

const securityAlertStorageKey = testPreviewKey(securityAlertStorageKeyBase);

describe("Security alert triage", () => {
  it("starts with needs review and keeps risk totals after acknowledgement", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    expect(
      screen
        .getByRole("tab", { name: "Needs review 4" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByText("Last evaluation")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));
    expect(screen.getByRole("tab", { name: "Needs review 3" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Acknowledged 2" })).toBeTruthy();
    expect(
      screen.getByText("Critical findings").nextElementSibling?.textContent,
    ).toBe("1");
    expect(
      screen.getByText("Affected servers").nextElementSibling?.textContent,
    ).toBe("4");
  });

  it("combines server and severity filters and resets them without changing status", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    await user.click(
      screen.getByRole("combobox", { name: "Filter by server" }),
    );
    await user.click(screen.getByRole("option", { name: "Rusthaven Main" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await user.click(
      screen.getByRole("combobox", { name: "Filter by severity" }),
    );
    await user.click(screen.getByRole("option", { name: "Low" }));
    expect(screen.getByText("No matching alerts")).toBeTruthy();
    expect(screen.queryByText("No alert selected")).toBeNull();
    await user.click(
      screen.getAllByRole("button", { name: "Clear filters" })[1],
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Needs review 4" }),
    );
  });

  it("distinguishes a reviewed queue from a search with no matches", async () => {
    localStorage.setItem(
      securityAlertStorageKey,
      JSON.stringify([
        "SEC-2041",
        "SEC-2038",
        "SEC-2032",
        "SEC-2017",
        "SEC-1984",
      ]),
    );
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    expect(screen.getByText("No alerts need review")).toBeTruthy();
    expect(screen.getByText(/They may still need a fix/)).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "View acknowledged alerts" }),
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    await user.type(
      screen.getByRole("searchbox", { name: "Search alerts" }),
      "no-such-server",
    );
    expect(screen.getByText("No matching alerts")).toBeTruthy();
  });

  it("supports keyboard status navigation", async () => {
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    screen.getByRole("tab", { name: "Needs review 4" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(
      screen
        .getByRole("tab", { name: "Acknowledged 1" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    await user.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("tab", { name: "All 5" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("returns mobile focus to the selected row, then advances after acknowledgement", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const user = userEvent.setup();
    render(<SecurityAlerts />);
    const row = screen.getByRole("button", {
      name: /RCON endpoint accepts public connections/,
    });
    await user.click(row);
    expect(document.activeElement).toBe(screen.getByRole("article"));
    await user.click(screen.getByRole("button", { name: "Back to alerts" }));
    expect(document.activeElement).toBe(row);
    await user.click(row);
    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: /Console password has not been rotated/,
      }),
    );
  });
});

it("returns to the mobile queue when another tab acknowledges the selected alert", async () => {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
  const user = userEvent.setup();
  render(<SecurityAlerts />);
  await user.click(
    screen.getByRole("button", {
      name: /RCON endpoint accepts public connections/,
    }),
  );
  expect(document.activeElement).toBe(screen.getByRole("article"));
  act(() => {
    localStorage.setItem(
      securityAlertStorageKey,
      JSON.stringify(["SEC-2017", "SEC-2041"]),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: securityAlertStorageKey }),
    );
  });
  expect(document.activeElement).toBe(
    screen.getByRole("button", {
      name: /Console password has not been rotated/,
    }),
  );
  await user.click(screen.getByRole("tab", { name: "Acknowledged 2" }));
  await user.click(
    screen.getByRole("button", {
      name: /RCON endpoint accepts public connections/,
    }),
  );
  expect(document.activeElement).toBe(screen.getByRole("article"));
});
