// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { OrganizationUsers } from "./organization-users";
import { TooltipProvider } from "./ui/tooltip";
import {
  defaultOrganizationTeam,
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

function publishTeam(settings: typeof defaultOrganizationTeam) {
  const raw = JSON.stringify(settings);
  localStorage.setItem(organizationTeamKey, raw);
  window.dispatchEvent(
    new StorageEvent("storage", { key: organizationTeamKey, newValue: raw }),
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
    expect(within(dialog).queryByLabelText("User status")).toBeNull();
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

  it("focuses and describes the first invalid field in user dialogs", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "Invite user" }));
    const inviteDialog = screen.getByRole("dialog", { name: "Invite user" });
    await user.click(
      within(inviteDialog).getByRole("button", { name: "Create invitation" }),
    );

    const inviteName = within(inviteDialog).getByLabelText("Name");
    expect(document.activeElement).toBe(inviteName);
    expect(inviteName.getAttribute("aria-invalid")).toBe("true");
    expect(inviteName.getAttribute("aria-describedby")).toBe(
      "team-user-name-error",
    );
    expect(
      within(inviteDialog).getByText("Enter the user's name."),
    ).toBeTruthy();

    await user.click(
      within(inviteDialog).getByRole("button", { name: "Cancel" }),
    );
    await user.click(
      within(screen.getByRole("table")).getByRole("button", {
        name: "Manage Maya Chen",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit user" }));
    const editDialog = screen.getByRole("dialog", { name: "Edit user" });
    const email = within(editDialog).getByLabelText("Email");
    await user.clear(email);
    await user.type(email, "invalid");
    await user.click(
      within(editDialog).getByRole("button", { name: "Save user" }),
    );

    expect(document.activeElement).toBe(email);
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBe(
      "team-user-email-error",
    );
    expect(
      within(editDialog).getByText("Enter a valid email address."),
    ).toBeTruthy();
  });

  it("discards a canceled invitation draft", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "Invite user" }));
    const dialog = screen.getByRole("dialog", { name: "Invite user" });
    await user.type(within(dialog).getByLabelText("Name"), "Canceled user");
    await user.type(
      within(dialog).getByLabelText("Email"),
      "canceled@example.com",
    );
    await user.click(within(dialog).getByLabelText("User role"));
    await user.click(screen.getByRole("option", { name: "Operator" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Invite user" }));
    const reopened = screen.getByRole("dialog", { name: "Invite user" });
    expect(
      (within(reopened).getByLabelText("Name") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (within(reopened).getByLabelText("Email") as HTMLInputElement).value,
    ).toBe("");
    expect(within(reopened).getByLabelText("User role").textContent).toContain(
      "Viewer",
    );
  });

  it("updates and removes a user", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    await user.click(
      within(screen.getByRole("table")).getByRole("button", {
        name: "Manage Maya Chen",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit user" }));
    const editDialog = screen.getByRole("dialog", { name: "Edit user" });
    expect(
      within(editDialog).getByText(/do not grant, suspend, or revoke access/i),
    ).toBeTruthy();
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

    await user.click(
      within(screen.getByRole("table")).getByRole("button", {
        name: "Manage Maya Chen",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove user" }));
    const confirm = screen.getByRole("alertdialog");
    await user.click(
      within(confirm).getByRole("button", { name: "Remove user" }),
    );
    stored = parseOrganizationTeam(localStorage.getItem(organizationTeamKey)!);
    expect(stored.users.some(({ id }) => id === "user-maya-chen")).toBe(false);
  });

  it("rejects an edit when the user changed in another tab", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    await user.click(
      within(screen.getByRole("table")).getByRole("button", {
        name: "Manage Maya Chen",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit user" }));
    const dialog = screen.getByRole("dialog", { name: "Edit user" });
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "Local edit");

    const external = structuredClone(defaultOrganizationTeam);
    external.users.find(({ id }) => id === "user-maya-chen")!.name =
      "Updated elsewhere";
    act(() => publishTeam(external));
    await user.click(within(dialog).getByRole("button", { name: "Save user" }));

    expect(within(dialog).getByRole("alert").textContent).toContain(
      "changed in another tab",
    );
    expect(
      parseOrganizationTeam(
        localStorage.getItem(organizationTeamKey)!,
      ).users.find(({ id }) => id === "user-maya-chen")?.name,
    ).toBe("Updated elsewhere");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("rejects an edit when the user was removed in another tab", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    await user.click(
      within(screen.getByRole("table")).getByRole("button", {
        name: "Manage Maya Chen",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit user" }));
    const dialog = screen.getByRole("dialog", { name: "Edit user" });

    const external = structuredClone(defaultOrganizationTeam);
    external.users = external.users.filter(({ id }) => id !== "user-maya-chen");
    act(() => publishTeam(external));
    await user.click(within(dialog).getByRole("button", { name: "Save user" }));

    expect(within(dialog).getByRole("alert").textContent).toContain(
      "removed in another tab",
    );
    expect(
      parseOrganizationTeam(
        localStorage.getItem(organizationTeamKey)!,
      ).users.some(({ id }) => id === "user-maya-chen"),
    ).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("keeps removal open when another tab already removed the user", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    await user.click(
      within(screen.getByRole("table")).getByRole("button", {
        name: "Manage Maya Chen",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove user" }));
    const confirmation = screen.getByRole("alertdialog", {
      name: "Remove Maya Chen?",
    });

    const external = structuredClone(defaultOrganizationTeam);
    external.users = external.users.filter(({ id }) => id !== "user-maya-chen");
    act(() => publishTeam(external));
    await user.click(
      within(confirmation).getByRole("button", { name: "Remove user" }),
    );

    expect(
      screen.getByRole("alertdialog", { name: "Remove Maya Chen?" }),
    ).toBeTruthy();
    expect(within(confirmation).getByRole("alert").textContent).toContain(
      "already removed in another tab",
    );
    expect(
      parseOrganizationTeam(
        localStorage.getItem(organizationTeamKey)!,
      ).users.some(({ id }) => id === "user-maya-chen"),
    ).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("keeps current-operator protections after an email change", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    const table = screen.getByRole("table");

    await user.click(
      within(table).getByRole("button", { name: "Manage Demo operator" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit user" }));
    const dialog = screen.getByRole("dialog", { name: "Edit user" });
    const email = within(dialog).getByLabelText("Email");
    await user.clear(email);
    await user.type(email, "changed@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Save user" }));

    await user.click(
      within(table).getByRole("button", { name: "Manage Demo operator" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit user" }));
    const reopenedDialog = screen.getByRole("dialog", { name: "Edit user" });
    expect(
      (within(reopenedDialog).getByLabelText("User role") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        within(reopenedDialog).getByLabelText(
          "User status",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.click(
      within(reopenedDialog).getByRole("button", { name: "Cancel" }),
    );
    await user.click(
      within(table).getByRole("button", { name: "Manage Demo operator" }),
    );
    expect(
      screen
        .getByRole("menuitem", { name: "Remove user" })
        .getAttribute("data-disabled"),
    ).not.toBeNull();
  });

  it("offers user removal from the mobile action menu", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Users" });
    const mobileList = screen.getByRole("list", {
      name: "Organization users",
    });

    await user.click(
      within(mobileList).getByRole("button", { name: "Manage Maya Chen" }),
    );
    expect(screen.getByRole("menuitem", { name: "Edit user" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Remove user" })).toBeTruthy();
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
