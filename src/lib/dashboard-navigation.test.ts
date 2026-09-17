import { implementedPages } from "@/lib/implemented-pages";
import { describe, expect, it } from "vitest";
import { navigationHref } from "./dashboard-navigation";

describe("dashboard navigation", () => {
  it("links implemented organization pages and leaves planned pages disabled", () => {
    expect(navigationHref("connections")).toBe(
      implementedPages["connections"].href,
    );
    expect(navigationHref("organization")).toBe(
      implementedPages["organization"].href,
    );
    expect(navigationHref("billing")).toBe(implementedPages["billing"].href);
    expect(navigationHref("credentials")).toBe(
      implementedPages["credentials"].href,
    );
    expect(navigationHref("access")).toBe(implementedPages["access"].href);
    expect(navigationHref("audit-log")).toBe(
      implementedPages["audit-log"].href,
    );
  });
});
