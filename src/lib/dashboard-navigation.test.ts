import { describe, expect, it } from "vitest";
import {
  accessPath,
  connectionsPath,
  credentialsPath,
  navigationHref,
  profilePath,
  usagePath,
} from "./dashboard-navigation";

describe("dashboard navigation", () => {
  it("links implemented organization pages and leaves planned pages disabled", () => {
    expect(navigationHref("connections")).toBe(connectionsPath);
    expect(navigationHref("organization")).toBe(profilePath);
    expect(navigationHref("billing")).toBe(usagePath);
    expect(navigationHref("credentials")).toBe(credentialsPath);
    expect(navigationHref("access")).toBe(accessPath);
  });
});
