# Development workflow

Use this workflow for new Cupboard work. Linear tracks the task, a worktree owns
its environment, and the full checks and PR review establish whether it is ready.

## Start a task

Find the task in the Cupboard team and Cupboard rebuild project. Create a Backlog
issue if none exists. An explicit user request authorizes starting that work;
move the issue through Todo to In Progress when implementation begins. Keep
decisions, progress, and blockers in issue comments.

From an existing checkout, create the task's branch and worktree:

```bash
npm run worktree -- CUP-123 feat server-health
```

The command uses the local `origin/main` ref and creates
`.worktrees/feat-cup-123-server-health` beside the repository's shared Git
directory. Fetch first when you need the latest main. Supply a fourth argument,
such as `HEAD`, when the task deliberately builds on another branch. It refuses
an existing branch or destination and preserves the source checkout's changes.
It does not create or move Linear issues. Agents do that through the connected
Linear tools before running the command.

T3 may already provide a separate worktree for the task. Reuse it and name its
branch `<type>/cup-123-description`; do not nest another worktree just to follow
the command example. Each simultaneous task needs a distinct worktree. Delegate
bounded implementation work only when requested; independent review of automated
PR findings follows the repository's PR rules.

In the new directory:

```bash
npm ci
npm run doctor
npm run dev
```

Doctor reports Node, Git, Rust, Docker, Compose, GitHub access, dependencies,
NetBird, saved ports, and any dev lock. It exits nonzero when a prerequisite is
missing. GitHub access is needed for review; application development can proceed
without it. Doctor never prints database credentials or environment secrets.
Dev prints the exact NetBird link to use from another device.

## Worktree environment

The absolute worktree path determines its Compose project name. Each project has
its own PostgreSQL container and persistent volume. Changing branches in the
same directory preserves data. Moving the directory creates a new identity and
fresh database; the old volume remains intact. Copying a worktree does not copy
its database.

The first dev startup selects available web/API ports and saves them in ignored
`.dev-stack/workspace.json`. Later starts reuse them. Next.js and Rust listen on
`0.0.0.0`. PostgreSQL publishes an automatically assigned loopback port, and the
launcher discovers it before starting Rust. Do not depend on a fixed database
port across restarts.

An occupied saved port stops startup. Stop the process that owns it or choose
`CUPBOARD_PORT` and `CUPBOARD_API_BIND=0.0.0.0:<port>` explicitly. The launcher
still fails safely if another process takes a port between checking and binding.
Overrides become the saved ports for that worktree. `CUPBOARD_DB_PORT` sets an
explicit database port. `DATABASE_URL` skips Compose and makes database isolation
your responsibility. The launcher supplies its own local `CUPBOARD_API_URL` so the
web application always talks to this worktree's Rust process.

Use separate browser profiles or isolated contexts for concurrent sign-in tests.
Cookies share a host across ports, even though local storage uses separate origins.
The development origins include localhost, loopback, and the detected NetBird IP.

Ctrl+C stops the dev launcher and application processes. PostgreSQL stays running
with its data. Stop only the current worktree's database with:

```bash
npm run dev:stop-db
```

The launcher creates `.dev-stack/dev.lock` to block duplicate starts. A hard kill
can leave it behind. Run doctor, verify that the recorded PID has exited, and
remove only that lock file before restarting. Do not delete a live process's lock.
The old shared Compose volume is left untouched and is not imported automatically.
New worktrees begin with an empty database; create test accounts through signup.

## Check while editing

Use the focused test command for the code being changed. For broader feedback:

```bash
npm run check:quick
```

Quick checks run Rust formatting and Clippy, web formatting, lint, type checking,
and Vitest. They skip database-backed Rust tests and the production web build.
Run the full required checks before completing work:

```bash
npm run check
```

Full checks create their own disposable database, run Rust tests and all web
checks, and build Next.js. They never fall back to development `DATABASE_URL`.
Use only a dedicated disposable database for `CUPBOARD_TEST_DATABASE_URL`.

## Review and handoff

PR titles include `CUP-123`; descriptions explain the change and validation and
include `Fixes CUP-123`. Register every PR being worked on with the T3 thread
when its linking tools are available. Move the issue to In Review when the PR is
ready for review; Done requires merge and passing required checks.

Collect the current PR state without changing GitHub:

```bash
npm run review -- 123
```

The command prints the head commit, checks, submitted reviews, PR comments, and
all pages of review threads. It reports whether a thread has additional comment
pages that need inspection. Its output is review data, not a readiness verdict.
Agents must inspect the enabled automated reviewers and pending checks, validate
every recommendation, fix valid findings, and reply to each originating thread
before resolving it. Repeat the review and CI cycle after every push. The full
rules are in `AGENTS.md`.

A handoff states the Linear issue, branch, what changed, checks and results, PR
state, and any blocker. If the dev server was started, include its clickable
NetBird URL and whether it is still running. Keep the worktree and database for
follow-up work. Removal of worktrees, branches, and database volumes is a separate,
explicitly requested action.
