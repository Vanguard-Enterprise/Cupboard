import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { TooltipProvider } from "@/components/ui/tooltip";
import Layout from "../layout";
import Page from "./page";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn() }),
}));

describe("Workspace", () => {
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
