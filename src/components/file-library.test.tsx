// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
  fireEvent,
} from "@testing-library/react";
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
  localStorage.clear();
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
  await screen.findByText("Your files, together");
  await user.click(screen.getByRole("button", { name: "Upload file" }));
  const upload = new File(["configuration"], "config.txt");
  await user.upload(screen.getByLabelText("Upload a file"), upload);
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Upload file",
    }),
  );
  await screen.findByText("config.txt");
  expect(fetcher.mock.calls[1][1]?.body).toBe(upload);
  expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({
    "X-Cupboard-Organization": "org",
    "X-Cupboard-Filename": "config.txt",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Delete config.txt" }));
  expect(screen.getByRole("dialog")).not.toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Delete config.txt" }));
  await user.click(screen.getByRole("button", { name: "Delete file" }));
  await screen.findByText("Your files, together");
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
  await screen.findByText("Your files, together");
  await user.click(screen.getByRole("button", { name: "Upload file" }));
  const input = screen.getByLabelText("Upload a file") as HTMLInputElement;
  await user.upload(input, new File(["bytes"], "config.txt"));
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Upload file",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Storage unavailable.",
  );
  expect(input.files?.[0].name).toBe("config.txt");
  await user.upload(
    input,
    new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.bin"),
  );
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Upload file",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Choose a file no larger than 10 MiB.",
  );
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Choose file" }),
  );
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
  await user.click(await screen.findByRole("button", { name: /^config.txt/ }));
  await user.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Download unavailable.",
    ),
  );
  expect(screen.getByText("config.txt")).not.toBeNull();
});

it("preserves selected-file actions between list and grid and filters by extension", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json([
      file,
      { id: "zip", name: "backup.zip", size: 1024, createdAt: 1700000001 },
    ]),
  );
  const user = userEvent.setup();
  render(<FileLibrary identity={identity} />);
  await user.click(await screen.findByRole("button", { name: /^config.txt/ }));
  expect(screen.getByText("1 selected")).not.toBeNull();
  await user.click(screen.getByRole("radio", { name: "Grid view" }));
  expect(
    screen
      .getByRole("button", { name: "Select config.txt" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  await user.click(
    screen.getByRole("button", { name: "Filter and sort files" }),
  );
  await user.click(screen.getByRole("menuitemradio", { name: ".zip" }));
  expect(screen.queryByText("config.txt")).toBeNull();
  expect(screen.queryByText("1 selected")).toBeNull();
  expect(screen.getByText("backup.zip")).not.toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Actions for backup.zip" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "File details" }));
  expect(screen.getByRole("dialog").textContent).toContain("1.0 KiB");
});
it("sorts rows and supports keyboard selection and action menus", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json([
      file,
      { id: "zip", name: "backup.zip", size: 1024, createdAt: 1600000000 },
    ]),
  );
  const user = userEvent.setup();
  render(<FileLibrary identity={identity} />);
  await screen.findByText("config.txt");
  await user.click(
    screen.getByRole("button", { name: "Filter and sort files" }),
  );
  await user.click(screen.getByRole("menuitemradio", { name: "Name A–Z" }));
  expect(screen.getAllByRole("row")[1].textContent).toContain("backup.zip");
  screen.getByRole("button", { name: /^backup.zip/ }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByText("1 selected")).not.toBeNull();
  screen.getByRole("button", { name: "Actions for backup.zip" }).focus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("menuitem", { name: "Download" }),
  ).not.toBeNull();
  await user.keyboard("{Escape}");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Actions for backup.zip" }),
  );
});
it("accepts a dropped file and preserves the dialog when upload fails", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(
      Response.json({ error: "Upload failed." }, { status: 503 }),
    );
  const user = userEvent.setup();
  render(<FileLibrary identity={identity} />);
  await screen.findByText("Your files, together");
  await user.click(screen.getByRole("button", { name: "Upload file" }));
  const dropped = new File(["config"], "dropped.cfg");
  fireEvent.drop(screen.getByText("Drop a file here"), {
    dataTransfer: { files: [dropped] },
  });
  expect(screen.getByText("dropped.cfg")).not.toBeNull();
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Upload file",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Upload failed.",
  );
  expect(fetcher.mock.calls[1][1]?.body).toBe(dropped);
  expect(screen.getByText("dropped.cfg")).not.toBeNull();
});

it("remembers the view after remount and scopes it to the organization", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json([file]),
  );
  const user = userEvent.setup();
  const first = render(<FileLibrary identity={identity} />);
  await user.click(screen.getByRole("radio", { name: "Grid view" }));
  first.unmount();
  const second = render(<FileLibrary identity={identity} />);
  expect(
    screen
      .getByRole("radio", { name: "Grid view" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  second.unmount();
  render(
    <FileLibrary
      identity={{ ...identity, organization: { id: "other", name: "Other" } }}
    />,
  );
  expect(
    screen
      .getByRole("radio", { name: "List view" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  await screen.findByText("config.txt");
});

it("offers right-click copy and cut, navigates folders, and pastes into the destination", async () => {
  const folder = {
    id: "folder",
    name: "Configs",
    size: 0,
    createdAt: 1700000001,
    isFolder: true,
    parentId: null,
  };
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([file, folder]))
    .mockResolvedValueOnce(Response.json({ ...file, parentId: "folder" }));
  const user = userEvent.setup();
  render(<FileLibrary identity={identity} />);
  fireEvent.contextMenu(
    await screen.findByRole("button", { name: /^config.txt/ }),
  );
  expect(screen.getByRole("menuitem", { name: "Copy" })).not.toBeNull();
  expect(screen.getByRole("menuitem", { name: "Share" })).not.toBeNull();
  await user.click(screen.getByRole("menuitem", { name: "Cut" }));
  await user.click(screen.getByRole("button", { name: /^Configs/ }));
  await screen.findByText("This folder is empty");
  await user.click(screen.getByRole("button", { name: "Paste" }));
  await screen.findByText("config.txt");
  expect(fetcher.mock.calls[1][0]).toBe("/app-api/files/file/move");
  expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string)).toEqual({
    parentId: "folder",
  });
  expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({
    "X-Cupboard-Organization": "org",
  });
  expect(
    screen.queryByRole("button", { name: "Cancel copy or cut" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "All files" }));
  expect(screen.queryByText("config.txt")).toBeNull();
});
it("creates folders from the empty-area context menu and retains invalid names for correction", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(
      Response.json({ error: "Use a valid name." }, { status: 400 }),
    )
    .mockResolvedValueOnce(
      Response.json({
        id: "folder",
        name: "Configs",
        size: 0,
        createdAt: 1,
        isFolder: true,
        parentId: null,
      }),
    );
  const user = userEvent.setup();
  render(<FileLibrary identity={identity} />);
  await screen.findByText("Your files, together");
  fireEvent.contextMenu(screen.getByLabelText("File browser"));
  await user.click(screen.getByRole("menuitem", { name: "New folder" }));
  await user.type(screen.getByLabelText("Name"), "../bad");
  await user.click(screen.getByRole("button", { name: "Create folder" }));
  await screen.findByText("Use a valid name.");
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
    "../bad",
  );
  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), "Configs");
  await user.click(screen.getByRole("button", { name: "Create folder" }));
  await screen.findByText("Configs");
  expect(fetcher.mock.calls[2][0]).toBe("/app-api/files/folders");
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("opens file actions with Shift+F10 in grid view", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([file]));
  const user = userEvent.setup();
  render(<FileLibrary identity={identity} />);
  await screen.findByText("config.txt");
  await user.click(screen.getByRole("radio", { name: "Grid view" }));
  const target = screen.getByRole("button", { name: "Select config.txt" });
  target.focus();
  fireEvent.keyDown(target, { key: "F10", shiftKey: true });
  await user.click(screen.getByRole("menuitem", { name: "File details" }));
  expect(screen.getByRole("dialog").textContent).toContain("config.txt");
});
it("closes the overflow menu after Copy and preserves the clipboard after a failed paste", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json([file]))
    .mockResolvedValueOnce(
      Response.json({ error: "Copy failed." }, { status: 503 }),
    );
  const user = userEvent.setup();
  render(<FileLibrary identity={identity} />);
  await user.click(
    await screen.findByRole("button", { name: "Actions for config.txt" }),
  );
  await user.click(screen.getByRole("menuitem", { name: "Copy" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await user.click(screen.getByRole("button", { name: "Paste" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Paste" })).not.toBeNull();
});
