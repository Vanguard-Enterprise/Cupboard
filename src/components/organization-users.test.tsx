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
      within(dialog).getByRole("button", { name: "Create invitation link" }),
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
    await user.click(screen.getByRole("menuitem", { name: "Manage access" }));
    const dialog = screen.getByRole("dialog", { name: "Manage access" });
    expect(
      (within(dialog).getByLabelText("Email") as HTMLInputElement).disabled,
    ).toBe(true);
    await user.click(
      within(dialog).getByRole("combobox", { name: "User status" }),
    );
    await user.click(screen.getByRole("option", { name: "Suspended" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
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
  await user.click(screen.getByRole("menuitem", { name: "Manage access" }));
  const dialog = screen.getByRole("dialog", { name: "Manage access" });
  expect(within(dialog).queryByRole("checkbox", { name: "Owner" })).toBeNull();
  await user.click(within(dialog).getByRole("checkbox", { name: "Viewer" }));
  await user.click(
    within(dialog).getByRole("button", { name: "Save changes" }),
  );
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
  const user = userEvent.setup();
  for (const name of ["Demo operator", "Priya Shah"]) {
    expect(
      within(table).queryByRole("button", { name: `Manage ${name}` }),
    ).toBeNull();
    await user.click(
      within(table).getByRole("button", {
        name: `Access restriction for ${name}`,
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Access restriction" }),
    ).toBeTruthy();
    await user.keyboard("{Escape}");
  }
  expect(
    (
      within(table).getByRole("button", {
        name: "Manage Maya Chen",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it("disables member actions for lower roles with permissions the manager lacks", async () => {
  api.state.team.currentUserId = "user-maya-chen";
  api.state.team.roles.find((role) => role.id === "operator")!.permissions = [
    "organization.manage",
    "servers.view",
  ];
  api.state.team.roles
    .find((role) => role.id === "viewer")!
    .permissions.push("billing.manage");
  mount();
  await screen.findByRole("heading", { name: "Users" });
  const table = screen.getByRole("table");
  for (const name of ["Noah Williams", "Lena Ortiz"]) {
    expect(
      within(table).queryByRole("button", { name: `Manage ${name}` }),
    ).toBeNull();
    expect(
      within(table).getByRole("button", {
        name: `Access restriction for ${name}`,
      }),
    ).toBeTruthy();
  }
  expect(
    api.fetcher.mock.calls.every(([, options]) => options?.method !== "POST"),
  ).toBe(true);
});

it("filters by status with keyboard tabs and removable role selections", async () => {
  const user = userEvent.setup();
  mount();
  const all = await screen.findByRole("tab", { name: "All 5" });
  all.focus();
  await user.keyboard("{ArrowRight}{ArrowRight}");
  await waitFor(() =>
    expect(
      screen
        .getByRole("tab", { name: "Invited 1" })
        .getAttribute("aria-selected"),
    ).toBe("true"),
  );
  expect(
    within(screen.getByRole("table")).getByText("Noah Williams"),
  ).toBeTruthy();
  expect(within(screen.getByRole("table")).queryByText("Maya Chen")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Filter by role" }));
  await user.click(screen.getByRole("menuitemcheckbox", { name: "Operator" }));
  await user.keyboard("{Escape}");
  expect(
    screen.getByRole("heading", { name: "No matching users" }),
  ).toBeTruthy();
  await user.click(
    screen.getByRole("button", { name: "Remove Operator filter" }),
  );
  expect(
    within(screen.getByRole("table")).getByText("Noah Williams"),
  ).toBeTruthy();
  expect(screen.getByRole("tab", { name: "All 5" })).toBeTruthy();
});

it("cancels pending invitations only after confirmation", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByRole("heading", { name: "Users" });
  await user.click(
    within(screen.getByRole("table")).getByRole("button", {
      name: "Manage Noah Williams",
    }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Cancel invitation" }));
  const dialog = screen.getByRole("alertdialog", {
    name: "Cancel invitation for Noah Williams?",
  });
  expect(
    api.fetcher.mock.calls.every(([, options]) => options?.method !== "POST"),
  ).toBe(true);
  await user.click(
    within(dialog).getByRole("button", { name: "Cancel invitation" }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(
    api.state.team.users.some((user) => user.name === "Noah Williams"),
  ).toBe(false);
});

it.each([true, false])(
  "reports clipboard outcome without storing the link, success=%s",
  async (success) => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText");
    if (success) write.mockResolvedValue();
    else write.mockRejectedValue(new Error("Denied"));
    mount();
    await screen.findByRole("heading", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "Invite user" }));
    const dialog = screen.getByRole("dialog", { name: "Invite user" });
    await user.type(within(dialog).getByLabelText("Name"), "New member");
    await user.type(within(dialog).getByLabelText("Email"), "new@example.com");
    await user.click(within(dialog).getByRole("checkbox", { name: "Viewer" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Create invitation link" }),
    );
    const share = await screen.findByRole("dialog", {
      name: "Share invitation",
    });
    await user.click(within(share).getByRole("button", { name: "Copy link" }));
    expect((await within(share).findByRole("status")).textContent).toBe(
      success
        ? "Link copied."
        : "Could not copy the link. Select it and copy it manually.",
    );
    expect(localStorage.length).toBe(0);
    await user.click(within(share).getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText("Invitation link")).toBeNull();
  },
);
