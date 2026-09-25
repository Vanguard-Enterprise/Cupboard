// @vitest-environment jsdom
import { previewStorageKey } from "./preview-storage";
import { render, testPreviewKey } from "@/test/preview-storage";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { OrganizationNotificationsData } from "./organization-notifications-data";
import {
  defaultOrganizationNotifications,
  organizationNotificationsKey as organizationNotificationsKeyBase,
} from "@/lib/organization-notifications";
import {
  defaultOrganizationProfile,
  organizationProfileKey as organizationProfileKeyBase,
} from "@/lib/organization-profile";
import { securityAlertStorageKey as securityAlertStorageKeyBase } from "@/lib/security-alerts";
import {
  defaultOrganizationIntegrations,
  organizationIntegrationsKey as organizationIntegrationsKeyBase,
} from "@/lib/organization-integrations";
import {
  navigationHref,
  notificationsDataPath,
} from "@/lib/dashboard-navigation";
import {
  defaultOrganizationAccess,
  organizationAccessKey as organizationAccessKeyBase,
} from "@/lib/organization-access";

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

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
        "Your saved profile, notification, approval, credential, webhook, and alert settings for this organization in this browser.",
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
    expect(
      screen.getByText(
        "Saved in this browser. Cupboard does not send notifications yet.",
      ),
    ).toBeTruthy();
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
    expect(screen.getByRole("status").textContent).toContain(
      "Preferences saved.",
    );

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
    expect(screen.getByRole("status").textContent).toContain(
      "Preferences saved.",
    );
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
    localStorage.setItem(
      organizationIntegrationsKey,
      JSON.stringify(defaultOrganizationIntegrations),
    );
    localStorage.setItem(securityAlertStorageKey, JSON.stringify(["SEC-2041"]));
    const savedAccess = structuredClone(defaultOrganizationAccess);
    savedAccess.rules[0].approvals = 2;
    localStorage.setItem(organizationAccessKey, JSON.stringify(savedAccess));
    localStorage.setItem("unrelated", "keep me");
    const untouchedKeys = [
      organizationProfileKeyBase,
      organizationNotificationsKeyBase,
      organizationIntegrationsKeyBase,
      organizationAccessKeyBase,
      securityAlertStorageKeyBase,
    ].flatMap((base) => [
      base,
      previewStorageKey("test-account", "other-org", base),
      previewStorageKey("other-account", "test-organization", base),
    ]);
    for (const key of untouchedKeys) localStorage.setItem(key, "keep me");
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
    expect(localStorage.getItem(organizationIntegrationsKey)).toBeNull();
    expect(localStorage.getItem(securityAlertStorageKey)).toBeNull();
    expect(localStorage.getItem(organizationAccessKey)).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep me");
    for (const key of untouchedKeys)
      expect(localStorage.getItem(key)).toBe("keep me");
    expect(toast.success).toHaveBeenCalledWith("Local data cleared.");
    expect(
      notificationSwitch("Weekly summary").getAttribute("data-state"),
    ).toBe("unchecked");
  });
});

const organizationProfileKey = testPreviewKey(organizationProfileKeyBase);

const organizationIntegrationsKey = testPreviewKey(
  organizationIntegrationsKeyBase,
);

const organizationNotificationsKey = testPreviewKey(
  organizationNotificationsKeyBase,
);

const organizationAccessKey = testPreviewKey(organizationAccessKeyBase);

const securityAlertStorageKey = testPreviewKey(securityAlertStorageKeyBase);
