// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Checkbox } from "./checkbox";

afterEach(cleanup);

function icons(box: HTMLElement) {
  const shown = [...box.querySelectorAll<SVGElement>("svg[data-icon]")].filter(
    (icon) => !icon.classList.contains("hidden"),
  );
  return { all: box.querySelectorAll("svg[data-icon]"), shown };
}

describe("Checkbox", () => {
  it("draws a dash, not a check, for a partly selected group", () => {
    render(<Checkbox aria-label="No group" checked="indeterminate" />);
    const box = screen.getByRole("checkbox", { name: "No group" });
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    expect(box.getAttribute("data-state")).toBe("indeterminate");
    const check = box.querySelector('svg[data-icon="checked"]')!;
    const dash = box.querySelector('svg[data-icon="indeterminate"]')!;
    expect(dash.getAttribute("class")).toContain(
      "group-data-[state=indeterminate]/checkbox:block",
    );
    expect(check.getAttribute("class")).toContain(
      "group-data-[state=indeterminate]/checkbox:hidden",
    );
    // The mixed box is filled like a checked one, so the dash reads on it.
    expect(box.className).toContain("data-[state=indeterminate]:bg-primary");
  });

  it("draws a check when fully selected and nothing when empty", () => {
    const { rerender } = render(
      <Checkbox aria-label="Website" checked={true} />,
    );
    const box = screen.getByRole("checkbox", { name: "Website" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(box.getAttribute("data-state")).toBe("checked");
    expect(icons(box).shown.map((icon) => icon.dataset.icon)).toEqual([
      "checked",
    ]);
    rerender(<Checkbox aria-label="Website" checked={false} />);
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(icons(box).all).toHaveLength(0);
  });
});
