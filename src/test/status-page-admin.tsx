// Shared fixtures for the status page admin tests, split across files so
// Vitest can run them in parallel. Each test file mocks the modules itself.
import { TooltipProvider } from "@/components/ui/tooltip";
import { UnsavedChangesProvider } from "@/components/ui/unsaved-changes";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { StatusPageAdmin } from "@/components/status-page";
import { apiRequest, type Identity } from "@/lib/api-client";
import type { MaintenanceWindow, StatusPageState } from "@/lib/status-page";
import { toast } from "sonner";

export const identity: Identity = {
  user: { id: "operator", name: "Operator", email: "operator@example.com" },
  organization: { id: "org-one", name: "Northstar Games" },
  organizations: [],
  membershipId: "member",
  permissions: ["infrastructure.view", "infrastructure.manage"],
};
export const empty: StatusPageState = {
  revision: 0,
  name: "Northstar Games",
  slug: "northstar-games",
  published: false,
  announcement: "",
  supportUrl: "",
  theme: "dark",
  accentColor: "#7cb58d",
  font: "geist",
  links: [],
  footerText: "",
  poweredBy: true,
  logoVersion: null,
  components: [],
  maintenance: [],
  sources: [
    { id: "server-eu", name: "Rust EU", kind: "server", tags: [] },
    {
      id: "machine-1",
      name: "use1-wings-01",
      kind: "machine",
      tags: ["wings"],
    },
  ],
  tags: [
    { id: "wings", name: "Wings" },
    { id: "game-server", name: "Game server" },
  ],
};
export const now = Date.now();
export const live: StatusPageState = {
  ...empty,
  revision: 2,
  published: true,
  components: [
    {
      id: "c-eu",
      name: "EU main",
      kind: "server",
      sourceId: "server-eu",
      sourceName: "Rust EU",
      tagId: "game-server",
      groupName: "Game server",
      public: true,
      health: "operational",
      observedAt: now - 10_000,
      detail: null,
    },
    {
      id: "c-host",
      name: "Wings host",
      kind: "machine",
      sourceId: "machine-1",
      sourceName: "use1-wings-01",
      tagId: "",
      groupName: "",
      public: false,
      health: "down",
      observedAt: now - 300_000,
      detail: null,
    },
  ],
  maintenance: [
    {
      id: "w-1",
      title: "Monthly wipe",
      message: "Map and blueprints reset.",
      startsAt: now - 60_000,
      endsAt: now + 3_600_000,
      completedAt: null,
      componentIds: ["c-eu"],
      createdAt: now - 120_000,
    },
  ],
};

export function registerStatusPageHooks() {
  // Frames still waiting when a test ends would run after the file's jsdom
  // window is gone, so each test cancels its own.
  const frames = new Set<ReturnType<typeof setTimeout>>();
  beforeEach(() => {
    // jsdom runs animation frames on one setInterval, made by the first
    // request. Made while a test fakes setInterval, it dies with the fake
    // timers and no frame runs again in this file. Frames on setTimeout,
    // looked up per call, survive that.
    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
      const frame = setTimeout(() => {
        frames.delete(frame);
        run(performance.now());
      }, 16);
      frames.add(frame);
      return frame;
    });
    vi.stubGlobal(
      "cancelAnimationFrame",
      (frame: ReturnType<typeof setTimeout>) => {
        frames.delete(frame);
        clearTimeout(frame);
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(apiRequest).mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    for (const frame of frames) clearTimeout(frame);
    frames.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}
export const mount = (who = identity) =>
  render(
    // The workspace's leave guard, as `workspace.tsx` mounts it.
    <UnsavedChangesProvider>
      <TooltipProvider>
        <StatusPageAdmin identity={who} />
      </TooltipProvider>
    </UnsavedChangesProvider>,
  );
export const ready = () =>
  waitFor(() =>
    expect(screen.queryByLabelText("Loading status page")).toBeNull(),
  );

/** The save bar says "Saved", in its status region. */
export const savedInBar = () =>
  waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Changes saved" })).getByRole(
        "status",
      ).textContent,
    ).toContain("Saved"),
  );
/** A polite live region on the page says `text`. */
export const said = (text: string) =>
  waitFor(() =>
    expect(
      [...document.querySelectorAll('[aria-live="polite"]')].some((element) =>
        element.textContent?.includes(text),
      ),
    ).toBe(true),
  );

/** jsdom has no image decoding or canvas, so give the logo editor stand-ins. */
export function stubImages() {
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 600;
      naturalHeight = 300;
      decoding = "auto";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  let next = 0;
  URL.createObjectURL = vi.fn(() => `blob:logo-${++next}`);
  URL.revokeObjectURL = vi.fn();
  const context = new Proxy({}, { get: () => vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,",
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(new Blob(["png"], { type: "image/png" })),
  );
}

export const old: MaintenanceWindow = {
  id: "w-old",
  title: "Database migration",
  message: "",
  startsAt: now - 9 * 86_400_000,
  endsAt: now - 9 * 86_400_000 + 3_600_000,
  completedAt: null,
  componentIds: [],
  createdAt: now - 10 * 86_400_000,
};
export const hiddenOnly: MaintenanceWindow = {
  id: "w-hidden",
  title: "Host firmware",
  message: "",
  startsAt: now + 86_400_000,
  endsAt: now + 86_400_000 + 3_600_000,
  completedAt: null,
  componentIds: ["c-host"],
  createdAt: now - 60_000,
};
export const conflictError = new Error(
  "The status page changed in another session. Reload it before saving again.",
);
