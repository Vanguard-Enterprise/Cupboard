"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  FlipHorizontal2Icon,
  ImageUpIcon,
  RotateCcwIcon,
  RotateCwIcon,
  UndoIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { validColor } from "@/lib/status-page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type LogoShape = "original" | "square" | "wide";
export type LogoBackground = "none" | "white" | "black" | "accent";

export type LogoEdit = {
  shape: LogoShape;
  zoom: number;
  rotation: 0 | 90 | 180 | 270;
  flip: boolean;
  background: LogoBackground;
  /** Pan from the frame center, in frame heights. */
  x: number;
  y: number;
};

export const initialEdit: LogoEdit = {
  shape: "original",
  zoom: 1,
  rotation: 0,
  flip: false,
  background: "none",
  x: 0,
  y: 0,
};

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
/** The longest exported side. The server shrinks it further. */
const EXPORT_EDGE = 640;
/** The stage is 16:9; the frame keeps a margin inside it. */
const STAGE_ASPECT = 16 / 9;

const shapeLabel: Record<LogoShape, string> = {
  original: "Original",
  square: "Square",
  wide: "Wide",
};
const backgroundLabel: Record<LogoBackground, string> = {
  none: "Transparent",
  white: "White",
  black: "Black",
  accent: "Accent",
};

type Size = { width: number; height: number };

/** The image size after a quarter-turn rotation. */
function turned(image: Size, rotation: LogoEdit["rotation"]): Size {
  return rotation % 180 === 0
    ? image
    : { width: image.height, height: image.width };
}

/** Width over height of the crop, between a tall 1:2 and a wide 4:1. */
export function frameAspect(image: Size, edit: LogoEdit) {
  if (edit.shape === "square") return 1;
  if (edit.shape === "wide") return 3;
  const size = turned(image, edit.rotation);
  return Math.min(4, Math.max(0.5, size.width / size.height));
}

export function clampZoom(zoom: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100));
}

/**
 * Draws the edited logo onto a canvas whose aspect matches the frame. At zoom
 * 1 the whole image fits inside the frame, so nothing is cut off by default.
 */
export function drawLogo(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  image: Size,
  edit: LogoEdit,
  output: Size,
  accent: string,
) {
  const { width, height } = output;
  context.clearRect(0, 0, width, height);
  if (edit.background !== "none") {
    context.fillStyle =
      edit.background === "white"
        ? "#ffffff"
        : edit.background === "black"
          ? "#000000"
          : validColor(accent)
            ? accent
            : "#7cb58d";
    context.fillRect(0, 0, width, height);
  }
  const size = turned(image, edit.rotation);
  const scale = Math.min(width / size.width, height / size.height) * edit.zoom;
  context.save();
  context.translate(width / 2 + edit.x * height, height / 2 + edit.y * height);
  context.rotate((edit.rotation * Math.PI) / 180);
  context.scale(edit.flip ? -1 : 1, 1);
  context.imageSmoothingQuality = "high";
  context.drawImage(
    source,
    (-image.width * scale) / 2,
    (-image.height * scale) / 2,
    image.width * scale,
    image.height * scale,
  );
  context.restore();
}

export function outputSize(aspect: number, edge = EXPORT_EDGE): Size {
  return aspect >= 1
    ? { width: edge, height: Math.max(1, Math.round(edge / aspect)) }
    : { width: Math.max(1, Math.round(edge * aspect)), height: edge };
}

/** Where a snapped guide sits, in frame heights from the frame center. */
export type Guides = { x: number | null; y: number | null };

/**
 * Snaps a dragged position so the image's center or edges line up with the
 * frame's center lines or edges. `threshold` is in frame heights.
 */
export function snap(
  image: Size,
  edit: LogoEdit,
  x: number,
  y: number,
  threshold: number,
): { x: number; y: number; guides: Guides } {
  const aspect = frameAspect(image, edit);
  const size = turned(image, edit.rotation);
  // Image size in frame heights; the frame is `aspect` wide and 1 tall.
  const scale = Math.min(aspect / size.width, 1 / size.height) * edit.zoom;
  const halfWidth = (size.width * scale) / 2;
  const halfHeight = (size.height * scale) / 2;
  const axis = (value: number, half: number, frameHalf: number) => {
    // Each candidate pairs the offset that aligns it with the guide it shows.
    const candidates: [number, number][] = [
      [0, 0],
      [half - frameHalf, -frameHalf],
      [frameHalf - half, frameHalf],
    ];
    let best: [number, number] | null = null;
    for (const candidate of candidates) {
      const distance = Math.abs(value - candidate[0]);
      if (
        distance <= threshold &&
        (!best || distance < Math.abs(value - best[0]))
      )
        best = candidate;
    }
    return best
      ? { value: best[0], guide: best[1] }
      : { value, guide: null as number | null };
  };
  const snappedX = axis(x, halfWidth, aspect / 2);
  const snappedY = axis(y, halfHeight, 0.5);
  return {
    x: snappedX.value,
    y: snappedY.value,
    guides: { x: snappedX.guide, y: snappedY.guide },
  };
}

/** Screen pixels within which a drag snaps to a guide. */
const SNAP_PIXELS = 6;

type Loaded = { element: HTMLImageElement; width: number; height: number };

function loadImage(url: string) {
  return new Promise<Loaded>((resolve, reject) => {
    const element = new Image();
    element.decoding = "async";
    element.onload = () =>
      // SVG files without a size report zero, so give them a working canvas.
      resolve({
        element,
        width: element.naturalWidth || 512,
        height: element.naturalHeight || 512,
      });
    element.onerror = () =>
      reject(new Error("That file is not an image Cupboard can read."));
    element.src = url;
  });
}

function exportPng(loaded: Loaded, edit: LogoEdit, accent: string) {
  const canvas = document.createElement("canvas");
  const size = outputSize(frameAspect(loaded, edit));
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context)
    return Promise.reject(
      new Error("Your browser could not prepare the logo."),
    );
  drawLogo(context, loaded.element, loaded, edit, size, accent);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Your browser could not prepare the logo.")),
      "image/png",
    ),
  );
}

export function StatusLogoEditor({
  file,
  onOpenChange,
  onSave,
  onChooseFile,
  accent,
  pageName,
}: {
  /** An object URL for the picked file or current logo, or null when closed. */
  file: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (png: Blob) => Promise<boolean>;
  onChooseFile: () => void;
  accent: string;
  pageName: string;
}) {
  const [loaded, setLoaded] = useState<{ url: string; image: Loaded } | null>(
    null,
  );
  const [loadError, setLoadError] = useState("");
  const [edit, setEdit] = useState<LogoEdit>(initialEdit);
  const [preview, setPreview] = useState("");
  const [saving, setSaving] = useState(false);
  const stage = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    id: number;
    clientX: number;
    clientY: number;
    x: number;
    y: number;
  } | null>(null);
  const [guides, setGuides] = useState<Guides>({ x: null, y: null });

  useEffect(() => {
    if (!file) return;
    let current = true;
    loadImage(file).then(
      (image) => {
        if (!current) return;
        setLoaded({ url: file, image });
        setLoadError("");
        setEdit(initialEdit);
      },
      (cause: Error) => {
        if (current) setLoadError(cause.message);
      },
    );
    return () => {
      current = false;
    };
  }, [file]);

  const image = loaded && loaded.url === file ? loaded.image : null;

  // A small render of the result for the header preview.
  useEffect(() => {
    if (!image) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        const canvas = document.createElement("canvas");
        const size = outputSize(frameAspect(image, edit), 160);
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d");
        if (!context) return;
        drawLogo(context, image.element, image, edit, size, accent);
        setPreview(canvas.toDataURL("image/png"));
      } catch {
        setPreview("");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [accent, edit, image]);

  const change = useCallback(
    (next: Partial<LogoEdit>) =>
      setEdit((current) => ({ ...current, ...next })),
    [],
  );

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const element = stage.current;
    if (!element || !image) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setEdit((current) => ({
        ...current,
        zoom: clampZoom(current.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08)),
      }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [image]);

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is a nicety; dragging still works inside the crop area.
    }
    drag.current = {
      id: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: edit.x,
      y: edit.y,
    };
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId || !image) return;
    const box = event.currentTarget.getBoundingClientRect();
    const frame = layout(frameAspect(image, edit));
    const unit = box.height * frame.height;
    if (unit <= 0) return;
    const x = start.x + (event.clientX - start.clientX) / unit;
    const y = start.y + (event.clientY - start.clientY) / unit;
    // Alt drags freely, like most design tools.
    const next = event.altKey
      ? { x, y, guides: { x: null, y: null } }
      : snap(image, edit, x, y, SNAP_PIXELS / unit);
    setGuides(next.guides);
    setEdit((current) => ({ ...current, x: next.x, y: next.y }));
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setGuides({ x: null, y: null });
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      setEdit((current) => ({
        ...current,
        x: current.x + move[0],
        y: current.y + move[1],
      }));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setEdit((current) => ({
        ...current,
        zoom: clampZoom(current.zoom + 0.1),
      }));
    } else if (event.key === "-") {
      event.preventDefault();
      setEdit((current) => ({
        ...current,
        zoom: clampZoom(current.zoom - 0.1),
      }));
    }
  }

  async function save() {
    if (!image) return;
    setSaving(true);
    try {
      const png = await exportPng(image, edit, accent);
      if (await onSave(png)) onOpenChange(false);
    } catch (cause) {
      setLoadError(
        cause instanceof Error ? cause.message : "The logo could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  const aspect = image ? frameAspect(image, edit) : 1;
  const frame = layout(aspect);
  const placed = image ? placement(image, edit, frame) : null;
  const fill =
    edit.background === "white"
      ? "#ffffff"
      : edit.background === "black"
        ? "#000000"
        : edit.background === "accent"
          ? accent
          : undefined;

  return (
    <Dialog open={file !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit logo</DialogTitle>
          <DialogDescription>
            Drag to position, scroll to zoom. Hold Alt to move without snapping.
          </DialogDescription>
        </DialogHeader>

        {/* The wrapper keeps the grid from squeezing the 16:9 stage. */}
        <div>
          <div
            ref={stage}
            role="application"
            aria-label="Logo crop area"
            aria-roledescription="Crop area. Use the arrow keys to move and plus or minus to zoom."
            tabIndex={0}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
            onKeyDown={keyDown}
            className="relative aspect-video w-full cursor-grab touch-none overflow-hidden rounded-lg border border-border bg-[conic-gradient(var(--surface-elevated)_25%,var(--background)_0_50%,var(--surface-elevated)_0_75%,var(--background)_0)] bg-[length:16px_16px] outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 active:cursor-grabbing"
          >
            {!image && !loadError && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Spinner aria-label="Loading image" />
              </div>
            )}
            {loadError && !image && (
              <p
                role="alert"
                className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-destructive"
              >
                {loadError}
              </p>
            )}
            {image && placed && (
              <>
                <div
                  aria-hidden="true"
                  className="absolute"
                  style={{ ...frame.style, background: fill }}
                />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={loaded?.url}
                  alt=""
                  draggable={false}
                  className="pointer-events-none absolute max-w-none"
                  style={placed}
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute rounded-[3px] shadow-[0_0_0_9999px_rgb(0_0_0/0.55)] ring-1 ring-white/70"
                  style={frame.style}
                >
                  <div className="absolute inset-0 bg-[linear-gradient(to_right,transparent_33.2%,rgb(255_255_255/0.18)_33.3%,rgb(255_255_255/0.18)_33.4%,transparent_33.5%,transparent_66.5%,rgb(255_255_255/0.18)_66.6%,rgb(255_255_255/0.18)_66.7%,transparent_66.8%),linear-gradient(to_bottom,transparent_33.2%,rgb(255_255_255/0.18)_33.3%,rgb(255_255_255/0.18)_33.4%,transparent_33.5%,transparent_66.5%,rgb(255_255_255/0.18)_66.6%,rgb(255_255_255/0.18)_66.7%,transparent_66.8%)]" />
                </div>
                {guides.x !== null && (
                  <div
                    aria-hidden="true"
                    data-testid="logo-guide-vertical"
                    className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-primary"
                    style={{
                      left: `${((STAGE_ASPECT / 2 + guides.x * frame.height) / STAGE_ASPECT) * 100}%`,
                    }}
                  />
                )}
                {guides.y !== null && (
                  <div
                    aria-hidden="true"
                    data-testid="logo-guide-horizontal"
                    className="pointer-events-none absolute inset-x-0 h-px -translate-y-1/2 bg-primary"
                    style={{ top: `${(0.5 + guides.y * frame.height) * 100}%` }}
                  />
                )}
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom out"
            disabled={!image || edit.zoom <= MIN_ZOOM}
            onClick={() => change({ zoom: clampZoom(edit.zoom - 0.25) })}
          >
            <ZoomOutIcon aria-hidden="true" />
          </Button>
          <Slider
            aria-label="Zoom"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={[edit.zoom]}
            disabled={!image}
            onValueChange={([zoom]) => change({ zoom: clampZoom(zoom) })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in"
            disabled={!image || edit.zoom >= MAX_ZOOM}
            onClick={() => change({ zoom: clampZoom(edit.zoom + 0.25) })}
          >
            <ZoomInIcon aria-hidden="true" />
          </Button>
          <span className="w-11 text-right text-xs text-muted-foreground tabular-nums">
            {Math.round(edit.zoom * 100)}%
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label id="logo-shape-label">Shape</Label>
            <ToggleGroup
              type="single"
              value={edit.shape}
              onValueChange={(shape) => {
                if (
                  shape === "original" ||
                  shape === "square" ||
                  shape === "wide"
                )
                  change({ shape, x: 0, y: 0 });
              }}
              aria-labelledby="logo-shape-label"
              spacing={0}
              className="w-full rounded-lg bg-surface-elevated p-1"
              disabled={!image}
            >
              {(["original", "square", "wide"] as const).map((shape) => (
                <ToggleGroupItem
                  key={shape}
                  value={shape}
                  className="h-8 flex-1 rounded-md px-2 text-xs text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground [@media(any-pointer:coarse)]:min-h-11"
                >
                  {shapeLabel[shape]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="space-y-2">
            <p className="text-sm leading-none font-medium">Orientation</p>
            <div className="flex gap-1 rounded-lg bg-surface-elevated p-1">
              <Button
                type="button"
                variant="ghost"
                className="h-8 flex-1 [@media(any-pointer:coarse)]:min-h-11"
                aria-label="Rotate left"
                disabled={!image}
                onClick={() =>
                  change({
                    rotation: ((edit.rotation + 270) %
                      360) as LogoEdit["rotation"],
                    x: 0,
                    y: 0,
                  })
                }
              >
                <RotateCcwIcon aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-8 flex-1 [@media(any-pointer:coarse)]:min-h-11"
                aria-label="Rotate right"
                disabled={!image}
                onClick={() =>
                  change({
                    rotation: ((edit.rotation + 90) %
                      360) as LogoEdit["rotation"],
                    x: 0,
                    y: 0,
                  })
                }
              >
                <RotateCwIcon aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                className={cn(
                  "h-8 flex-1 [@media(any-pointer:coarse)]:min-h-11",
                  edit.flip && "bg-background text-foreground",
                )}
                aria-label="Flip horizontally"
                aria-pressed={edit.flip}
                disabled={!image}
                onClick={() => change({ flip: !edit.flip })}
              >
                <FlipHorizontal2Icon aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label id="logo-background-label">Background</Label>
            <ToggleGroup
              type="single"
              value={edit.background}
              onValueChange={(background) => {
                if (background in backgroundLabel)
                  change({ background: background as LogoBackground });
              }}
              aria-labelledby="logo-background-label"
              spacing={0}
              className="w-full rounded-lg bg-surface-elevated p-1"
              disabled={!image}
            >
              {(["none", "white", "black", "accent"] as const).map(
                (background) => (
                  <ToggleGroupItem
                    key={background}
                    value={background}
                    className="h-8 flex-1 gap-1.5 rounded-md px-2 text-xs text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground [@media(any-pointer:coarse)]:min-h-11"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-3 shrink-0 rounded-full ring-1 ring-foreground/20",
                        background === "none" &&
                          "bg-[conic-gradient(#d4d4d8_25%,#fff_0_50%,#d4d4d8_0_75%,#fff_0)] bg-[length:6px_6px]",
                      )}
                      style={
                        background === "none"
                          ? undefined
                          : {
                              background:
                                background === "white"
                                  ? "#ffffff"
                                  : background === "black"
                                    ? "#000000"
                                    : accent,
                            }
                      }
                    />
                    {backgroundLabel[background]}
                  </ToggleGroupItem>
                ),
              )}
            </ToggleGroup>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm leading-none font-medium">On your page</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["dark", "light"] as const).map((theme) => (
              <div
                key={theme}
                data-testid={`logo-preview-${theme}`}
                className={cn(
                  "flex min-w-0 items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2.5 text-foreground",
                  theme === "light" && "theme-light",
                )}
              >
                {preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={preview}
                    alt=""
                    className="h-9 w-auto max-w-40 shrink-0 object-contain"
                  />
                ) : (
                  <span className="size-9 shrink-0 rounded-lg bg-muted" />
                )}
                <span className="truncate text-sm font-semibold">
                  {pageName || "Status"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {loadError && image && (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        )}

        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              className="h-10 px-3"
              onClick={onChooseFile}
            >
              <ImageUpIcon aria-hidden="true" />
              Choose another
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-10 px-3"
              disabled={!image}
              onClick={() => setEdit(initialEdit)}
            >
              <UndoIcon aria-hidden="true" />
              Reset
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-10 px-4"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="h-10 px-4"
              disabled={!image || saving}
              onClick={() => void save()}
            >
              {saving && <Spinner aria-hidden="true" />}
              Save logo
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The crop frame as fractions of the 16:9 stage. */
function layout(aspect: number) {
  // Work in stage heights: the stage is STAGE_ASPECT wide and 1 tall.
  const width = Math.min(0.84 * STAGE_ASPECT, 0.78 * aspect);
  const height = width / aspect;
  const style: CSSProperties = {
    left: `${((STAGE_ASPECT - width) / 2 / STAGE_ASPECT) * 100}%`,
    top: `${((1 - height) / 2) * 100}%`,
    width: `${(width / STAGE_ASPECT) * 100}%`,
    height: `${height * 100}%`,
  };
  return { width, height, style };
}

/** Positions the preview image so it matches what drawLogo exports. */
function placement(
  image: Size,
  edit: LogoEdit,
  frame: ReturnType<typeof layout>,
): CSSProperties {
  const size = turned(image, edit.rotation);
  const scale =
    Math.min(frame.width / size.width, frame.height / size.height) * edit.zoom;
  const width = image.width * scale;
  const height = image.height * scale;
  const centerX = STAGE_ASPECT / 2 + edit.x * frame.height;
  const centerY = 0.5 + edit.y * frame.height;
  return {
    left: `${((centerX - width / 2) / STAGE_ASPECT) * 100}%`,
    top: `${(centerY - height / 2) * 100}%`,
    width: `${(width / STAGE_ASPECT) * 100}%`,
    height: `${height * 100}%`,
    transform: `rotate(${edit.rotation}deg) scaleX(${edit.flip ? -1 : 1})`,
  };
}
