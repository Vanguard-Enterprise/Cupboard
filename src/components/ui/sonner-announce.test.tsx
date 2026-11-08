// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import { Toaster } from "./sonner";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

let width = 390;
const listeners = new Set<() => void>();
function stubScreen() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === "(max-width: 639px)"
        ? width < 640
        : query === "(min-width: 640px) and (max-width: 1279px)"
          ? width >= 640 && width < 1280
          : false;
    },
    media: query,
    addEventListener: (_: string, change: () => void) => listeners.add(change),
    removeEventListener: (_: string, change: () => void) =>
      listeners.delete(change),
  }));
}

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
  listeners.clear();
  vi.unstubAllGlobals();
});

// a11y D-R8-01: a toast that changed edges was remounted, so the live region
// gained the same message 2 to 4 times and screen readers said it again.
it("adds a toast to the live region once, whatever happens while it shows", async () => {
  width = 390;
  stubScreen();
  render(<Toaster />);
  const region = screen.getByRole("region", { name: /Notifications/ });
  const added: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes)
        if (node instanceof HTMLElement)
          for (const item of [
            ...(node.matches("[data-sonner-toast]") ? [node] : []),
            ...node.querySelectorAll("[data-sonner-toast]"),
          ])
            added.push(item.textContent ?? "");
  });
  observer.observe(region, { childList: true, subtree: true });

  act(() => {
    toast.error("Machine refresh failed.");
  });
  await waitFor(() =>
    expect(region.textContent).toContain("Machine refresh failed."),
  );
  // Focus moves, the page scrolls, and the screen crosses a breakpoint.
  const field = document.createElement("input");
  document.body.append(field);
  act(() => field.focus());
  window.dispatchEvent(new Event("scroll"));
  width = 1440;
  act(() => {
    for (const change of listeners) change();
  });
  await act(() => new Promise((done) => setTimeout(done, 400)));
  expect(region.textContent).toContain("Machine refresh failed.");

  observer.disconnect();
  expect(added).toHaveLength(1);
});
