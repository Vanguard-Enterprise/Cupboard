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
import { describe, expect, it, vi } from "vitest";
import { StatusPageAdmin } from "./status-page";
import { apiRequest } from "@/lib/api-client";
import type { StatusPageState } from "@/lib/status-page";
import { toast } from "sonner";

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
  live,
  mount,
  ready,
  said,
  old,
} from "@/test/status-page-admin";

registerStatusPageHooks();

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

    await user.click(screen.getByRole("button", { name: "Post announcement" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Announcement"), "Wipe.");
    vi.mocked(apiRequest).mockRejectedValueOnce(unavailable);
    await user.click(within(dialog).getByRole("button", { name: "Post" }));
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
    const save = screen.getByRole("button", { name: "Save" });
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
    await screen.findByRole("dialog", { name: "Create Scheduled Maintenance" });
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
    await screen.findByRole("dialog", { name: "Create Scheduled Maintenance" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(action));
  });

  it("previews only on Settings, on phones and private pages too", async () => {
    phone();
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValue({ ...live, published: false });
    mount();
    await ready();
    // Preview sits with the branding edits: not on Overview or Targets.
    expect(screen.queryByRole("button", { name: /Preview/ })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Targets" }));
    expect(screen.queryByRole("button", { name: /Preview/ })).toBeNull();
    for (const tab of ["Settings"]) {
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
    const wings = within(status).getByText("Wings host").closest("li")!;
    expect(wings.textContent).toContain("Hidden");
    expect(wings.textContent).toContain("Unavailable");
    // Like the public page: every row in view, nothing to expand, and no
    // summary line or Manage targets under the headline.
    expect(within(status).getByText("EU main")).toBeTruthy();
    expect(within(status).queryAllByRole("button")).toHaveLength(0);
    expect(status.textContent).not.toMatch(/2 targets|Updated/);
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
    const eu = within(status).getByText("EU main").closest("li")!;
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
      screen.getByRole("region", { name: "Systems Operational" }),
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

  it("marks a target in a running window under a healthy headline", async () => {
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
      name: "Systems Operational",
    });
    // The window itself leads the page in the Maintenance card.
    const eu = within(status).getByText("EU main").closest("li")!;
    expect(eu.textContent).toContain("Maintenance");
    expect(
      within(screen.getByRole("region", { name: /^Maintenance/ })).getByText(
        "In progress",
      ),
    ).toBeTruthy();
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

  it("leads the Overview with Maintenance and the Announcement", async () => {
    vi.mocked(apiRequest).mockResolvedValue(live);
    mount();
    await ready();
    const order = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-labelledby"))
      .filter((id) =>
        [
          "maintenance-heading",
          "announcement-heading",
          "health-heading",
        ].includes(id ?? ""),
      );
    expect(order).toEqual([
      "maintenance-heading",
      "announcement-heading",
      "health-heading",
    ]);
    // A long schedule scrolls inside its card.
    const maintenance = screen.getByRole("region", { name: /^Maintenance/ });
    expect(
      within(maintenance).getByRole("group", { name: "Maintenance windows" })
        .className,
    ).toContain("overflow-y-auto");
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
