import { organizationPreviewStorage } from "@/lib/organization-preview-storage";
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
import {
  defaultOrganizationAccess,
  parseOrganizationAccess,
} from "@/lib/organization-access";
import { toast } from "sonner";

const scrollIntoView = HTMLElement.prototype.scrollIntoView;

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
    localStorage.setItem(
      organizationPreviewStorage.access.key,
      JSON.stringify(settings),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: organizationPreviewStorage.access.key,
      }),
    );
  });
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
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
afterAll(() => {
  if (scrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  vi.unstubAllGlobals();
});

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
    const stored = JSON.parse(
      localStorage.getItem(organizationPreviewStorage.access.key)!,
    );
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
    expect(
      localStorage.getItem(organizationPreviewStorage.access.key),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      parseOrganizationAccess(
        localStorage.getItem(organizationPreviewStorage.access.key)!,
      ).members.at(-1)?.email,
    ).toBe("new.operator@example.com");
  });

  it("rejects an address whose generated member cannot be reloaded", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Member access" });
    await user.click(screen.getByRole("button", { name: "Invite member" }));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: `${"a".repeat(201)}@example.com` },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Send invitation",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("discards invitation fields when the dialog is canceled or dismissed", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Member access" });

    await user.click(screen.getByRole("button", { name: "Invite member" }));
    await user.type(
      screen.getByLabelText("Email address"),
      "canceled@example.com",
    );
    screen.getByLabelText("Role").focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("option", { name: "Administrator" });
    await user.keyboard("{Home}{Enter}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Invite member" }));
    expect(
      (screen.getByLabelText("Email address") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByLabelText("Role").textContent).toContain("Viewer");
    expect(
      (
        screen.getByRole("button", {
          name: "Send invitation",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await user.type(
      screen.getByLabelText("Email address"),
      "dismissed@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Invite member" }));
    expect(
      (screen.getByLabelText("Email address") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (
        screen.getByRole("button", {
          name: "Send invitation",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("preserves a dirty draft when another tab saves", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Member access" });
    const serverRule = screen.getByRole("switch", {
      name: "Require approval for Server lifecycle",
    }) as HTMLButtonElement;
    await user.click(serverRule);

    const external = structuredClone(defaultOrganizationAccess);
    external.rules[3].enabled = true;
    externalSave(external);

    expect(serverRule.getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByRole("alert").textContent).toContain(
      "changed in another tab",
    );
    const save = screen.getByRole("button", {
      name: "Save changes",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(save);
    expect(
      JSON.parse(localStorage.getItem(organizationPreviewStorage.access.key)!)
        .rules[3].enabled,
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(serverRule.getAttribute("data-state")).toBe("checked");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("loads another tab's save immediately when the draft is clean", async () => {
    mount();
    await screen.findByRole("heading", { name: "Member access" });
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

  it("replaces malformed stored settings with valid defaults", async () => {
    localStorage.setItem(organizationPreviewStorage.access.key, "not-json");
    const user = userEvent.setup();
    mount();
    await screen.findByRole("heading", { name: "Member access" });

    expect(screen.getByRole("alert").textContent).toContain(
      "could not be loaded",
    );
    const cancel = screen.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    const save = screen.getByRole("button", {
      name: "Save changes",
    }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(save.disabled).toBe(false);

    await user.click(save);

    expect(
      parseOrganizationAccess(
        localStorage.getItem(organizationPreviewStorage.access.key)!,
      ),
    ).toEqual(defaultOrganizationAccess);
    expect(toast.success).toHaveBeenCalledWith("Changes saved");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(save.disabled).toBe(true);
  });
});
