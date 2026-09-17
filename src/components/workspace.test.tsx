// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { usePathname } from "next/navigation";
import { Workspace } from "./workspace";
import { TooltipProvider } from "./ui/tooltip";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
  useRouter: () => ({ push: vi.fn() }),
}));
describe("workspace route ownership", () => {
  it.each([
    ["/dashboard/organization/settings/profile", "Profile"],
    ["/dashboard/organization/settings/usage", "Usage"],
    ["/dashboard/organization/integrations/connections", "Connections"],
    [
      "/dashboard/organization/integrations/credentials",
      "Credentials &amp; webhooks",
    ],
    ["/dashboard/organization/security/alerts", "Alerts"],
    ["/dashboard/organization/security/audit-log", "Audit log"],
    ["/dashboard/organization/security/access", "Access &amp; approvals"],
    [
      "/dashboard/organization/settings/notifications-data",
      "Notifications &amp; data",
    ],
  ])("renders organization breadcrumbs for %s", (pathname, label) => {
    vi.mocked(usePathname).mockReturnValue(pathname);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Workspace defaultOpen>{null}</Workspace>
      </TooltipProvider>,
    );
    expect(html).toContain('href="/dashboard"');
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(
      document.querySelector('[data-slot="breadcrumb-page"]')?.innerHTML,
    ).toBe(label);
    const activeLink = document.querySelector(
      'a[data-slot="sidebar-menu-sub-button"][data-active="true"]',
    );
    expect(activeLink?.getAttribute("href")).toBe(pathname);
    expect(activeLink?.getAttribute("aria-current")).toBe("page");
  });
  it.each([
    "/dashboard",
    "/unknown",
    "/dashboard/organization/settings/profile/",
    "/dashboard/organization/settings/profile/child",
  ])("keeps exact-path Dashboard fallback for %s", (pathname) => {
    vi.mocked(usePathname).mockReturnValue(pathname);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <Workspace defaultOpen>{null}</Workspace>
      </TooltipProvider>,
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(
      document.querySelector('[data-slot="breadcrumb-page"]')?.textContent,
    ).toBe("Dashboard");
    expect(
      document.querySelector(
        'a[data-slot="sidebar-menu-sub-button"][data-active="true"]',
      ),
    ).toBeNull();
    expect(html).not.toContain('href="/dashboard"');
  });
});
