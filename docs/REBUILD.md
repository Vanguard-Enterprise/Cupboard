# Cupboard rebuild

## Why this reset exists

The old repository made routine product changes cross too many services, crates,
API boundaries, and development processes. That cost matters more than theoretical
scale before launch.

This rebuild optimizes for one developer who delegates bounded work to coding
agents and must be able to understand, run, and verify every change.

## Product direction

Cupboard helps Rust server operators manage their servers and understand what is
happening on them. The first release will grow from one working path:

1. An operator signs in.
2. The operator creates or joins a tenant.
3. The operator adds one Rust server through RCON and A2S details.
4. Cupboard checks the connection and stores the result.
5. The dashboard shows current server health and player count.

This path is the first proof, not the whole launch scope. Moderation, player
identity, commerce, Discord, public APIs, white-label sites, and advanced
performance analysis stay out until the core loop works in a deployed environment.

Cupboard uses an AI-first operator flow. The operator states an intent, Cupboard
reads the relevant stored server state, explains its findings, proposes a concrete
action, obtains approval when the action is sensitive, and reports the verified
outcome. The dashboard remains the source of truth for inspection and manual
control. A conversational response must never imply that an action ran when it
was only suggested or attempted.

## Starting architecture

- One repository.
- One Next.js web runtime.
- One Rust API and background-work runtime.
- One PostgreSQL database.
- One web interface.
- Background work runs in the Rust application until it causes a measured
  reliability or scaling problem.
- Redis, a message bus, and internal HTTP services are absent until a feature has a
  concrete need for them.

The initial runtime and frontend shape is recorded in
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md). The backend remains a Rust monolith.
The web interface uses Next.js App Router so it can render on the server and call
the Rust API without exposing private service credentials to the browser. This
requires a separate web runtime, which is the first deliberate exception to the
single-application default. The database library, authentication provider, and
deployment target must still be chosen together before the first persistent
application slice is added. These choices should favor maintained libraries,
fast tests, and simple deployment.

The frontend foundation stays in this repository. It uses Next.js Server
Components, semantic charcoal and sage theme tokens, and source-owned shadcn controls.
Feature slices may use mock data until the Rust application API is implemented.
Mocked response shapes do not create a compatibility promise for that API.

The dashboard navigation explores a broader organization workspace in Operations,
Community, and Organization groups. Infrastructure covers hosts and nodes; game
servers covers Rust instances. Unimplemented navigation items have no destination and do not expand the first
deployable slice. Connection capabilities must be
verified per connector before offering actions such as file access or host power
control. Player identities and staff organization membership are separate domains.

The first editable frontend page is `/dashboard/organization/settings/profile`. It currently
persists a local preview in browser storage because authentication and the shared
database remain undecided. Public and private contact fields are separate; general
search indexes only public fields. This preview is not tenant-authorized storage
and must not hold confidential production contacts. Shared persistence must add
server-side membership checks before replacing the preview. Organization search
currently covers only implemented pages and locally saved profile information.
The organization usage page at `/dashboard/organization/settings/usage` previews
activity and capacity charts with sample data. It does not meter activity, enforce
limits, or connect to billing. The organization audit log at
`/dashboard/organization/security/audit-log` previews search, filtering, and event
details with labeled sample data. It does not record user or server activity.

## Acceptance bar for the first slice

A fresh clone must support the following with documented root commands:

- Start the application and database.
- Run formatting, static checks, and tests.
- Create a local operator without editing the database by hand.
- Add a reachable or test Rust server.
- See a useful connection result in the browser.
- Restart the application without losing saved configuration.

The slice is incomplete if it requires several terminals, undocumented services,
or manual repair after a normal restart.

## Rules for adding complexity

A new process, package, data store, queue, or protocol needs a short note in this
file that names the current problem it solves. The Next.js runtime exists because
the product requires server rendering and server-side API requests. Expected
future scale is not enough reason for another process.

Code generators may create a starting point, but generated code receives the same
review and test requirements as handwritten code. If nobody can explain why a
module exists, remove it.
