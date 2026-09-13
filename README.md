# Cupboard

This repository contains the in-progress application rebuild.

Read the [rebuild plan](docs/REBUILD.md) for the current product scope,
architecture, and acceptance criteria. Contributors should also follow
[AGENTS.md](AGENTS.md).

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

Run every web check from the repository root:

```bash
npm run check
```

The web application uses the Next.js App Router. Pages and layouts are Server
Components unless they need browser state or event handlers. This lets the web
runtime call the future Rust API without exposing private service credentials to
the browser.

Shadcn is initialized with Radix components and the default Slate color tokens.
The current component catalog is installed in `src/components/ui` so product
work does not need to rerun setup. The application currently contains only a
minimal root page; the discarded login prototype is not part of this foundation.
