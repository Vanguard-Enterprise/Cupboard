// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import SecurityAlertsPage from "./page";

afterEach(cleanup);

describe("Security alerts page", () => {
  it("renders without a sample data tag", () => {
    render(<SecurityAlertsPage />);

    expect(
      screen.getByRole("heading", { name: "Security alerts" }),
    ).toBeTruthy();
    expect(screen.queryByText(/sample data/i)).toBeNull();
  });
});
