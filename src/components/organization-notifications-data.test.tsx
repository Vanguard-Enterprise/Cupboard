// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationNotificationsData } from "./organization-notifications-data";
import {
  defaultOrganizationNotifications,
  organizationNotificationsKey,
} from "@/lib/organization-notifications";
import {
  defaultOrganizationProfile,
  organizationProfileKey,
} from "@/lib/organization-profile";
import { securityAlertStorageKey } from "@/lib/security-alerts";
import {
  navigationHref,
  notificationsDataPath,
} from "@/lib/dashboard-navigation";
import {
  defaultOrganizationAccess,
  organizationAccessKey,
} from "@/lib/organization-access";

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

beforeEach(() => localStorage.clear());
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

  it("uses two compact settings sections without the preview banner", () => {
    render(<OrganizationNotificationsData />);

    expect(
      screen.getByRole("region", { name: "Notification preferences" }),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Local data" })).toBeTruthy();
    expect(screen.queryByText("Local preview")).toBeNull();
    expect(
      screen.queryByText(
        "Choose which organization events should reach your email.",
      ),
    ).toBeNull();
    expect(screen.getByText("Organization data")).toBeTruthy();
    expect(
      screen.getByText(
        "Profile, notification, access, and alert acknowledgement data stored in this browser.",
      ),
    ).toBeTruthy();
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
    expect(screen.getAllByText(/Does not send email yet/)).toHaveLength(4);
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

    await user.click(notificationSwitch("Weekly summary"));
    expect(saveButton().disabled).toBe(false);
    expect(cancelButton().disabled).toBe(false);
    await user.click(cancelButton());
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
    expect(screen.getByRole("status").textContent).toBe("Preferences saved.");

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

    expect(screen.getByRole("alert").textContent).toContain(
      "changed in another tab",
    );
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

    expect(screen.getByRole("alert").textContent).toContain(
      "could not be loaded",
    );
    expect(saveButton().disabled).toBe(false);
    expect(cancelButton().disabled).toBe(true);
    await user.click(saveButton());
    expect(
      JSON.parse(localStorage.getItem(organizationNotificationsKey)!),
    ).toEqual(defaultOrganizationNotifications);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Preferences saved.");
  });

  it("keeps an unsaved choice when browser storage rejects a save", async () => {
    const user = userEvent.setup();
    render(<OrganizationNotificationsData />);
    await user.click(notificationSwitch("Weekly summary"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });

    await user.click(saveButton());
    expect(screen.getByRole("alert").textContent).toContain("Could not save");
    expect(
      notificationSwitch("Weekly summary").getAttribute("data-state"),
    ).toBe("checked");
    expect(saveButton().disabled).toBe(false);
  });

  it("confirms and clears only Cupboard organization preview data", async () => {
    localStorage.setItem(
      organizationProfileKey,
      JSON.stringify({ ...defaultOrganizationProfile, name: "Saved org" }),
    );
    localStorage.setItem(
      organizationNotificationsKey,
      JSON.stringify({
        ...defaultOrganizationNotifications,
        weeklySummary: true,
      }),
    );
    localStorage.setItem(securityAlertStorageKey, JSON.stringify(["SEC-2041"]));
    const savedAccess = structuredClone(defaultOrganizationAccess);
    savedAccess.rules[0].enabled = false;
    localStorage.setItem(organizationAccessKey, JSON.stringify(savedAccess));
    localStorage.setItem("unrelated", "keep me");
    const user = userEvent.setup();
    render(<OrganizationNotificationsData />);

    await user.click(screen.getByRole("button", { name: "Clear local data" }));
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText(/You cannot undo this action/),
    ).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Clear local data" }),
    );

    expect(localStorage.getItem(organizationProfileKey)).toBeNull();
    expect(localStorage.getItem(organizationNotificationsKey)).toBeNull();
    expect(localStorage.getItem(securityAlertStorageKey)).toBeNull();
    expect(localStorage.getItem(organizationAccessKey)).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep me");
    expect(screen.getByRole("status").textContent).toBe("Local data cleared.");
    expect(
      notificationSwitch("Weekly summary").getAttribute("data-state"),
    ).toBe("unchecked");
  });
});
