// @vitest-environment jsdom
import { render, testPreviewKey } from "@/test/preview-storage";
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationAccess } from "./organization-access";
import { TooltipProvider } from "./ui/tooltip";
import {
  defaultOrganizationAccess,
  organizationAccessKey as organizationAccessKeyBase,
  parseOrganizationAccess,
} from "@/lib/organization-access";

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
  it("shows approval counts in a responsive column", async () => {
    mount();

    expect(
      await screen.findByRole("heading", { name: "Approval rules" }),
    ).toBeTruthy();
    expect(screen.queryByText("Member access", { selector: "h2" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite member" })).toBeNull();

    const serverRule = screen.getByTestId("approval-rule-server-lifecycle");
    expect(serverRule.className).toContain("grid");
    expect(serverRule.className).toContain("sm:grid-cols-");
    const approvalLabels = screen.getAllByText("Approvals required");
    expect(approvalLabels).toHaveLength(3);
    expect(approvalLabels[0].className).toContain("sm:sr-only");
    const serverApprovers = screen.getByLabelText(
      "Approvals required for Server lifecycle",
    );
    expect(serverApprovers.className).toContain("h-11");
    expect(serverApprovers.className).toContain("sm:h-10");

    expect(screen.queryByRole("switch")).toBeNull();
    const cancel = screen.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save.className).toContain("h-11");
    expect(save.className).toContain("w-full");
  });

  it("saves approver changes", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Approval rules" });
    expect(
      screen.getByText(
        "Saved in this browser. These rules do not block sensitive actions.",
      ),
    ).toBeTruthy();

    const save = screen.getByRole("button", {
      name: "Save changes",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await user.click(screen.getByLabelText("Approvals required for Billing"));
    await user.click(screen.getByRole("option", { name: "2" }));
    expect(save.disabled).toBe(false);
    await user.click(save);

    const stored = parseOrganizationAccess(
      localStorage.getItem(organizationAccessKey)!,
    );
    expect(stored.rules[2].approvals).toBe(2);
    expect(screen.getByRole("status").textContent).toContain(
      "Approval settings saved.",
    );
    expect(save.disabled).toBe(true);
  });

  it("cancels unsaved approval changes", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Approval rules" });
    const billing = screen.getByLabelText("Approvals required for Billing");
    const cancel = screen.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    const save = screen.getByRole("button", {
      name: "Save changes",
    }) as HTMLButtonElement;

    await user.click(billing);
    await user.click(screen.getByRole("option", { name: "2" }));
    expect(billing.textContent).toContain("2");
    expect(cancel.disabled).toBe(false);

    await user.click(cancel);
    expect(billing.textContent).toContain("None");
    expect(cancel.disabled).toBe(true);
    expect(save.disabled).toBe(true);
    expect(localStorage.getItem(organizationAccessKey)).toBeNull();
  });

  it("saves a rule with no approval requirement", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Approval rules" });

    await user.click(
      screen.getByLabelText("Approvals required for Server lifecycle"),
    );
    await user.click(screen.getByRole("option", { name: "None" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      parseOrganizationAccess(localStorage.getItem(organizationAccessKey)!)
        .rules[0].approvals,
    ).toBe(0);
  });

  it("preserves a dirty draft when another tab saves", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Approval rules" });
    const serverApprovers = screen.getByLabelText(
      "Approvals required for Server lifecycle",
    );
    await user.click(serverApprovers);
    await user.click(screen.getByRole("option", { name: "2" }));

    const external = structuredClone(defaultOrganizationAccess);
    external.rules[1].approvals = 1;
    externalSave(external);

    expect(serverApprovers.textContent).toContain("2");
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

    await user.click(screen.getByRole("button", { name: "Load latest" }));
    expect(serverApprovers.textContent).toContain("1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("loads another tab's save when the draft is clean", async () => {
    mount();
    await screen.findByRole("heading", { name: "Approval rules" });
    const external = structuredClone(defaultOrganizationAccess);
    external.rules[0].approvals = 2;
    externalSave(external);

    expect(
      screen.getByLabelText("Approvals required for Server lifecycle")
        .textContent,
    ).toContain("2");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the draft when browser storage fails", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Approval rules" });
    await user.click(screen.getByLabelText("Approvals required for Billing"));
    await user.click(screen.getByRole("option", { name: "2" }));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const storageAlert = screen.getByRole("alert");
    expect(storageAlert.getAttribute("data-slot")).toBe("alert");
    expect(storageAlert.textContent).toContain("Could not save");
    expect(screen.queryByRole("status")).toBeNull();
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
    expect(screen.getByRole("status").textContent).toContain(
      "Approval settings saved.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(save.disabled).toBe(true);
  });
});

const organizationAccessKey = testPreviewKey(organizationAccessKeyBase);
