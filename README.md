# Cupboard

This repository contains the in-progress application rebuild.

Read the [rebuild plan](docs/REBUILD.md) for the current product scope,
architecture, and acceptance criteria. Contributors should also follow
[AGENTS.md](AGENTS.md).

## Design direction

Read the [design direction](docs/DESIGN.md) before changing the interface. It
records Cupboard's product character, visual system, interaction rules,
accessibility bar, and writing style.

## Development workflow

Follow [the development workflow](docs/WORKFLOW.md) for issue-named worktrees,
isolated databases and ports, fast checks, PR review, and agent handoffs. These
are the defaults for all new Cupboard work.

## Local development

Install Node.js 24.18.0, Rustup, and Docker with Compose. The repository pins
Rust 1.96.0 with rustfmt and Clippy. Then install the web dependencies:

```bash
npm ci
```

Start PostgreSQL, local S3 storage, the Rust API, and Next.js from the repository root:

```bash
npm run dev
```

The command starts Next.js with hot reloading and automatically rebuilds and
restarts Rust when backend sources, migrations, Cargo files, `build.rs`,
`rust-toolchain.toml`, or `.cargo` configuration change. No extra watcher install
is needed. The API stops during rebuilding; compile errors stay visible in the
terminal and saving a fix retries automatically. Both servers listen on all
network interfaces. The command prints the local web URL and active NetBird URL.
Ctrl+C stops the watcher, builds, and both application processes. PostgreSQL and S3 storage remain running with their saved development data. Each worktree saves automatically selected web and API ports in
`.dev-stack/workspace.json`. Set `CUPBOARD_PORT` or
`CUPBOARD_API_BIND=0.0.0.0:<port>` to choose specific ports. Occupied saved ports
fail with an actionable error rather than silently changing the browser URL.
The command also allows the detected NetBird host to load Next.js development
resources so interactive controls and hot reloading work over NetBird.

Run all Rust and web checks from the repository root:

```bash
npm run check
```

Checks create separate disposable PostgreSQL and S3 containers and remove them afterward.
They require Docker, or `CUPBOARD_TEST_DATABASE_URL` pointing to a dedicated test
database. They never fall back to the development `DATABASE_URL`. Containerized CI runners
set `CUPBOARD_CHECK_CONTAINER` to their Docker container ID or name so checks can
attach them to the temporary test database network and detach them on completion.

The API listens on port 8080 by default. `GET /health/live` returns 204 while the
process is running. `GET /health/ready` returns 204 when PostgreSQL responds, or
503 without database details on failure. Startup fails if connecting or migrating
fails. Account, session, and organization membership endpoints are available under
`/app-api/`. The Next.js boundary forwards authenticated requests to Rust.

Local PostgreSQL publishes an automatically assigned loopback port. Each worktree
has a separate Compose project and persistent database volume. Set
`CUPBOARD_DB_PORT` to choose its database port, or supply `DATABASE_URL` to use an
existing database and skip local Compose startup. An external database is an
explicit override; use a dedicated database for each worktree. Export these
variables in your shell; the Rust process does not load `.env` files.
`npm run dev:stop-db` stops only this worktree's database and preserves its volume.
The previous shared Compose database remains untouched; the new workflow starts
with a fresh database in each worktree.

Build the production images with:

```bash
docker build -f backend/Dockerfile -t cupboard-api .
docker build -f Dockerfile -t cupboard-web .
node scripts/smoke-images.mjs cupboard-api cupboard-web
```

Production targets USE1 Kubernetes through Argo CD in `v-deployments`, with
cluster PostgreSQL and environment-provided credentials. GitHub Actions runs
checks, both container builds, and a disposable release smoke test on GitHub-hosted
`ubuntu-24.04` runners. The smoke test exercises browser assets, sign-in,
organization setup, server creation, connectivity results, tenant isolation,
secret handling, and persistence across web/API restarts. Its database and
containers are removed afterward. A successful main-branch run publishes
`ghcr.io/vanguard-enterprise/cupboard-api:sha-<commit>` and
`ghcr.io/vanguard-enterprise/cupboard-web:sha-<commit>`. Pull requests never publish.

## Staging operations

The first deployment uses [Cupboard staging](https://cupboard-staging.vngenterprise.com)
on USE1's internal ingress. Access requires the private network. Argo CD reads
`applications/cupboard-rebuild/overlays/use1` in `Vanguard-Enterprise/v-deployments`.
The `cupboard-rebuild` namespace contains the web and API Deployments and a fresh
CloudNativePG PostgreSQL cluster. The old implementation's manifests and databases
are not used. One replica per runtime and one database instance are sufficient for
this staging verification; this is not a highly available database configuration.

To release, first merge the application change and wait for the `Check` workflow,
including publication, to pass. In a separate `v-deployments` worktree, set both
images in `workload.yaml` to the same published `sha-<commit>` tag. Review and merge
that deployment change. Argo CD applies it automatically. Do not use a moving
`main` or `latest` image tag. The deployment binds port 3000 for Next.js and 8080
for Rust; only Next.js is routed through the HTTPS ingress.

CloudNativePG generates the `cupboard-app` database credential Secret. External
Secrets reads the 64-character `secret_key` from OpenBao
`kv/cupboard/rebuild/staging` into `cupboard-encryption`. Preserve this key across
all releases and database restores. Registry authentication uses the cluster's
existing `dockerconfig/aliencord-github` OpenBao entry. Neither credentials nor
production environment files belong in the image build context.

Inspect and restart only this deployment:

```bash
kubectl --context use1-oidc -n argocd get application cupboard-rebuild
kubectl --context use1-oidc -n cupboard-rebuild get deployments,pods,clusters,externalsecrets
kubectl --context use1-oidc -n cupboard-rebuild rollout status deployment/cupboard-api
kubectl --context use1-oidc -n cupboard-rebuild rollout status deployment/cupboard-web
kubectl --context use1-oidc -n cupboard-rebuild rollout restart deployment/cupboard-api deployment/cupboard-web
```

Use `/signup` to create an operator, create an organization, add a Rust server in
Servers, and select Test connection. Return to Dashboard to view saved health and
player count. Sign out and back in to verify login. After restarting both
Deployments, the same account, organization, server details, and connection
results must remain. Test connection must still decrypt the saved credential.
An unreachable server should show the protocol failure without revealing its
password. A second account in a different organization must not see that server.

The API needs `DATABASE_URL`, `CUPBOARD_SECRET_KEY`, and
`CUPBOARD_WEB_ORIGINS=https://cupboard-staging.vngenterprise.com`. The web runtime
needs `CUPBOARD_API_URL=http://cupboard-api:8080`. Production cookies stay Secure;
do not set `CUPBOARD_INSECURE_COOKIES` in Kubernetes. Readiness checks database
connectivity at `/health/ready`; `/health/live` checks the Rust process. The web
probes `/login`, which does not depend on a signed-in session.

PostgreSQL uses a retained Longhorn volume. Namespace and database resources opt
out of Argo pruning. Application restarts do not recreate the database. Do not
delete the namespace, Cluster, PVCs, or OpenBao key as a restart or rollback step.
Before production use, configure and test off-cluster database backups and a
separate encryption-key backup. Staging persistence is not a backup policy.
SQLx applies forward migrations at API startup. To roll back application code,
revert the image tags in Git only after checking compatibility with the current
schema; do not reverse migrations or overwrite a database with an older volume.

The web application uses the Next.js App Router. Pages and layouts are Server
Components unless they need browser state or event handlers. This lets the web
runtime call the Rust API without exposing private service credentials to
the browser.

Shadcn is initialized with Radix components and the charcoal surfaces and muted sage accent tokens.
The current component catalog is installed in `src/components/ui` so product
work does not need to rerun setup. The `/dashboard/` page uses the shadcn
`sidebar-07` block with organization navigation. The dashboard shows saved server health and player counts, with automatic
refresh and explicit stale readings. Organization profile settings live at
`/dashboard/organization/settings/profile`. Billing and usage are available at
`/dashboard/organization/settings/usage`. Resource meters show used and remaining
capacity; the activity chart offers 7-, 14-, and 30-day ranges with totals and an
expandable daily table. Usage values remain fixed design data until metering is
connected. Billing details read the saved, scoped organization profile and link
to its billing fields; there are no payment, subscription, or invoice APIs. Credentials and webhooks are available at
`/dashboard/organization/integrations/credentials` as a browser-local preview.
Credential secrets appear only once and are never stored; webhook endpoints and
credential metadata use sample data or local browser storage. Security alerts
are available at
`/dashboard/organization/security/alerts` with sample findings and browser-local
acknowledgements. The organization audit log at
`/dashboard/organization/security/audit-log` has searchable sample events and
redacted event details until server-side audit storage exists. Organization
connections are previewed at
`/dashboard/organization/integrations/connections`; the page shows connected services above a searchable catalog, with attention-needed
connections first and dialogs for account details and setup requirements. It uses
sample states and does not connect external accounts. Organization notification and
browser-data settings live at
`/dashboard/organization/settings/notifications-data`. Organization users and
roles are managed from `/dashboard/organization/team/users` and
`/dashboard/organization/team/roles`; both pages support search, sorting, and PostgreSQL-backed membership and role
management. Changes require the organization management permission.
The sidebar search opens with its button or Ctrl/Cmd+K and searches available pages,
organization details, and public contacts. Private contacts are excluded.

Profile settings use one form with organization, contact, and billing sections.
A sticky footer keeps Save changes and Cancel within reach.
Organization logos accept a public HTTPS image URL with a preview and removal.
Logo URLs use the same browser-local storage as other profile fields; existing
profiles without a logo remain valid. File uploads are tracked separately in CUP-31.
Profile edits remain drafts until Save changes is selected. Cancel restores the
saved values across all sections. Invalid edits show an error and are not saved.
Updates from another tab refresh untouched forms. If local edits conflict with
a newer saved profile, Cancel loads the latest version before editing continues.
Country and supported state or region fields use searchable source-owned
comboboxes instead of native browser menus. The country menu supports keyboard
navigation and common abbreviations such as USA and UK.

Profile settings are a browser-local prototype stored under
`cupboard:organization:local-preview:profile:v1:account:<account-id>:organization:<organization-id>`. Nothing is shared between
browsers or sent to a profile API. Private contacts are a field grouping, not an
access-control boundary: anyone using this browser profile can read them. Do not
use real confidential details until authentication and shared storage exist.
Notification choices are grouped into operational alerts and summaries, with
explicit Save changes and Cancel actions. They are browser-local and do not send
messages yet. The page does not provide browser-data clearing.
Profile, integration, notification, approval, and alert stores all
use account and organization namespaces. Switching organizations or accounts
discards unsaved drafts and cached previews; older unscoped data is not loaded
or automatically assigned to an organization.

User membership, invitations, roles, and permissions live in PostgreSQL. No
browser-local team settings are read or migrated. The account menu shows the
signed-in operator and supports logout; the organization menu switches between
active memberships.

## Accounts and roles

Open `/signup` to create an account. Organization membership and ownership are
optional: accounts can remain signed in with no memberships, create an organization
later, or join through an invitation. The regular dashboard sidebar remains
available without membership; its main area offers join-code entry and organization
creation. The join field accepts a code or the full invitation link. Creating an organization grants its Owner
role. Passwords require 8 to 128 Unicode characters, counted as code points
in the browser and scalar values in Rust, and are hashed with
Argon2id. `/login` creates a PostgreSQL-backed session with an absolute 12-hour
expiry. Logout deletes the session. A changed password hash invalidates existing
sessions. Password reset and email verification are not implemented yet.

New organizations have exactly two built-in roles: Owner and Administrator. Both
have every permission. Owner belongs exclusively to the recorded organization
owner and cannot be assigned, removed, or transferred through role management.
Administrator is one level below Owner. These built-in roles are fixed at the top
and their permissions cannot be edited.

Users can hold multiple roles; their permissions combine and their highest role
determines whom they can manage. Managers can assign and edit only roles below
their highest role, cannot grant permissions they lack, and cannot modify users
at or above their level or their own membership. Roles sort highest first by
default. Drag custom roles to reorder them, use Arrow Up/Down on the reorder
handle, or choose Move up/Move down in their menu. Order changes apply to existing
sessions immediately. Existing organizations retain their previous role
assignments; former Operator and Viewer defaults become custom roles.

Permissions for future server, moderation, billing, and integration features do
not make those features live.

Invite a user from Users, choose one or more roles, and copy the invitation link shown once.
Send it to the intended recipient yourself. Cupboard does not send email. Links
expire after seven days and are single-use; the backend stores only their SHA-256
hash. The recipient signs in or signs up with the invited email and accepts the
link. The token stays in the URL fragment, outside server request logs. Remove
an invited user to cancel the invitation. Remove and invite again if the link
was lost or expired.

The Rust API requires `CUPBOARD_WEB_ORIGINS`, a comma-separated list of exact web
origins. Every mutation also requires `X-Cupboard-Request: 1`. The web proxy rejects
cross-origin writes and forwards only the session cookie. Authenticated responses
are never shared-cached. `CUPBOARD_API_URL` sets the private Rust URL used by
Next.js. Sessions use HttpOnly, SameSite=Lax cookies and default to Secure.
`npm run dev` supplies local/NetBird origins and enables insecure cookies for
local HTTP. Production must use HTTPS and omit `CUPBOARD_INSECURE_COOKIES=1`.

Authentication allows ten attempts per email and 1,000 total attempts per
15-minute window, shared through PostgreSQL. Password hashing runs outside the
async executor with at most four concurrent jobs per Rust process. Expired
throttle buckets and sessions are pruned during authentication requests.

Security alert acknowledgements use
`cupboard:organization:local-preview:security-alerts:v1:account:<account-id>:organization:<organization-id>`. They update only the
sample alerts in the current browser and do not change a live server.

The approvals page at `/dashboard/organization/security/access` previews
sensitive-action approval rules. Its data stays in the current browser and does
not enforce approvals.

The sidebar remembers its expanded state in the `sidebar_state` cookie for
seven days, including across refreshes and visits to the login page.

## Rust server inventory

`/dashboard/servers` lists the active organization's saved Rust servers. Members
with `servers.view` can read connection addresses; `servers.manage` permits
adding a server and running **Test connection**. RCON passwords never appear in
API responses. Read-only health checks begin automatically after saving.

Test connection sends the read-only `serverinfo` command over Rust WebRCON and
an A2S_INFO UDP query, including the challenge exchange when required. Each
protocol has a five-second deadline. The latest result and check time are saved
in PostgreSQL and survive restarts. The inventory shows each protocol separately;
a successful result describes that check, not a guarantee that the server is still reachable.

Checks distinguish explicit authentication rejection, unreachable endpoints,
timeouts, invalid configuration, and unexpected protocol responses. A UDP timeout
cannot distinguish a stopped server from dropped firewall traffic. Raw protocol
responses and errors are never returned or stored. WebRCON must be enabled with
`rcon.web 1`; legacy Source RCON and split/compressed A2S responses are not
supported. WebRCON uses plain TCP, so use a trusted private network or encrypted
network tunnel between Cupboard and the server. Private and loopback destinations
are supported; unspecified, multicast, broadcast, and link-local addresses are
rejected.

At most four checks run at once per API process, and an advisory transaction lock
prevents concurrent checks of the same server across processes. A check requires
`servers.manage` in the record's organization. The organization authorization
lock is held through the bounded probes and result write, so membership changes
cannot race an authorized check.

Production requires `CUPBOARD_SECRET_KEY`, a cryptographically random 32-byte key
encoded as 64 hexadecimal characters. RCON passwords use AES-256-GCM with a
random nonce and authenticated organization/server identifiers. Keep the key
in your deployment secret store and preserve it across restarts and database
restores. Back up the key separately from the database. Key rotation requires
re-encrypting stored secrets before replacing the key. `npm run dev` creates a
worktree-specific key in ignored `.dev-stack/secret-key` with owner-only access.
Do not delete this file while retaining that worktree's database.

## Server health dashboard

`/dashboard` reads observations for the active organization with `servers.view`
permission. The Rust API runtime checks saved servers when observations are at
least 30 seconds old. Polling uses batches of 16 and two concurrent probes;
large inventories or timeouts may delay refreshes. The browser reloads saved
observations every 15 seconds and marks readings older than 90 seconds stale.
Refresh health reloads saved readings. Managers can use Test connection in the
inventory to request a new probe.

Healthy means both RCON and A2S responded. Degraded means only one responded.
Unavailable means neither responded successfully, which can include network or
configuration failures and does not prove the game server is stopped. Player
counts prefer RCON, with A2S as a fallback. A2S reports an eight-bit count, so use
RCON for servers with more than 255 players. Failed checks retain the last
successful count and its timestamp as last known players. Raw server payloads
and credentials never appear in health responses.

The poller runs in the existing Rust process and stops with it. PostgreSQL
advisory locks prevent simultaneous checks of a record across API instances and
manual requests. There is no health-history store or separate worker.

## File storage

The File store > Shared library page at `/dashboard/files` supports upload,
search, download, and confirmed deletion. It requires `organization.manage` for
all operations. Each file belongs to the active organization, and requests from
an outdated organization tab must refresh before accessing files. The first slice
accepts files up to 10 MiB, including empty files. Reusing a filename creates a
separate file; it never overwrites an existing object. Files download as private
attachments, with browser caching disabled. They are not scanned for malware or
served as public assets.

`npm run dev` starts SeaweedFS 4.48 alongside PostgreSQL. SeaweedFS uses one
container in `mini` mode with a worktree-owned persistent `storage` volume. Only
its S3 port is published, on loopback with an automatically selected port. The
launcher discovers it and supplies the Rust process with local credentials and
the pre-created `cupboard` bucket. S3 credentials never reach browser responses.
Set `CUPBOARD_S3_PORT` to choose a specific local S3 port. Ctrl+C leaves storage
running and preserves data; `npm run dev:stop-storage` stops this worktree's
storage container without removing its volume.

To use an existing S3 bucket, set `CUPBOARD_S3_BUCKET`. This skips local storage
startup. Configure the Rust runtime with these environment variables:

| Variable                                     | Purpose                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `CUPBOARD_S3_BUCKET`                         | Existing private bucket name. Cupboard does not create production buckets.               |
| `AWS_REGION`                                 | Bucket region, default `us-east-1`.                                                      |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Server-side credentials, or omit to use the client's workload identity credential chain. |
| `AWS_SESSION_TOKEN`                          | Optional temporary credential token.                                                     |
| `CUPBOARD_S3_ENDPOINT`                       | Optional S3-compatible service URL. Omit for AWS S3.                                     |
| `CUPBOARD_S3_ALLOW_HTTP`                     | Set to `1` only for a trusted local HTTP endpoint. HTTPS is the default.                 |

Grant the application `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` for
`organizations/*/files/*` inside the bucket. Keep public access blocked. Object
keys contain generated organization and file IDs; filenames stay in PostgreSQL.
Credentials and endpoints are configured on Rust, not as `NEXT_PUBLIC_*` values.
Use a dedicated bucket for each environment and preserve its association with the
database. Back up both the database and bucket. Configure bucket encryption and
retention policies for the deployed environment. Bucket versioning can retain
previous object versions after a delete; storage lifecycle policy owns their
expiration.

Uploads record their generated key before writing bytes and publish the file
only after S3 succeeds. Deletions first hide the file, then remove its object and
metadata. A provider failure leaves a retryable cleanup record. The Rust runtime
checks every ten minutes for unpublished records older than one hour, locks each
record, retries object deletion, and removes metadata only after deletion
succeeds. Failed cleanup records remain for the next pass. Do not delete metadata
manually before its objects are reclaimed. A failed deletion can disappear from
the library before physical cleanup finishes.

When storage is unconfigured, the rest of the application remains available;
file actions report unavailability. Invalid partial S3 configuration fails startup
without printing provider errors or credentials. Enabling storage in staging
requires configuring its bucket and credentials separately from this application
change.

`npm run check` starts disposable PostgreSQL and SeaweedFS containers, tests file
persistence and tenant isolation against S3, and removes only its test resources.
Docker is required even with `CUPBOARD_TEST_DATABASE_URL`. Direct Rust test runs
also need `CUPBOARD_TEST_S3_ENDPOINT` for an isolated SeaweedFS service using the
`storage-test` configuration. Quick checks do not start either service.
