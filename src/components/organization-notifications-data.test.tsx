import { organizationPreviewStorage } from "@/lib/organization-preview-storage";
import { implementedPages } from "@/lib/implemented-pages";
// @vitest-environment jsdom
import {
  dispatchCrossTab,
  dispatchSameTab,
  failStorage,
  removeRaw,
  seedRaw,
} from "@/test/browser-storage";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationNotificationsData } from "./organization-notifications-data";
import { defaultOrganizationNotifications } from "@/lib/organization-notifications";
import { defaultOrganizationProfile } from "@/lib/organization-profile";
import { defaultOrganizationIntegrations } from "@/lib/organization-integrations";
import { navigationHref } from "@/lib/dashboard-navigation";
import { defaultOrganizationAccess } from "@/lib/organization-access";

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
      organizationPreviewStorage.notifications.key,
      JSON.stringify(preferences),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: organizationPreviewStorage.notifications.key,
      }),
    );
  });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.cookie = "sidebar_state=; Max-Age=0";
});

describe("Organization notifications and data", () => {
  it("links the implemented navigation destination", () => {
    expect(navigationHref("preferences")).toBe(
      implementedPages["preferences"].href,
    );
    expect(implementedPages["preferences"].href).toBe(
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
        "Organization profile, notification, access, credential, webhook, and security alert acknowledgement data stored in this browser.",
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
      JSON.parse(
        localStorage.getItem(organizationPreviewStorage.notifications.key)!,
      ),
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
    localStorage.setItem(
      organizationPreviewStorage.notifications.key,
      "not-json",
    );
    const user = userEvent.setup();
    render(<OrganizationNotificationsData />);

    expect(screen.getByRole("alert").textContent).toContain(
      "could not be loaded",
    );
    expect(saveButton().disabled).toBe(false);
    expect(cancelButton().disabled).toBe(true);
    await user.click(saveButton());
    expect(
      JSON.parse(
        localStorage.getItem(organizationPreviewStorage.notifications.key)!,
      ),
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
      organizationPreviewStorage.profile.key,
      JSON.stringify({ ...defaultOrganizationProfile, name: "Saved org" }),
    );
    localStorage.setItem(
      organizationPreviewStorage.notifications.key,
      JSON.stringify({
        ...defaultOrganizationNotifications,
        weeklySummary: true,
      }),
    );
    localStorage.setItem(
      organizationPreviewStorage.integrations.key,
      JSON.stringify(defaultOrganizationIntegrations),
    );
    localStorage.setItem(
      organizationPreviewStorage.securityAlerts.key,
      JSON.stringify(["SEC-2041"]),
    );
    const savedAccess = structuredClone(defaultOrganizationAccess);
    savedAccess.rules[0].enabled = false;
    localStorage.setItem(
      organizationPreviewStorage.access.key,
      JSON.stringify(savedAccess),
    );
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

    expect(
      localStorage.getItem(organizationPreviewStorage.profile.key),
    ).toBeNull();
    expect(
      localStorage.getItem(organizationPreviewStorage.notifications.key),
    ).toBeNull();
    expect(
      localStorage.getItem(organizationPreviewStorage.integrations.key),
    ).toBeNull();
    expect(
      localStorage.getItem(organizationPreviewStorage.securityAlerts.key),
    ).toBeNull();
    expect(
      localStorage.getItem(organizationPreviewStorage.access.key),
    ).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep me");
    expect(screen.getByRole("status").textContent).toBe("Local data cleared.");
    expect(
      notificationSwitch("Weekly summary").getAttribute("data-state"),
    ).toBe("unchecked");
  });
});

describe("storage characterization", () => {
  it.each([null, "", "not-json", '{"invalid":true}'])(
    "preserves defaults and warning for %s",
    (raw) => {
      if (raw !== null)
        seedRaw(organizationPreviewStorage.notifications.key, raw);
      render(<OrganizationNotificationsData />);
      expect(
        notificationSwitch("Weekly summary").getAttribute("data-state"),
      ).toBe("unchecked");
      expect(Boolean(screen.queryByText(/Saved .* could not be loaded/))).toBe(
        Boolean(raw),
      );
    },
  );

  it.each(["getItem", "access"] as const)(
    "recovers from %s failure",
    (method) => {
      const raw = JSON.stringify({
        ...defaultOrganizationNotifications,
        weeklySummary: true,
      });
      seedRaw(organizationPreviewStorage.notifications.key, raw);
      const restore = failStorage(method);
      render(<OrganizationNotificationsData />);
      expect(screen.getByText(/Saved .* could not be loaded/)).toBeTruthy();
      expect(
        notificationSwitch("Weekly summary").getAttribute("data-state"),
      ).toBe("unchecked");
      restore();
      act(() =>
        dispatchSameTab(organizationPreviewStorage.notifications.changedEvent),
      );
      expect(
        notificationSwitch("Weekly summary").getAttribute("data-state"),
      ).toBe("checked");
      expect(screen.queryByText(/Saved .* could not be loaded/)).toBeNull();
    },
  );

  it.each(["same", "key", "clear"])(
    "observes %s events but ignores unrelated keys",
    (kind) => {
      render(<OrganizationNotificationsData />);
      const raw = JSON.stringify({
        ...defaultOrganizationNotifications,
        weeklySummary: true,
      });
      act(() => {
        seedRaw(organizationPreviewStorage.notifications.key, raw);
        dispatchCrossTab({ key: "unrelated", oldValue: null, newValue: raw });
      });
      expect(
        notificationSwitch("Weekly summary").getAttribute("data-state"),
      ).toBe("unchecked");
      act(() => {
        if (kind === "same")
          dispatchSameTab(
            organizationPreviewStorage.notifications.changedEvent,
          );
        else
          dispatchCrossTab({
            key:
              kind === "clear"
                ? null
                : organizationPreviewStorage.notifications.key,
            oldValue: null,
            newValue: raw,
          });
      });
      expect(
        notificationSwitch("Weekly summary").getAttribute("data-state"),
      ).toBe("checked");
      act(() => {
        removeRaw(organizationPreviewStorage.notifications.key);
        dispatchCrossTab({ key: null, oldValue: raw, newValue: null });
      });
      expect(
        notificationSwitch("Weekly summary").getAttribute("data-state"),
      ).toBe("unchecked");
    },
  );
});

const clearKeys = [
  "cupboard:organization:local-preview:profile:v1",
  "cupboard:organization:local-preview:notifications:v1",
  "cupboard:organization:local-preview:integrations:v1",
  "cupboard:organization:local-preview:access:v1",
  "cupboard:organization:local-preview:security-alerts:v1",
];
const clearTrace = [
  ...clearKeys.slice(0, 4).map((key) => `remove:${key}`),
  "event:cupboard-profile-saved",
  "event:cupboard-notifications-saved",
  "event:cupboard-integrations-saved",
  `remove:${clearKeys[4]}`,
  "event:cupboard-security-alerts-saved",
  "event:cupboard-access-saved",
];

it.each([0, 1, 2, 3, 4, null])(
  "preserves clear ordering and partial progress at removal %s",
  async (failure) => {
    expect(
      Object.values(organizationPreviewStorage).map(({ key }) => key),
    ).toEqual(clearKeys);
    for (const key of clearKeys) seedRaw(key, "{}");
    seedRaw(
      organizationPreviewStorage.notifications.key,
      JSON.stringify(defaultOrganizationNotifications),
    );
    seedRaw("unrelated", "keep");
    seedRaw("cupboard:organization:local-preview:unregistered:v1", "keep");
    document.cookie = "sidebar_state=false";
    const originals = clearKeys.map((key) => localStorage.getItem(key));
    const user = userEvent.setup();
    render(<OrganizationNotificationsData />);
    await user.click(notificationSwitch("Weekly summary"));
    const editor = notificationSwitch("Weekly summary");
    const trace: string[] = [];
    const remove = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
      this: Storage,
      key,
    ) {
      trace.push(`remove:${key}`);
      if (failure !== null && key === clearKeys[failure])
        throw new Error("Unavailable");
      remove.call(this, key);
    });
    const dispatch = window.dispatchEvent.bind(window);
    vi.spyOn(window, "dispatchEvent").mockImplementation((event) => {
      if (event.type.startsWith("cupboard-")) trace.push(`event:${event.type}`);
      return dispatch(event);
    });
    await user.click(screen.getByRole("button", { name: "Clear local data" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Clear local data",
      }),
    );
    const expected =
      failure === null
        ? clearTrace
        : clearTrace.slice(
            0,
            clearTrace.indexOf(`remove:${clearKeys[failure]}`) + 1,
          );
    expect(trace).toEqual(expected);
    clearKeys.forEach((key, index) =>
      expect(localStorage.getItem(key)).toBe(
        failure === null || index < failure ? null : originals[index],
      ),
    );
    expect(localStorage.getItem("unrelated")).toBe("keep");
    expect(
      localStorage.getItem(
        "cupboard:organization:local-preview:unregistered:v1",
      ),
    ).toBe("keep");
    expect(document.cookie).toContain("sidebar_state=false");
    if (failure !== null) {
      expect(
        screen.getByText("Could not clear local data. Please try again."),
      ).toBeTruthy();
      expect(screen.queryByText("Local data cleared.")).toBeNull();
      expect(notificationSwitch("Weekly summary")).toBe(editor);
      expect(editor.getAttribute("data-state")).toBe("checked");
    } else {
      expect(screen.getByText("Local data cleared.")).toBeTruthy();
      expect(notificationSwitch("Weekly summary")).not.toBe(editor);
    }
  },
);
