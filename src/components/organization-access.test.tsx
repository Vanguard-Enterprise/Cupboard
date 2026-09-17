// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { OrganizationAccess } from "./organization-access";
import { TooltipProvider } from "./ui/tooltip";
import {
  defaultOrganizationAccess,
  organizationAccessKey,
  parseOrganizationAccess,
} from "@/lib/organization-access";

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

function externalSave(settings = defaultOrganizationAccess) {
  act(() => {
    localStorage.setItem(organizationAccessKey, JSON.stringify(settings));
    window.dispatchEvent(
      new StorageEvent("storage", { key: organizationAccessKey }),
    );
  });
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

describe("Organization approvals", () => {
  it("shows only approval rules in a responsive control layout", async () => {
    mount();

    expect(
      await screen.findByRole("heading", { name: "Approval rules" }),
    ).toBeTruthy();
    expect(screen.queryByText("Member access", { selector: "h2" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull();

    const serverRule = screen.getByTestId("approval-rule-server-lifecycle");
    expect(serverRule.className).toContain("grid");
    expect(serverRule.className).toContain("sm:grid-cols-");

    for (const name of ["Cancel", "Save changes"]) {
      const button = screen.getByRole("button", { name });
      expect(button.className).toContain("h-11");
      expect(button.className).toContain("w-full");
    }
  });

  it("saves rule changes", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Approval rules" });

    const cancel = screen.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    const save = screen.getByRole("button", {
      name: "Save changes",
    }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(save.disabled).toBe(true);

    const disabledApprovers = screen.getByLabelText(
      "Approvers for Billing",
    ) as HTMLButtonElement;
    expect(disabledApprovers.disabled).toBe(true);
    expect(disabledApprovers.className).toContain("disabled:opacity-40");

    await user.click(
      screen.getByRole("switch", {
        name: "Require approval for Server lifecycle",
      }),
    );
    expect(cancel.disabled).toBe(false);
    expect(save.disabled).toBe(false);
    await user.click(save);

    const stored = parseOrganizationAccess(
      localStorage.getItem(organizationAccessKey)!,
    );
    expect(stored.rules[0].enabled).toBe(false);
    expect(toast.success).toHaveBeenCalledWith("Approval settings saved.");
    expect(cancel.disabled).toBe(true);
    expect(save.disabled).toBe(true);
  });

  it("changes the required approver count with the source-owned select", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Approval rules" });

    await user.click(screen.getByLabelText("Approvers for Server lifecycle"));
    await user.click(screen.getByRole("option", { name: "2 people" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      parseOrganizationAccess(localStorage.getItem(organizationAccessKey)!)
        .rules[0].approvals,
    ).toBe(2);
  });

  it("preserves a dirty draft when another tab saves", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Approval rules" });
    const serverRule = screen.getByRole("switch", {
      name: "Require approval for Server lifecycle",
    }) as HTMLButtonElement;
    await user.click(serverRule);

    const external = structuredClone(defaultOrganizationAccess);
    external.rules[2].enabled = true;
    externalSave(external);

    expect(serverRule.getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByRole("alert").textContent).toContain(
      "changed in another tab",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Save changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(serverRule.getAttribute("data-state")).toBe("checked");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("loads another tab's save when the draft is clean", async () => {
    mount();
    await screen.findByRole("heading", { name: "Approval rules" });
    const external = structuredClone(defaultOrganizationAccess);
    external.rules[0].enabled = false;
    externalSave(external);

    expect(
      screen
        .getByRole("switch", {
          name: "Require approval for Server lifecycle",
        })
        .getAttribute("data-state"),
    ).toBe("unchecked");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the draft when browser storage fails", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Approval rules" });
    await user.click(
      screen.getByRole("switch", { name: "Require approval for Billing" }),
    );
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const storageAlert = screen.getByRole("alert");
    expect(storageAlert.getAttribute("data-slot")).toBe("alert");
    expect(storageAlert.textContent).toContain("Could not save");
    expect(toast.success).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("button", {
          name: "Save changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("replaces malformed stored settings with valid defaults", async () => {
    localStorage.setItem(organizationAccessKey, "not-json");
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Approval rules" });

    expect(screen.getByRole("alert").textContent).toContain(
      "could not be loaded",
    );
    const save = screen.getByRole("button", {
      name: "Save changes",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    await user.click(save);

    expect(
      parseOrganizationAccess(localStorage.getItem(organizationAccessKey)!),
    ).toEqual(defaultOrganizationAccess);
    expect(toast.success).toHaveBeenCalledWith("Approval settings saved.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(save.disabled).toBe(true);
  });
});
