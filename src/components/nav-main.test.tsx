// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NavMain } from "./nav-main";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { dashboardNavigation } from "@/lib/dashboard-navigation";

beforeAll(() => {
  window.matchMedia ??= vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(cleanup);

function mount(activeSection?: string, disabled = false) {
  render(
    <TooltipProvider>
      <SidebarProvider>
        <NavMain
          group={dashboardNavigation[0]}
          activeSection={activeSection}
          disabled={disabled}
        />
      </SidebarProvider>
    </TooltipProvider>,
  );
}

describe("Operations navigation", () => {
  it("links single-page areas directly instead of opening a dropdown", () => {
    mount("servers");
    const servers = screen.getByRole("link", { name: "Game servers" });
    expect(servers.getAttribute("href")).toBe("/dashboard/servers");
    expect(servers.getAttribute("aria-current")).toBe("page");
    expect(servers.getAttribute("aria-expanded")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Files" }).getAttribute("href"),
    ).toBe("/dashboard/files");
    // Observability has no page yet: one entry, shown but not a link.
    expect(screen.queryByRole("link", { name: "Observability" })).toBeNull();
    const observability = screen.getByRole("button", { name: "Observability" });
    expect(observability.getAttribute("aria-disabled")).toBe("true");
    expect(observability.getAttribute("aria-expanded")).toBeNull();
    // The removed entries are gone.
    for (const name of [
      "Server inventory",
      "Shared library",
      "Versions & access",
    ])
      expect(screen.queryByText(name)).toBeNull();
    // Areas with several pages keep their dropdown.
    const infrastructure = screen.getByRole("button", {
      name: "Infrastructure",
    });
    expect(infrastructure.getAttribute("aria-expanded")).toBe("false");
    expect(within(document.body).queryByText("Machines")).toBeNull();
  });

  it("links nothing without an organization", () => {
    mount(undefined, true);
    for (const name of ["Game servers", "Files"])
      expect(screen.queryByRole("link", { name })).toBeNull();
  });
});
