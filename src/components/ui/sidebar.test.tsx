import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SidebarMenuSkeleton } from "./sidebar";

describe("SidebarMenuSkeleton", () => {
  it("renders hydration-stable markup", () => {
    const render = () => renderToStaticMarkup(<SidebarMenuSkeleton />);

    expect(render()).toBe(render());
    expect(render()).toContain("--skeleton-width:70%");
  });
});
