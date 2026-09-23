// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountForm } from "./account-form";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("account forms", () => {
  it("submits credentials to the API and reports rejected login", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: "Email or password is incorrect." },
        { status: 401 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<AccountForm />);
    await user.type(screen.getByLabelText("Email"), "operator@example.com");
    await user.type(screen.getByLabelText("Password"), "invalid-password");
    await user.click(screen.getByRole("button", { name: "Login" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Email or password is incorrect",
      ),
    );
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/app-api/auth/login");
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual(
      { email: "operator@example.com", password: "invalid-password" },
    );
    expect(localStorage.length).toBe(0);
  });
  it("focuses confirmation and never sends mismatched passwords", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<AccountForm signup />);
    await user.type(screen.getByLabelText("Name"), "Operator");
    await user.type(screen.getByLabelText("Email"), "operator@example.com");
    await user.type(screen.getByLabelText("Password"), "a long password here");
    await user.type(screen.getByLabelText("Confirm password"), "different");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Passwords do not match",
    );
    expect(document.activeElement).toBe(
      screen.getByLabelText("Confirm password"),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
