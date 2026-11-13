// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicStatusPage, PublicStatusView } from "./public-status-page";
import {
  accentEdge,
  dayName,
  statusBackgrounds,
  type PublicStatus,
} from "@/lib/status-page";
import { apiRequest } from "@/lib/api-client";

vi.mock("@/lib/api-client", () => ({ apiRequest: vi.fn() }));
vi.mock("@/components/status-fonts", () => ({
  statusFontFamily: {
    geist: "Geist",
    inter: "Inter",
    manrope: "Manrope",
    "ibm-plex-sans": "IBM Plex Sans",
    "space-grotesk": "Space Grotesk",
    "source-serif": "Source Serif 4",
    "jetbrains-mono": "JetBrains Mono",
  },
}));

const now = Date.now();
const status: PublicStatus = {
  name: "Northstar Games status",
  announcement: "Wipe on Thursday.",
  supportUrl: "https://discord.gg/northstar",
  theme: "dark",
  accentColor: "#7cb58d",
  font: "geist",
  links: [],
  footerText: "",
  poweredBy: true,
  showName: true,
  headerTitle: "",
  logoAlign: "left",
  logoSize: "medium",
  announcementIcon: "megaphone",
  announcementTone: "neutral",
  logoVersion: null,
  updatedAt: now,
  components: [
    {
      id: "eu",
      name: "EU Main",
      groupName: "Game servers",
      health: "operational",
      observedAt: now,
    },
    {
      id: "us",
      name: "US Vanilla",
      groupName: "Game servers",
      health: "down",
      observedAt: now,
    },
  ],
  maintenance: [
    {
      id: "w1",
      title: "Monthly wipe",
      message: "Map reset.",
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      completedAt: null,
      componentIds: ["eu"],
      createdAt: now,
    },
    {
      id: "w2",
      title: "Host reboot",
      message: "",
      startsAt: now + 86_400_000,
      endsAt: now + 90_000_000,
      completedAt: null,
      componentIds: [],
      createdAt: now,
    },
  ],
};

beforeEach(() => vi.mocked(apiRequest).mockReset());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Public status page", () => {
  it("names the affected services, maintenance, and the support link", () => {
    render(<PublicStatusPage slug="northstar" initial={status} />);
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "US Vanilla is unavailable",
      }),
    ).toBeTruthy();
    // Secondary states are the list's to show; screen readers still hear
    // them with the headline. The hero is not a landmark: its name would
    // change with every state (a11y P-R6-05).
    expect(
      screen.queryByRole("region", { name: "US Vanilla is unavailable" }),
    ).toBeNull();
    const hero = document.querySelector<HTMLElement>("[data-status-tone]")!;
    const secondary = hero.querySelector(".sr-only")!;
    expect(secondary.textContent).toMatch(
      /^EU Main is under maintenance until \d+:\d\d [AP]M \S+\./,
    );
    expect(screen.getByRole("note").textContent).toContain("Wipe on Thursday.");
    expect(
      screen
        .getByRole("link", { name: /Contact support/ })
        .getAttribute("href"),
    ).toBe("https://discord.gg/northstar");
    const services = screen.getByRole("region", { name: "Services" });
    const rows = within(services).getAllByRole("listitem");
    // The state follows the name, before any second line (a11y P-16).
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^EU Main: Under maintenance\./),
      expect.stringMatching(/^US Vanilla: Unavailable\. Maintenance on /),
    ]);
    // The coming window is named in Upcoming maintenance, not under the row.
    expect(
      within(rows[1])
        .getByText(/Maintenance on/)
        .closest(".sr-only"),
    ).not.toBeNull();
    // The end is in the hero and the card, not repeated on the row.
    expect(rows[0].textContent).not.toMatch(/Back by/);
    // The heading counts; an open group's rows already say what its roll-up
    // would (claude P-34).
    expect(
      within(services).getAllByText("0 of 2 online, 1 under maintenance"),
    ).toHaveLength(1);
    // Maintenance under an outage headline: its own end and reach, no card.
    const active = screen.getByRole("region", {
      name: "Maintenance in progress",
    });
    expect(
      within(active).getByRole("heading", { name: "Monthly wipe" }),
    ).toBeTruthy();
    expect(active.textContent).toMatch(
      /Back by \d+:\d\d [AP]M \S+ \(in 1 hour\)Affects EU Main/,
    );
    expect(document.querySelector("article")).toBeNull();
    const upcoming = screen.getByRole("region", {
      name: "Upcoming maintenance",
    });
    expect(within(upcoming).getByText("Host reboot")).toBeTruthy();
    // Days are named as in the admin: "Today", "Tomorrow", then the date.
    expect(within(upcoming).getByText("Tomorrow").tagName).toBe("TIME");
    expect(upcoming.textContent).toMatch(/Affects All services/);
    expect(upcoming.textContent).toMatch(/\(in 1 day\)/);
    expect(screen.queryByText("Past maintenance")).toBeNull();
  });

  it("exposes banner, main, and contentinfo landmarks with labelled times", () => {
    const { container } = render(
      <PublicStatusPage slug="northstar" initial={status} />,
    );
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("contentinfo").textContent).toBe(
      "Powered byCupboard",
    );
    expect(screen.getByRole("main").contains(screen.getByRole("banner"))).toBe(
      false,
    );
    const times = [...container.querySelectorAll("time")];
    expect(times.length).toBeGreaterThan(3);
    for (const time of times)
      expect(time.getAttribute("dateTime")).toMatch(/Z$/);
    // The update reads as an age; its clock time and zone stay on hover.
    const updated = screen.getByText(/^Updated/);
    expect(updated.textContent).toBe("Updated just now");
    expect(updated.querySelector("time")!.getAttribute("title")).toMatch(
      /^\d+:\d\d [AP]M \S+$/,
    );
  });

  it("never publishes maintenance that only affects hidden targets", () => {
    render(
      <PublicStatusView
        embedded
        now={now}
        logoUrl={null}
        data={{
          ...status,
          maintenance: [
            ...status.maintenance,
            {
              id: "w3",
              title: "Hidden staging reboot",
              message: "",
              startsAt: now + 3_600_000,
              endsAt: now + 7_200_000,
              completedAt: null,
              componentIds: ["staging"],
              createdAt: now,
            },
            {
              id: "w4",
              title: "Old wipe",
              message: "",
              startsAt: now - 9 * 86_400_000,
              endsAt: now - 9 * 86_400_000 + 3_600_000,
              completedAt: null,
              componentIds: [],
              createdAt: now,
            },
          ],
        }}
      />,
    );
    expect(screen.queryByText("Hidden staging reboot")).toBeNull();
    expect(screen.queryByText("Old wipe")).toBeNull();
    // The preview renders no landmarks or headings of its own.
    expect(screen.queryByRole("main")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("applies the page branding without letting the accent drive focus", () => {
    const { container } = render(
      <PublicStatusPage
        slug="northstar"
        initial={{
          ...status,
          theme: "light",
          accentColor: "#1f3a5f",
          font: "space-grotesk",
          links: [{ label: "Store", url: "https://store.northstar.example" }],
          footerText: "Northstar Games LLC",
          poweredBy: false,
          logoVersion: 9,
        }}
      />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("theme-light");
    expect(root.style.fontFamily).toContain("Space Grotesk");
    expect(root.style.getPropertyValue("--ring")).toBe("");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/app-api/public/status/northstar/logo?v=9",
    );
    const support = screen.getByRole("link", { name: /Contact support/ });
    expect(support.style.color).toBe("rgb(255, 255, 255)");
    expect(support.className).toContain("focus-visible:outline-foreground");
    expect(
      screen.getByRole("link", { name: /Store/ }).getAttribute("href"),
    ).toBe("https://store.northstar.example");
    const store = screen.getByRole("link", { name: "Store" });
    expect(
      document.getElementById(store.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("Opens in a new tab");
    expect(
      screen.getByRole("navigation", { name: "Northstar Games status links" }),
    ).toBeTruthy();
    expect(screen.getByText("Northstar Games LLC")).toBeTruthy();
    expect(screen.queryByText("Powered by")).toBeNull();
  });

  it("edges an accent button that would vanish into the page with a shade of the accent", () => {
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{ ...status, theme: "light", accentColor: "#7cb58d" }}
      />,
    );
    const support = () => screen.getByRole("link", { name: /Contact support/ });
    // A deeper sage on the light page, not a grey ring (claude P-33).
    expect(support().style.getPropertyValue("--accent-edge-light")).toBe(
      accentEdge("#7cb58d", statusBackgrounds.light),
    );
    expect(support().style.getPropertyValue("--accent-edge-dark")).toBe(
      "transparent",
    );
    expect(support().getAttribute("style")).toContain(
      "inset 0 0 0 1px light-dark(var(--accent-edge-light), var(--accent-edge-dark))",
    );
    expect(support().getAttribute("style")).not.toContain("muted-foreground");
    cleanup();
    // A System page gets the edge each scheme needs.
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{ ...status, theme: "system", accentColor: "#1f3a5f" }}
      />,
    );
    expect(support().style.getPropertyValue("--accent-edge-light")).toBe(
      "transparent",
    );
    expect(support().style.getPropertyValue("--accent-edge-dark")).toBe(
      accentEdge("#1f3a5f", statusBackgrounds.dark),
    );
    cleanup();
    render(<PublicStatusPage slug="northstar" initial={status} />);
    expect(support().getAttribute("style")).not.toContain("box-shadow");
  });

  it("follows the visitor's device only when the page uses the system theme", () => {
    const system = render(
      <PublicStatusPage
        slug="northstar"
        initial={{ ...status, theme: "system" }}
      />,
    );
    const root = system.container.firstElementChild as HTMLElement;
    expect(root.className).toContain("theme-system");
    expect(root.className).not.toContain("theme-light");
    system.unmount();
    const dark = render(<PublicStatusPage slug="northstar" initial={status} />);
    expect(
      (dark.container.firstElementChild as HTMLElement).className,
    ).not.toMatch(/theme-(light|system)/);
  });

  it("shows an initial in the accent color without a logo", () => {
    render(<PublicStatusPage slug="northstar" initial={status} />);
    expect(screen.getByText("N")).toBeTruthy();
    expect(screen.getByText("Powered by")).toBeTruthy();
  });

  it("speaks to players when nothing is listed", () => {
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{ ...status, components: [], maintenance: [] }}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "No services listed yet" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Add the servers/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Services" })).toBeNull();
    // Nothing is tracked, so there is no update time to report.
    expect(screen.queryByText(/^Updated/)).toBeNull();
  });

  it("collapses healthy groups on long pages and keeps problem groups open", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `s${i}`,
      name: `Server ${i}`,
      groupName: i < 6 ? "EU" : "US",
      health: i === 7 ? ("down" as const) : ("operational" as const),
      observedAt: now,
    }));
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{ ...status, components: many, maintenance: [] }}
      />,
    );
    // Headings name the group; the roll-up is the button's description.
    const eu = screen.getByRole("button", {
      name: "EU",
      description: "6 of 6 online",
    });
    const us = screen.getByRole("button", {
      name: "US",
      description: "2 of 3 online",
    });
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual(["EU", "US"]);
    expect(eu.getAttribute("aria-expanded")).toBe("false");
    expect(us.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Server 0").closest("[hidden]")).not.toBeNull();
    expect(screen.getByText("Server 7").closest("[hidden]")).toBeNull();
    fireEvent.click(eu);
    expect(eu.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Server 0").closest("[hidden]")).toBeNull();
    expect(
      document.getElementById(eu.getAttribute("aria-controls") ?? ""),
    ).toBeTruthy();
  });

  it("marks stale data, offers a retry, and announces only real changes", async () => {
    vi.useFakeTimers();
    vi.mocked(apiRequest).mockRejectedValueOnce(new Error("offline"));
    render(<PublicStatusPage slug="northstar" initial={status} />);
    const live = screen.getByRole("status");
    expect(live.textContent).toBe("");
    // The clock ticks without announcing anything.
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(live.textContent).toBe("");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(apiRequest).toHaveBeenCalledWith("public/status/northstar");
    expect(
      screen.getByRole("heading", { name: "Status may be out of date" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Last known: US Vanilla is unavailable/),
    ).toBeTruthy();
    expect(screen.getByText(/^Updated/).textContent).toBe(
      "Updated 1 minute ago",
    );
    expect(live.textContent).toBe(
      "Couldn't refresh. Status may be out of date.",
    );
    // The list stops looking live: muted labels, and an "as of" count for
    // screen readers (the hero shows the time).
    const services = screen.getByRole("region", { name: "Services" });
    expect(services.textContent).toMatch(
      /As of \d+:\d\d [AP]M \S+, 0 of 2 online, 1 under maintenance/,
    );
    expect(within(services).getByText(/As of/).className).toContain("sr-only");
    const down = within(services)
      .getAllByRole("listitem")
      .find((r) => r.textContent?.startsWith("US Vanilla"))!;
    expect(down.textContent).toMatch(/^US Vanilla: Last known Unavailable\. /);
    const label = down.querySelector("[data-status-label]")!;
    expect(label.className).toContain("text-muted-foreground");
    expect(label.className).not.toContain("text-destructive");
    expect(
      down.querySelector("svg")?.getAttribute("class") ?? "",
    ).not.toContain("text-destructive");
    expect(document.title).toBe(
      "Out of date | Northstar Games status | Status",
    );
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...status,
      components: status.components.map((c) => ({
        ...c,
        health: "operational" as const,
      })),
      maintenance: [],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(
      screen.getByRole("heading", { name: "All services are online" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(
      screen.getByRole("region", { name: "Services" }).textContent,
    ).not.toMatch(/As of|Last known/);
    expect(live.textContent).toBe(
      "Status refreshed. EU Main is back online. US Vanilla is back online.",
    );
    expect(document.title).toBe("Northstar Games status | Status");
  });

  it("folds maintenance into the hero when it is the headline", () => {
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{
          ...status,
          components: [status.components[0]],
          maintenance: [status.maintenance[0]],
        }}
      />,
    );
    const hero = document.querySelector<HTMLElement>("[data-status-tone]")!;
    expect(hero.getAttribute("data-status-tone")).toBe("maintenance");
    // No full stop after the answer, like the Updated line (claude P-35).
    expect(screen.getByTestId("status-answer").textContent).toMatch(
      /^Back by \d+:\d\d [AP]M \S+ \(in 1 hour\)$/,
    );
    expect(
      within(hero).getByRole("heading", { name: "Monthly wipe" }),
    ).toBeTruthy();
    // The hero states the end, so the window just says it is happening.
    expect(hero.textContent).not.toMatch(/Started/);
    expect(hero.textContent).toMatch(/Monthly wipeIn progress/);
    expect(hero.textContent).toContain("Map reset.");
    // With no time to give, the entry drops the timetable's time column and
    // puts its state on the title's line (codex P-22).
    const entry = within(hero)
      .getByRole("heading", { name: "Monthly wipe" })
      .closest("li")!;
    expect(entry.className).not.toContain("grid-cols-[11rem");
    expect(
      within(hero).getByRole("heading", { name: "Monthly wipe" }).parentElement,
    ).toBe(within(entry).getByText("In progress").closest("div"));
    // A short note stays in view.
    expect(within(entry).queryByRole("button")).toBeNull();
    // Title, Back by, Updated, then the window; the message is secondary.
    const text = hero.textContent!;
    expect(text.indexOf("Back by")).toBeLessThan(text.indexOf("Updated"));
    expect(text.indexOf("Updated")).toBeLessThan(text.indexOf("Monthly wipe"));
    expect(screen.getByText("Map reset.").className).toContain(
      "text-muted-foreground",
    );
    // No second card repeats the window.
    expect(document.querySelector("article")).toBeNull();
    expect(screen.getAllByText(/Back by/)).toHaveLength(1);
  });

  it("shows how old every reading is once it stops being fresh", () => {
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{
          ...status,
          maintenance: [],
          components: [
            { ...status.components[0], observedAt: now - 3 * 3_600_000 },
            { ...status.components[1], observedAt: now },
            {
              id: "x",
              name: "Old box",
              groupName: "",
              health: "unknown",
              observedAt: now - 86_400_000,
            },
          ],
        }}
      />,
    );
    const rows = within(
      screen.getByRole("region", { name: "Services" }),
    ).getAllByRole("listitem");
    const row = (name: string) =>
      rows.find((r) => r.textContent?.startsWith(name))!;
    expect(row("EU Main").textContent).toMatch(/Last checked 3 hours ago/);
    expect(row("US Vanilla").textContent).not.toMatch(/Last checked/);
    expect(row("Old box").textContent).toMatch(/Last checked 1 day ago/);
    expect(screen.getByText(/Old box hasn't reported recently\./)).toBeTruthy();
  });

  it("announces a secondary service change while the headline stays the same", async () => {
    vi.useFakeTimers();
    const two = {
      ...status,
      maintenance: [],
      components: [
        { ...status.components[1], id: "a", name: "Server 0" },
        { ...status.components[0], id: "b", name: "Server 1" },
      ],
    };
    render(<PublicStatusPage slug="northstar" initial={two} />);
    const live = screen.getByRole("status");
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...two,
      components: [
        two.components[0],
        { ...two.components[1], health: "degraded" as const },
      ],
    });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Server 0 is unavailable",
      }),
    ).toBeTruthy();
    expect(live.textContent).toBe("Server 1 is now degraded.");
  });

  it("sets the tab title from the state on load and after refreshes", async () => {
    vi.useFakeTimers();
    document.title = "Northstar Games status | Status";
    render(<PublicStatusPage slug="northstar" initial={status} />);
    expect(document.title).toBe(
      "Unavailable | Northstar Games status | Status",
    );
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...status,
      components: [status.components[0]],
    });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(document.title).toBe(
      "Maintenance | Northstar Games status | Status",
    );
  });

  it("opens a collapsed group when it develops a problem, and keeps a visitor's collapse", async () => {
    vi.useFakeTimers();
    const fleet = (down: number | null, degraded: number | null = null) =>
      Array.from({ length: 9 }, (_, i) => ({
        id: `s${i}`,
        name: `Server ${i}`,
        groupName: i < 6 ? "EU" : "US",
        health:
          i === down
            ? ("down" as const)
            : i === degraded
              ? ("degraded" as const)
              : ("operational" as const),
        observedAt: now,
      }));
    const page = (components: ReturnType<typeof fleet>) => ({
      ...status,
      maintenance: [],
      components,
    });
    render(<PublicStatusPage slug="northstar" initial={page(fleet(null))} />);
    const eu = () => screen.getByRole("button", { name: /^EU/ });
    expect(eu().getAttribute("aria-expanded")).toBe("false");
    const refresh = async (components: ReturnType<typeof fleet>) => {
      vi.mocked(apiRequest).mockResolvedValueOnce(page(components));
      await act(() => vi.advanceTimersByTimeAsync(60_000));
    };
    await refresh(fleet(0));
    expect(eu().getAttribute("aria-expanded")).toBe("true");
    expect(eu()).toHaveProperty("textContent", "EU");
    expect(
      document.getElementById(eu().getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe("5 of 6 online");
    // The visitor closes it; the same incident does not reopen it.
    fireEvent.click(eu());
    await refresh(fleet(0));
    expect(eu().getAttribute("aria-expanded")).toBe("false");
    // Recovery, then a new problem, opens it again.
    await refresh(fleet(null));
    await refresh(fleet(null, 2));
    expect(eu().getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps accent button text at 4.5:1 or more", () => {
    render(
      <PublicStatusView
        data={{ ...status, accentColor: "#787878" }}
        logoUrl={null}
        now={now}
      />,
    );
    const support = screen.getByRole("link", { name: "Contact support" });
    expect(support.style.color).toBe("rgb(0, 0, 0)");
  });

  it("states the headline without a card, the glyph carrying the state", () => {
    render(
      <PublicStatusView
        data={{ ...status, theme: "light" }}
        logoUrl={null}
        now={now}
      />,
    );
    const hero = document.querySelector("[data-status-tone]")!;
    expect(hero.getAttribute("data-status-tone")).toBe("down");
    expect(hero.className).not.toMatch(/border|bg-/);
    const glyph = hero.querySelector("h2 svg")!;
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(glyph.getAttribute("class")).toContain("text-destructive");
    // The glyph sits inline before the title, in the column: a wrapped line
    // lines up with the title's text, never under the glyph (P-31).
    const statement = hero.firstElementChild!;
    const heading = hero.querySelector("h2")!;
    expect(heading.className.split(" ")).toContain("flex");
    expect(glyph.getAttribute("class")).toContain("shrink-0");
    expect(glyph.getAttribute("class")).not.toContain("absolute");
    // Visible: the title and the update time. The rest is for screen readers.
    const shown = [...statement.children].filter(
      (el) => !el.classList.contains("sr-only"),
    );
    expect(shown.map((el) => el.textContent)).toEqual([
      "US Vanilla is unavailable",
      expect.stringMatching(/^Updated /),
    ]);
  });
  it("keeps each window's own end when several fold into the hero", () => {
    const servers = [0, 1].map((i) => ({
      id: `s${i}`,
      name: `Server ${i}`,
      groupName: "",
      health: "operational" as const,
      observedAt: now,
    }));
    const window = (i: number, hours: number) => ({
      id: `m${i}`,
      title: `Restart ${i}`,
      message: "",
      startsAt: now - 60_000,
      endsAt: now + hours * 3_600_000,
      completedAt: null,
      componentIds: [`s${i}`],
      createdAt: now,
    });
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{
          ...status,
          components: servers,
          maintenance: [window(0, 1), window(1, 2)],
        }}
      />,
    );
    const hero = document.querySelector<HTMLElement>("[data-status-tone]")!;
    const block = (title: string) =>
      within(hero).getByRole("heading", { name: title }).parentElement!;
    expect(block("Restart 0").textContent).toMatch(
      /^Restart 0Back by \d+:\d\d [AP]M \S+ \(in 1 hour\)Affects Server 0$/,
    );
    expect(block("Restart 1").textContent).toMatch(
      /^Restart 1Back by \d+:\d\d [AP]M \S+ \(in 2 hours\)Affects Server 1$/,
    );
    // The hero's own end says it is the last one (claude P-32), once: the
    // last row already counts down to it (claude P-37).
    expect(screen.getByTestId("status-answer").textContent).toMatch(
      /^All back by \d+:\d\d [AP]M \S+$/,
    );
    expect(hero.textContent?.match(/in 2 hours/g)).toHaveLength(1);
    expect(
      within(block("Restart 0")).getAllByText(/\d+:\d\d [AP]M/, {
        selector: "time",
      }),
    ).toHaveLength(1);
  });

  it("sets chips, roll-ups, and Affects at 13 pixels and says the same thing for no report", () => {
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{
          ...status,
          components: [
            ...status.components,
            {
              id: "new",
              name: "New box",
              groupName: "",
              health: "unknown",
              observedAt: null,
            },
          ],
        }}
      />,
    );
    const services = screen.getByRole("region", { name: "Services" });
    for (const label of services.querySelectorAll("[data-status-label]"))
      expect(label.className).toContain("text-[0.8125rem]");
    expect(
      within(services).getByText(/0 of 3 online, 1 under/).className,
    ).toContain("text-[0.8125rem]");
    const reach = [...document.querySelectorAll("p")].find(
      (p) => p.textContent === "Affects EU Main",
    )!;
    expect(reach.className).toContain("text-[0.8125rem]");
    // "Affects" is for screen readers; the names are enough on screen.
    expect(within(reach).getByText("Affects").className).toContain("sr-only");
    const row = within(services)
      .getAllByRole("listitem")
      .find((r) => r.textContent?.startsWith("New box"))!;
    expect(row.textContent).toMatch(/^New box: Unknown\. Hasn't reported yet /);
  });

  it("shows the announcement as the operator's words alone", () => {
    render(<PublicStatusPage slug="northstar" initial={status} />);
    const note = screen.getByRole("note", { name: "Announcement" });
    expect(note.textContent).toBe("Wipe on Thursday.");
    expect(note.className).not.toMatch(/border|bg-/);
  });

  it("runs the footer rule across the page and centers one line under it", () => {
    const { container, rerender } = render(
      <PublicStatusView
        data={{ ...status, footerText: "© Northstar Games" }}
        logoUrl={null}
        now={now}
      />,
    );
    const page = container.querySelector("[data-status-page]")!;
    const footer = screen.getByRole("contentinfo");
    // The rule is the footer's own edge, outside the content column.
    expect(footer.parentElement).toBe(page);
    expect(footer.className).toContain("border-t");
    const line = footer.firstElementChild!;
    // Centered on the area beside any scrollbar, like the rule and the bar,
    // so every center agrees (a11y P-R6-01).
    expect(line.className).toContain("mx-auto");
    expect(line.className).not.toContain("status-column");
    expect(line.className).toContain("justify-center");
    // The link's hit box reaches into the padding, so one line stays about
    // 60 pixels tall on touch screens too (a11y P-R6-02).
    const cupboard = within(footer).getByRole("link", { name: "Cupboard" });
    expect(cupboard.className).toContain("-my-1.5");
    expect(cupboard.className).toContain("[@media(any-pointer:coarse)]:-my-3");
    expect(line.textContent).toBe("© Northstar GamesPowered byCupboard");
    expect(footer.textContent).not.toMatch(/updates every minute/);
    // Short pages keep it at the bottom of the window.
    expect(page.className).toContain("min-h-svh");
    rerender(
      <PublicStatusView
        data={{ ...status, footerText: "", poweredBy: false }}
        logoUrl={null}
        now={now}
      />,
    );
    expect(screen.queryByRole("contentinfo")).toBeNull();
  });

  it("flashes a row once when a refresh changes it, never on first paint", async () => {
    vi.useFakeTimers();
    const { container } = render(
      <PublicStatusPage slug="northstar" initial={status} />,
    );
    // The first paint is still: no flash and no headline motion.
    expect(container.querySelector("[data-status-changed]")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 2, name: /US Vanilla/ }).className,
    ).not.toContain("animate-in");
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...status,
      components: status.components.map((c) => ({
        ...c,
        health: "operational" as const,
      })),
      maintenance: [],
    });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    const services = screen.getByRole("region", { name: "Services" });
    const flashes = services.querySelectorAll("[data-status-changed]");
    // EU Main left maintenance and US Vanilla came back: both rows flash.
    expect(flashes).toHaveLength(2);
    for (const flash of flashes) {
      expect(flash.getAttribute("aria-hidden")).toBe("true");
      expect(flash.getAttribute("class")).toContain("animate-status-flash");
      // Reduced motion holds a still tint instead (a11y P-R6-03).
      expect(flash.getAttribute("class")).toContain(
        "motion-reduce:animate-none",
      );
      expect(flash.getAttribute("class")).toContain("motion-reduce:opacity-10");
    }
    // The cue clears after a few seconds, in both modes.
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(services.querySelectorAll("[data-status-changed]")).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(services.querySelectorAll("[data-status-changed]")).toHaveLength(0);
    // The new headline settles in, and only where motion is welcome.
    expect(
      screen.getByRole("heading", { name: "All services are online" })
        .className,
    ).toContain("motion-safe:animate-in");
  });

  it("sets the footer and the stale Retry label at 13 pixels", async () => {
    vi.useFakeTimers();
    vi.mocked(apiRequest).mockRejectedValueOnce(new Error("offline"));
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{ ...status, footerText: "Northstar Games LLC" }}
      />,
    );
    const footer = screen.getByRole("contentinfo");
    expect(footer.firstElementChild!.className).toContain("text-[0.8125rem]");
    expect(footer.innerHTML).not.toContain("text-xs");
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.className).toContain("text-[0.8125rem]");
    expect(retry.className).not.toContain("text-xs");
  });

  it("rests past maintenance on one line and opens its details for everyone alike", () => {
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{
          ...status,
          maintenance: [
            {
              id: "past",
              title: "Host kernel update",
              message: "Kernel and firmware updates.",
              startsAt: now - 2 * 86_400_000,
              endsAt: now - 2 * 86_400_000 + 5_400_000,
              completedAt: null,
              componentIds: [],
              createdAt: now,
            },
          ],
        }}
      />,
    );
    const past = screen.getByRole("region", { name: "Past maintenance" });
    // The heading is the disclosure: the whole row opens it.
    const toggle = within(past).getByRole("button", {
      name: "Host kernel update",
    });
    expect(toggle.closest("h3")).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(
      toggle.getAttribute("aria-controls")!,
    )!;
    const hidden = (text: RegExp) =>
      within(past).getByText(text).closest("[hidden]") !== null;
    // At rest: the day and the title. The hours, length, reach, and note
    // are hidden from sighted visitors and screen readers alike (a11y
    // P-R6-04): no sr-only copy says more than the screen.
    expect(within(past).getByText(/^\w{3}, \w{3} \d+$/)).toBeTruthy();
    expect(hidden(/Lasted 1 hour 30 minutes/)).toBe(true);
    expect(hidden(/All services/)).toBe(true);
    expect(hidden(/Kernel and firmware updates\./)).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(
      [...past.querySelectorAll(".sr-only")].every(
        (el) => el.closest("[hidden]") !== null,
      ),
    ).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(hidden(/Lasted 1 hour 30 minutes/)).toBe(false);
    expect(hidden(/All services/)).toBe(false);
    expect(hidden(/Kernel and firmware updates\./)).toBe(false);
    expect(past.textContent).toMatch(/\d+:\d\d [AP]M\s?to \d+:\d\d [AP]M \S+/);
    expect(within(past).getByText("Affects").className).toContain("sr-only");
  });

  it("keeps every end and reach in view and folds the notes when several windows are in progress", () => {
    const note = "Restarting the daemon to apply new egress rules.";
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{
          ...status,
          // US Vanilla is down, so maintenance sits under its own heading.
          components: [
            ...status.components,
            {
              id: "store",
              name: "Store",
              groupName: "",
              health: "operational",
              observedAt: now,
            },
          ],
          maintenance: [
            status.maintenance[0],
            {
              ...status.maintenance[0],
              id: "w3",
              title: "Node restart",
              message: note,
              endsAt: now + 1_800_000,
              componentIds: ["store"],
            },
          ],
        }}
      />,
    );
    const active = screen.getByRole("region", {
      name: "Maintenance in progress",
    });
    for (const [title, text, reach] of [
      ["Monthly wipe", "Map reset.", "Affects EU Main"],
      ["Node restart", note, "Affects Store"],
    ]) {
      const toggle = within(active).getByRole("button", { name: title });
      const entry = toggle.closest("li")!;
      // Players reach Services sooner: the note waits behind the entry.
      expect(within(entry).getByText(text).closest("[hidden]")).not.toBeNull();
      // The end and what it affects never fold.
      expect(
        within(entry)
          .getByText(/^Back by/)
          .closest("[hidden]"),
      ).toBeNull();
      expect(entry.textContent).toContain(reach);
      fireEvent.click(toggle);
      expect(within(entry).getByText(text).closest("[hidden]")).toBeNull();
    }
  });

  it("names days in a window's hours as the admin does", () => {
    const startsAt = now + 2 * 3_600_000;
    const endsAt = startsAt + 24 * 3_600_000;
    render(
      <PublicStatusView
        data={{
          ...status,
          maintenance: [
            {
              ...status.maintenance[1],
              startsAt,
              endsAt,
            },
          ],
        }}
        logoUrl={null}
        now={now}
      />,
    );
    // The window ends on another day, so the end names it ("Tomorrow" or
    // the date) with the same rule as the admin's day labels.
    const times = [...document.querySelectorAll("time")].map(
      (t) => t.textContent,
    );
    expect(times).toContain(dayName(startsAt, now));
    expect(times.some((t) => t?.startsWith(`${dayName(endsAt, now)}, `))).toBe(
      true,
    );
  });

  it("folds one long note in progress and leaves a short one in view", () => {
    const long = "Map wipe and blueprint reset. ".repeat(6).trim();
    const { rerender } = render(
      <PublicStatusView
        data={{
          ...status,
          maintenance: [{ ...status.maintenance[0], message: long }],
        }}
        logoUrl={null}
        now={now}
      />,
    );
    expect(screen.getByText(long).closest("[hidden]")).not.toBeNull();
    rerender(<PublicStatusView data={status} logoUrl={null} now={now} />);
    expect(screen.getByText("Map reset.").closest("[hidden]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Monthly wipe" })).toBeNull();
  });

  // claude P-38: "3 of 5 online" above five visible rows repeated them. The
  // page count follows the roll-up rule: shown only while a group is
  // collapsed. CSS (`:has`) decides, so the test checks that contract.
  it("opens a service's uptime, response times, and incidents from its row", async () => {
    const hour = Math.floor(now / 3_600_000) * 3_600_000;
    const day = Math.floor(now / 86_400_000) * 86_400_000;
    const bucket = (start: number, down: number, latencyMs: number | null) => ({
      start,
      operational: 60 - down,
      degraded: 0,
      down,
      maintenance: 0,
      unknown: 0,
      latencyMs,
      latencyCount: latencyMs === null ? 0 : 60,
    });
    vi.mocked(apiRequest).mockResolvedValueOnce({
      now,
      hours: [bucket(hour - 3_600_000, 0, 120), bucket(hour, 6, 180)],
      days: [bucket(day, 6, 150)],
      incidents: [
        { startedAt: now - 600_000, endedAt: now - 240_000, worst: "down" },
      ],
    });
    render(<PublicStatusPage slug="northstar" initial={status} />);
    const row = screen.getByRole("button", { name: /^EU Main/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(row.getAttribute("aria-controls")!)!;
    expect(await within(panel).findByText("Recent incidents")).toBeTruthy();
    expect(apiRequest).toHaveBeenLastCalledWith(
      `public/status/northstar/components/${status.components[0].id}/history`,
    );
    // 114 of 120 minutes up over the day: never rounded up to 100%.
    expect(within(panel).getAllByText("95.00%").length).toBeGreaterThan(0);
    expect(within(panel).getByText("Average 150 ms")).toBeTruthy();
    expect(within(panel).getByText("Unavailable for 6 minutes")).toBeTruthy();
    fireEvent.click(row);
    expect(panel.hidden).toBe(true);
  });

  it("shows the announcement with its chosen icon and color", () => {
    const { rerender } = render(
      <PublicStatusView data={status} logoUrl={null} now={now} />,
    );
    const plain = screen.getByRole("note", { name: "Announcement" });
    expect(plain.className).not.toContain("border");
    expect(plain.querySelector("svg")!.getAttribute("class")).toContain(
      "text-muted-foreground",
    );
    rerender(
      <PublicStatusView
        data={{
          ...status,
          announcementIcon: "alert",
          announcementTone: "danger",
        }}
        logoUrl={null}
        now={now}
      />,
    );
    const red = screen.getByRole("note", { name: "Announcement" });
    expect(red.className).toContain("border-destructive/40");
    const glyph = red.querySelector("svg")!.getAttribute("class")!;
    expect(glyph).toContain("text-destructive");
    expect(glyph).toContain("lucide-triangle-alert");
  });

  it("titles the top bar with the operator's title, else the page name", () => {
    const { rerender } = render(
      <PublicStatusView
        data={{ ...status, headerTitle: "Northstar" }}
        logoUrl={null}
        now={now}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Northstar",
    );
    rerender(
      <PublicStatusView
        data={{ ...status, headerTitle: "  " }}
        logoUrl={null}
        now={now}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      status.name,
    );
  });

  it("places the logo left, center, or right, and sizes a logo title", () => {
    const view = (data: Partial<PublicStatus>) => (
      <PublicStatusView
        data={{ ...status, logoVersion: 3, ...data }}
        logoUrl="/logo.png"
        now={now}
      />
    );
    const { rerender } = render(view({}));
    const header = () => screen.getByRole("banner");
    expect(header().className).toContain("@min-[40rem]:justify-between");
    expect(header().className).not.toContain("flex-row-reverse");
    rerender(view({ logoAlign: "right" }));
    expect(header().className).toContain("@min-[40rem]:flex-row-reverse");
    rerender(view({ logoAlign: "center" }));
    expect(header().className).toContain("items-center");
    expect(header().className).toContain(
      "@min-[40rem]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]",
    );
    // Links and support stay reachable in every position.
    expect(
      within(header()).getByRole("link", { name: "Contact support" }),
    ).toBeTruthy();
    // A logo standing in for the title takes the chosen size.
    rerender(view({ showName: false, logoSize: "large" }));
    const logo = within(header()).getByRole("img", { name: status.name });
    expect(logo.getAttribute("class")).toContain("h-16");
    rerender(view({ showName: false, logoSize: "small" }));
    expect(
      within(header())
        .getByRole("img", { name: status.name })
        .getAttribute("class"),
    ).toContain("h-10");
  });

  it("uses the logo as the title when the name is turned off", () => {
    const { rerender } = render(
      <PublicStatusView
        data={{ ...status, showName: false, logoVersion: 3 }}
        logoUrl="/logo.png"
        now={now}
      />,
    );
    const title = screen.getByRole("heading", { level: 1 });
    expect(title.textContent).toBe("");
    expect(within(title).getByRole("img", { name: status.name })).toBeTruthy();
    // Without a logo the name always shows.
    rerender(
      <PublicStatusView
        data={{ ...status, showName: false }}
        logoUrl={null}
        now={now}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      status.name,
    );
  });

  it("shows the page count only while a group hides its rows", () => {
    const fleet = Array.from({ length: 9 }, (_, i) => ({
      id: `s${i}`,
      name: `Server ${i}`,
      groupName: i < 6 ? "EU" : "US",
      health: i === 7 ? ("down" as const) : ("operational" as const),
      observedAt: now,
    }));
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{ ...status, components: fleet, maintenance: [] }}
      />,
    );
    const services = screen.getByRole("region", { name: "Services" });
    const count = screen.getByTestId("services-count");
    expect(count.textContent).toBe("8 of 9 online");
    expect(count.className.split(" ")).toContain("hidden");
    expect(count.className).toContain(
      "group-has-[button[data-group-toggle][aria-expanded=false]]/services:block",
    );
    expect(services.className.split(" ")).toContain("group/services");
    const hiding = ":has(button[data-group-toggle][aria-expanded=false])";
    expect(services.matches(hiding)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "EU" }));
    expect(services.matches(hiding)).toBe(false);
  });

  it("shows a group's roll-up only while its rows are out of sight", () => {
    const fleet = Array.from({ length: 9 }, (_, i) => ({
      id: `s${i}`,
      name: `Server ${i}`,
      groupName: i < 6 ? "EU" : "US",
      health: i === 7 ? ("down" as const) : ("operational" as const),
      observedAt: now,
    }));
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{ ...status, components: fleet, maintenance: [] }}
      />,
    );
    const rollup = (name: string) =>
      document.getElementById(
        screen.getByRole("button", { name }).getAttribute("aria-describedby")!,
      )!;
    // Collapsed: the roll-up stands in for the hidden rows.
    expect(rollup("EU").textContent).toBe("6 of 6 online");
    expect(rollup("EU").className).not.toContain("sr-only");
    // Open: the rows say it, so the roll-up is only the button's description.
    expect(rollup("US").textContent).toBe("2 of 3 online");
    expect(rollup("US").className).toContain("sr-only");
    fireEvent.click(screen.getByRole("button", { name: "EU" }));
    expect(rollup("EU").className).toContain("sr-only");
    cleanup();
    // A collapsed group names maintenance in its roll-up, so the Services
    // header needs no count of its own (claude D-94 discussion, a11y R8).
    render(
      <PublicStatusPage
        slug="northstar"
        initial={{
          ...status,
          components: fleet,
          maintenance: [
            {
              id: "w9",
              title: "EU wipe",
              message: "",
              startsAt: now - 60_000,
              endsAt: now + 3_600_000,
              completedAt: null,
              componentIds: ["s1", "s2"],
              createdAt: now,
            },
          ],
        }}
      />,
    );
    expect(rollup("EU").textContent).toBe("4 of 6 online, 2 under maintenance");
    // It opens to show the affected rows; closed, the roll-up says it.
    expect(
      screen.getByRole("button", { name: "EU" }).getAttribute("aria-expanded"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "EU" }));
    expect(rollup("EU").className).not.toContain("sr-only");
    cleanup();
    // A group that can't collapse shows its rows and no roll-up at all.
    render(<PublicStatusPage slug="northstar" initial={status} />);
    const services = screen.getByRole("region", { name: "Services" });
    expect(within(services).getAllByText(/online/)).toHaveLength(1);
  });
});
