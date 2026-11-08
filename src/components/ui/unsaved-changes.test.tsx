// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UnsavedChangesProvider,
  useGuardedNavigation,
  useUnsavedChanges,
} from "./unsaved-changes";

const { push, replace } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/dashboard/infrastructure/maintenance",
}));

beforeEach(() => {
  window.history.replaceState(
    null,
    "",
    "/dashboard/infrastructure/maintenance",
  );
});
afterEach(() => {
  cleanup();
  push.mockReset();
  replace.mockReset();
});

function Editor({ dirty, changes }: { dirty: boolean; changes?: string }) {
  useUnsavedChanges(dirty, { changes });
  return <input aria-label="Footer text" />;
}

function Leaver({ onAction }: { onAction?: () => void }) {
  const { push: go, confirmLeave } = useGuardedNavigation();
  return (
    <>
      <button type="button" onClick={() => go("/dashboard/machines")}>
        Machines
      </button>
      <button type="button" onClick={() => confirmLeave(() => onAction?.())}>
        Sign out
      </button>
      <a href="/dashboard">Dashboard</a>
      <a href="/dashboard/infrastructure/maintenance">Same page</a>
      <a href="https://example.com/">Elsewhere</a>
    </>
  );
}

function renderGuarded(dirty: boolean, onAction?: () => void) {
  return render(
    <UnsavedChangesProvider>
      <Editor dirty={dirty} changes="Footer text and logo." />
      <Leaver onAction={onAction} />
    </UnsavedChangesProvider>,
  );
}

const prompt = () => screen.queryByRole("alertdialog");

describe("unsaved changes guard", () => {
  it("navigates at once when nothing is unsaved", async () => {
    const user = userEvent.setup();
    renderGuarded(false);
    await user.click(screen.getByRole("button", { name: "Machines" }));
    expect(push).toHaveBeenCalledWith("/dashboard/machines");
    expect(prompt()).toBeNull();
  });

  it("asks before programmatic navigation and stays on Keep editing", async () => {
    const user = userEvent.setup();
    renderGuarded(true);
    await user.click(screen.getByRole("button", { name: "Machines" }));
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    const dialog = prompt()!;
    expect(dialog.textContent).toContain("Leave without saving?");
    expect(dialog.textContent).toContain("You have unsaved changes.");
    expect(dialog.textContent).toContain("Footer text and logo.");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(prompt()).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("leaves after Discard and leave, replacing its own Back entry", async () => {
    const user = userEvent.setup();
    renderGuarded(true);
    // While dirty the page sits on an extra history entry for Back.
    expect(window.history.state?.cupboardUnsavedGuard).toBe(true);
    await user.click(screen.getByRole("button", { name: "Machines" }));
    await user.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(replace).toHaveBeenCalledWith("/dashboard/machines");
    expect(push).not.toHaveBeenCalled();
  });

  it("asks before following an in-app link, but not same-page or outside links", async () => {
    const user = userEvent.setup();
    renderGuarded(true);
    const outside = vi.fn((event: MouseEvent) => event.preventDefault());
    document.addEventListener("click", outside);
    await user.click(screen.getByRole("link", { name: "Same page" }));
    expect(prompt()).toBeNull();
    await user.click(screen.getByRole("link", { name: "Elsewhere" }));
    expect(prompt()).toBeNull();
    await user.click(screen.getByRole("link", { name: "Dashboard" }));
    expect(prompt()).not.toBeNull();
    // The link's own navigation never ran.
    expect(outside).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(replace).toHaveBeenCalledWith("/dashboard");
    document.removeEventListener("click", outside);
  });

  it("runs a leaving action such as signing out only after confirmation", async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    renderGuarded(true, action);
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(action).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("asks on the browser's Back and restores the Back entry on Keep editing", async () => {
    const user = userEvent.setup();
    renderGuarded(true);
    // Back lands on the page's own entry (no guard flag).
    act(() => {
      window.history.replaceState(null, "", window.location.href);
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(prompt()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(window.history.state?.cupboardUnsavedGuard).toBe(true);
  });

  // Round 9: after Save, taking the extra Back entry off let the browser
  // restore that entry's scroll position, throwing the operator 100 to 140
  // pixels away from the field they had just saved, under the save bar.
  it("takes its Back entry off after a save without moving the page", async () => {
    const { rerender } = renderGuarded(true);
    expect(window.history.state?.cupboardUnsavedGuard).toBe(true);
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    vi.stubGlobal("scrollY", 1232);
    rerender(
      <UnsavedChangesProvider>
        <Editor dirty={false} />
        <Leaver />
      </UnsavedChangesProvider>,
    );
    expect(back).toHaveBeenCalledTimes(1);
    // The browser restores where the page was when the first edit was made.
    vi.stubGlobal("scrollY", 1099);
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 1232));
    back.mockRestore();
    vi.unstubAllGlobals();
  });

  it("blocks closing the tab only while there are edits", () => {
    const { rerender } = renderGuarded(true);
    const dirtyEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
    rerender(
      <UnsavedChangesProvider>
        <Editor dirty={false} />
        <Leaver />
      </UnsavedChangesProvider>,
    );
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });

  it("navigates directly without a provider", async () => {
    const user = userEvent.setup();
    render(<Leaver />);
    await user.click(screen.getByRole("button", { name: "Machines" }));
    expect(push).toHaveBeenCalledWith("/dashboard/machines");
  });
});

describe("unsaved changes guard from a menu", () => {
  it("returns focus to the menu's button after Keep editing", async () => {
    const {
      DropdownMenu,
      DropdownMenuContent,
      DropdownMenuItem,
      DropdownMenuTrigger,
    } = await import("./dropdown-menu");
    function Account() {
      const { confirmLeave } = useGuardedNavigation();
      return (
        <DropdownMenu>
          <DropdownMenuTrigger>Account</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => confirmLeave(() => {})}>
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }
    const user = userEvent.setup();
    render(
      <UnsavedChangesProvider>
        <Editor dirty={true} />
        <Account />
      </UnsavedChangesProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Account" }));
    await user.click(await screen.findByRole("menuitem", { name: "Log out" }));
    expect(prompt()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Account" }),
      ),
    );
  });
});
