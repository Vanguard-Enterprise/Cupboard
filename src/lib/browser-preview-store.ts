export type RawSnapshot =
  | Readonly<{ status: "not-ready" }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "available"; raw: string }>
  | Readonly<{ status: "unavailable" }>;

export type RawPreviewStore = {
  getSnapshot(): RawSnapshot;
  getServerSnapshot(): RawSnapshot;
  subscribe(callback: () => void): () => void;
  write(raw: string): void;
};

const notReady: RawSnapshot = Object.freeze({ status: "not-ready" });
const missing: RawSnapshot = Object.freeze({ status: "missing" });
const unavailable: RawSnapshot = Object.freeze({ status: "unavailable" });

export function createRawPreviewStore({
  key,
  changedEvent,
}: {
  key: string;
  changedEvent: string;
}): RawPreviewStore {
  let previous: RawSnapshot = notReady;
  return {
    getSnapshot() {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) previous = missing;
        else if (previous.status !== "available" || previous.raw !== raw) {
          previous = Object.freeze({ status: "available", raw });
        }
      } catch {
        previous = unavailable;
      }
      return previous;
    },
    getServerSnapshot: () => notReady,
    subscribe(callback) {
      const onStorage = (event: StorageEvent) => {
        if (!event.key || event.key === key) callback();
      };
      window.addEventListener("storage", onStorage);
      window.addEventListener(changedEvent, callback);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(changedEvent, callback);
      };
    },
    write(raw) {
      window.localStorage.setItem(key, raw);
      window.dispatchEvent(new Event(changedEvent));
    },
  };
}
