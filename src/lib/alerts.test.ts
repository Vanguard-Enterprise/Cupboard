import { describe, expect, it } from "vitest";
import {
  alertGroups,
  channelRouteCount,
  exportFileName,
  normalizeRoutes,
  rebaseRoutes,
} from "./alerts";

describe("alert routing helpers", () => {
  it("normalizes routes to known events and channels in a stable order", () => {
    expect(
      normalizeRoutes(
        {
          "server.offline": ["b", "a", "a", "removed"],
          "server.exploded": ["a"],
          "member.joined": [],
        },
        ["a", "b"],
      ),
    ).toEqual({ "server.offline": ["a", "b"] });
  });

  it("reapplies unsaved additions and removals onto newer saved routes", () => {
    const previous = { "server.offline": ["a"], "machine.offline": ["a"] };
    const draft = { "server.offline": ["a", "b"] };
    // Another session added channel c everywhere and removed nothing.
    const next = {
      "server.offline": ["a", "c"],
      "machine.offline": ["a", "c"],
      "pelican.failed": ["c"],
    };
    expect(rebaseRoutes(previous, draft, next, ["a", "b", "c"])).toEqual({
      "server.offline": ["a", "b", "c"],
      "machine.offline": ["c"],
      "pelican.failed": ["c"],
    });
    // A removed channel disappears even when the draft still selects it.
    expect(rebaseRoutes(previous, draft, next, ["a", "c"])).toEqual({
      "server.offline": ["a", "c"],
      "machine.offline": ["c"],
      "pelican.failed": ["c"],
    });
  });

  it("counts routed alerts and names exports safely", () => {
    expect(
      channelRouteCount(
        { "server.offline": ["a"], "member.joined": ["a", "b"] },
        "a",
      ),
    ).toBe(2);
    expect(
      exportFileName("Northstar Games / EU", new Date("2026-10-27T12:00:00Z")),
    ).toBe("cupboard-northstar-games-eu-2026-10-27.json");
    expect(exportFileName("///", new Date("2026-10-27T12:00:00Z"))).toBe(
      "cupboard-organization-2026-10-27.json",
    );
    const keys = alertGroups.flatMap((g) => g.events.map((e) => e.key));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
