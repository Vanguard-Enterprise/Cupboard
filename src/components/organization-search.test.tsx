// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { OrganizationSearch } from "./organization-search";
import { defaultOrganizationProfile } from "@/lib/organization-profile";
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("./organization-provider", () => ({
  useOrganization: () => ({ profile: defaultOrganizationProfile }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  push.mockReset();
});
it("finds server inventory and navigates from organization search", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const close = vi.fn();
  const user = userEvent.setup();
  render(<OrganizationSearch open={true} setOpen={close} />);
  await user.type(screen.getByRole("combobox"), "servers");
  await user.click(
    await screen.findByRole("option", { name: "Server inventory" }),
  );
  expect(push).toHaveBeenCalledWith("/dashboard/servers");
  expect(close).toHaveBeenCalledWith(false);
});
