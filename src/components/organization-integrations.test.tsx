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

function clearIntegrationsAsExternalUpdate() {
  const oldValue = localStorage.getItem(organizationIntegrationsKey);
  act(() => {
    localStorage.removeItem(organizationIntegrationsKey);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: organizationIntegrationsKey,
        oldValue,
        newValue: null,
      }),
    );
  });
}

describe("Organization credentials and webhooks", () => {
  it("keeps section actions reachable on narrow screens", () => {
    render(<OrganizationIntegrations />);

    for (const [sectionName, actionName] of [
      ["API credentials", "Create credential"],
      ["Webhooks", "Add webhook"],
    ] as const) {
      const section = screen.getByRole("region", { name: sectionName });
      expect(section.firstElementChild?.className).toContain("flex-col");
      expect(section.firstElementChild?.className).toContain("sm:flex-row");
      const action = within(section).getByRole("button", {
        name: actionName,
      });
      expect(action.className).toContain("w-full");
      expect(action.className).toContain("sm:w-auto");
    }
  });

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
    expect(
      within(createDialog).getByText(
        "Name this sample credential. It is stored in this browser and cannot authenticate to the Cupboard API.",
      ),
    ).toBeTruthy();
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
      screen.getByText(
        "This sample secret cannot authenticate. Copy it now if needed; Cupboard will not show it again.",
      ),
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

  it("does not recreate cleared data from an open credential form", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      organizationIntegrationsKey,
      JSON.stringify(defaultOrganizationIntegrations),
    );
    render(<OrganizationIntegrations />);

    await user.click(screen.getByRole("button", { name: "Create credential" }));
    await user.type(
      screen.getByRole("textbox", { name: "Credential name" }),
      "Deploy agent",
    );
    clearIntegrationsAsExternalUpdate();
    await user.click(
      screen
        .getByRole("dialog", { name: "Create API credential" })
        .querySelector('button[type="submit"]')!,
    );

    expect(localStorage.getItem(organizationIntegrationsKey)).toBeNull();
    const dialog = screen.getByRole("dialog", {
      name: "Create API credential",
    });
    expect(
      within(dialog).getByText(
        "Integration data was cleared in another tab. Close and reopen this form before creating a credential.",
      ),
    ).toBeTruthy();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Create credential",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("preserves a credential draft when integration data becomes unreadable", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    await user.click(screen.getByRole("button", { name: "Create credential" }));
    await user.type(
      screen.getByRole("textbox", { name: "Credential name" }),
      "Deploy agent",
    );
    localStorage.setItem(organizationIntegrationsKey, "");

    await user.click(
      screen
        .getByRole("dialog", { name: "Create API credential" })
        .querySelector('button[type="submit"]')!,
    );

    expect(localStorage.getItem(organizationIntegrationsKey)).toBe("");
    expect(
      screen.getByRole("alertdialog", {
        name: "Replace unreadable integration data?",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "Credential created" }),
    ).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "Create API credential" }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Keep data" }));
    const restored = screen.getByRole("dialog", {
      name: "Create API credential",
    });
    expect(
      (
        within(restored).getByRole("textbox", {
          name: "Credential name",
        }) as HTMLInputElement
      ).value,
    ).toBe("Deploy agent");

    localStorage.setItem(
      organizationIntegrationsKey,
      JSON.stringify(defaultOrganizationIntegrations),
    );
    await user.click(
      within(restored).getByRole("button", { name: "Create credential" }),
    );
    expect(screen.getByTestId("created-credential")).toBeTruthy();
    expect(localStorage.getItem(organizationIntegrationsKey)).toContain(
      "Deploy agent",
    );
  });

  it("preserves a webhook draft when integration data becomes unreadable", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    await user.click(screen.getByRole("button", { name: "Add webhook" }));
    await user.type(
      screen.getByRole("textbox", { name: "Webhook name" }),
      "Incident relay",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Endpoint URL" }),
      "https://hooks.example.com/incidents",
    );
    await user.click(screen.getByRole("checkbox", { name: "Player reported" }));
    localStorage.setItem(organizationIntegrationsKey, "unreadable-data");

    await user.click(
      screen
        .getByRole("dialog", { name: "Add webhook" })
        .querySelector('button[type="submit"]')!,
    );
    await user.click(screen.getByRole("button", { name: "Keep data" }));

    const restored = screen.getByRole("dialog", { name: "Add webhook" });
    expect(
      (
        within(restored).getByRole("textbox", {
          name: "Webhook name",
        }) as HTMLInputElement
      ).value,
    ).toBe("Incident relay");
    expect(
      (
        within(restored).getByRole("textbox", {
          name: "Endpoint URL",
        }) as HTMLInputElement
      ).value,
    ).toBe("https://hooks.example.com/incidents");
    expect(
      (
        within(restored).getByRole("checkbox", {
          name: "Player reported",
        }) as HTMLButtonElement
      ).getAttribute("data-state"),
    ).toBe("checked");

    localStorage.setItem(
      organizationIntegrationsKey,
      JSON.stringify(defaultOrganizationIntegrations),
    );
    await user.click(
      within(restored).getByRole("button", { name: "Add webhook" }),
    );
    expect(localStorage.getItem(organizationIntegrationsKey)).toContain(
      "Incident relay",
    );
  });

  it("rebases a credential draft after replacing unreadable data", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      organizationIntegrationsKey,
      JSON.stringify(defaultOrganizationIntegrations),
    );
    render(<OrganizationIntegrations />);

    await user.click(screen.getByRole("button", { name: "Create credential" }));
    await user.type(
      screen.getByRole("textbox", { name: "Credential name" }),
      "Recovered draft",
    );
    localStorage.setItem(organizationIntegrationsKey, "unreadable-data");
    await user.click(
      screen
        .getByRole("dialog", { name: "Create API credential" })
        .querySelector('button[type="submit"]')!,
    );
    const replacement = screen.getByRole("alertdialog", {
      name: "Replace unreadable integration data?",
    });
    await user.click(
      within(replacement).getByRole("button", { name: "Replace local data" }),
    );

    const restored = screen.getByRole("dialog", {
      name: "Create API credential",
    });
    expect(
      (
        within(restored).getByRole("textbox", {
          name: "Credential name",
        }) as HTMLInputElement
      ).value,
    ).toBe("Recovered draft");
    await user.click(
      within(restored).getByRole("button", { name: "Create credential" }),
    );
    expect(screen.getByTestId("created-credential")).toBeTruthy();
    expect(localStorage.getItem(organizationIntegrationsKey)).toContain(
      "Recovered draft",
    );
    expect(
      screen.queryByText(
        "Integration data was cleared in another tab. Close and reopen this form before creating a credential.",
      ),
    ).toBeNull();
  });

  it("rebases a new webhook draft after replacing unreadable data", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      organizationIntegrationsKey,
      JSON.stringify(defaultOrganizationIntegrations),
    );
    render(<OrganizationIntegrations />);

    await user.click(screen.getByRole("button", { name: "Add webhook" }));
    const dialog = screen.getByRole("dialog", { name: "Add webhook" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Webhook name" }),
      "Recovered webhook",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "Endpoint URL" }),
      "https://hooks.example.com/recovered",
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Player reported" }),
    );
    localStorage.setItem(organizationIntegrationsKey, "unreadable-data");
    await user.click(
      within(dialog).getByRole("button", { name: "Add webhook" }),
    );
    await user.click(
      screen
        .getByRole("alertdialog", {
          name: "Replace unreadable integration data?",
        })
        .querySelector('[data-slot="alert-dialog-action"]')!,
    );

    const restored = screen.getByRole("dialog", { name: "Add webhook" });
    await user.click(
      within(restored).getByRole("button", { name: "Add webhook" }),
    );
    expect(screen.getByText("Recovered webhook")).toBeTruthy();
    expect(localStorage.getItem(organizationIntegrationsKey)).toContain(
      "https://hooks.example.com/recovered",
    );
  });

  it("rebases a sample webhook edit after replacing unreadable data", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      organizationIntegrationsKey,
      JSON.stringify(defaultOrganizationIntegrations),
    );
    render(<OrganizationIntegrations />);

    await user.click(
      screen.getByRole("button", { name: "Manage Operations relay" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit webhook" });
    const name = within(dialog).getByRole("textbox", { name: "Webhook name" });
    await user.clear(name);
    await user.type(name, "Recovered sample webhook");
    localStorage.setItem(organizationIntegrationsKey, "unreadable-data");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    await user.click(
      screen
        .getByRole("alertdialog", {
          name: "Replace unreadable integration data?",
        })
        .querySelector('[data-slot="alert-dialog-action"]')!,
    );

    const restored = screen.getByRole("dialog", { name: "Edit webhook" });
    await user.click(
      within(restored).getByRole("button", { name: "Save changes" }),
    );
    expect(screen.getByText("Recovered sample webhook")).toBeTruthy();
    expect(localStorage.getItem(organizationIntegrationsKey)).toContain(
      "Recovered sample webhook",
    );
  });

  it("requires confirmation before replacing unreadable integration data", async () => {
    const user = userEvent.setup();
    localStorage.setItem(organizationIntegrationsKey, "");
    localStorage.setItem("unrelated-preview-data", "keep-me");
    render(<OrganizationIntegrations />);

    expect(
      screen.getByText(
        "Saved integration data could not be loaded. Showing the last loaded data; changes are disabled.",
      ),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Create credential",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Add webhook" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getAllByRole("button", {
          name: /Credential actions for/,
        })[0] as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Manage Operations relay",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await user.click(
      screen.getByRole("button", { name: "Replace local data" }),
    );
    const confirmation = screen.getByRole("alertdialog", {
      name: "Replace unreadable integration data?",
    });
    expect(localStorage.getItem(organizationIntegrationsKey)).toBe("");
    expect(
      within(confirmation)
        .getByRole("button", { name: "Keep data" })
        .getAttribute("data-variant"),
    ).toBe("secondary");
    expect(
      within(confirmation)
        .getByRole("button", { name: "Replace local data" })
        .getAttribute("data-variant"),
    ).toBe("destructive");

    await user.click(
      within(confirmation).getByRole("button", {
        name: "Replace local data",
      }),
    );
    expect(localStorage.getItem(organizationIntegrationsKey)).toBeNull();
    expect(localStorage.getItem("unrelated-preview-data")).toBe("keep-me");
    expect(
      screen.queryByText(
        "Saved integration data could not be loaded. Showing the last loaded data; changes are disabled.",
      ),
    ).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Create credential",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("does not replace integration data repaired after confirmation opens", async () => {
    const user = userEvent.setup();
    localStorage.setItem(organizationIntegrationsKey, "unreadable-data");
    render(<OrganizationIntegrations />);

    await user.click(
      screen.getByRole("button", { name: "Replace local data" }),
    );
    const repaired = structuredClone(defaultOrganizationIntegrations);
    repaired.credentials[0].name = "Repaired elsewhere";
    const raw = JSON.stringify(repaired);
    localStorage.setItem(organizationIntegrationsKey, raw);

    await user.click(
      screen
        .getByRole("alertdialog", {
          name: "Replace unreadable integration data?",
        })
        .querySelector('[data-slot="alert-dialog-action"]')!,
    );

    expect(localStorage.getItem(organizationIntegrationsKey)).toBe(raw);
    expect(
      screen.getByText(
        "Saved integration data changed. Review it before replacing.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Repaired elsewhere")).toBeTruthy();
    expect(
      screen.queryByText(
        "Unreadable integration data replaced with sample data.",
      ),
    ).toBeNull();
  });

  it("keeps the last valid integration data visible while storage is unreadable", async () => {
    const user = userEvent.setup();
    const custom = structuredClone(defaultOrganizationIntegrations);
    custom.credentials = [
      {
        id: "custom-credential",
        name: "Custom credential",
        prefix: "cb_live_CUSTOM...1234",
        createdAt: "Sep 16, 2026",
        lastUsed: null,
      },
    ];
    custom.webhooks = [
      {
        id: "custom-webhook",
        name: "Custom webhook",
        url: "https://custom.example.com/hooks/cupboard",
        events: ["player.reported"],
        enabled: true,
        createdAt: "Sep 16, 2026",
        lastDelivery: null,
      },
    ];
    localStorage.setItem(organizationIntegrationsKey, JSON.stringify(custom));
    render(<OrganizationIntegrations />);

    await user.click(screen.getByText("Custom webhook").closest("button")!);
    const details = screen.getByRole("dialog", { name: "Custom webhook" });
    const malformed = "unreadable-data";
    act(() => {
      localStorage.setItem(organizationIntegrationsKey, malformed);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: organizationIntegrationsKey,
          newValue: malformed,
        }),
      );
    });

    expect(screen.getByText("Custom credential")).toBeTruthy();
    expect(screen.getAllByText("Custom webhook").length).toBeGreaterThan(0);
    expect(screen.queryByText("Server operations")).toBeNull();
    expect(screen.queryByText("Operations relay")).toBeNull();
    expect(
      screen.getByText(
        "Saved integration data could not be loaded. Showing the last loaded data; changes are disabled.",
      ),
    ).toBeTruthy();
    expect(
      (
        within(details).getByRole("button", {
          name: "Edit",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        within(details).getByRole("button", {
          name: "Delete",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(localStorage.getItem(organizationIntegrationsKey)).toBe(malformed);

    const recovered = structuredClone(custom);
    recovered.credentials[0].name = "Recovered credential";
    recovered.webhooks[0].name = "Recovered webhook";
    const recoveredRaw = JSON.stringify(recovered);
    act(() => {
      localStorage.setItem(organizationIntegrationsKey, recoveredRaw);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: organizationIntegrationsKey,
          newValue: recoveredRaw,
        }),
      );
    });

    expect(screen.getByText("Recovered credential")).toBeTruthy();
    expect(
      screen.getByRole("dialog", { name: "Recovered webhook" }),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Saved integration data could not be loaded. Showing the last loaded data; changes are disabled.",
      ),
    ).toBeNull();
    expect(
      (
        within(details).getByRole("button", {
          name: "Edit",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
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
    expect(dialog.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(dialog.className).toContain("overflow-y-auto");
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

  it("does not recreate cleared data from an open webhook form", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      organizationIntegrationsKey,
      JSON.stringify(defaultOrganizationIntegrations),
    );
    render(<OrganizationIntegrations />);

    await user.click(screen.getByRole("button", { name: "Add webhook" }));
    const dialog = screen.getByRole("dialog", { name: "Add webhook" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Webhook name" }),
      "Incident relay",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "Endpoint URL" }),
      "https://hooks.example.com/incidents",
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: "Player reported" }),
    );
    clearIntegrationsAsExternalUpdate();
    await user.click(
      within(dialog).getByRole("button", { name: "Add webhook" }),
    );

    expect(localStorage.getItem(organizationIntegrationsKey)).toBeNull();
    expect(
      within(dialog).getByText(
        "Integration data was cleared in another tab. Close and reopen this form before saving.",
      ),
    ).toBeTruthy();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Add webhook",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("requires confirmation before revoking a credential", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    await user.click(
      screen.getByRole("button", {
        name: "Credential actions for Server operations",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Revoke" }));
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

  it("rotates a credential from its action menu without storing the secret", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    await user.click(
      screen.getByRole("button", {
        name: "Credential actions for Server operations",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Rotate key" }));

    const confirmation = screen.getByRole("alertdialog", {
      name: "Rotate Server operations?",
    });
    await user.click(
      within(confirmation).getByRole("button", { name: "Rotate key" }),
    );

    const rotated = screen.getByRole("dialog", {
      name: "Credential rotated",
    });
    const secret =
      within(rotated).getByTestId("created-credential").textContent!;
    const stored = localStorage.getItem(organizationIntegrationsKey)!;
    expect(secret).toMatch(/^cb_live_[A-F0-9]{36}$/);
    expect(stored).not.toContain(secret);
    expect(JSON.parse(stored).credentials[0]).toMatchObject({
      lastUsed: null,
      prefix: `${secret.slice(0, 12)}...${secret.slice(-4)}`,
    });
    expect(screen.getByText("Server operations rotated.")).toBeTruthy();
  });

  it("does not recreate cleared data from a credential revocation", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      organizationIntegrationsKey,
      JSON.stringify(defaultOrganizationIntegrations),
    );
    render(<OrganizationIntegrations />);

    await user.click(
      screen.getByRole("button", {
        name: "Credential actions for Server operations",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Revoke" }));
    const confirmation = screen.getByRole("alertdialog", {
      name: "Revoke Server operations?",
    });
    clearIntegrationsAsExternalUpdate();
    await user.click(
      within(confirmation).getByRole("button", {
        name: "Revoke credential",
      }),
    );

    expect(localStorage.getItem(organizationIntegrationsKey)).toBeNull();
    expect(
      within(confirmation).getByText(
        "Integration data was cleared in another tab. Close this confirmation before trying again.",
      ),
    ).toBeTruthy();
    expect(
      (
        within(confirmation).getByRole("button", {
          name: "Revoke credential",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
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

  it("offers icon actions and pauses or resumes a webhook", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    const webhookName = screen.getByText("Operations relay");
    const row = webhookName.closest(".group")!;
    expect(row.className).toContain("hover:bg-surface-elevated");

    await user.click(
      screen.getByRole("button", { name: "Manage Operations relay" }),
    );
    for (const action of ["View", "Edit", "Pause", "Delete"]) {
      const item = screen.getByRole("menuitem", { name: action });
      expect(item.querySelector("svg")).toBeTruthy();
    }
    await user.click(screen.getByRole("menuitem", { name: "Pause" }));

    expect(screen.getByText("Paused")).toBeTruthy();
    expect(
      JSON.parse(localStorage.getItem(organizationIntegrationsKey)!).webhooks[0]
        .enabled,
    ).toBe(false);
    expect(screen.getByRole("status").textContent).toBe(
      "Operations relay paused.",
    );

    await user.click(
      screen.getByRole("button", { name: "Manage Operations relay" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Resume" }));
    expect(screen.getByText("Active")).toBeTruthy();
    expect(
      JSON.parse(localStorage.getItem(organizationIntegrationsKey)!).webhooks[0]
        .enabled,
    ).toBe(true);
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
      within(confirmation).getByText(
        "This removes the endpoint and its sample delivery history from this browser preview. This cannot be undone.",
      ),
    ).toBeTruthy();
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
      "Operations bridge deleted from preview data.",
    );
  });

  it("does not recreate cleared data from an open webhook edit", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      organizationIntegrationsKey,
      JSON.stringify(defaultOrganizationIntegrations),
    );
    render(<OrganizationIntegrations />);

    await user.click(
      screen.getByRole("button", { name: "Manage Operations relay" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit webhook" });
    clearIntegrationsAsExternalUpdate();
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    expect(localStorage.getItem(organizationIntegrationsKey)).toBeNull();
    expect(
      within(dialog).getByText(
        "Integration data was cleared in another tab. Close and reopen this form before saving.",
      ),
    ).toBeTruthy();
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Save changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("does not recreate cleared data from a webhook deletion", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      organizationIntegrationsKey,
      JSON.stringify(defaultOrganizationIntegrations),
    );
    render(<OrganizationIntegrations />);

    await user.click(
      screen.getByRole("button", { name: "Manage Operations relay" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirmation = screen.getByRole("alertdialog", {
      name: "Delete Operations relay?",
    });
    clearIntegrationsAsExternalUpdate();
    await user.click(
      within(confirmation).getByRole("button", { name: "Delete webhook" }),
    );

    expect(localStorage.getItem(organizationIntegrationsKey)).toBeNull();
    expect(
      within(confirmation).getByText(
        "Integration data was cleared in another tab. Close this confirmation before trying again.",
      ),
    ).toBeTruthy();
    expect(
      (
        within(confirmation).getByRole("button", {
          name: "Delete webhook",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("does not delete a webhook changed after confirmation opens", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    await user.click(
      screen.getByRole("button", { name: "Manage Operations relay" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirmation = screen.getByRole("alertdialog", {
      name: "Delete Operations relay?",
    });
    const changed = structuredClone(defaultOrganizationIntegrations);
    changed.webhooks[0].url = "https://new.example.com/hooks/cupboard";
    const raw = JSON.stringify(changed);
    localStorage.setItem(organizationIntegrationsKey, raw);

    await user.click(
      within(confirmation).getByRole("button", { name: "Delete webhook" }),
    );

    expect(localStorage.getItem(organizationIntegrationsKey)).toBe(raw);
    expect(
      within(confirmation).getByText(
        "This webhook changed in another tab. Close and reopen the confirmation before deleting it.",
      ),
    ).toBeTruthy();
    expect(
      (
        within(confirmation).getByRole("button", {
          name: "Delete webhook",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.queryByText("Operations relay deleted from preview data."),
    ).toBeNull();
  });

  it("does not report success when a confirmed webhook was already deleted", async () => {
    const user = userEvent.setup();
    render(<OrganizationIntegrations />);

    await user.click(
      screen.getByRole("button", { name: "Manage Operations relay" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirmation = screen.getByRole("alertdialog", {
      name: "Delete Operations relay?",
    });
    const deleted = structuredClone(defaultOrganizationIntegrations);
    deleted.webhooks = [];
    const raw = JSON.stringify(deleted);
    localStorage.setItem(organizationIntegrationsKey, raw);

    await user.click(
      within(confirmation).getByRole("button", { name: "Delete webhook" }),
    );

    expect(localStorage.getItem(organizationIntegrationsKey)).toBe(raw);
    expect(
      within(confirmation).getByText(
        "This webhook was already deleted in another tab. Close this confirmation.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Operations relay deleted from preview data."),
    ).toBeNull();
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
