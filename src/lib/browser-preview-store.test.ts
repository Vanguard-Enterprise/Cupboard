// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRawPreviewStore } from "./browser-preview-store";
import {
  dispatchCrossTab,
  dispatchSameTab,
  failStorage,
  removeRaw,
  seedRaw,
} from "@/test/browser-storage";

const identity = { key: "preview-test", changedEvent: "preview-test-changed" };
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("raw preview store", () => {
  it("does not access browser storage on construction or server snapshots", () => {
    const browser = window;
    vi.stubGlobal("window", undefined);
    try {
      const serverStore = createRawPreviewStore(identity);
      expect(serverStore.getServerSnapshot()).toEqual({ status: "not-ready" });
    } finally {
      vi.stubGlobal("window", browser);
    }
    const get = vi
      .spyOn(window, "localStorage", "get")
      .mockImplementation(() => {
        throw new Error("Unavailable");
      });
    const store = createRawPreviewStore(identity);
    expect(store.getServerSnapshot()).toEqual({ status: "not-ready" });
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
    expect(store.getSnapshot()).toEqual({ status: "missing" });
  });

  it("reuses only the immediately previous available bytes and preserves server separation", () => {
    const store = createRawPreviewStore(identity);
    seedRaw(identity.key, "X");
    const first = store.getSnapshot();
    expect(first).toEqual({ status: "available", raw: "X" });
    expect(store.getSnapshot()).toBe(first);
    store.getServerSnapshot();
    expect(store.getSnapshot()).toBe(first);
    seedRaw(identity.key, "Y");
    expect(store.getSnapshot()).not.toBe(first);
    seedRaw(identity.key, "X");
    const again = store.getSnapshot();
    expect(again).not.toBe(first);
    removeRaw(identity.key);
    const missing = store.getSnapshot();
    expect(store.getSnapshot()).toBe(missing);
    seedRaw(identity.key, "X");
    expect(store.getSnapshot()).not.toBe(again);
  });

  it.each(["getItem", "access"] as const)(
    "recovers to a new object after %s failure with identical bytes",
    (method) => {
      seedRaw(identity.key, "X");
      const store = createRawPreviewStore(identity);
      const first = store.getSnapshot();
      const restore = failStorage(method);
      const unavailable = store.getSnapshot();
      expect(unavailable).toEqual({ status: "unavailable" });
      expect(store.getSnapshot()).toBe(unavailable);
      restore();
      const recovered = store.getSnapshot();
      expect(recovered).toEqual(first);
      expect(recovered).not.toBe(first);
      expect(store.getSnapshot()).toBe(recovered);
    },
  );

  it.each(["", "{broken", "null", "{}"])(
    "exposes raw bytes without decoding %s",
    (raw) => {
      seedRaw(identity.key, raw);
      expect(createRawPreviewStore(identity).getSnapshot()).toEqual({
        status: "available",
        raw,
      });
    },
  );

  it("selects custom, matching and null-key events and cleans up exact listeners", () => {
    const store = createRawPreviewStore(identity);
    const callback = vi.fn();
    const unsubscribe = store.subscribe(callback);
    dispatchSameTab("other");
    dispatchCrossTab({ key: "other" });
    expect(callback).not.toHaveBeenCalled();
    dispatchSameTab(identity.changedEvent);
    dispatchCrossTab({ key: identity.key, oldValue: "same", newValue: "same" });
    dispatchCrossTab({ key: null });
    dispatchCrossTab({ key: "" });
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: identity.key,
        storageArea: sessionStorage,
      }),
    );
    expect(callback).toHaveBeenCalledTimes(5);
    expect(localStorage.getItem(identity.key)).toBeNull();
    unsubscribe();
    dispatchSameTab(identity.changedEvent);
    dispatchCrossTab({ key: identity.key });
    expect(callback).toHaveBeenCalledTimes(5);
  });

  it("writes before notification and leaves snapshot observation to subscribers", () => {
    const store = createRawPreviewStore(identity);
    seedRaw(identity.key, "X");
    const first = store.getSnapshot();
    const notices: (string | null)[] = [];
    const unsubscribe = store.subscribe(() =>
      notices.push(localStorage.getItem(identity.key)),
    );
    store.write("Y");
    expect(notices).toEqual(["Y"]);
    seedRaw(identity.key, "X");
    expect(store.getSnapshot()).toBe(first);
    unsubscribe();
    const observe = store.subscribe(() => store.getSnapshot());
    store.write("Y");
    seedRaw(identity.key, "X");
    expect(store.getSnapshot()).not.toBe(first);
    observe();
  });

  it.each(["setItem", "access"] as const)(
    "propagates failed %s writes without notification, cache changes or logging",
    (method) => {
      const store = createRawPreviewStore(identity);
      seedRaw(identity.key, "X");
      const first = store.getSnapshot();
      const callback = vi.fn();
      const unsubscribe = store.subscribe(callback);
      const log = vi.spyOn(console, "log");
      const warn = vi.spyOn(console, "warn");
      const error = vi.spyOn(console, "error");
      const restore = failStorage(method);
      expect(() => store.write("Y")).toThrow();
      expect(callback).not.toHaveBeenCalled();
      restore();
      expect(store.getSnapshot()).toBe(first);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      unsubscribe();
    },
  );

  it("keeps cache identity independent across stores sharing a key", () => {
    seedRaw(identity.key, "X");
    const first = createRawPreviewStore(identity);
    const second = createRawPreviewStore(identity);
    const original = first.getSnapshot();
    expect(second.getSnapshot()).not.toBe(original);
    seedRaw(identity.key, "Y");
    second.getSnapshot();
    seedRaw(identity.key, "X");
    expect(first.getSnapshot()).toBe(original);
  });
});
