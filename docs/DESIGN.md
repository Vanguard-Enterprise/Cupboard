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

Login and signup password-length failures use a top-right toast that dismisses
after four seconds, as requested for authentication. Keep focus on Password.
Missing fields, invalid email, and password confirmation mismatches use inline
field errors.

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

## Marketing navigation

Marketing pages share a dark-only header. Sign-in, signup, and dashboard pages
retain their existing layouts without this header. Follow the linked Giga capture's
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
