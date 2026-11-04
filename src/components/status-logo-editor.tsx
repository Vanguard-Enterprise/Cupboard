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
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

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
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId || !image) return;
    const box = event.currentTarget.getBoundingClientRect();
    const frame = layout(frameAspect(image, edit));
    const unit = box.height * frame.height;
    if (unit <= 0) return;
    const dx = (event.clientX - start.x) / unit;
    const dy = (event.clientY - start.y) / unit;
    drag.current = { ...start, x: event.clientX, y: event.clientY };
    setEdit((current) => ({
      ...current,
      x: current.x + dx,
      y: current.y + dy,
    }));
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id === event.pointerId) drag.current = null;
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
            Drag to position it, scroll or use the slider to zoom.
          </DialogDescription>
        </DialogHeader>

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
            </>
          )}
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
