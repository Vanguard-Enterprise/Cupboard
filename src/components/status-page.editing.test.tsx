// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
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
  empty,
  live,
  mount,
  ready,
  said,
  old,
  hiddenOnly,
} from "@/test/status-page-admin";

registerStatusPageHooks();

describe("Status page admin", () => {
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
});
