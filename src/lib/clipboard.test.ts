// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("uses the async clipboard when the browser offers it", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyText("https://example.com/status/northstar");
    expect(writeText).toHaveBeenCalledWith(
      "https://example.com/status/northstar",
    );
  });

  it("falls back to the copy command on plain HTTP and restores focus", async () => {
    vi.stubGlobal("navigator", {});
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    let selected = "";
    document.execCommand = vi.fn(() => {
      selected = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    });
    await copyText("http://100.107.41.153:26103/status/northstar");
    expect(selected).toBe("http://100.107.41.153:26103/status/northstar");
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it("reports a failed copy", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error())) },
    });
    document.execCommand = vi.fn(() => false);
    await expect(copyText("x")).rejects.toThrow("Copy failed.");
  });
});
