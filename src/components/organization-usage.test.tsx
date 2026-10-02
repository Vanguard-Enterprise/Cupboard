// @vitest-environment jsdom
import { render, screen, cleanup, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrganizationUsage } from "./organization-usage";
import { OrganizationProvider } from "./organization-provider";
import { PreviewStorageProvider, previewStorageKey } from "./preview-storage";
import {
  defaultOrganizationProfile,
  organizationProfileKey,
} from "@/lib/organization-profile";

const key = (account = "alice", org = "one") =>
  previewStorageKey(account, org, organizationProfileKey);
function view(account = "alice", org = "one") {
  return (
    <PreviewStorageProvider accountId={account} organizationId={org}>
      <OrganizationProvider>
        <OrganizationUsage />
      </OrganizationProvider>
    </PreviewStorageProvider>
  );
}
beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("Billing and usage", () => {
  it("filters the chart, totals, date range, and accessible daily table together", async () => {
    const user = userEvent.setup();
    render(view());
    expect(screen.queryByText(/sample data/i)).toBeNull();
    expect(
      screen
        .getByRole("radio", { name: "14 days" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByRole("img", { name: /Sep 2 – Sep 15/ })).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Show daily activity" }),
    );
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(15);
    await user.click(screen.getByRole("radio", { name: "7 days" }));
    expect(screen.getByRole("img", { name: /Sep 9 – Sep 15/ })).toBeTruthy();
    expect(screen.getByText("480", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("168", { selector: "dd" })).toBeTruthy();
    expect(within(table).getAllByRole("row")).toHaveLength(8);
    expect(within(table).queryByText("Sep 8")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "30 days" }));
    expect(screen.getByRole("img", { name: /Aug 17 – Sep 15/ })).toBeTruthy();
    expect(within(table).getAllByRole("row")).toHaveLength(31);
  });

  it("shows used and remaining capacity with determinate accessible meters", () => {
    render(view());
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
    const members = screen.getByRole("progressbar", {
      name: "Team members capacity",
    });
    expect(members.getAttribute("aria-valuenow")).toBe("80");
    expect(members.getAttribute("aria-valuetext")).toBe("8 of 10; 80% used");
    expect(screen.getByText("2 seats available")).toBeTruthy();
    expect(screen.getByText("17.6 GB available")).toBeTruthy();
  });

  it("reads billing details from saved profile, refreshes them, and isolates accounts and organizations", () => {
    localStorage.setItem(
      key(),
      JSON.stringify({
        ...defaultOrganizationProfile,
        legalName: "First community",
        billingEmail: "billing@example.com",
        addressLine1: "10 Main Street",
        city: "London",
        country: "United Kingdom",
        privateEmail: "private@example.com",
      }),
    );
    const rendered = render(view());
    expect(screen.getByText("First community")).toBeTruthy();
    expect(screen.getByText("billing@example.com")).toBeTruthy();
    expect(screen.getByText(/10 Main Street/).textContent).toContain(
      "United Kingdom",
    );
    expect(screen.queryByText("private@example.com")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Edit billing details" })
        .getAttribute("href"),
    ).toBe("/dashboard/organization/settings/profile#billing-heading");
    act(() => {
      localStorage.setItem(
        key(),
        JSON.stringify({
          ...defaultOrganizationProfile,
          legalName: "Updated community",
        }),
      );
      window.dispatchEvent(new StorageEvent("storage", { key: key() }));
    });
    expect(screen.getByText("Updated community")).toBeTruthy();
    rendered.rerender(view("alice", "two"));
    expect(screen.queryByText("Updated community")).toBeNull();
    expect(screen.getAllByText("Not provided")).toHaveLength(3);
    rendered.rerender(view("bob", "one"));
    expect(screen.queryByText("Updated community")).toBeNull();
    rendered.rerender(view());
    expect(screen.getByText("Updated community")).toBeTruthy();
  });

  it("shows missing billing values without inventing payment or subscription details", () => {
    render(view());
    expect(screen.getAllByText("Not provided")).toHaveLength(3);
    expect(
      screen.queryByText(/\$|Visa|Mastercard|Free plan|paid invoice/i),
    ).toBeNull();
  });

  it("reports unreadable billing data instead of showing default details as saved", () => {
    localStorage.setItem(key(), "bad json");
    render(view());
    expect(screen.getByRole("alert").textContent).toContain(
      "Saved billing details could not be loaded",
    );
    expect(screen.queryByText("Not provided")).toBeNull();
  });
});
