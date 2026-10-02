# Cupboard working rules

This repository is a clean rebuild for one developer working with coding agents.

## Before changing code

- Read `README.md` and `docs/REBUILD.md`.
- Before changing a user-facing interface, read `docs/DESIGN.md` and follow its
  visual, interaction, accessibility, and writing direction.
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
- Never use browser-native menus in the product interface. Use the source-owned
  select, combobox, dropdown, context-menu, command-menu, and popover components
  in `src/components/ui`; add a missing shared component there before using it.
- Never add preview, prototype, sample-data, or implementation-status banners,
  badges, tags, or notices to product pages. Keep development status in project
  documentation. Explain a limitation inside an affected action only when the
  operator needs it to decide what to do.
- Add an abstraction after two real implementations need it, not before.
- Delete abandoned paths instead of keeping compatibility layers for unreleased
  code.

## Developer workflow

- Name branches for the work using `<type>/<short-description>`, such as `feat`,
  `fix`, `refactor`, `docs`, `test`, `perf`, or `chore`. Do not use an agent or
  author name as the prefix. When work has a Linear issue, include its lowercase
  identifier after the slash, such as `feat/cup-123-server-health`.
- Provide one root command for local development and one root command for all
  required checks.
- Keep setup reproducible from a fresh clone.
- Follow `docs/WORKFLOW.md` for all new work. Start each nontrivial task in an
  issue-named worktree using `npm run worktree`, or reuse the isolated worktree
  provided for the current task. Never switch another task's working tree.
- Run `npm run doctor` before starting a new environment. Use `npm ci` for
  dependencies and `npm run dev` for the complete stack. Let the dev command
  select and save ports and a worktree-specific database; do not share a
  development `DATABASE_URL` between tasks.
- Use separate browser profiles or contexts for concurrent worktrees because
  cookies on the same host are shared across ports.
- Run focused checks during editing or `npm run check:quick`; run the full
  `npm run check` before declaring the change complete or ready for review.
- When working on a PR, use `npm run review -- <number>` to collect checks,
  reviews, and threads. Register the PR with the current T3 thread when its
  linking tools are available. Repeat collection after every push.
- Finish with the issue and branch, a short description of the change, checks
  and their results, the PR state when applicable, and any remaining blocker.
  Include the clickable NetBird URL when the server was started.
- Preserve worktrees and database volumes after handoff. Stop only processes and
  containers owned by the task; do not remove saved data without an explicit
  request.
- Tests must cover tenant isolation, authorization, secret handling, and the main
  success path of each slice.
- Update `docs/REBUILD.md` when a decision changes the repository shape or launch
  scope.
- Do not claim completion until the relevant checks pass.
- Bind every local web development server to `0.0.0.0` so it is reachable through
  NetBird. The root development command must print the active NetBird URL.
- Whenever a user asks an agent to start the development server, include the
  clickable NetBird URL in the response. Do not provide only a localhost URL.

## Linear workflow

- Use the Linear `Cupboard` team and `Cupboard rebuild` project as the source of
  truth for planned product work. Do not mirror the backlog into GitHub issues.
- Before starting a nontrivial change, find its `CUP` issue. Create one in Backlog
  if the work is not tracked yet, using the repository requirements and user
  request as its acceptance criteria.
- Moving an issue from Backlog to Todo means the work is approved to start. Move
  it to In Progress when implementation begins and to In Review when its pull
  request is ready for review.
- Put the issue identifier in the branch name and pull request title. Add
  `Fixes CUP-N` to the pull request description so Linear links the pull request
  and can update the issue from GitHub activity.
- Post implementation progress, material decisions, and blockers as comments on
  the Linear issue. Do not leave the only record in local notes or chat.
- Move an issue to Done only after its pull request is merged and required checks
  pass. Prefer the configured GitHub automation for status changes and correct
  the Linear status directly if the integration misses an event.

## Pull request completion

When the user asks you to create, update, or finish a pull request, carry it
through the full review cycle:

- After each push, find every CI check and automated code-review integration
  enabled for the pull request. Wait for pending jobs and reviews to finish.
- Treat CI failures as part of the task. Read the logs, reproduce the failure when
  practical, fix the cause, push the fix, and monitor the new run. Do not dismiss
  a failure as environment-specific without evidence.
- Delegate the automated review feedback to an independent subagent when
  subagents are available. Have it check every recommendation against the diff,
  surrounding code, requirements, and tests.
- Apply valid recommendations, add or update tests when needed, and push the
  fixes. Leave the code unchanged when a recommendation is invalid.
- Reply directly to the originating pull request review thread for every
  recommendation. For a valid recommendation, reply after pushing the fix and
  state what changed. For an invalid recommendation, reply with the technical
  reason for rejecting it. Do not leave these decisions only in local notes,
  commit messages, or the final chat response. Resolve the thread only after
  posting the reply.
- Repeat the review and CI cycle after every fix. A pull request is ready only
  when required CI is green, enabled automated reviewers have responded, and no
  valid finding remains unresolved.
- If a check or reviewer does not complete, keep its status explicit. Do not call
  the pull request ready. Stop waiting only when the user cancels or a documented
  access or service failure prevents further monitoring.

## Safety

- Never log credentials, session tokens, RCON passwords, API keys, or raw secrets.
- Enforce tenant ownership in the data-access path, not only in UI or route code.
- Use maintained authentication and cryptography libraries. Do not invent either.
- Keep migrations forward-only once a migration has been used outside local
  development.
