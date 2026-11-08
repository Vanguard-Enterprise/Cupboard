import { describe, expect, it } from "vitest";
import {
  accentEdge,
  accentEdges,
  accentForeground,
  accentTextContrast,
  affectedNames,
  atText,
  onlineCount,
  statusAnnouncement,
  statusSnapshot,
  statusTabTitle,
  contrastRatio,
  durationLabel,
  hiddenOnlyWindow,
  nameList,
  publicMaintenance,
  publicSummary,
  recentMaintenanceMs,
  relativeTime,
  timeAgo,
  timeParts,
  windowLabel,
  dayName,
  componentStatus,
  draftOf,
  groupComponents,
  maintenancePhase,
  moveComponent,
  overallStatus,
  publicLogoPath,
  sameDraft,
  slugify,
  statusBackgrounds,
  unusedSources,
  validColor,
  validSlug,
  validTargetUrl,
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
  tagId: "",
  groupName: "",
  public: true,
  health,
  observedAt: null,
  detail: null,
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

const utc = { timeZone: "UTC", locale: "en-US" };

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
    expect(overallStatus([], [], now).title).toBe("No targets yet");
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
      title: "1 target unavailable",
      detail: "c",
    });
    expect(overallStatus(all, [], now, true)).toMatchObject({
      tone: "degraded",
      title: "1 target degraded",
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
      // Never "All targets operational" while a target has not reported.
      tone: "unknown",
      title: "1 of 2 targets operational",
      detail: "1 target still waiting for a first check.",
    });
  });

  it("names every problem for players and only says online when all is known", () => {
    const now = 1_000_000;
    const named = (id: string, health: StatusComponent["health"]) =>
      component(id, health, { name: id.toUpperCase() });
    expect(publicSummary([], [], now)).toMatchObject({
      tone: "unknown",
      title: "No services listed yet",
      details: ["Check back soon."],
      // The answer line ends without a full stop, like the Updated line
      // under it (claude P-35).
      answer: ["Check back soon"],
    });
    expect(publicSummary([named("eu", "operational")], [], now).title).toBe(
      "EU is online",
    );
    expect(
      publicSummary(
        [named("eu", "operational"), named("us", "operational")],
        [],
        now,
      ),
    ).toMatchObject({ tone: "operational", title: "All services are online" });
    expect(
      publicSummary(
        [named("eu", "operational"), named("new", "unknown")],
        [],
        now,
      ),
    ).toMatchObject({
      // The hero names the gap; the count is left to the Services heading.
      tone: "unknown",
      title: "NEW hasn't reported yet",
      details: ["Everything else is online."],
      countText: "1 of 2 online",
    });
    expect(publicSummary([named("new", "unknown")], [], now)).toMatchObject({
      tone: "unknown",
      title: "Status not reported yet",
    });
    const mixed = publicSummary(
      [
        named("eu", "down"),
        named("us", "down"),
        named("store", "degraded"),
        named("wings", "operational"),
        named("web", "operational"),
        named("new", "unknown"),
      ],
      [window(now - 10, now + 3_600_000, ["wings"])],
      now,
      { format: utc },
    );
    expect(mixed).toMatchObject({
      tone: "down",
      title: "EU and US are unavailable",
      // A secondary maintenance end belongs to its own sentence.
      details: [
        "STORE is degraded.",
        "WINGS is under maintenance until 1:16 AM UTC.",
        "NEW hasn't reported yet.",
        "Everything else is online.",
      ],
      backBy: now + 3_600_000,
      countText: "2 of 6 online, 1 under maintenance",
      // Nothing here is the hero's to show: the services list says it all.
      answer: null,
    });
    expect(mixed.detail).toBe(mixed.details.join(" "));
    expect(mixed.detailParts[1]).toEqual([
      "WINGS is under maintenance until ",
      { at: now + 3_600_000, text: "1:16 AM UTC" },
      ".",
    ]);
    expect(mixed.counts).toMatchObject({
      down: 2,
      degraded: 1,
      maintenance: 1,
      unknown: 1,
      operational: 1,
      total: 6,
      online: 2,
    });
    const many = publicSummary(
      ["a", "b", "c", "d"].map((id) => named(id, "down")),
      [],
      now,
    );
    expect(many.title).toBe("4 services are unavailable");
    expect(
      publicSummary(
        [named("wings", "operational")],
        [window(now - 10, now + 60_000)],
        now,
      ),
    ).toMatchObject({
      tone: "maintenance",
      title: "WINGS is under maintenance",
      backBy: now + 60_000,
    });
  });

  it("counts degraded services as online and maintenance on its own", () => {
    expect(onlineCount(["operational", "degraded", "down"]).text).toBe(
      "2 of 3 online",
    );
    expect(onlineCount(["operational", "maintenance"]).text).toBe(
      "1 of 2 online, 1 under maintenance",
    );
    expect(onlineCount(["unknown", "operational"]).text).toBe("1 of 2 online");
  });

  it("states the maintenance end once, with its relative time, and agrees with the admin card", () => {
    const now = Date.UTC(2026, 10, 5, 17, 34);
    const ends = Date.UTC(2026, 10, 5, 19, 15);
    const maintenance = publicSummary(
      [
        component("wings", "operational", { name: "use1-wings-01" }),
        component("web", "operational", { name: "Website" }),
      ],
      [window(now - 60_000, ends, ["wings"])],
      now,
      { format: utc },
    );
    expect(maintenance).toMatchObject({
      tone: "maintenance",
      title: "use1-wings-01 is under maintenance",
      details: [
        "Back by 7:15 PM UTC (in 1 hour 41 minutes).",
        "Everything else is online.",
      ],
      countText: "1 of 2 online, 1 under maintenance",
    });
    // The end is the one line players act on, and it leads the details.
    expect(maintenance.answer).toEqual([
      "Back by ",
      { at: ends, text: "7:15 PM UTC" },
      " (in 1 hour 41 minutes)",
    ]);
    expect(atText(Date.UTC(2026, 10, 7, 19), now, utc)).toBe(
      "Sat, Nov 7, 7:00 PM UTC",
    );
  });

  it("says the hero's end is the last one when windows end at different times", () => {
    const now = Date.UTC(2026, 10, 5, 20, 0);
    const targets = [
      component("eu", "operational", { name: "Rust EU Main" }),
      component("us", "operational", { name: "Rust US Weekly" }),
      component("web", "operational", { name: "Website" }),
    ];
    const hour = 3_600_000;
    const staggered = [
      { ...window(now - 60_000, now + hour, ["eu"]), id: "eu-restart" },
      { ...window(now - 60_000, now + 2 * hour, ["us"]), id: "us-restart" },
    ];
    expect(
      publicSummary(targets, staggered, now, { format: utc }).details,
    ).toEqual(["All back by 10:00 PM UTC.", "Everything else is online."]);
    // Each window shows its own end and countdown under the hero, so the
    // hero says the last end once, without repeating that row's countdown
    // (claude P-37).
    expect(
      publicSummary(targets, staggered, now, { format: utc }).answer,
    ).toEqual(["All back by ", { at: now + 2 * hour, text: "10:00 PM UTC" }]);
    // One shared end stays the plain "Back by".
    const together = staggered.map((w) => ({ ...w, endsAt: now + hour }));
    expect(
      publicSummary(targets, together, now, { format: utc }).details[0],
    ).toBe("Back by 9:00 PM UTC (in 1 hour).");
    // Secondary maintenance names the last end the same way.
    const withOutage = [
      ...targets,
      component("store", "down", { name: "Store" }),
    ];
    expect(
      publicSummary(withOutage, staggered, now, { format: utc }).details,
    ).toEqual([
      "Rust EU Main and Rust US Weekly are under maintenance, all back by 10:00 PM UTC, some sooner.",
      "Everything else is online.",
    ]);
  });

  it("keeps the last known state when stale and says what players get when unpublished", () => {
    const now = 1_000_000;
    const targets = [
      component("eu", "down", { name: "EU" }),
      component("store", "degraded", { name: "Store" }),
      component("web", "operational", { name: "Web" }),
    ];
    expect(publicSummary(targets, [], now, { stale: true })).toMatchObject({
      tone: "unknown",
      title: "Status may be out of date",
      details: [
        "Last known: EU is unavailable.",
        "Store is degraded.",
        "Everything else is online.",
      ],
      answer: ["Last known: EU is unavailable"],
    });
    const unpublished = publicSummary(targets, [], now, { published: false });
    expect(unpublished).toMatchObject({
      tone: "unknown",
      title: "Players see a not-found page",
      details: [
        "When published: EU is unavailable.",
        "Store is degraded.",
        "Everything else is online.",
      ],
      countText: "2 of 3 online",
    });
  });

  it("words old readings for services that reported before", () => {
    const now = 10_000_000;
    expect(
      publicSummary(
        [
          component("web", "operational", { name: "Web", observedAt: now }),
          component("eu", "unknown", {
            name: "EU",
            observedAt: now - 3_600_000,
          }),
        ],
        [],
        now,
      ),
    ).toMatchObject({
      tone: "unknown",
      title: "EU hasn't reported recently",
      details: ["Everything else is online."],
    });
    expect(
      publicSummary(
        [component("eu", "unknown", { observedAt: now - 3_600_000 })],
        [],
        now,
      ).title,
    ).toBe("Services haven't reported recently");
  });

  it("titles the tab with the state", () => {
    expect(statusTabTitle("Northstar", "down")).toBe(
      "Unavailable | Northstar | Status",
    );
    expect(statusTabTitle("Northstar", "maintenance")).toBe(
      "Maintenance | Northstar | Status",
    );
    expect(statusTabTitle("Northstar", "down", true)).toBe(
      "Out of date | Northstar | Status",
    );
    expect(statusTabTitle("Northstar", "operational")).toBe(
      "Northstar | Status",
    );
  });

  it("announces service, maintenance, and freshness changes but not the clock", () => {
    const now = 1_000_000;
    const wipe = {
      ...window(now + 60_000, now + 120_000, ["b"]),
      title: "Wipe",
    };
    const targets = (b: StatusComponent["health"]) => [
      component("a", "down", { name: "A" }),
      component("b", b, { name: "B" }),
    ];
    const first = statusSnapshot(targets("operational"), [wipe], now);
    // Time passing inside a phase changes nothing.
    expect(
      statusAnnouncement(
        first,
        statusSnapshot(targets("operational"), [wipe], now + 30_000),
      ),
    ).toBeNull();
    // A change below the worst state is announced on its own.
    expect(
      statusAnnouncement(
        first,
        statusSnapshot(targets("degraded"), [wipe], now),
      ),
    ).toBe("B is now degraded.");
    expect(
      statusAnnouncement(
        first,
        statusSnapshot(targets("operational"), [wipe], now + 60_000),
      ),
    ).toBe("Maintenance started: Wipe. B is now under maintenance.");
    const during = statusSnapshot(targets("operational"), [wipe], now + 60_000);
    expect(
      statusAnnouncement(
        during,
        statusSnapshot(targets("operational"), [wipe], now + 120_000),
      ),
    ).toBe("Maintenance ended: Wipe. B is back online.");
    expect(
      statusAnnouncement(
        first,
        statusSnapshot(targets("operational"), [wipe], now, true),
      ),
    ).toBe("Couldn't refresh. Status may be out of date.");
    expect(
      statusAnnouncement(
        statusSnapshot(targets("operational"), [wipe], now, true),
        first,
      ),
    ).toBe("Status refreshed.");
    expect(
      statusAnnouncement(
        statusSnapshot([component("n", "unknown", { name: "N" })], [], now),
        statusSnapshot([component("n", "operational", { name: "N" })], [], now),
      ),
    ).toBe("N is online.");
    const five = (health: StatusComponent["health"]) =>
      ["a", "b", "c", "d"].map((id) => component(id, health, { name: id }));
    expect(
      statusAnnouncement(
        statusSnapshot(five("operational"), [], now),
        statusSnapshot(five("down"), [], now),
      ),
    ).toBe("4 services changed status. Now: 4 services are unavailable.");
    // A new service can change the headline without any service changing.
    expect(
      statusAnnouncement(
        statusSnapshot([component("a", "operational")], [], now),
        statusSnapshot(
          [
            component("a", "operational"),
            component("n", "down", { name: "N" }),
          ],
          [],
          now,
        ),
      ),
    ).toBe("Now: N is unavailable.");
  });

  it("publishes maintenance only for public targets and the last week", () => {
    const now = 10 * recentMaintenanceMs;
    const windows = [
      { ...window(now + 1, now + 10, []), id: "all" },
      { ...window(now + 1, now + 10, ["eu", "hidden"]), id: "mixed" },
      { ...window(now + 1, now + 10, ["hidden"]), id: "hidden" },
      {
        ...window(
          now - 2 * recentMaintenanceMs,
          now - recentMaintenanceMs - 1,
          ["eu"],
        ),
        id: "old",
      },
      {
        ...window(now - 10, now + 10, ["eu"], now - recentMaintenanceMs - 1),
        id: "done",
      },
      {
        ...window(now - recentMaintenanceMs - 10, now - recentMaintenanceMs, [
          "eu",
        ]),
        id: "week",
      },
    ];
    const shown = publicMaintenance(windows, ["eu", "us"], now);
    expect(shown.map((w) => w.id)).toEqual(["all", "mixed", "week"]);
    expect(shown[1].componentIds).toEqual(["eu"]);
    expect(JSON.stringify(shown)).not.toContain("hidden");
    expect(
      hiddenOnlyWindow(windows[2], [
        component("eu", "operational"),
        component("hidden", "operational", { public: false }),
      ]),
    ).toBe(true);
    expect(hiddenOnlyWindow(windows[0], [])).toBe(false);
  });

  it("keeps each zone across daylight-saving changes and the year across years", () => {
    const now = Date.UTC(2026, 9, 30);
    const ny = { timeZone: "America/New_York", locale: "en-US" };
    // 1:30 AM happens twice on Nov 1, 2026 in New York.
    expect(
      windowLabel(
        window(Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 6, 30)),
        now,
        ny,
      ).range,
    ).toBe("Sun, Nov 1, 1:30 AM EDT to 1:30 AM EST");
    expect(
      windowLabel(
        window(Date.UTC(2026, 11, 31, 22), Date.UTC(2027, 0, 1, 2)),
        now,
        { timeZone: "UTC", locale: "en-US" },
      ).range,
    ).toBe("Thu, Dec 31, 10:00 PM to Fri, Jan 1, 2027, 2:00 AM UTC");
  });

  // claude D-90: the admin said "Sat, Nov 7" for the window the public
  // page calls "Today".
  it("names today and tomorrow the way the public page does", () => {
    const now = Date.UTC(2026, 10, 7, 14);
    const hours = (h: number) => now + h * 3_600_000;
    expect(dayName(hours(5), now, utc)).toBe("Today");
    expect(dayName(hours(12), now, utc)).toBe("Tomorrow");
    expect(dayName(hours(40), now, utc)).toBe("Mon, Nov 9");
    expect(dayName(hours(-20), now, utc)).toBe("Fri, Nov 6");
    expect(windowLabel(window(hours(5), hours(7)), now, utc).range).toBe(
      "Today, 7:00 PM to 9:00 PM UTC",
    );
    expect(windowLabel(window(hours(9), hours(12)), now, utc).range).toBe(
      "Today, 11:00 PM to Tomorrow, 2:00 AM UTC",
    );
    // A 23-hour day still finds tomorrow by the calendar: Mar 8, 2026 in
    // New York, late in the evening.
    const ny = { timeZone: "America/New_York", locale: "en-US" };
    const late = Date.UTC(2026, 2, 9, 3, 30); // Mar 8, 11:30 PM EDT
    expect(dayName(late + 3_600_000, late, ny)).toBe("Tomorrow");
    expect(dayName(late + 25 * 3_600_000, late, ny)).toBe("Tue, Mar 10");
  });

  it("formats times with weekday, zone, and relative words", () => {
    const now = Date.UTC(2026, 10, 5, 12);
    const at = Date.UTC(2026, 10, 7, 19);
    expect(timeParts(at, now, utc)).toMatchObject({
      day: "Sat, Nov 7",
      time: "7:00 PM",
      zone: "UTC",
      dayKey: "2026-11-07",
    });
    expect(timeParts(Date.UTC(2027, 0, 2), now, utc).day).toBe(
      "Sat, Jan 2, 2027",
    );
    expect(
      timeParts(at, now, { timeZone: "America/Los_Angeles", locale: "en-US" }),
    ).toMatchObject({ time: "11:00 AM", zone: "PST" });
    expect(windowLabel(window(at, at + 7_200_000), now).range).toMatch(
      /^\w{3}, \w{3} \d+, .+ to .+ \S+$/,
    );
    expect(relativeTime(at, now)).toBe("in 2 days");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 hours ago");
    // Under a day, hours keep their minutes.
    expect(relativeTime(now + 6_060_000, now)).toBe("in 1 hour 41 minutes");
    expect(relativeTime(now - 25 * 60_000, now)).toBe("25 minutes ago");
    // Ages drop their minutes past an hour (claude P-31); countdowns keep them.
    expect(relativeTime(now - 3 * 3_600_000 - 60_000, now)).toBe("3 hours ago");
    expect(relativeTime(now - 6_060_000, now)).toBe("2 hours ago");
    expect(relativeTime(now - 3_660_000, now)).toBe("1 hour ago");
    expect(relativeTime(now - 59 * 60_000, now)).toBe("59 minutes ago");
    expect(relativeTime(now - 23 * 3_600_000 - 50 * 60_000, now)).toBe(
      "1 day ago",
    );
    expect(timeAgo(now - 3 * 3_600_000 - 60_000, now)).toBe("3 hours ago");
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(timeAgo(now + 5_000, now)).toBe("just now");
    expect(durationLabel(3_600_000)).toBe("1 hour");
    expect(durationLabel(6_000_000)).toBe("1 hour 40 minutes");
    expect(durationLabel(30 * 60_000)).toBe("30 minutes");
    expect(nameList(["A"])).toBe("A");
    expect(nameList(["A", "B"])).toBe("A and B");
    expect(nameList(["A", "B", "C"])).toBe("A, B, and C");
    expect(nameList(["A", "B", "C", "D", "E"])).toBe("A, B, and 3 more");
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
          { id: "s1", name: "EU", kind: "server", tags: [] },
          { id: "s1", name: "Host", kind: "machine", tags: [] },
        ],
        [
          {
            id: null,
            name: "EU",
            kind: "server",
            sourceId: "s1",
            tagId: "",
            public: true,
          },
        ],
      ),
    ).toEqual([{ id: "s1", name: "Host", kind: "machine", tags: [] }]);
    expect(
      affectedNames(window(0, 1, ["b"]), [component("a", "operational")]),
    ).toBe("Removed targets");
    expect(affectedNames(window(0, 1), [])).toBe("All targets");
  });

  it("builds drafts that only differ by meaningful edits", () => {
    const state: StatusPageState = {
      revision: 0,
      name: "Northstar",
      slug: "northstar",
      published: false,
      announcement: "",
      supportUrl: "",
      theme: "dark",
      accentColor: "#7cb58d",
      font: "geist",
      links: [],
      footerText: "",
      poweredBy: true,
      logoVersion: null,
      components: [component("a", "operational")],
      maintenance: [],
      sources: [],
      tags: [],
    };
    const draft = draftOf(state);
    expect(draft.slugEdited).toBe(false);
    expect(sameDraft(draft, draftOf(state))).toBe(true);
    expect(sameDraft(draft, { ...draft, components: [] })).toBe(false);
    expect(sameDraft(draft, { ...draft, slugEdited: true })).toBe(true);
    expect(sameDraft(draft, { ...draft, theme: "light" })).toBe(false);
    expect(
      sameDraft(draft, {
        ...draft,
        links: [{ label: "Site", url: "https://a.example" }],
      }),
    ).toBe(false);
    expect(sameDraft(draft, { ...draft, poweredBy: false })).toBe(false);
  });

  it("accepts only complete http and https target addresses", () => {
    expect(validTargetUrl("https://play.example.com")).toBe(true);
    expect(validTargetUrl(" http://example.com:8080/health ")).toBe(true);
    expect(validTargetUrl("play.example.com")).toBe(false);
    expect(validTargetUrl("ftp://example.com")).toBe(false);
    expect(validTargetUrl("")).toBe(false);
  });

  it("validates accents and picks readable text for them", () => {
    expect(validColor("#7cb58d")).toBe(true);
    expect(validColor("#7CB58D")).toBe(false);
    expect(validColor("#7cb")).toBe(false);
    expect(accentForeground("#f3f4f6")).toBe("#0e0f11");
    expect(accentForeground("#7cb58d")).toBe("#0e0f11");
    expect(accentForeground("#1f3a5f")).toBe("#ffffff");
    expect(accentForeground("#000000")).toBe("#ffffff");
    // Mid-grey reaches 4.5:1 with neither near-black nor white text.
    expect(accentForeground("#787878")).toBe("#000000");
    for (let r = 0; r < 256; r += 17)
      for (let g = 0; g < 256; g += 17)
        for (let b = 0; b < 256; b += 17) {
          const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
          expect(accentTextContrast(hex)).toBeGreaterThanOrEqual(4.5);
        }
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21);
    // The white preset vanishes on the light page and needs an edge there;
    // a navy accent vanishes on the dark page.
    expect(accentEdges("#f3f4f6", "light").light).not.toBeNull();
    expect(accentEdges("#f3f4f6", "dark")).toEqual({ light: null, dark: null });
    expect(accentEdges("#f3f4f6", "system").light).not.toBeNull();
    expect(accentEdges("#f3f4f6", "system").dark).toBeNull();
    expect(accentEdges("#1f3a5f", "dark").dark).not.toBeNull();
    expect(accentEdges("#7cb58d", "dark")).toEqual({ light: null, dark: null });
    // The edge is the accent's own deeper or lighter shade (claude P-33): it
    // holds 3:1 on the page, and is the first such shade, never black or
    // white when a shade will do.
    for (const [accent, page] of [
      ["#7cb58d", statusBackgrounds.light],
      ["#f3f4f6", statusBackgrounds.light],
      ["#1f3a5f", statusBackgrounds.dark],
      ["#2a2f36", statusBackgrounds.dark],
    ]) {
      const edge = accentEdge(accent, page)!;
      expect(edge).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrastRatio(edge, page)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(edge, page)).toBeLessThan(3.6);
      expect(["#000000", "#ffffff"]).not.toContain(edge);
    }
    // Sage on the light page gets a deeper sage, not a grey ring.
    const sage = accentEdge("#7cb58d", statusBackgrounds.light)!;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(sage.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(publicLogoPath("northstar", 7)).toBe(
      "/app-api/public/status/northstar/logo?v=7",
    );
  });
});
