import { describe, expect, it } from "vitest";
import {
  affectedNames,
  componentStatus,
  draftOf,
  groupComponents,
  maintenancePhase,
  moveComponent,
  overallStatus,
  sameDraft,
  slugify,
  unusedSources,
  validSlug,
  type MaintenanceWindow,
  type StatusComponent,
  type StatusPageState,
} from "./status-page";

const component = (
  id: string,
  health: StatusComponent["health"],
  extra: Partial<StatusComponent> = {},
): StatusComponent => ({
  id,
  name: id,
  kind: "server",
  sourceId: `source-${id}`,
  sourceName: id,
  groupName: "",
  public: true,
  health,
  observedAt: null,
  ...extra,
});
const window = (
  startsAt: number,
  endsAt: number,
  componentIds: string[] = [],
  completedAt: number | null = null,
): MaintenanceWindow => ({
  id: `w-${startsAt}`,
  title: "Wipe",
  message: "",
  startsAt,
  endsAt,
  completedAt,
  componentIds,
  createdAt: 0,
});

describe("status page helpers", () => {
  it("derives safe public addresses from names", () => {
    expect(slugify("Northstar Games")).toBe("northstar-games");
    expect(slugify("  EU / Main --  ")).toBe("eu-main");
    expect(slugify("***")).toBe("status");
    expect(slugify("a".repeat(60))).toHaveLength(40);
    expect(validSlug("northstar-games")).toBe(true);
    expect(validSlug("-eu")).toBe(false);
    expect(validSlug("EU")).toBe(false);
    expect(validSlug("")).toBe(false);
  });

  it("puts components under maintenance only during an open window", () => {
    const now = 1_000_000;
    const eu = component("eu", "operational");
    const us = component("us", "down");
    const windows = [window(now - 10, now + 10, ["eu"])];
    expect(componentStatus(eu, windows, now)).toBe("maintenance");
    expect(componentStatus(us, windows, now)).toBe("down");
    expect(componentStatus(eu, [window(now + 1, now + 10, ["eu"])], now)).toBe(
      "operational",
    );
    expect(
      componentStatus(eu, [window(now - 10, now + 10, ["eu"], now - 1)], now),
    ).toBe("operational");
    expect(componentStatus(us, [window(now - 10, now + 10)], now)).toBe(
      "maintenance",
    );
    expect(maintenancePhase(window(now + 1, now + 10), now)).toBe("scheduled");
    expect(maintenancePhase(window(now - 1, now + 10), now)).toBe("active");
    expect(maintenancePhase(window(now - 10, now - 1), now)).toBe("completed");
  });

  it("summarizes the page from the worst component", () => {
    const now = 5;
    expect(overallStatus([], [], now).title).toBe("No components yet");
    expect(overallStatus([component("a", "unknown")], [], now).title).toBe(
      "Waiting for the first check",
    );
    const all = [
      component("a", "operational"),
      component("b", "degraded"),
      component("c", "down", { public: false }),
    ];
    expect(overallStatus(all, [], now)).toMatchObject({
      tone: "down",
      title: "1 component unavailable",
      detail: "c",
    });
    expect(overallStatus(all, [], now, true)).toMatchObject({
      tone: "degraded",
      title: "1 component degraded",
    });
    expect(overallStatus(all, [window(now - 1, now + 1)], now).tone).toBe(
      "maintenance",
    );
    expect(
      overallStatus(
        [component("a", "operational"), component("b", "unknown")],
        [],
        now,
      ),
    ).toMatchObject({
      tone: "operational",
      detail: "1 component still waiting for a first check.",
    });
  });

  it("groups, reorders, and lists unused sources", () => {
    const items = [
      { groupName: "EU", id: 1 },
      { groupName: "", id: 2 },
      { groupName: "EU", id: 3 },
    ];
    expect(groupComponents(items).map((g) => [g.name, g.items.length])).toEqual(
      [
        ["EU", 2],
        ["", 1],
      ],
    );
    expect(moveComponent([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveComponent([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(moveComponent([1, 2, 3], 0, 3)).toEqual([1, 2, 3]);
    expect(
      unusedSources(
        [
          { id: "s1", name: "EU", kind: "server" },
          { id: "s1", name: "Host", kind: "machine" },
        ],
        [
          {
            id: null,
            name: "EU",
            kind: "server",
            sourceId: "s1",
            groupName: "",
            public: true,
          },
        ],
      ),
    ).toEqual([{ id: "s1", name: "Host", kind: "machine" }]);
    expect(
      affectedNames(window(0, 1, ["b"]), [component("a", "operational")]),
    ).toBe("Removed components");
    expect(affectedNames(window(0, 1), [])).toBe("All components");
  });

  it("builds drafts that only differ by meaningful edits", () => {
    const state: StatusPageState = {
      revision: 0,
      name: "Northstar",
      slug: "northstar",
      published: false,
      announcement: "",
      supportUrl: "",
      components: [component("a", "operational")],
      maintenance: [],
      sources: [],
    };
    const draft = draftOf(state);
    expect(draft.slugEdited).toBe(false);
    expect(sameDraft(draft, draftOf(state))).toBe(true);
    expect(sameDraft(draft, { ...draft, components: [] })).toBe(false);
    expect(sameDraft(draft, { ...draft, slugEdited: true })).toBe(true);
  });
});
