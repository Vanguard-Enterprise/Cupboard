// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationIntegrations } from "./organization-integrations";
import {
  defaultOrganizationIntegrations,
  organizationIntegrationsKey,
} from "@/lib/organization-integrations";

beforeEach(() => {
  localStorage.clear();
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Organization credentials and webhooks", () => {
  it("creates a credential without storing its full secret", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    render(<OrganizationIntegrations />);

    await user.click(screen.getByRole("button", { name: "Create credential" }));
    const createDialog = screen.getByRole("dialog", {
      name: "Create API credential",
    });
    const createButton = within(createDialog).getByRole("button", {
      name: "Create credential",
    }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);

    await user.type(
      screen.getByRole("textbox", { name: "Credential name" }),
      "Deploy agent",
    );
    expect(createButton.disabled).toBe(false);
    await user.click(createButton);

    const secret = screen.getByTestId("created-credential").textContent!;
    expect(secret).toMatch(/^cb_live_[A-F0-9]{36}$/);
    const stored = localStorage.getItem(organizationIntegrationsKey)!;
    expect(stored).toContain("Deploy agent");
    expect(stored).not.toContain(secret);

    await user.click(screen.getByRole("button", { name: "Copy credential" }));
    expect(writeText).toHaveBeenCalledWith(secret);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: "Credential created" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Done" }).getAttribute("data-variant"),
    ).toBe("secondary");
  });

  it("preserves concurrent integration changes when creating a credential", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    await user.click(screen.getByRole("button", { name: "Create credential" }));
    await user.type(
      screen.getByRole("textbox", { name: "Credential name" }),
      "Deploy agent",
    );

    const concurrent = structuredClone(defaultOrganizationIntegrations);
    concurrent.credentials.unshift({
      id: "concurrent-credential",
      name: "Created elsewhere",
      prefix: "cb_live_OTHER...1234",
      createdAt: "Sep 16, 2026",
      lastUsed: null,
    });
    concurrent.webhooks[0].name = "Updated elsewhere";
    localStorage.setItem(
      organizationIntegrationsKey,
      JSON.stringify(concurrent),
    );

    await user.click(
      screen
        .getByRole("dialog", { name: "Create API credential" })
        .querySelector('button[type="submit"]')!,
    );

    const stored = JSON.parse(
      localStorage.getItem(organizationIntegrationsKey)!,
    );
    expect(
      stored.credentials.map((item: { name: string }) => item.name),
    ).toEqual(expect.arrayContaining(["Deploy agent", "Created elsewhere"]));
    expect(stored.webhooks[0].name).toBe("Updated elsewhere");
  });

  it("keeps the one-time secret open until Done is selected", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    await user.click(screen.getByRole("button", { name: "Create credential" }));
    await user.type(
      screen.getByRole("textbox", { name: "Credential name" }),
      "Deploy agent",
    );
    await user.click(
      screen
        .getByRole("dialog", { name: "Create API credential" })
        .querySelector('button[type="submit"]')!,
    );

    const dialog = screen.getByRole("dialog", { name: "Credential created" });
    const secret = screen.getByTestId("created-credential").textContent;
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Credential created" })).toBe(
      dialog,
    );
    expect(screen.getByTestId("created-credential").textContent).toBe(secret);

    fireEvent.pointerDown(
      document.querySelector('[data-slot="dialog-overlay"]')!,
    );
    fireEvent.click(document.querySelector('[data-slot="dialog-overlay"]')!);
    expect(screen.getByTestId("created-credential").textContent).toBe(secret);

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(
      screen.queryByRole("dialog", { name: "Credential created" }),
    ).toBeNull();
  });

  it("offers a neutral retry state when credential copy fails", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("Clipboard unavailable"))
      .mockResolvedValueOnce(undefined);
    render(<OrganizationIntegrations />);

    await user.click(screen.getByRole("button", { name: "Create credential" }));
    await user.type(
      screen.getByRole("textbox", { name: "Credential name" }),
      "Deploy agent",
    );
    await user.click(
      screen
        .getByRole("dialog", { name: "Create API credential" })
        .querySelector('button[type="submit"]')!,
    );

    const secret = screen.getByTestId("created-credential");
    expect(secret.className).toContain("select-all");
    expect(secret.getAttribute("tabindex")).toBe("0");

    await user.click(screen.getByRole("button", { name: "Copy credential" }));
    expect(screen.getByText("Couldn't copy to clipboard.")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry copy" });
    expect(retry.getAttribute("data-variant")).toBe("destructive");

    await user.click(retry);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.queryByText("Couldn't copy to clipboard.")).toBeNull();
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("validates and saves a webhook with selected events", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    await user.click(screen.getByRole("button", { name: "Add webhook" }));
    const dialog = screen.getByRole("dialog", { name: "Add webhook" });
    expect(
      within(dialog).getByText(
        "Save a sample endpoint and selected events in this browser. This preview does not send webhooks.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).queryByText(
        "Cupboard will send the selected events to this endpoint.",
      ),
    ).toBeNull();
    const addButton = within(dialog).getByRole("button", {
      name: "Add webhook",
    }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);

    await user.type(
      screen.getByRole("textbox", { name: "Webhook name" }),
      "Incident bot",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Endpoint URL" }),
      "http://example.com/cupboard",
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Server status changed" }),
    );
    expect(addButton.disabled).toBe(true);
    expect(
      screen.getByText("Use HTTPS. HTTP is allowed only for localhost."),
    ).toBeTruthy();

    const urlInput = screen.getByRole("textbox", {
      name: "Endpoint URL",
    });
    await user.clear(urlInput);
    await user.type(urlInput, "https://hooks.example.com/cupboard");
    expect(addButton.disabled).toBe(false);
    await user.click(addButton);

    expect(screen.getByText("Incident bot")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Incident bot added.");
    expect(
      JSON.parse(localStorage.getItem(organizationIntegrationsKey)!)
        .webhooks[0],
    ).toMatchObject({
      name: "Incident bot",
      url: "https://hooks.example.com/cupboard",
      events: ["server.status_changed"],
    });
  });

  it("requires confirmation before revoking a credential", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    const revokeButtons = screen.getAllByRole("button", { name: "Revoke" });
    await user.click(revokeButtons[0]);
    const confirmation = screen.getByRole("alertdialog", {
      name: "Revoke Server operations?",
    });
    expect(
      within(confirmation).getByText(
        "This removes the credential from this browser preview. It does not revoke access to a live API. This cannot be undone.",
      ),
    ).toBeTruthy();
    expect(
      within(confirmation)
        .getByRole("button", { name: "Keep credential" })
        .getAttribute("data-variant"),
    ).toBe("secondary");
    expect(
      within(confirmation)
        .getByRole("button", { name: "Revoke credential" })
        .getAttribute("data-variant"),
    ).toBe("destructive");
    await user.click(
      within(confirmation).getByRole("button", {
        name: "Revoke credential",
      }),
    );

    expect(screen.queryByText("Server operations")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Server operations removed from preview data.",
    );
  });

  it("opens webhook details without retry for a healthy delivery", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    await user.click(screen.getByText("Operations relay").closest("button")!);
    const details = screen.getByRole("dialog", { name: "Operations relay" });
    expect(within(details).getByText("Not configured")).toBeTruthy();
    expect(within(details).getByText("HTTP 204")).toBeTruthy();
    expect(within(details).getByText("Server status changed")).toBeTruthy();

    expect(
      within(details).queryByRole("button", { name: "Retry delivery" }),
    ).toBeNull();
  });

  it("edits and deletes a webhook through managed actions", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    await user.click(
      screen.getByRole("button", { name: "Manage Operations relay" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const editDialog = screen.getByRole("dialog", { name: "Edit webhook" });
    const name = within(editDialog).getByRole("textbox", {
      name: "Webhook name",
    });
    await user.clear(name);
    await user.type(name, "Operations bridge");
    await user.click(
      within(editDialog).getByRole("button", { name: "Save changes" }),
    );
    expect(screen.getByText("Operations bridge")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Manage Operations bridge" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirmation = screen.getByRole("alertdialog", {
      name: "Delete Operations bridge?",
    });
    expect(
      within(confirmation)
        .getByRole("button", { name: "Keep webhook" })
        .getAttribute("data-variant"),
    ).toBe("secondary");
    expect(
      within(confirmation)
        .getByRole("button", { name: "Delete webhook" })
        .getAttribute("data-variant"),
    ).toBe("destructive");
    await user.click(
      within(confirmation).getByRole("button", { name: "Delete webhook" }),
    );
    expect(screen.queryByText("Operations bridge")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Operations bridge deleted.",
    );
  });

  it("does not recreate a webhook deleted in another tab while editing", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    await user.click(
      screen.getByRole("button", { name: "Manage Operations relay" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const editDialog = screen.getByRole("dialog", { name: "Edit webhook" });

    const deleted = structuredClone(defaultOrganizationIntegrations);
    deleted.webhooks = [];
    const raw = JSON.stringify(deleted);
    act(() => {
      localStorage.setItem(organizationIntegrationsKey, raw);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: organizationIntegrationsKey,
          newValue: raw,
        }),
      );
      window.dispatchEvent(new Event("cupboard-integrations-saved"));
    });

    fireEvent.submit(editDialog.querySelector("form")!);
    expect(
      await within(editDialog).findByText(
        "This webhook was deleted in another tab. Close this dialog without saving.",
      ),
    ).toBeTruthy();
    const save = within(editDialog).getByRole("button", {
      name: "Save changes",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    expect(
      JSON.parse(localStorage.getItem(organizationIntegrationsKey)!).webhooks,
    ).toEqual([]);
    expect(screen.queryByText("Operations relay added.")).toBeNull();
  });

  it("does not overwrite a webhook changed in another tab while editing", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    await user.click(
      screen.getByRole("button", { name: "Manage Operations relay" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const editDialog = screen.getByRole("dialog", { name: "Edit webhook" });

    const changed = structuredClone(defaultOrganizationIntegrations);
    changed.webhooks[0] = {
      ...changed.webhooks[0],
      name: "Updated elsewhere",
      url: "https://new.example.com/hooks/cupboard",
      events: ["player.reported"],
    };
    const raw = JSON.stringify(changed);
    act(() => {
      localStorage.setItem(organizationIntegrationsKey, raw);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: organizationIntegrationsKey,
          newValue: raw,
        }),
      );
      window.dispatchEvent(new Event("cupboard-integrations-saved"));
    });

    fireEvent.submit(editDialog.querySelector("form")!);
    expect(
      await within(editDialog).findByText(
        "This webhook changed in another tab. Close and reopen it before editing again.",
      ),
    ).toBeTruthy();
    expect(
      (
        within(editDialog).getByRole("button", {
          name: "Save changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    const stored = JSON.parse(
      localStorage.getItem(organizationIntegrationsKey)!,
    );
    expect(stored.webhooks[0]).toMatchObject(changed.webhooks[0]);
    expect(screen.queryByText("Operations relay updated.")).toBeNull();
  });

  it("does not report a simulated webhook retry as delivered", async () => {
    const user = userEvent.setup();
    const data = structuredClone(defaultOrganizationIntegrations);
    data.webhooks[0].lastDelivery = {
      status: 503,
      deliveredAt: "4 minutes ago",
    };
    localStorage.setItem(organizationIntegrationsKey, JSON.stringify(data));

    render(<OrganizationIntegrations />);

    expect(screen.getByText("Delivery failed")).toBeTruthy();
    expect(screen.getByText("Last delivery failed 4 minutes ago")).toBeTruthy();

    await user.click(screen.getByText("Operations relay").closest("button")!);
    const details = screen.getByRole("dialog", { name: "Operations relay" });
    await user.click(
      within(details).getByRole("button", { name: "Retry delivery" }),
    );
    expect(
      within(details).getByText(
        "Retry delivery isn't available in this sample-data preview.",
      ),
    ).toBeTruthy();
    expect(within(details).getByText("4 minutes ago")).toBeTruthy();
    expect(within(details).getByText("HTTP 503")).toBeTruthy();
    expect(
      within(details).getByRole("button", { name: "Retry delivery" }),
    ).toBeTruthy();
    expect(
      JSON.parse(localStorage.getItem(organizationIntegrationsKey)!).webhooks[0]
        .lastDelivery,
    ).toEqual({ status: 503, deliveredAt: "4 minutes ago" });
  });
});
