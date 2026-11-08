// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StatusNotFound from "./[slug]/not-found";
import { generateMetadata } from "./[slug]/page";
import { StatusUnavailable } from "./status-unavailable";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  notFound: vi.fn(),
}));
vi.mock("@/components/status-fonts", () => ({ statusFontFamily: {} }));
vi.mock("@/lib/api-proxy", () => ({
  backendUrl: (path: string) => `http://backend/${path}`,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
  vi.useRealTimers();
});

describe("Status page fallbacks", () => {
  it("explains a missing or unpublished page the same way, in the page shell", () => {
    const { container } = render(<StatusNotFound />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "This status page isn't available",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("main").textContent).toMatch(/isn't public yet/);
    // The footer rule runs across the window, with its line centered.
    const footer = screen.getByRole("contentinfo");
    expect(footer.className).toContain("border-t");
    expect(footer.firstElementChild!.className).toContain("justify-center");
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("theme-system");
    expect(root.hasAttribute("data-status-page")).toBe(true);
    // It starts with the accent bar, like every status page; the page's own
    // accent is unknown, so it is Cupboard's.
    const bar = root.firstElementChild as HTMLElement;
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    expect(bar.className).toContain("h-1");
    expect(bar.className).toContain("bg-primary");
    // One footer line, its link's touch box reaching into the padding.
    expect(
      within(footer).getByRole("link", { name: "Cupboard" }).className,
    ).toContain("[@media(any-pointer:coarse)]:-my-3");
  });

  it("retries a failed load on request and every minute", async () => {
    vi.useFakeTimers();
    const reset = vi.fn();
    render(<StatusUnavailable reset={reset} />);
    expect(
      screen.getByRole("heading", { name: "Status can't be shown right now" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("offers Go back only when a page linked here", () => {
    render(<StatusNotFound />);
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    cleanup();
    Object.defineProperty(document, "referrer", {
      value: "https://discord.com/channels/1",
      configurable: true,
    });
    window.history.pushState({}, "", "/status/missing");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    render(<StatusNotFound />);
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(back).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "referrer", {
      value: "",
      configurable: true,
    });
  });

  it("puts the state in the first tab title, from the server data", async () => {
    const now = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          name: "Northstar",
          updatedAt: now,
          components: [
            {
              id: "a",
              name: "EU",
              groupName: "",
              health: "down",
              observedAt: now,
            },
          ],
          maintenance: [],
        }),
      ),
    );
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "northstar" }),
    });
    expect(metadata.title).toBe("Unavailable | Northstar | Status");
  });
});
