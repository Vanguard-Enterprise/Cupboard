// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { OrganizationUsers } from "./organization-users";
import { TooltipProvider } from "./ui/tooltip";
import {
  organizationTeamKey,
  parseOrganizationTeam,
} from "@/lib/organization-team";

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

function mount() {
  return render(
    <TooltipProvider>
      <OrganizationUsers />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Organization users", () => {
  it("searches and sorts the user table", async () => {
    const user = userEvent.setup();
    mount();
    expect(await screen.findByRole("heading", { name: "Users" })).toBeTruthy();
    expect(screen.queryByText(/^Local preview/)).toBeNull();
    const search = screen.getByLabelText("Search users");
    expect(search.className).toContain("h-11");
    expect(search.className).toContain("focus:placeholder:text-transparent");
    expect(search.getAttribute("placeholder")).toBe("Search users");
    expect(search.parentElement?.className).toContain("sm:w-72");
    await user.type(search, "noah");
    expect(screen.getAllByText("Noah Williams").length).toBeGreaterThan(0);
    expect(screen.queryByText("Maya Chen")).toBeNull();

    await user.clear(search);
    await user.click(screen.getByRole("button", { name: /Sort by User/ }));
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows[1].textContent).toContain("Priya Shah");
  });

  it("filters users by role and status", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });

    await user.click(screen.getByRole("button", { name: "Filters" }));
    const menu = screen.getByRole("menu");
    await user.click(
      within(menu).getByRole("menuitemcheckbox", { name: "Viewer" }),
    );

    expect(screen.getAllByText("Noah Williams").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Lena Ortiz").length).toBeGreaterThan(0);
    expect(screen.queryByText("Maya Chen")).toBeNull();
    expect(
      screen.getByRole("menu", { name: "Filters, 1 active" }),
    ).toBeTruthy();

    await user.click(
      within(menu).getByRole("menuitemcheckbox", { name: "Suspended" }),
    );

    expect(screen.getAllByText("Lena Ortiz").length).toBeGreaterThan(0);
    expect(screen.queryByText("Noah Williams")).toBeNull();
    expect(
      screen.getByRole("menu", { name: "Filters, 2 active" }),
    ).toBeTruthy();

    await user.click(
      within(menu).getByRole("menuitem", { name: "Clear filters" }),
    );
    expect(screen.getAllByText("Maya Chen").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Filters" })).toBeTruthy();
  });

  it("creates an invitation and persists its role", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "Invite user" }));
    const dialog = screen.getByRole("dialog", { name: "Invite user" });
    await user.type(within(dialog).getByLabelText("Name"), "Alex Morgan");
    await user.type(within(dialog).getByLabelText("Email"), "alex@example.com");
    await user.click(within(dialog).getByLabelText("User role"));
    await user.click(screen.getByRole("option", { name: "Operator" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Create invitation" }),
    );

    const stored = parseOrganizationTeam(
      localStorage.getItem(organizationTeamKey)!,
    );
    expect(stored.users.at(-1)).toMatchObject({
      name: "Alex Morgan",
      email: "alex@example.com",
      roleId: "operator",
      status: "invited",
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Invitation created for alex@example.com.",
    );
  });

  it("updates and removes a user", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "Manage Maya Chen" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit user" }));
    const editDialog = screen.getByRole("dialog", { name: "Edit user" });
    await user.click(within(editDialog).getByLabelText("User role"));
    await user.click(screen.getByRole("option", { name: "Administrator" }));
    await user.click(within(editDialog).getByLabelText("User status"));
    await user.click(screen.getByRole("option", { name: "Suspended" }));
    await user.click(
      within(editDialog).getByRole("button", { name: "Save user" }),
    );

    let stored = parseOrganizationTeam(
      localStorage.getItem(organizationTeamKey)!,
    );
    expect(
      stored.users.find(({ id }) => id === "user-maya-chen"),
    ).toMatchObject({ roleId: "administrator", status: "suspended" });

    await user.click(screen.getByRole("button", { name: "Manage Maya Chen" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove user" }));
    const confirm = screen.getByRole("alertdialog");
    await user.click(
      within(confirm).getByRole("button", { name: "Remove user" }),
    );
    stored = parseOrganizationTeam(localStorage.getItem(organizationTeamKey)!);
    expect(stored.users.some(({ id }) => id === "user-maya-chen")).toBe(false);
  });

  it("keeps the invitation dialog open when browser storage fails", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "Invite user" }));
    const dialog = screen.getByRole("dialog", { name: "Invite user" });
    await user.type(within(dialog).getByLabelText("Name"), "Alex Morgan");
    await user.type(within(dialog).getByLabelText("Email"), "alex@example.com");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Create invitation" }),
    );

    expect(screen.getByRole("dialog", { name: "Invite user" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Could not save");
    expect(toast.success).not.toHaveBeenCalled();
  });
});
