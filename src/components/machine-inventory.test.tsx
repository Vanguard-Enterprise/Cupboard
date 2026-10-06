// @vitest-environment jsdom
import {
  act,
  cleanup,
  render as renderView,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { toast } from "sonner";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MachineInventory } from "./machine-inventory";
import { machineStatus, type Machine } from "@/lib/machines";
import type { Identity } from "@/lib/api-client";
import { TooltipProvider } from "@/components/ui/tooltip";
const render = (ui: Parameters<typeof renderView>[0]) =>
  renderView(<TooltipProvider>{ui}</TooltipProvider>);
const identity: Identity = {
  user: { id: "operator", name: "Operator", email: "operator@example.com" },
  organization: { id: "org", name: "Rust community" },
  organizations: [],
  membershipId: "member",
  permissions: ["infrastructure.view", "infrastructure.manage"],
};
const machine: Machine = {
  id: "machine",
  name: "EU host",
  address: "192.0.2.12",
  provider: "Dedicated",

  notes: "Rack 2",
  revision: 1,
  enrolled: false,
  enrolledAt: null,
  enrollmentExpiresAt: null,
  lastSeenAt: null,
  health: null,
};
beforeEach(() => vi.restoreAllMocks());
afterEach(() => cleanup());
it("links to the persistent setup page", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));
  render(<MachineInventory identity={identity} />);
  await screen.findByText("No machines yet");
  expect(
    screen.getByRole("link", { name: "Add machine" }).getAttribute("href"),
  ).toBe("/dashboard/infrastructure/machines/setup");
});
it("sends the original revision and preserves edits when another operator changed the record", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([machine]))
    .mockResolvedValueOnce(
      Response.json(
        { error: "Machine changed. Cancel and refresh." },
        { status: 409 },
      ),
    );
  const user = userEvent.setup();
  render(<MachineInventory identity={identity} />);
  await user.click(await screen.findByRole("button", { name: machine.name }));
  await user.click(screen.getByRole("button", { name: "Machine details" }));
  await user.click(screen.getByRole("button", { name: "Edit machine" }));
  await user.type(screen.getByLabelText("Machine name"), " edited");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Machine changed. Cancel and refresh.");
  expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string).revision).toBe(1);
  expect(
    (screen.getByLabelText("Machine name") as HTMLInputElement).value,
  ).toBe("EU host edited");
});
it("requires enrollment confirmation, shows its token once, and clears it when closed", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([machine]))
    .mockResolvedValueOnce(
      Response.json({
        token: "one-time-token",
        expiresAt: Date.now() + 600000,
        issuedAt: Date.now(),
      }),
    )
    .mockResolvedValueOnce(Response.json([machine]));
  const user = userEvent.setup();
  render(<MachineInventory identity={identity} />);
  await user.click(await screen.findByRole("button", { name: machine.name }));
  await user.click(screen.getByRole("button", { name: "Machine details" }));
  await user.click(screen.getByRole("button", { name: "Enroll agent" }));
  expect(screen.queryByLabelText("Enrollment token")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Generate token" }));
  await screen.findByDisplayValue("one-time-token");
  expect(localStorage.length).toBe(0);
  await user.click(screen.getByRole("button", { name: "Close enrollment" }));
  expect(screen.queryByDisplayValue("one-time-token")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Machine details" }));
  await user.click(screen.getByRole("button", { name: "Enroll agent" }));
  expect(screen.queryByDisplayValue("one-time-token")).toBeNull();
});
it("keeps old readings after an automatic refresh failure and supports search", async () => {
  const toastError = vi.spyOn(toast, "error");
  const intervals = vi.spyOn(globalThis, "setInterval");
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([machine]))
    .mockRejectedValueOnce(new Error("Network unavailable"));
  const user = userEvent.setup();
  render(<MachineInventory identity={identity} />);
  await screen.findByRole("button", { name: machine.name });
  await act(async () => {
    const poll = intervals.mock.calls.find(
      (call) => call[1] === 30000,
    )?.[0] as () => void;
    poll();
  });
  await waitFor(() =>
    expect(toastError).toHaveBeenCalledWith(
      "Couldn’t refresh machines.",
      expect.objectContaining({ duration: 4000, position: "top-right" }),
    ),
  );
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.queryByText(/Machine readings may be out of date/)).toBeNull();
  expect(screen.getByRole("button", { name: machine.name })).not.toBeNull();
  await user.type(
    screen.getByRole("textbox", { name: "Search machines" }),
    "not-present",
  );
  expect(screen.getByText("No machines match your search.")).not.toBeNull();
});
it("uses keyboard menus and confirms disconnect before revoking the agent", async () => {
  const connected = { ...machine, enrolled: true, lastSeenAt: Date.now() };
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([connected]))
    .mockResolvedValueOnce(Response.json({ disconnected: true }))
    .mockResolvedValueOnce(Response.json([machine]));
  const user = userEvent.setup();
  render(<MachineInventory identity={identity} />);
  const actions = await screen.findByRole("button", {
    name: "Actions for EU host",
  });
  actions.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menuitem", { name: "Disconnect" });
  await user.keyboard("{End}{Enter}");
  await screen.findByRole("dialog");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Disconnect agent" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(fetcher.mock.calls[1][0]).toBe("/app-api/machines/machine/disconnect");
});
it("hides management from viewers and does not load without viewing permission", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json([machine]));
  const { unmount } = render(
    <MachineInventory
      identity={{ ...identity, permissions: ["infrastructure.view"] }}
    />,
  );
  await screen.findByRole("button", { name: machine.name });
  expect(screen.queryByRole("button", { name: "Add machine" })).toBeNull();
  unmount();
  fetcher.mockClear();
  render(<MachineInventory identity={{ ...identity, permissions: [] }} />);
  expect(
    screen.getByText(/You need infrastructure viewing permission/),
  ).not.toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it("distinguishes enrollment, missing reports, and stale observations", () => {
  expect(machineStatus(machine, 200000)).toBe("Not enrolled");
  expect(machineStatus({ ...machine, enrolled: true }, 200000)).toBe(
    "Awaiting report",
  );
  expect(
    machineStatus({ ...machine, enrolled: true, lastSeenAt: 199999 }, 200000),
  ).toBe("Connected");
  expect(
    machineStatus({ ...machine, enrolled: true, lastSeenAt: 100000 }, 200000),
  ).toBe("Stale");
});
it("verifies replacement only after the new agent enrolls and sends a report", async () => {
  const issuedAt = Date.now();
  const old = {
    ...machine,
    enrolled: true,
    enrolledAt: issuedAt - 60000,
    lastSeenAt: issuedAt,
  };
  const enrolled = { ...old, enrolledAt: issuedAt + 1, lastSeenAt: null };
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([old]))
    .mockResolvedValueOnce(
      Response.json({
        token: "replacement-token",
        issuedAt,
        expiresAt: issuedAt + 600000,
      }),
    )
    .mockResolvedValueOnce(Response.json([old]))
    .mockResolvedValueOnce(Response.json([enrolled]))
    .mockResolvedValueOnce(
      Response.json([{ ...enrolled, lastSeenAt: issuedAt + 2 }]),
    );
  const user = userEvent.setup();
  render(<MachineInventory identity={identity} />);
  await user.click(await screen.findByRole("button", { name: machine.name }));
  await user.click(screen.getByRole("button", { name: "Machine details" }));
  await user.click(screen.getByRole("button", { name: "Replace agent" }));
  await user.click(screen.getByRole("button", { name: "Generate token" }));
  await screen.findByDisplayValue("replacement-token");
  expect(screen.queryByText("Agent connected")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Check for report" }));
  await waitFor(() =>
    expect(screen.queryByLabelText("Enrollment token")).toBeNull(),
  );
  expect(screen.queryByText("Agent connected")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Check for report" }));
  await screen.findByText("Agent connected");
  await user.click(screen.getByRole("button", { name: "View monitoring" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Back to machines" }),
  ).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "Back to machines" }));
  expect(
    screen.getByRole("table", { name: "Machine inventory" }),
  ).not.toBeNull();
});
it("shows actual capacity readings and warns when reports are stale", async () => {
  const gib = 1024 ** 3;
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json([
      {
        ...machine,
        enrolled: true,
        enrolledAt: Date.now() - 200000,
        lastSeenAt: Date.now() - 100000,
        health: {
          hostname: "eu-host",
          os: "Linux",
          agentVersion: "1",
          cpuCount: 4,
          loadOne: 1.25,
          memoryTotalBytes: 8 * gib,
          memoryAvailableBytes: 6 * gib,
          diskTotalBytes: 100 * gib,
          diskAvailableBytes: 25 * gib,
          uptimeSeconds: 90061,
        },
      },
    ]),
  );
  const user = userEvent.setup();
  render(
    <MachineInventory
      identity={{ ...identity, permissions: ["infrastructure.view"] }}
    />,
  );
  await user.click(await screen.findByRole("button", { name: machine.name }));
  expect(screen.queryByText("2.0 GiB")).toBeNull();
  expect(screen.queryByText("75.0 GiB")).toBeNull();
  expect(screen.queryByRole("meter")).toBeNull();
  expect(screen.queryByText("1d 1h 1m uptime")).toBeNull();
  expect(screen.getByText(/Machine unreachable. Last seen/)).not.toBeNull();
  for (const label of ["CPU", "Network", "Memory", "Storage"]) {
    expect(
      within(screen.getByRole("region", { name: label })).getByText(
        /Unavailable. Last seen/,
      ),
    ).not.toBeNull();
  }
  expect(screen.queryByRole("button", { name: "Edit machine" })).toBeNull();
});
it("shows country and measured inventory metrics with accessible status details", async () => {
  const reported = {
    ...machine,
    enrolled: true,
    lastSeenAt: Date.now(),
    health: {
      hostname: "host",
      os: "Linux",
      agentVersion: "1.1.0",
      cpuCount: 4,
      loadOne: 8,
      cpuUsagePercent: 25,
      geolocation: { publicIp: "8.8.8.8", countryCode: "US" },
      memoryTotalBytes: 100,
      memoryAvailableBytes: 40,
      diskTotalBytes: 100,
      diskAvailableBytes: 20,
      uptimeSeconds: 100,
    },
  };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([reported]));
  const user = userEvent.setup();
  render(<MachineInventory identity={identity} />);
  const status = await screen.findByRole("button", {
    name: "EU host: Connected, United States",
  });
  expect(status.querySelector(".border-primary")).not.toBeNull();
  expect(
    screen
      .getAllByRole("meter", { name: "EU host CPU usage" })[0]
      .getAttribute("aria-valuenow"),
  ).toBe("25");
  expect(
    screen
      .getAllByRole("meter", { name: "EU host Memory usage" })[0]
      .getAttribute("aria-valuenow"),
  ).toBe("60");
  expect(
    screen
      .getAllByRole("meter", { name: "EU host Storage usage" })[0]
      .getAttribute("aria-valuenow"),
  ).toBe("80");
  await user.click(status);
  status.focus();
  await user.keyboard("{Tab}{Shift>}{Tab}{/Shift}");
  await screen.findByRole("tooltip");
  await user.click(screen.getByRole("button", { name: machine.name }));
  await user.click(screen.getByRole("button", { name: "Machine details" }));
  expect(
    within(screen.getByRole("dialog")).getByText("United States"),
  ).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "Edit machine" }));
  expect(screen.queryByLabelText(/Location/)).toBeNull();
});

it("replaces unenrolled metrics with an enrollment invitation", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([machine]));
  const view = render(<MachineInventory identity={identity} />);
  await screen.findByRole("button", { name: machine.name });
  expect(
    screen.getByRole("link", { name: "Enroll machine" }).getAttribute("href"),
  ).toBe(`/dashboard/infrastructure/machines/setup?machine=${machine.id}`);
  expect(
    view.container.querySelectorAll('[data-slot="skeleton"]'),
  ).toHaveLength(8);
});

it("removes an unenrolled machine after confirmation and omits duplicate enrollment actions", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([machine]))
    .mockResolvedValueOnce(Response.json({ removed: true }))
    .mockResolvedValueOnce(Response.json([]));
  const user = userEvent.setup();
  render(<MachineInventory identity={identity} />);
  await user.click(
    await screen.findByRole("button", { name: "Actions for EU host" }),
  );
  expect(screen.queryByRole("menuitem", { name: "Continue setup" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Enroll" })).toBeNull();
  await user.click(screen.getByRole("menuitem", { name: "Remove" }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Remove machine",
    }),
  );
  await screen.findByText("No machines yet");
  expect(fetcher.mock.calls[1][0]).toBe("/app-api/machines/machine/remove");
});

it("preserves fresh monitoring after a failed refresh and marks only aged reports unreachable", async () => {
  const started = Date.now();
  let now = started;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const intervals = vi.spyOn(globalThis, "setInterval");
  const report = {
    ...machine,
    enrolled: true,
    enrolledAt: started - 60000,
    lastSeenAt: started,
    health: {
      hostname: "host",
      os: "Linux",
      agentVersion: "1.2",
      cpuCount: 4,
      loadOne: 1,
      cpuUsagePercent: 42,
      memoryTotalBytes: 100,
      memoryAvailableBytes: 50,
      diskTotalBytes: 100,
      diskAvailableBytes: 50,
      uptimeSeconds: 100,
    },
  };
  let failed = false;
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      if (String(input) === "/app-api/machines") {
        if (failed) throw new Error("Refresh failed");
        return Response.json([report]);
      }
      return Response.json({ samples: [], windowEnd: started });
    });
  const user = userEvent.setup();
  render(<MachineInventory identity={identity} />);
  await user.click(await screen.findByRole("button", { name: machine.name }));
  await screen.findByRole("meter", { name: "Memory used" });
  const poll = intervals.mock.calls.find(
    (call) => call[1] === 30000,
  )![0] as () => void;
  failed = true;
  await act(async () => poll());
  expect(screen.queryByText(/Machine unreachable/)).toBeNull();
  expect(screen.getByRole("meter", { name: "Memory used" })).not.toBeNull();
  expect(screen.getByText(/uptime/)).not.toBeNull();
  for (const [, options] of fetcher.mock.calls) {
    expect(new Headers(options?.headers).get("X-Cupboard-Organization")).toBe(
      identity.organization!.id,
    );
  }
  now = started + 91000;
  await act(async () => poll());
  expect(screen.getByText(/Machine unreachable/)).not.toBeNull();
  expect(screen.queryByRole("meter")).toBeNull();
});
