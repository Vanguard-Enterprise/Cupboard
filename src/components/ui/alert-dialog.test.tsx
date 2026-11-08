// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";

afterEach(cleanup);

function Confirm() {
  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Weekly wipe?</AlertDialogTitle>
          <AlertDialogDescription>
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive-solid">
            Delete window
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const classes = (element: Element) => element.className.split(/\s+/);

describe("AlertDialog", () => {
  it("is a bottom sheet on phones, like the other dialogs", () => {
    render(<Confirm />);
    const dialog = screen.getByRole("alertdialog", {
      name: "Delete Weekly wipe?",
    });
    expect(classes(dialog)).toEqual(
      expect.arrayContaining([
        "max-sm:top-auto",
        "max-sm:bottom-0",
        "max-sm:translate-y-0",
        "max-sm:rounded-b-none",
        "max-sm:overflow-y-auto",
      ]),
    );
    // Full width under 640px; the card widths start at sm.
    expect(classes(dialog)).not.toContain("data-[size=default]:max-w-xs");
    expect(classes(dialog)).toContain("data-[size=default]:sm:max-w-sm");
  });

  it("keeps Cancel first and the confirming action last, side by side", () => {
    render(<Confirm />);
    const footer = document.querySelector('[data-slot="alert-dialog-footer"]')!;
    expect(
      [...footer.querySelectorAll("button")].map((b) => b.textContent),
    ).toEqual(["Cancel", "Delete window"]);
    // No reversed column: the visual order is the tab order at every width.
    expect(classes(footer)).not.toContain("flex-col-reverse");
    expect(classes(footer)).toEqual(
      expect.arrayContaining([
        "flex-wrap",
        "max-sm:*:flex-auto",
        "*:min-h-10",
        "[@media(any-pointer:coarse)]:*:min-h-11",
      ]),
    );
  });

  it("left-aligns the text like other dialogs", () => {
    render(<Confirm />);
    const header = document.querySelector('[data-slot="alert-dialog-header"]')!;
    expect(classes(header)).toEqual(
      expect.arrayContaining([
        "group-data-[size=default]/alert-dialog-content:text-left",
        "group-data-[size=default]/alert-dialog-content:place-items-start",
      ]),
    );
  });
});
