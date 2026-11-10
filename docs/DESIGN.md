# Cupboard UI notes

The code decides how Cupboard looks: tokens in `src/app/globals.css`, controls
in `src/components/ui`. `npm run lint` and `npm run ui:check` enforce what can
be checked (`npx eslint --fix` applies the mechanical fixes). This file holds
the values and the mistakes that keep coming back.

## Values

**Type.** Geist Sans for the interface. Geist Mono only for machine text:
endpoints, IDs, commands, console output. Page titles are `text-2xl
font-semibold tracking-tight`; section titles `text-base` or `text-lg`
semibold; body `text-sm`; help text and metadata `text-xs`; tiny tags and
badges `text-2xs`. Weights are 400,
500, and 600. Numbers in tables use `tabular-nums`.

**Color.** Semantic tokens only. Sage `primary` means action, selection, or
healthy. Amber `warning` needs attention. Red `destructive` is an error or a
destructive choice. `input` is for field edges (3:1 against every surface);
`border` is for dividers. New colors go in `globals.css`. The light palette
(`status-light`) exists only for public status pages.

**Controls.** 40 pixels by default, 32 for `size="sm"`, 28 for `size="xs"`.
Every shared control grows to 44 on touch screens by itself, so never set a
height on a Button, Input, Select, Toggle, Tabs, or InputGroup.

**Shape and spacing.** The base radius is `0.75rem`. Use `rounded-xs` through
`rounded-xl`, or `rounded-full` for pills, statuses, and tags; no arbitrary
radii. A 4-pixel spacing grid, 24 pixels of page padding (16 on phones).

## Easy to get wrong

- **Native menus.** Lint blocks `<select>`, `<datalist>`, and date or time
  inputs. Use `Select`, `Combobox`, `DatePicker`, or `TimeField`.
- **Status.** Always pair color with a shape or text.
- **Busy buttons.** Use `aria-disabled`, not `disabled`, so focus stays put.
- **Toasts.** Only for events in the background. An action's result shows
  where it happened. A dialog's error stays in the dialog, never only in a
  toast.
- **Unsaved edits.** Register them with `useUnsavedChanges` and navigate with
  `useGuardedNavigation`, never a bare `router.push`.
- **Phones.** Text inputs are 16 pixels below 768 wide so the page doesn't zoom
  on focus.
- **Popovers.** Give each one a name (`aria-label` or `aria-labelledby`).
- **Destructive menu rows.** Highlighted ones use `destructive-strong` text.
- **Image previews.** Put transparent images on `bg-image-backdrop`.
- **Scrollbars.** The workspace uses the slim token scrollbar. Public status
  pages keep the browser's scrollbar and reserve no gutter.
- **Template tells.** No all-caps labels, eyebrow labels over headings, text
  joined with " · ", arrows in button labels, or monospace as decoration.
- **Writing.** Sentence case. Name the action ("Add server", not "Submit").
  Errors say what failed and what to do. Say "Unknown" when Cupboard doesn't
  know.
- **Product pages.** No preview, sample-data, or status banners.
- **Marketing.** Don't invent customer logos, testimonials, prices, or
  statistics. Cupboard is not open source, so no GitHub or source links.
- **Brand.** The mark is `public/images/cupboard-logo.png` (source in
  `docs/brand/`). Don't invent other marks.
- **Accessibility checks.** Radix menus are modal, so axe reports
  `aria-hidden-focus` and `region` while one is open. That is expected.
- **Before calling UI done,** look at it at desktop and phone widths.
