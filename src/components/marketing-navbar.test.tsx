// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketingNavbar } from "./marketing-navbar";

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
afterEach(() => {
  cleanup();
  route.pathname = "/";
});

describe("marketing navbar", () => {
  it("dismisses the release announcement without removing navigation", async () => {
    const user = userEvent.setup();
    render(<MarketingNavbar />);
    expect(screen.getByText(/Cupboard 5 is here/)).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Dismiss announcement" }),
    );
    expect(screen.queryByText(/Cupboard 5 is here/)).toBeNull();
    expect(screen.getByRole("link", { name: "Cupboard home" })).toBeTruthy();
  });
  it("links account actions and opens product destinations by keyboard", async () => {
    const user = userEvent.setup();
    render(<MarketingNavbar />);
    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login");
    expect(
      screen.getByRole("link", { name: "Get started" }).getAttribute("href"),
    ).toBe("/signup");
    screen.getByRole("button", { name: "Product" }).focus();
    await user.keyboard("{Enter}");
    expect(
      screen
        .getByRole("link", { name: /Server management/ })
        .getAttribute("href"),
    ).toBe("/#servers");
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("link", { name: /Server management/ }),
    ).toBeNull();
  });
  it("uses a logo-only home link and keyboard-accessible documentation topics", async () => {
    const user = userEvent.setup();
    const { container } = render(<MarketingNavbar />);
    expect(
      screen.getByRole("link", { name: "Cupboard home" }).textContent,
    ).toBe("");
    expect(container.innerHTML).not.toMatch(/github|open source/i);
    screen.getByRole("button", { name: "Docs" }).focus();
    await user.keyboard("{Enter}");
    expect(
      screen
        .getByRole("link", { name: /Identity providers/ })
        .getAttribute("href"),
    ).toBe("/#docs-identity-providers");
    expect(screen.getByRole("link", { name: /Integrations/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /User management/ })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("link", { name: /Identity providers/ }),
    ).toBeNull();
  });
  it("opens and dismisses the mobile menu with restored focus", async () => {
    const user = userEvent.setup();
    render(<MarketingNavbar />);
    const menu = screen.getByRole("button", { name: "Menu" });
    await user.click(menu);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.getByRole("navigation", { name: "Mobile marketing" }),
    ).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(menu);
  });
  it.each(["/dashboard", "/dashboard/servers"])(
    "keeps the workspace shell separate at %s",
    (pathname) => {
      route.pathname = pathname;
      const { container } = render(<MarketingNavbar />);
      expect(container.innerHTML).toBe("");
    },
  );
  it.each(["/join", "/login", "/signup"])(
    "hides navigation at %s",
    (pathname) => {
      route.pathname = pathname;
      const { container } = render(<MarketingNavbar />);
      expect(container.innerHTML).toBe("");
    },
  );
});
