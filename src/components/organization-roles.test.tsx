// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { OrganizationRoles } from "./organization-roles";
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
      <OrganizationRoles />
    </TooltipProvider>,
  );
}
describe("Organization roles backed by the API", () => {
  it("searches permission descriptions from the backend roles", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Roles" });
    await user.type(screen.getByLabelText("Search roles"), "billing");
    expect(within(screen.getByRole("table")).getByText("Owner")).toBeTruthy();
    expect(
      within(screen.getByRole("table")).queryByText("Operator"),
    ).toBeNull();
  });
  it("persists a new role with revision and displays the server result", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Roles" });
    await user.click(screen.getByRole("button", { name: "Add role" }));
    const dialog = screen.getByRole("dialog", { name: "Add role" });
    await user.type(within(dialog).getByLabelText("Role name"), "Support");
    await user.type(
      within(dialog).getByLabelText("Description"),
      "Support staff",
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: "View servers" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create role" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(screen.getByRole("table")).getByText("Support")).toBeTruthy();
    const call = api.fetcher.mock.calls.find(
      ([, options]) => options?.method === "POST",
    )!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      revision: 1,
      change: { kind: "createRole", role: { name: "Support" } },
    });
    expect(localStorage.length).toBe(0);
  });
  it("keeps a stale edit for review when the server returns a conflict", async () => {
    api.state.error = "Team settings changed. Refresh and review your changes.";
    api.state.status = 409;
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Roles" });
    await user.click(
      within(screen.getByRole("table")).getByRole("button", {
        name: "Manage Operator",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit role" }));
    const dialog = screen.getByRole("dialog", { name: "Edit role" });
    await user.type(within(dialog).getByLabelText("Description"), " Updated");
    await user.click(within(dialog).getByRole("button", { name: "Save role" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toContain(
        "Team settings changed",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
  it("locks the owner role in the editor", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Roles" });
    await user.click(
      within(screen.getByRole("table")).getByRole("button", {
        name: "Manage Owner",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit role" }));
    const dialog = screen.getByRole("dialog", { name: "Edit role" });
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Save role",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

it("sorts by hierarchy and persists drag reordering", async () => {
  mount();
  await screen.findByRole("heading", { name: "Roles" });
  const table = screen.getByRole("table");
  const before = within(table).getAllByRole("row").slice(1);
  expect(
    before.map((row) =>
      within(row)
        .getByRole("button", { name: /Reorder/ })
        .getAttribute("aria-label"),
    ),
  ).toEqual([
    "Reorder Owner",
    "Reorder Administrator",
    "Reorder Operator",
    "Reorder Viewer",
  ]);
  expect(
    (
      within(table).getByRole("button", {
        name: "Reorder Owner",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  const dataTransfer = {
    setData: vi.fn(),
    getData: vi.fn(() => "operator"),
    effectAllowed: "",
  };
  fireEvent.dragStart(
    within(table).getByRole("button", { name: "Reorder Operator" }),
    { dataTransfer },
  );
  expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "operator");
  fireEvent.drop(before[3], { dataTransfer });
  await waitFor(() => expect(api.state.team.roles[2].id).toBe("viewer"));
  const call = api.fetcher.mock.calls.find(
    ([, options]) => options?.method === "POST",
  )!;
  expect(JSON.parse(String(call[1]?.body)).change).toEqual({
    kind: "reorderRoles",
    ids: ["owner", "administrator", "viewer", "operator"],
  });
});
it("supports keyboard reordering and locks roles at the user's level", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByRole("heading", { name: "Roles" });
  const handle = within(screen.getByRole("table")).getByRole("button", {
    name: "Reorder Viewer",
  });
  handle.focus();
  await user.keyboard("{ArrowUp}");
  await waitFor(() => expect(api.state.team.roles[2].id).toBe("viewer"));
});

it("reorders with pointer handles and cancels without saving", async () => {
  mount();
  await screen.findByRole("heading", { name: "Roles" });
  const table = screen.getByRole("table");
  const rows = within(table).getAllByRole("row").slice(1);
  const handle = within(table).getByRole("button", {
    name: "Reorder Operator",
  });
  const hit = vi.fn(() => rows[3]);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: hit,
  });
  // jsdom does not implement PointerEvent coordinates.
  vi.stubGlobal("PointerEvent", MouseEvent);
  fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(handle, { clientX: 10, clientY: 80 });
  expect(rows[3].className).toContain("outline-primary");
  fireEvent.pointerCancel(handle);
  expect(
    api.fetcher.mock.calls.filter(([, options]) => options?.method === "POST"),
  ).toHaveLength(0);
  fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(handle, { clientX: 10, clientY: 80 });
  fireEvent.pointerUp(handle, { clientX: 10, clientY: 80 });
  await waitFor(() => expect(api.state.team.roles[2].id).toBe("viewer"));
  delete (document as Partial<Document>).elementFromPoint;
});

it("inspects built-in permissions by keyboard and restores focus", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByRole("heading", { name: "Roles" });
  const trigger = within(screen.getByRole("table")).getByRole("button", {
    name: "View Owner role",
  });
  trigger.focus();
  await user.keyboard("{Enter}");
  const drawer = screen.getByRole("dialog", { name: "Owner" });
  expect(
    within(drawer).getByText(
      "Built-in roles cannot be edited, moved, or deleted.",
    ),
  ).toBeTruthy();
  expect(
    (
      within(drawer).getByRole("button", {
        name: "Edit role",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(within(drawer).getAllByText(": Granted").length).toBeGreaterThan(0);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
it("shows missing permissions and opens an editable role from its details", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByRole("heading", { name: "Roles" });
  expect(
    screen.queryByText("Control what organization members can access."),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit hierarchy" })).toBeNull();
  await user.click(
    within(screen.getByRole("table")).getByRole("button", {
      name: "View Operator role",
    }),
  );
  const drawer = screen.getByRole("dialog", { name: "Operator" });
  expect(within(drawer).getAllByText(": Not granted").length).toBeGreaterThan(
    0,
  );
  await user.click(within(drawer).getByRole("button", { name: "Edit role" }));
  const editor = screen.getByRole("dialog", { name: "Edit role" });
  expect(within(editor).getByText(/Changes affect/)).toBeTruthy();
  expect(
    (
      within(editor).getByRole("button", {
        name: "Save role",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it.each(["cancel", "escape", "save"])(
  "restores the role trigger after %s in an editor opened from details",
  async (action) => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Roles" });
    const trigger = within(screen.getByRole("table")).getByRole("button", {
      name: "View Operator role",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(
      within(screen.getByRole("dialog", { name: "Operator" })).getByRole(
        "button",
        { name: "Edit role" },
      ),
    );
    const editor = screen.getByRole("dialog", { name: "Edit role" });
    if (action === "escape") await user.keyboard("{Escape}");
    else
      await user.click(
        within(editor).getByRole("button", {
          name: action === "save" ? "Save role" : "Cancel",
        }),
      );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  },
);

it("moves focus to Roles when a refresh removes the inspected role", async () => {
  const user = userEvent.setup();
  mount();
  const heading = await screen.findByRole("heading", { name: "Roles" });
  await user.click(
    within(screen.getByRole("table")).getByRole("button", {
      name: "View Viewer role",
    }),
  );
  expect(screen.getByRole("dialog", { name: "Viewer" })).toBeTruthy();
  api.state.team.roles = api.state.team.roles.filter(
    (role) => role.id !== "viewer",
  );
  api.state.team.users = api.state.team.users.map((member) => ({
    ...member,
    roleIds: member.roleIds.map((id) => (id === "viewer" ? "operator" : id)),
  }));
  fireEvent.focus(window);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(heading));
});

it.each(["view", "manage", "both"] as const)(
  "summarizes infrastructure-only roles with %s grants",
  async (grant) => {
    const role = api.state.team.roles.find((role) => role.name === "Operator")!;
    role.permissions =
      grant === "view"
        ? ["infrastructure.view"]
        : grant === "manage"
          ? ["infrastructure.manage"]
          : ["infrastructure.view", "infrastructure.manage"];
    const label =
      grant === "view" ? "Infrastructure viewing" : "Infrastructure management";
    mount();
    const trigger = within(await screen.findByRole("table")).getByRole(
      "button",
      {
        name: "View Operator role",
      },
    );
    const row = trigger.closest("tr")!;
    expect(within(row).getByText(label)).not.toBeNull();
    expect(within(row).queryByText("No permissions")).toBeNull();
    expect(screen.getAllByText(label)).toHaveLength(2);
  },
);
