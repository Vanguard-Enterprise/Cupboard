import { describe, expect, it } from "vitest";
import {
  clampZoom,
  drawLogo,
  frameAspect,
  initialEdit,
  outputSize,
} from "./status-logo-editor";

const wide = { width: 600, height: 300 };

function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const context = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "calls") return calls;
        return (...args: unknown[]) => calls.push([String(key), ...args]);
      },
      set: (_target, key, value) => {
        calls.push([`set ${String(key)}`, value]);
        return true;
      },
    },
  ) as CanvasRenderingContext2D & { calls: typeof calls };
  return context;
}

describe("logo editor geometry", () => {
  it("frames the original shape after rotation and clamps extreme ratios", () => {
    expect(frameAspect(wide, initialEdit)).toBe(2);
    expect(frameAspect(wide, { ...initialEdit, rotation: 90 })).toBe(0.5);
    expect(frameAspect({ width: 1000, height: 10 }, initialEdit)).toBe(4);
    expect(frameAspect(wide, { ...initialEdit, shape: "square" })).toBe(1);
    expect(frameAspect(wide, { ...initialEdit, shape: "wide" })).toBe(3);
  });

  it("exports at most 640 pixels on the longest side", () => {
    expect(outputSize(2)).toEqual({ width: 640, height: 320 });
    expect(outputSize(0.5)).toEqual({ width: 320, height: 640 });
    expect(outputSize(1, 160)).toEqual({ width: 160, height: 160 });
  });

  it("keeps zoom between half and five times", () => {
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(9)).toBe(5);
    expect(clampZoom(1.234)).toBe(1.23);
  });

  it("fits the whole image at zoom 1 and applies pan, rotation, flip, and fill", () => {
    const context = recorder();
    const source = {} as CanvasImageSource;
    drawLogo(
      context,
      source,
      wide,
      initialEdit,
      { width: 640, height: 320 },
      "#7cb58d",
    );
    const draw = context.calls.find(([name]) => name === "drawImage");
    expect(draw).toEqual(["drawImage", source, -320, -160, 640, 320]);
    expect(context.calls.some(([name]) => name === "fillRect")).toBe(false);

    const edited = recorder();
    drawLogo(
      edited,
      source,
      wide,
      {
        ...initialEdit,
        shape: "square",
        zoom: 2,
        rotation: 90,
        flip: true,
        background: "accent",
        x: 0.25,
        y: -0.5,
      },
      { width: 100, height: 100 },
      "#ff0000",
    );
    expect(edited.calls).toContainEqual(["set fillStyle", "#ff0000"]);
    expect(edited.calls).toContainEqual(["fillRect", 0, 0, 100, 100]);
    expect(edited.calls).toContainEqual(["translate", 75, 0]);
    expect(edited.calls).toContainEqual(["rotate", Math.PI / 2]);
    expect(edited.calls).toContainEqual(["scale", -1, 1]);
    // Turned 90 degrees the image is 300 by 600, so it fits at 1/6, then doubles.
    const scaled = edited.calls.find(([name]) => name === "drawImage");
    expect(scaled?.slice(2).map((value) => Math.round(Number(value)))).toEqual([
      -100, -50, 200, 100,
    ]);
  });

  it("falls back to the default accent when the draft color is invalid", () => {
    const context = recorder();
    drawLogo(
      context,
      {} as CanvasImageSource,
      wide,
      { ...initialEdit, background: "accent" },
      { width: 10, height: 10 },
      "not a color",
    );
    expect(context.calls).toContainEqual(["set fillStyle", "#7cb58d"]);
  });
});
