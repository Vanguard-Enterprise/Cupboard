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
single-application default. The Rust runtime uses Axum, Tokio, and SQLx. Cupboard
will own accounts and sessions using maintained authentication primitives, with
no external identity
provider. Production will run in the USE1 Kubernetes cluster, with PostgreSQL in
the cluster and Argo CD deployment from `v-deployments`. CUP-45 moves CI to the organization's `ve-runner` self-hosted Linux x64
runners. Full checks and cached release builds run concurrently, with the existing
required check gating both before publication. Fork pull requests do not run on
these Docker-privileged workers. Remote caches survive ephemeral runner recreation
and nightly maintenance eviction; runner availability is now a CI dependency. The root Cargo package keeps all Rust code in `backend/`.

CUP-2 adds the runtime, database connection and migration execution, health checks,
container build, and combined root development and check commands. CUP-27 adds sign-in, account creation, revocable sessions, tenant membership, and
role management. Signup creates only an account; organization membership and
ownership are optional. Accounts with no memberships retain access to their account
workspace within the regular dashboard sidebar and header. Its main area offers
join-code entry and optional organization creation. They can create an organization
as Owner or join one through an invitation.
Existing Users and Roles pages now read and write PostgreSQL through Rust.
New organizations start with only Owner and Administrator, both with full
permissions. Ownership is exclusive; Administrator ranks below Owner. Memberships
support multiple roles, and persisted role order bounds management of lower roles
and users. Custom roles can be reordered by drag, keyboard, or menu actions. Other
settings retain their documented browser-local behavior, with storage scoped
to the signed-in account and active organization. Organization changes discard
drafts and cached previews. Legacy unscoped records are not imported.

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
persists a local preview in browser storage because the profile API is not implemented. Public and private contact
fields are separate; general search indexes only public fields. This preview is not tenant-authorized storage
and must not hold confidential production contacts. Shared persistence must add
server-side membership checks before replacing the preview. Organization search
currently covers only implemented pages and locally saved profile information.
The billing and usage page at `/dashboard/organization/settings/usage` shows
resource capacity and activity charts with fixed design data, explicit date ranges,
calculated totals, and an accessible daily table. Its billing details read the
scoped browser-local organization profile and link back to its billing fields.
It does not meter activity, enforce limits, or connect to a billing provider.
The credentials and webhooks page at
`/dashboard/organization/integrations/credentials` is also a browser-local
preview. It stores credential metadata and webhook configuration under a local
organization key. Generated credential secrets appear once and are never written
to browser storage. Shared persistence must add server-side membership checks,
secret hashing, and encrypted webhook signing secrets before production use.
The security alerts page at `/dashboard/organization/security/alerts` previews
sample findings and stores acknowledgement state in the browser. It does not scan
servers or change their configuration.
The organization audit log at
`/dashboard/organization/security/audit-log` previews search, filtering, and event
details with labeled sample data. It does not record user or server activity. The
organization connections page at
`/dashboard/organization/integrations/connections` supports a PostgreSQL-backed
Pelican Client API connection, verified server inventory, and secure disconnect.
Other catalog services show requirements without connecting external accounts. The organization notifications
and data page at
`/dashboard/organization/settings/notifications-data` stores notification choices
in the current browser. Browser-data clearing was removed from this page.
It does not send notifications or delete shared server data.
The approvals page at `/dashboard/organization/security/access` previews
sensitive-action approval rules in local browser storage. The Members & teams pages at
`/dashboard/organization/team/users` and `/dashboard/organization/team/roles`
now enforce tenant ownership and organization management permission in Rust.
Invitations use expiring, single-use links shown once for manual sharing. Email
delivery, email verification, and password recovery are still outside this slice.
Sensitive-action approval rules remain a separate browser preview and do not
control backend role enforcement.

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

## Development isolation

CUP-34 makes each development worktree own a persistent Compose PostgreSQL
volume, saved web/API ports, and a dev-process lock. Concurrent agent work must
not reuse another task's database or stop its processes. Disposable check
containers remain separate from development data. `docs/WORKFLOW.md` records
the worktree, doctor, quick-check, and PR-feedback commands. These are local
workflow tools and do not change the production runtime or launch scope.

## Rules for adding complexity

A new process, package, data store, queue, or protocol needs a short note in this
file that names the current problem it solves. The Next.js runtime exists because
the product requires server rendering and server-side API requests. Expected
future scale is not enough reason for another process.

Code generators may create a starting point, but generated code receives the same
review and test requirements as handwritten code. If nobody can explain why a
module exists, remove it.

CUP-5 adds PostgreSQL-backed Rust server inventory and creation through the
existing authenticated API. Each record belongs to one organization and uses
server permissions. RCON passwords use AES-256-GCM with an environment-supplied
key and record-bound authenticated data. Local development saves its own key
next to the worktree configuration. CUP-6 adds an operator-triggered connection check in the existing Rust runtime.
WebRCON and A2S probes run concurrently with five-second deadlines, and PostgreSQL
stores separate protocol outcomes and their check time. The inventory exposes
the action to server managers and saved results to server viewers. This does not
add polling, health history, a worker, or a console command interface.

CUP-8 adds the server health dashboard and retains player counts from the existing
RCON/A2S probes. The Rust API process polls due records in bounded batches,
sharing PostgreSQL advisory locks with manual checks. No new runtime is needed.
The browser reads saved, tenant-authorized observations and marks old or failed
refreshes stale. PostgreSQL retains the latest protocol outcomes and last useful
player count with its source and observation time; historical telemetry remains
outside this slice.

CUP-7 packages the existing Next.js runtime as a standalone container and publishes
both runtime images after main-branch CI and release smoke checks pass. USE1
staging uses a fresh CloudNativePG database in `cupboard-rebuild`, the existing
internal Traefik ingress, and OpenBao through External Secrets. This adds no
application runtime or service beyond the selected web/API/PostgreSQL shape.
Deployment manifests live in `v-deployments`; old Cupboard overlays are not used.
Both images are pinned to one commit's release tags. The smoke check verifies the
containerized proxy and persisted account, tenant, server, and health data across
runtime restarts, including tenant isolation and secret redaction.

CUP-43 adds organization-scoped machine inventory and agent health at
`/dashboard/infrastructure/machines`. Infrastructure has separate viewing and
management permissions. Machine edits use revisions to detect conflicting saves.
Operators issue ten-minute, single-use enrollment tokens. The agent exchanges a
token for a credential that can only submit health for its assigned machine.
PostgreSQL stores token and credential hashes, never their plaintext. Replacing
an agent revokes its previous credential; disconnecting also cancels pending
enrollment and clears readings while retaining the inventory record.

The Linux agent is a downloadable Python 3.10+ standard-library script. This
adds a process on each managed host because Cupboard cannot read remote host
memory, uptime, or disk capacity from its application runtime. It sends outbound
HTTPS reports every 30 seconds, verifies certificates, refuses redirects, and
stores its credential in a private file. No new central service or worker is
introduced. Reports include hostname, OS, logical CPU count, one-minute load,
memory, root-disk capacity, uptime, and agent version. Readings become stale after
90 seconds without a report. Current readings and one hour of resource history are retained. Remote commands,
software installation, Windows hosts, and longer-term host telemetry are outside
this slice. A machine connection reports agent reachability, not game-server
health. The agent setup guide includes an optional systemd user service.

Machine inventory includes status indicators, country flags, and current CPU,
memory, and root-disk usage bars. Agent 1.1 adds optional CPU utilization and
public-IP country fields to the existing health JSON, so older agents remain
accepted. The agent resolves its own outbound IP through IPWhois over HTTPS,
caching for one hour; failure leaves country unknown. No additional service or browser geolocation request is introduced.

Machine details now retain up to 120 timestamped CPU, memory, and root-disk samples
in a bounded JSON column on each machine. Heartbeats replace the current 30-second
bucket, evict samples older than one hour, and cap storage at 120 samples.
History reads filter expired samples even while an agent is offline. The detail
history endpoint enforces infrastructure viewing permission and tenant ownership;
inventory responses do not include history. Disconnect and replacement clear it.
Charts show real samples, with no backfill. Agent 1.2 adds optional network
receive/send rates from Linux interface counters, averaged between reports and
excluding loopback. Counter resets or interface changes leave one interval unknown.
Older agents and stored samples remain valid. Details use circular capacity meters
and a configuration dialog; no new service or migration is needed.

Machine location comes from the agent’s public-IP country lookup. A forward-only
migration removes the former manually entered location column; create/update
contracts no longer accept location. Details and the country flag share the same
reported country, with no new lookup service.

Machine creation now uses a dedicated resumable setup route. User/organization-
scoped browser storage preserves unfinished non-secret details; after creation,
the existing machine record and enrollment fields are the persistent setup state.
No extra service or draft table is required. Raw enrollment tokens remain ephemeral.

Machine address validation now requires a standard IPv4 or IPv6 literal instead
of the shared server hostname validator. Existing stored addresses are not
guessed or rewritten; subsequent edits must supply a valid IP.
CUP-42 adds the organization file library at `/dashboard/files`. PostgreSQL holds
file metadata and S3 holds private file contents. This is a new external storage
dependency because file payloads need durable object storage, including the later
logo-upload slice. The Rust application owns all storage requests and cleanup;
there is no new application service or worker. The file library allows organization
managers to upload, download, and delete files up to 10 MiB, create nested folders,
rename entries, copy folders and files, and move them through cut/paste. Folder
relationships live in PostgreSQL; moves do not rename S3 keys. Copies receive
independent S3 objects. Uploads and copies use a 45-second deadline and perform
object-store I/O outside database transactions. Copies transfer up to four objects
at once, then reauthorize and validate source and destination before publication.
Deletion returns after durably hiding the subtree; bounded background cleanup and
the existing retry loop remove physical objects. File metadata mutations serialize per organization to prevent
concurrent folder cycles and inconsistent recursive operations. All organization file management checks active membership and management
permission beside tenant-scoped data access. File
requests carry the page's organization ID so a stale browser tab cannot upload
into a newly selected organization.

Local development uses pinned SeaweedFS in its single-process `mini` mode, started
by the root dev command with a separate persistent volume per worktree. Production
uses an existing private S3 bucket and environment-provided credentials or workload
identity. S3 configuration is optional for existing deployments; unconfigured file
actions return an unavailable response. Local and disposable check storage use the
same S3 client as production. Interrupted uploads and deletions retain metadata
for retrying cleanup in the existing Rust runtime.

Organization links retain membership and management checks. Managers can also
create public download links for individual files with 1, 7, or 30-day expiry.
Only token hashes are stored. Replacing or revoking a link invalidates its token.
Public link tokens stay in URL fragments and reach the API in POST bodies rather
than request URLs. Public downloads are authorized by the token and served as
attachments; they do not require membership. Folder sharing uses organization
links. Versions, per-file member permissions, public folder downloads, large
multipart uploads, and content scanning remain outside this slice. Files download as attachments. Grid cards render authenticated raster image
previews after checking PNG, JPEG, GIF, or WebP signatures; active content is not
rendered inline. Organization logo uploads are implemented by CUP-31.

CUP-44 isolates development browser sessions by assigning a stable cookie name per
worktree at the Next.js boundary. Root dev supplies the same name to proxy and
server-rendered identity reads. Rust retains its canonical session cookie name,
and production retains its existing default. This prevents parallel local apps
on one host from overwriting each other's login cookies across ports.

CUP-31 adds shared organization logos using the existing private S3 bucket and
Rust runtime. PostgreSQL stores tenant-owned metadata and a revision for conflict
detection. Raster uploads accept PNG, JPEG, WebP, GIF, BMP, ICO, and TIFF within
2 MiB, 8192 pixels per side, and 16 megapixels. A restricted SVG path accepts
self-contained shapes within 256 KiB, with XML size/depth limits and no scripts,
external resources, fonts, embedded images, filters, or reusable subtrees.
Both preview and save decode off the async executor and return only metadata-free,
compressed PNG pixels, downscaled to at most 160 pixels on the longest side.
Management permission is rechecked before publication; active members can read
the current image. Save publishes a replacement or removal, while Cancel discards
selections. The organization switcher shows the saved logo and refreshes on updates.
Manual logo URLs are removed; other profile fields remain browser-local.
Replacement cleanup and abandoned uploads use the existing storage cleanup loop.
No additional runtime, worker, bucket, or credentials are introduced.

CUP-47 makes Pelican connections functional inside the existing Rust runtime. One
connection per organization stores its HTTPS origin, AES-256-GCM encrypted Client
API key, last check outcome, and a bounded server inventory in PostgreSQL. Only
active members with `integrations.manage` can read or change it. Every request
includes the page organization; connection IDs and revisions reject stale edits
and checks. Network I/O runs outside database transactions, with membership and
revision checks repeated before publication. Secrets share the existing master
key while using a separate authenticated-data purpose from RCON.

Checks read `/api/client` with at most ten pages and 1,000 servers, a 15-second
overall deadline, and a 2 MiB response limit per page. They retain only identifiers,
names, nodes, and panel lifecycle flags, never startup commands or variables.
Redirects, environment proxies, untrusted TLS, and unsafe destination addresses
are rejected. DNS results are validated and pinned for each check. Operators may
approve exact private HTTPS panel origins with `CUPBOARD_PELICAN_PRIVATE_ORIGINS`;
loopback and link-local destinations remain blocked. Failed refreshes preserve
the last verified inventory; checks older than five minutes show overdue status.
Inventory is not live game-server health. Other providers remain outside this
slice. No additional application process or worker is introduced.

Pelican inventory checks run in the API every five minutes, including while the
Connections page is closed. PostgreSQL stores the schedule and claims each due
connection across replicas. Failed checks retain the last verified inventory;
concurrent edits and disconnects take precedence over scheduled results. The page
refreshes saved results every 30 seconds and keeps a manual check action.

Local development has an explicit `npm run dev:seed` fixture command. Each
worktree owns a gitignored account file and a separate fake organization, with
stable IDs and repeatable team fixtures. Seeding verifies the worktree's managed
Compose database, rejects external database overrides, and preserves other data.
The fixture module is excluded from release builds; there is no seed endpoint.

CUP-49 adds Rust-only imports from Pelican into the existing Servers inventory.
Imports verify the current startup invocation or Rust egg, retain a scoped panel
link, and deduplicate by organization, connection, and upstream UUID. Structured
egg variables can supply encrypted RCON and A2S settings; missing settings do not
prevent panel management. Manual servers keep their existing behavior.

Imported servers expose live resource observations, recent console output, console
commands, and start, stop, and restart. Viewers need `servers.view`; mutations
need `servers.manage`, and importing also needs `integrations.manage`. Every
request checks the page organization and reauthorizes after upstream I/O. Removing
a connection disables its imported servers' panel controls. WebSocket credentials
stay in the API, which validates and pins Wings destinations and redacts known
secrets from console output. Resources refresh every 30 seconds; console snapshots
refresh every eight seconds while their tab is open. No worker is added.

CUP-52 seeds a scoped infrastructure machine for the real development Wings host.
Each managed worktree owns its machine credential and database record. A single
repository-wide development reporter collects measurements from the source-owned
agent over verified SSH and sends them to the prepared local APIs. The reporter
runs with the development stack and uses no application or production credentials
on Wings. Offline development applications receive measurements when restarted.
All-worktree seeding preserves existing data and running applications; production
builds still exclude the seed module and retain the agent's HTTPS requirement.

CUP-53 adds organization-owned infrastructure tags and per-machine assignments.
Infrastructure viewers can read labels; infrastructure managers can create,
rename, delete, and assign them. Catalog writes serialize within each organization;
assignment writes check the machine revision. Deletion removes assignments in the
same transaction. Tags describe operator-assigned roles rather than software
detection. Inventory network graphs now show at most five minutes of real samples.

Imported server identity includes the panel origin as well as the organization
and upstream UUID. After disconnect, controls stay disabled. Explicitly importing
from a reconnected same-origin panel restores the original Cupboard server record
without duplicates; different panel origins remain separate.

Pelican scheduling drains due work in batches of three before sleeping when idle.
Inventory resources also refresh with three workers, so one slow server does not
block later rows. Background work reserves one shared slot for interactive
requests. Candidate imported-state lookup uses one scoped database query
for the complete bounded candidate set.
