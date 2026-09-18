// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "./sonner";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

vi.mock("sonner", () => ({
  Toaster: ({
    duration,
    position,
  }: {
    duration?: number;
    position?: string;
  }) => (
    <div
      data-testid="toaster"
      data-duration={duration}
      data-position={position}
    />
  ),
}));

afterEach(cleanup);

describe("Toaster", () => {
  it("shows auto-dismissing notifications in the top right", () => {
    render(<Toaster />);

    const toaster = screen.getByTestId("toaster");
    expect(toaster.getAttribute("data-position")).toBe("top-right");
    expect(toaster.getAttribute("data-duration")).toBe("4000");
  });
});
