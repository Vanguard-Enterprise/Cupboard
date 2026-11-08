// @vitest-environment jsdom
import { TooltipProvider } from "@/components/ui/tooltip";
import { UnsavedChangesProvider } from "@/components/ui/unsaved-changes";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusPageAdmin, mergeNotice, rebaseDraft } from "./status-page";
import { apiRequest, type Identity } from "@/lib/api-client";
import {
  atText,
  draftOf,
  type MaintenanceWindow,
  type StatusPageState,
} from "@/lib/status-page";
import { toast } from "sonner";
import { formatTime } from "@/components/ui/time-field";

vi.mock("@/lib/api-client", () => ({ apiRequest: vi.fn() }));
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: push }),
  usePathname: () => "/dashboard/infrastructure/maintenance",
}));
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
    { id: "server-eu", name: "Rust EU", kind: "server", tags: [] },
    {
      id: "machine-1",
      name: "use1-wings-01",
      kind: "machine",
      tags: ["wings"],
    },
  ],
  tags: [
    { id: "wings", name: "Wings" },
    { id: "game-server", name: "Game server" },
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
      tagId: "game-server",
      groupName: "Game server",
      public: true,
      health: "operational",
      observedAt: now - 10_000,
      detail: null,
    },
    {
      id: "c-host",
      name: "Wings host",
      kind: "machine",
      sourceId: "machine-1",
      sourceName: "use1-wings-01",
      tagId: "",
      groupName: "",
      public: false,
      health: "down",
      observedAt: now - 300_000,
      detail: null,
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
  // jsdom runs animation frames on one setInterval, made by the first
  // request. Made while a test fakes setInterval, it dies with the fake
  // timers and no frame runs again in this file. Frames on setTimeout,
  // looked up per call, survive that.
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) =>
    setTimeout(() => run(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
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
    // The workspace's leave guard, as `workspace.tsx` mounts it.
    <UnsavedChangesProvider>
      <TooltipProvider>
        <StatusPageAdmin identity={who} />
      </TooltipProvider>
    </UnsavedChangesProvider>,
  );
const ready = () =>
  waitFor(() =>
    expect(screen.queryByLabelText("Loading status page")).toBeNull(),
  );

/** The save bar says "Saved", in its status region. */
const savedInBar = () =>
  waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Changes saved" })).getByRole(
        "status",
      ).textContent,
    ).toContain("Saved"),
  );
/** A polite live region on the page says `text`. */
const said = (text: string) =>
  waitFor(() =>
    expect(
      [...document.querySelectorAll('[aria-live="polite"]')].some((element) =>
        element.textContent?.includes(text),
      ),
    ).toBe(true),
  );

/** jsdom has no image decoding or canvas, so give the logo editor stand-ins. */
function stubImages() {
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 600;
      naturalHeight = 300;
      decoding = "auto";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  let next = 0;
  URL.createObjectURL = vi.fn(() => `blob:logo-${++next}`);
  URL.revokeObjectURL = vi.fn();
  const context = new Proxy({}, { get: () => vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,",
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(new Blob(["png"], { type: "image/png" })),
  );
}

const old: MaintenanceWindow = {
  id: "w-old",
  title: "Database migration",
  message: "",
  startsAt: now - 9 * 86_400_000,
  endsAt: now - 9 * 86_400_000 + 3_600_000,
  completedAt: null,
  componentIds: [],
  createdAt: now - 10 * 86_400_000,
};
const hiddenOnly: MaintenanceWindow = {
  id: "w-hidden",
  title: "Host firmware",
  message: "",
  startsAt: now + 86_400_000,
  endsAt: now + 86_400_000 + 3_600_000,
  completedAt: null,
  componentIds: ["c-host"],
  createdAt: now - 60_000,
};
const conflictError = new Error(
  "The status page changed in another session. Reload it before saving again.",
);

describe("Status page admin", () => {
  it("lists every target and the maintenance on Overview", async () => {
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    expect(apiRequest).toHaveBeenCalledWith(
      "status-page",
      undefined,
      "org-one",
    );
    const status = screen.getByRole("region", {
      name: "1 target needs attention",
    });
    // One count wording at every width (claude D-92).
    expect(within(status).getAllByText(/^2 targets, 1 hidden\.$/)).toHaveLength(
      1,
    );
    expect(status.textContent).toMatch(/Updated \d{1,2}:\d{2}\s?[AP]M/);
    // EU main is healthy inside a window: it says so in words.
    expect(within(status).getByText("Under maintenance")).toBeTruthy();
    expect(screen.getByText("In progress")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark complete" })).toBeTruthy();
  });

  it("opens the add dialog straight from an empty overview", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(empty);
    mount();
    await ready();
    expect(screen.queryByRole("button", { name: "Refresh status" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add target" }));
    expect(
      await screen.findByRole("dialog", { name: "Add target" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("tab", { name: "Targets", hidden: true })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("keeps the announcement and maintenance on a page with no targets", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({
      ...empty,
      announcement: "Moving hosts this week.",
      maintenance: [{ ...live.maintenance[0], componentIds: [] }],
    });
    mount();
    await ready();
    expect(
      screen.getByRole("region", { name: "Set up your status page" }),
    ).toBeTruthy();
    const announcement = screen.getByRole("region", { name: "Announcement" });
    expect(announcement.textContent).toContain("Moving hosts this week.");
    expect(
      within(screen.getByRole("region", { name: /^Maintenance/ })).getByText(
        "Monthly wipe",
      ),
    ).toBeTruthy();
    await user.click(
      within(announcement).getByRole("button", { name: "Edit announcement" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Edit announcement" }),
    ).toBeTruthy();
  });

  it("reads setup, Maintenance, then the Announcement at every width (claude D-60)", async () => {
    vi.mocked(apiRequest).mockResolvedValue(empty);
    mount();
    await ready();
    expect(
      screen
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-labelledby"))
        .filter((id) =>
          [
            "maintenance-heading",
            "announcement-heading",
            "setup-heading",
          ].includes(id ?? ""),
        ),
    ).toEqual(["setup-heading", "maintenance-heading", "announcement-heading"]);
    // The last step points at the pill that publishes.
    expect(
      screen.getByRole("region", { name: "Set up your status page" })
        .textContent,
    ).toContain("Open Private beside the title.");
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
    expect(
      screen.queryByRole("button", { name: "More page actions" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /announcement/ })).toBeNull();
    cleanup();
    mount({ ...identity, permissions: ["servers.view"] });
    expect(screen.getByText("Infrastructure viewing required")).toBeTruthy();
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it("shows product copy, not transport errors, when loading fails", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the status page");
    expect(alert.textContent).not.toContain("Failed to fetch");
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await ready();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(
      /^Status page/,
    );
  });

  it("adds website, machine, and game server targets with errors by each field", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(empty);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Targets" }));

    // A website target needs a complete address; the error sits by the field.
    await user.click(screen.getByRole("button", { name: "Add target" }));
    let dialog = await screen.findByRole("dialog");
    expect(
      within(dialog)
        .getByRole("radio", { name: "Website" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const address = within(dialog).getByLabelText("Address");
    // Before an address, the name's placeholder is an example, not a default.
    expect(
      within(dialog).getByLabelText("Display name").getAttribute("placeholder"),
    ).toBe("Such as Forum");
    await user.type(address, "ftp://play.example.com");
    await user.click(
      within(dialog).getByRole("button", { name: "Add target" }),
    );
    expect(address.getAttribute("aria-invalid")).toBe("true");
    const describedBy = address.getAttribute("aria-describedby") ?? "";
    expect(
      document.getElementById(describedBy.split(" ")[0])?.textContent,
    ).toBe("Enter a complete address that starts with http:// or https://.");
    await waitFor(() => expect(document.activeElement).toBe(address));
    await user.clear(address);
    // A pasted bare host means https (claude D-55).
    await user.type(address, "play.example.com");
    await user.tab();
    expect(address).toHaveProperty("value", "https://play.example.com");
    // The host is suggested as a placeholder, never written into the field,
    // so clicking in and typing starts from an empty name.
    const displayName = within(dialog).getByLabelText("Display name");
    expect(displayName).toHaveProperty("value", "");
    expect(displayName.getAttribute("placeholder")).toBe("play.example.com");
    expect(document.getElementById("component-name-hint")?.textContent).toBe(
      "Leave empty to use play.example.com.",
    );
    await user.click(displayName);
    await user.type(displayName, "Website");
    expect(displayName).toHaveProperty("value", "Website");
    await user.click(
      within(dialog).getByRole("button", { name: "Add target" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("New")).toBeTruthy();

    // A machine defaults to its first tag as the group and shows just its name.
    await user.click(screen.getByRole("button", { name: "Add target" }));
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "Machine" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Machine" }));
    await user.click(
      await screen.findByRole("option", { name: /use1-wings-01/ }),
    );
    expect(
      within(dialog).getByRole("combobox", { name: "Machine" }).textContent,
    ).toBe("use1-wings-01");
    expect(within(dialog).getByLabelText("Group").textContent).toContain(
      "Wings",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Add target" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Game servers are searchable; a search with no match says so.
    await user.click(screen.getByRole("button", { name: "Add target" }));
    dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("radio", { name: "Game server" }),
    );
    await user.click(
      within(dialog).getByRole("combobox", { name: "Game server" }),
    );
    const search = await screen.findByPlaceholderText("Search game servers");
    await user.type(search, "zzz");
    expect(await screen.findByText(/No game servers match/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await user.click(await screen.findByRole("option", { name: /Rust EU/ }));
    expect(
      within(dialog).getByLabelText("Display name").getAttribute("placeholder"),
    ).toBe("Rust EU");
    await user.type(within(dialog).getByLabelText("Display name"), "EU main");
    await user.click(
      within(dialog).getByRole("button", { name: "Add target" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const eye = screen.getByRole("button", {
      name: "Show EU main on the public page",
    });
    expect(eye.getAttribute("aria-pressed")).toBe("true");
    await user.click(eye);
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("https://play.example.com")).toBeTruthy();
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    expect(bar.textContent).toContain("3 new targets");

    vi.mocked(apiRequest).mockResolvedValueOnce({ ...empty, revision: 1 });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        expect.objectContaining({
          revision: 0,
          components: [
            {
              id: null,
              kind: "url",
              name: "Website",
              sourceId: "https://play.example.com",
              tagId: "",
              public: true,
            },
            {
              id: null,
              kind: "machine",
              name: "use1-wings-01",
              sourceId: "machine-1",
              tagId: "wings",
              public: true,
            },
            {
              id: null,
              kind: "server",
              name: "EU main",
              sourceId: "server-eu",
              tagId: "",
              public: false,
            },
          ],
        }),
        "org-one",
      ),
    );
    await savedInBar();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("adds the chosen machine by ID when two machines share a name", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...empty,
      sources: [
        { id: "machine-1", name: "wings", kind: "machine", tags: [] },
        { id: "machine-2", name: "wings", kind: "machine", tags: [] },
      ],
    });
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Targets" }));

    await user.click(screen.getByRole("button", { name: "Add target" }));
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "Machine" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Machine" }));
    const options = await screen.findAllByRole("option", { name: /wings/ });
    expect(options).toHaveLength(2);
    await user.click(options[1]);
    // Only the second one is marked chosen when the list opens again.
    await user.click(within(dialog).getByRole("combobox", { name: "Machine" }));
    const reopened = await screen.findAllByRole("option", { name: /wings/ });
    expect(
      reopened[0].querySelector("svg.lucide-check:not(.opacity-0)"),
    ).toBeNull();
    expect(
      reopened[1].querySelector("svg.lucide-check:not(.opacity-0)"),
    ).not.toBeNull();
    await user.click(reopened[1]);
    await user.click(
      within(dialog).getByRole("button", { name: "Add target" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The first machine is still free to add; the second is taken.
    await user.click(screen.getByRole("button", { name: "Add target" }));
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "Machine" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Machine" }));
    expect(
      await screen.findAllByRole("option", { name: /wings/ }),
    ).toHaveLength(1);
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    vi.mocked(apiRequest).mockResolvedValueOnce({ ...empty, revision: 1 });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        expect.objectContaining({
          components: [
            {
              id: null,
              kind: "machine",
              name: "wings",
              sourceId: "machine-2",
              tagId: "",
              public: true,
            },
          ],
        }),
        "org-one",
      ),
    );
  });

  it("returns focus to the opener when a dialog closes", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    const schedule = screen.getByRole("button", {
      name: "Schedule maintenance",
    });
    await user.click(schedule);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(schedule));

    await user.click(screen.getByRole("tab", { name: "Targets" }));
    const add = screen.getByRole("button", { name: "Add target" });
    await user.click(add);
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it("warns before a new address breaks shared links and shows only the saved one", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const slug = screen.getByLabelText("Public address");
    await user.clear(slug);
    await user.type(slug, "northstar");
    const warning = screen.getByText(
      /Links to \/status\/northstar-games stop working/,
    );
    // A warning, not ordinary help text, and named in the save bar too.
    expect(warning.closest("p")?.className).toContain("text-warning");
    expect(
      screen.getByRole("region", { name: "Unsaved changes" }).textContent,
    ).toContain("Public address (old links stop working)");
    // The title link and the pill keep the saved address until Save.
    expect(
      within(screen.getByRole("heading", { level: 1 }))
        .getByRole("link")
        .getAttribute("href"),
    ).toBe("/status/northstar-games");
    await user.click(screen.getByRole("button", { name: /^Public/ }));
    expect((await screen.findByRole("dialog")).textContent).toMatch(
      /\/status\/northstar-games/,
    );
  });

  it("says Publish and Unpublish once each, with the players' headline", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...live, published: false });
    mount();
    await ready();
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...live, revision: 3 });
    // claude D-98, a11y D-R9-02, codex D-51: one message says the action
    // and the new public headline, never two in the same moment.
    const spoken: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const region = (
          record.target instanceof Element
            ? record.target
            : record.target.parentElement
        )?.closest("[aria-live], [role=status], [role=alert]");
        if (region?.textContent?.trim()) spoken.push(region.textContent.trim());
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // One Publish page, in the pill (claude D-52).
    expect(screen.queryByRole("button", { name: "Publish page" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Private/ }));
    expect(
      screen.getAllByRole("button", { name: "Publish page" }),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Publish page" }));
    await said("Status page published.");
    expect(new Set(spoken)).toEqual(
      new Set([
        expect.stringMatching(/^Status page published\. Players see: .+\.$/),
      ]),
    );
    spoken.length = 0;
    // Publish closes the pill and lands on the title link. Reopening before
    // focus lands there would race the move and close the pill again.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(screen.getByRole("heading", { level: 1 })).getByRole("link"),
      ),
    );

    await user.click(screen.getByRole("button", { name: /^Public/ }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Unpublish page",
      }),
    );
    const confirm = await screen.findByRole("alertdialog");
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      revision: 4,
      published: false,
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Unpublish page" }),
    );
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        expect.objectContaining({ revision: 3, published: false }),
        "org-one",
      ),
    );
    await said("Status page unpublished.");
    observer.disconnect();
    expect([...new Set(spoken)]).toEqual([
      "Status page unpublished. Players see a not-found page.",
    ]);
  });

  it("posts an announcement right away without saving drafted settings", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.type(screen.getByLabelText("Footer text"), "Draft footer");
    await user.click(screen.getByRole("tab", { name: "Overview" }));
    await user.click(
      screen.getByRole("button", { name: "Post an announcement" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("Announcement"),
      "Wipe on Thursday.",
    );
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      revision: 3,
      announcement: "Wipe on Thursday.",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Post announcement" }),
    );
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        expect.objectContaining({
          announcement: "Wipe on Thursday.",
          footerText: "",
        }),
        "org-one",
      ),
    );
    expect(await screen.findByText("Wipe on Thursday.")).toBeTruthy();
    // The drafted footer is still waiting for Save changes.
    expect(
      screen.getByRole("region", { name: "Unsaved changes" }).textContent,
    ).toContain("Footer text");
  });

  it("lets the page follow each visitor's system theme", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(empty);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(
      screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(screen.getByRole("radio", { name: "System" }));
    const preview = screen.getByRole("region", { name: "Public preview" });
    expect(preview.querySelector(".theme-system")).toBeTruthy();
    expect(preview.querySelector(".theme-light")).toBeNull();
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...empty,
      revision: 1,
      theme: "system",
    });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        expect.objectContaining({ theme: "system" }),
        "org-one",
      ),
    );
  });

  // codex D-47: the accent readout asked operators to read ratios. It gives
  // a verdict to act on; the ratios are one press away.
  it("judges the accent in words and shows the ratios on demand", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(empty);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.click(screen.getByRole("radio", { name: "Light" }));
    await user.click(
      screen.getByRole("radio", { name: "Vermilion (#e4572e)" }),
    );
    const verdict = () =>
      document.getElementById("status-accent-contrast")!.textContent;
    expect(verdict()).toBe("Stands out on light pages.");
    expect(
      screen.getByLabelText("Accent color").getAttribute("aria-describedby"),
    ).toContain("status-accent-contrast");
    await user.click(screen.getByRole("radio", { name: "White (#f3f4f6)" }));
    expect(verdict()).toBe("Fades on light pages. Try a stronger color.");
    expect(verdict()).not.toMatch(/:1/);
    await user.click(screen.getByRole("button", { name: "Contrast ratios" }));
    // a11y D-R7-01: the popover is named by its trigger.
    const ratios = await screen.findByRole("dialog", {
      name: "Contrast ratios",
    });
    expect(ratios.textContent).toMatch(/Light pages1\.\d:1/);
    expect(ratios.textContent).toMatch(/Button text\d+\.\d:1/);
  });

  it("brands the page in an inert preview and ties each error to its field", async () => {
    const user = userEvent.setup();
    // Each keystroke renders the whole admin and its live preview, so typing
    // these values a key at a time took most of this test's time and pushed
    // it past 5 s when two checks ran at once. What is checked here is the
    // values, so they are entered whole.
    const enter = async (field: HTMLElement, text: string) => {
      await user.clear(field);
      await user.click(field);
      await user.paste(text);
    };
    vi.mocked(apiRequest).mockResolvedValueOnce(empty);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.click(screen.getByRole("radio", { name: "Light" }));
    await user.click(
      screen.getByRole("radio", { name: "Vermilion (#e4572e)" }),
    );
    await user.click(screen.getByRole("button", { name: "Add link" }));
    await enter(screen.getByLabelText("Link 1 Label"), "Website");
    await enter(
      screen.getByLabelText("Link 1 Address"),
      "http://northstar.example",
    );
    await enter(screen.getByLabelText("Footer text"), "Northstar Games LLC");
    await user.click(
      screen.getByRole("switch", { name: "Show Powered by Cupboard" }),
    );
    const preview = screen.getByRole("region", { name: "Public preview" });
    expect(preview.querySelector(".theme-light")).toBeTruthy();
    expect(preview.querySelector("[inert]")).toBeTruthy();
    expect(within(preview).getByText("Northstar Games LLC")).toBeTruthy();
    expect(within(preview).queryByText("Powered by")).toBeNull();

    // The header link must be HTTPS; the client says so by the field.
    await enter(screen.getByLabelText("Accent color"), "#12");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(apiRequest).toHaveBeenCalledTimes(1);
    const accent = screen.getByLabelText("Accent color");
    const link = screen.getByLabelText("Link 1 Address");
    expect(accent.getAttribute("aria-invalid")).toBe("true");
    expect(link.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(link.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toContain("https://");
    await waitFor(() => expect(document.activeElement).toBe(accent));
    expect(
      screen.getByRole("region", { name: "Unsaved changes" }).textContent,
    ).toContain("2 fields need attention");

    await enter(accent, "#E4572E");
    await enter(link, "https://northstar.example");
    expect(accent.getAttribute("aria-invalid")).toBeNull();
    expect(
      preview.querySelector('a[href="https://northstar.example"]'),
    ).toBeTruthy();
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

  // claude D-91: the header repeated the page name the organization switcher
  // shows. codex D-46: on phones Settings began below half the screen, under
  // a row of its own for Preview.
  it("keeps the phone header to the title and the pill", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query === "(max-width: 639px)",
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    const heading = screen.getByRole("heading", { level: 1 });
    const header = heading.parentElement!;
    expect(within(header).queryByText("Northstar Games")).toBeNull();
    expect(within(header).getAllByRole("button")).toHaveLength(1);
    expect(within(header).getAllByRole("link")).toHaveLength(1);
  });

  it("keeps the side preview on Phone and opens Desktop preview at full size (claude D-62)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const side = screen.getByRole("region", { name: "Public preview" });
    // No scaled desktop thumbnail beside the editor.
    expect(
      within(side).queryByRole("group", { name: "Preview width" }),
    ).toBeNull();
    const desktop = within(side).getByRole("button", {
      name: "Desktop preview",
    });
    await user.click(desktop);
    const sheet = await screen.findByRole("dialog", { name: "Public preview" });
    expect(
      within(sheet)
        .getByRole("radio", { name: "Desktop" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(desktop));
  });

  it("selects theme, accent, and preview width as the arrow keys move", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const sage = screen.getByRole("radio", { name: "Sage (#7cb58d)" });
    sage.focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(screen.getByLabelText("Accent color")).toHaveProperty(
        "value",
        "#4f8fd6",
      ),
    );
    expect(
      screen.getByRole("radio", { name: /^Blue/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: /^Blue/ }),
    );
    screen.getByRole("radio", { name: "Dark" }).focus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(
        screen
          .getByRole("radio", { name: "Light" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    expect(bar.textContent).toContain("Theme and accent color");
  });

  it("previews only the maintenance the public page shows", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      maintenance: [...live.maintenance, old, hiddenOnly],
    });
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const preview = screen.getByRole("region", { name: "Public preview" });
    expect(within(preview).queryByText("Database migration")).toBeNull();
    expect(within(preview).queryByText("Host firmware")).toBeNull();
    expect(within(preview).queryByText("Wings host")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Overview" }));
    // A window touching only hidden targets is tagged like a hidden target.
    const maintenance = screen.getByRole("region", { name: "Maintenance" });
    expect(within(maintenance).getByText("Hidden")).toBeTruthy();
  });

  it("stages a cropped logo until Save changes and drops it on Discard", async () => {
    const user = userEvent.setup();
    stubImages();
    vi.mocked(apiRequest).mockResolvedValueOnce(empty);
    const fetch = vi.fn(async (path: string) =>
      path.startsWith("/app-api/status-page/logo")
        ? Response.json({ ...empty, logoVersion: 7 })
        : Response.json({}),
    );
    vi.stubGlobal("fetch", fetch);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const file = new File(["png"], "logo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Logo file"), file);
    let editor = await screen.findByRole("dialog", { name: "Edit logo" });
    await user.click(within(editor).getByRole("radio", { name: "Square" }));
    await user.click(within(editor).getByRole("button", { name: "Zoom in" }));
    await user.click(
      within(editor).getByRole("button", { name: "Rotate right" }),
    );
    expect(within(editor).getByText("125%")).toBeTruthy();
    expect(
      within(editor)
        .getByRole("slider", { name: "Zoom" })
        .getAttribute("aria-valuetext"),
    ).toBe("125 percent");
    await user.click(within(editor).getByRole("button", { name: "Use logo" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit logo" })).toBeNull(),
    );
    // Nothing is uploaded until the page is saved.
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("New logo")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("New logo")).toBeNull();
    expect(screen.getByRole("button", { name: "Add logo" })).toBeTruthy();

    await user.upload(screen.getByLabelText("Logo file"), file);
    editor = await screen.findByRole("dialog", { name: "Edit logo" });
    await user.click(within(editor).getByRole("button", { name: "Use logo" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit logo" })).toBeNull(),
    );
    // A page never saved gets its row first; the logo is checked against it.
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...empty, revision: 1 });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/app-api/status-page/logo",
        expect.objectContaining({
          method: "POST",
          body: expect.any(Blob),
          headers: expect.objectContaining({
            "Content-Type": "application/octet-stream",
            "X-Cupboard-Organization": "org-one",
            "X-Cupboard-Logo-Revision": "1",
          }),
        }),
      ),
    );
    await savedInBar();
    expect(toast.success).not.toHaveBeenCalled();
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it("snaps a dragged logo to the frame center and shows the guides", async () => {
    const user = userEvent.setup();
    stubImages();
    vi.mocked(apiRequest).mockResolvedValueOnce(empty);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.upload(
      screen.getByLabelText("Logo file"),
      new File(["png"], "logo.png", { type: "image/png" }),
    );
    const editor = await screen.findByRole("dialog", { name: "Edit logo" });
    const stage = await within(editor).findByRole("application", {
      name: "Logo crop area",
    });
    expect(stage.getAttribute("aria-describedby")).toContain("logo-stage-help");
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 400, height: 225 }),
    );
    const image = () =>
      editor.querySelector<HTMLImageElement>("img.max-w-none");
    const start = image()!.style.left;
    const press = { pointerId: 1, button: 0, clientX: 200, clientY: 112 };
    fireEvent.pointerDown(stage, press);
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 204, clientY: 115 });
    expect(within(editor).getByTestId("logo-guide-vertical")).toBeTruthy();
    expect(within(editor).getByTestId("logo-guide-horizontal")).toBeTruthy();
    expect(image()!.style.left).toBe(start);

    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 240, clientY: 112 });
    expect(within(editor).queryByTestId("logo-guide-vertical")).toBeNull();
    expect(within(editor).getByTestId("logo-guide-horizontal")).toBeTruthy();
    expect(image()!.style.left).not.toBe(start);

    fireEvent.pointerMove(stage, {
      pointerId: 1,
      clientX: 204,
      clientY: 115,
      altKey: true,
    });
    expect(within(editor).queryByTestId("logo-guide-vertical")).toBeNull();
    expect(image()!.style.left).not.toBe(start);
    fireEvent.pointerUp(stage, { pointerId: 1 });
    expect(within(editor).queryByTestId("logo-guide-horizontal")).toBeNull();
  });

  it("refuses files that are not images before opening the editor", async () => {
    const user = userEvent.setup({ applyAccept: false });
    stubImages();
    vi.mocked(apiRequest).mockResolvedValueOnce(empty);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.upload(
      screen.getByLabelText("Logo file"),
      new File(["text"], "notes.txt", { type: "text/plain" }),
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Choose a PNG, JPEG, WebP, GIF, or SVG image.",
    );
    expect(screen.queryByRole("dialog", { name: "Edit logo" })).toBeNull();
  });

  it("removes the logo after confirming, when the page is saved", async () => {
    const user = userEvent.setup();
    stubImages();
    vi.mocked(apiRequest).mockImplementation(async (path: string, body) =>
      path === "status-page/logo/remove"
        ? { ...empty, revision: 2, logoVersion: null }
        : body
          ? { ...empty, revision: 1, logoVersion: 4 }
          : { ...empty, logoVersion: 4 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }))),
    );
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.click(
      await screen.findByRole("button", { name: "Remove logo" }),
    );
    expect(screen.getByText("Remove the logo?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Remove logo" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText("Logo removed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add logo" })).toBeTruthy();
    expect(apiRequest).not.toHaveBeenCalledWith(
      "status-page/logo/remove",
      expect.anything(),
      expect.anything(),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        "status-page/logo/remove",
        { revision: 1 },
        "org-one",
      ),
    );
    await savedInBar();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("reorders within a group, announces the position, and discards on request", async () => {
    const user = userEvent.setup();
    const grouped: StatusPageState = {
      ...live,
      components: [
        { ...live.components[0], tagId: "", groupName: "" },
        live.components[1],
      ],
    };
    vi.mocked(apiRequest).mockResolvedValue(grouped);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    const handle = screen.getByRole("button", { name: "Reorder Wings host" });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    const handles = screen.getAllByRole("button", { name: /^Reorder / });
    expect(handles.map((h) => h.getAttribute("aria-label"))).toEqual([
      "Reorder Wings host",
      "Reorder EU main",
    ]);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Reorder Wings host" }),
    );
    expect(
      await screen.findByText("Wings host moved to position 1 of 2."),
    ).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps the operator's edits through a save conflict", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const name = screen.getByLabelText("Page name");
    await user.clear(name);
    await user.type(name, "Northstar Status");
    vi.mocked(apiRequest).mockRejectedValueOnce(conflictError);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const bar = await screen.findByRole("region", { name: "Unsaved changes" });
    await waitFor(() =>
      expect(bar.textContent).toContain("Changed in another session"),
    );
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      revision: 5,
      footerText: "Edited elsewhere",
    });
    await user.click(
      screen.getByRole("button", { name: "Load latest, keep my edits" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Footer text")).toHaveProperty(
        "value",
        "Edited elsewhere",
      ),
    );
    expect(screen.getByLabelText("Page name")).toHaveProperty(
      "value",
      "Northstar Status",
    );
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...live, revision: 6 });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        expect.objectContaining({
          revision: 5,
          name: "Northstar Status",
          footerText: "Edited elsewhere",
        }),
        "org-one",
      ),
    );
  });

  it("asks before leaving with unsaved changes", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    const away = document.createElement("a");
    away.href = "/dashboard/infrastructure/machines";
    away.textContent = "Machines";
    document.body.appendChild(away);
    await user.click(away);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Targets" }));
    await user.click(
      screen.getByRole("button", { name: "Show EU main on the public page" }),
    );
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await user.click(away);
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Leave without saving?");
    await user.click(
      within(confirm).getByRole("button", { name: "Keep editing" }),
    );
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    away.remove();
  });

  it("schedules maintenance with a date, a time, a length, and grouped targets", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2030-01-01T08:00"));
    try {
      const user = userEvent.setup();
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      mount();
      await ready();
      await user.click(
        // The header's; an empty Maintenance card offers the same action.
        screen.getAllByRole("button", { name: "Schedule maintenance" })[0],
      );
      const dialog = await screen.findByRole("dialog");
      expect(
        dialog.querySelector("#maintenance-start-date")?.textContent,
      ).toContain("Jan 1, 2030");
      await user.click(
        within(dialog).getByRole("button", { name: "Schedule maintenance" }),
      );
      const title = within(dialog).getByLabelText("Title");
      expect(title.getAttribute("aria-invalid")).toBe("true");
      expect(
        document.getElementById(title.getAttribute("aria-describedby")!)
          ?.textContent,
      ).toBe("Enter a title.");
      await waitFor(() => expect(document.activeElement).toBe(title));
      await user.type(title, "Host reboot");

      const start = within(dialog).getByLabelText("Start time");
      await user.clear(start);
      await user.type(start, "10am");
      await user.tab();
      // The field follows the locale's clock: "10:00 AM" in en-US.
      expect(start).toHaveProperty("value", formatTime(10 * 60));
      await user.click(
        within(dialog).getByRole("radio", { name: "Custom end" }),
      );
      const end = within(dialog).getByLabelText("End time");
      await user.clear(end);
      await user.type(end, "09:00");
      // The start still reads; the summary says what is wrong (claude D-53).
      const summary = within(dialog).getByTestId("maintenance-summary");
      expect(summary.textContent).toMatch(
        /^Starts in 2 hours, on .+\. The end is before the start\.$/,
      );
      await user.click(
        within(dialog).getByRole("button", { name: "Schedule maintenance" }),
      );
      expect(end.getAttribute("aria-invalid")).toBe("true");
      expect(dialog.textContent).toContain(
        "The window must end after it starts.",
      );
      // Stated once: under the field, not again in the summary.
      expect(summary.textContent).not.toContain("before the start");
      expect(summary.textContent).toMatch(/^Starts in 2 hours, on /);
      await user.click(within(dialog).getByRole("radio", { name: "2 hours" }));
      expect(dialog.textContent).toContain("lasts 2 hours");
      // The zone by name, never an abbreviation that could contradict the
      // field (a11y D-77).
      expect(
        within(dialog).getByText(/^Your time zone, .+\. Players see theirs\.$/),
      ).toBeTruthy();

      await user.click(
        within(dialog).getByRole("radio", { name: "Specific targets" }),
      );
      await user.click(
        within(dialog).getByRole("button", { name: "Schedule maintenance" }),
      );
      expect(dialog.textContent).toContain(
        "Choose at least one affected target.",
      );
      await user.click(
        within(dialog).getByRole("checkbox", { name: /Wings host/ }),
      );
      expect(dialog.textContent).toContain("1 of 2 selected");
      // The dialog body is the one scroll region at every width (claude D-40).
      expect(
        dialog.querySelectorAll('[class*="overflow-y-auto"]'),
      ).toHaveLength(
        dialog.querySelectorAll('[data-slot="dialog-body"]').length,
      );
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
            endsAt: new Date("2030-01-01T12:00").getTime(),
            componentIds: ["c-host"],
          },
          "org-one",
        ),
      );
      await said("Maintenance scheduled.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never summarizes a time daylight saving skips (claude D-48, codex D-31)", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    // Sun, Mar 14, 2027: clocks skip from 2:00 AM to 3:00 AM.
    vi.setSystemTime(new Date(2027, 2, 14, 0, 30));
    try {
      const user = userEvent.setup();
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      mount();
      await ready();
      await user.click(
        // The header's; an empty Maintenance card offers the same action.
        screen.getAllByRole("button", { name: "Schedule maintenance" })[0],
      );
      const dialog = await screen.findByRole("dialog");
      const start = within(dialog).getByLabelText("Start time");
      await user.clear(start);
      await user.type(start, "2:30am");
      await user.tab();
      const summary = within(dialog).getByTestId("maintenance-summary");
      expect(summary.textContent).toBe(
        "Fix the start time to see when it runs.",
      );
      expect(summary.textContent).not.toMatch(/3:30/);
      // Nothing spoken for a time that doesn't happen.
      const spoken = dialog.querySelector('p[aria-live="polite"].sr-only');
      expect(spoken?.textContent).toBe("");
      await user.clear(start);
      await user.type(start, "4am");
      expect(summary.textContent).toMatch(
        /^Starts in 2 hours 30 minutes, on .+4:00 AM EDT, and lasts 1 hour\.$/,
      );
    } finally {
      vi.useRealTimers();
      process.env.TZ = zone;
    }
  });

  it("schedules the second occurrence of a repeated hour (codex D-31)", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    // Sun, Nov 7, 2027: 1:00 to 2:00 AM happens twice.
    vi.setSystemTime(new Date(2027, 10, 7, 0, 10));
    try {
      const user = userEvent.setup();
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      mount();
      await ready();
      await user.click(
        screen.getAllByRole("button", { name: "Schedule maintenance" })[0],
      );
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Title"), "Wipe");
      const start = within(dialog).getByLabelText("Start time");
      await user.clear(start);
      await user.type(start, "1:30am");
      await user.tab();
      const summary = within(dialog).getByTestId("maintenance-summary");
      expect(summary.textContent).toContain("1:30 AM EDT");
      // A label that fits neither reading is no time (codex D-39), and the
      // choice stays beside the error after Schedule.
      await user.clear(start);
      await user.type(start, "1:30 AM PST");
      await user.click(
        within(dialog).getByRole("button", { name: "Schedule maintenance" }),
      );
      expect(
        vi
          .mocked(apiRequest)
          .mock.calls.filter(([path]) => path === "status-page/maintenance"),
      ).toHaveLength(0);
      expect(summary.textContent).toBe(
        "Fix the start time to see when it runs.",
      );
      expect(
        within(dialog).getByRole("radiogroup", { name: "Which 1:30 AM" }),
      ).toBeTruthy();
      await user.click(
        within(dialog).getByRole("radio", { name: "1:30 AM EST" }),
      );
      expect(summary.textContent).toContain("1:30 AM EST");
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      await user.click(
        within(dialog).getByRole("button", { name: "Schedule maintenance" }),
      );
      // 1:30 AM EST is 6:30 UTC; the first 1:30 would be 5:30 UTC.
      await waitFor(() =>
        expect(apiRequest).toHaveBeenLastCalledWith(
          "status-page/maintenance",
          expect.objectContaining({
            startsAt: Date.UTC(2027, 10, 7, 6, 30),
          }),
          "org-one",
        ),
      );
    } finally {
      vi.useRealTimers();
      process.env.TZ = zone;
    }
  });

  it("never schedules a time whose zone label doesn't fit the day (codex D-39)", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    // Tue, Jun 1, 2027 is in EDT, so "EST" names no time that evening.
    vi.setSystemTime(new Date(2027, 5, 1, 10, 0));
    const posted = () =>
      vi
        .mocked(apiRequest)
        .mock.calls.filter(([path]) => path === "status-page/maintenance");
    try {
      const user = userEvent.setup();
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      mount();
      await ready();
      await user.click(
        screen.getAllByRole("button", { name: "Schedule maintenance" })[0],
      );
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Title"), "Wipe");
      const start = within(dialog).getByLabelText("Start time");
      const summary = within(dialog).getByTestId("maintenance-summary");
      const spoken = dialog.querySelector('p[aria-live="polite"].sr-only');
      const submit = within(dialog).getByRole("button", {
        name: "Schedule maintenance",
      });

      // Start: a wrong label, and an unknown one, typed and submitted
      // without leaving the field first.
      for (const text of ["7:00 PM EST", "7:00 PM XYZ"]) {
        await user.clear(start);
        await user.type(start, text);
        expect(summary.textContent).not.toMatch(/^Starts/);
        expect(spoken?.textContent).toBe("");
        await user.click(submit);
        expect(posted()).toHaveLength(0);
        expect(screen.getByRole("dialog")).toBe(dialog);
        expect(start.getAttribute("aria-invalid")).toBe("true");
        await waitFor(() => expect(document.activeElement).toBe(start));
        expect(summary.textContent).toBe(
          "Fix the start time to see when it runs.",
        );
      }
      // Said once, as the field's own message.
      expect(dialog.querySelector("#maintenance-start-time-error")).toBeNull();
      expect(
        dialog.querySelector("#maintenance-start-time-issue")?.textContent,
      ).toMatch(/^7:00 PM on Tue, Jun 1 is EDT, not XYZ\./);

      // A valid start, then a custom end with the wrong label.
      await user.clear(start);
      await user.type(start, "7:00 PM");
      expect(summary.textContent).toMatch(/^Starts .+ and lasts 1 hour\.$/);
      await user.click(
        within(dialog).getByRole("radio", { name: "Custom end" }),
      );
      const end = within(dialog).getByLabelText("End time");
      await user.clear(end);
      await user.type(end, "9:00 PM EST");
      expect(summary.textContent).toBe("Fix the end time to see when it runs.");
      expect(spoken?.textContent).toBe("");
      await user.click(submit);
      expect(posted()).toHaveLength(0);
      expect(end.getAttribute("aria-invalid")).toBe("true");
      await waitFor(() => expect(document.activeElement).toBe(end));
      expect(dialog.querySelector("#maintenance-end-time-error")).toBeNull();
      expect(
        dialog.querySelector("#maintenance-end-time-issue")?.textContent,
      ).toMatch(/^9:00 PM on Tue, Jun 1 is EDT, not EST\./);

      // Removing the label schedules exactly the typed time.
      await user.clear(end);
      await user.type(end, "9:00 PM");
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      await user.click(submit);
      await waitFor(() => expect(posted()).toHaveLength(1));
      expect(posted()[0][1]).toMatchObject({
        startsAt: Date.UTC(2027, 5, 1, 23, 0),
        endsAt: Date.UTC(2027, 5, 2, 1, 0),
      });
    } finally {
      vi.useRealTimers();
      process.env.TZ = zone;
    }
  });

  it("completes an active window from its inline action after confirmation", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    await user.click(screen.getByRole("button", { name: "Mark complete" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(
      within(confirm).getByRole("button", { name: "Mark complete" }),
    );
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page/maintenance/w-1/complete",
        {},
        "org-one",
      ),
    );
  });

  it("confirms deleting a window with a solid destructive action", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    await user.click(
      screen.getByRole("button", { name: "Actions for Monthly wipe" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    const remove = within(confirm).getByRole("button", {
      name: "Delete window",
    });
    expect(remove.getAttribute("data-variant")).toBe("destructive-solid");
    await user.click(remove);
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page/maintenance/w-1/remove",
        {},
        "org-one",
      ),
    );
  });
});

describe("Status page admin data safety", () => {
  /** Runs the 30 second status poll once. */
  async function poll(next: StatusPageState) {
    vi.mocked(apiRequest).mockResolvedValueOnce(next);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
  }

  it("says a status headline a refresh changes, once", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      mount();
      await ready();
      const card = screen.getByRole("region", {
        name: "1 target needs attention",
      });
      const region = within(card).getByRole("status");
      expect(region.textContent).toBe("");
      await poll({
        ...live,
        maintenance: [],
        components: live.components.map((c) =>
          c.id === "c-eu" ? { ...c, health: "down" as const } : c,
        ),
      });
      await waitFor(() =>
        expect(region.textContent).toBe("2 targets need attention"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets a poll move unsaved edits onto a newer revision", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const user = userEvent.setup();
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      mount();
      await ready();
      await user.click(screen.getByRole("tab", { name: "Settings" }));
      const name = screen.getByLabelText("Page name");
      await user.clear(name);
      await user.type(name, "Northstar Status");
      // Another session saved a new footer.
      await poll({ ...live, revision: 3, footerText: "Edited elsewhere" });
      const bar = await screen.findByRole("region", {
        name: "Unsaved changes",
      });
      await waitFor(() =>
        expect(bar.textContent).toContain("Changed in another session"),
      );
      expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
      expect(screen.getByLabelText("Footer text")).toHaveProperty("value", "");
      expect(apiRequest).not.toHaveBeenCalledWith(
        "status-page",
        expect.objectContaining({ revision: 3 }),
        "org-one",
      );

      vi.mocked(apiRequest).mockResolvedValueOnce({
        ...live,
        revision: 3,
        footerText: "Edited elsewhere",
      });
      await user.click(
        screen.getByRole("button", { name: "Load latest, keep my edits" }),
      );
      await waitFor(() =>
        expect(screen.getByLabelText("Footer text")).toHaveProperty(
          "value",
          "Edited elsewhere",
        ),
      );
      expect(screen.getByLabelText("Page name")).toHaveProperty(
        "value",
        "Northstar Status",
      );
      vi.mocked(apiRequest).mockResolvedValueOnce({ ...live, revision: 4 });
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() =>
        expect(apiRequest).toHaveBeenLastCalledWith(
          "status-page",
          expect.objectContaining({
            revision: 3,
            name: "Northstar Status",
            footerText: "Edited elsewhere",
          }),
          "org-one",
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the draft current through this session's own live actions", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const user = userEvent.setup();
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      mount();
      await ready();
      await user.click(screen.getByRole("tab", { name: "Settings" }));
      await user.type(screen.getByLabelText("Footer text"), "Hi");
      await user.click(screen.getByRole("tab", { name: "Overview" }));
      await user.click(
        screen.getByRole("button", { name: "Post an announcement" }),
      );
      await user.type(
        screen.getByRole("textbox", { name: "Announcement" }),
        "Wipe at 7",
      );
      const posted = { ...live, revision: 3, announcement: "Wipe at 7" };
      vi.mocked(apiRequest).mockResolvedValueOnce(posted);
      await user.click(
        screen.getByRole("button", { name: "Post announcement" }),
      );
      await said("Announcement posted.");
      await poll(posted);
      const bar = screen.getByRole("region", { name: "Unsaved changes" });
      expect(bar.textContent).not.toContain("another session");
      vi.mocked(apiRequest).mockResolvedValueOnce({ ...posted, revision: 4 });
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() =>
        expect(apiRequest).toHaveBeenLastCalledWith(
          "status-page",
          expect.objectContaining({
            revision: 3,
            footerText: "Hi",
            announcement: "Wipe at 7",
          }),
          "org-one",
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges targets one by one when loading the latest version", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    await user.click(
      screen.getByRole("button", { name: "Show EU main on the public page" }),
    );
    vi.mocked(apiRequest).mockRejectedValueOnce(conflictError);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Load latest, keep my edits" });
    // Elsewhere: Wings host was renamed and a Store target was added.
    const store = {
      ...live.components[0],
      id: "c-store",
      name: "Store",
      kind: "url" as const,
      sourceId: "https://store.example.com",
      sourceName: "https://store.example.com",
      tagId: "",
      groupName: "",
    };
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      revision: 5,
      components: [
        live.components[0],
        { ...live.components[1], name: "Wings box" },
        store,
      ],
    });
    await user.click(
      screen.getByRole("button", { name: "Load latest, keep my edits" }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Show Store on the public page",
      }),
    ).toBeTruthy();
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...live, revision: 6 });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        expect.objectContaining({
          revision: 5,
          components: [
            expect.objectContaining({ id: "c-eu", public: false }),
            expect.objectContaining({ id: "c-host", name: "Wings box" }),
            expect.objectContaining({ id: "c-store", name: "Store" }),
          ],
        }),
        "org-one",
      ),
    );
  });

  it("rebases fields three ways and names the ones both sides changed", () => {
    const base = draftOf(live);
    const mine = {
      ...base,
      footerText: "Mine",
      links: [{ label: "Discord", url: "https://discord.gg/mine" }],
      components: [...base.components].reverse(),
    };
    const latest = {
      ...base,
      footerText: "Theirs",
      name: "Renamed elsewhere",
      components: base.components.slice(0, 1),
    };
    const { draft, overlaps } = rebaseDraft(base, mine, latest);
    expect(draft.footerText).toBe("Mine");
    expect(draft.name).toBe("Renamed elsewhere");
    expect(draft.links).toEqual(mine.links);
    // Wings host was removed elsewhere and was not edited here: it stays gone.
    expect(draft.components.map((c) => c.id)).toEqual(["c-eu"]);
    expect(overlaps).toContain("footer text");
  });

  it("publishes the logo only after the rest of the draft saves", async () => {
    const user = userEvent.setup();
    stubImages();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    let logoOk = false;
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (
        path.startsWith("/app-api/status-page/logo") &&
        init?.method === "POST"
      )
        return logoOk
          ? Response.json({ ...live, revision: 4, logoVersion: 9 })
          : Response.json(
              { error: "Choose a simpler logo image." },
              { status: 400 },
            );
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    const posts = () =>
      fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    const uploads = () => posts().length;
    const revisionSent = () =>
      (posts().at(-1)?.[1]?.headers as Record<string, string>)[
        "X-Cupboard-Logo-Revision"
      ];
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.upload(
      screen.getByLabelText("Logo file"),
      new File(["png"], "logo.png", { type: "image/png" }),
    );
    const editor = await screen.findByRole("dialog", { name: "Edit logo" });
    await user.click(within(editor).getByRole("button", { name: "Use logo" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit logo" })).toBeNull(),
    );
    await user.type(screen.getByLabelText("Footer text"), "Hi");

    // 1. The page save fails: the logo is never sent and stays staged.
    vi.mocked(apiRequest).mockRejectedValueOnce(
      new Error("That public address is already in use."),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText("That public address is already in use."),
    ).toBeTruthy();
    expect(uploads()).toBe(0);
    expect(screen.getByText("New logo")).toBeTruthy();

    // 2. The page saves and the logo upload fails: the bar says so exactly.
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      revision: 3,
      footerText: "Hi",
    });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText(
        /Saved, except the new logo\. Choose a simpler logo image\./,
      ),
    ).toBeTruthy();
    expect(uploads()).toBe(1);
    // Checked against the revision the page save just wrote.
    expect(revisionSent()).toBe("3");
    expect(screen.getByText("New logo")).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();

    // 3. Retrying sends only the logo.
    logoOk = true;
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await savedInBar();
    expect(uploads()).toBe(2);
    expect(revisionSent()).toBe("3");
    expect(apiRequest).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("New logo")).toBeNull();
  });

  it("keeps edits typed while Save is pending (codex D-36)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const name = screen.getByLabelText("Page name");
    await user.clear(name);
    await user.type(name, "Sent name");
    let respond: (value: StatusPageState) => void = () => {};
    vi.mocked(apiRequest).mockImplementationOnce(
      () => new Promise((resolve) => (respond = resolve)),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        expect.objectContaining({ revision: 2, name: "Sent name" }),
        "org-one",
      ),
    );
    // Typed while the request is still pending, on both draft tabs.
    await user.clear(screen.getByLabelText("Page name"));
    await user.type(screen.getByLabelText("Page name"), "Newer local name");
    await user.type(screen.getByLabelText("Footer text"), "Late");
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    await user.click(
      screen.getByRole("button", { name: "Show EU main on the public page" }),
    );
    await act(async () => respond({ ...live, revision: 3, name: "Sent name" }));
    // The later edits are the new draft, on top of the saved revision, and
    // the bar says what was saved and what is not (claude D-58, codex D-37):
    // never a bare "saved" beside it.
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    await waitFor(() =>
      expect(bar.textContent).toContain(
        "Saved your earlier changes. Not saved yet: 1 target changed, page name, and footer text.",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: /^Settings/ }));
    expect(screen.getByLabelText("Page name")).toHaveProperty(
      "value",
      "Newer local name",
    );
    expect(screen.getByLabelText("Footer text")).toHaveProperty(
      "value",
      "Late",
    );
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...live, revision: 4 });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        expect.objectContaining({
          revision: 3,
          name: "Newer local name",
          footerText: "Late",
          components: [
            expect.objectContaining({ id: "c-eu", public: false }),
            expect.objectContaining({ id: "c-host" }),
          ],
        }),
        "org-one",
      ),
    );
  });

  // a11y D-R8-01, D-R8-02, claude D-95, codex D-49: the "saved" toast
  // landed 400 to 700 pixels from the Save button and, moving between screen
  // edges, was announced 2 to 4 times. The bar the operator just pressed now
  // says it, once, in a status region that was there before the text.
  it("confirms Save in the save bar, announced once, with no toast", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const name = screen.getByLabelText("Page name");
    await user.type(name, " now");
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    const status = within(bar).getByRole("status");
    expect(status.textContent).toBe("");
    const changes: string[] = [];
    const observer = new MutationObserver(() =>
      changes.push(status.textContent ?? ""),
    );
    observer.observe(status, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      revision: 3,
      name: `${live.name} now`,
    });
    const save = within(bar).getByRole("button", { name: "Save changes" });
    save.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(status.textContent).toContain("Saved"));
    observer.disconnect();

    // The same node, filled once; nothing else on the page says it.
    expect(status.isConnected).toBe(true);
    expect(screen.getByRole("region", { name: "Changes saved" })).toBe(bar);
    expect(new Set(changes.filter(Boolean))).toEqual(
      new Set([status.textContent]),
    );
    const sayers = [
      ...document.querySelectorAll("[aria-live], [role=status], [role=alert]"),
    ].filter((element) => element.textContent?.includes("Saved"));
    expect(sayers).toEqual([status]);
    expect(toast.success).not.toHaveBeenCalled();
    // No buttons left to press, and focus went back to the field.
    expect(within(bar).queryByRole("button")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Page name"));

    // The next edit brings the unsaved bar straight back.
    await user.type(screen.getByLabelText("Page name"), "!");
    expect(
      screen.getByRole("region", { name: "Unsaved changes" }).textContent,
    ).not.toContain("Saved");
    expect(within(bar).getByRole("status").textContent).toBe("");
    // Discarding that edit doesn't bring "Saved" back.
    await user.click(within(bar).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("region", { name: "Changes saved" })).toBeNull();
  });

  // claude D-102, a11y D-R9-04: focus rested on the page for a moment
  // between Save leaving and the field getting it back.
  it("moves focus back to the field before Save goes, so it never rests on the page", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const footer = screen.getByLabelText("Footer text");
    await user.type(footer, "Hi");
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    const save = within(bar).getByRole("button", { name: "Save changes" });
    // Where focus is the moment Save leaves the page.
    let focusWhenGone: Element | null | undefined;
    const observer = new MutationObserver(() => {
      if (focusWhenGone === undefined && !save.isConnected)
        focusWhenGone = document.activeElement;
    });
    observer.observe(bar, { childList: true, subtree: true });
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      revision: 3,
      footerText: `${live.footerText}Hi`,
    });
    save.focus();
    await user.keyboard("{Enter}");
    await savedInBar();
    observer.disconnect();
    expect(focusWhenGone).toBe(footer);
    expect(document.activeElement).toBe(footer);
  });

  // claude D-103: a pointer left resting on the bar after a click kept
  // "Saved" up indefinitely. It has nothing to act on, so it leaves on time.
  it("lets Saved go on time with the pointer resting on the bar", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.type(screen.getByLabelText("Footer text"), "Hi");
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      revision: 3,
      footerText: `${live.footerText}Hi`,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const save = screen.getByRole("button", { name: "Save changes" });
      fireEvent.pointerEnter(save.closest('[role="region"]')!);
      fireEvent.pointerOver(save);
      fireEvent.click(save);
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const bar = screen.getByRole("region", { name: "Changes saved" });
      fireEvent.pointerEnter(bar);
      fireEvent.pointerMove(bar);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(
        screen.queryByRole("region", { name: "Changes saved" }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the Saved bar at least 6 seconds, then lets it go", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.type(screen.getByLabelText("Footer text"), "Hi");
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      revision: 3,
      footerText: `${live.footerText}Hi`,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const bar = screen.getByRole("region", { name: "Changes saved" });
      expect(within(bar).getByRole("status").textContent).toContain("Saved");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_900);
      });
      expect(screen.getByRole("region", { name: "Changes saved" })).toBe(bar);
      // Then it slides away.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(
        screen.queryByRole("region", { name: "Changes saved" }),
      ).toBeNull();
      expect(
        screen.queryByRole("region", { name: "Unsaved changes" }),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // claude D-97, codex D-50, a11y D-R9-01: when the Saved bar left, the page
  // lost the space kept for it and, at the end of Settings, the browser
  // clamped the scroll: the focused field dropped 65 to 161 pixels about 6
  // seconds after Save. The space now stays until releasing it moves nothing.
  describe.each([
    // Tablets and desktops: sticky, in the page's flow, 66 pixels.
    { position: "sticky", height: 66, end: 66 },
    // Phones: fixed to the screen edge, the page pads its end by the bar
    // and a 16 pixel gap.
    { position: "fixed", height: 121, end: 137 },
  ])("a $position save bar", ({ position, height, end }) => {
    const isBar = (element: Element) =>
      element.getAttribute("role") === "region" &&
      ["Unsaved changes", "Changes saved"].includes(
        element.getAttribute("aria-label") ?? "",
      );
    /** The bar's own height in the page's flow, or the space kept for it. */
    const pageEnd = (page: HTMLElement) => {
      const last = page.lastElementChild as HTMLElement | null;
      const flow = !last
        ? 0
        : isBar(last)
          ? position === "fixed"
            ? 0
            : height
          : last.getAttribute("aria-hidden") === "true"
            ? parseFloat(last.style.height || "0")
            : 0;
      return parseFloat(page.style.paddingBottom || "0") + flow;
    };
    function stubLayout() {
      const real = window.getComputedStyle.bind(window);
      vi.spyOn(window, "getComputedStyle").mockImplementation(
        (element, pseudo) => {
          const style = real(element, pseudo);
          if (!isBar(element)) return style;
          return new Proxy(style, {
            get: (target, key) =>
              key === "position" ? position : Reflect.get(target, key, target),
          });
        },
      );
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
        function (this: HTMLElement) {
          return isBar(this) ? height : 0;
        },
      );
    }
    async function saveAndWait() {
      const user = userEvent.setup();
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      mount();
      await ready();
      await user.click(screen.getByRole("tab", { name: "Settings" }));
      await user.type(screen.getByLabelText("Footer text"), "Hi");
      const bar = screen.getByRole("region", { name: "Unsaved changes" });
      const page = bar.parentElement!;
      const before = pageEnd(page);
      vi.mocked(apiRequest).mockResolvedValueOnce({
        ...live,
        revision: 3,
        footerText: `${live.footerText}Hi`,
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      fireEvent.click(
        within(bar).getByRole("button", { name: "Save changes" }),
      );
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      return { bar, page, before };
    }

    it("keeps the page end where it was through Save and after the bar leaves", async () => {
      stubLayout();
      try {
        const { bar, page, before } = await saveAndWait();
        expect(before).toBe(end);
        expect(screen.getByRole("region", { name: "Changes saved" })).toBe(bar);
        expect(pageEnd(page)).toBe(end);
        // Fixed, the Saved bar can shrink to one line from its top: the
        // page keeps the space it had (claude D-101). In the flow, it keeps
        // its height.
        expect(bar.style.minHeight).toBe(
          position === "fixed" ? "" : `${height}px`,
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        expect(pageEnd(page)).toBe(end);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
        expect(
          screen.queryByRole("region", { name: "Changes saved" }),
        ).toBeNull();
        // Gone, and the page end has not moved.
        expect(pageEnd(page)).toBe(end);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(pageEnd(page)).toBe(end);
        expect(document.activeElement).toBe(
          screen.getByLabelText("Footer text"),
        );
      } finally {
        vi.useRealTimers();
      }
      // Another tab replaces the page under it: the space goes with it.
      fireEvent.mouseDown(screen.getByRole("tab", { name: "Overview" }));
      fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
      await waitFor(() =>
        expect(
          pageEnd(screen.getByRole("tabpanel").parentElement!.parentElement!),
        ).toBe(0),
      );
    });

    it("lets the space go once it is scrolled out of view, not before", async () => {
      stubLayout();
      try {
        const { page } = await saveAndWait();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
        const space = page.lastElementChild as HTMLElement;
        expect(space.getAttribute("aria-hidden")).toBe("true");
        const top = { value: window.innerHeight - 40 };
        vi.spyOn(space, "getBoundingClientRect").mockImplementation(
          () => ({ top: top.value }) as DOMRect,
        );
        // Still on screen: kept, so nothing moves.
        await act(async () => {
          window.dispatchEvent(new Event("scroll"));
          await vi.advanceTimersByTimeAsync(20);
        });
        expect(pageEnd(page)).toBe(end);
        // Below the screen's bottom edge: letting it go moves nothing.
        top.value = window.innerHeight + 10;
        await act(async () => {
          window.dispatchEvent(new Event("scroll"));
          await vi.advanceTimersByTimeAsync(20);
        });
        expect(pageEnd(page)).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("checks the page revision before a logo is removed or replaced (codex D-26)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const user = userEvent.setup();
      stubImages();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () => new Response(new Blob(["png"], { type: "image/png" })),
        ),
      );
      const withLogo = { ...live, logoVersion: 4 };
      vi.mocked(apiRequest).mockResolvedValueOnce(withLogo);
      mount();
      await ready();
      await user.click(screen.getByRole("tab", { name: "Settings" }));
      await user.click(
        await screen.findByRole("button", { name: "Remove logo" }),
      );
      await user.click(screen.getByRole("button", { name: "Remove" }));
      expect(screen.getByText("Logo removed")).toBeTruthy();
      // Another session replaced the logo: the page revision moved on.
      const replaced = { ...withLogo, revision: 3, logoVersion: 7 };
      await poll(replaced);
      const bar = screen.getByRole("region", { name: "Unsaved changes" });
      await waitFor(() =>
        expect(bar.textContent).toContain("Changed in another session"),
      );
      expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
      expect(apiRequest).not.toHaveBeenCalledWith(
        "status-page/logo/remove",
        expect.anything(),
        expect.anything(),
      );

      vi.mocked(apiRequest).mockResolvedValueOnce(replaced);
      await user.click(
        screen.getByRole("button", { name: "Load latest, keep my edits" }),
      );
      await waitFor(() => expect(bar.textContent).toContain("logo"));
      expect(bar.textContent).toContain(
        "Your logo replaces the other session's.",
      );
      vi.mocked(apiRequest).mockResolvedValueOnce({
        ...replaced,
        revision: 4,
        logoVersion: null,
      });
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() =>
        expect(apiRequest).toHaveBeenLastCalledWith(
          "status-page/logo/remove",
          { revision: 3 },
          "org-one",
        ),
      );
      // A logo-only Save sends no page save.
      expect(
        vi
          .mocked(apiRequest)
          .mock.calls.filter(
            ([path, body]) => path === "status-page" && body !== undefined,
          ),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns about a logo staged while the latest version loads (codex D-26)", async () => {
    const user = userEvent.setup();
    stubImages();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }))),
    );
    const withLogo = { ...live, logoVersion: 4 };
    vi.mocked(apiRequest).mockResolvedValueOnce(withLogo);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.type(screen.getByLabelText("Footer text"), "Mine");
    vi.mocked(apiRequest).mockRejectedValueOnce(conflictError);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    let respond: (value: StatusPageState) => void = () => {};
    vi.mocked(apiRequest).mockImplementationOnce(
      () => new Promise((resolve) => (respond = resolve)),
    );
    await user.click(
      await screen.findByRole("button", { name: "Load latest, keep my edits" }),
    );
    // Staged while the latest version is still loading.
    await user.upload(
      screen.getByLabelText("Logo file"),
      new File(["png"], "logo.png", { type: "image/png" }),
    );
    const editor = await screen.findByRole("dialog", { name: "Edit logo" });
    await user.click(within(editor).getByRole("button", { name: "Use logo" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit logo" })).toBeNull(),
    );
    await act(async () =>
      respond({ ...withLogo, revision: 5, logoVersion: 7 }),
    );
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    await waitFor(() =>
      expect(bar.textContent).toContain(
        "Your logo replaces the other session's.",
      ),
    );
  });

  it("names a target edited here and removed elsewhere, and the reverse (codex D-07)", () => {
    const base = draftOf(live);
    const [eu, host] = base.components;
    // Renamed here, removed elsewhere.
    const restored = rebaseDraft(
      base,
      { ...base, components: [{ ...eu, name: "EU primary" }, host] },
      { ...base, components: [host] },
    );
    expect(restored.draft.components.map((c) => c.name)).toEqual([
      "EU primary",
      "Wings host",
    ]);
    expect(restored.targets).toEqual([
      { kind: "restored", name: "EU primary" },
    ]);
    expect(restored.overlaps).toContain("EU primary");
    // Removed here, renamed elsewhere.
    const removed = rebaseDraft(
      base,
      { ...base, components: [eu] },
      { ...base, components: [eu, { ...host, name: "Wings box" }] },
    );
    expect(removed.draft.components.map((c) => c.id)).toEqual(["c-eu"]);
    // Named as the operator knew it, with the other session's new name
    // (codex D-38, claude D-61).
    expect(removed.targets).toEqual([
      { kind: "removed", name: "Wings host", now: "Wings box" },
    ]);
    expect(removed.overlaps).toContain("Wings host");
    expect(mergeNotice(removed).items).toEqual([
      "Wings host was renamed Wings box elsewhere. Saving removes it.",
    ]);
    // Edited on both sides: named, independent fields combined.
    const both = rebaseDraft(
      base,
      { ...base, components: [{ ...eu, name: "EU primary" }, host] },
      { ...base, components: [{ ...eu, public: false }, host] },
    );
    expect(both.draft.components[0]).toMatchObject({
      name: "EU primary",
      public: false,
    });
    expect(both.targets).toEqual([
      { kind: "combined", name: "EU primary", now: "EU primary" },
    ]);
    // Renamed elsewhere only: the notice says what it is called now.
    const renamed = rebaseDraft(
      base,
      { ...base, components: [{ ...eu, public: false }, host] },
      { ...base, components: [{ ...eu, public: false, name: "EU A" }, host] },
    );
    expect(mergeNotice(renamed).items).toEqual([
      "EU main changed in both sessions. Both changes are kept, as EU A.",
    ]);
    // The same field changed differently on both sides: the operator's wins.
    const clash = rebaseDraft(
      base,
      { ...base, components: [{ ...eu, name: "EU here" }, host] },
      { ...base, components: [{ ...eu, name: "EU there" }, host] },
    );
    expect(clash.draft.components[0].name).toBe("EU here");
    expect(mergeNotice(clash).items).toEqual([
      "EU here changed in both sessions. Saving uses your name.",
    ]);
    // Untouched here, removed elsewhere: stays removed without a warning.
    const quiet = rebaseDraft(
      base,
      { ...base, footerText: "Hi" },
      { ...base, components: [eu] },
    );
    expect(quiet.draft.components.map((c) => c.id)).toEqual(["c-eu"]);
    expect(quiet.overlaps).toEqual([]);
  });

  it("names a target both sessions added with different choices (codex D-07)", () => {
    const base = { ...draftOf(live), components: [] };
    const [eu] = draftOf(live).components;
    const mine = {
      ...base,
      components: [{ ...eu, id: null, name: "Local addition", public: true }],
    };
    const theirs = {
      ...base,
      components: [
        { ...eu, id: "c-remote", name: "Remote addition", public: false },
      ],
    };
    const both = rebaseDraft(base, mine, theirs);
    // The operator's choices win, on the other session's saved row.
    expect(both.draft.components).toEqual([
      expect.objectContaining({
        id: "c-remote",
        name: "Local addition",
        public: true,
      }),
    ]);
    expect(both.overlaps).toContain("Local addition");
    expect(mergeNotice(both).items).toContain(
      "Local addition was also added elsewhere, as Remote addition. Saving uses your name and visibility (shown to players).",
    );
    // The same addition on both sides needs no decision.
    const same = rebaseDraft(base, mine, {
      ...base,
      components: [{ ...mine.components[0], id: "c-remote" }],
    });
    expect(same.draft.components[0].id).toBe("c-remote");
    expect(same.overlaps).toEqual([]);
  });

  it("merges header links as whole links, never mixing a label and a URL (codex D-32)", () => {
    const base = {
      ...draftOf(live),
      links: [
        { label: "Website", url: "https://a.example.com" },
        { label: "Discord", url: "https://b.example.com" },
      ],
    };
    const mine = {
      ...base,
      links: [{ ...base.links[0], label: "Our homepage" }, base.links[1]],
    };
    const latest = {
      ...base,
      links: [base.links[1], { label: "Docs", url: "https://c.example.com" }],
    };
    const { draft, overlaps } = rebaseDraft(base, mine, latest);
    expect(draft.links).toEqual(mine.links);
    expect(overlaps).toContain("header links");
    // Changed on one side only: that side's whole list.
    expect(rebaseDraft(base, base, latest).draft.links).toEqual(latest.links);
    expect(rebaseDraft(base, mine, base).draft.links).toEqual(mine.links);
  });

  it("shows the whole merge notice and names restored targets (claude D-47)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    await user.click(
      screen.getByRole("button", { name: "Show EU main on the public page" }),
    );
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.type(screen.getByLabelText("Footer text"), "Mine");
    vi.mocked(apiRequest).mockRejectedValueOnce(conflictError);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      revision: 5,
      footerText: "Theirs",
      components: [live.components[1]],
    });
    await user.click(
      await screen.findByRole("button", { name: "Load latest, keep my edits" }),
    );
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    // One decision per line (claude D-61).
    await waitFor(() =>
      expect(
        within(bar)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        "Your footer text replaces the other session's.",
        "EU main was removed elsewhere. Saving adds it back.",
      ]),
    );
    expect(bar.textContent).toContain("Check the merged changes");
    expect(bar.querySelector(".truncate")).toBeNull();
  });

  it("folds a long merge notice on phones behind Show all (a11y D-71)", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query === "(max-width: 639px)",
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    const user = userEvent.setup();
    const eu = live.components[0];
    const many = {
      ...live,
      components: [
        ...live.components,
        ...[2, 3, 4].map((n) => ({
          ...eu,
          id: `c-eu-${n}`,
          name: `EU ${n}`,
          sourceId: `server-eu-${n}`,
        })),
      ],
    };
    vi.mocked(apiRequest).mockResolvedValueOnce(many);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    for (const name of ["EU main", "EU 2", "EU 3", "EU 4"])
      await user.click(
        screen.getByRole("button", { name: `Show ${name} on the public page` }),
      );
    vi.mocked(apiRequest).mockRejectedValueOnce(conflictError);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...many,
      revision: 5,
      components: [live.components[1]],
    });
    await user.click(
      await screen.findByRole("button", { name: "Load latest, keep my edits" }),
    );
    const bar = screen.getByRole("region", { name: "Unsaved changes" });
    const items = () =>
      within(bar)
        .getAllByRole("listitem")
        .map((item) => item.textContent);
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(items()[0]).toBe(
      "EU main was removed elsewhere. Saving adds it back.",
    );
    const more = within(bar).getByRole("button", {
      name: "Show all 4 changes",
    });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await user.click(more);
    expect(items()).toHaveLength(4);
    // The list scrolls inside the bar, which is capped at half the screen.
    const area = within(bar).getByRole("group", { name: "Merged changes" });
    expect(area.className).toContain("overflow-y-auto");
    expect(area.getAttribute("tabindex")).toBe("0");
    expect(bar.className).toContain("max-h-[50dvh]");
    const fewer = within(bar).getByRole("button", { name: "Show fewer" });
    expect(fewer.getAttribute("aria-expanded")).toBe("true");
    await user.click(fewer);
    expect(items()).toHaveLength(3);
  });

  it("keeps the chosen accent visible in forced colors (claude D-64)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const presets = screen.getByLabelText("Accent presets");
    await user.click(presets.querySelector<HTMLElement>("[data-value]")!);
    const chosen = presets.querySelector('[aria-checked="true"]');
    expect(chosen).toBeTruthy();
    // The swatch keeps its color; selection is a Highlight edge and a
    // HighlightText check on Highlight, not the theme's colors.
    expect(chosen!.className).toContain("forced-color-adjust-none");
    expect(chosen!.className).toContain(
      "forced-colors:aria-checked:border-[Highlight]",
    );
    const check = chosen!.querySelector('[data-slot="accent-check"]');
    expect(check?.className).toContain("forced-colors:bg-[Highlight]");
    expect(check?.className).toContain("forced-colors:text-[HighlightText]");
    // The accent field's dot keeps the chosen color too.
    const dot = screen
      .getByLabelText("Accent color")
      .parentElement?.querySelector('span[aria-hidden="true"]');
    expect(dot?.className).toContain("forced-color-adjust-none");
  });

  // a11y D-84, codex D-45: the same error also showed in a toast, which at
  // 834 covered the Theme cards. It shows once, on the tile, as an alert.
  it("shows a refused logo file on the tile only, as an alert", async () => {
    const user = userEvent.setup({ applyAccept: false });
    vi.mocked(apiRequest).mockResolvedValueOnce(empty);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.upload(
      screen.getByLabelText("Logo file"),
      new File(["text"], "notes.txt", { type: "text/plain" }),
    );
    const message = "Choose a PNG, JPEG, WebP, GIF, or SVG image.";
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(message);
    const tile = screen.getByRole("button", { name: "Add logo" });
    expect(tile.getAttribute("aria-describedby")).toBe("logo-error logo-hint");
    expect(document.getElementById("logo-error")?.textContent).toBe(message);
    // A file Cupboard can use clears it.
    stubImages();
    await user.upload(
      screen.getByLabelText("Logo file"),
      new File(["png"], "logo.png", { type: "image/png" }),
    );
    await screen.findByRole("dialog", { name: "Edit logo" });
    expect(document.getElementById("logo-error")).toBeNull();
  });

  it("asks before the browser's Back button drops unsaved changes", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    await user.click(
      screen.getByRole("button", { name: "Show EU main on the public page" }),
    );
    await waitFor(() =>
      expect(window.history.state?.cupboardUnsavedGuard).toBe(true),
    );
    act(() => window.history.back());
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Leave without saving?");
    expect(confirm.textContent).toContain(
      "You have unsaved changes. They are lost if you leave.",
    );
    expect(confirm.textContent).toContain("1 target changed.");
    await user.click(
      within(confirm).getByRole("button", { name: "Keep editing" }),
    );
    expect(window.history.state?.cupboardUnsavedGuard).toBe(true);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    // Discarding takes the extra entry back off.
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(window.history.state?.cupboardUnsavedGuard).toBeUndefined(),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("Status page admin errors and focus", () => {
  const unavailable = new Error("Cupboard is unavailable. Try again.");

  it("keeps a failed Delete window in its dialog, not only in a toast (claude D-80)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(
      screen.getByRole("button", { name: "Actions for Monthly wipe" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    vi.mocked(apiRequest).mockRejectedValueOnce(unavailable);
    const remove = within(confirm).getByRole("button", {
      name: "Delete window",
    });
    await user.click(remove);
    const alert = await within(confirm).findByRole("alert");
    expect(alert.textContent).toContain("Cupboard is unavailable. Try again.");
    expect(toast.error).not.toHaveBeenCalled();
    // The dialog stays open and focus stays on the action to try again.
    expect(screen.getByRole("alertdialog")).toBe(confirm);
    expect(document.activeElement).toBe(remove);
  });

  it("keeps a failed Mark complete in its dialog (claude D-80)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(screen.getByRole("button", { name: "Mark complete" }));
    const confirm = await screen.findByRole("alertdialog");
    vi.mocked(apiRequest).mockRejectedValueOnce(unavailable);
    await user.click(
      within(confirm).getByRole("button", { name: "Mark complete" }),
    );
    expect((await within(confirm).findByRole("alert")).textContent).toContain(
      "Cupboard is unavailable.",
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows a failed Publish in the pill and a failed announcement in its dialog (claude D-80)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...live, published: false });
    mount();
    await ready();
    vi.mocked(apiRequest).mockRejectedValueOnce(unavailable);
    await user.click(screen.getByRole("button", { name: /^Private/ }));
    const popover = await screen.findByRole("dialog");
    await user.click(
      within(popover).getByRole("button", { name: "Publish page" }),
    );
    const alert = await within(popover).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't publish the page.");
    expect(alert.textContent).toContain("Cupboard is unavailable.");
    expect(toast.error).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");

    await user.click(
      screen.getByRole("button", { name: "Post an announcement" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Announcement"), "Wipe.");
    vi.mocked(apiRequest).mockRejectedValueOnce(unavailable);
    await user.click(
      within(dialog).getByRole("button", { name: "Post announcement" }),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "Cupboard is unavailable.",
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps a failed Unpublish in its dialog (claude D-80)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(screen.getByRole("button", { name: /^Public/ }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Unpublish page",
      }),
    );
    const confirm = await screen.findByRole("alertdialog");
    vi.mocked(apiRequest).mockRejectedValueOnce(unavailable);
    await user.click(
      within(confirm).getByRole("button", { name: "Unpublish page" }),
    );
    expect((await within(confirm).findByRole("alert")).textContent).toContain(
      "Cupboard is unavailable.",
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("returns focus to the edited field after a keyboard Save (claude D-81)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    const footer = screen.getByLabelText("Footer text");
    await user.type(footer, "Northstar");
    const save = screen.getByRole("button", { name: "Save changes" });
    save.focus();
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      revision: 3,
      footerText: "Northstar",
    });
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Unsaved changes" }),
      ).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(footer));
  });

  it("shows a repeated hour's choice on Enter before scheduling (a11y D-79)", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2027, 10, 7, 0, 10));
    try {
      const user = userEvent.setup();
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      mount();
      await ready();
      await user.click(
        screen.getAllByRole("button", { name: "Schedule maintenance" })[0],
      );
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Title"), "Wipe");
      const start = within(dialog).getByLabelText("Start time");
      await user.clear(start);
      await user.type(start, "1:30am{Enter}");
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(dialog).getByRole("radio", { name: "1:30 AM EDT" }),
        ),
      );
      expect(
        vi
          .mocked(apiRequest)
          .mock.calls.filter(([path]) => path === "status-page/maintenance"),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      process.env.TZ = zone;
    }
  });
  // a11y D-82: after the choice showed, retyping a plain time and pressing
  // Tab dropped focus to the dialog. A browser blurs the field before the
  // next control takes focus; the check's re-render removed nodes in that
  // gap, and the dialog's focus trap took focus back to itself.
  it("tabs on from a repeated hour retyped as a plain time (a11y D-82)", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/New_York";
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2027, 10, 7, 0, 10));
    try {
      const user = userEvent.setup();
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      mount();
      await ready();
      await user.click(
        screen.getAllByRole("button", { name: "Schedule maintenance" })[0],
      );
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("Title"), "Wipe");
      const start = within(dialog).getByLabelText("Start time");
      await user.clear(start);
      await user.type(start, "1:30am{Tab}");
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(dialog).getByRole("radio", { name: "1:30 AM EDT" }),
        ),
      );
      await user.click(start);
      await user.clear(start);
      await user.type(start, "3:00pm");

      // Tab as a browser does it: unless the field takes the key, the field
      // blurs, handlers and microtasks run, then the next control is focused
      // if focus is still nowhere.
      const length = dialog.querySelector<HTMLElement>(
        '[aria-labelledby="maintenance-length-label"]',
      )!;
      const tab = fireEvent.keyDown(start, { key: "Tab" });
      if (tab) {
        act(() => start.blur());
        await act(async () => {
          await Promise.resolve();
        });
        if (document.activeElement === document.body) act(() => length.focus());
      }
      await waitFor(() =>
        expect(length.contains(document.activeElement)).toBe(true),
      );
      expect(start).toHaveProperty("value", "3:00 PM");
      expect(within(dialog).queryByRole("radio", { name: /1:30 AM/ })).toBe(
        null,
      );
    } finally {
      vi.useRealTimers();
      process.env.TZ = zone;
    }
  });
});

/* Round 11: the operator's own annotations. Every control the quieter header
   drops still has a home, the Overview leads with the true status, and a
   dragged row follows the pointer. */
describe("Status page admin, every action reachable", () => {
  const phone = () =>
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query === "(max-width: 639px)",
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
  const pill = (name: RegExp) => screen.getByRole("button", { name });

  it("keeps the header to a linked title and the Public pill", async () => {
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    const heading = screen.getByRole("heading", { level: 1 });
    // The title is the way to visit the public page, in a new tab.
    const link = within(heading).getByRole("link");
    expect(link.getAttribute("href")).toBe("/status/northstar-games");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.textContent).toMatch(/^Status page/);
    expect(link.textContent).toContain("opens in a new tab");
    // Gone: the address line, Visit, the More menu, Preview, and Schedule.
    expect(screen.queryByText(/\/status\/northstar-games$/)).toBeNull();
    expect(screen.queryByRole("link", { name: /Visit/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "More page actions" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Preview/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy public address" }),
    ).toBeNull();
    // Schedule maintenance lives in the Maintenance card only.
    const schedules = screen.getAllByRole("button", {
      name: "Schedule maintenance",
    });
    expect(schedules).toHaveLength(1);
    expect(
      screen
        .getByRole("region", { name: /^Maintenance/ })
        .contains(schedules[0]),
    ).toBe(true);
    expect(pill(/^Public/)).toBeTruthy();
    expect(screen.queryByText("Published")).toBeNull();
  });

  it("publishes from the Private pill and lands on the title link", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...live, published: false });
    mount();
    await ready();
    const heading = screen.getByRole("heading", { level: 1 });
    // A private page has nothing to visit: the title is plain text.
    expect(within(heading).queryByRole("link")).toBeNull();
    await user.click(pill(/^Private/));
    const popover = await screen.findByRole("dialog");
    expect(popover.textContent).toContain("/status/northstar-games");
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...live, revision: 3 });
    await user.click(
      within(popover).getByRole("button", { name: "Publish page" }),
    );
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        expect.objectContaining({ revision: 2, published: true }),
        "org-one",
      ),
    );
    await said("Status page published.");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(screen.getByRole("heading", { level: 1 })).getByRole("link"),
      ),
    );
    expect(pill(/^Public/)).toBeTruthy();
  });

  it("publishing never saves drafted edits", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...live, published: false });
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.type(screen.getByLabelText("Footer text"), "Draft footer");
    await user.click(pill(/^Private/));
    vi.mocked(apiRequest).mockResolvedValueOnce({ ...live, revision: 3 });
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Publish page",
      }),
    );
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        expect.objectContaining({ published: true, footerText: "" }),
        "org-one",
      ),
    );
    expect(screen.getByLabelText("Footer text")).toHaveProperty(
      "value",
      "Draft footer",
    );
  });

  it("copies and unpublishes from the Public pill, with a confirmation", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    mount();
    await ready();
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const copy = vi.fn(() => true);
    document.execCommand = copy;
    const trigger = pill(/^Public/);
    await user.click(trigger);
    let popover = await screen.findByRole("dialog");
    expect(popover.textContent).toContain("/status/northstar-games");
    await user.click(
      within(popover).getByRole("button", { name: "Copy public address" }),
    );
    expect(copy).toHaveBeenCalledWith("copy");
    await said("Public address copied.");

    await user.click(
      within(popover).getByRole("button", { name: "Unpublish page" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("see a not-found page");
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(pill(/^Public/)));

    await user.click(pill(/^Public/));
    popover = await screen.findByRole("dialog");
    await user.click(
      within(popover).getByRole("button", { name: "Unpublish page" }),
    );
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      revision: 3,
      published: false,
    });
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Unpublish page",
      }),
    );
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page",
        expect.objectContaining({ revision: 2, published: false }),
        "org-one",
      ),
    );
    await said("Status page unpublished.");
    await waitFor(() => expect(document.activeElement).toBe(pill(/^Private/)));
  });

  it("says a failed copy in the pill, with the address to select", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    document.execCommand = vi.fn(() => false);
    await user.click(pill(/^Public/));
    const popover = await screen.findByRole("dialog");
    await user.click(
      within(popover).getByRole("button", { name: "Copy public address" }),
    );
    const alert = await within(popover).findByRole("alert");
    expect(alert.textContent).toContain("Copy failed.");
    const address = popover.querySelector(".select-all")!;
    expect(address.textContent).toMatch(/\/status\/northstar-games$/);
    for (const mark of address.querySelectorAll("wbr"))
      expect(mark.previousSibling?.textContent?.endsWith("/")).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("lets viewers copy the address but never publish or unpublish", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount({ ...identity, permissions: ["infrastructure.view"] });
    await ready();
    await user.click(pill(/^Public/));
    const popover = await screen.findByRole("dialog");
    expect(
      within(popover).getByRole("button", { name: "Copy public address" }),
    ).toBeTruthy();
    expect(within(popover).queryByRole("button", { name: /publish/i })).toBe(
      null,
    );
    expect(
      screen.queryByRole("button", { name: "Schedule maintenance" }),
    ).toBeNull();
  });

  it("opens the pill from the keyboard and from a tap, with the word always in it", async () => {
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    const trigger = pill(/^Public/);
    // The word stays in the accessible name and the DOM when collapsed.
    const word = within(trigger).getByText("Public").closest("[data-fold]")!;
    // Collapsed only where a fine pointer can hover; touch always shows it,
    // and keyboard focus or an open popover expands it.
    expect(word.className).toContain(
      "[@media(hover:hover)_and_(pointer:fine)]",
    );
    expect(word.className).toContain("group-focus-visible/pill");
    expect(word.className).toContain("group-hover/pill");
    expect(word.className).toContain("group-data-[state=open]/pill");
    // Its width is reserved, so expanding moves nothing beside it.
    expect(trigger.parentElement?.className).toContain("grid");
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.pointerUp(trigger, { pointerType: "touch" });
    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("schedules maintenance from the card, empty or not", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ ...live, maintenance: [old] });
    mount();
    await ready();
    const card = screen.getByRole("region", { name: /^Maintenance/ });
    // Empty: the message, then the button below it, and past windows after.
    const message = within(card).getByText("No maintenance scheduled");
    const button = within(card).getByRole("button", {
      name: "Schedule maintenance",
    });
    expect(
      message.compareDocumentPosition(button) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: /Past windows/ }),
    ).toBeTruthy();
    await user.click(button);
    await screen.findByRole("dialog", { name: "Schedule maintenance" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(button));
    cleanup();

    // With windows, the card header holds the action.
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    const full = screen.getByRole("region", { name: /^Maintenance/ });
    expect(within(full).queryByText("No maintenance scheduled")).toBeNull();
    const action = within(full).getByRole("button", {
      name: "Schedule maintenance",
    });
    await user.click(action);
    await screen.findByRole("dialog", { name: "Schedule maintenance" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(action));
  });

  it("previews only in the editors, on phones and private pages too", async () => {
    phone();
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ ...live, published: false });
    mount();
    await ready();
    // Nothing is being edited on Overview.
    expect(screen.queryByRole("button", { name: /Preview/ })).toBeNull();
    for (const tab of ["Targets", "Settings"]) {
      await user.click(screen.getByRole("tab", { name: tab }));
      const open = screen.getByRole("button", { name: "Preview" });
      await user.click(open);
      const sheet = await screen.findByRole("dialog", {
        name: "Public preview",
      });
      expect(sheet.textContent).not.toContain("What visitors see");
      expect(sheet.textContent).not.toContain("Once published");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(document.activeElement).toBe(open));
    }
    // With unsaved changes too.
    await user.type(screen.getByLabelText("Footer text"), "Draft footer");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const sheet = await screen.findByRole("dialog", { name: "Public preview" });
    expect(sheet.textContent).toContain("Draft footer");
  });
});

describe("Status page admin, true status", () => {
  it("leads with every target's observed health, problems first", async () => {
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    expect(screen.queryByRole("region", { name: "What players see" })).toBe(
      null,
    );
    expect(screen.queryByText(/Hidden from players/)).toBeNull();
    // Hidden targets count: Wings host is hidden and down.
    const status = screen.getByRole("region", {
      name: "1 target needs attention",
    });
    const attention = within(status).getByRole("list", {
      name: "Needs attention",
    });
    expect(within(attention).getByText("Wings host")).toBeTruthy();
    expect(within(attention).getByText("Hidden")).toBeTruthy();
    expect(within(attention).getByText("Unavailable")).toBeTruthy();
    // The count says the hidden ones in words.
    expect(status.textContent).toContain("2 targets, 1 hidden");
    expect(
      within(status).getByRole("button", { name: "Manage targets" }),
    ).toBeTruthy();
  });

  it("never lets maintenance hide a target that is down", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ...live,
      components: live.components.map((c) =>
        c.id === "c-eu"
          ? { ...c, health: "down" as const, detail: "Query timed out" }
          : c,
      ),
    });
    mount();
    await ready();
    const status = screen.getByRole("region", {
      name: "2 targets need attention",
    });
    const attention = within(status).getByRole("list", {
      name: "Needs attention",
    });
    const eu = within(attention).getByText("EU main").closest("li")!;
    expect(eu.textContent).toContain("Unavailable");
    expect(eu.textContent).toContain("Maintenance");
    expect(eu.textContent).toContain("Query timed out");
  });

  it("says all targets are operational in words", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ...live,
      maintenance: [],
      components: live.components.map((c) => ({
        ...c,
        health: "operational" as const,
      })),
    });
    mount();
    await ready();
    expect(
      screen.getByRole("region", { name: "All 2 targets operational" }),
    ).toBeTruthy();
  });

  it("keeps the refresh warning and Retry on the status card", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      mount();
      await ready();
      vi.mocked(apiRequest).mockRejectedValueOnce(new TypeError("nope"));
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      const status = await screen.findByRole("region", {
        name: "1 target needs attention",
      });
      await waitFor(() =>
        expect(status.textContent).toContain("Couldn't refresh."),
      );
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      fireEvent.click(within(status).getByRole("button", { name: "Retry" }));
      await waitFor(() =>
        expect(status.textContent).not.toContain("Couldn't refresh."),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Status page admin, target dialog and live drag", () => {
  const grouped: StatusPageState = {
    ...live,
    components: [
      { ...live.components[0], tagId: "", groupName: "" },
      live.components[1],
    ],
  };
  /** Rows lay out 64 pixels tall, one after another, in jsdom. */
  function layRows() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const position = Number(this.dataset?.position ?? 0);
        const top = this.matches?.("li[data-position]") ? position * 64 : 0;
        return {
          top,
          bottom: top + 64,
          height: 64,
          left: 0,
          right: 600,
          width: 600,
          x: 0,
          y: top,
          toJSON() {},
        } as DOMRect;
      },
    );
  }
  const row = (name: string) =>
    screen.getByRole("button", { name: `Reorder ${name}` }).closest("li")!;

  it("shows the check interval beside Address and no group hint", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    await user.click(screen.getByRole("button", { name: "Add target" }));
    const dialog = await screen.findByRole("dialog", { name: "Add target" });
    expect(dialog.textContent).not.toContain("From your machine tags.");
    expect(dialog.textContent).not.toContain("Checked every 30 seconds");
    const address = within(dialog).getByLabelText("Address");
    const described = address.getAttribute("aria-describedby")!;
    const interval = described
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(interval).toContain("Checked every 60 seconds");
    expect(within(dialog).getByText("60s")).toBeTruthy();
    const group = within(dialog).getByLabelText("Group");
    expect(group.getAttribute("aria-describedby")).toBeNull();
    // Machines have no interval line.
    await user.click(within(dialog).getByRole("radio", { name: "Machine" }));
    expect(within(dialog).queryByText("60s")).toBeNull();
  });

  it("explains groups inside the Group select when there are no tags", async () => {
    // Radix Select reads pointer capture, which jsdom lacks.
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ ...live, tags: [] });
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    await user.click(screen.getByRole("button", { name: "Add target" }));
    const dialog = await screen.findByRole("dialog", { name: "Add target" });
    await user.click(within(dialog).getByLabelText("Group"));
    const option = await screen.findByRole("option", {
      name: "Add tags on Machines to make groups.",
    });
    expect(option.getAttribute("aria-disabled")).toBe("true");
  });

  it("drags a row that follows the pointer while the others move aside", async () => {
    vi.mocked(apiRequest).mockResolvedValue(grouped);
    mount();
    await ready();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Targets" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reorder EU main" }),
      ).toBeTruthy(),
    );
    layRows();
    const grip = screen.getByRole("button", { name: "Reorder EU main" });
    fireEvent.pointerDown(grip, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 32,
    });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 10, clientY: 102 });
    // The dragged row is under the pointer; Wings host has moved up.
    await waitFor(() =>
      expect(row("EU main").style.transform).toBe("translateY(64px)"),
    );
    expect(row("EU main").dataset.dragging).toBe("true");
    expect(row("Wings host").style.transform).toBe("translateY(-64px)");
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 10, clientY: 102 });
    await said("EU main moved to position 2 of 2.");
    expect(
      screen
        .getAllByRole("button", { name: /^Reorder / })
        .map((h) => h.getAttribute("aria-label")),
    ).toEqual(["Reorder Wings host", "Reorder EU main"]);
    expect(row("EU main").style.transform).toBe("");
  });

  it("cancels a drag with Escape and keeps the order", async () => {
    vi.mocked(apiRequest).mockResolvedValue(grouped);
    mount();
    await ready();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Targets" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reorder EU main" }),
      ).toBeTruthy(),
    );
    layRows();
    const grip = screen.getByRole("button", { name: "Reorder EU main" });
    fireEvent.pointerDown(grip, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 32,
    });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 10, clientY: 110 });
    await waitFor(() => expect(row("EU main").dataset.dragging).toBe("true"));
    fireEvent.keyDown(grip, { key: "Escape" });
    await waitFor(() =>
      expect(row("EU main").dataset.dragging).toBeUndefined(),
    );
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 10, clientY: 110 });
    expect(
      screen
        .getAllByRole("button", { name: /^Reorder / })
        .map((h) => h.getAttribute("aria-label")),
    ).toEqual(["Reorder EU main", "Reorder Wings host"]);
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(row("Wings host").style.transform).toBe("");
    await said("Move cancelled.");
  });
});

describe("Status page admin, fewer hints", () => {
  it("drops hints that repeat their control and keeps what screen readers need", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.queryByText("Leave empty to hide Contact support.")).toBe(
      null,
    );
    const formats = screen.getByText(
      "PNG, JPEG, WebP, GIF, or SVG, up to 20 MB",
    );
    expect(formats.className).toContain("sr-only");
    expect(
      screen
        .getByRole("button", { name: "Add logo" })
        .getAttribute("aria-describedby"),
    ).toContain(formats.id);
    // The side preview is titled and says nothing more.
    const side = screen.getByRole("region", { name: "Public preview" });
    expect(side.textContent).not.toContain("What visitors see");
    expect(side.textContent).not.toContain("hidden target");
  });
});

describe("Status page admin, round 12", () => {
  const pill = (name: RegExp) => screen.getByRole("button", { name });
  const grouped: StatusPageState = {
    ...live,
    components: [
      { ...live.components[0], tagId: "", groupName: "" },
      live.components[1],
    ],
  };
  /** Rows lay out 64 pixels tall, one after another, in jsdom. */
  function layRows() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const position = Number(this.dataset?.position ?? 0);
        const top = this.matches?.("li[data-position]") ? position * 64 : 0;
        return {
          top,
          bottom: top + 64,
          height: 64,
          left: 0,
          right: 600,
          width: 600,
          x: 0,
          y: top,
          toJSON() {},
        } as DOMRect;
      },
    );
  }
  const row = (name: string) =>
    screen.getByRole("button", { name: `Reorder ${name}` }).closest("li")!;
  async function targets() {
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Targets" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reorder EU main" }),
      ).toBeTruthy(),
    );
  }

  it("shows the saved address and Copy on a Private page, to managers", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ ...live, published: false });
    mount();
    await ready();
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const copy = vi.fn(() => true);
    document.execCommand = copy;
    await user.click(pill(/^Private/));
    const popover = await screen.findByRole("dialog");
    const address = popover.querySelector(".select-all")!;
    expect(address.textContent).toMatch(/\/status\/northstar-games$/);
    await user.click(
      within(popover).getByRole("button", { name: "Copy public address" }),
    );
    expect(copy).toHaveBeenCalledWith("copy");
    await said("Public address copied.");
    expect(
      within(popover).getByRole("button", { name: "Publish page" }),
    ).toBeTruthy();
  });

  it("shows the address and Copy on a Private page to viewers, without Publish", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ ...live, published: false });
    mount({ ...identity, permissions: ["infrastructure.view"] });
    await ready();
    await user.click(pill(/^Private/));
    const popover = await screen.findByRole("dialog");
    expect(popover.querySelector(".select-all")?.textContent).toMatch(
      /\/status\/northstar-games$/,
    );
    expect(
      within(popover).getByRole("button", { name: "Copy public address" }),
    ).toBeTruthy();
    expect(within(popover).queryByRole("button", { name: /publish/i })).toBe(
      null,
    );
  });

  it("slides the neighbour aside at half overlap, so it is never covered", async () => {
    vi.mocked(apiRequest).mockResolvedValue(grouped);
    mount();
    await ready();
    await targets();
    layRows();
    const grip = screen.getByRole("button", { name: "Reorder EU main" });
    fireEvent.pointerDown(grip, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 32,
    });
    // 20 pixels: under half of Wings host, so it stays. The held row leans
    // toward the pointer from its own gap (round 13).
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 10, clientY: 52 });
    await waitFor(() =>
      expect(row("EU main").style.transform).toBe("translateY(8px)"),
    );
    expect(row("Wings host").style.transform).toBe("translateY(0px)");
    // 40 pixels: past half, so Wings host has already moved up and the held
    // row sits in the new gap, leaning back toward the pointer.
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 10, clientY: 72 });
    await waitFor(() =>
      expect(row("EU main").style.transform).toBe("translateY(56px)"),
    );
    expect(row("Wings host").style.transform).toBe("translateY(-64px)");
    // And back under half on the way up, it returns.
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 10, clientY: 60 });
    await waitFor(() =>
      expect(row("Wings host").style.transform).toBe("translateY(0px)"),
    );
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 10, clientY: 72 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 10, clientY: 72 });
    await said("EU main moved to position 2 of 2.");
  });

  it("announces the first move of an editing session once", async () => {
    vi.mocked(apiRequest).mockResolvedValue(grouped);
    mount();
    await ready();
    await targets();
    const grip = screen.getByRole("button", { name: "Reorder EU main" });
    act(() => grip.focus());
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    await said("EU main moved to position 2 of 2.");
    await screen.findByRole("region", { name: "Unsaved changes" });
    const spoken = [
      ...document.querySelectorAll('[aria-live], [role="status"]'),
    ]
      .map((element) => element.textContent?.trim() ?? "")
      .filter(Boolean);
    expect(spoken).toEqual(["EU main moved to position 2 of 2."]);
  });

  it("folds the Public pill to its filled globe, with no chevron at rest", async () => {
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    const trigger = pill(/^Public/);
    const chevron = trigger.querySelector("svg.lucide-chevron-down")!;
    // The chevron folds with the word and returns when it expands.
    const folding = chevron.closest("[data-fold]")!;
    expect(trigger.contains(folding)).toBe(true);
    expect(folding.textContent).toBe("Public");
    for (const variant of [
      "[@media(hover:hover)_and_(pointer:fine)]:max-w-0",
      "group-hover/pill:max-w-20",
      "group-focus-visible/pill:max-w-20",
      "group-data-[state=open]/pill:max-w-20",
    ])
      expect(folding.className).toContain(variant);
    // The globe sits on the sage tint, so the glyph alone reads as Public.
    expect(trigger.className).toMatch(/(^| )bg-primary\/\d+/);
  });

  it("names the popover without repeating the pill's word", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    await user.click(pill(/^Public/));
    let popover = await screen.findByRole("dialog", { name: "Public page" });
    expect(popover.textContent).not.toMatch(/Public/);
    await user.keyboard("{Escape}");
    cleanup();
    vi.mocked(apiRequest).mockResolvedValue({ ...live, published: false });
    mount();
    await ready();
    await user.click(pill(/^Private/));
    popover = await screen.findByRole("dialog", { name: "Private page" });
    expect(popover.textContent).not.toMatch(/Private/);
    expect(popover.textContent).toContain("see a not-found page");
  });

  it("names a window in progress under a healthy headline", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ...live,
      components: live.components.map((c) => ({
        ...c,
        health: "operational" as const,
      })),
    });
    mount();
    await ready();
    const status = screen.getByRole("region", {
      name: "All 2 targets operational",
    });
    expect(status.textContent).toContain(
      `Maintenance until ${atText(live.maintenance[0].endsAt, Date.now())}.`,
    );
    cleanup();
    vi.mocked(apiRequest).mockResolvedValue({ ...live, maintenance: [] });
    mount();
    await ready();
    expect(screen.queryByText(/Maintenance until/)).toBeNull();
  });

  it("puts the check interval right after the Address label", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    await user.click(screen.getByRole("button", { name: "Add target" }));
    const dialog = await screen.findByRole("dialog", { name: "Add target" });
    const label = within(dialog).getByText("Address", { selector: "label" });
    expect(label.nextElementSibling?.textContent).toContain("60s");
    expect(label.parentElement?.className).not.toContain("justify-between");
  });
});

describe("Status page admin, round 13", () => {
  const grouped: StatusPageState = {
    ...live,
    components: [
      { ...live.components[0], tagId: "", groupName: "" },
      live.components[1],
    ],
  };
  /** Rows lay out 64 pixels tall, one after another, in jsdom. */
  function layRows() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const position = Number(this.dataset?.position ?? 0);
        const top = this.matches?.("li[data-position]") ? position * 64 : 0;
        return {
          top,
          bottom: top + 64,
          height: 64,
          left: 0,
          right: 600,
          width: 600,
          x: 0,
          y: top,
          toJSON() {},
        } as DOMRect;
      },
    );
  }
  const row = (name: string) =>
    screen.getByRole("button", { name: `Reorder ${name}` }).closest("li")!;
  const offset = (element: HTMLElement) =>
    Number(/translateY\((-?[\d.]+)px\)/.exec(element.style.transform)?.[1]);
  async function targets() {
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Targets" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reorder EU main" }),
      ).toBeTruthy(),
    );
  }

  /** Sweeps one row a full row's travel and checks every pixel. */
  async function sweep(held: string, other: string, direction: 1 | -1) {
    const grip = screen.getByRole("button", { name: `Reorder ${held}` });
    // Away from the screen edges, where a held row scrolls the page.
    const start = direction === 1 ? 132 : 196;
    fireEvent.pointerDown(grip, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: start,
    });
    const heldTop = direction === 1 ? 0 : 64;
    const otherTop = direction === 1 ? 64 : 0;
    for (let travel = 6; travel <= 64; travel++) {
      fireEvent.pointerMove(grip, {
        pointerId: 1,
        clientX: 10,
        clientY: start + direction * travel,
      });
      const a = heldTop + offset(row(held));
      const b = otherTop + offset(row(other));
      // Rows keep 8 pixels of padding, so 8 pixels of lean never reaches
      // the passed row's name, status or address.
      const covered = Math.max(0, Math.min(a, b) + 64 - Math.max(a, b));
      expect(covered, `${travel}px`).toBeLessThanOrEqual(8);
      // It still follows: it leans toward the pointer before the swap.
      if (travel === 8) expect(offset(row(held))).toBe(direction * 8);
    }
    return grip;
  }

  it("keeps the held row in its gap, leaning toward the pointer, going down", async () => {
    vi.mocked(apiRequest).mockResolvedValue(grouped);
    mount();
    await ready();
    await targets();
    layRows();
    const grip = await sweep("EU main", "Wings host", 1);
    expect(offset(row("EU main"))).toBe(64);
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 10, clientY: 196 });
    await said("EU main moved to position 2 of 2.");
  });

  it("keeps the held row in its gap, leaning toward the pointer, going up", async () => {
    vi.mocked(apiRequest).mockResolvedValue(grouped);
    mount();
    await ready();
    await targets();
    layRows();
    const grip = await sweep("Wings host", "EU main", -1);
    expect(offset(row("Wings host"))).toBe(-64);
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 10, clientY: 132 });
    await said("Wings host moved to position 1 of 2.");
  });

  it("slides the passed row over the held one while both move to their slots", async () => {
    vi.mocked(apiRequest).mockResolvedValue(grouped);
    mount();
    await ready();
    await targets();
    layRows();
    const grip = screen.getByRole("button", { name: "Reorder EU main" });
    fireEvent.pointerDown(grip, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 32,
    });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 10, clientY: 50 });
    // Before the swap nothing is in flight, and the held row is on top.
    expect(row("Wings host").dataset.settling).toBeUndefined();
    expect(row("EU main").className).toContain("z-10");
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 10, clientY: 66 });
    // At the swap the passed row is raised for its slide, so the two rows
    // never hide its text while they cross. Both slide in 120 ms.
    const passed = row("Wings host");
    expect(passed.dataset.settling).toBe("true");
    expect(passed.className).toContain("z-20");
    for (const element of [passed, row("EU main")])
      expect(element.className).toContain("duration-120");
    // It stays raised until its own slide ends, however late that starts.
    fireEvent.transitionEnd(row("EU main"), { propertyName: "transform" });
    expect(row("Wings host").dataset.settling).toBe("true");
    fireEvent.transitionEnd(row("Wings host"), { propertyName: "transform" });
    await waitFor(() =>
      expect(row("Wings host").dataset.settling).toBeUndefined(),
    );
    fireEvent.keyDown(grip, { key: "Escape" });
    await said("Move cancelled.");
  });
  it("stacks the empty Maintenance state like Machines: icon, message, button", async () => {
    vi.mocked(apiRequest).mockResolvedValue({ ...live, maintenance: [] });
    mount();
    await ready();
    const card = screen.getByRole("region", { name: /^Maintenance/ });
    const message = within(card).getByText("No maintenance scheduled");
    const empty = message.closest('[data-slot="empty"]')!;
    const icon = empty.querySelector('[data-slot="empty-icon"]')!;
    const button = within(card).getByRole("button", {
      name: "Schedule maintenance",
    });
    // One column, in reading order, with nothing beside the message.
    expect(empty.className).toContain("flex-col");
    expect([...empty.children]).toEqual([icon, message, button]);
  });

  it("keeps the maintenance line under a healthy headline short", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      ...live,
      components: live.components.map((c) => ({
        ...c,
        health: "operational" as const,
      })),
    });
    mount();
    await ready();
    const status = screen.getByRole("region", {
      name: "All 2 targets operational",
    });
    expect(status.textContent).toContain(
      `Maintenance until ${atText(live.maintenance[0].endsAt, Date.now())}.`,
    );
    expect(status.textContent).not.toContain("in progress");
  });
  it("keeps the grip tooltip inside the main landmark", async () => {
    vi.mocked(apiRequest).mockResolvedValue(grouped);
    const main = document.createElement("main");
    main.id = "main-content";
    document.body.append(main);
    render(
      <UnsavedChangesProvider>
        <TooltipProvider>
          <StatusPageAdmin identity={identity} />
        </TooltipProvider>
      </UnsavedChangesProvider>,
      { container: main },
    );
    await ready();
    await targets();
    const grip = screen.getByRole("button", { name: "Reorder EU main" });
    act(() => grip.focus());
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toBe("Drag to reorder");
    expect(tip.closest("main")).toBe(main);
    cleanup();
    main.remove();
  });
});
