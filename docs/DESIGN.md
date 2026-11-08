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
| Field border     | `input`            | `#616a77`     | Field, checkbox, and slider boundaries |
| Primary action   | `primary`          | `#7cb58d`     | Main action, active state, focus       |
| Warning          | `warning`          | `#c9a45d`     | Degraded or cautionary state           |
| Destructive      | `destructive`      | `#d06a6a`     | Errors and destructive actions         |

Sage means action, selection, healthy state, or progress. Do not wash large
areas in sage and do not use it as decoration. Amber means attention is needed.
Red means an error, failed state, or destructive choice. Never rely on color
alone to communicate status.

Fields, checkboxes, radios, and slider tracks use the `input` border, which
holds 3:1 against card, input, and popover surfaces (WCAG 1.4.11). Card
dividers and outline buttons stay on `border`. Use thin borders and small
changes in surface color to establish depth. Shadows
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
- Never ship a native date or time picker (`type="date"`, `time`, or
  `datetime-local`). Use the shared `DatePicker` and the typed `TimeField`.
  The DatePicker opens Cupboard's calendar in a popover on screens 1024 pixels
  and wider and in a sheet titled with the field's label below that and in
  windows under 480 pixels tall (a bottom sheet on phones, a centered layer
  on tablets; after [Bevel](https://mobbin.com/screens/2c827446-4405-44c8-b393-6c6d54da0103)
  and [Lightyear](https://mobbin.com/screens/35287218-c4f4-4799-ac17-c6a0e6298d3a)),
  so it never covers a form's other fields or actions or loses its month
  header off screen. Weeks start on the visitor's locale's first day (Sunday
  in en-US, Monday in most of Europe). It opens with focus on the chosen day
  (else today), cannot page to months before its minimum, and its accessible
  name carries the date ("Start date, Thursday, November 5, 2026"). The TimeField writes the visitor's clock ("7:00 PM" in
  en-US, "19:00" in 24-hour locales, like [Klaviyo](https://mobbin.com/screens/ff8cfdca-d571-42ac-a227-cc873b9fd8b6)),
  reads either, checks the text on Tab, Enter, or leaving the field (never
  while typing), and given the day, rejects a time daylight saving skips. For
  a time that happens twice (clocks going back) it says so and offers both
  readings as a segmented choice ("1:30 AM EDT", "1:30 AM EST") placed right
  after the field, so Tab or Enter from the field lands on it (Enter never
  submits the form at a reading the operator hasn't seen); the note is one
  line ("1:30 AM happens twice on Sun, Nov 7 as clocks go back.") because the
  choice under it says the rest. When Tab or Shift+Tab leaves text the field
  has not checked yet, the field moves focus itself once the check has
  rendered, because the check can remove that choice or a message while a
  browser's own Tab is between the field and the next control, and a dialog
  then takes focus back to itself. The chosen reading travels in the
  field text as a zone label, which operators can also type, and `timeOn` and
  `timeTextAt` turn that text into an instant and back, so the form's summary
  names the zone it uses. Invalid means no value: `timeOn` gives no instant
  for any text the field marks as an error (unreadable, skipped, or a zone
  label the time can't have that day, such as "7:00 PM EST" in June), so a
  form can never submit a nearby instant instead. Because focus has usually
  moved on when that check runs, the field also says its message once in a
  polite live region. A field box that holds a bare input beside an icon,
  prefix, or swatch (the TimeField, the public address, the accent color) is
  the shared `InputFrame` with `InputFrameControl`, whose input covers the
  frame's edge so the input itself is 44 pixels on touch. Every text input,
  framed or not, and the Ctrl+K search are 16 pixels below 768 pixels wide so
  phones don't zoom in on focus.
- Use the matching source-owned `Select`, `Combobox`, `DropdownMenu`,
  `ContextMenu`, `Command`, or `Popover` component from `src/components/ui`.
- A `Popover` is a dialog, so it always has a name: pass `aria-label` or
  `aria-labelledby`, or it takes its trigger's (the trigger's `aria-label`
  or text). It keeps 16 pixels from the screen edges, so on a phone it never
  sits flush with one.
- If the needed menu component does not exist, add it to the shared UI layer
  before using it in a feature. Do not build a one-off menu inside a page.
- Existing native menus are design debt, not precedent. Replace one when working
  on the screen that contains it.
- Menu rows must show a visible pointer hover and keyboard highlight. Searchable
  menus must support Arrow key navigation and Enter selection. A highlighted
  destructive row uses `destructive-strong` text on its red tint (5.0:1), never
  the resting `destructive` red (3.6:1 there).
- Search should recognize common abbreviations when the domain has them. Country
  search, for example, accepts ISO codes and familiar forms such as USA and UK.

Keep native HTML semantics beneath our components where they provide keyboard,
form, or accessibility behavior. The visible menu and every interactive state
must use our component styling and behavior.

Buttons follow a clear order:

- Use one primary button for the main action in a region.
- Use outline or secondary buttons for valid alternatives.
- Use ghost buttons for low-priority toolbar and navigation actions.
- Use the destructive treatment only for actions with destructive effects. The
  confirming button in a destructive confirmation uses the solid
  `destructive-solid` variant so it never reads as disabled; the tinted
  `destructive` variant stays for inline actions.
- Label actions with specific verbs such as "Save changes", "Add server", or
  "Test connection". Avoid vague labels such as "Submit", "Continue", or "OK"
  when a specific result is known.

Forms place labels above controls. Keep related short fields in a two-column
grid when space allows. Give addresses, descriptions, secrets, and other long
values the full width. Show field errors beside the field and move focus to the
first invalid input after submission. Keep unsaved edits until the user cancels
or saves them. A page with unsaved edits registers them with the shared
guard (`useUnsavedChanges` in `src/components/ui/unsaved-changes.tsx`), and
every way out asks first with one "Leave without saving?" prompt naming the
pending changes: workspace links, the Ctrl+K command menu, switching
organization, signing out, the browser's Back, reload, and closing the tab.
Keep editing returns focus to where the operator was. Programmatic
navigation goes through `useGuardedNavigation`, never a bare `router.push`.
While that prompt, another confirmation, or any other dialog is open, Ctrl+K
does nothing: the open layer keeps focus until it is answered.

Login and signup password-length failures use a top-right toast that dismisses
after four seconds, as requested for authentication, on phones too, where a
bottom toast would sit behind the keyboard. Keep focus on Password. Elsewhere
toasts are for events the operator didn't just trigger in view: a background
refresh failing, a session expiring, a long task finishing. The result of an
action the operator just took (Save, Publish, a dialog that closes) shows
where it happened instead (see "State, feedback, and trust"). Each width has
one home: top right from 1280 pixels, bottom right from 640 to 1279 (where the
top-right corner holds the breadcrumb and a page title's pills), and bottom
center on phones, where a top toast would span the page header's actions. A
page with a bar pinned to the bottom (fixed on phones, sticky above)
publishes its height as `--cupboard-bottom-bar` and bottom toasts rise above
it. **The place is decided once, when a toast appears**: if its home would
hide the control in focus and the other end of the same edge would not, it
uses that end (bottom center to top center, bottom right to top right, top
right to bottom right, above a pinned bar); toasts that arrive while others
show join them, and once every toast has gone the next starts from home.
After that **a toast never moves**: not for focus, scrolling, resizing, or a
control under it, and a toast is never remounted, so screen readers say it
once. The Toaster keeps Sonner's `position` fixed while toasts show (a new
position remounts every toast) and reaches the other end with an offset.
There is no avoidance logic beyond that one check; a toast can rest over an
unfocused control for its few seconds. Every toast has a close button inside
its right edge ("Dismiss notification", 32 pixels, 44 on touch), and Escape
closes toasts unless a dialog, menu, or popover is open. The page never
scrolls for a toast. A toast never carries the only
copy of an error the operator has to act on: a failed confirmation shows its
error inside the dialog, above its actions, and the dialog stays open. A
button that is busy is `aria-disabled`, never `disabled`, so focus stays on
it while its request runs and after it fails.
Missing fields, invalid email, and password confirmation mismatches use inline
field errors.

A segmented control (`ToggleGroup variant="segmented"`) picks one of a few
short options inside a bordered track. The chosen cell is filled, bold, and
edged in `input-hover`, which holds 3:1 against the track, so the choice never
rests on a faint fill alone. In forced colors (Windows contrast themes), which
drop fills and inset edges, a chosen toggle or segmented cell, a checked radio's
dot, and a switch's thumb are drawn in the system Highlight color. A partly selected checkbox (a group with some
children chosen) draws a dash, never a check.

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
forms, persistent failures, and conflicts. A form with a save bar confirms a
Save in that bar, never in a toast: its buttons give way to a check and
"Saved" in a `role="status"` region that is part of the bar from the start
(so it is said once, by every screen reader), focus goes back to the field
the operator last used before the buttons go (so it never rests on the page
in between), and the bar stays six seconds, or until the next edit, then
fades away (at once with reduced motion). A resting pointer doesn't hold it:
it has nothing to act on. Nothing on the page moves at any point: a bar in
the page's flow keeps its height, a bar fixed to a phone's edge shrinks to
one line from its top while the page keeps the space it reserved, and when
the bar leaves, that space stays, empty, until releasing it moves nothing
(another tab, the bar coming back, or the space scrolled out of view). So the
browser never clamps the scroll at the page end and the field in focus never
jumps. It sits where the operator's
eyes and thumb already are, at every width and at 400% zoom, after
[Klaviyo](https://mobbin.com/screens/e06a4b15-a937-4f72-8096-9d4261b31972)
and [Clerk](https://mobbin.com/screens/0dcb1707-a8ae-4218-a23a-4976adb5b4d2).
An action whose result appears on the page (a Published pill, a new row)
lets that change confirm it and says it in a polite live region. Use a toast
only for events in the background (see "Components and controls"). Skeletons should resemble the content
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
all optional motion is removed. `globals.css` cuts animation and transition
time to near zero under that preference; spinners keep turning because they
mark work in progress.

## Accessibility

Meet WCAG AA contrast for text and interactive states. Preserve visible keyboard
focus with the sage ring token: one solid 2-pixel ring (`ring-2 ring-ring`) on
every control, with a 2-pixel offset on buttons, switches, checkboxes, radios,
and tab panels, never the faint 50% ring. Tab triggers and breadcrumb links use
the same ring (line tabs without the offset), and the base outline fallback is
the full-strength ring color. Field edges use `input` at rest and the stronger
`input-hover` on hover, so hover never weakens a field's 3:1 boundary. The
workspace shell starts with a Skip to main content link (a 40-pixel sage pill
at the top left when focused), and the sidebar content is a "Workspace"
navigation landmark. On touch screens (`any-pointer: coarse`) inputs, sidebar
rows, the sidebar toggle, breadcrumb links, slider thumbs, and dialog close
buttons reach 44 pixels. Toasts mount only where something toasts (the
workspace shell and the sign-in and sign-up layout), so public pages carry no
empty Notifications region. Keyboard-only edits that change something visual
say what changed: the logo crop area describes the logo's position, the edges
it lines up with, and whether the frame cuts it off, and announces it once the
arrow or zoom keys rest; arrow keys in a TimeField announce the new time. Radix
menus open modally, so axe reports `aria-hidden-focus`, `region`, and
`page-has-heading-one` while one is open; focus is trapped in the menu and
nothing behind it is reachable, so these are accepted. All work must be possible with a keyboard, and
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

The login and signup pages share `src/components/auth-layout.tsx` and follow the
Ferndesk reference's composition: a compact form and wordmark grouped in the left
column, with full-height artwork on the right.
Cupboard keeps its charcoal form and sage action color. The artwork depicts a
coastal Rust base with a tool cupboard and server operator station in pixel art.
It is decorative, has a light dark overlay, and is hidden below the desktop
breakpoint so the form remains the focus on smaller screens.

The selected Cupboard mark is the sage C-shaped cabinet with two server shelves
from logo concept v3. The authentication wordmark and favicon use this mark, with
transparent negative space and no enclosing tile. The source concept lives in
`output/imagegen/cupboard-logo-v3.png`; the authentication asset is
`public/images/cupboard-logo.png`. Existing letter tiles elsewhere can migrate
to this mark when their interface is updated. Do not invent competing marks.

## Machines

Use [Twingate's inventory](https://mobbin.com/screens/5385e167-f213-4cd4-a354-14b01d30c2b9)
for the compact machine table, search and filters, and restrained row actions.
Agent enrollment follows its
[guided setup](https://mobbin.com/screens/0764a44a-ad61-44a1-b75a-08b220f75d26):
prepare, install, then verify a report from the newly enrolled agent.

Machine details follow
[Neon's monitoring layout](https://mobbin.com/screens/a140f8f1-d12e-407f-81c8-e06186ce5350)
with grouped resource panels and a Machine details dialog for configuration.
Show actual memory and root-disk capacity, CPU load, uptime, and report time.
Machine details use [StackAI's compact value-and-chart cards](https://mobbin.com/screens/03fb91f0-89d0-45e6-ada1-34d533a3febf)
for CPU and network receive/send, with circular memory and storage meters and
uptime beside the machine name. Charts cover
the last hour, use actual report timestamps, and leave gaps after missed reports.
Detailed history values belong in chart tooltips; capacity meters expose used and
available bytes alongside the percentage. Keep configuration and agent actions
in the Machine details dialog.
Keep Cupboard's charcoal, sage, and shared components.

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

Machine rows combine status with the public-IP country flag: a focusable flag tile
uses a gently pulsing colored border. Align the tile and machine name at the top
on every screen size; the full identity block opens monitoring.
Use green for connected, red for stale reports, yellow for awaiting a report,
and gray for unenrolled machines. Enrolled states pulse gently with reduced
motion respected. Tooltips provide text, report time, and an explanation.
Resource columns use usage bars with accessible values and text details; missing
readings remain empty. Unreachable machines replace every graph with a skeleton
and show relative Last seen time and its timestamp in the stats area; never present stale utilization as current.
Provider belongs beside the host name. Location appears only in machine details,
derived from the public-IP country used by the flag. Do not offer a manual
location field. A combined
in/out network sparkline occupies the final metric column. Mobile rows hide resource stats and the network chart below the medium breakpoint.
Keep identity, status, last-seen information, and actions visible; tapping the
machine opens its full monitoring view.

Machine refresh failures use a brief top-right toast once per outage; automatic
retries continue without a persistent banner or retry button.

Adding a machine opens a dedicated Machine setup page: Details, Install agent,
Verify connection. Keep progress visible and resumable; preserve non-secret drafts
and use server state for enrollment and verification. Show the country flag beside
the derived location in the details dialog. Before the first report, every metric
column uses skeleton placeholders, including network labels.

Unenrolled machines use one enrollment invitation across the resource columns.
Place decorative skeletons behind the enrollment action. Offline
flags stay small and faded behind a disconnected-cable icon on a blurred translucent backdrop.
Machine address forms accept IPv4 and IPv6 literals and label the requirement.

Keep the enrollment invitation borderless; omit duplicate Continue setup/Enroll
menu entries. Unenrolled machine menus offer Remove with confirmation. Offline
flag content stays static and faded beneath the cable overlay; only its red
border pulses, respecting reduced-motion preferences.

Center the Enroll machine button by itself across the resource columns. Offline
rows overlay relative Last seen time with an absolute timestamp on their skeletons;
on mobile, keep this time below the identity because metric columns are hidden.

Enrollment and offline Last seen overlays use a translucent blurred backdrop,
centered over the skeleton metrics without adding row height for a separate label.

## File library

The file library follows Google Drive's compact list/grid switching and selected
file toolbar, adapted to Cupboard's charcoal and sage tokens. Search and filtering
sit above the content, with file type and sort options in one menu beside search.
Order the toolbar as Search, flexible space, Filters, list/grid view, New folder,
and Upload file. Use icon-only action buttons with accessible names and tooltips.
The file library breadcrumbs are Dashboard > Files. Below the medium breakpoint, hide
the root Files heading visually and put search in a labeled popover opened by a
44-pixel search button. Put all six mobile toolbar controls in one row with matching
44-pixel targets. Keep folder navigation available. The folder dialog accepts
slash-separated paths to create subdirectories in one action.
The browser remembers the view per account and organization. List view aligns
filenames, upload dates, and sizes, with compact image thumbnails beside filenames.
List and grid views lazily load authenticated PNG, JPEG,
GIF, and WebP previews after checking their byte signatures. Images use a white
backdrop so transparent dark artwork remains legible. Other files and failed
previews use extension-based icons. File and folder context menus match the overflow menus, including copy, cut,
rename, share, details, and confirmed deletion. Empty-space menus offer new folder,
upload, and paste. Show folder navigation in the page heading only inside a folder.
Omit the item count and show the selection toolbar only when an item is selected. Update after mutations and check for changes while the
page is visible, without a manual Refresh button. Distinguish
cut entries with reduced opacity until pasted or canceled. Public link creation
explains who can download, the expiry, and how to revoke access; folder sharing
uses organization links. Upload uses a dialog with browsing and drag/drop. Keep mobile actions at
least 44 pixels and allow filenames to be read in the details dialog.

Reference: [Google Drive file list on Mobbin](https://mobbin.com/screens/4e58234e-a5d7-4119-8ab6-f4d7dbc4f20d).

## Connections

Use [Apollo's compact integrations list](https://mobbin.com/screens/4d8f6c81-5562-4a49-ae10-49f830806ee7)
for connected services above available services, divided rows, and right-aligned
actions. Keep the page heading free of a generic subtitle. Put connection status
beside the service name, following [Vanta's integrations](https://mobbin.com/screens/0bfbcb9b-e013-4fc0-b8f1-ec17b1f70996).
Use short Refresh, Edit, and Disconnect labels with action icons in the shared
overflow menu. Browse connections opens the catalog in a searchable dialog, keeping the search
field above a scrolling list. Use locally served provider logos for connected
services and catalog entries. Catalog rows use logo/name/description, with actions
below the text on narrow screens. Server inventory shows names, nodes, and panel
states; omit provider identifiers from the visible rows.

Pelican imports use a searchable Rust-only picker from the Servers header. The server inventory follows the Machines page layout, with search, status and
provider filters, compact resource columns, and a three-dot action menu. Clicking
a server opens its monitoring view with a Back to servers action. Imported
servers have Resources and Console tabs. Keep power controls in monitoring, require confirmation for stop and restart, and hide
mutating controls from viewers. Resource observations show their update time;
console refreshes only while visible. Connection failures stay inside the affected
view with a useful recovery action.

Machine network sparklines fit recent samples within a one-to-five-minute window.
Ignore older points when scaling, and preserve gaps longer than 90 seconds.
Place the provider before the IP on the identity's second line. Show compact
rounded role tags beside the name. Tags describe an operator-assigned role, not
confirmed running software. The row's Tags action assigns tags and opens
organization-wide create, rename, and confirmed deletion controls. Provide Wings,
Game server, Database, Backups, and Bot server as editable recommended defaults.

## Alerts and data

The organization's Alerts & data page follows
[fal's notification settings](https://mobbin.com/screens/8248454f-ffe1-43ab-bec4-d83afdb5d6cc):
delivery channels above an alert-by-channel routing table, with critical and
warning tags beside the alert name. Channel rows use
[Laravel Cloud's](https://mobbin.com/screens/c2d83187-249e-4c50-bab3-057a926391a1)
contained card rows with a masked destination, the last delivery result, and a
visible Send test action. Routing rows explain the trigger in a full sentence;
do not restate the alert name. On narrow screens the routing table scrolls
inside its card with the alert column pinned. Recent alerts show each channel's
delivery result, with retry errors in a tooltip. The data section follows
[Mixpanel's data and privacy rows](https://mobbin.com/screens/a9cbba75-40fe-499e-a368-705d02b913ec):
a retention select and a labeled export action that names what is excluded.
Routing and retention share one sticky save bar that appears only with unsaved
changes. Webhook signing secrets appear once in a dialog with a copy action.

## Marketing navigation

Marketing pages share a dark-only header. Sign-in, signup, invitation acceptance,
dashboard, and public status pages retain their existing layouts without this header. Follow the linked Giga capture's
single integrated navigation row, with the logo alone at the left, Product, Docs,
and Resources centered, and Pricing, Sign in, and a pale pill Get started action
at the right. Put a slim dismissible announcement above the row. The user requested
a fictional Cupboard 5 announcement as a design reference; replace that copy before
publishing a real release. Keep charcoal surfaces and Cupboard's sage cabinet mark.
Docs groups getting started, integrations, user management, identity providers,
and servers and machines. Resources groups Guides, Changelog, and Support with
short descriptions. These links reserve future content destinations; do not add
GitHub or source-code links to marketing navigation. Cupboard is not open source.
On mobile, keep the logo and a Menu control. Use the shared
Sheet with labeled Menu and Close controls, 44-pixel links, keyboard focus
containment, and Escape dismissal.

Reference: the Giga capture linked below.

## Marketing landing page

CUP-51 expands the marketing work to a full homepage, based on the linked
[Giga landing-page capture](https://mobbin.com/sites/giga-e8026bbd-682d-4bab-820c-eddb76d71bff/77a9cacb-2791-4f1d-8111-39cbe7b4ec13/sections).
Use its dark grid, dotted type, line reveal, section sequence, setup walkthrough,
map, framed product illustrations, capability panels, story composition, FAQ,
closing action, and footer. Keep Cupboard's cabinet mark, charcoal and sage tokens,
logo-only integrated navigation, and authentication/dashboard header exclusions.

Marketing has a scoped exception to the workspace's compact typography and
restrained imagery rules: large dot-pattern headings, subtle atmospheric color,
and the existing coastal Rust artwork may establish the page composition.
These styles live in the landing component's CSS module and do not alter the
workspace or authentication design. The headline resolves scrambled glyphs once; light columns, the logo marquee, rotating subheadline, and map move continuously following the
reference recording. The hero omits the explore card, graph caption, and visible
motion control at the user's request. The overview uses a regular sans-serif
heading, no eyebrow or supporting paragraph, and a wide product view without
a separate outer frame.
The overview showcase follows the [Giga Showcase capture](https://mobbin.com/sites/sections/b0f8fb5b-aa00-4aec-8213-2418d9a7a275):
a single-line heading above a full-width dark operations window, a slim workspace
bar, narrow navigation, paired performance metrics, and a wide chart. A progressive
lower gradient and masked backdrop blur blend the dashboard into the page.
Its entrance resolves blur, opacity, and vertical offset once; the chart draws in
2.6 seconds. Time-range controls update the illustrated readings, and pointer or
keyboard inspection exposes individual values. Mobile retains the chart and
summary while removing the decorative sidebar. Reduced motion shows the finished
chart immediately. These interactions use local presentation data, not live telemetry.
The chart's hover marker follows the SVG curve continuously rather than snapping
between readings. The tooltip and crosshair ease between positions. Controls and
metric cards respond to hover and keyboard focus; the decorative Console/Overview
segments respond to hover without changing the dashboard. Monitoring can be toggled
within the illustration. The showcase remains one view.
All additional transitions respect reduced motion.
Sections reveal once as they enter view. All content stays visible without JavaScript,
and reduced-motion preference removes optional animation and hidden reveal states.

Use real Cupboard capabilities in copy. Product illustrations are decorative,
not connected telemetry. Do not invent customer logos, testimonials, certification
badges, subscription prices, or performance statistics to fill reference sections.
Setup steps, product tabs, and FAQ disclosures use source-owned components and
support keyboard input. Signup actions lead to the existing account flow. Docs
and resource links retain the requested placeholder destinations until that work
is separately authorized.

The hero graph draws once from left to right in six seconds on desktop and 2.8
seconds on mobile. One reveal includes the line, upper gradient, and four labeled
checkpoints, with no additional moving dot. Wide screens extend the line on either
side while keeping checkpoint positions and proportions fixed. Mobile gives the
curve more vertical room and uses readable labels below the markers. It does not
scroll or repeat. The user-selected Vital, Wicked, Vitality, Atlas, Physgun, and
GameServerKings logos replace the feature strip. Use their actual locally stored
marks in white/grayscale without customer or endorsement claims. Sources are
recorded beside the assets. Logo links and their focus targets remain accessible;
the duplicate marquee group is hidden from assistive technology and keyboard focus.

## Maintenance and status page

The admin page follows [incident.io's status page overview](https://mobbin.com/screens/1c0dbbc8-df9c-408c-9d03-b2ae7be690d0)
and [components settings](https://mobbin.com/screens/2f54654e-82b2-4664-b483-65fa66ebf0ef).
Operators asked for the word "targets" in place of "components", for the
sidebar entry to read "Status page", and for the overview and settings
sections, the address field, and the accent field to carry no descriptions.
Round 6 cut the rest of the admin's copy to what an operator needs to act:
no helper line repeats what a control, a count, or a button label already
says; detail that only matters to a screen reader stays in `sr-only` text or
`aria-describedby`; confirmations name the effect in one sentence. Helper,
hint, and error lines are 13 pixels (`text-[13px] leading-5`), and so are
the page's badges and pills (In progress, Hidden, Maintenance, New logo), 22
pixels tall, and the 24-pixel Public pill; 12 pixels is left to short labels such as "Start date".
Status colors use the existing tokens: sage operational, amber degraded, red
unavailable, neutral for maintenance and unknown, always with a shape glyph and
a text label. The public page (and so the settings preview) is described under
"Public status page" below.

**Header.** One line: the title "Status page" and a Public or Private pill.
No address line, Visit button, page actions menu, Preview, or Schedule
maintenance: the operator found them redundant, and each has one home
elsewhere. While the page is Public the title is the visit: a link inside
the `h1` to the saved public address (never an unsaved slug), opening a new
tab, with a small up-right arrow that shows without hover and an underline on
hover. Its accessible name is "Status page, public page, opens in a new tab",
so it never shares a name with the sidebar's Status page. A Private page has
nothing to visit, so its title is plain text.

The pill is a button that opens the page's publishing popover, after
[Plane's publish popover](https://mobbin.com/screens/f6e00ee6-635c-41d4-b762-1876fc7ec11f).
The popover is named "Public page" or "Private page" and has no visible title:
the pill right above it already says the word. In both states it opens on the
full saved address, broken only after a slash, with Copy, for managers and
viewers alike: a private address is still the one to share once it goes live.
Public then has a quiet destructive Unpublish page that confirms first and
names the effect ("Players at /status/... see a not-found page"). Private
(neutral, lock) says "Players see a not-found page at this address." and
offers Publish page, the page's only publish control and the popover's one
filled button. Viewers get the address and Copy only. Public always sits on
the sage tint. Where a fine pointer can hover it folds to a 26 by 24 pixel
tinted badge holding only the globe, with no chevron, so at rest it reads as
a state and never as a language or region picker. It opens to the word and
the chevron on hover, on keyboard focus, and while its popover is open; touch
screens always show both. The word stays in the DOM and the accessible name
("Public, address and publishing"), and an invisible expanded copy in the
same grid cell keeps its width, so opening it moves nothing. Private never
folds: an abnormal state stays spelled out, word and chevron. With reduced
motion the word appears without sliding. On touch the pill's hit area is 44
pixels tall.

Publishing and unpublishing commit only the published flag (revision-checked,
management only) and never save drafted edits. Publish closes the popover and
focus lands on the new title link; Unpublish's confirmation returns focus to
the pill, which then says Private. A failed Publish shows in the popover under
its button. A failed copy says "Copy failed. The address is selected: copy
it." under the address and selects it, so one keystroke copies it; it never
lives in a toast.

**One save model.** Overview actions go live at once: maintenance, the
announcement, and publishing. They never touch drafted edits. Targets and
Settings are drafts, including the logo, until Save changes; their tab shows a
sage dot while it holds unsaved work, rows carry New or Edited tags, and the
dialogs say "Players see it after you save changes." The save bar,
after [Laravel Cloud's](https://mobbin.com/screens/bce31f98-3283-4c47-971c-8a0dda21ca4b)
and [Chatbase's](https://mobbin.com/screens/9ea5f0e3-06e6-4d4d-b3f0-cb82ab149858),
is a labeled region that names what is pending ("1 new target, footer text, and
logo.") with Discard and Save changes. That summary is not a live region: the
edit that made it has already said what changed, and a region that mounts
already full is voiced by some screen readers, which made the first edit of a
session speak twice. Only what the operator did not just do is said from the
bar: a conflict, field errors, a failed save, or a merge result. When it goes away under focus (after
Save or Discard), focus returns to the control the operator last used outside
it, without scrolling, or to the active tab if that control is gone; Save and
Discard stay focusable while Save runs. It is
sticky in the content column on wider screens (only as wide as the editor
column beside the Settings preview, so it never covers the preview) and a
full-width bottom bar on phones. It never hides the focused control: while it
is pinned, the scroller's `scroll-padding-bottom` matches its height, a fixed
bar reserves that space at the page end, and a control that receives focus
under it scrolls clear. In viewports under 30rem tall (a phone on its side,
400% zoom) it is not pinned at all and follows the content. Its text wraps and
is never cut with an ellipsis; a merge warning takes the bar's full width with
the actions below it. Pinned on a phone, the bar never takes more than half the
screen: its title, intro, and actions stay put while the list of decisions
scrolls inside a focusable "Merged changes" region, and a list longer than three
shows the first three with a "Show all 5 changes" button (and "Show fewer").
While more of the list sits below the region's edge, its last line fades out,
so a list cut by a short screen never reads as complete.

Edits are protected, not just kept. The draft remembers the saved revision it
was built on; the 30-second status poll refreshes health and live fields but
never moves that base, so Save is always checked against the version the
operator started from. A staged logo holds the base like any other edit, and
logo upload and removal send that revision too (`X-Cupboard-Logo-Revision` on
the upload, `{"revision": N}` on removal), so another session's logo change is
a conflict, never a silent replacement. When a poll shows another session saved
meanwhile, the bar says so at once ("Changed in another session. Your edits
aren't saved yet.")
instead of waiting for Save to fail. "Load latest, keep my edits" is a
three-way merge: fields and targets (one by one, by kind and source) the
operator changed keep their value, everything else takes the newer version, and
a target added elsewhere stays. Header links have no identity, so they merge as
one list: when both sides changed them the operator's list wins whole, and a
label never pairs with an address neither side chose. Every decision both sides
made is named in an amber "Check the merged changes" notice that stays until
Save or Discard, one decision per bulleted line: fields whose edit replaces the
other session's ("Your footer text replaces the other session's."), targets
the other session removed that the operator edited ("Website was removed
elsewhere. Saving adds it back."), targets the operator removed that the other
session changed, targets both changed ("EU main changed in both sessions.
Both changes are kept.", or "Saving uses your name" where both changed the
same field), and a target both sessions added from the same source with
different choices ("Shop was also added elsewhere, as Store. Saving uses your
name and visibility (shown to players)."); identical additions merge quietly.
A target is always named as the operator knows it, with the other session's
new name after it ("Store was renamed Store (EU) elsewhere. Saving removes
it."). "Discard my edits" confirms before
reloading. Fields stay editable while Save runs: what was sent is kept apart,
and anything typed meanwhile stays as the next draft on top of the saved
revision. That Save never says a bare "saved": the bar says
"Saved your earlier changes. Not saved yet: page name and footer text." until
the next edit. A Save that leaves nothing pending confirms in the bar, the
region renamed "Changes saved": a sage check, "Saved", and "Visitors see it
now." ("Visitors see it once the page is published." while unpublished), at
the height the bar had (on phones, one line), for six seconds or until the
next edit; then the bar fades and its space stays until releasing it moves
nothing. Focus returns to the last field without scrolling, before Save
goes. The admin page shows no toasts at all: Publish hands focus to the title
link, the announcement, maintenance, and unpublish dialogs let the
page's change confirm them and say it politely, and Publish and Unpublish
say the new headline in that one message ("Status page published. Players
see: EU main is unavailable.", "Status page unpublished. Players see a
not-found page."), never alongside the card's own. Save is staged for the operator: the page saves first,
revision-checked (a page never saved always writes its row first), and the
logo uploads only after it succeeds, checked against the revision that save
returned; if the logo then fails, the bar says the other changes are saved and
the logo is still pending. Leaving with unsaved edits goes through the
workspace's shared guard (`useUnsavedChanges`): workspace links, the Ctrl+K
command menu, organization switching and sign out, reload, closing the tab,
and the browser's Back button all ask first with one "Leave without saving?"
prompt that lists what is pending on its own line. The discard prompt says
"You have unsaved changes" the same way. Request failures show product copy;
transport text such as "Failed to fetch" never reaches the screen.

**Validation.** Errors sit under their field with an icon, the control gets
`aria-invalid` and `aria-describedby`, and focus moves to the first invalid
field (switching to Settings when needed), after the inline errors in
[Mintlify](https://mobbin.com/screens/31a78b73-f62f-4129-8d80-df093e8b7021) and
[Podia](https://mobbin.com/screens/eecdc958-60b4-412b-a6f9-d630ab3011f6). The
save bar only counts them ("2 fields need attention") and offers Show; the
highlighted fields say the rest. The
client checks what the server checks: HTTPS for the support link and header
links, the slug pattern, and the hex accent.

**Overview.** It answers "what needs me" with the true status of every
target, after [Customer.io's health card](https://mobbin.com/screens/b9743841-5a29-4454-bc39-133d7b0d7d9c)
and [Grab's problems-first diagnostics](https://mobbin.com/screens/f21cc30a-b0e8-4c8e-9de8-3a829706255c).
What players are told is not the operator's question: it stays on the public
page (the title link) and in the editors' preview, and the Overview never
shows a player headline or a "Hidden from players" line. The first card, full
width, is headed by an operator headline from every target's observed
`health`, hidden ones included: "3 targets need attention" with the worst
glyph, or "All 7 targets operational" in sage, 20 to 24 pixels. Under it one
13-pixel line gives the count ("7 targets, 2 hidden."), then, while a window
runs on any target, "Maintenance until 9:00 PM UTC." (one line on a 320
pixel phone) with a calendar glyph (the latest end among running windows), then "Updated 4:54 PM
UTC.". The headline stays the observed health, so "All 2 targets
operational" is true during a window, and that line keeps the window from
going unsaid. Manage targets sits on the right from 640 pixels; on phones it
is the card's last row, full width and 44 pixels tall with a chevron, so it
never sits alone under the headline. Then "Needs attention"
(unavailable, degraded, unknown, worst first) with the backend's reason
("HTTP 503 in 23 ms") and the reading's age, then "Under maintenance" for
healthy targets inside a window, then a collapsed "N targets operational"
disclosure. Maintenance and visibility are words beside the health, never a
replacement for it: a target that is down during a window stays in Needs
attention, reads Unavailable, and carries a Maintenance tag; a hidden one
carries Hidden. (`componentStatus`, which lets maintenance stand in for
health, is the public view's rule and is not used here.) A failed refresh of
the dashboard itself keeps the last known status, dims the headline, and
replaces the Updated line with "Couldn't refresh. Last checked ..." and
Retry. The card's visually hidden live region says a new headline only when a
refresh changes it; Publish and Unpublish say their own one message. A page
with no targets shows the three-step setup card in this place instead.
Maintenance and the Announcement follow, side by side from 1024 pixels and
stacked below that, so the DOM order is the visual order at every width.
Card headers keep their action on the title row; a long count wraps under the
title instead.
Maintenance: only an in-progress window carries a badge ("In progress", in
neutral), with "Ends in 2 hours" and an inline Mark complete; scheduled ones
say "Starts in 2 days" over the zoned range (which already shows the length),
whose days read as on the public page ("Today, 7:00 PM to 9:00 PM UTC",
"Tomorrow", then "Mon, Nov 9"; `dayName` in `src/lib/status-page.ts`);
a window touching only hidden targets is tagged "Hidden", like a hidden
target; past windows hide behind a chevron divider row with their count. Empty,
the card is a compact centred empty state from `ui/empty.tsx`, stacked like
the Machines empty state: the calendar tile a window row carries (bordered, so
it never fades into the card), then "No maintenance scheduled" (a paragraph,
since the card's heading names the section), then an outline Schedule
maintenance button. Compact padding keeps the card a little shorter than one
with a window; past windows stay reachable below. With current or upcoming windows, a ghost "Schedule"
action (named "Schedule maintenance") sits in the card header, so a second
window is always one press away; the two never show together. Viewers see
neither. The Announcement card
shows the current text (or "No announcement.") with Post or Edit; its dialog
("Goes live on your page when you post it.") saves immediately and keeps Remove announcement in the body as a quiet
destructive button, so the footer holds only Cancel and the primary. A
page with no targets gets a three-step setup card (Add a target, Brand the
page, Publish, which points at the Private pill) whose Add target opens the
dialog directly, like
[Better Stack's onboarding list](https://mobbin.com/screens/280299a6-26a7-4c8d-8c4e-1bd6429bca80).
It leads the page at every width, where the status card would be.

**Targets.** Rows follow [Better Stack's monitor list](https://mobbin.com/screens/bf3fbed5-e633-4df4-aa6f-320ac608270b):
status glyph, name with Hidden, New, or Edited tags, then the kind icon and
source (mono for addresses) on a second line, the status label as its own
right-aligned column from `md` (on the second line below that), an eye toggle with
a stable label ("Show Website on the public page", state in `aria-pressed`),
and an actions menu (Edit, Move up, Move down, Remove). Rows sit in the same
group sections the public page shows, each with a count and hidden count, and
reorder only within their group, so the list order is the public order. The
grip (from `md`) drags live, after [Square's rearrange list](https://mobbin.com/screens/0a58c939-63ab-4837-a6d3-75efde14f794):
the held row lifts (raised surface, shadow, edge) and stays in the open gap
where a drop would put it, leaning up to 8 pixels toward the pointer. Rows
keep 8 pixels of padding, so the lean never reaches a neighbour's name,
status, glyph, or address. The pointer's travel decides the gap: a row slides
aside by the held row's height once the held row's leading edge would cover
half of it, measured from where the rows stood when the drag began, so turning
back returns it at the same point. At that moment the held row and the passed
row move to their new places together in 120 ms (at once with reduced
motion), and the passed row is drawn above the held one until its own slide
ends, so its text is never covered in any frame. The list always shows the
order a drop would make, and the drop lands within 8 pixels of where the row
already is. Nothing changes until the drop, which commits one move and is
announced once. Escape or a cancelled pointer puts the row back ("Move
cancelled."). Near the screen's top or bottom edge the page scrolls under the
held row. The grip takes the pointer (`touch-action: none`) and starts the
drag; the rest of the row never does, so the eye toggle and menu stay
tappable. The grip also moves with Arrow Up and Arrow Down; every move, add,
removal, and visibility change is announced, and focus lands on the next
row's actions after a removal. Narrow screens drop the grip
for the menu's Move up and Move down; rows never scroll sideways at 320 pixels,
and the list is size-contained so a long address truncates instead of widening
the workspace column on tablets. A row's spoken subtitle never repeats its
kind ("Game server: Game server"). The grip's "Drag to reorder" tooltip
mounts inside the page's `main` landmark (the shared `TooltipContent` takes a
`container`), so nothing on the page sits outside a landmark.

**Dialogs.** Long dialogs use the shared `scrollable` DialogContent: a scrolling
DialogBody between a fixed header and footer, and a bottom sheet on phones with
the actions side by side. In windows under 480 pixels tall (the `short` variant:
a phone on its side, a laptop at 400% zoom) the header and footer stop being
pinned and the whole dialog scrolls as one, so the form never shrinks to a
sliver between them. Closing any dialog returns focus to the control that
opened it, or to the next sensible control when that one is gone. Destructive
confirmations use the solid `destructive-solid` button. Confirmations
(`AlertDialog`) are bottom sheets on phones like every other dialog, after
[Lightyear's delete sheet](https://mobbin.com/screens/2041c114-ecf9-499e-8603-b0aadd2506ab):
Cancel (or Keep editing) first and the confirming action last, side by side,
growing from their labels and wrapping before a label is cut, so the visual
order is the tab order at every width. The add target dialog
starts with Website, Machine, or Game server. Display name stays empty until
the operator types: the website's host or the machine or server's own name is
its placeholder (screen readers also hear "Leave empty to use
forum.example.com.") and is used only if
the field is still empty on submit, so typing never appends to a suggestion.
Before there is a suggestion the placeholder is a plain example ("Such as
Forum"), never a value that reads like a default. A bare host pasted into
Address ("forum.example.com") means https and is completed on blur. A
website's check interval sits right after the Address label, 8 pixels from
it, as a timer glyph and "60s" (the backend's `URL_INTERVAL_MS`); screen readers hear
"Checked every 60 seconds" as the field's description. Machines and game
servers show no interval.
On phones, footer buttons grow from their label's width and wrap before a
label is cut. Radio-style toggle groups (Type, Length, Theme, Accent, Preview
width) select as the arrow keys move, like native radios, so the tab stop
always returns to the chosen option. The picker shows just the name and tells "No game servers
match 'zzz'" (with Clear search) apart from "Every one of your machines is
already on this page" (with a link to Machines). Groups are a select over the
machine tag catalog, so the same tags organize machines and the status page.
The select carries no hint; only an empty catalog explains itself, as a
disabled "Add tags on Machines to make groups." option under No group.

**Scheduling.** The maintenance dialog follows [incident.io's form](https://mobbin.com/screens/450fda91-b483-4b19-8f08-981be36c142c)
with [Wix's](https://mobbin.com/screens/37bd167a-d9a1-4904-af4f-1ee9d90f9506)
and [Fresha's](https://mobbin.com/screens/ada687d4-6868-466a-ac3d-6ba9ff310ec1)
separate date and time fields (side by side, or date above time when the
dialog is under 22rem wide, so the date is never cut): Title, Message, then
When, with a start date
from the shared DatePicker (weekday shown), a TimeField in the operator's clock
(typed, never the native picker; "7pm" and "1930" work, arrow keys step 15
minutes and skip a daylight saving gap; a time the clock skips that day, or
one with a zone label it can't have that day, is no time at all: submit keeps
the dialog open, focuses the field, and shows the field's own message), and Length as one segmented control like Type (30 min, 1,
2, or 4 hours, or Custom with its own end date and time). A summary line reads "Starts in 2 days, on Sat,
Nov 7 at 7:00 PM UTC, and lasts 2 hours." over "Your time zone,
America/New_York. Players see theirs." The zone line names the zone itself,
never EDT or EST, so it can't contradict the field or the summary on a day in
the other half of the year. Screen readers hear an absolute version of the
summary when the window changes, never the ticking relative one. The summary
never states a time the operator didn't choose: while a typed time is one
daylight saving skips or has a zone label that doesn't fit ("7:00 PM EST" in
June) it reads "Fix the start time to see when it runs." (muted, and nothing
is spoken; the field says what is wrong), and when the end is before the start it keeps the
valid start ("Starts in 2 hours, on ... The end is before the start."), dropping
the second sentence once the field shows its own error. Affected targets (a named radio group) are All
targets or Specific targets, chosen from a checklist grouped like the page,
with a tri-state group checkbox, a selected count, search from six targets,
Hidden tags, and no scroll of its own: the dialog body is the only scroll
region at every width, and choosing Specific targets never moves it. The "choose at least one"
error and the amber "Players won't see this: every chosen target is hidden."
warning (eye-off glyph) sit
at the top of the list, beside the count, where they are seen before
scrolling. The client rejects windows that end before they
start, last over 30 days, or are already over.

**Settings.** On screens 1280 pixels and wider, the editor (a 34rem column) sits
beside a sticky Public preview that always shows the phone frame (360 pixels)
at real size, so every word beside the editor is readable, and a Desktop
preview button that opens the desktop page at real size in the sheet (up to
66rem wide). No scaled desktop thumbnail is offered beside the editor.
Preview exists only where public-facing edits happen: a Preview button at the
end of the tab row on Targets and on Settings (below 1280 pixels, where no
preview column sits beside the editor), on a private page and with unsaved
changes alike. Below 640 pixels it is a 44-pixel glyph button still named
"Preview", and the tabs tighten to 8-pixel padding, so all four fit 320
pixels with two unsaved-change dots.
Overview has none, and neither does the header. Closing the sheet returns
focus to the button that opened it. The sheet has a Desktop or Phone width
toggle; Desktop lays the page out at a real 1024-pixel width and scales only
when the sheet is narrower. Under 640 pixels the toggle is hidden and the
sheet shows the phone frame. Both previews are titled "Public preview" and
say nothing more. The
preview renders
the real public view inside an `inert` wrapper (no links in the tab order, no
duplicate landmarks or headings) and feeds it what the endpoint returns:
`publicMaintenance` drops week-old windows and hidden-only windows, and hidden
targets stay out. Sections: Page (name, public address with an amber warning
that old links stop working when a published page's address changes, also
named in the save bar as "public address (old links stop working)", support
link, whose placeholder shows the expected link and which carries no hint),
Branding, and Header and footer (header links as numbered groups with visible
Label and Address fields under a "2 of 3" count, footer text, the Powered by
Cupboard switch). The
announcement lives on Overview, not here.

Branding is modeled on what Uptime Kuma and hosted status pages let customers
set: a logo, a theme, an accent, one of a curated set of fonts, up to three
header links, footer text, and the Powered by Cupboard credit. Theme is three
picture cards (Dark, Light, System, each a tiny page sketch in its own tokens),
after [incident.io's branding step](https://mobbin.com/screens/e34a9184-b0b8-4f43-b070-408e4f17c25f).
Accent presets are a single-tab-stop radio group with arrow keys and named
swatches ("Vermilion (#e4572e)") beside the hex field, and a one-line contrast
verdict for the theme in use: "Stands out on dark pages." with a check, or, for
a page background under 3:1, an amber "Fades on light pages. Try a stronger
color." The ratios are one press away: a quiet Ratios button (named "Contrast
ratios") opens a popover, itself named "Contrast ratios", listing each page
background, the button text, and the 3:1 the top bar and button need, after
[Canny's checker](https://mobbin.com/screens/5ee30084-ecc8-4be9-9627-3adae4a2b839).
The verdict is the accent field's description; an operator choosing a color
acts on "fades", not on "2.1:1".
Selected and focused never look alike: a selected theme card has a sage border
and a check badge, a selected swatch a check and a light inner edge, and focus
is always the shared 2-pixel sage ring with its offset. Swatch selection keys on
`aria-checked`, because the swatch's tooltip owns `data-state`. In forced colors
every swatch and the hex field's dot keep their real color (the color is the
content) inside a CanvasText edge; the selected swatch adds a Highlight edge and
a HighlightText check on a Highlight disc, and focus is a CanvasText outline.
The accent only colors the top bar, the Contact support button, and the initial
shown without a logo; status colors never change, so players read health the
same way on every page. The accent never drives focus:
public focus is a 2-pixel outline in the page's text color with a 2-pixel
offset, which contrasts with the background in every theme, and an accent
button that falls under 3:1 against the page background gets a 1-pixel edge in
a deeper (light page) or lighter (dark page) shade of the accent itself, the
first that holds 3:1 (`accentEdge`), so the edge reads as part of the button
rather than a dark ring. A System page carries both shades and the browser
picks the one for the visitor's scheme (`light-dark()`). Button text is Cupboard's near-black or white, whichever
clears 4.5:1 with more room, and pure black in the narrow mid range where
neither does (`accentForeground`), so no accepted accent leaves "Contact
support" under 4.5:1.

The logo tile is the only entry point (no separate upload or replace button): it
picks a file when empty, opens the editor when set, and accepts a dropped file;
the supported formats and 20 MB limit are its screen-reader description only
("PNG, JPEG, WebP, GIF, or SVG, up to 20 MB"), since a refused file says them.
A file it can't use (wrong type, over 20 MB) turns the tile's edge red and
puts the reason beside it until the next file, never in a toast. A trash button on the
tile's corner confirms in a popover. Picking or dropping a logo opens an editor
dialog instead of uploading the raw file: a 16:9 stage with a dimmed crop frame
(Original, Square, or Wide), drag or arrow keys to pan, the wheel, slider, or
plus and minus keys to zoom, snapping within 6 pixels of the frame's center
lines and edges with a sage guide line (Alt disables it), quarter turns and a
flip with tooltips, and a transparent, white, black, or accent background (a
2x2 grid on phones, with a note that the accent is baked in). Visible help
under the stage is one line ("Drag to move, scroll to zoom. Alt skips
snapping.", or "Drag to move." on touch); the crop area's description adds the
keys for screen readers, followed by the crop in words
("Logo 8% left of center, centered up and down, at 100% zoom. Part of the logo
is outside the frame and will be cut off."), which is also announced when the
arrow or zoom keys rest; arrow keys land exactly on the center and edges they
pass within half a step of. The zoom slider is named and speaks "150 percent". At zoom 1 the whole image fits the frame. The browser
renders the result to a PNG of at most 640 pixels and shows it in a dark and a
light header; Use logo stages it, and it uploads with Save changes (removal
too). A file that cannot be decoded collapses the editor to the explanation
with Choose another image.

The light theme is a scoped token set (`.theme-light`) that darkens status
colors for contrast on white, and a full light page also lights the document so
the scrollbar gutter matches. Dark and Light lock the page to the
organization's branding; System (`.theme-system`) applies the same light tokens
inside a `prefers-color-scheme: light` media query. Both share one
`status-light` utility in `globals.css`, and the choice is pure CSS, so a
light-preferring visitor never sees a dark first paint.

Copy buttons use `copyText` from `src/lib/clipboard.ts`, which falls back to the
copy command when the async clipboard is missing on plain-HTTP origins.

### Public status page

Players open the page to answer "can I play right now, and when is it back",
often on a phone from a Discord link. The page is player-first and calm, inside
Cupboard's tokens and the operator's branding. Everything on it serves that
answer: one statement, one list, a maintenance timetable, and a footer. Text
that repeats what another part of the page shows is cut, or kept for screen
readers where hearing it with the headline helps.

- **Composition.** One 42rem column centered on the area beside any
  scrollbar (`mx-auto`), like the accent bar and the footer rule, so the bar,
  the rule, the column, and the footer line share one center with or without
  a scrollbar; nothing is boxed except the services list. The operator's accent runs as a 4-pixel bar across the whole
  window and reappears only on the logo tile and the support button. Sections
  sit 48 pixels apart (56 from 48rem) under 15-pixel headings; the hero gets
  80 pixels of air below the header on wide pages. Glyphs that lead a block
  (the hero's state glyph, the announcement's megaphone) hang in the left
  margin from 50rem, so the title, the announcement, and every list share one
  left edge. Below that the block's text is indented (`--hang`, 32 to 48
  pixels, following the hero's type size) and the glyph sits in the indent at
  the column edge, a hanging indent like [Xbox status on phones](https://mobbin.com/screens/1742b6b0-7249-403c-9459-b1effd2573a2):
  the headline's wrapped lines, its answer and Updated lines, and the
  announcement share one text edge, never wrapping under a glyph.
- **Hero.** An unboxed, left-aligned statement, not a centered card with an
  icon tile, after [Polestar](https://mobbin.com/screens/c0029cca-3635-4457-88b9-aebb38affec9)
  and [Xbox status](https://mobbin.com/screens/1742b6b0-7249-403c-9459-b1effd2573a2).
  It is the page's one large element: 28 pixels on phones up to 44 pixels
  from 48rem, semibold, tracked tight (-0.025em), balanced, with the state
  glyph in the state color carrying the color (no rail, no tint, so dark and
  light read the same). The title names the services in the worst state
  ("Rust EU Main and Rust US Weekly are unavailable"; more than three become a
  count). The page says "All services are online" only when every service has
  reported and is operational. When the only gap is unreported services the
  hero names them ("use1-wings-02 hasn't reported yet", or "hasn't reported
  recently" for one that reported before). Under the title sits at most one
  answer line, at 16 to 18 pixels in the text color: when maintenance is the
  headline, "Back by 6:30 PM UTC (in 1 hour 42 minutes)", or "All back by
  1:00 AM UTC" when windows end at different times (each window under the
  hero gives its own end and countdown, so the hero names the last end once
  and repeats no row's countdown); while stale, "Last known: ..."; on an
  empty page, "Check back soon". The answer line has no full stop, like the
  Updated line under it; the screen-reader sentences keep theirs. The
  parenthetical steps back to the secondary color so the time stays the
  strongest part. Below a 30rem page it drops its parentheses and takes its
  own quiet line ("Back by 6:30 PM UTC", then "in 1 hour 42 minutes" in the
  secondary color), so the end stays on one line at 390 and 320 and the
  countdown is never a stray fragment. Every other summary sentence ("Store is degraded.",
  "use1-wings-01 is under maintenance until 8:15 PM UTC.", "Everything else
  is online.") repeats what the list shows, so it is screen-reader text right
  after the title: a screen reader still hears the whole picture with the
  headline, a sighted player reads the list. Then "Updated 9:04 AM UTC" in
  13-pixel secondary text, absolute with its zone so screenshots compare
  across time zones, like [Better Stack](https://mobbin.com/screens/0d34fbf2-e4c4-451c-ad5d-de3cdf409164);
  the relative age shows only while stale. It is left out when no services
  are listed.
- **One summary, two surfaces.** `publicSummary` in `src/lib/status-page.ts`
  produces the hero's title, its detail sentences in order (with times marked
  for `<time>`), the `answer` (the one line shown under the title, always the
  first detail line without its full stop), the count, and the stale ("Status may be out of
  date" / "Last known: ...") and unpublished ("Players see a not-found page" /
  "When published: ...") variants. The settings preview renders the same
  strings, so the two never drift.
- **Counting.** "Online" is operational plus degraded, because players can
  join a degraded server. Maintenance is counted on its own and unreported
  services are not online: "3 of 5 online", "1 of 2 online, 1 under
  maintenance". The Services heading, group roll-ups, and the admin use the
  same rule (`onlineCount`). Like a group's roll-up, the count beside the
  Services heading shows only while a group is collapsed: with every row in
  view it would repeat them. A collapsed group's roll-up names maintenance
  (", 2 under maintenance"), so no affected row is out of sight unsaid.
- **Freshness.** When a refresh fails, the hero turns neutral (a history
  glyph), reads "Status may be out of date" with "Last known: ..." as its
  answer, shows "Updated 9:04 AM UTC (5 minutes ago)", and offers Retry. The
  page refreshes every minute while visible and again on return to the tab.
  Separately, the server treats a game server reading older than five minutes
  as unknown, like URL checks, so an old reading never reads as online, and
  every row whose reading is more than three minutes old says "Last checked
  ..." whatever its state. While the page is stale nothing in the list looks
  live: row glyphs, labels, and roll-ups drop their state color (problem chips
  lose their outline), screen readers hear "Last known Unavailable", and the
  Services count carries "As of 9:08 PM UTC" for screen readers (the hero
  already shows the time).
- **Times.** Every time is a `<time datetime>` in the visitor's zone with the
  zone label, the weekday, and the year only when it differs, like [Dropbox's
  scheduled maintenance](https://mobbin.com/sites/sections/572040f9-7411-4b7f-9af5-edd0dca8b8eb).
  A range that crosses a daylight-saving change names both zones ("1:30 AM
  EDT to 1:30 AM EST"). A time and its zone, and a date, never wrap apart.
  Countdowns under a day keep their minutes ("in 1 hour 41 minutes"); ages
  past an hour round to whole hours ("3 hours ago"), since the minutes are
  noise there. Server HTML renders in UTC and en-US and switches to the
  visitor's zone after hydration.
- **Services.** The one card on the page, under a "Services" heading with the
  count. Ungrouped targets come first in operator order, then each tag group
  as an `h3` header row: the group's name as a quiet 13-pixel semibold label
  in the secondary color (no band, a hairline above). The heading holds the
  group's name only, so the heading list stays short. A collapsed group shows
  a rolled-up count in the worst state's color at the right, standing in for
  its hidden rows; an open group shows its rows and no count, since they say
  the same thing. On a collapsible group the roll-up is always the disclosure
  button's description (screen-reader text while open), and the button
  covers the whole row. This follows
  [Xbox's grouped services](https://mobbin.com/screens/b48dd50c-ec19-411f-a07b-60d6e59f0dd9)
  and [Linear's status groups](https://mobbin.com/sites/sections/28e936ae-4d43-4ce0-9187-8f15d06c5478).
  When a page lists more than eight targets, healthy groups start collapsed
  and problem groups start open, like [OpenAI's service accordions](https://mobbin.com/screens/d605f83d-3869-4ecc-8874-b913e09e2930).
  A collapsed group opens itself when its worst state gets worse; a visitor's
  collapse holds while the incident stays the same. Rows are list items: a
  shape glyph (check, triangle, cross, wrench, dashed circle for not
  reported), the name, which wraps instead of truncating, and the label. In
  reading order the state follows the name ("Rust EU Main: Unavailable.")
  while the label stays at the row's right edge. Unreported rows say "Hasn't
  reported yet". A row shows its reading's age when it is old. A coming
  window is screen-reader text on the row ("Maintenance on Sat, Nov 7"):
  Upcoming maintenance names every service it affects, so the row does not
  repeat it on screen, and no row repeats a maintenance end.
- **Status labels.** Emphasis follows severity, so the worst news is the
  loudest: Unavailable and Degraded are bold outlined chips in the state
  color (no fill, which keeps the label at 5:1 or more on the card in both
  themes); Operational, Under maintenance, and Unknown are plain medium text
  (sage for Operational, secondary text for the other two). Group roll-ups are
  bold in the state color for unavailable and degraded, medium otherwise.
  Lines players act on (times, reading ages, what a window affects), status
  chips and labels, roll-ups, the Retry button, and the footer are 13 pixels;
  no text on the page is smaller.
- **Maintenance.** A timetable, not cards: entries separated by hairlines,
  with the time in its own 11rem column on the left from 40rem (title first
  in reading order, so heading navigation lands on it), stacking under the
  title on phones. Upcoming entries read "Sat, Nov 7" (the day in the text
  color, named as in the admin by `dayName`: "Today", "Tomorrow", then the
  date), the hours, and "in 2 days"; in-progress entries
  read "Back by 7:15 PM UTC" and "in 1 hour 41 minutes". The relative phrase
  takes its own quiet line, without parentheses, at every width, so at 320
  it is never a stray "(in 1 hour 57 minutes)" under the time. When the hero
  already states the single end, the entry has no time to give, so it drops
  the time column and puts "In progress" on the title's line, at the right
  like a service's label, rather than leaving the column mostly empty. Each entry gives its
  title, what it affects as plain names ("Rust EU Main and Rust US Weekly",
  "All services"; screen readers hear "Affects ..."), and the operator's
  message in the secondary color. When maintenance is the headline its
  windows follow the hero directly under a hairline, and the names are left
  out for a single window, whose services the title already names; otherwise
  they sit under "Maintenance in progress" after the announcement. These
  entries sit above Services, so when several windows are in progress, or a
  note runs past about two phone lines (120 characters), each entry keeps its
  end and what it affects in view and its note waits behind the entry: the
  whole row is a disclosure button with a chevron at its right edge. With two
  windows on a 390-pixel phone that brings Services up 128 pixels, onto the
  first screen. "Upcoming maintenance" follows Services with its notes in
  view, and "Past maintenance" (the last week) rests as a quiet one-line
  entry per window, the day and the title, that opens to its hours, how long
  it lasted, what it affected, and its note, like the start and end on
  [PayPal's event log](https://mobbin.com/sites/sections/c88f3dcf-3133-4c5c-9b3a-acea925358c2).
  A folded part is hidden from everyone until the row opens, so sighted
  visitors and screen readers always get the same entry. A window whose targets are all hidden
  is never published, and hidden target ids never leave the server; the
  preview applies the same rule (`publicMaintenance`).
- **Announcement.** The operator's words alone (`role="note"`, named
  "Announcement" for screen readers) at 15 pixels in the text color, with a
  muted megaphone glyph and line breaks kept; no card and no byline. It is
  the operator's own text, so any time it mentions is theirs and is not
  converted to the visitor's zone like the rest of the page.
- **Footer.** A hairline across the whole window (the footer's own top edge,
  outside the column) with one centered line under it: the operator's footer
  text and "Powered by Cupboard", side by side, after [Better Stack's public page](https://mobbin.com/screens/0d34fbf2-e4c4-451c-ad5d-de3cdf409164)
  and [incident.io's](https://mobbin.com/screens/05816d43-88a9-4537-a444-a09ca5456e03).
  The page is at least the small viewport tall (`min-h-svh`), so on a short
  page the footer rests on the bottom edge, above a phone's browser bar, and
  on a long page it follows the content. The line is 20 pixels under 20
  pixels of padding (61 pixels with the rule), on touch screens too: the
  Cupboard link's 44-pixel hit box reaches into the padding instead of
  growing the footer, and wrapped lines leave it room. Below a 360-pixel
  page the side padding drops to 8 pixels and the gap between the two parts
  to 16, so a short footer text ("© Northstar Games") still shares the one
  line at 320; a longer one, or a wider font, wraps to a second centered
  line. With neither footer text nor Powered by there is no footer.
- **Motion.** Only change moves, never the first paint. A new headline after a
  refresh settles in (a 300 ms fade and 4-pixel rise, motion-safe only), and
  a service row whose state changed flashes its new state color once
  (`animate-status-flash`, 1.6 s, from 14% to nothing), so the change is easy
  to find. Reduced motion skips both; instead the changed row holds a still
  10% tint of its new state color for five seconds, so a sighted visitor can
  still find it, and the live region still says what changed.
- **Structure.** Header, main, and footer are separate landmarks; the overall
  status is an `h2` and not a landmark of its own, since its name would be
  the headline and change with every state. A visually hidden status region announces
  what changed in one short sentence ("Store is now degraded.", "Maintenance
  started: Wings node restart.", "Couldn't refresh. Status may be out of
  date."), never the ticking update time. The browser tab title gains the
  state ("Unavailable | Northstar Games | Status") during problems, from the
  server's first response and again after each refresh. Header and
  footer links are 44 pixels tall on touch, and "opens in a new tab" is their
  description. On phones the name and a "Support" button share the first row
  and header links wrap to a row 12 pixels below. The embedded preview renders no landmarks,
  headings, or live region, and centers in its own frame.
- **Missing and broken addresses.** Unknown and unpublished addresses share one
  page, "This status page isn't available", that does not reveal which case it
  is, after [SoundCloud's not-found](https://mobbin.com/screens/fb0bab97-c063-4e49-a922-a8c9589a8cc6).
  A failed load shows "Status can't be shown right now" with Try again and a
  retry every minute, after [UNIQLO's unavailable page](https://mobbin.com/screens/d6bcaa36-ae74-4e40-919d-6b76d19f62af).
  Both follow the visitor's device theme because the page's branding is
  unknown, and lead with a muted glyph tile (a crossed-out search for missing,
  a crossed-out cloud for a failed load) so the case reads at a glance. The
  not-found page offers Go back when the visitor arrived from another page,
  after [Instagram's unavailable page](https://mobbin.com/screens/5294ba10-11ee-43dd-892c-840e0fbfdab6);
  a pasted address shows no dead button. Like every status page they start
  with the 4-pixel accent bar, in Cupboard's sage since the page's own accent
  is unknown, and their footer is the status page's: a rule across the
  window and one centered line.
- **Empty.** A published page with no targets says "No services listed yet"
  with "Check back soon." and omits the list; setup instructions stay in the
  dashboard.

## Scrollbars

Every scrollable area in the workspace uses Cupboard's own scrollbar: a slim rounded thumb in
`--border-strong` on a clear track, matching the ScrollArea component, with the
thumb darkening on hover. Chromium and Safari use the scrollbar pseudo-elements;
Firefox, which has none, gets `scrollbar-width: thin` with the same colors.
Components that hide their scrollbar on purpose, such as menus and the sidebar,
keep doing so.

From 768 pixels the document reserves the scrollbar's gutter
(`scrollbar-gutter: stable`), so the workspace never shifts sideways when a
page starts to scroll.

Public status pages (any document rendering `[data-status-page]`, including
their not-found and unavailable pages) are the exception. They keep the
browser's own scrollbar, light or dark with the page's theme, and reserve no
gutter. On a page that scrolls with a classic scrollbar, Cupboard's clear
track is the page's color, so the full-width accent bar looked cut off a few
pixels short of the corner. The browser's track is drawn as window chrome, so
the bar visibly ends at the edge of the page, as on any site. Overlay
scrollbars (phones, macOS by default) draw over the page and the bar runs to
the corner. We compared a track that continues the accent (it strands a
stub of accent color once the page scrolls), a slim track in a chrome tone
(still reads as a Cupboard control on a player's page), and an inner scroller
under a full-width bar (breaks the phone's collapsing address bar,
scroll restoration, and printing); the browser's scrollbar was the only one
that read as intended. Everything full-width and the column center on the
area beside the scrollbar, so all centers agree. A page that starts or stops
scrolling when its content changes moves its column by half a scrollbar,
which is accepted: it happens only as content moves anyway. The embedded
preview in Settings is part of the workspace and keeps the slim scrollbar.
