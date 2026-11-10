// @vitest-environment jsdom
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mergeNotice, rebaseDraft } from "./status-page";
import { apiRequest } from "@/lib/api-client";
import { draftOf, type StatusPageState } from "@/lib/status-page";
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
  empty,
  live,
  mount,
  ready,
  savedInBar,
  said,
  stubImages,
  conflictError,
} from "@/test/status-page-admin";

registerStatusPageHooks();

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

  it("drops a refresh sent before a save that landed first (codex)", async () => {
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
      // A poll reads revision 2, and its answer is slow.
      let answerPoll: (value: StatusPageState) => void = () => {};
      vi.mocked(apiRequest).mockImplementationOnce(
        () => new Promise((resolve) => (answerPoll = resolve)),
      );
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      const saved = { ...live, revision: 3, name: "Northstar Status" };
      vi.mocked(apiRequest).mockResolvedValueOnce(saved);
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await savedInBar();
      await act(async () => answerPoll(live));
      expect(screen.getByLabelText("Page name")).toHaveProperty(
        "value",
        "Northstar Status",
      );
      await user.type(screen.getByLabelText("Footer text"), "Hi");
      vi.mocked(apiRequest).mockResolvedValueOnce({ ...saved, revision: 4 });
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() =>
        expect(apiRequest).toHaveBeenLastCalledWith(
          "status-page",
          expect.objectContaining({
            revision: 3,
            name: "Northstar Status",
            footerText: "Hi",
          }),
          "org-one",
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a refresh sent before a maintenance action landed (codex)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const user = userEvent.setup();
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      mount();
      await ready();
      // A poll reads the window while it is open, and its answer is slow.
      let answerPoll: (value: StatusPageState) => void = () => {};
      vi.mocked(apiRequest).mockImplementationOnce(
        () => new Promise((resolve) => (answerPoll = resolve)),
      );
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      await user.click(screen.getByRole("button", { name: "Mark complete" }));
      const confirm = await screen.findByRole("alertdialog");
      // Completing a window keeps the page revision: only the order of the
      // responses says which is newer.
      vi.mocked(apiRequest).mockResolvedValueOnce({
        ...live,
        maintenance: [{ ...live.maintenance[0], completedAt: Date.now() }],
      });
      await user.click(
        within(confirm).getByRole("button", { name: "Mark complete" }),
      );
      await said("Maintenance marked complete.");
      expect(
        screen.queryByRole("button", { name: "Mark complete" }),
      ).toBeNull();
      await act(async () => answerPoll(live));
      expect(
        screen.queryByRole("button", { name: "Mark complete" }),
      ).toBeNull();
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

  it("applies an open target edit to the same target after a poll reorders or removes it (codex)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const user = userEvent.setup();
      vi.mocked(apiRequest).mockResolvedValueOnce(live);
      mount();
      await ready();
      await user.click(screen.getByRole("tab", { name: "Targets" }));
      await user.click(
        screen.getByRole("button", { name: "Actions for Wings host" }),
      );
      await user.click(screen.getByRole("menuitem", { name: "Edit" }));
      let dialog = screen.getByRole("dialog");
      await user.clear(within(dialog).getByLabelText("Display name"));
      await user.type(
        within(dialog).getByLabelText("Display name"),
        "Wings node",
      );
      // Another session moved the host first while the editor was open.
      const reordered = {
        ...live,
        revision: 3,
        components: [live.components[1], live.components[0]],
      };
      await poll(reordered);
      await user.click(
        within(dialog).getByRole("button", { name: "Update target" }),
      );
      vi.mocked(apiRequest).mockResolvedValueOnce({
        ...reordered,
        revision: 4,
      });
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() =>
        expect(apiRequest).toHaveBeenLastCalledWith(
          "status-page",
          expect.objectContaining({
            revision: 3,
            components: [
              expect.objectContaining({
                sourceId: "machine-1",
                name: "Wings node",
                public: false,
              }),
              expect.objectContaining({
                sourceId: "server-eu",
                name: "EU main",
                tagId: "game-server",
                public: true,
              }),
            ],
          }),
          "org-one",
        ),
      );

      // Another session removed the target being edited.
      await user.click(
        await screen.findByRole("button", { name: "Actions for EU main" }),
      );
      await user.click(screen.getByRole("menuitem", { name: "Edit" }));
      dialog = screen.getByRole("dialog");
      await user.type(within(dialog).getByLabelText("Display name"), " 2");
      await poll({
        ...reordered,
        revision: 5,
        components: [{ ...live.components[1], name: "Wings node" }],
      });
      await user.click(
        within(dialog).getByRole("button", { name: "Update target" }),
      );
      expect(within(dialog).getByRole("alert").textContent).toContain(
        "removed in another session",
      );
      expect(screen.queryByText("Unsaved changes")).toBeNull();
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

  it("matches a URL target to its saved, normalized address when rebasing", () => {
    const base = { ...draftOf(live), components: [] };
    const typed = {
      id: null,
      name: "Forum",
      kind: "url" as const,
      sourceId: "https://example.com",
      tagId: "",
      public: true,
    };
    const sent = { ...base, components: [typed] };
    // Renamed and grouped while Save was pending.
    const mine = {
      ...base,
      components: [{ ...typed, name: "Community forum", tagId: "wings" }],
    };
    // The server saves the address the way it parses it.
    const saved = {
      ...base,
      components: [
        { ...typed, id: "c-forum", sourceId: "https://example.com/" },
      ],
    };
    const { draft, targets } = rebaseDraft(sent, mine, saved);
    expect(draft.components).toEqual([
      {
        id: "c-forum",
        name: "Community forum",
        kind: "url",
        sourceId: "https://example.com/",
        tagId: "wings",
        public: true,
      },
    ]);
    expect(targets).toEqual([]);
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
