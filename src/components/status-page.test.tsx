// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/api-client";

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

import {
  registerStatusPageHooks,
  identity,
  empty,
  live,
  mount,
  ready,
  savedToast,
} from "@/test/status-page-admin";

registerStatusPageHooks();

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
    // EU main is healthy inside a window: it says so in words.
    const eu = within(status).getByText("EU main").closest("li")!;
    expect(eu.textContent).toContain("Maintenance");
    expect(eu.textContent).toContain("Operational");
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

  it("reads Maintenance, the Announcement, then setup at every width (claude D-60)", async () => {
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
    ).toEqual(["maintenance-heading", "announcement-heading", "setup-heading"]);
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
    await user.click(screen.getByRole("button", { name: "Save" }));
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
    await savedToast();
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
    await user.click(screen.getByRole("button", { name: "Save" }));
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
});
