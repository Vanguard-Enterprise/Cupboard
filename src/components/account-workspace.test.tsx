// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AccountWorkspace } from "./account-workspace";
import { apiRequest, navigateAfterAuth } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({
  apiRequest: vi.fn(),
  navigateAfterAuth: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("creates an organization only after the account holder chooses to", async () => {
  vi.mocked(apiRequest).mockResolvedValue({ id: "new-org" });
  const user = userEvent.setup();
  render(
    <AccountWorkspace
      identity={{
        user: { id: "user", name: "Operator", email: "operator@example.com" },
        organization: null,
        organizations: [],
        membershipId: null,
        permissions: [],
      }}
    />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(apiRequest).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Create organization" }));
  await user.type(
    screen.getByLabelText("Organization name"),
    "My organization",
  );
  await user.click(
    screen.getAllByRole("button", { name: "Create organization" }).at(-1)!,
  );
  await waitFor(() =>
    expect(navigateAfterAuth).toHaveBeenCalledWith("/dashboard"),
  );
  expect(apiRequest).toHaveBeenCalledExactlyOnceWith("organizations", {
    name: "My organization",
  });
});

it.each(["a".repeat(64), "https://cupboard.example/join#" + "a".repeat(64)])(
  "joins with a code or invitation link",
  async (code) => {
    vi.mocked(apiRequest).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      <AccountWorkspace
        identity={{
          user: { id: "user", name: "Operator", email: "operator@example.com" },
          organization: null,
          organizations: [],
          membershipId: null,
          permissions: [],
        }}
      />,
    );
    await user.type(screen.getByLabelText("Join code"), code);
    await user.click(screen.getByRole("button", { name: "Join organization" }));
    await waitFor(() =>
      expect(navigateAfterAuth).toHaveBeenCalledWith("/dashboard"),
    );
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith("invitations/accept", {
      token: "a".repeat(64),
    });
  },
);
it("keeps rejected invitation errors beside the focused code field", async () => {
  vi.mocked(apiRequest).mockRejectedValue(
    new Error("This invitation is invalid or has expired."),
  );
  const user = userEvent.setup();
  render(
    <AccountWorkspace
      identity={{
        user: { id: "user", name: "Operator", email: "operator@example.com" },
        organization: null,
        organizations: [],
        membershipId: null,
        permissions: [],
      }}
    />,
  );
  await user.type(screen.getByLabelText("Join code"), "a".repeat(64));
  await user.click(screen.getByRole("button", { name: "Join organization" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("expired"),
  );
  expect(document.activeElement).toBe(screen.getByLabelText("Join code"));
  expect(navigateAfterAuth).not.toHaveBeenCalled();
});
