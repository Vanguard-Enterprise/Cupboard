// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { FileShareDialog } from "./file-share-dialog";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("keeps organization access separate from public link creation and revocation", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ expiresAt: null }))
    .mockResolvedValueOnce(
      Response.json({ token: "test-link-token", expiresAt: 1900000000 }),
    )
    .mockResolvedValueOnce(Response.json({ revoked: true }));
  const user = userEvent.setup();
  render(
    <FileShareDialog
      file={{ id: "file", name: "config.txt", size: 1, createdAt: 1 }}
      organization="org"
      onClose={() => {}}
    />,
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Organization link") as HTMLInputElement).value,
    ).toContain("organization=org&file=file"),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Create public link" }));
  await screen.findByLabelText("Public link");
  expect(
    (screen.getByLabelText("Public link") as HTMLInputElement).value,
  ).toContain("/share/file#test-link-token");
  expect(JSON.parse(fetcher.mock.calls[1][1]?.body as string)).toEqual({
    days: 7,
  });
  await user.click(screen.getByRole("button", { name: "Revoke link" }));
  await waitFor(() =>
    expect(screen.queryByLabelText("Public link")).toBeNull(),
  );
  expect(fetcher.mock.calls[2][0]).toBe("/app-api/files/file/share/revoke");
});
