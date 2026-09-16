// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import SecurityAlertsPage from "./page";

afterEach(cleanup);

describe("Security alerts page", () => {
  it("opens and dismisses the sample data explanation", async () => {
    const user = userEvent.setup();
    render(<SecurityAlertsPage />);

    await user.click(
      screen.getByRole("button", { name: "About sample security alerts" }),
    );
    expect(
      screen.getByText(
        "Findings are examples. Acknowledgements stay in this browser.",
      ),
    ).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(
      screen.queryByText(
        "Findings are examples. Acknowledgements stay in this browser.",
      ),
    ).toBeNull();
  });
});
