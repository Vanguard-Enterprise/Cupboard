// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MachineTagsDialog } from "./machine-tags";
import type { Machine } from "@/lib/machines";
const machine: Machine = {
  id: "host",
  name: "Host",
  address: "10.1.1.1",
  provider: "",
  notes: "",
  revision: 1,
  enrolled: false,
  enrolledAt: null,
  enrollmentExpiresAt: null,
  lastSeenAt: null,
  health: null,
  tags: [],
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("creates, renames, confirms deletion, and assigns organization tags", async () => {
  const user = userEvent.setup();
  let tags = [{ id: "wings", name: "Wings" }];
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, options) => {
      const body = options?.body ? JSON.parse(String(options.body)) : null;
      if (String(url).endsWith("machines/tags")) {
        if (body?.kind === "save") {
          if (body.id)
            tags = tags.map((tag) =>
              tag.id === body.id ? { ...tag, name: body.name } : tag,
            );
          else tags = [...tags, { id: "custom", name: body.name }];
        }
        if (body?.kind === "delete")
          tags = tags.filter((tag) => tag.id !== body.id);
        return Response.json(tags);
      }
      return Response.json({ saved: true });
    });
  const closed = vi.fn();
  const saved = vi.fn();
  render(
    <MachineTagsDialog
      machine={machine}
      organization="org"
      onClose={closed}
      onSaved={saved}
    />,
  );
  await user.click(await screen.findByRole("checkbox", { name: "Wings" }));
  await user.click(
    screen.getByRole("button", { name: "Manage organization tags" }),
  );
  await user.type(screen.getByLabelText("New tag"), "Database");
  await user.click(screen.getByRole("button", { name: "Create" }));
  await user.click(
    await screen.findByRole("button", { name: "Rename Database" }),
  );
  await user.clear(screen.getByLabelText("Rename tag"));
  await user.type(screen.getByLabelText("Rename tag"), "Storage");
  await user.click(screen.getByRole("button", { name: "Rename" }));
  await user.click(
    await screen.findByRole("button", { name: "Delete Storage" }),
  );
  expect(
    fetcher.mock.calls.filter((call) =>
      String(call[1]?.body).includes('"delete"'),
    ),
  ).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Delete tag" }));
  await waitFor(() =>
    expect(screen.queryByRole("checkbox", { name: "Storage" })).toBeNull(),
  );
  await user.click(screen.getByRole("button", { name: "Save tags" }));
  await waitFor(() => expect(closed).toHaveBeenCalled());
  const request = fetcher.mock.calls.find((call) =>
    String(call[0]).endsWith("machines/host/tags"),
  );
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({
    tags: ["wings"],
    revision: 1,
  });
  expect(
    new Headers(request?.[1]?.headers).get("x-cupboard-organization"),
  ).toBe("org");
});
it("keeps edits and displays server rejection", async () => {
  const user = userEvent.setup();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) =>
    options?.method === "POST"
      ? Response.json({ error: "This machine changed." }, { status: 409 })
      : Response.json([{ id: "wings", name: "Wings" }]),
  );
  const closed = vi.fn();
  render(
    <MachineTagsDialog
      machine={machine}
      organization="org"
      onClose={closed}
      onSaved={vi.fn()}
    />,
  );
  await user.click(await screen.findByRole("checkbox", { name: "Wings" }));
  await user.click(screen.getByRole("button", { name: "Save tags" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "This machine changed.",
  );
  expect(
    screen
      .getByRole("checkbox", { name: "Wings" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(closed).not.toHaveBeenCalled();
});
