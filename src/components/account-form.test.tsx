// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
    await user.click(screen.getByRole("button", { name: "Sign in" }));
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

for (const signup of [false, true]) {
  describe(
    signup ? "Unicode signup passwords" : "Unicode login passwords",
    () => {
      it.each(["😀".repeat(4), "界".repeat(129)])(
        "rejects invalid character counts without sending credentials (%#)",
        async (password) => {
          const fetcher = vi.fn();
          vi.stubGlobal("fetch", fetcher);
          render(<AccountForm signup={signup} />);
          fillForm(signup, password);
          const user = userEvent.setup();
          await user.click(
            screen.getByRole("button", {
              name: signup ? "Create account" : "Sign in",
            }),
          );
          expect(screen.getByRole("alert").textContent).toContain(
            "8 to 128 characters",
          );
          expect(document.activeElement).toBe(
            screen.getByLabelText("Password"),
          );
          expect(fetcher).not.toHaveBeenCalled();
        },
      );
      it.each(["😀".repeat(8), "界".repeat(100), "😀".repeat(128)])(
        "submits valid Unicode passwords unchanged (%#)",
        async (password) => {
          const fetcher = vi.fn<
            (url: unknown, options?: RequestInit) => Promise<Response>
          >(async () =>
            Response.json({ error: "Test response" }, { status: 400 }),
          );
          vi.stubGlobal("fetch", fetcher);
          render(<AccountForm signup={signup} />);
          fillForm(signup, password);
          const input = screen.getByLabelText("Password");
          expect(input.hasAttribute("minlength")).toBe(false);
          expect(input.hasAttribute("maxlength")).toBe(false);
          const user = userEvent.setup();
          await user.click(
            screen.getByRole("button", {
              name: signup ? "Create account" : "Sign in",
            }),
          );
          await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
          expect(
            JSON.parse(String(fetcher.mock.calls[0][1]?.body)).password,
          ).toBe(password);
        },
      );
    },
  );
}

function fillForm(signup: boolean, password: string) {
  if (signup)
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Operator" },
    });
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "operator@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: password },
  });
  if (signup)
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: password },
    });
}
