// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
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
    expect(screen.queryByRole("tab")).toBeNull();
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

    const connected = screen.getByRole("region", {
      name: "Connected services",
    });
    expect(within(connected).getAllByRole("listitem")[0].textContent).toContain(
      "Pelican Panel",
    );
    expect(within(connected).getAllByRole("listitem")).toHaveLength(2);

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
    expect(document.activeElement).toBe(search);
    expect(screen.getByText("Pelican Panel")).toBeTruthy();
  });

  it("moves focus to catalog search from Browse connections", async () => {
    const user = userEvent.setup();
    mount();
    const browse = screen.getByRole("button", { name: "Browse connections" });
    browse.focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(
      screen.getByRole("searchbox", { name: "Search available connections" }),
    );
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

    const setupCloudflare = screen.getByRole("button", {
      name: "View Cloudflare requirements",
    });
    setupCloudflare.focus();
    await user.keyboard("{Enter}");
    const setupDialog = screen.getByRole("dialog");
    expect(setupDialog).toBeTruthy();
    const describedBy = setupDialog.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      "sample data",
    );
    const dialogTitle = screen.getByText("Cloudflare requirements");
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

    expect(document.activeElement).toBe(setupCloudflare);
    await user.click(
      screen.getByRole("button", { name: "View Discord details" }),
    );
    expect(screen.getByText("Discord connection")).toBeTruthy();
    expect(
      screen.getByText(
        "This status is sample data. Cupboard has not checked or changed this account.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Access")).toBeTruthy();
    expect(
      within(screen.getByRole("dialog")).getByText("Northstar Rust"),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/API key|password|token/i)).toBeNull();
    expect(screen.getAllByText("Sync healthy")).toHaveLength(2);
    expect(screen.getByText("Read server and role details")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(
      screen.getByRole("button", { name: "View Pelican Panel details" }),
    );
    expect(screen.getByText("Pelican Panel connection")).toBeTruthy();
    expect(screen.getAllByText("API key rejected")).toHaveLength(2);
    expect(screen.getByText("Send approved power actions")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "View Pelican Panel details" }),
    );
  });
});
