// @vitest-environment jsdom
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationAlerts } from "./organization-alerts";
import { apiRequest, type Identity } from "@/lib/api-client";
import type { AlertState } from "@/lib/alerts";
import { toast } from "sonner";

vi.mock("@/lib/api-client", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const identity: Identity = {
  user: { id: "operator", name: "Operator", email: "operator@example.com" },
  organization: { id: "org-one", name: "Northstar Games" },
  organizations: [],
  membershipId: "member",
  permissions: ["organization.manage"],
};
const channel = {
  id: "channel-a",
  kind: "discord" as const,
  name: "#server-alerts",
  destination: "Webhook ending 5678",
  createdAt: 1,
  lastDeliveryAt: null,
  lastDeliveryOk: null,
  lastError: null,
};
const empty: AlertState = {
  revision: 0,
  retentionDays: 30,
  routes: {},
  channels: [],
  events: [],
};
const withChannel: AlertState = {
  ...empty,
  revision: 1,
  routes: { "server.offline": ["channel-a"] },
  channels: [channel],
  events: [
    {
      id: "event-1",
      event: "server.offline",
      severity: "critical",
      title: "Rust EU is offline",
      detail: "RCON and A2S health checks both failed.",
      createdAt: Date.now() - 60_000,
      deliveries: [
        {
          channelId: "channel-a",
          status: "pending",
          attempts: 1,
          error: "The destination is unavailable (HTTP 503).",
          completedAt: null,
          channelName: "#old-alerts",
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const mount = (who = identity) =>
  render(
    <TooltipProvider>
      <OrganizationAlerts identity={who} />
    </TooltipProvider>,
  );
const ready = () =>
  waitFor(() => expect(screen.queryByLabelText("Loading alerts")).toBeNull());

describe("Organization alerts", () => {
  it("explains the empty state and lists every alert Cupboard can send", async () => {
    vi.mocked(apiRequest).mockResolvedValue(empty);
    mount();
    await ready();
    expect(apiRequest).toHaveBeenCalledWith("alerts", undefined, "org-one");
    expect(screen.getByText("No channels yet")).toBeTruthy();
    expect(screen.getByText("No alerts yet")).toBeTruthy();
    for (const title of [
      "Server offline",
      "Machine stopped reporting",
      "Pelican check failed",
      "Member removed",
    ])
      expect(
        screen.getByRole("rowheader", { name: new RegExp(title) }),
      ).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("requires organization management without requesting alert data", () => {
    mount({ ...identity, permissions: ["servers.view"] });
    expect(screen.getByText("Organization management required")).toBeTruthy();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("saves routing and retention with the loaded revision", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockImplementation(async (path, body) =>
      path === "alerts/settings"
        ? {
            ...withChannel,
            revision: 2,
            routes: (body as { routes: AlertState["routes"] }).routes,
          }
        : withChannel,
    );
    mount();
    await ready();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    const box = screen.getByRole("checkbox", {
      name: "Send Machine stopped reporting to #server-alerts",
    });
    await user.click(box);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        "alerts/settings",
        {
          revision: 1,
          routes: {
            "machine.offline": ["channel-a"],
            "server.offline": ["channel-a"],
          },
          retentionDays: 30,
        },
        "org-one",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("Unsaved changes")).toBeNull(),
    );
    expect(toast.success).toHaveBeenCalledWith("Alert settings saved.");
  });

  it("shows delivery history with retry details", async () => {
    vi.mocked(apiRequest).mockResolvedValue(withChannel);
    mount();
    await ready();
    const history = screen.getByRole("region", { name: "Recent alerts" });
    expect(within(history).getByText("Rust EU is offline")).toBeTruthy();
    expect(within(history).getByText("Critical")).toBeTruthy();
    expect(within(history).getByText("Retrying")).toBeTruthy();
  });

  it("adds a webhook and reveals its signing secret once", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockImplementation(async (path) =>
      path === "alerts/channels"
        ? {
            alerts: {
              ...withChannel,
              revision: 2,
              channels: [
                channel,
                {
                  ...channel,
                  id: "channel-b",
                  kind: "webhook",
                  name: "Pager",
                  destination: "hooks.example.com",
                },
              ],
            },
            signingSecret: "whsec_example",
          }
        : withChannel,
    );
    mount();
    await ready();
    await user.click(screen.getByRole("button", { name: "Add channel" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /Webhook/ }));
    await user.click(
      within(dialog).getByRole("button", { name: "Add channel" }),
    );
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "Enter a channel name.",
    );
    await user.type(within(dialog).getByLabelText("Name"), "Pager");
    await user.type(
      within(dialog).getByLabelText("Endpoint URL"),
      "https://hooks.example.com/cupboard",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Add channel" }),
    );
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        "alerts/channels",
        {
          revision: 1,
          kind: "webhook",
          name: "Pager",
          url: "https://hooks.example.com/cupboard",
        },
        "org-one",
      ),
    );
    const secret = await screen.findByRole("dialog", {
      name: "Save the signing secret",
    });
    expect(
      (within(secret).getByLabelText("Signing secret") as HTMLInputElement)
        .value,
    ).toBe("whsec_example");
    // The secret is shown once, so only an explicit choice dismisses it.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    await user.click(within(secret).getByRole("button", { name: "Copy" }));
    expect(toast.error).toHaveBeenCalledWith(
      "Copy is unavailable here. Select the secret.",
    );
    vi.stubGlobal("navigator", navigator);
    await user.click(within(secret).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByDisplayValue("whsec_example")).toBeNull();
    expect(screen.getByRole("heading", { name: "Pager" })).toBeTruthy();
  });

  it("sends a test alert and reports a failed delivery", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockImplementation(async (path) =>
      path.endsWith("/test")
        ? {
            alerts: withChannel,
            delivered: false,
            error: "The destination rejected the alert (HTTP 404).",
          }
        : withChannel,
    );
    mount();
    await ready();
    await user.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "#server-alerts did not accept the test alert. The destination rejected the alert (HTTP 404).",
      ),
    );
    expect(apiRequest).toHaveBeenCalledWith(
      "alerts/channels/channel-a/test",
      {},
      "org-one",
    );
  });

  it("names the channel saved with each delivery", async () => {
    vi.mocked(apiRequest).mockResolvedValue(withChannel);
    mount();
    await ready();
    expect(screen.getByText("#old-alerts")).toBeTruthy();
  });

  it("rotates a webhook secret after confirmation and shows it once", async () => {
    const user = userEvent.setup();
    const webhook = { ...channel, kind: "webhook" as const };
    const state = { ...withChannel, channels: [webhook] };
    vi.mocked(apiRequest).mockImplementation(async (path) =>
      path.endsWith("/rotate")
        ? { alerts: state, signingSecret: "whsec_rotated" }
        : state,
    );
    mount();
    await ready();
    await user.click(
      screen.getByRole("button", { name: "#server-alerts actions" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Rotate signing secret" }),
    );
    const confirm = screen.getByRole("alertdialog");
    expect(confirm.textContent).toContain("update your receiver");
    await user.click(
      within(confirm).getByRole("button", { name: "Rotate secret" }),
    );
    const secret = await screen.findByRole("dialog", {
      name: "Save the signing secret",
    });
    expect(
      (within(secret).getByLabelText("Signing secret") as HTMLInputElement)
        .value,
    ).toBe("whsec_rotated");
    expect(apiRequest).toHaveBeenCalledWith(
      "alerts/channels/channel-a/rotate",
      { revision: 1 },
      "org-one",
    );
  });

  it("offers rotation only for webhooks", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(withChannel);
    mount();
    await ready();
    await user.click(
      screen.getByRole("button", { name: "#server-alerts actions" }),
    );
    await screen.findByRole("menuitem", { name: "Remove" });
    expect(
      screen.queryByRole("menuitem", { name: "Rotate signing secret" }),
    ).toBeNull();
  });

  it("requires every exported section's permission to download", async () => {
    vi.mocked(apiRequest).mockResolvedValue(withChannel);
    const first = mount();
    await ready();
    const button = () =>
      screen.getByRole("button", {
        name: "Download export",
      }) as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    first.unmount();
    mount({
      ...identity,
      permissions: [
        "organization.manage",
        "servers.view",
        "infrastructure.view",
        "integrations.manage",
      ],
    });
    await ready();
    expect(button().disabled).toBe(false);
  });

  it("confirms channel removal with its consequences", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockImplementation(async (path) =>
      path.endsWith("/remove") ? empty : withChannel,
    );
    mount();
    await ready();
    await user.click(
      screen.getByRole("button", { name: "#server-alerts actions" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const confirm = screen.getByRole("alertdialog");
    expect(confirm.textContent).toContain("cancels deliveries");
    await user.click(
      within(confirm).getByRole("button", { name: "Remove channel" }),
    );
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        "alerts/channels/channel-a/remove",
        { revision: 1 },
        "org-one",
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("No channels yet")).toBeTruthy(),
    );
  });
});
