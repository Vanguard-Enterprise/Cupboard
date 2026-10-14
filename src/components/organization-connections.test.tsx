import { TooltipProvider } from "@/components/ui/tooltip";
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationConnections } from "./organization-connections";
import { apiRequest, type Identity } from "@/lib/api-client";
import type { PelicanConnection } from "@/lib/pelican";

vi.mock("@/lib/api-client", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
const identity: Identity = {
  user: { id: "operator", name: "Operator", email: "operator@example.com" },
  organization: { id: "org-one", name: "Organization" },
  organizations: [],
  membershipId: "member",
  permissions: ["integrations.manage"],
};
const connected: PelicanConnection = {
  id: "connection-id",
  revision: 1,
  panelUrl: "https://panel.example.com/",
  checkedAt: Date.now(),
  lastSuccessAt: Date.now(),
  error: null,
  servers: [
    {
      uuid: "server-uuid",
      identifier: "rust-one",
      name: "Rust One",
      node: "USE1",
      suspended: false,
      installing: false,
      transferring: false,
    },
  ],
};
beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(apiRequest).mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const mount = (who = identity) =>
  render(
    <TooltipProvider>
      <OrganizationConnections identity={who} />
    </TooltipProvider>,
  );
async function ready() {
  await waitFor(() =>
    expect(screen.queryByLabelText("Loading connections")).toBeNull(),
  );
}

describe("Organization connections", () => {
  it("loads tenant-scoped data and shows a real empty state with searchable catalog", async () => {
    const user = userEvent.setup();
    mount();
    await ready();
    expect(apiRequest).toHaveBeenCalledWith(
      "integrations/pelican",
      undefined,
      "org-one",
    );
    expect(screen.getByText("No connected services")).toBeTruthy();
    expect(
      screen.queryByText(
        "Connect services and verify access for your organization.",
      ),
    ).toBeNull();
    expect(screen.queryByText("Available connections")).toBeNull();
    expect(screen.queryByText("Discord", { exact: true })).toBeNull();
    expect(screen.queryByText("Northstar Rust")).toBeNull();
    expect(screen.queryByText("API key rejected")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Browse connections" }),
    );
    const search = screen.getByRole("searchbox", {
      name: "Search available connections",
    });
    expect(document.activeElement).toBe(search);
    await user.type(search, "network");
    expect(screen.getByText("Cloudflare")).toBeTruthy();
    expect(screen.queryByText("Pterodactyl")).toBeNull();
    await user.clear(search);
    await user.type(search, "missing");
    expect(screen.getByText("No connections found")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(document.activeElement).toBe(search);
  });
  it("saves and verifies a connection without storing its key in the browser", async () => {
    const user = userEvent.setup();
    const storage = vi.spyOn(Storage.prototype, "setItem");
    mount();
    await ready();
    await user.click(
      screen.getByRole("button", { name: "Browse connections" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Connect Pelican Panel" }),
    );
    expect(
      screen.getByText(/Authorized operators can send console commands/),
    ).toBeTruthy();
    expect(
      screen.getByText(/startup read for Rust connection discovery/),
    ).toBeTruthy();
    expect(screen.queryByText(/does not send power actions/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save and verify" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Panel URL"));
    await user.type(
      screen.getByLabelText("Panel URL"),
      "https://panel.example.com",
    );
    await user.click(screen.getByRole("button", { name: "Save and verify" }));
    expect(document.activeElement).toBe(
      screen.getByLabelText("Client API key"),
    );
    await user.type(
      screen.getByLabelText("Client API key"),
      "pelican-secret-for-testing",
    );
    vi.mocked(apiRequest).mockResolvedValueOnce(connected);
    await user.click(screen.getByRole("button", { name: "Save and verify" }));
    await screen.findByText("Rust One");
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Available", { exact: true })).toBeTruthy();
    expect(apiRequest).toHaveBeenLastCalledWith(
      "integrations/pelican",
      {
        panelUrl: "https://panel.example.com/",
        apiKey: "pelican-secret-for-testing",
        id: null,
        revision: null,
      },
      "org-one",
    );
    expect(storage).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("pelican-secret-for-testing")).toBeNull();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Pelican connection actions" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(
      (screen.getByLabelText("Client API key") as HTMLInputElement).value,
    ).toBe("");
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...connected, revision: 2 });
    await user.click(screen.getByRole("button", { name: "Save and verify" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(apiRequest).toHaveBeenLastCalledWith(
      "integrations/pelican",
      {
        panelUrl: connected.panelUrl,
        apiKey: null,
        id: connected.id,
        revision: 1,
      },
      "org-one",
    );
  });
  it("preserves verified inventory after a failed check and requires confirmation to disconnect", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(connected);
    mount();
    await ready();
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...connected,
      revision: 2,
      error: "Pelican rejected the Client API key. Replace it and try again.",
    });
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Pelican connection actions" }),
      { button: 0, ctrlKey: false },
    );
    await user.click(screen.getByRole("menuitem", { name: "Refresh" }));
    await screen.findByText("Needs attention");
    expect(apiRequest).toHaveBeenLastCalledWith(
      "integrations/pelican/check",
      { id: connected.id, revision: 1 },
      "org-one",
    );
    expect(screen.getByText("Rust One")).toBeTruthy();
    expect(screen.queryByText("rust-one", { exact: true })).toBeNull();
    expect(screen.queryByText(/Inventory from/)).toBeNull();
    expect(screen.queryByText(/Checked /)).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Pelican connection actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(apiRequest).toHaveBeenCalledTimes(2);
    await user.click(
      screen.getByRole("button", { name: "Pelican connection actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    vi.mocked(apiRequest).mockResolvedValueOnce({ removed: true });
    await user.click(
      screen.getByRole("button", { name: "Disconnect Pelican" }),
    );
    await screen.findByText("No connected services");
    expect(apiRequest).toHaveBeenLastCalledWith(
      "integrations/pelican/remove",
      { id: connected.id, revision: 2 },
      "org-one",
    );
    expect(screen.queryByText("Rust One")).toBeNull();
  });
  it("does not fetch or show credentials without integration management permission", () => {
    mount({ ...identity, permissions: ["servers.view"] });
    expect(apiRequest).not.toHaveBeenCalled();
    expect(
      screen.getByText(/need integration management permission/),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("shows load failures and retries without implying an empty successful result", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockRejectedValueOnce(new Error("Unavailable"));
    mount();
    await screen.findByText("Unavailable");
    expect(screen.queryByText("No connected services")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Browse connections" }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Connect Pelican Panel",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Close" }));
    vi.mocked(apiRequest).mockResolvedValueOnce(null);
    await user.click(
      screen.getByRole("button", { name: "Reload connections" }),
    );
    await screen.findByText("No connected services");
  });
  it("keeps entered fields after save errors and clears secrets on cancel", async () => {
    const user = userEvent.setup();
    mount();
    await ready();
    await user.click(
      screen.getByRole("button", { name: "Browse connections" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Connect Pelican Panel" }),
    );
    await user.type(
      screen.getByLabelText("Panel URL"),
      "https://panel.example.com",
    );
    await user.type(
      screen.getByLabelText("Client API key"),
      "test-secret-not-persisted",
    );
    vi.mocked(apiRequest).mockRejectedValueOnce(
      new Error(
        "This connection changed. Reload connections before trying again.",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Save and verify" }));
    await screen.findByText(/This connection changed/);
    expect(screen.getByDisplayValue("test-secret-not-persisted")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(
      screen.getByRole("button", { name: "Browse connections" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Connect Pelican Panel" }),
    );
    expect(
      (screen.getByLabelText("Client API key") as HTMLInputElement).value,
    ).toBe("");
  });
  it("disables duplicate checks while pending and shows empty verified inventory", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(connected);
    mount();
    await ready();
    let finish!: (value: PelicanConnection) => void;
    vi.mocked(apiRequest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Pelican connection actions" }),
      { button: 0, ctrlKey: false },
    );
    await user.click(screen.getByRole("menuitem", { name: "Refresh" }));
    expect(
      (
        screen.getByRole("button", {
          name: "Checking Pelican...",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    finish({ ...connected, revision: 2, servers: [] });
    await screen.findByText(/No servers are assigned/);
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });
  it("marks old checks stale and explains unsupported connections in the action dialog", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...connected,
      lastSuccessAt: Date.now() - 600_000,
    });
    mount();
    await ready();
    expect(screen.getByText("Check overdue")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Browse connections" }),
    );
    const trigger = screen.getByRole("button", {
      name: "View Cloudflare requirements",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/cannot be connected yet/)).toBeTruthy();
    expect(document.activeElement).toBe(
      within(dialog).getByText("Cloudflare requirements"),
    );
    expect(within(dialog).getByText("Scoped API token")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(trigger);
  });
});
