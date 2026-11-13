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
  live,
  mount,
  ready,
} from "@/test/status-page-admin";

registerStatusPageHooks();

describe("Status page admin", () => {
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
        within(dialog).getByRole("button", { name: "Schedule" }),
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
        within(dialog).getByRole("button", { name: "Schedule" }),
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
        name: "Schedule",
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

  it("drops a removed target from a window being edited, keeping its scope (codex)", async () => {
    const user = userEvent.setup();
    // The window affected EU main and a target removed since.
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      maintenance: [
        { ...live.maintenance[0], componentIds: ["c-eu", "c-removed"] },
      ],
    });
    mount();
    await ready();
    await user.click(
      screen.getByRole("button", { name: "Actions for Monthly wipe" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog)
        .getByRole("radio", { name: "Specific targets" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(dialog.textContent).toContain("1 of 2 selected");
    await user.type(within(dialog).getByLabelText("Title"), " and restart");
    vi.mocked(apiRequest).mockResolvedValueOnce(live);
    await user.click(
      within(dialog).getByRole("button", { name: "Save window" }),
    );
    await waitFor(() =>
      expect(apiRequest).toHaveBeenLastCalledWith(
        "status-page/maintenance/w-1",
        expect.objectContaining({
          title: "Monthly wipe and restart",
          componentIds: ["c-eu"],
        }),
        "org-one",
      ),
    );
  });

  it("asks for a target when every target a window affected was removed (codex)", async () => {
    const user = userEvent.setup();
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...live,
      maintenance: [{ ...live.maintenance[0], componentIds: ["c-removed"] }],
    });
    mount();
    await ready();
    await user.click(
      screen.getByRole("button", { name: "Actions for Monthly wipe" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    // Never widened to every target on its own.
    expect(
      within(dialog)
        .getByRole("radio", { name: "Specific targets" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(dialog.textContent).toContain("0 of 2 selected");
    const calls = vi.mocked(apiRequest).mock.calls.length;
    await user.click(
      within(dialog).getByRole("button", { name: "Save window" }),
    );
    expect(dialog.textContent).toContain(
      "Choose at least one affected target.",
    );
    expect(apiRequest).toHaveBeenCalledTimes(calls);
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
