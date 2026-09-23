import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getIdentity } from "@/lib/auth-server";
import Layout from "../layout";
import Page from "./page";

vi.mock("@/lib/auth-server", () => ({
  getIdentity: vi.fn(async () => ({
    user: { id: "account", name: "Real operator", email: "real@example.com" },
    organization: { id: "org", name: "Real organization" },
    organizations: [{ id: "org", name: "Real organization" }],
    membershipId: "member",
    permissions: ["organization.manage"],
  })),
}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn() }),
}));

describe("Workspace", () => {
  it("keeps accounts without memberships signed in without tenant content", async () => {
    vi.mocked(getIdentity).mockResolvedValueOnce({
      user: {
        id: "account",
        name: "Independent user",
        email: "user@example.com",
      },
      organization: null,
      organizations: [],
      membershipId: null,
      permissions: [],
    });
    vi.mocked(cookies).mockResolvedValue({ get: vi.fn() } as unknown as Awaited<
      ReturnType<typeof cookies>
    >);
    const html = renderToStaticMarkup(
      <TooltipProvider>
        {await Layout({ children: <p>Tenant content</p> })}
      </TooltipProvider>,
    );
    expect(html).toContain("Independent user");
    expect(html).toContain("Join code");
    expect(html).toContain("Join organization");
    expect(html).toContain("Create organization");
    expect(html).not.toContain("Tenant content");
    expect(html).toContain("Game servers");
    expect(html).toContain("No organization");
  });
  it.each([undefined, "true", "false", "invalid"])(
    "restores sidebar state from cookie %s without dashboard filler",
    async (value) => {
      vi.mocked(cookies).mockResolvedValue({
        get: vi
          .fn()
          .mockReturnValue(value === undefined ? undefined : { value }),
      } as unknown as Awaited<ReturnType<typeof cookies>>);
      const html = renderToStaticMarkup(
        <TooltipProvider>
          {await Layout({ children: <Page /> })}
        </TooltipProvider>,
      );
      expect(html).toContain("Game servers");
      expect(html).toContain("Real operator");
      expect(html).toContain("Real organization");
      expect(html).not.toContain("Demo operator");
      expect(html).toContain("Search organization");
      expect(html).toContain(
        `data-state="${value === "false" ? "collapsed" : "expanded"}"`,
      );
      expect(html).not.toContain("?section=");
      expect(html).not.toContain("Planned features");
      expect(html).not.toContain("proposed workspace");
      expect(Page()).toBeNull();
    },
  );
});
