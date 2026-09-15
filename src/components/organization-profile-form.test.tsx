// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationProfileForm } from "./organization-profile-form";
import { OrganizationProvider } from "./organization-provider";
import { TooltipProvider } from "./ui/tooltip";
import {
  defaultOrganizationProfile,
  organizationProfileKey,
} from "@/lib/organization-profile";

function mount() {
  return render(
    <OrganizationProvider>
      <TooltipProvider>
        <OrganizationProfileForm />
      </TooltipProvider>
    </OrganizationProvider>,
  );
}
function externalSave(name: string) {
  const profile = { ...defaultOrganizationProfile, name };
  act(() => {
    localStorage.setItem(organizationProfileKey, JSON.stringify(profile));
    window.dispatchEvent(
      new StorageEvent("storage", { key: organizationProfileKey }),
    );
  });
}
const nameInput = () =>
  screen.getByLabelText(/Organization name/) as HTMLInputElement;
const saveButton = () =>
  screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
const cancelButton = () =>
  screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Organization profile persistence", () => {
  it("navigates filtered countries by keyboard", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("tab", { name: "Contact info" }));

    const country = screen.getByLabelText("Country") as HTMLInputElement;
    await user.type(country, "United");
    await screen.findByRole("option", { name: "United Kingdom" });
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(country.value).toBe("United Kingdom");
  });

  it("highlights hovered country options", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("tab", { name: "Contact info" }));

    const country = screen.getByLabelText("Country") as HTMLInputElement;
    await user.type(country, "United");

    const unitedKingdom = await screen.findByRole("option", {
      name: "United Kingdom",
    });
    await user.hover(unitedKingdom);
    expect(unitedKingdom.hasAttribute("data-highlighted")).toBe(true);
    expect(unitedKingdom.className).toContain("data-highlighted:bg-border");
  });

  it("filters countries by common abbreviations", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("tab", { name: "Contact info" }));

    const country = screen.getByLabelText("Country") as HTMLInputElement;
    await user.type(country, "USA");
    expect(
      await screen.findByRole("option", { name: "United States" }),
    ).toBeTruthy();
    expect(screen.queryByRole("option", { name: "United Kingdom" })).toBeNull();

    await user.clear(country);
    await user.type(country, "UK");
    expect(
      await screen.findByRole("option", { name: "United Kingdom" }),
    ).toBeTruthy();
    expect(screen.queryByRole("option", { name: "United States" })).toBeNull();
  });

  it("filters and selects countries with the shared combobox", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("tab", { name: "Contact info" }));

    const country = screen.getByLabelText("Country") as HTMLInputElement;
    expect(country.tagName).toBe("INPUT");
    await user.type(country, "united kin");

    expect(screen.queryByText("United States")).toBeNull();
    await user.click(
      await screen.findByRole("option", { name: "United Kingdom" }),
    );

    expect(country.value).toBe("United Kingdom");
    expect(saveButton().disabled).toBe(false);

    const region = screen.getByLabelText("State / region") as HTMLInputElement;
    expect(region.tagName).toBe("INPUT");
    await user.type(region, "esse");
    await user.click(await screen.findByRole("option", { name: "Essex" }));
    expect(region.value).toBe("Essex");

    await user.click(saveButton());
    expect(
      JSON.parse(localStorage.getItem(organizationProfileKey)!),
    ).toMatchObject({ country: "United Kingdom", region: "Essex" });
  });

  it("saves both tabs, restores after remount, and cancels unsaved edits", async () => {
    const user = userEvent.setup();
    const view = mount();
    expect(saveButton().disabled).toBe(true);
    expect(cancelButton().disabled).toBe(true);
    await user.clear(nameInput());
    await user.type(nameInput(), "New organization");
    await user.click(screen.getByRole("tab", { name: "Contact info" }));
    await user.type(screen.getByLabelText("Public email"), "hello@example.com");
    await user.click(saveButton());
    expect(
      JSON.parse(localStorage.getItem(organizationProfileKey)!),
    ).toMatchObject({
      name: "New organization",
      publicEmail: "hello@example.com",
    });
    expect(saveButton().disabled).toBe(true);
    expect(cancelButton().disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Changes saved.");
    view.unmount();
    mount();
    expect(nameInput().value).toBe("New organization");
    await user.type(nameInput(), " draft");
    await user.click(screen.getByRole("tab", { name: "Contact info" }));
    const email = screen.getByLabelText("Public email") as HTMLInputElement;
    expect(email.value).toBe("hello@example.com");
    await user.clear(email);
    await user.type(email, "draft@example.com");
    await user.click(cancelButton());
    expect(email.value).toBe("hello@example.com");
    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(nameInput().value).toBe("New organization");
  });

  it("updates a pristine form when another tab saves", () => {
    mount();
    externalSave("Other tab");
    expect(nameInput().value).toBe("Other tab");
    expect(saveButton().disabled).toBe(true);
    expect(cancelButton().disabled).toBe(true);
  });

  it("preserves pending edits and blocks stale saves until Cancel loads the latest profile", async () => {
    const user = userEvent.setup();
    mount();
    await user.type(nameInput(), " local draft");
    externalSave("Other tab");
    expect(nameInput().value).toBe("Cupboard local draft");
    expect(screen.getByRole("alert").textContent).toContain(
      "changed in another tab",
    );
    expect(saveButton().disabled).toBe(true);
    await user.click(saveButton());
    expect(JSON.parse(localStorage.getItem(organizationProfileKey)!).name).toBe(
      "Other tab",
    );
    await user.click(cancelButton());
    expect(nameInput().value).toBe("Other tab");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it("keeps invalid edits out of storage and focuses the invalid field", async () => {
    const user = userEvent.setup();
    mount();
    await user.clear(nameInput());
    await user.click(saveButton());
    expect(screen.getByText("Enter an organization name.")).toBeTruthy();
    expect(document.activeElement).toBe(nameInput());
    expect(localStorage.getItem(organizationProfileKey)).toBeNull();
  });

  it("reports a storage failure without discarding the draft", async () => {
    const user = userEvent.setup();
    mount();
    await user.type(nameInput(), " draft");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    await user.click(saveButton());
    expect(screen.getByRole("alert").textContent).toContain("Could not save");
    expect(nameInput().value).toBe("Cupboard draft");
    expect(saveButton().disabled).toBe(false);
  });
});
