# Cupboard

This repository contains the in-progress application rebuild.

Read the [rebuild plan](docs/REBUILD.md) for the current product scope,
architecture, and acceptance criteria. Contributors should also follow
[AGENTS.md](AGENTS.md).

## Design direction

Read the [design direction](docs/DESIGN.md) before changing the interface. It
records Cupboard's product character, visual system, interaction rules,
accessibility bar, and writing style.

## Web development

Use Node.js 24.18.0 (recorded in `.nvmrc`), then install the dependencies:

```bash
npm install
```

Start the Next.js web application from the repository root:

```bash
npm run dev
```

The command starts Next.js with hot reloading, binds it to all network
interfaces, and prints both the local URL and the active NetBird URL. The
default port is `5173`; set `CUPBOARD_PORT` to use another port.
The command also allows the detected NetBird host to load Next.js development
resources so interactive controls and hot reloading work over NetBird.

Run every web check from the repository root:

```bash
npm run check
```

The web application uses the Next.js App Router. Pages and layouts are Server
Components unless they need browser state or event handlers. This lets the web
runtime call the future Rust API without exposing private service credentials to
the browser.

Shadcn is initialized with Radix components and the charcoal surfaces and muted sage accent tokens.
The current component catalog is installed in `src/components/ui` so product
work does not need to rerun setup. The `/dashboard/` page uses the shadcn
`sidebar-07` block with organization navigation. The dashboard is empty until
server data is connected. Organization profile settings live at
`/dashboard/organization/settings/profile`. Organization usage is available at
`/dashboard/organization/settings/usage` with clearly labeled sample data until
metering is connected. Organization connections are previewed at
`/dashboard/organization/integrations/connections`; the page uses sample states
and does not connect external accounts. Organization notification and
browser-data settings live
at `/dashboard/organization/settings/notifications-data`; unfinished sidebar
items have no destination.
The sidebar search opens with its button or Ctrl/Cmd+K and searches available pages,
organization details, and public contacts. Private contacts are excluded.

Profile edits remain drafts until Save changes is selected. Cancel restores the
saved values across both tabs. Invalid edits show an error and are not saved.
Updates from another tab refresh untouched forms. If local edits conflict with
a newer saved profile, Cancel loads the latest version before editing continues.
Country and supported state or region fields use searchable source-owned
comboboxes instead of native browser menus. The country menu supports keyboard
navigation and common abbreviations such as USA and UK.

Profile settings are a browser-local prototype stored under
`cupboard:organization:local-preview:profile:v1`. Nothing is shared between
browsers or sent to a profile API. Private contacts are a field grouping, not an
access-control boundary: anyone using this browser profile can read them. Do not
use real confidential details until authentication and shared storage exist.
Notification choices are also browser-local and do not send messages yet. The
Notifications & data page can clear both sets of organization preview data from
the current browser without clearing unrelated local storage.

The sidebar remembers its expanded state in the `sidebar_state` cookie for
seven days, including across refreshes and visits to the login page.
