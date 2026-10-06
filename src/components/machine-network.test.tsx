// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MachineNetwork } from "./machine-network";
import type { Machine } from "@/lib/machines";

const now = Date.now();
const machine: Machine = {
  id: "host",
  name: "Host",
  address: "host",
  provider: "",

  notes: "",
  revision: 1,
  enrolled: true,
  enrolledAt: now - 600000,
  enrollmentExpiresAt: null,
  lastSeenAt: now,
  health: {
    hostname: "host",
    os: "Linux",
    agentVersion: "1.2",
    cpuCount: 4,
    loadOne: 1,
    networkReceiveBytesPerSecond: 2048,
    networkSendBytesPerSecond: 1024,
    memoryTotalBytes: 100,
    memoryAvailableBytes: 50,
    diskTotalBytes: 100,
    diskAvailableBytes: 50,
    uptimeSeconds: 100,
  },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("plots recorded in/out rates, leaves report gaps, and hides them when unreachable", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      windowEnd: now,
      samples: [
        {
          at: now - 180000,
          networkReceiveBytesPerSecond: 1024,
          networkSendBytesPerSecond: 512,
        },
        {
          at: now - 150000,
          networkReceiveBytesPerSecond: 2048,
          networkSendBytesPerSecond: 1024,
        },
        {
          at: now,
          networkReceiveBytesPerSecond: 2048,
          networkSendBytesPerSecond: 1024,
        },
      ],
    }),
  );
  const view = render(
    <MachineNetwork organization="org" machine={machine} now={now} />,
  );
  const graph = await screen.findByRole("img");
  const paths = graph.querySelectorAll("path");
  expect(paths).toHaveLength(2);
  expect(paths[0].getAttribute("d")?.match(/M/g)).toHaveLength(2);
  expect(screen.getByText("↓ In 2.0 KiB/s")).not.toBeNull();
  view.rerender(
    <MachineNetwork organization="org" machine={machine} now={now + 91000} />,
  );
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByText("↓ In 2.0 KiB/s")).toBeNull();
  expect(screen.getByText(/Last seen/)).not.toBeNull();
  view.rerender(
    <MachineNetwork
      organization="org"
      machine={{ ...machine, lastSeenAt: now + 92000 }}
      now={now + 92000}
    />,
  );
  await screen.findByRole("img");
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});

it("shows only skeletons before the first report without fetching history", () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  const view = render(
    <MachineNetwork
      organization="org"
      machine={{ ...machine, lastSeenAt: null, health: null }}
      now={now}
    />,
  );
  expect(screen.queryByText(/In /)).toBeNull();
  expect(screen.queryByText(/Out /)).toBeNull();
  expect(screen.queryByText("Waiting for network history")).toBeNull();
  expect(
    view.container.querySelectorAll('[data-slot="skeleton"]'),
  ).toHaveLength(2);
  expect(fetcher).not.toHaveBeenCalled();
});
