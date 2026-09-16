// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { OrganizationUsage } from "./organization-usage";

describe("Organization usage", () => {
  it("shows accessible sample activity and capacity charts", async () => {
    const user = userEvent.setup();
    render(<OrganizationUsage />);

    expect(screen.getByText("Sample data")).toBeTruthy();
    expect(screen.getByText("Managed servers")).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: /daily server checks and AI actions for the last 14 days/i,
      }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: "14 days" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(screen.getByRole("radio", { name: "7 days" }));
    expect(
      screen.getByRole("img", {
        name: /daily server checks and AI actions for the last 7 days/i,
      }),
    ).toBeTruthy();
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
    expect(
      screen
        .getByRole("progressbar", { name: "Members capacity" })
        .getAttribute("aria-valuetext"),
    ).toBe("80% used");
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "P" && element.textContent === "8 of 10 · 80%",
      ),
    ).toBeTruthy();
  });
});
