// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";

afterEach(cleanup);

function Length({ value }: { value: string }) {
  return (
    <ToggleGroup
      type="single"
      variant="segmented"
      value={value}
      aria-label="Length"
    >
      {["30 min", "1 hour", "Custom"].map((label) => (
        <ToggleGroupItem key={label} value={label}>
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

const classes = (element: HTMLElement) => element.className.split(/\s+/);

describe("segmented ToggleGroup", () => {
  it("draws a track and edges the chosen cell, not only colors it", () => {
    render(<Length value="1 hour" />);
    const group = screen.getByRole("radiogroup", { name: "Length" });
    expect(classes(group)).toEqual(
      expect.arrayContaining(["border", "border-border", "p-1", "w-full"]),
    );
    const chosen = screen.getByRole("radio", { name: "1 hour" });
    expect(chosen.getAttribute("aria-checked")).toBe("true");
    expect(chosen.getAttribute("data-state")).toBe("on");
    // A 1px edge in input-hover (4.3:1 or more against the track) and bold text.
    expect(classes(chosen)).toEqual(
      expect.arrayContaining([
        "data-[state=on]:inset-ring",
        "data-[state=on]:inset-ring-input-hover",
        "data-[state=on]:font-semibold",
        "data-[state=on]:bg-border",
      ]),
    );
    // The default toggle fill does not fight the segmented one.
    expect(classes(chosen)).not.toContain("data-[state=on]:bg-muted");
    // Cells keep their own rounding instead of the joined-button corners.
    expect(chosen.className).not.toContain("rounded-none");
    // 44px on touch screens.
    expect(classes(chosen)).toContain("[@media(any-pointer:coarse)]:min-h-11");
    expect(classes(chosen)).toContain("min-w-0");
    expect(classes(chosen)).not.toContain("min-w-8");
  });

  it("draws the chosen cell in system Highlight colors in forced colors", () => {
    render(<Length value="1 hour" />);
    const chosen = screen.getByRole("radio", { name: "1 hour" });
    // Contrast themes drop the fill and the inset edge, so the chosen cell
    // takes the system's own selection colors and keeps them.
    expect(classes(chosen)).toEqual(
      expect.arrayContaining([
        "forced-colors:data-[state=on]:bg-[Highlight]",
        "forced-colors:data-[state=on]:text-[HighlightText]",
        "forced-colors:data-[state=on]:forced-color-adjust-none",
      ]),
    );
    // Only the chosen cell opts out; the others keep the system colors.
    expect(classes(chosen)).not.toContain("forced-color-adjust-none");
  });

  it("keeps one tab stop on the chosen cell and moves with arrows", async () => {
    const user = userEvent.setup();
    render(<Length value="30 min" />);
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "30 min" }),
    );
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: "1 hour" }),
    );
  });
});
