import { vi } from "vitest";

export function seedRaw(key: string, raw: string) {
  window.localStorage.setItem(key, raw);
}
export function removeRaw(key: string) {
  window.localStorage.removeItem(key);
}
export function dispatchSameTab(eventName: string) {
  window.dispatchEvent(new Event(eventName));
}
export function dispatchCrossTab(
  event: Pick<StorageEventInit, "key" | "oldValue" | "newValue">,
) {
  window.dispatchEvent(new StorageEvent("storage", event));
}
export function failStorage(
  method: "getItem" | "setItem" | "removeItem" | "access",
  predicate: (key: string) => boolean = () => true,
): () => void {
  if (method === "access") {
    const spy = vi
      .spyOn(window, "localStorage", "get")
      .mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
    return () => spy.mockRestore();
  }
  const original = Storage.prototype[method];
  const spy = vi.spyOn(Storage.prototype, method).mockImplementation(function (
    this: Storage,
    key: string,
    value?: string,
  ) {
    if (predicate(key)) throw new Error("Storage unavailable");
    return Reflect.apply(original, this, [key, value]);
  });
  return () => spy.mockRestore();
}
