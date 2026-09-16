// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { OrganizationConnections } from "./organization-connections";
import { TooltipProvider } from "./ui/tooltip";

afterEach(cleanup);

function mount() {
  return render(
    <TooltipProvider>
      <OrganizationConnections />
    </TooltipProvider>,
  );
}

describe("Organization connections", () => {
  it("labels preview data and filters available connections", async () => {
    const user = userEvent.setup();
    mount();

    expect(screen.queryByText("Preview only")).toBeNull();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("Pterodactyl")).toBeTruthy();
    expect(screen.getByText("Cloudflare")).toBeTruthy();

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

    await user.hover(screen.getByRole("button", { name: "About sample data" }));
    expect(
      await screen.findByText(/no external accounts are connected/i),
    ).toBeTruthy();

    const browse = screen.getByRole("button", { name: "Browse connections" });
    await user.click(browse);

    const search = screen.getByRole("searchbox", {
      name: "Search available connections",
    });
    expect(document.activeElement).toBe(search);
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

  it("opens concise setup and connected-service details", async () => {
    const user = userEvent.setup();
    mount();

    await user.click(screen.getByRole("button", { name: "Set up Cloudflare" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    const dialogTitle = screen.getByText("Connect Cloudflare");
    expect(document.activeElement).toBe(dialogTitle);
    expect(screen.getByText("Requirements")).toBeTruthy();
    expect(screen.getByText("Scoped API token")).toBeTruthy();
    expect(screen.getByText("Selected zone access")).toBeTruthy();
    expect(screen.queryByText("Preview data")).toBeNull();
    expect(screen.queryByText(/preview/i)).toBeNull();
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.getAttribute("data-variant")).toBe("secondary");
    await user.click(close);

    expect(screen.getByRole("button", { name: "Manage Discord" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Resolve Pelican Panel" }),
    ).toBeTruthy();

    await user.click(screen.getByText("Community roles and moderation events"));
    expect(screen.getByText("Discord connection")).toBeTruthy();
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
