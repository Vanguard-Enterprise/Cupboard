// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Switch } from "./switch";

afterEach(cleanup);

const classes = (element: Element) => element.className.split(/\s+/);

it("keeps the thumb and its state visible in forced colors", () => {
  render(<Switch aria-label="Show on page" defaultChecked />);
  const toggle = screen.getByRole("switch", { name: "Show on page" });
  expect(classes(toggle)).toEqual(
    expect.arrayContaining([
      "forced-colors:border-[CanvasText]",
      "forced-colors:data-checked:border-[Highlight]",
    ]),
  );
  const thumb = toggle.querySelector("[data-slot=switch-thumb]")!;
  expect(classes(thumb)).toEqual(
    expect.arrayContaining([
      "forced-color-adjust-none",
      "forced-colors:bg-[CanvasText]!",
      "forced-colors:data-checked:bg-[Highlight]!",
    ]),
  );
});
