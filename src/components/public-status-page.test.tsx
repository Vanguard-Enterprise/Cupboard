// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicStatusPage } from "./public-status-page";
import type { PublicStatus } from "@/lib/status-page";
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
  it("shows the worst status, maintenance, and the support link", () => {
    render(<PublicStatusPage slug="northstar" initial={status} />);
    expect(screen.getByText("1 target unavailable")).toBeTruthy();
    expect(screen.getByText("Wipe on Thursday.")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Contact support" })
        .getAttribute("href"),
    ).toBe("https://discord.gg/northstar");
    expect(screen.getByText("Under maintenance")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(
      screen.getByText(/Maintenance in progress: Monthly wipe/),
    ).toBeTruthy();
    expect(screen.getByText("Scheduled maintenance")).toBeTruthy();
    expect(screen.getByText("Host reboot")).toBeTruthy();
    expect(screen.queryByText("Past maintenance")).toBeNull();
  });

  it("applies the page branding", () => {
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
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/app-api/public/status/northstar/logo?v=9",
    );
    const support = screen.getByRole("link", { name: "Contact support" });
    expect(support.style.color).toBe("rgb(255, 255, 255)");
    expect(
      screen.getByRole("link", { name: "Store" }).getAttribute("href"),
    ).toBe("https://store.northstar.example");
    expect(screen.getByText("Northstar Games LLC")).toBeTruthy();
    expect(screen.queryByText("Powered by")).toBeNull();
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

  it("refreshes from the public endpoint and keeps the last state on failure", async () => {
    vi.useFakeTimers();
    vi.mocked(apiRequest).mockRejectedValueOnce(new Error("offline"));
    render(<PublicStatusPage slug="northstar" initial={status} />);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apiRequest).toHaveBeenCalledWith("public/status/northstar");
    expect(screen.getByText("1 target unavailable")).toBeTruthy();
    expect(screen.getByText(/Refresh failed/)).toBeTruthy();
    vi.mocked(apiRequest).mockResolvedValueOnce({
      ...status,
      components: status.components.map((c) => ({
        ...c,
        health: "operational" as const,
      })),
      maintenance: [],
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(screen.getByText("All targets operational")).toBeTruthy();
    expect(screen.queryByText(/Refresh failed/)).toBeNull();
  });
});
