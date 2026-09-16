// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { OrganizationAccess } from "./organization-access";
import { TooltipProvider } from "./ui/tooltip";
import { organizationAccessKey } from "@/lib/organization-access";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

function mount() {
  return render(
    <TooltipProvider>
      <OrganizationAccess />
    </TooltipProvider>,
  );
}

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
afterAll(() => vi.unstubAllGlobals());

describe("Organization access", () => {
  it("saves access changes directly and resets the dirty state", async () => {
    const user = userEvent.setup();
    mount();

    expect(
      await screen.findByRole("heading", { name: "Member access" }),
    ).toBeTruthy();
    expect(screen.getByText(/3 active/).textContent).toContain("1 pending");
    const ownerRole = screen.getByLabelText("Role for Demo operator");
    expect(ownerRole.tagName).toBe("SPAN");
    expect(ownerRole.textContent).toBe("Owner");
    const cancel = screen.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(cancel.getAttribute("data-variant")).toBe("secondary");
    expect(
      (
        screen.getByRole("button", {
          name: "Save changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    const disabledApprovers = screen.getByLabelText(
      "Approvers for Billing",
    ) as HTMLButtonElement;
    expect(disabledApprovers.disabled).toBe(true);
    expect(disabledApprovers.className).toContain("disabled:opacity-25");

    await user.click(
      screen.getByRole("switch", {
        name: "Require approval for Server lifecycle",
      }),
    );
    expect(cancel.disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("Changes saved in this browser.")).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Changes saved");
    expect(cancel.disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Save changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    const stored = JSON.parse(localStorage.getItem(organizationAccessKey)!);
    expect(stored.rules[0].enabled).toBe(false);
  });

  it("validates and stages an invitation before saving", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Member access" });

    await user.click(screen.getByRole("button", { name: "Invite member" }));
    expect(screen.getByRole("heading", { name: "Invite member" })).toBeTruthy();
    expect(
      screen.queryByText(/pending invitation to this local preview/i),
    ).toBeNull();
    const sendInvitation = screen.getByRole("button", {
      name: "Send invitation",
    }) as HTMLButtonElement;
    expect(sendInvitation.disabled).toBe(true);
    await user.type(screen.getByLabelText("Email address"), "invalid");
    expect(sendInvitation.disabled).toBe(true);

    const email = screen.getByLabelText("Email address");
    await user.clear(email);
    await user.type(email, "new.operator@example.com");
    expect(sendInvitation.disabled).toBe(false);
    await user.click(sendInvitation);

    expect(screen.getByText("new.operator@example.com")).toBeTruthy();
    expect(screen.getByText(/3 active/).textContent).toContain("2 pending");
    expect(localStorage.getItem(organizationAccessKey)).toBeNull();
  });

  it("keeps the draft when browser storage fails", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Member access" });
    await user.click(
      screen.getByRole("switch", { name: "Require approval for Billing" }),
    );
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(screen.getByRole("alert").textContent).toContain("Could not save");
    expect(toast.success).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("button", {
          name: "Save changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
