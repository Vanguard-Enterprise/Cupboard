// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrganizationSearch } from "./organization-search";
import {
  UnsavedChangesProvider,
  useUnsavedChanges,
} from "@/components/ui/unsaved-changes";
import { defaultOrganizationProfile } from "@/lib/organization-profile";
const { push, replace } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/dashboard/infrastructure/maintenance",
}));
vi.mock("./organization-provider", () => ({
  useOrganization: () => ({ profile: defaultOrganizationProfile }),
}));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  push.mockReset();
  replace.mockReset();
});
it("finds server inventory and navigates from organization search", async () => {
  const close = vi.fn();
  const user = userEvent.setup();
  render(<OrganizationSearch open={true} setOpen={close} />);
  await user.type(screen.getByRole("combobox"), "servers");
  await user.click(await screen.findByRole("option", { name: "Game servers" }));
  expect(push).toHaveBeenCalledWith("/dashboard/servers");
  expect(close).toHaveBeenCalledWith(false);
});

function DirtyPage() {
  useUnsavedChanges(true, { changes: ["Footer text"] });
  return <input aria-label="Footer text" />;
}

function Shell() {
  const [open, setOpen] = useState(false);
  return (
    <UnsavedChangesProvider>
      <DirtyPage />
      <OrganizationSearch open={open} setOpen={setOpen} />
    </UnsavedChangesProvider>
  );
}

it("asks before Ctrl+K navigation drops unsaved edits", async () => {
  const user = userEvent.setup();
  render(<Shell />);
  await user.click(screen.getByRole("textbox", { name: "Footer text" }));
  await user.keyboard("{Control>}k{/Control}");
  await user.type(screen.getByRole("combobox"), "machines");
  await user.click(await screen.findByRole("option", { name: "Machines" }));
  const prompt = await screen.findByRole("alertdialog");
  expect(prompt.textContent).toContain("Leave without saving?");
  expect(prompt.textContent).toContain("Your change:Footer text");
  expect(push).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(push).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
  // Focus goes back to the field the operator was editing.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Footer text" }),
    ),
  );

  await user.keyboard("{Control>}k{/Control}");
  await user.type(screen.getByRole("combobox"), "machines");
  await user.click(await screen.findByRole("option", { name: "Machines" }));
  await user.click(await screen.findByRole("button", { name: "Confirm" }));
  expect(replace).toHaveBeenCalledWith("/dashboard/infrastructure/machines");
});

it("leaves Ctrl+K alone while a confirmation or other dialog is open", async () => {
  const user = userEvent.setup();
  render(<Shell />);
  await user.click(screen.getByRole("textbox", { name: "Footer text" }));
  await user.keyboard("{Control>}k{/Control}");
  await user.type(screen.getByRole("combobox"), "machines");
  await user.click(await screen.findByRole("option", { name: "Machines" }));
  const prompt = await screen.findByRole("alertdialog");
  const keep = screen.getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(keep));

  // The prompt owns focus: the shortcut neither opens the search over it
  // nor moves focus out of it.
  await user.keyboard("{Control>}k{/Control}");
  expect(
    screen.queryByRole("dialog", { name: "Search organization" }),
  ).toBeNull();
  expect(prompt.isConnected).toBe(true);
  expect(document.activeElement).toBe(keep);

  // Once the prompt is answered, Ctrl+K works again.
  await user.click(keep);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await user.keyboard("{Control>}k{/Control}");
  expect(
    await screen.findByRole("dialog", { name: "Search organization" }),
  ).toBeTruthy();
  // And it still closes itself.
  await user.keyboard("{Control>}k{/Control}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Search organization" }),
    ).toBeNull(),
  );
});
