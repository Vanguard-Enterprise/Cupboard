// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { RadioGroup, RadioGroupItem } from "./radio-group";

afterEach(cleanup);

const classes = (element: Element) => element.className.split(/\s+/);

it("keeps the checked dot and ring visible in forced colors", () => {
  render(
    <RadioGroup aria-label="Targets" defaultValue="all">
      <RadioGroupItem value="all" aria-label="All targets" />
      <RadioGroupItem value="some" aria-label="Specific targets" />
    </RadioGroup>,
  );
  const checked = screen.getByRole("radio", { name: "All targets" });
  expect(checked.getAttribute("aria-checked")).toBe("true");
  expect(classes(checked)).toContain(
    "forced-colors:data-checked:border-[Highlight]",
  );
  // Contrast themes force backgrounds to the canvas, which hid the dot.
  const dot = checked.querySelector("[data-slot=radio-group-indicator] span")!;
  expect(classes(dot)).toEqual(
    expect.arrayContaining([
      "forced-color-adjust-none",
      "forced-colors:bg-[Highlight]",
    ]),
  );
  const unchecked = screen.getByRole("radio", { name: "Specific targets" });
  expect(
    unchecked.querySelector("[data-slot=radio-group-indicator]"),
  ).toBeNull();
});
