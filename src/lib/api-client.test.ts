import { afterEach, expect, it, vi } from "vitest";
import { apiRequest } from "./api-client";
afterEach(() => vi.unstubAllGlobals());
it("shows a readable error for a non-JSON response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("Failed to deserialize private details", { status: 422 }),
    ),
  );
  await expect(apiRequest("auth/signup", {})).rejects.toThrow(
    "Cupboard returned an unexpected response. Try again shortly.",
  );
});
it("preserves structured API validation errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: "Use a password of 8 to 128 characters." },
        { status: 400 },
      ),
    ),
  );
  await expect(apiRequest("auth/signup", {})).rejects.toThrow(
    "Use a password of 8 to 128 characters.",
  );
});
