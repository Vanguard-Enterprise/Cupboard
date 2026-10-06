// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MachineStatCards } from "./machine-stat-cards";
import type { Machine } from "@/lib/machines";
const machine: Machine = {
  id: "one",
  name: "Host",
  address: "host",
  provider: "",

  notes: "",
  revision: 1,
  enrolled: true,
  enrolledAt: 1,
  enrollmentExpiresAt: null,
  lastSeenAt: Date.now(),
  health: {
    hostname: "host",
    os: "Linux",
    agentVersion: "1.1",
    cpuCount: 4,
    cpuUsagePercent: 42,
    networkReceiveBytesPerSecond: 2048,
    networkSendBytesPerSecond: 1024,
    loadOne: 1,
    memoryTotalBytes: 8 * 1024 ** 3,
    memoryAvailableBytes: 6 * 1024 ** 3,
    diskTotalBytes: 100 * 1024 ** 3,
    diskAvailableBytes: 50 * 1024 ** 3,
    uptimeSeconds: 100,
  },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("renders current utilization as accessible circular meters and network rates", async () => {
  const now = Date.now();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      windowEnd: now,
      samples: [
        {
          at: now - 30000,
          cpu: 18,
          memoryUsed: 1024 ** 3,
          memoryTotal: 8 * 1024 ** 3,
          storageUsed: 50 * 1024 ** 3,
          storageTotal: 100 * 1024 ** 3,
        },
        {
          at: now,
          cpu: 42,
          memoryUsed: 2 * 1024 ** 3,
          memoryTotal: 8 * 1024 ** 3,
          storageUsed: 50 * 1024 ** 3,
          storageTotal: 100 * 1024 ** 3,
        },
      ],
    }),
  );
  render(<MachineStatCards organization="org" machine={machine} />);
  expect(
    within(screen.getByRole("region", { name: "CPU" })).getByText("42.0%"),
  ).not.toBeNull();
  await waitFor(() =>
    expect(screen.queryByText("Loading history...")).toBeNull(),
  );
  expect(
    screen
      .getByRole("meter", { name: "Memory used" })
      .getAttribute("aria-valuenow"),
  ).toBe("25");
  expect(
    screen
      .getByRole("meter", { name: "Storage used" })
      .getAttribute("aria-valuenow"),
  ).toBe("50");
  expect(
    within(screen.getByRole("region", { name: "Network" })).getByText(
      "2.0 KiB/s",
    ),
  ).not.toBeNull();
  expect(screen.queryByText("View readings")).toBeNull();
  expect(fetch).toHaveBeenCalledWith(
    "/app-api/machines/one/history",
    expect.any(Object),
  );
});
it("keeps current readings usable when history fails", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline"));
  render(<MachineStatCards organization="org" machine={machine} />);
  await screen.findByText("History unavailable. Retrying automatically.");
  expect(
    within(screen.getByRole("region", { name: "CPU" })).getByText("42.0%"),
  ).not.toBeNull();
  expect(screen.queryByText("View readings")).toBeNull();
});
it("does not invent history or CPU utilization for older agents", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ windowEnd: Date.now(), samples: [] }),
  );
  render(
    <MachineStatCards
      organization="org"
      machine={{
        ...machine,
        health: { ...machine.health!, cpuUsagePercent: null },
      }}
    />,
  );
  await waitFor(() =>
    expect(screen.getAllByText("Waiting for history")).toHaveLength(2),
  );
  expect(
    within(screen.getByRole("region", { name: "CPU" })).getByText("—"),
  ).not.toBeNull();
  expect(screen.queryByText("View readings")).toBeNull();
});
