// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileThumbnail } from "./file-thumbnail";
let intersect: (entries: { isIntersecting: boolean }[]) => void;
beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof intersect) {
        intersect = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:thumbnail"),
    revokeObjectURL: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("loads visible raster previews with tenant authorization and releases them", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
    );
  const page = render(
    <FileThumbnail
      id="image"
      organization="org"
      fallback={<span>File icon</span>}
    />,
  );
  expect(fetcher).not.toHaveBeenCalled();
  intersect([{ isIntersecting: true }]);
  await waitFor(() =>
    expect(page.container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:thumbnail",
    ),
  );
  expect(fetcher.mock.calls[0][1]?.headers).toEqual({
    "X-Cupboard-Organization": "org",
  });
  expect(URL.createObjectURL).toHaveBeenCalledWith(
    expect.objectContaining({ type: "image/png" }),
  );
  page.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail");
  expect((fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
});
it.each([
  new Response("<svg onload='alert(1)'/>"),
  new Response("denied", { status: 403 }),
])(
  "keeps an icon for unsupported content or denied requests",
  async (response) => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const page = render(
      <FileThumbnail
        id="image"
        organization="other-org"
        fallback={<span>File icon</span>}
      />,
    );
    intersect([{ isIntersecting: true }]);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(page.container.querySelector("img")).toBeNull();
  },
);
