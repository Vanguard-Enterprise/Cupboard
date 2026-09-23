// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { OrganizationUsers } from "./organization-users";
import { TooltipProvider } from "./ui/tooltip";
import { setupTeamApi } from "@/test/team-api";
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
let api: ReturnType<typeof setupTeamApi>;
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  api = setupTeamApi();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount() {
  render(
    <TooltipProvider>
      <OrganizationUsers />
    </TooltipProvider>,
  );
}
describe("Organization users backed by the API", () => {
  it("loads and searches real response data without using local storage", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    await user.type(screen.getByLabelText("Search users"), "maya");
    expect(
      within(screen.getByRole("table")).getByText("Maya Chen"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("table")).queryByText("Priya Shah"),
    ).toBeNull();
    expect(api.fetcher.mock.calls[0][0]).toBe("/app-api/team");
    expect(localStorage.length).toBe(0);
  });
  it("creates a backend invitation and displays the one-time link", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "Invite user" }));
    const dialog = screen.getByRole("dialog", { name: "Invite user" });
    await user.type(within(dialog).getByLabelText("Name"), "New member");
    await user.type(within(dialog).getByLabelText("Email"), "new@example.com");
    await user.click(within(dialog).getByRole("checkbox", { name: "Viewer" }));
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Operator" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create invitation" }),
    );
    const share = await screen.findByRole("dialog", {
      name: "Share invitation",
    });
    expect(
      (within(share).getByLabelText("Invitation link") as HTMLInputElement)
        .value,
    ).toContain(`/join#${"a".repeat(64)}`);
    const call = api.fetcher.mock.calls.find(
      ([, options]) => options?.method === "POST",
    )!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      revision: 1,
      change: {
        kind: "invite",
        user: { email: "new@example.com", roleIds: ["viewer", "operator"] },
      },
    });
    expect(localStorage.length).toBe(0);
  });
  it("keeps edits open and reports backend authorization failures without success", async () => {
    api.state.error = "You do not have permission to perform this action.";
    api.state.status = 403;
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    await user.click(
      within(screen.getByRole("table")).getByRole("button", {
        name: "Manage Maya Chen",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit user" });
    expect(
      (within(dialog).getByLabelText("Email") as HTMLInputElement).disabled,
    ).toBe(true);
    await user.click(
      within(dialog).getByRole("combobox", { name: "User status" }),
    );
    await user.click(screen.getByRole("option", { name: "Suspended" }));
    await user.click(within(dialog).getByRole("button", { name: "Save user" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toContain(
        "permission",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
  it("shows access denial instead of demo users when loading fails", async () => {
    api.fetcher.mockResolvedValue(
      Response.json({ error: "You do not have permission." }, { status: 403 }),
    );
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "permission",
    );
    expect(screen.queryByText("Maya Chen")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Invite user" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

it("saves multiple role assignments on an existing member", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByRole("heading", { name: "Users" });
  await user.click(
    within(screen.getByRole("table")).getByRole("button", {
      name: "Manage Maya Chen",
    }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Edit" }));
  const dialog = screen.getByRole("dialog", { name: "Edit user" });
  expect(within(dialog).queryByRole("checkbox", { name: "Owner" })).toBeNull();
  await user.click(within(dialog).getByRole("checkbox", { name: "Viewer" }));
  await user.click(within(dialog).getByRole("button", { name: "Save user" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    api.state.team.users.find((entry) => entry.name === "Maya Chen")?.roleIds,
  ).toEqual(["operator", "viewer"]);
});
it("disables editing users with equal or higher roles", async () => {
  api.state.team.currentUserId = "user-priya-shah";
  mount();
  await screen.findByRole("heading", { name: "Users" });
  const table = screen.getByRole("table");
  expect(
    (
      within(table).getByRole("button", {
        name: "Manage Demo operator",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      within(table).getByRole("button", {
        name: "Manage Priya Shah",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      within(table).getByRole("button", {
        name: "Manage Maya Chen",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
