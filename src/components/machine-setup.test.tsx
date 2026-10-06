// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MachineSetup } from "./machine-setup";
import type { Identity } from "@/lib/api-client";
const identity: Identity = {
  user: { id: "one", name: "User", email: "user@example.com" },
  organization: { id: "org", name: "Org" },
  organizations: [],
  membershipId: "m",
  permissions: ["infrastructure.view", "infrastructure.manage"],
};
const record = {
  id: "machine",
  name: "Host",
  address: "192.0.2.20",
  provider: "",
  notes: "",
  revision: 1,
  enrolled: false,
  enrolledAt: null,
  lastSeenAt: null,
  enrollmentExpiresAt: null,
  health: null,
};
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("restores a scoped draft and saves one machine before enrollment, without persisting tokens", async () => {
  const user = userEvent.setup();
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      if (String(_url).endsWith("/enrollment"))
        return Response.json({
          token: "private-token",
          expiresAt: Date.now() + 600000,
          issuedAt: Date.now(),
        });
      if (init?.method === "POST") return Response.json(record);
      return Response.json([record]);
    });
  const first = render(<MachineSetup identity={identity} />);
  await user.type(await screen.findByLabelText("Machine name"), "Host");
  await user.type(
    screen.getByLabelText("IP address (IPv4 or IPv6)"),
    record.address,
  );
  first.unmount();
  render(<MachineSetup identity={identity} />);
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Machine name") as HTMLInputElement).value,
    ).toBe("Host"),
  );
  await user.click(screen.getByRole("button", { name: "Save and continue" }));
  await user.click(
    await screen.findByRole("button", { name: "Generate token" }),
  );
  await screen.findByDisplayValue("private-token");
  expect(localStorage.getItem("machine-setup:one:org")).not.toContain(
    "private-token",
  );
  expect(window.location.search).toBe("?machine=machine");
  expect(
    fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(2);
});
it("resumes server enrollment progress after refresh without generating a token", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json([{ ...record, enrolled: true, enrolledAt: Date.now() }]),
    );
  render(<MachineSetup identity={identity} initialMachineId="machine" />);
  await screen.findByText("Waiting for a fresh health report…");
  expect(screen.queryByRole("button", { name: "Generate token" })).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("does not show another user's draft or load machines without permission", async () => {
  localStorage.setItem(
    "machine-setup:other:org",
    JSON.stringify({
      draft: { name: "Private", address: "host", provider: "", notes: "" },
      machineId: null,
    }),
  );
  const view = render(<MachineSetup identity={identity} />);
  await screen.findByLabelText("Machine name");
  expect(screen.queryByDisplayValue("Private")).toBeNull();
  view.unmount();
  const fetcher = vi.spyOn(globalThis, "fetch");
  render(
    <MachineSetup
      identity={{ ...identity, permissions: [] }}
      initialMachineId="machine"
    />,
  );
  expect(screen.getByText(/You need infrastructure/)).not.toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it("preserves invalid drafts and focuses the rejected field", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      { error: "Check fields", fields: { name: "Enter a name." } },
      { status: 422 },
    ),
  );
  const user = userEvent.setup();
  render(<MachineSetup identity={identity} />);
  await user.type(
    await screen.findByLabelText("IP address (IPv4 or IPv6)"),
    "192.0.2.20",
  );
  await user.click(screen.getByRole("button", { name: "Save and continue" }));
  await screen.findByText("Enter a name.");
  expect(document.activeElement).toBe(screen.getByLabelText("Machine name"));
  expect(
    (screen.getByLabelText("IP address (IPv4 or IPv6)") as HTMLInputElement)
      .value,
  ).toBe("192.0.2.20");
});
it("finishes only after a fresh report and allows starting another machine", async () => {
  const now = Date.now();
  localStorage.setItem(
    "machine-setup:one:org",
    JSON.stringify({
      draft: { name: "Host", address: "host", provider: "", notes: "" },
      machineId: "machine",
    }),
  );
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json([
      {
        ...record,
        enrolled: true,
        enrolledAt: now - 1000,
        lastSeenAt: now,
        health: { hostname: "host" },
      },
    ]),
  );
  const user = userEvent.setup();
  render(<MachineSetup identity={identity} initialMachineId="machine" />);
  await screen.findByText("Machine connected");
  expect(localStorage.getItem("machine-setup:one:org")).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Set up another machine" }),
  );
  expect(
    (screen.getByLabelText("Machine name") as HTMLInputElement).value,
  ).toBe("");
  expect(window.location.search).toBe("");
});

it("rejects invalid IP syntax before submitting", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  const user = userEvent.setup();
  render(<MachineSetup identity={identity} />);
  await user.type(await screen.findByLabelText("Machine name"), "Host");
  await user.type(
    screen.getByLabelText("IP address (IPv4 or IPv6)"),
    "10.1.1.30.50",
  );
  await user.click(screen.getByRole("button", { name: "Save and continue" }));
  expect(
    screen.getByText("Enter a valid IPv4 or IPv6 address."),
  ).not.toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
