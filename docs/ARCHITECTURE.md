# Cupboard architecture

## Status

This document records the starting architecture. The frontend foundation is now
selected and implemented. The backend decisions at the end of this document must
be resolved before the first persistent application slice begins.

## Product boundary

Cupboard has a Next.js web runtime and a Rust application runtime for server
operators. The web runtime owns rendering and browser-facing interaction. The
Rust application owns authentication enforcement, tenant-scoped data,
PostgreSQL persistence, RCON and A2S communication, and scheduled server-health
checks.

The Rust application remains a monolith until a measured reliability,
performance, or ownership problem requires another process or service boundary.
Product feature names do not create service boundaries.

## Production shape

```mermaid
flowchart LR
    browser[Browser] --> web[Next.js web runtime]
    web -->|Authenticated API requests| app[Rust monolith]
    app --> db[(PostgreSQL)]
    app -->|RCON and A2S| servers[Rust game servers]
```

The Next.js process is the server-rendered web boundary. The Rust monolith
contains application behavior, background work, persistence, authorization, and
external server integrations. Modules inside the Rust application call each
other directly. Cupboard does not use a message bus, Redis, or a separate worker
at launch.

PostgreSQL is the only application data store. Once a migration has been used
outside local development, later changes use forward-only migrations.

## Web frontend

The frontend uses React, TypeScript, and the Next.js App Router. Pages and layouts
are Server Components by default. They may fetch from the Rust API during server
rendering. Client Components are reserved for browser state, event handlers, and
live interactions. Frequently refreshed server state may use TanStack Query when
the first feature needs client caching or polling.

Tailwind CSS provides utility styles and semantic Slate theme variables. Shadcn
is initialized with Radix and its current component catalog is source-owned in
`src/components/ui`. Cupboard-specific components will live with their feature
or in `src/components/app`. The UI does not use a separately published component
package because only one application consumes it.

The operator experience is AI first. The primary interface accepts an operator's
intent, shows which server data the assistant used, separates findings from
proposed actions, and reports a verified result after execution. Conventional
screens will remain available for inspection and direct control. Any action that can
interrupt service, change configuration, expose data, or affect players requires
an explicit approval step. The backend will enforce authorization and approval;
the frontend is never the enforcement boundary.

The production build creates a Next.js server artifact plus browser assets. A CDN
or edge proxy may cache content-hashed assets. Server-rendered routes remain
dynamic when they depend on operator sessions or tenant data.

The Next.js runtime calls the Rust application over HTTP. It never connects to
PostgreSQL, RCON, or A2S directly. The Rust application enforces all
authentication, authorization, workflow, and tenant rules. Rendering a control
in Next.js is never proof that an operator may perform its action.

## HTTP interfaces

The system has two HTTP contract boundaries backed by the same Rust application
behavior:

- `/app-api/*` supports the Next.js web runtime. It uses an authenticated web
  session and may evolve with the frontend. Server Components call it directly;
  browser-side requests use a same-origin Next.js boundary when required.
- `/api/v1/*` will be the supported public API when that work enters the launch
  scope. It is versioned and uses scoped API credentials, rate limits, and
  pagination where applicable.

The public API gives operators a supported way to automate Cupboard. The browser
interface may use application-specific responses without turning those responses
into a compatibility promise. Both interfaces call the same Rust functions for
authorization, tenant-scoped access, validation, and persistence. Business rules
must not be copied into route handlers.

Cupboard does not treat application API routes as secret or assume that only the
Next.js runtime can call them. Every request must be safe when called directly,
repeated, or sent out of the expected UI order.

## Server health and load

Page views and public API requests do not start RCON or A2S checks. Background
work in the monolith checks each configured Rust server on its own schedule and
stores the latest useful snapshot. The dashboard and public API read that
snapshot, so adding viewers does not multiply traffic to managed game servers.

The first dashboard may poll snapshots every 15 to 30 seconds while its page is
visible. It should stop polling when hidden and back off after failures. A later
move to server-sent events or another live-update mechanism requires measured
evidence that polling no longer meets the product or load requirement.

Authenticated tenant data must not enter a shared cache. Read endpoints may use
private browser caching, conditional requests, or short-lived in-process caching
when their authorization and invalidation behavior is explicit.

## Security properties

- Every data access is scoped to the authenticated tenant in the Rust data-access
  path.
- Route handlers do not accept a tenant identifier as proof of ownership.
- RCON passwords, session tokens, API credentials, and other raw secrets never
  appear in logs or frontend responses.
- Stored server credentials are encrypted with a maintained cryptography library;
  the key source will be selected with the deployment target.
- Public API credentials have explicit scopes, can be revoked, and are stored in a
  non-recoverable form when Cupboard does not need to display them again.
- Tests cover tenant isolation, authorization, secret handling, and the main
  success path of every user-visible slice.

## Development and delivery

A fresh clone will provide one root command that starts PostgreSQL, the Rust
application, and the Next.js development server. A separate root command will
run all required formatting, static checks, and tests for Rust and TypeScript.

Development tooling may run several child processes behind that one command.
Production deploys the Next.js web artifact and the Rust application artifact.

Until the backend exists, `npm run dev` is the root development command. It starts
Next.js with hot reloading on `0.0.0.0`, prints the local URL, and discovers the
machine's active NetBird IPv4 address for remote testing. `npm run check` checks
formatting, lint, TypeScript, tests, and the production web build.

## Deliberately absent

The starting architecture does not include feature microservices, Redis, a queue,
or a standalone worker. Next.js is the single web runtime and Rust is the single
application API runtime. Any later addition must name the current measured
problem that requires it in `docs/REBUILD.md`.

## Decisions still required before code

The following choices remain open and must be made as one compatible set:

- Rust web framework and asynchronous runtime
- PostgreSQL access and migration library
- Authentication and session provider
- Production deployment target and secret-key source
- CDN or edge-cache implementation

These decisions should favor maintained libraries, fast automated tests, one-step
local development, and a deployment that does not introduce services without a
current need.
