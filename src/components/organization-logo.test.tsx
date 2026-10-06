// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrganizationLogo } from "./organization-logo";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("loads only the active organization's saved PNG and refreshes after save", async () => {
  let id: string | null = "first";
  const fetcher = vi.fn(async (path: string) =>
    path === "/app-api/organization-logo"
      ? Response.json({ id, revision: 1 })
      : new Response(new Blob(["png"], { type: "image/png" })),
  );
  vi.stubGlobal("fetch", fetcher);
  URL.createObjectURL = vi.fn(() => "blob:saved-logo");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(
    () => {},
  );
  const view = render(<OrganizationLogo organizationId="org-a" />);
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/app-api/organization-logo/first",
      expect.objectContaining({
        headers: { "X-Cupboard-Organization": "org-a" },
      }),
    ),
  );
  await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
  id = "second";
  act(() => {
    window.dispatchEvent(
      new CustomEvent("cupboard-logo-saved", { detail: "other-org" }),
    );
  });
  expect(fetcher.mock.calls).toHaveLength(2);
  act(() => {
    window.dispatchEvent(
      new CustomEvent("cupboard-logo-saved", { detail: "org-a" }),
    );
  });
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/app-api/organization-logo/second",
      expect.anything(),
    ),
  );
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:saved-logo");
  id = null;
  act(() => {
    window.dispatchEvent(
      new CustomEvent("cupboard-logo-saved", { detail: "org-a" }),
    );
  });
  await waitFor(() => expect(fetcher.mock.calls).toHaveLength(5));
  view.unmount();
});
