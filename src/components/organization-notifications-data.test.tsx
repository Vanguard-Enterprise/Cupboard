// @vitest-environment jsdom
import { render, testPreviewKey } from "@/test/preview-storage";
import { act, cleanup, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationNotificationsData } from "./organization-notifications-data";
import {
  defaultOrganizationNotifications,
  organizationNotificationsKey as organizationNotificationsKeyBase,
} from "@/lib/organization-notifications";
import {
  navigationHref,
  notificationsDataPath,
} from "@/lib/dashboard-navigation";
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const saveButton = () =>
  screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
const cancelButton = () =>
  screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
const notificationSwitch = (name: string) =>
  screen.getByRole("switch", { name }) as HTMLButtonElement;

function externalSave(preferences: typeof defaultOrganizationNotifications) {
  act(() => {
    localStorage.setItem(
      organizationNotificationsKey,
      JSON.stringify(preferences),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: organizationNotificationsKey }),
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Organization notifications and data", () => {
  it("links the implemented navigation destination", () => {
    expect(navigationHref("preferences")).toBe(notificationsDataPath);
    expect(notificationsDataPath).toBe(
      "/dashboard/organization/settings/notifications-data",
    );
  });

  it("groups alerts and summaries", () => {
    render(<OrganizationNotificationsData />);

    expect(
      screen.getByRole("region", { name: "Notification preferences" }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Browser data" })).toBeNull();
    expect(screen.queryByText("Local preview")).toBeNull();
    const alerts = screen.getByRole("group", { name: "Operational alerts" });
    const summaries = screen.getByRole("group", { name: "Summaries" });
    expect(within(alerts).getAllByRole("switch")).toHaveLength(3);
    expect(
      within(summaries).getByRole("switch", { name: "Weekly summary" }),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Choose which organization events should reach your email.",
      ),
    ).toBeNull();
    for (const name of [
      "Server incidents",
      "Security alerts",
      "Moderation activity",
      "Weekly summary",
    ]) {
      const preference = notificationSwitch(name);
      expect(preference.getAttribute("data-size")).toBe("lg");
      expect(preference.getAttribute("data-state")).toBe("unchecked");
    }
    expect(screen.getByText("Server outages and incidents.")).toBeTruthy();
  });

  it("saves, restores, and cancels notification choices", async () => {
    const user = userEvent.setup();
    const view = render(<OrganizationNotificationsData />);

    expect(
      notificationSwitch("Server incidents").getAttribute("data-state"),
    ).toBe("unchecked");
    expect(
      notificationSwitch("Weekly summary").getAttribute("data-state"),
    ).toBe("unchecked");
    expect(saveButton().disabled).toBe(true);
    expect(cancelButton().disabled).toBe(true);

    notificationSwitch("Weekly summary").focus();
    await user.keyboard(" ");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
    expect(cancelButton().disabled).toBe(false);
    await user.click(cancelButton());
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(
      notificationSwitch("Weekly summary").getAttribute("data-state"),
    ).toBe("unchecked");
    expect(saveButton().disabled).toBe(true);
    expect(cancelButton().disabled).toBe(true);

    await user.click(notificationSwitch("Weekly summary"));
    await user.click(saveButton());
    expect(
      JSON.parse(localStorage.getItem(organizationNotificationsKey)!),
    ).toMatchObject({ weeklySummary: true });
    expect(toast.success).toHaveBeenCalledWith("Preferences saved.");

    view.unmount();
    render(<OrganizationNotificationsData />);
    expect(
      notificationSwitch("Weekly summary").getAttribute("data-state"),
    ).toBe("checked");
  });

  it("blocks a stale save until Cancel loads choices from another tab", async () => {
    const user = userEvent.setup();
    render(<OrganizationNotificationsData />);

    await user.click(notificationSwitch("Weekly summary"));
    externalSave({
      ...defaultOrganizationNotifications,
      securityAlerts: false,
    });

    const conflictAlert = screen.getByRole("alert");
    expect(conflictAlert.getAttribute("data-slot")).toBe("alert");
    expect(conflictAlert.textContent).toContain("changed in another tab");
    expect(saveButton().disabled).toBe(true);
    await user.click(cancelButton());
    expect(
      notificationSwitch("Security alerts").getAttribute("data-state"),
    ).toBe("unchecked");
    expect(
      notificationSwitch("Weekly summary").getAttribute("data-state"),
    ).toBe("unchecked");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports unreadable data and replaces it when the operator saves", async () => {
    localStorage.setItem(organizationNotificationsKey, "not-json");
    const user = userEvent.setup();
    render(<OrganizationNotificationsData />);

    const unreadableAlert = screen.getByRole("alert");
    expect(unreadableAlert.getAttribute("data-slot")).toBe("alert");
    expect(unreadableAlert.textContent).toContain("could not be loaded");
    expect(saveButton().disabled).toBe(false);
    expect(cancelButton().disabled).toBe(true);
    await user.click(saveButton());
    expect(
      JSON.parse(localStorage.getItem(organizationNotificationsKey)!),
    ).toEqual(defaultOrganizationNotifications);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Preferences saved.");
  });

  it("keeps an unsaved choice when browser storage rejects a save", async () => {
    const user = userEvent.setup();
    render(<OrganizationNotificationsData />);
    await user.click(notificationSwitch("Weekly summary"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });

    await user.click(saveButton());
    const saveAlert = screen.getByRole("alert");
    expect(saveAlert.getAttribute("data-slot")).toBe("alert");
    expect(saveAlert.textContent).toContain("Could not save");
    expect(screen.queryByRole("status")).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
    expect(
      notificationSwitch("Weekly summary").getAttribute("data-state"),
    ).toBe("checked");
    expect(saveButton().disabled).toBe(false);
  });
});

const organizationNotificationsKey = testPreviewKey(
  organizationNotificationsKeyBase,
);
