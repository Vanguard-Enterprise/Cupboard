// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketingLanding } from "./marketing-landing";

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("marketing landing page", () => {
  it("keeps the headline static when reduced motion is requested", () => {
    const subscribe = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: subscribe,
        removeEventListener: vi.fn(),
      })),
    );
    render(<MarketingLanding />);
    expect(subscribe).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Life's too short to babysit your servers.",
    );
  });
  it("resolves scrambled glyphs and cancels pending work on unmount", () => {
    let tick: FrameRequestCallback = () => {};
    const request = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        tick = callback;
        return 42;
      });
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const { unmount } = render(<MarketingLanding />);
    act(() => tick(0));
    expect(
      screen.getByRole("heading", { level: 1 }).getAttribute("aria-label"),
    ).toBe("Life's too short to babysit your servers.");
    act(() => tick(1500));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Life's too short to babysit your servers.",
    );
    unmount();
    expect(cancel).toHaveBeenCalledWith(42);
    request.mockRestore();
    cancel.mockRestore();
  });
  it("links the requested community logos without customer claims", () => {
    render(<MarketingLanding />);
    for (const [name, href] of [
      ["Vital", "https://vitalrust.com/"],
      ["Wicked", "https://wickedrust.net/"],
      ["Vitality", "https://vitalityrust.com/"],
      ["Atlas", "https://atlasrust.com/"],
      ["Physgun", "https://physgun.com/"],
      ["GameServerKings", "https://www.gameserverkings.com/"],
    ])
      expect(screen.getByRole("link", { name }).getAttribute("href")).toBe(
        href,
      );
    expect(
      screen.queryByText(/trusted by|our customers|our partners/i),
    ).toBeNull();
  });
  it("offers signup without reading account or organization data", () => {
    const { container } = render(<MarketingLanding />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "babysit your servers",
    );
    expect(
      screen
        .getAllByRole("link", { name: /Get started/ })[0]
        .getAttribute("href"),
    ).toBe("/signup");
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(container.innerHTML).not.toMatch(/github|DoorDash|Giga|90%|SOC 2/);
    for (const id of [
      "overview",
      "servers",
      "machines",
      "files",
      "team",
      "faq",
      "pricing",
    ])
      expect(container.querySelector(`#${id}`)).toBeTruthy();
  });
  it("changes setup steps and product panels using the keyboard", async () => {
    const user = userEvent.setup();
    render(<MarketingLanding />);
    screen.getByRole("button", { name: /Connect your Rust server/ }).focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("heading", { name: "Connect with confidence." }),
    ).toBeTruthy();
    screen.getByRole("tab", { name: "Servers" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(
      screen
        .getByRole("tab", { name: "Machines" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("heading", { name: "Look beneath the game." }),
    ).toBeTruthy();
    await user.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("heading", { name: "A place for the files." }),
    ).toBeTruthy();
  });
  it("opens and closes FAQ answers using keyboard controls", async () => {
    const user = userEvent.setup();
    render(<MarketingLanding />);
    const trigger = screen.getByRole("button", {
      name: "Does Cupboard host my game servers?",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByText(/Your servers stay on your infrastructure/),
    ).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(
      screen.queryByText(/Your servers stay on your infrastructure/),
    ).toBeNull();
  });
});
