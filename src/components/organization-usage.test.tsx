import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrganizationUsage } from "./organization-usage";

describe("Organization usage", () => {
  it("labels sample metrics and exposes each usage meter", () => {
    const html = renderToStaticMarkup(<OrganizationUsage />);

    expect(html).toContain("Preview data");
    expect(html).toContain("Live metering is not connected");
    expect(html).toContain("Managed servers");
    expect(html).toContain('aria-label="Game servers usage"');
    expect(html).toContain('aria-valuenow="60"');
    expect(html).toContain('aria-label="AI actions usage"');
  });
});
