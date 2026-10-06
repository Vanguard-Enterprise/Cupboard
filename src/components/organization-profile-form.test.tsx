// @vitest-environment jsdom
import { render, testPreviewKey } from "@/test/preview-storage";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
import { OrganizationProfileForm } from "./organization-profile-form";
import { OrganizationProvider } from "./organization-provider";
import { TooltipProvider } from "./ui/tooltip";
import {
  defaultOrganizationProfile,
  organizationProfileKey as organizationProfileKeyBase,
} from "@/lib/organization-profile";

async function mount() {
  const view = render(
    <OrganizationProvider>
      <TooltipProvider>
        <OrganizationProfileForm organizationId="test-organization" canManage />
      </TooltipProvider>
    </OrganizationProvider>,
  );
  await waitFor(() =>
    expect(screen.queryByText("Preparing logo...")).toBeNull(),
  );
  return view;
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
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(async () => Response.json({ id: null, revision: 0 })),
  );
  vi.stubGlobal("URL", URL);
  URL.createObjectURL = vi.fn(() => "blob:test-logo");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Organization profile persistence", () => {
  it("does not offer manual logo URLs", async () => {
    await mount();
    expect(screen.queryByLabelText("Organization logo URL")).toBeNull();
  });

  it("navigates filtered countries by keyboard", async () => {
    const user = userEvent.setup();
    await mount();

    const country = screen.getByLabelText("Country") as HTMLInputElement;
    await user.type(country, "United");
    await screen.findByRole("option", { name: "United Kingdom" });
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(country.value).toBe("United Kingdom");
  });

  it("highlights hovered country options", async () => {
    const user = userEvent.setup();
    await mount();

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
    await mount();

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
    await mount();

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
    await mount();

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
    await mount();

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
    const view = await mount();
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
    expect(toast.success).toHaveBeenCalledWith("Changes saved.");
    expect(screen.queryByText("Changes saved.")).toBeNull();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    view.unmount();
    await mount();
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

  it("updates a pristine form when another tab saves", async () => {
    await mount();
    externalSave("Other tab");
    expect(nameInput().value).toBe("Other tab");
    expect(saveButton().disabled).toBe(true);
    expect(cancelButton().disabled).toBe(true);
  });

  it("preserves pending edits and blocks stale saves until Cancel loads the latest profile", async () => {
    const user = userEvent.setup();
    await mount();
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
    await mount();
    await user.clear(nameInput());
    await user.click(saveButton());
    expect(screen.getByText("Enter an organization name.")).toBeTruthy();
    expect(document.activeElement).toBe(nameInput());
    expect(localStorage.getItem(organizationProfileKey)).toBeNull();
  });

  it("focuses errors in visual order when multiple fields are invalid", async () => {
    const user = userEvent.setup();
    await mount();
    const website = screen.getByLabelText("Website");
    await user.type(website, "invalid");
    await user.clear(nameInput());
    await user.click(saveButton());
    expect(document.activeElement).toBe(nameInput());
    await user.type(nameInput(), "Valid name");
    await user.click(saveButton());
    expect(document.activeElement).toBe(website);
  });

  it("reports a storage failure without discarding the draft", async () => {
    const user = userEvent.setup();
    await mount();
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

describe("Shared organization logo uploads", () => {
  it("previews and cancels without uploading, then saves only on Save changes", async () => {
    const user = userEvent.setup();
    const fetcher = vi.mocked(fetch);
    fetcher.mockImplementation(async (url, options) => {
      if (String(url).endsWith("/preview"))
        return new Response(new Blob(["png"], { type: "image/png" }));
      if (options?.method === "POST")
        return Response.json({ id: "saved-logo", revision: 1 });
      if (String(url).endsWith("/saved-logo"))
        return new Response(new Blob(["png"], { type: "image/png" }));
      return Response.json({ id: null, revision: 0 });
    });
    await mount();
    await screen.findByRole("button", { name: "Select logo" });
    const file = new File(["image"], "logo.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Upload organization logo"), file);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(URL.createObjectURL).not.toHaveBeenCalledWith(file);
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false);
    expect(
      fetcher.mock.calls.filter(
        ([url, options]) =>
          url === "/app-api/organization-logo" && options?.method === "POST",
      ),
    ).toHaveLength(0);
    await user.click(cancelButton());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-logo");
    expect(
      fetcher.mock.calls.filter(
        ([url, options]) =>
          url === "/app-api/organization-logo" && options?.method === "POST",
      ),
    ).toHaveLength(0);
    await user.upload(screen.getByLabelText("Upload organization logo"), file);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    await user.click(saveButton());
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Changes saved."),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/app-api/organization-logo",
      expect.objectContaining({
        method: "POST",
        body: file,
        headers: expect.objectContaining({
          "X-Cupboard-Organization": "test-organization",
          "X-Cupboard-Logo-Revision": "0",
        }),
      }),
    );
    expect(localStorage.getItem(organizationProfileKey)).not.toContain("blob:");
    expect(screen.getByRole("button", { name: "Replace logo" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove logo" }));
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/remove")),
    ).toHaveLength(0);
    await user.click(cancelButton());
  });
  it("keeps a failed upload draft and permits retry", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockImplementation(async (url, options) =>
      String(url).endsWith("/preview")
        ? new Response(new Blob(["png"], { type: "image/png" }))
        : options?.method === "POST"
          ? Response.json(
              { error: "Logo storage is unavailable." },
              { status: 400 },
            )
          : Response.json({ id: null, revision: 0 }),
    );
    await mount();
    await user.upload(
      screen.getByLabelText("Upload organization logo"),
      new File(["bad"], "large.png", { type: "image/png" }),
    );
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    await user.click(saveButton());
    expect(
      (await screen.findAllByText("Logo storage is unavailable.")).length,
    ).toBeGreaterThan(0);
    expect(saveButton().disabled).toBe(false);
    expect(localStorage.getItem(organizationProfileKey)).toBeNull();
  });
  it.each([0, 2 * 1024 * 1024 + 1])(
    "discards the prior draft when rejecting a %i-byte file",
    async (size) => {
      const user = userEvent.setup();
      vi.mocked(fetch).mockImplementation(async (url) =>
        String(url).endsWith("/preview")
          ? new Response(new Blob(["png"], { type: "image/png" }))
          : Response.json({ id: null, revision: 0 }),
      );
      await mount();
      const input = screen.getByLabelText("Upload organization logo");
      await user.upload(
        input,
        new File(["image"], "valid.png", { type: "image/png" }),
      );
      await waitFor(() => expect(saveButton().disabled).toBe(false));
      await user.upload(
        input,
        new File([new Uint8Array(size)], "invalid.png", { type: "image/png" }),
      );
      expect(
        await screen.findByText("Choose an image no larger than 2 MiB."),
      ).toBeTruthy();
      await waitFor(() => expect(saveButton().disabled).toBe(true));
      expect(screen.getByRole("button", { name: "Select logo" })).toBeTruthy();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-logo");
      await user.click(saveButton());
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([url, options]) =>
              url === "/app-api/organization-logo" &&
              options?.method === "POST",
          ),
      ).toHaveLength(0);
    },
  );
  it("rejects oversized files locally and disables uploads for members without management permission", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const view = await mount();
    await user.upload(
      screen.getByLabelText("Upload organization logo"),
      new File([new Uint8Array(2 * 1024 * 1024 + 1)], "logo.png", {
        type: "image/png",
      }),
    );
    expect(
      await screen.findByText("Choose an image no larger than 2 MiB."),
    ).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    view.unmount();
    render(
      <OrganizationProvider>
        <OrganizationProfileForm
          organizationId="test-organization"
          canManage={false}
        />
      </OrganizationProvider>,
    );
    expect(
      (screen.getByRole("button", { name: "Select logo" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it("can retry loading after a storage error", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Storage unavailable"));
    await mount();
    await user.click(
      await screen.findByRole("button", { name: "Reload logo" }),
    );
    expect(
      (screen.getByRole("button", { name: "Select logo" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

it("never renders an original SVG and blocks save when server conversion rejects it", async () => {
  const user = userEvent.setup();
  vi.mocked(fetch).mockImplementation(async (url) =>
    String(url).endsWith("/preview")
      ? Response.json(
          { error: "Use a self-contained SVG with outlined text." },
          { status: 400 },
        )
      : Response.json({ id: null, revision: 0 }),
  );
  await mount();
  const file = new File(
    ["<svg><script>alert(1)</script></svg>"],
    "unsafe.svg",
    { type: "image/svg+xml" },
  );
  await user.upload(screen.getByLabelText("Upload organization logo"), file);
  expect(
    await screen.findByText("Use a self-contained SVG with outlined text."),
  ).toBeTruthy();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(saveButton().disabled).toBe(true);
  await user.click(cancelButton());
  expect(
    screen.queryByText("Use a self-contained SVG with outlined text."),
  ).toBeNull();
});
