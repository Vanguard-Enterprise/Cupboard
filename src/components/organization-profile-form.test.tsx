// @vitest-environment jsdom
import { render, testPreviewKey } from "@/test/preview-storage";
import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationProfileForm } from "./organization-profile-form";
import { OrganizationProvider } from "./organization-provider";
import { TooltipProvider } from "./ui/tooltip";
import {
  defaultOrganizationProfile,
  organizationProfileKey as organizationProfileKeyBase,
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

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Organization profile persistence", () => {
  it("loads logo previews only after leaving the URL field", async () => {
    const requests = vi
      .spyOn(HTMLImageElement.prototype, "src", "set")
      .mockImplementation(() => {});
    const user = userEvent.setup();
    mount();
    const input = screen.getByLabelText("Organization logo URL");
    await user.type(input, "https://example.com/logo.png");
    expect(requests).not.toHaveBeenCalled();
    await user.tab();
    expect(requests.mock.calls).toEqual([["https://example.com/logo.png"]]);
    await user.click(input);
    await user.type(input, "?version=2");
    expect(requests).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(requests.mock.calls).toEqual([
      ["https://example.com/logo.png"],
      ["https://example.com/logo.png?version=2"],
    ]);
  });

  it("saves a logo URL, restores it, and cancels or saves removal", async () => {
    const user = userEvent.setup();
    const view = mount();
    const logoInput = () =>
      screen.getByLabelText("Organization logo URL") as HTMLInputElement;
    await user.type(logoInput(), "https://example.com/logo.png");
    await user.click(saveButton());
    expect(
      JSON.parse(localStorage.getItem(organizationProfileKey)!),
    ).toHaveProperty("logoUrl", "https://example.com/logo.png");
    view.unmount();
    mount();
    expect(logoInput().value).toBe("https://example.com/logo.png");
    await user.click(screen.getByRole("button", { name: "Remove logo" }));
    expect(logoInput().value).toBe("");
    await user.click(cancelButton());
    expect(logoInput().value).toBe("https://example.com/logo.png");
    await user.click(screen.getByRole("button", { name: "Remove logo" }));
    await user.click(saveButton());
    expect(
      JSON.parse(localStorage.getItem(organizationProfileKey)!),
    ).toHaveProperty("logoUrl", "");
  });

  it("rejects credential-bearing logo URLs without rendering or saving them", async () => {
    const requests = vi
      .spyOn(HTMLImageElement.prototype, "src", "set")
      .mockImplementation(() => {});
    const user = userEvent.setup();
    mount();
    const input = screen.getByLabelText("Organization logo URL");
    await user.type(input, "https://user:password@example.com/logo.png");
    await user.click(saveButton());
    expect(screen.getByText(/Enter an https:\/\/ image URL/)).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("img", { name: "Organization logo" })).toBeNull();
    expect(localStorage.getItem(organizationProfileKey)).toBeNull();
    expect(requests).not.toHaveBeenCalled();
  });

  it("navigates filtered countries by keyboard", async () => {
    const user = userEvent.setup();
    mount();

    const country = screen.getByLabelText("Country") as HTMLInputElement;
    await user.type(country, "United");
    await screen.findByRole("option", { name: "United Kingdom" });
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(country.value).toBe("United Kingdom");
  });

  it("highlights hovered country options", async () => {
    const user = userEvent.setup();
    mount();

    const country = screen.getByLabelText("Country") as HTMLInputElement;
    await user.type(country, "United");

    const unitedKingdom = await screen.findByRole("option", {
      name: "United Kingdom",
    });
    await user.hover(unitedKingdom);
    expect(unitedKingdom.hasAttribute("data-highlighted")).toBe(true);
    expect(unitedKingdom.className).toContain("min-h-11");
    expect(unitedKingdom.className).toContain("data-highlighted:bg-border");
  });

  it("sizes combobox controls for coarse pointers", async () => {
    const user = userEvent.setup();
    mount();

    const country = screen.getByLabelText("Country") as HTMLInputElement;
    const inputGroup = country.closest('[data-slot="input-group"]')!;
    const inputAddon = inputGroup.querySelector(
      '[data-slot="input-group-addon"]',
    )!;
    const trigger = inputGroup.querySelector('[aria-label="Show options"]')!;

    expect(inputGroup.className).toContain(
      "[@media(any-pointer:coarse)]:min-h-12",
    );
    expect(inputAddon.className).toContain("[@media(any-pointer:coarse)]:py-0");
    expect(trigger.className).toContain("[@media(any-pointer:coarse)]:size-11");

    await user.type(country, "USA");
    await user.click(
      await screen.findByRole("option", { name: "United States" }),
    );
    const clear = inputGroup.querySelector('[aria-label="Clear selection"]')!;
    expect(clear.className).toContain("[@media(any-pointer:coarse)]:size-11");
  });

  it("filters countries by common abbreviations", async () => {
    const user = userEvent.setup();
    mount();

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

  it("keeps accent and punctuation insensitive country search", async () => {
    const user = userEvent.setup();
    mount();

    const country = screen.getByLabelText("Country") as HTMLInputElement;
    const searches = [
      ["Curacao", "Curaçao"],
      ["Reunion", "Réunion"],
      ["Cote", "Côte d'Ivoire, Republic of"],
      ["Timor Leste", "Timor-Leste"],
    ];

    for (const [query, result] of searches) {
      await user.clear(country);
      await user.type(country, query);
      expect(await screen.findByRole("option", { name: result })).toBeTruthy();
    }
  });

  it("filters and selects countries with the shared combobox", async () => {
    const user = userEvent.setup();
    mount();

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

  it("saves all sections, restores after remount, and cancels unsaved edits", async () => {
    const user = userEvent.setup();
    const view = mount();
    expect(saveButton().disabled).toBe(true);
    expect(cancelButton().disabled).toBe(true);
    await user.clear(nameInput());
    await user.type(nameInput(), "New organization");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
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
    expect(screen.getByRole("status").textContent).toContain("Changes saved.");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    view.unmount();
    mount();
    expect(nameInput().value).toBe("New organization");
    await user.type(nameInput(), " draft");
    const email = screen.getByLabelText("Public email") as HTMLInputElement;
    expect(email.value).toBe("hello@example.com");
    await user.clear(email);
    await user.type(email, "draft@example.com");
    await user.click(cancelButton());
    expect(email.value).toBe("hello@example.com");
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

  it("focuses errors in visual order when multiple fields are invalid", async () => {
    const user = userEvent.setup();
    mount();
    const logo = screen.getByLabelText("Organization logo URL");
    await user.type(logo, "invalid");
    await user.clear(nameInput());
    await user.click(saveButton());
    expect(document.activeElement).toBe(logo);
    expect(screen.getByText("Enter an organization name.")).toBeTruthy();
    expect(localStorage.getItem(organizationProfileKey)).toBeNull();
    await user.clear(logo);
    await user.click(saveButton());
    expect(document.activeElement).toBe(nameInput());
  });

  it("reports a storage failure without discarding the draft", async () => {
    const user = userEvent.setup();
    mount();
    await user.type(nameInput(), " draft");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    await user.click(saveButton());
    const storageAlert = screen.getByRole("alert");
    expect(storageAlert.getAttribute("data-slot")).toBe("alert");
    expect(storageAlert.textContent).toContain("Could not save");
    expect(screen.queryByRole("status")).toBeNull();
    expect(nameInput().value).toBe("Cupboard draft");
    expect(saveButton().disabled).toBe(false);
  });
});

const organizationProfileKey = testPreviewKey(organizationProfileKeyBase);
