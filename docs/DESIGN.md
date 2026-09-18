# Cupboard design direction

This file records the product design decisions that should survive individual
screens and implementation changes. Read it before designing or changing any
user-facing interface.

`src/app/globals.css` is the source of truth for current token values. The
components in `src/components/ui` are the source-owned implementation base. If a
feature needs to depart from this direction, make the decision explicit and
update this file in the same change.

## Product character

Cupboard is an operator's control room for Rust servers. Rust servers can be
noisy. Cupboard should not be.

The interface is dark, steady, and precise. It should feel dependable during an
incident and comfortable during routine work. Favor clear state, compact
controls, and useful context over decoration. Give dangerous actions the weight
they deserve without making the rest of the product feel alarmist.

Use these qualities to settle design choices:

- Calm, not playful or theatrical.
- Dense enough for operators, but never cramped.
- Technical, but understandable without memorizing server jargon.
- Confident about known state and honest about unknown or stale state.
- Restrained. One strong accent is usually enough.

Avoid neon gamer styling, fake terminal chrome, glass effects, heavy gradients,
and decorative telemetry. Operational data should look like data, not scenery.

## Visual foundation

Cupboard uses a dark-only charcoal palette with a muted sage accent. Use semantic
tokens in application code. Do not copy these hex values into components.

| Role             | Token              | Current value | Use                                    |
| ---------------- | ------------------ | ------------- | -------------------------------------- |
| App background   | `background`       | `#0e0f11`     | Page canvas                            |
| Sidebar          | `sidebar`          | `#111317`     | Persistent workspace navigation        |
| Card             | `card`             | `#15171a`     | Main grouped content                   |
| Elevated surface | `surface-elevated` | `#1c1f24`     | Menus, tabs, and secondary surfaces    |
| Input surface    | `input-background` | `#121418`     | Editable fields                        |
| Primary text     | `foreground`       | `#f3f4f6`     | Headings and important values          |
| Secondary text   | `muted-foreground` | `#a3aab5`     | Labels and supporting copy             |
| Quiet text       | `text-muted`       | `#7e8693`     | Placeholders and low-priority metadata |
| Border           | `border`           | `#2a2f36`     | Default separation                     |
| Strong border    | `border-strong`    | `#3a4048`     | Hover and stronger separation          |
| Primary action   | `primary`          | `#7cb58d`     | Main action, active state, focus       |
| Warning          | `warning`          | `#c9a45d`     | Degraded or cautionary state           |
| Destructive      | `destructive`      | `#d06a6a`     | Errors and destructive actions         |

Sage means action, selection, healthy state, or progress. Do not wash large
areas in sage and do not use it as decoration. Amber means attention is needed.
Red means an error, failed state, or destructive choice. Never rely on color
alone to communicate status.

Use thin borders and small changes in surface color to establish depth. Shadows
belong on temporary layers such as dialogs, popovers, and tooltips. Routine
cards should not float.

The base radius is `0.75rem`. Controls use medium rounding and containers use
large rounding. Pills are for statuses, tags, and compact filters. Do not make
ordinary buttons or cards pill-shaped.

## Typography and iconography

Use Geist Sans for the interface. Use Geist Mono for values that benefit from
fixed-width alignment, such as IP addresses, ports, commands, identifiers, and
log output. Do not use monospaced type as a general technical motif.

Keep the hierarchy compact:

- Page titles use `text-2xl`, semibold, with tight tracking.
- Section titles use `text-base` or `text-lg`, semibold.
- Most controls and body copy use `text-sm`.
- Help text and compact metadata use `text-xs` with a comfortable line height.

Use sentence case for headings, navigation, buttons, tabs, and table columns.
Prefer short, descriptive headings. Weight and spacing should carry the
hierarchy, so avoid frequent all-caps labels or oversized type.

Use Lucide icons with the library's default stroke style. A typical control icon
is 16 pixels. Icons should clarify a label or make a familiar compact action easy
to scan. Give unfamiliar actions a visible text label. Do not use emoji as
interface icons.

## Layout and spacing

The workspace shell uses a persistent collapsible sidebar, a slim header with
breadcrumbs, and one main scroll area. Keep organization navigation stable
between pages. A user should not have to relearn the shell for each feature.

Use the Tailwind spacing scale and a 4-pixel rhythm. Existing settings pages use
these useful defaults:

- 24 pixels of page padding on medium screens and 16 pixels on small screens.
- 24 to 28 pixels of card padding.
- 16 pixels between related fields and 24 pixels between form rows.
- 32 to 40 pixels between page-level sections.
- 40-pixel field and standard button heights on desktop.

Settings and focused tasks should use a readable centered column. The current
settings maximum is 848 pixels. Tables, logs, and dashboards may use the full
content area when the extra width improves scanning.

Group related information once. Avoid cards inside cards unless the inner card
has its own interaction or state. Prefer a divider, section heading, or spacing
when structure is all that is needed.

On narrow screens, collapse the sidebar, stack form columns, and keep the main
action easy to reach. No core task may require horizontal page scrolling.
Touch targets should be at least 44 pixels where the interface is likely to be
used on a phone or tablet.

## Components and controls

Start with the source-owned shadcn components in `src/components/ui`. Adapt them
with semantic tokens and variants before creating a parallel control. New
patterns should earn their place through a real feature, not a hypothetical
future use.

### Never use native menus

No product menu may use browser-native rendering. This rule covers selects,
listboxes, comboboxes, dropdown menus, context menus, command menus, and action
menus.

- Never ship a native `<select>` or `<datalist>`.
- Use the matching source-owned `Select`, `Combobox`, `DropdownMenu`,
  `ContextMenu`, `Command`, or `Popover` component from `src/components/ui`.
- If the needed menu component does not exist, add it to the shared UI layer
  before using it in a feature. Do not build a one-off menu inside a page.
- Existing native menus are design debt, not precedent. Replace one when working
  on the screen that contains it.
- Menu rows must show a visible pointer hover and keyboard highlight. Searchable
  menus must support Arrow key navigation and Enter selection.
- Search should recognize common abbreviations when the domain has them. Country
  search, for example, accepts ISO codes and familiar forms such as USA and UK.

Keep native HTML semantics beneath our components where they provide keyboard,
form, or accessibility behavior. The visible menu and every interactive state
must use our component styling and behavior.

Buttons follow a clear order:

- Use one primary button for the main action in a region.
- Use outline or secondary buttons for valid alternatives.
- Use ghost buttons for low-priority toolbar and navigation actions.
- Use the destructive treatment only for actions with destructive effects.
- Label actions with specific verbs such as "Save changes", "Add server", or
  "Test connection". Avoid vague labels such as "Submit", "Continue", or "OK"
  when a specific result is known.

Forms place labels above controls. Keep related short fields in a two-column
grid when space allows. Give addresses, descriptions, secrets, and other long
values the full width. Show field errors beside the field and move focus to the
first invalid input after submission. Keep unsaved edits until the user cancels
or saves them.

Use tabs for a few peer sections that share one task and URL. Use navigation when
sections need separate URLs, permissions, or history. Keep the active state
obvious without adding a second accent color.

Tables should optimize comparison. Align like values, keep headers visible when
the table is long, and put row actions at the end. Use badges for short states,
not ordinary values. A dashboard should answer a real operational question;
empty metric cards are worse than a clear empty state.

## State, feedback, and trust

Every data view must account for loading, empty, stale, partial, error, and
success states. Preserve the last useful data when a refresh fails, then mark it
as stale and show when it was last updated.

Feedback belongs near the action that caused it. Use inline status for saved
forms, persistent failures, and conflicts. Use a toast for brief confirmation
that does not need to remain on screen. Skeletons should resemble the content
that will replace them. Use a spinner only when there is no useful shape to show.

Do not label pages with preview, prototype, sample-data, or implementation-status
banners, badges, tags, or notices. Record development status in project
documentation. If a limitation changes the result of an action, explain it in
that action's dialog or supporting copy instead of adding page-level chrome.

Disable an action while the same request is running and keep its label specific,
such as "Testing connection...". Do not claim success until the server has
verified the result. If the outcome is uncertain, say so and provide the next
check.

Sensitive actions follow a visible sequence:

1. State the proposed action and its target.
2. Explain material effects or risk.
3. Ask for approval when the action changes access, data, billing, or a live
   server.
4. Run the action once.
5. Report the verified result.

The conversational interface follows the same rules as the dashboard. A
proposal must never look like a completed action.

Confirm destructive actions when they cannot be quickly undone. Name the object
in the confirmation and describe what will be lost. Prefer a recoverable archive
or disable action when the product supports one.

## Motion

Motion should explain a state change. Keep ordinary transitions between 150 and
200 milliseconds. Use simple fades, color changes, and short position changes
for menus, disclosure, and sidebar transitions. Avoid bouncing, long staged
entrances, and looping animation. Continuous motion is reserved for work that is
actually in progress.

Honor `prefers-reduced-motion`. The interface must remain understandable when
all optional motion is removed.

## Accessibility

Meet WCAG AA contrast for text and interactive states. Preserve visible keyboard
focus with the sage ring token. All work must be possible with a keyboard, and
focus should move predictably when dialogs open, errors appear, or content is
removed.

Use semantic HTML before ARIA. Inputs need visible labels. Icon-only controls
need accessible names and tooltips when their meaning is not universal. Status
needs text or an icon in addition to color. Charts need a text summary or an
accessible data view.

Write tests for keyboard interaction and state changes that carry operational
risk. Check new pages at desktop and mobile widths before calling the UI done.

## Product writing

Write for an operator who wants the state and the next action. Use plain,
specific language. Put the important noun and status early.

- Say "Connection failed" and explain which connection failed.
- Say "No servers yet" before explaining how to add one.
- Say "Restart server" instead of "Initiate restart operation".
- Use "you" for the operator and the server's name for its effects.
- Keep help text useful. Do not restate the field label.

Avoid jokes during failures, marketing copy inside the application, and vague
reassurance. When the product does not know, use "Unknown" and explain how to
refresh or verify it.

## Imagery and brand

Operational screens should rely on the interface and the operator's data. Do not
add generic game art, stock photography, or decorative server illustrations.
Authentication and onboarding may use one subdued image or texture under a dark
overlay. It must not compete with the task.

Until a dedicated mark exists, use the simple Cupboard wordmark and the current
letter tile. Do not invent a new logo inside a feature change.

## Review checklist

Before finishing a user-facing change, check that:

- The screen helps complete a real task in the current product scope.
- It uses semantic tokens and existing controls.
- Every menu uses a source-owned component. No native menu remains.
- The primary action and current state are obvious.
- Loading, empty, error, stale, success, and destructive states are covered when
  they apply.
- Copy names the object and result precisely.
- Keyboard, focus, contrast, and reduced motion behavior work.
- Desktop and mobile layouts have been inspected.
- Tests cover the main interaction and risky state transitions.
- Any intentional change to the product's design direction is recorded here.
