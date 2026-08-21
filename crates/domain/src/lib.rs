//! Shared domain types and contracts used across Cupboard services.
//!
//! Kept deliberately dependency-light (serde + uuid only) so every service can
//! depend on it cheaply. Heavier concerns (JWT, hashing) live in `cupboard-auth-core`
//! and `cupboard-crypto`.

mod permission;
pub use permission::{Permission, RoleTemplate, DEFAULT_ROLE_TEMPLATES};

mod plan;
pub use plan::{Plan, PlanLimits, ServiceItem, SERVICES};

pub mod push;

pub mod events;
pub use events::{
    ChatEvent, EventSource, HookTiming, NamedTiming, NetworkUpdate, ObservedPlayer, PerfEvent,
    PerfTimings, PlayerPerf, ReportEvent, RosterEvent, SessionEdge, SessionEvent, TicketEvent,
    TicketEventKind, CHAT_STREAM, PERF_STREAM, REPORT_STREAM, ROSTER_STREAM, SESSION_STREAM,
    TICKET_STREAM,
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Defines an opaque, UUID-backed identifier newtype with `Display` and ergonomic
/// `From<Uuid>` / `Into<Uuid>` conversions. Serializes transparently as the inner UUID.
macro_rules! uuid_newtype {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        impl From<Uuid> for $name {
            fn from(id: Uuid) -> Self {
                Self(id)
            }
        }

        impl From<$name> for Uuid {
            fn from(id: $name) -> Uuid {
                id.0
            }
        }
    };
}

uuid_newtype! {
    /// Identifies a tenant (a server-network organization). Scopes all per-tenant data
    /// and drives row-level security (see `cupboard-db`). Equal to [`OrgId`] — the
    /// organization *is* the tenant; this is the name used on the RLS/data path.
    TenantId
}

uuid_newtype! {
    /// Identifies an organization (a tenant). Same underlying value as [`TenantId`];
    /// this is the name used on the auth/identity path. Convert with `TenantId::from`.
    OrgId
}

uuid_newtype! {
    /// The canonical, global Cupboard player identity (a surrogate key — *not* a Steam
    /// ID). See `docs/identity-schema.md`.
    PlayerId
}

uuid_newtype! {
    /// A game server connection owned by a tenant (Fleet). Scopes sessions/bans on the
    /// data path and identifies a server to the Collector.
    ServerId
}

uuid_newtype! {
    /// An identifier-level ban (Identity & Moderation). Per-tenant.
    BanId
}

uuid_newtype! {
    /// An operator/staff account that logs into the admin dashboard. Global — a single
    /// user may be a member of several organizations.
    UserId
}

uuid_newtype! {
    /// A user's membership in one organization (the join of [`UserId`] and [`OrgId`]).
    MembershipId
}

uuid_newtype! {
    /// A custom (or default-template) RBAC role within an organization.
    RoleId
}

uuid_newtype! {
    /// A pending staff invitation to an organization.
    InviteId
}

// The organization and the tenant are the same entity under two names; allow free
// conversion so the auth path (`OrgId`) can drive the RLS path (`TenantId`).
impl From<OrgId> for TenantId {
    fn from(org: OrgId) -> Self {
        TenantId(org.0)
    }
}

impl From<TenantId> for OrgId {
    fn from(tenant: TenantId) -> Self {
        OrgId(tenant.0)
    }
}
