// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { useState, useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PreviewStorageProvider,
  previewStorageKey,
  usePreviewStorage,
} from "./preview-storage";
import { OrganizationProvider } from "./organization-provider";
import { OrganizationProfileForm } from "./organization-profile-form";
import {
  defaultOrganizationProfile,
  organizationProfileKey,
} from "@/lib/organization-profile";
import { organizationIntegrationsKey } from "@/lib/organization-integrations";
import { organizationAccessKey } from "@/lib/organization-access";
import { organizationNotificationsKey } from "@/lib/organization-notifications";
import { securityAlertStorageKey } from "@/lib/security-alerts";

beforeEach(() => localStorage.clear());
afterEach(cleanup);
const bases = [
  organizationProfileKey,
  organizationIntegrationsKey,
  organizationAccessKey,
  organizationNotificationsKey,
  securityAlertStorageKey,
];

function Probe({ base }: { base: string }) {
  const store = usePreviewStorage(base, "saved");
  const value = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    () => null,
  );
  const [draft, setDraft] = useState("");
  return (
    <>
      <output>{value}</output>
      <input
        aria-label="Draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button onClick={() => store.set(draft)}>Save</button>
    </>
  );
}

it.each(bases)(
  "isolates %s across organizations and accounts, ignoring legacy data",
  (base) => {
    localStorage.setItem(base, "legacy");
    const view = (account: string, org: string | null) => (
      <PreviewStorageProvider accountId={account} organizationId={org}>
        <Probe base={base} />
      </PreviewStorageProvider>
    );
    const rendered = render(view("alice", "a"));
    expect(screen.getByRole("status").textContent).toBe("");
    fireEvent.change(screen.getByLabelText("Draft"), {
      target: { value: "A saved" },
    });
    fireEvent.click(screen.getByText("Save"));
    fireEvent.change(screen.getByLabelText("Draft"), {
      target: { value: "A unsaved" },
    });
    rendered.rerender(view("alice", "b"));
    expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("status").textContent).toBe("");
    fireEvent.change(screen.getByLabelText("Draft"), {
      target: { value: "B saved" },
    });
    fireEvent.click(screen.getByText("Save"));
    rendered.rerender(view("alice", "a"));
    expect(screen.getByRole("status").textContent).toBe("A saved");
    rendered.rerender(view("bob", "a"));
    expect(screen.getByRole("status").textContent).toBe("");
    rendered.rerender(view("alice", null));
    expect(screen.getByRole("status").textContent).toBe("");
    expect(localStorage.getItem(previewStorageKey("alice", "b", base))).toBe(
      "B saved",
    );
    expect(localStorage.getItem(base)).toBe("legacy");
  },
);

it("filters storage and same-tab notifications by scope", () => {
  const callback = vi.fn();
  const { result } = renderHook(
    () => usePreviewStorage(organizationProfileKey, "saved"),
    {
      wrapper: ({ children }) => (
        <PreviewStorageProvider accountId="a" organizationId="one">
          {children}
        </PreviewStorageProvider>
      ),
    },
  );
  const storage = result.current;
  const unsubscribe = storage.subscribe(callback);
  const own = previewStorageKey("a", "one", organizationProfileKey);
  const other = previewStorageKey("a", "two", organizationProfileKey);
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: other }));
    window.dispatchEvent(new CustomEvent("saved", { detail: other }));
  });
  expect(callback).not.toHaveBeenCalled();
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key: own }));
    storage.notify();
  });
  expect(callback).toHaveBeenCalledTimes(2);
  unsubscribe();
  storage.notify();
  expect(callback).toHaveBeenCalledTimes(2);
});

it("discards a real profile form's dirty draft on organization changes", () => {
  for (const org of ["a", "b"])
    localStorage.setItem(
      previewStorageKey("alice", org, organizationProfileKey),
      JSON.stringify({
        ...defaultOrganizationProfile,
        name: org,
        logoUrl: `https://example.com/${org}.png`,
      }),
    );
  const view = (org: string) => (
    <PreviewStorageProvider accountId="alice" organizationId={org}>
      <OrganizationProvider>
        <OrganizationProfileForm />
      </OrganizationProvider>
    </PreviewStorageProvider>
  );
  const rendered = render(view("a"));
  fireEvent.change(screen.getByLabelText(/Organization name/), {
    target: { value: "unsaved a" },
  });
  fireEvent.change(screen.getByLabelText("Organization logo URL"), {
    target: { value: "https://example.com/unsaved.png" },
  });
  rendered.rerender(view("b"));
  expect(
    (screen.getByLabelText("Organization logo URL") as HTMLInputElement).value,
  ).toBe("https://example.com/b.png");
  expect(
    (screen.getByLabelText(/Organization name/) as HTMLInputElement).value,
  ).toBe("b");
  rendered.rerender(view("a"));
  expect(
    (screen.getByLabelText("Organization logo URL") as HTMLInputElement).value,
  ).toBe("https://example.com/a.png");
  expect(
    (screen.getByLabelText(/Organization name/) as HTMLInputElement).value,
  ).toBe("a");
});
