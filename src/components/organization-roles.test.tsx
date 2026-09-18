// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { OrganizationRoles } from "./organization-roles";
import { TooltipProvider } from "./ui/tooltip";
import {
  organizationTeamKey,
  parseOrganizationTeam,
} from "@/lib/organization-team";

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

function mount() {
  return render(
    <TooltipProvider>
      <OrganizationRoles />
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

describe("Organization roles", () => {
  it("searches permissions and sorts the role table", async () => {
    const user = userEvent.setup();
    mount();
    expect(await screen.findByRole("heading", { name: "Roles" })).toBeTruthy();
    expect(screen.queryByText(/^Local preview/)).toBeNull();
    const search = screen.getByLabelText("Search roles");
    await user.type(search, "billing");
    expect(screen.getAllByText("Owner").length).toBeGreaterThan(0);
    expect(screen.queryByText("Operator")).toBeNull();

    await user.clear(search);
    await user.click(
      screen.getByRole("button", { name: /Sort by Permissions/ }),
    );
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows[1].textContent).toContain("Viewer");
  });

  it("creates and deletes an unused custom role", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Roles" });
    await user.click(screen.getByRole("button", { name: "Add role" }));
    const dialog = screen.getByRole("dialog", { name: "Add role" });
    await user.type(within(dialog).getByLabelText("Role name"), "Support lead");
    await user.type(
      within(dialog).getByLabelText("Description"),
      "Handles player reports and support escalations.",
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: "View servers" }),
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Moderate players" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create role" }),
    );

    let stored = parseOrganizationTeam(
      localStorage.getItem(organizationTeamKey)!,
    );
    const custom = stored.roles.find(({ name }) => name === "Support lead");
    expect(custom?.permissions).toEqual(["servers.view", "players.moderate"]);

    await user.click(
      screen.getByRole("button", { name: "Manage Support lead" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete role" }));
    const confirm = screen.getByRole("alertdialog");
    await user.click(
      within(confirm).getByRole("button", { name: "Delete role" }),
    );
    stored = parseOrganizationTeam(localStorage.getItem(organizationTeamKey)!);
    expect(stored.roles.some(({ name }) => name === "Support lead")).toBe(
      false,
    );
  });

  it("edits permissions and prevents deleting built-in roles", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Roles" });
    await user.click(screen.getByRole("button", { name: "Manage Operator" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit role" }));
    const dialog = screen.getByRole("dialog", { name: "Edit role" });
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Manage integrations" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Save role" }));

    const stored = parseOrganizationTeam(
      localStorage.getItem(organizationTeamKey)!,
    );
    expect(
      stored.roles.find(({ id }) => id === "operator")?.permissions,
    ).toContain("integrations.manage");

    await user.click(screen.getByRole("button", { name: "Manage Owner" }));
    const deleteItem = screen.getByRole("menuitem", { name: "Delete role" });
    expect(deleteItem.getAttribute("data-disabled")).not.toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Role updated.");
  });
});
