// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiscordInstallCallback } from "./discord-install-callback";
import type { Identity } from "@/lib/api-client";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }),
}));

const identity: Identity = {
  user: { id: "operator", name: "Operator", email: "operator@example.com" },
  organization: { id: "org", name: "Rust community" },
  organizations: [],
  membershipId: "member",
  permissions: ["community.view", "integrations.manage"],
};
beforeEach(() => {
  vi.restoreAllMocks();
  push.mockReset();
});
afterEach(() => cleanup());

it("completes the install once and returns to the guild list", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ id: "130000000000000001" }));
  render(
    <StrictMode>
      <DiscordInstallCallback
        identity={identity}
        code="code"
        state="state"
        guildId="130000000000000001"
      />
    </StrictMode>,
  );
  await vi.waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      "/dashboard/community/discord?added=130000000000000001",
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [path, init] = fetcher.mock.calls[0]!;
  expect(path).toBe("/app-api/discord/install");
  expect(JSON.parse(init?.body as string)).toEqual({
    code: "code",
    state: "state",
    guildId: "130000000000000001",
  });
});

it("reports a cancelled or failed install without calling Cupboard", () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  render(<DiscordInstallCallback identity={identity} error="access_denied" />);
  expect(screen.getByRole("alert").textContent).toContain("cancelled");
  cleanup();
  render(<DiscordInstallCallback identity={identity} state="state" />);
  expect(screen.getByRole("alert").textContent).toContain(
    "didn’t return a complete installation",
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Back to Discord" })).toBeTruthy();
});

it("shows Cupboard's reason when the install is refused", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      { error: "This Discord installation expired or was started elsewhere." },
      { status: 400 },
    ),
  );
  render(
    <DiscordInstallCallback identity={identity} code="code" state="state" />,
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "expired or was started elsewhere",
  );
});
