// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "./sonner";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

const { dismiss } = vi.hoisted(() => ({ dismiss: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { dismiss },
  Toaster: ({
    duration,
    position,
    offset,
    mobileOffset,
    closeButton,
    toastOptions,
    style,
  }: {
    duration?: number;
    position?: string;
    offset?: { top?: string; bottom?: string; left?: string };
    mobileOffset?: { bottom?: string };
    closeButton?: boolean;
    toastOptions?: { closeButtonAriaLabel?: string };
    style?: Record<string, string>;
  }) => (
    <section aria-label="Notifications alt+T">
      <div
        data-testid="toaster"
        data-duration={duration}
        data-position={position}
        data-offset-top={offset?.top}
        data-offset-bottom={offset?.bottom}
        data-offset-left={offset?.left}
        data-width={style?.["--width"]}
        data-mobile-offset-bottom={mobileOffset?.bottom}
        data-close-button={closeButton}
        data-close-label={toastOptions?.closeButtonAriaLabel}
      />
    </section>
  ),
}));

let screenAt = 1440;
const mediaListeners = new Set<() => void>();
const matches = (query: string) =>
  query === "(max-width: 639px)"
    ? screenAt < 640
    : query === "(min-width: 640px) and (max-width: 1279px)"
      ? screenAt >= 640 && screenAt < 1280
      : query === "(max-width: 767px)"
        ? screenAt < 768
        : false;
function screenWidth(width: number) {
  screenAt = width;
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return matches(query);
    },
    media: query,
    addEventListener: (_: string, change: () => void) =>
      mediaListeners.add(change),
    removeEventListener: (_: string, change: () => void) =>
      mediaListeners.delete(change),
  }));
}
/** The screen changes width: media queries tell their listeners. */
function resizeTo(width: number) {
  screenAt = width;
  vi.stubGlobal("innerWidth", width);
  for (const change of mediaListeners) change();
}

/** A toast on screen, as Sonner renders one, at a given box. */
function showToast(box: Partial<DOMRect>) {
  const element = document.createElement("li");
  element.setAttribute("data-sonner-toast", "");
  element.setAttribute("data-visible", "true");
  element.getBoundingClientRect = () => ({ ...rect(0, 0, 0, 0), ...box });
  document.body.append(element);
  return element;
}
const rect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

afterEach(() => {
  cleanup();
  mediaListeners.clear();
  vi.unstubAllGlobals();
  dismiss.mockClear();
  document.body.innerHTML = "";
});

describe("Toaster", () => {
  it("shows auto-dismissing notifications in the top right", () => {
    screenWidth(1440);
    render(<Toaster />);

    const toaster = screen.getByTestId("toaster");
    expect(toaster.getAttribute("data-position")).toBe("top-right");
    expect(toaster.getAttribute("data-duration")).toBe("4000");
  });

  it("moves to the bottom on phones, clear of the home indicator", () => {
    screenWidth(390);
    render(<Toaster />);

    const toaster = screen.getByTestId("toaster");
    // A top toast spans a phone screen over the page header's actions.
    expect(toaster.getAttribute("data-position")).toBe("bottom-center");
    for (const name of ["data-offset-bottom", "data-mobile-offset-bottom"])
      expect(toaster.getAttribute(name)).toContain(
        "env(safe-area-inset-bottom",
      );
  });

  it("keeps a place the caller chooses", () => {
    screenWidth(390);
    render(<Toaster position="top-right" />);
    expect(screen.getByTestId("toaster").getAttribute("data-position")).toBe(
      "top-right",
    );
  });

  // claude D-65, codex D-42: at 834 a top-right toast covered the breadcrumb;
  // dropped below the header it covered the title's Published pill (a11y D-78,
  // claude D-84). Tablets put toasts at the bottom right, clear of both.
  it("sits at the bottom right on tablets, clear of the page header", () => {
    for (const [width, position] of [
      [834, "bottom-right"],
      [1024, "bottom-right"],
      [1279, "bottom-right"],
      [1280, "top-right"],
      [1440, "top-right"],
    ] as const) {
      screenWidth(width);
      render(<Toaster />);
      const toaster = screen.getByTestId("toaster");
      expect(toaster.getAttribute("data-position"), String(width)).toBe(
        position,
      );
      expect(toaster.getAttribute("data-offset-top")).toBe("24px");
      expect(toaster.getAttribute("data-offset-bottom")).toContain(
        "env(safe-area-inset-bottom",
      );
      cleanup();
    }
  });

  // a11y D-73: toasts could not be dismissed.
  it("gives every toast a close button and closes them on Escape", () => {
    screenWidth(1440);
    render(<Toaster />);
    const toaster = screen.getByTestId("toaster");
    expect(toaster.getAttribute("data-close-button")).toBe("true");
    expect(toaster.getAttribute("data-close-label")).toBe(
      "Dismiss notification",
    );

    // Nothing showing: Escape is left alone.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dismiss).not.toHaveBeenCalled();

    showToast(rect(1060, 24, 356, 54));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape to an open dialog or menu", () => {
    screenWidth(1440);
    render(<Toaster />);
    showToast(rect(1060, 24, 356, 54));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dismiss).not.toHaveBeenCalled();
  });

  const position = () =>
    screen.getByTestId("toaster").getAttribute("data-position");
  /** A labeled control at a fixed box on screen. */
  function place(
    label: string,
    box: DOMRect,
    { tag = "button", parent = document.body as HTMLElement } = {},
  ) {
    const element = document.createElement(tag);
    element.dataset.label = label;
    element.getBoundingClientRect = () => box;
    parent.append(element);
    return element;
  }
  /** The px length in an offset such as `24px`, or the last one in a calc. */
  const px = (value = "") => Number(/(-?[\d.]+)px\)?$/.exec(value)?.[1] ?? NaN);
  /**
   * A toast as Sonner lays it out: its box follows the toaster's place and
   * offsets, so moving the toaster moves it.
   */
  function arriveAt(left: number, width: number, height: number) {
    const element = document.createElement("li");
    element.setAttribute("data-sonner-toast", "");
    element.setAttribute("data-visible", "true");
    element.getBoundingClientRect = () => {
      const toaster = screen.getByTestId("toaster");
      const at = toaster.getAttribute("data-position") ?? "";
      const top = at.startsWith("top")
        ? px(toaster.getAttribute("data-offset-top") ?? "")
        : window.innerHeight -
          px(toaster.getAttribute("data-offset-bottom") ?? "") -
          height;
      return rect(left, top, width, height);
    };
    screen.getByRole("region", { name: /Notifications/ }).append(element);
    return element;
  }
  const overlaps = (a: DOMRect, b: DOMRect) =>
    a.left < b.right &&
    b.left < a.right &&
    a.top < b.bottom &&
    b.top < a.bottom;
  const settle = () => act(() => new Promise((done) => setTimeout(done, 50)));
  function screenSize(width: number, height: number) {
    screenWidth(width);
    vi.stubGlobal("innerHeight", height);
    vi.stubGlobal("requestAnimationFrame", (run: () => void) => run());
  }
  /** Everything about where the toaster puts its toasts. */
  const placement = () => {
    const toaster = screen.getByTestId("toaster");
    return [
      toaster.getAttribute("data-position"),
      toaster.getAttribute("data-offset-top"),
      toaster.getAttribute("data-offset-bottom"),
      toaster.getAttribute("data-mobile-offset-bottom"),
    ];
  };

  // a11y D-R8-01, D-R8-02, claude D-95, codex D-49: toasts slid 400 to 700
  // pixels to clear controls, and across edges they were remounted and
  // announced again. A toast now has one home and never moves.
  it("decides its place once, when it appears, and never moves", async () => {
    screenSize(390, 844);
    render(<Toaster />);
    const name = place("Page name", rect(16, 400, 358, 44), { tag: "input" });
    act(() => name.focus());
    const before = placement();
    const toast = arriveAt(16, 358, 54);
    await settle();
    expect(placement()).toEqual(before);
    const where = () => {
      const { left, top } = toast.getBoundingClientRect();
      return [left, top];
    };
    const box = where();

    // Controls under it, focus moving under it, scrolling and resizing: it
    // stays put (Escape and its close button dismiss it).
    place("Save", rect(16, 790, 120, 44));
    const footer = place("Footer text", rect(16, 780, 358, 44), {
      tag: "input",
    });
    act(() => footer.focus());
    fireEvent.scroll(window);
    fireEvent(window, new Event("resize"));
    await act(() => new Promise((done) => setTimeout(done, 700)));
    expect(placement()).toEqual(before);
    expect(where()).toEqual(box);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("takes the other end of its edge when its home would hide the focused control", async () => {
    // Phones: bottom center becomes top center.
    screenSize(390, 844);
    render(<Toaster />);
    const footer = place("Footer text", rect(16, 760, 358, 44), {
      tag: "input",
    });
    act(() => footer.focus());
    const toast = arriveAt(16, 358, 54);
    await waitFor(() =>
      expect(
        overlaps(toast.getBoundingClientRect(), rect(16, 760, 358, 44)),
      ).toBe(false),
    );
    expect(toast.getBoundingClientRect().top).toBe(16);
    // The same list: Sonner's position never changes, so nothing remounts.
    expect(position()).toBe("bottom-center");
    cleanup();
    document.body.innerHTML = "";

    // Desktop: top right becomes bottom right.
    screenSize(1440, 900);
    render(<Toaster />);
    const toggle = place("Desktop preview", rect(1244, 35, 134, 32));
    act(() => toggle.focus());
    const top = arriveAt(1028, 388, 54);
    await waitFor(() => expect(top.getBoundingClientRect().top).toBe(822));
    expect(position()).toBe("top-right");
  });

  it("stays home when the other end would hide the focused control too", async () => {
    // 320x256 (400% zoom): a field as tall as the screen.
    screenSize(320, 256);
    render(<Toaster />);
    const area = place("Footer text", rect(16, 8, 288, 240), {
      tag: "textarea",
    });
    act(() => area.focus());
    const before = placement();
    arriveAt(16, 288, 54);
    await settle();
    expect(placement()).toEqual(before);
  });

  it("joins the toasts already showing and returns home once they all close", async () => {
    screenSize(390, 844);
    render(<Toaster />);
    const footer = place("Footer text", rect(16, 760, 358, 44), {
      tag: "input",
    });
    act(() => footer.focus());
    const first = arriveAt(16, 358, 54);
    await waitFor(() => expect(first.getBoundingClientRect().top).toBe(16));
    const moved = placement();

    // A second toast lands where the first is, even with focus elsewhere.
    const name = place("Page name", rect(16, 20, 358, 44), { tag: "input" });
    act(() => name.focus());
    const second = arriveAt(16, 358, 54);
    await settle();
    expect(placement()).toEqual(moved);

    // Leaving (Sonner marks it removed, then deletes it) it doesn't jump.
    first.setAttribute("data-removed", "true");
    second.setAttribute("data-removed", "true");
    await settle();
    expect(placement()).toEqual(moved);
    act(() => {
      first.remove();
      second.remove();
    });
    await waitFor(() => expect(px(placement()[2] ?? "")).toBe(16));
  });

  it("keeps its home while toasts show, even when the screen changes size", async () => {
    screenSize(390, 844);
    render(<Toaster />);
    arriveAt(16, 358, 54);
    await settle();
    expect(position()).toBe("bottom-center");
    // A phone turned to landscape: the home waits for the toasts to close,
    // because a new Sonner position remounts and re-announces them.
    act(() => resizeTo(900));
    await settle();
    expect(position()).toBe("bottom-center");
    act(() => document.querySelector("[data-sonner-toast]")?.remove());
    await waitFor(() => expect(position()).toBe("bottom-right"));
  });
});
