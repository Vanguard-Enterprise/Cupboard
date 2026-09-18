// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationConnections } from "./organization-connections";
import { TooltipProvider } from "./ui/tooltip";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount() {
  return render(
    <TooltipProvider>
      <OrganizationConnections />
    </TooltipProvider>,
  );
}

describe("Organization connections", () => {
  it("filters available connections", async () => {
    const user = userEvent.setup();
    mount();

    expect(screen.queryByText("Preview only")).toBeNull();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.queryByText("Pterodactyl")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Available" }));
    expect(screen.getByText("Pterodactyl")).toBeTruthy();
    expect(screen.getByText("Cloudflare")).toBeTruthy();

    expect(screen.queryByText(/sample data/i)).toBeNull();
    for (const category of [
      "Server management",
      "Player activity",
      "Network",
      "Source control",
    ]) {
      const categoryBadge = screen.getByText(category);
      expect(categoryBadge.className).toContain("text-text-muted");
      expect(categoryBadge.className).not.toContain("text-text-muted/80");
    }

    const available = screen.getByRole("region", {
      name: "Available connections",
    });
    const catalogGrid = available.querySelector("ul")!;
    expect(catalogGrid.className).toContain("md:grid-cols-2");
    expect(catalogGrid.className).toContain("2xl:grid-cols-4");
    expect(catalogGrid.className).not.toContain("grid-cols-3");
    expect(available.querySelectorAll("li")).toHaveLength(4);
    for (const card of available.querySelectorAll("li")) {
      expect(card.className).toContain("h-[184px]");
    }

    const search = screen.getByRole("searchbox", {
      name: "Search available connections",
    });
    expect(screen.queryByText("Search available connections")).toBeNull();
    await user.type(search, "network");

    expect(screen.getByText("Cloudflare")).toBeTruthy();
    expect(screen.queryByText("Pterodactyl")).toBeNull();

    await user.clear(search);
    await user.type(search, "missing");
    expect(screen.getByText("No connections found")).toBeTruthy();
    const clearSearch = screen.getByRole("button", { name: "Clear search" });
    expect(clearSearch.getAttribute("data-variant")).toBe("secondary");
    expect(clearSearch.closest("div")?.className).not.toContain(
      "border-dashed",
    );
    await user.click(clearSearch);
    expect(screen.getByText("Pterodactyl")).toBeTruthy();
  });

  it("filters connections independently of the browser locale", async () => {
    const localeLowerCase = String.prototype.toLocaleLowerCase;
    vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(
      function (this: string) {
        return localeLowerCase.call(this, "tr-TR");
      },
    );
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole("tab", { name: "Available" }));
    await user.type(
      screen.getByRole("searchbox", {
        name: "Search available connections",
      }),
      "BATTLEMETRICS",
    );

    expect(screen.getByText("BattleMetrics")).toBeTruthy();
  });

  it("opens concise setup and connected-service details", async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole("tab", { name: "Available" }));
    const setupCloudflare = screen.getByRole("button", {
      name: "Set up Cloudflare",
    });
    setupCloudflare.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    const dialogTitle = screen.getByText("Connect Cloudflare");
    expect(document.activeElement).toBe(dialogTitle);
    expect(dialogTitle.className).toContain("focus-visible:ring-2");
    expect(dialogTitle.className).toContain("focus-visible:ring-ring/50");
    expect(screen.getByText("Requirements")).toBeTruthy();
    expect(screen.getByText("Scoped API token")).toBeTruthy();
    expect(screen.getByText("Selected zone access")).toBeTruthy();
    expect(
      screen.getByText(
        "These requirements are sample data. Cupboard will not request credentials or connect this account.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Preview data")).toBeNull();
    expect(screen.queryByText(/preview/i)).toBeNull();
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.getAttribute("data-variant")).toBe("secondary");
    await user.click(close);

    await user.click(screen.getByRole("tab", { name: "Connected" }));

    expect(
      screen.getByRole("button", {
        name: "Manage Discord",
        description:
          /Connected.*Community roles and moderation events.*Northstar Rust.*Sync healthy.*Checked 2 minutes ago/i,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Resolve Pelican Panel",
        description:
          /Needs attention.*Server status and power controls.*Operations panel.*API key rejected.*Checked 18 minutes ago/i,
      }),
    ).toBeTruthy();

    await user.click(screen.getByText("Community roles and moderation events"));
    expect(screen.getByText("Discord connection")).toBeTruthy();
    expect(
      screen.getByText(
        "This status is sample data. Cupboard has not checked or changed this account.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Access")).toBeTruthy();
    expect(screen.getAllByText("Sync healthy")).toHaveLength(2);
    expect(screen.getByText("Read server and role details")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(
      screen.getByRole("button", { name: "Resolve Pelican Panel" }),
    );
    expect(screen.getByText("Pelican Panel connection")).toBeTruthy();
    expect(screen.getAllByText("API key rejected")).toHaveLength(2);
    expect(screen.getByText("Send approved power actions")).toBeTruthy();
  });
});
