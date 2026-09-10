# Cupboard working rules

This repository is a clean rebuild for one developer working with coding agents.

## Before changing code

- Read `README.md` and `docs/REBUILD.md`.
- Treat the old implementation as reference material only. Do not restore or copy
  it unless the user asks for a specific piece.
- Preserve unrelated user changes already in the working tree.

## How to build

- Work in complete user-visible slices. A slice includes the UI, server behavior,
  persistence, and tests needed to use it.
- Start with one deployable application. Add a worker only when work cannot safely
  run in that application.
- Keep code together until a measured runtime or ownership problem requires a
  split. A product feature name is not a reason to create a service or package.
- Prefer direct calls within the application. Do not introduce internal HTTP,
  queues, or duplicated transport types between modules.
- Add an abstraction after two real implementations need it, not before.
- Delete abandoned paths instead of keeping compatibility layers for unreleased
  code.

## Developer workflow

- Name branches for the work using `<type>/<short-description>`, such as `feat`,
  `fix`, `refactor`, `docs`, `test`, `perf`, or `chore`. Do not use an agent or
  author name as the prefix.
- Provide one root command for local development and one root command for all
  required checks.
- Keep setup reproducible from a fresh clone.
- Tests must cover tenant isolation, authorization, secret handling, and the main
  success path of each slice.
- Update `docs/REBUILD.md` when a decision changes the repository shape or launch
  scope.
- Do not claim completion until the relevant checks pass.

## Safety

- Never log credentials, session tokens, RCON passwords, API keys, or raw secrets.
- Enforce tenant ownership in the data-access path, not only in UI or route code.
- Use maintained authentication and cryptography libraries. Do not invent either.
- Keep migrations forward-only once a migration has been used outside local
  development.
