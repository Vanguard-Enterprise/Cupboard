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

## Starting architecture

- One repository.
- One production application by default.
- One PostgreSQL database.
- One web interface.
- Background work runs in the application until it causes a measured reliability
  or scaling problem.
- Redis, a message bus, and internal HTTP services are absent until a feature has a
  concrete need for them.

The implementation language, web framework, database library, authentication
provider, and deployment target must be chosen together before application code is
added. The choice should favor one-language development, mature libraries, fast
tests, and simple deployment. The previous Rust and Next.js stack is not assumed.

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
file that names the current problem it solves. Expected future scale is not enough.

Code generators may create a starting point, but generated code receives the same
review and test requirements as handwritten code. If nobody can explain why a
module exists, remove it.
