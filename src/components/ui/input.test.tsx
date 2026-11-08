// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Command, CommandInput } from "./command";
import { Input, InputFrame, InputFrameControl } from "./input";

afterEach(cleanup);

const classes = (element: Element) => element.className.split(/\s+/);

describe("InputFrame", () => {
  it("is 44px on touch and its input covers the whole frame", () => {
    render(
      <InputFrame data-testid="frame">
        <span>/status/</span>
        <InputFrameControl aria-label="Public address" />
      </InputFrame>,
    );
    expect(classes(screen.getByTestId("frame"))).toEqual(
      expect.arrayContaining(["h-10", "[@media(any-pointer:coarse)]:h-11"]),
    );
    // The input reaches over the 1px edges, so its own box is the full
    // 44px instead of 42px.
    expect(
      classes(screen.getByRole("textbox", { name: "Public address" })),
    ).toEqual(expect.arrayContaining(["-my-px", "h-[calc(100%+2px)]"]));
  });

  it("puts the caret in its input when the prefix is pressed", async () => {
    const user = userEvent.setup();
    render(
      <InputFrame>
        <span>/status/</span>
        <InputFrameControl aria-label="Public address" />
        <button type="button">Copy</button>
      </InputFrame>,
    );
    await user.click(screen.getByText("/status/"));
    const input = screen.getByRole("textbox", { name: "Public address" });
    expect(document.activeElement).toBe(input);
    // A control inside the frame keeps its own press.
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Copy" }),
    );
  });
});

// a11y D-72: text under 16px makes iOS Safari zoom the page on focus.
describe("text size on phones", () => {
  it("is 16px below 768 and 14px from there, for every text input", () => {
    render(
      <>
        <Input aria-label="Plain" />
        <InputFrame>
          <InputFrameControl aria-label="Framed" />
        </InputFrame>
        <Command>
          <CommandInput aria-label="Search" />
        </Command>
      </>,
    );
    for (const name of ["Plain", "Framed", "Search"]) {
      const list = classes(screen.getByLabelText(name));
      expect(list, name).toEqual(
        expect.arrayContaining(["text-base", "md:text-sm"]),
      );
      expect(list, name).not.toContain("text-sm");
    }
  });
});
