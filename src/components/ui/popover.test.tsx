// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

afterEach(cleanup);

describe("Popover", () => {
  // a11y D-R7-01 (axe aria-dialog-name): the accent "Contrast ratios"
  // popover was a dialog with no name.
  it("takes its trigger's name unless it is given one", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Popover>
          <PopoverTrigger aria-label="Contrast ratios">Ratios</PopoverTrigger>
          <PopoverContent>Dark pages 8.1:1</PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" id="source-field">
              Source
            </button>
          </PopoverTrigger>
          <PopoverContent>Sources</PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger>Filter</PopoverTrigger>
          <PopoverContent aria-label="Filter events">Fields</PopoverContent>
        </Popover>
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Contrast ratios" }));
    expect(
      await screen.findByRole("dialog", { name: "Contrast ratios" }),
    ).toBeTruthy();
    await user.keyboard("{Escape}");

    // A trigger with its own id (a field's combobox) keeps it.
    await user.click(screen.getByRole("button", { name: "Source" }));
    expect(await screen.findByRole("dialog", { name: "Source" })).toBeTruthy();
    expect(document.getElementById("source-field")).toBeTruthy();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Filter" }));
    expect(
      await screen.findByRole("dialog", { name: "Filter events" }),
    ).toBeTruthy();
  });
});
