// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PelicanServerImport,
  PelicanServerControls,
} from "./pelican-server-controls";
import { apiRequest } from "@/lib/api-client";
vi.mock("@/lib/api-client", () => ({ apiRequest: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());
const resource = {
  state: "running",
  resources: {
    cpu_absolute: 12.5,
    memory_bytes: 1048576,
    disk_bytes: 2097152,
    network_rx_bytes: 1024,
    network_tx_bytes: 2048,
    uptime: 3600000,
  },
};
it("imports once from the scoped connection and marks the server added", async () => {
  const user = userEvent.setup();
  const imported = vi.fn();
  vi.mocked(apiRequest)
    .mockResolvedValueOnce({
      connectionId: "connection",
      revision: 3,
      servers: [
        { uuid: "rust", name: "Rust One", node: "Node", imported: false },
      ],
    })
    .mockResolvedValueOnce({ id: "new-server" });
  render(<PelicanServerImport organization="org-one" onImported={imported} />);
  await user.click(screen.getByRole("button", { name: "From Pelican" }));
  await user.click(await screen.findByRole("button", { name: "Add Rust One" }));
  expect(apiRequest).toHaveBeenLastCalledWith(
    "servers/pelican/import",
    { uuid: "rust", connectionId: "connection", revision: 3 },
    "org-one",
  );
  expect(
    (
      (await screen.findByRole("button", {
        name: "Rust One already added",
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(imported).toHaveBeenCalledOnce();
});
it("shows resources and confirms disruptive power actions before sending", async () => {
  const user = userEvent.setup();
  vi.mocked(apiRequest).mockResolvedValue(resource);
  render(
    <PelicanServerControls
      server={{ id: "server", name: "Rust One" }}
      organization="org-one"
      manage
    />,
  );
  await user.click(screen.getByRole("button", { name: "Manage Rust One" }));
  expect(await screen.findByText("12.5%")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(apiRequest).not.toHaveBeenCalledWith(
    "servers/server/panel/power",
    expect.anything(),
    expect.anything(),
  );
  await user.click(screen.getByRole("button", { name: "Stop server" }));
  await waitFor(() =>
    expect(apiRequest).toHaveBeenCalledWith(
      "servers/server/panel/power",
      { signal: "stop" },
      "org-one",
    ),
  );
});
it("allows a viewer to read console but exposes no command or power controls", async () => {
  const user = userEvent.setup();
  vi.mocked(apiRequest).mockImplementation(async (path) =>
    path.endsWith("console") ? { lines: ["Rust server ready"] } : resource,
  );
  render(
    <PelicanServerControls
      server={{ id: "server", name: "Rust One" }}
      organization="org-one"
      manage={false}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Manage Rust One" }));
  await screen.findByText("12.5%");
  expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Console" }));
  expect(await screen.findByText("Rust server ready")).toBeTruthy();
  expect(screen.queryByLabelText("Console command")).toBeNull();
});
it("sends a command only for a manager and clears the input", async () => {
  const user = userEvent.setup();
  vi.mocked(apiRequest).mockImplementation(async (path) =>
    path.endsWith("console") ? { lines: [] } : resource,
  );
  render(
    <PelicanServerControls
      server={{ id: "server", name: "Rust One" }}
      organization="org-one"
      manage
    />,
  );
  await user.click(screen.getByRole("button", { name: "Manage Rust One" }));
  await screen.findByText("12.5%");
  await user.click(screen.getByRole("tab", { name: "Console" }));
  await user.type(screen.getByLabelText("Console command"), "status");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(apiRequest).toHaveBeenCalledWith(
    "servers/server/panel/command",
    { command: "status" },
    "org-one",
  );
  expect(
    (screen.getByLabelText("Console command") as HTMLInputElement).value,
  ).toBe("");
});
