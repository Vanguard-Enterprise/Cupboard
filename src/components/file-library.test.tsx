// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { FileLibrary } from "./file-library";
import type { Identity } from "@/lib/api-client";
const identity: Identity = {
  user: { id: "user", name: "Operator", email: "operator@example.com" },
  organization: { id: "org", name: "Rust community" },
  organizations: [],
  membershipId: "member",
  permissions: ["organization.manage"],
};
const file = {
  id: "file",
  name: "config.txt",
  size: 12,
  createdAt: 1700000000,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("uploads into the current organization and confirms deletion", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(Response.json(file))
    .mockResolvedValueOnce(Response.json({ deleted: true }));
  const user = userEvent.setup();
  render(<FileLibrary identity={identity} />);
  await screen.findByText("No files yet");
  const upload = new File(["configuration"], "config.txt");
  await user.upload(screen.getByLabelText("Upload a file"), upload);
  await user.click(screen.getByRole("button", { name: "Upload file" }));
  await screen.findByText("config.txt");
  expect(fetcher.mock.calls[1][1]?.body).toBe(upload);
  expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({
    "X-Cupboard-Organization": "org",
    "X-Cupboard-Filename": "config.txt",
  });
  expect(
    (screen.getByLabelText("Upload a file") as HTMLInputElement).value,
  ).toBe("");
  await user.click(screen.getByRole("button", { name: "Delete config.txt" }));
  expect(screen.getByRole("dialog")).not.toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Delete config.txt" }));
  await user.click(screen.getByRole("button", { name: "Delete file" }));
  await screen.findByText("No files yet");
  expect(fetcher.mock.calls[2][0]).toBe("/app-api/files/file/delete");
});
it("keeps a failed upload selected and rejects oversized files before sending", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(
      Response.json({ error: "Storage unavailable." }, { status: 503 }),
    );
  const user = userEvent.setup();
  render(<FileLibrary identity={identity} />);
  await screen.findByText("No files yet");
  const input = screen.getByLabelText("Upload a file") as HTMLInputElement;
  await user.upload(input, new File(["bytes"], "config.txt"));
  await user.click(screen.getByRole("button", { name: "Upload file" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Storage unavailable.",
  );
  expect(input.files?.[0].name).toBe("config.txt");
  await user.upload(
    input,
    new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.bin"),
  );
  await user.click(screen.getByRole("button", { name: "Upload file" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Choose a file no larger than 10 MiB.",
  );
  expect(document.activeElement).toBe(input);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("retains the list after refresh failure and filters filenames", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([file]))
    .mockRejectedValueOnce(new Error("Connection failed."));
  const user = userEvent.setup();
  render(<FileLibrary identity={identity} />);
  await screen.findByText("config.txt");
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Last loaded"),
  );
  expect(screen.getByText("config.txt")).not.toBeNull();
  await user.type(screen.getByLabelText("Search files"), "missing");
  expect(screen.getByText("No matching files")).not.toBeNull();
});
it("does not request data without management permission", () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  render(<FileLibrary identity={{ ...identity, permissions: [] }} />);
  expect(
    screen.getByText(
      "You need organization management permission to access files.",
    ),
  ).not.toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it("shows download failures without navigating away", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([file]))
    .mockResolvedValueOnce(
      Response.json({ error: "Download unavailable." }, { status: 503 }),
    );
  const user = userEvent.setup();
  render(<FileLibrary identity={identity} />);
  await user.click(
    await screen.findByRole("button", { name: "Download config.txt" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Download unavailable.",
    ),
  );
  expect(screen.getByText("config.txt")).not.toBeNull();
});
