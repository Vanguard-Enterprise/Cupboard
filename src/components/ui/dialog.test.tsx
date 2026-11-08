// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { DatePicker } from "./date-picker";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Form({ scrollable = true }: { scrollable?: boolean }) {
  const [date, setDate] = useState<Date | null>(new Date(2026, 10, 5));
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Schedule maintenance</Button>
      </DialogTrigger>
      <DialogContent scrollable={scrollable}>
        <DialogHeader>
          <DialogTitle>Schedule maintenance</DialogTitle>
          <DialogDescription>
            Players see it as soon as you save.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <label htmlFor="start-date">Start date</label>
          <DatePicker id="start-date" value={date} onChange={setDate} />
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button>Schedule</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe("scrollable Dialog", () => {
  it("pins header and footer, and scrolls as one in short windows", async () => {
    const user = userEvent.setup();
    render(<Form />);
    await user.click(
      screen.getByRole("button", { name: "Schedule maintenance" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Schedule maintenance",
    });
    const body = dialog.querySelector("[data-slot=dialog-body]")!;
    const footer = dialog.querySelector("[data-slot=dialog-footer]")!;
    expect(dialog.dataset.scrollable).toBe("true");
    // Normal heights: the body is the only scroller and the footer stays put.
    expect(dialog.className).toMatch(/\bflex-col\b/);
    expect(body.className).toMatch(/\boverflow-y-auto\b/);
    expect(body.className).toMatch(/\bmin-h-0\b/);
    expect(footer.className).toMatch(/\bshrink-0\b/);
    // Under 480px tall the dialog itself scrolls and the body stops clipping,
    // so the form never shrinks to a sliver between header and footer.
    expect(dialog.className).toMatch(/\bshort:overflow-y-auto\b/);
    expect(body.className).toMatch(/\bshort:overflow-visible\b/);
    expect(body.className).toMatch(/\bshort:flex-none\b/);
  });

  it("defines the short variant at 480px of height", () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), "src/app/globals.css"),
      "utf8",
    );
    expect(css).toContain(
      "@custom-variant short (@media (max-height: 480px));",
    );
  });

  it("leaves plain dialogs alone", async () => {
    const user = userEvent.setup();
    render(<Form scrollable={false} />);
    await user.click(
      screen.getByRole("button", { name: "Schedule maintenance" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.dataset.scrollable).toBeUndefined();
    expect(dialog.className).not.toMatch(/short:/);
  });

  it("returns focus to its opener on Cancel and on Escape", async () => {
    const user = userEvent.setup();
    render(<Form />);
    const opener = screen.getByRole("button", { name: "Schedule maintenance" });
    await user.click(opener);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    await user.click(opener);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("stacks a phone date sheet over the form without closing the form", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    const user = userEvent.setup();
    render(<Form />);
    await user.click(
      screen.getByRole("button", { name: "Schedule maintenance" }),
    );
    const form = await screen.findByRole("dialog", {
      name: "Schedule maintenance",
    });
    const field = within(form).getByLabelText("Start date");
    await user.click(field);
    const sheet = await screen.findByRole("dialog", { name: "Start date" });
    expect(sheet.dataset.slot).toBe("date-picker-sheet");
    // Escape closes the date sheet only; the form and its footer remain.
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Start date" })).toBeNull(),
    );
    expect(
      screen.getByRole("dialog", { name: "Schedule maintenance" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(field);
    // Picking a day also lands back on the field inside the form.
    await user.click(field);
    const again = await screen.findByRole("dialog", { name: "Start date" });
    await user.click(
      again.querySelector<HTMLButtonElement>(
        'td[data-day="2026-11-20"] button',
      )!,
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Start date" })).toBeNull(),
    );
    expect(field.textContent).toContain("Fri, Nov 20, 2026");
    expect(field.getAttribute("aria-label")).toBe(
      "Start date, Friday, November 20, 2026",
    );
    expect(document.activeElement).toBe(field);
  });
});
