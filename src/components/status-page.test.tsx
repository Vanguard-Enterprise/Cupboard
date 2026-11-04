// @vitest-environment jsdom
import { TooltipProvider } from "@/components/ui/tooltip";
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
import { StatusPageAdmin } from "./status-page";
import { apiRequest, type Identity } from "@/lib/api-client";
import type { StatusPageState } from "@/lib/status-page";
import { toast } from "sonner";

vi.mock("@/lib/api-client", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/status-fonts", () => ({
  statusFontFamily: {
    geist: "Geist",
    inter: "Inter",
    manrope: "Manrope",
    "ibm-plex-sans": "IBM Plex Sans",
    "space-grotesk": "Space Grotesk",
    "source-serif": "Source Serif 4",
    "jetbrains-mono": "JetBrains Mono",
  },
}));

const identity: Identity = {
  user: { id: "operator", name: "Operator", email: "operator@example.com" },
  organization: { id: "org-one", name: "Northstar Games" },
  organizations: [],
  membershipId: "member",
  permissions: ["infrastructure.view", "infrastructure.manage"],
};
const empty: StatusPageState = {
  revision: 0,
  name: "Northstar Games",
  slug: "northstar-games",
  published: false,
  announcement: "",
  supportUrl: "",
  theme: "dark",
  accentColor: "#7cb58d",
  font: "geist",
  links: [],
  footerText: "",
  poweredBy: true,
  logoVersion: null,
  components: [],
  maintenance: [],
  sources: [
    { id: "server-eu", name: "Rust EU", kind: "server" },
    { id: "machine-1", name: "use1-wings-01", kind: "machine" },
  ],
};
const now = Date.now();
const live: StatusPageState = {
  ...empty,
  revision: 2,
  published: true,
  components: [
    {
      id: "c-eu",
      name: "EU main",
      kind: "server",
      sourceId: "server-eu",
      sourceName: "Rust EU",
      groupName: "Game servers",
      public: true,
      health: "operational",
      observedAt: now - 10_000,
    },
    {
      id: "c-host",
      name: "Wings host",
      kind: "machine",
      sourceId: "machine-1",
      sourceName: "use1-wings-01",
      groupName: "",
      public: false,
      health: "down",
      observedAt: now - 300_000,
    },
  ],
  maintenance: [
    {
      id: "w-1",
      title: "Monthly wipe",
      message: "Map and blueprints reset.",
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      completedAt: null,
      componentIds: ["c-eu"],
      createdAt: now - 120_000,
    },
  ],
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
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
      <StatusPageAdmin identity={who} />
    </TooltipProvider>,
  );
const ready = () =>
  waitFor(() =>
    expect(screen.queryByLabelText("Loading status page")).toBeNull(),
  );

describe("Status page admin", () => {
  it("shows live status, maintenance, and visibility on the overview", async () => {
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    expect(apiRequest).toHaveBeenCalledWith(
      "status-page",
      undefined,
      "org-one",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "1 target unavailable",
    );
    expect(screen.getByText("Under maintenance")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Hidden from the public page" }),
    ).toBeTruthy();
    expect(screen.getByText("Happening now")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Visit status page/ })
        .getAttribute("href"),
    ).toBe("/status/northstar-games");
  });

  it("lets viewers read but not change the page", async () => {
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount({ ...identity, permissions: ["infrastructure.view"] });
    await ready();
    expect(
      screen.queryByRole("button", { name: "Schedule maintenance" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Actions for Monthly wipe" }),
    ).toBeNull();
    mount({ ...identity, permissions: ["servers.view"] });
    expect(screen.getByText("Infrastructure viewing required")).toBeTruthy();
  });

  it("adds a component, hides it, and saves the ordered page", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(empty);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Add target" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByLabelText("Server or machine"));
    await user.type(
      await screen.findByPlaceholderText("Search servers and machines"),
      "rust",
    );
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /wings/ })).toBeNull(),
    );
    await user.click(await screen.findByRole("option", { name: /Rust EU/ }));
    expect(within(dialog).getByLabelText("Display name")).toHaveProperty(
      "value",
      "Rust EU",
    );
    await user.clear(within(dialog).getByLabelText("Display name"));
    await user.type(within(dialog).getByLabelText("Display name"), "EU main");
    await user.type(within(dialog).getByLabelText("Group"), "Game servers");
    await user.click(
      within(dialog).getByRole("button", { name: "Add target" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(
      screen.getByRole("button", { name: "Hide EU main on the public page" }),
    );
    await user.click(screen.getByRole("switch", { name: "Publish page" }));
    const saved: StatusPageState = {
      ...empty,
      revision: 1,
      published: true,
      components: [
        {
          id: "new",
          name: "EU main",
          kind: "server",
          sourceId: "server-eu",
          sourceName: "Rust EU",
          groupName: "Game servers",
          public: false,
          health: "unknown",
          observedAt: null,
        },
      ],
    };
    vi.mocked(apiRequest).mockResolvedValueOnce(saved);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        {
          revision: 0,
          name: "Northstar Games",
          slug: "northstar-games",
          published: true,
          announcement: "",
          supportUrl: "",
          theme: "dark",
          accentColor: "#7cb58d",
          font: "geist",
          links: [],
          footerText: "",
          poweredBy: true,
          components: [
            {
              id: null,
              name: "EU main",
              kind: "server",
              sourceId: "server-eu",
              groupName: "Game servers",
              public: false,
            },
          ],
        },
        "org-one",
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Status page saved.");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("titles the page Status with its visibility beside it", async () => {
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Status");
    expect(heading.parentElement?.textContent).toContain("Public");
  });

  it("brands the page, previews it, and saves the branding", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(empty);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.click(screen.getByRole("radio", { name: "Light" }));
    await user.click(screen.getByRole("radio", { name: "#e4572e" }));
    await user.click(screen.getByRole("button", { name: "Add link" }));
    await user.type(screen.getByLabelText("Link 1 label"), "Website");
    await user.type(
      screen.getByLabelText("Link 1 address"),
      "https://northstar.example",
    );
    await user.type(
      screen.getByLabelText("Footer text"),
      "Northstar Games LLC",
    );
    await user.click(
      screen.getByRole("switch", { name: "Show Powered by Cupboard" }),
    );
    const preview = screen.getByRole("region", { name: "Public preview" });
    expect(preview.querySelector(".theme-light")).toBeTruthy();
    expect(
      within(preview)
        .getByRole("link", { name: "Website" })
        .getAttribute("href"),
    ).toBe("https://northstar.example");
    expect(within(preview).getByText("Northstar Games LLC")).toBeTruthy();
    expect(within(preview).queryByText("Powered by")).toBeNull();

    await user.clear(screen.getByLabelText("Accent color"));
    await user.type(screen.getByLabelText("Accent color"), "#12");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "six-digit hex code",
    );
    expect(apiRequest).toHaveBeenCalledTimes(1);

    await user.clear(screen.getByLabelText("Accent color"));
    await user.type(screen.getByLabelText("Accent color"), "#E4572E");
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...empty, revision: 1 });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        expect.objectContaining({
          theme: "light",
          accentColor: "#e4572e",
          font: "geist",
          links: [{ label: "Website", url: "https://northstar.example" }],
          footerText: "Northstar Games LLC",
          poweredBy: false,
        }),
        "org-one",
      ),
    );
  });

  it("uploads a logo right away without touching the draft", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(empty);
    const fetch = vi.fn(async (path: string) =>
      path === "/app-api/status-page/logo"
        ? Response.json({ ...empty, logoVersion: 7 })
        : Response.json({}),
    );
    vi.stubGlobal("fetch", fetch);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.type(screen.getByLabelText("Footer text"), "Draft footer");
    const file = new File(["png"], "logo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Logo file"), file);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/app-api/status-page/logo",
        expect.objectContaining({
          method: "POST",
          body: file,
          headers: expect.objectContaining({
            "Content-Type": "application/octet-stream",
            "X-Cupboard-Organization": "org-one",
          }),
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Logo updated.");
    expect(
      await screen.findByRole("button", { name: "Replace logo" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Footer text")).toHaveProperty(
      "value",
      "Draft footer",
    );
  });

  it("reorders components with the keyboard and keeps the draft until saved", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const handle = screen.getByRole("button", { name: "Reorder Wings host" });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    const handles = screen.getAllByRole("button", { name: /^Reorder / });
    expect(handles.map((h) => h.getAttribute("aria-label"))).toEqual([
      "Reorder Wings host",
      "Reorder EU main",
    ]);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it("schedules maintenance for chosen components", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(
      screen.getByRole("button", { name: "Schedule maintenance" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Schedule maintenance" }),
    );
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "Enter a title for the maintenance window.",
    );
    await user.type(within(dialog).getByLabelText("Title"), "Host reboot");
    await user.click(
      within(dialog).getByRole("checkbox", { name: "All targets" }),
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: /Wings host/ }),
    );
    fireEvent.change(within(dialog).getByLabelText("Starts"), {
      target: { value: "2030-01-01T10:00" },
    });
    fireEvent.change(within(dialog).getByLabelText("Ends"), {
      target: { value: "2030-01-01T09:00" },
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Schedule maintenance" }),
    );
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "The window must end after it starts.",
    );
    fireEvent.change(within(dialog).getByLabelText("Ends"), {
      target: { value: "2030-01-01T11:00" },
    });
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    await user.click(
      within(dialog).getByRole("button", { name: "Schedule maintenance" }),
    );
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page/maintenance",
        {
          title: "Host reboot",
          message: "",
          startsAt: new Date("2030-01-01T10:00").getTime(),
          endsAt: new Date("2030-01-01T11:00").getTime(),
          componentIds: ["c-host"],
        },
        "org-one",
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Maintenance scheduled.");
  });

  it("completes an active window after confirmation", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    await user.click(
      screen.getByRole("button", { name: "Actions for Monthly wipe" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Mark complete" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Mark complete" }),
    );
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page/maintenance/w-1/complete",
        {},
        "org-one",
      ),
    );
  });
});
