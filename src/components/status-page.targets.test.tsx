// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/lib/api-client";
import { type StatusPageState } from "@/lib/status-page";
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

describe("Status page admin", () => {
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
});
