//! The RBAC **permission catalog** — the code-defined source of truth.
//!
//! Permissions are granular, per-area actions (Decision 32 in `ARCHITECTURE.md`).
//! Tenants compose them into custom roles; the auth service seeds a reference table
//! (`permission_catalog`) from this list at boot so the dashboard can list/group them
//! and `role_permissions.permission` can reference a known value.
//!
//! Wire format is the stable string (`"bans.create"`) — that's what lands in JWT
//! `perms` claims, the DB, and the API. Never renumber/rename a string without a
//! migration.

use serde::{Deserialize, Serialize};

/// A single grantable permission. The string form (`as_str`) is the stable identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Permission {
    /// Manage organization settings, deletion, and ownership transfer.
    OrgManage,
    /// Invite and remove staff members.
    StaffManage,
    /// Create and edit roles and their permission sets.
    RolesManage,
    /// View bans.
    BansView,
    /// Create bans.
    BansCreate,
    /// Revoke bans.
    BansRevoke,
    /// View player profiles (non-PII fields).
    PlayersView,
    /// View player personally-identifiable information (IPs, raw identifiers).
    PlayersViewPii,
    /// View the server roster and status.
    ServersView,
    /// Restart servers.
    ServersRestart,
    /// Add/configure/remove server connections.
    ServersManage,
    /// Manage the store integration and catalog.
    StoreManage,
    /// Respond to support tickets.
    SupportRespond,
    /// Edit the white-label site theme and content.
    SitesEdit,
    /// Manage the organization's Cupboard billing/subscription.
    BillingManage,
    /// Connect external services like BattleMetrics and manage import/sync.
    IntegrationsManage,
}

impl Permission {
    /// Every permission, in catalog order. Used to seed `permission_catalog` and to
    /// expand the Owner role.
    pub const ALL: &'static [Permission] = &[
        Permission::OrgManage,
        Permission::StaffManage,
        Permission::RolesManage,
        Permission::BansView,
        Permission::BansCreate,
        Permission::BansRevoke,
        Permission::PlayersView,
        Permission::PlayersViewPii,
        Permission::ServersView,
        Permission::ServersRestart,
        Permission::ServersManage,
        Permission::StoreManage,
        Permission::SupportRespond,
        Permission::SitesEdit,
        Permission::BillingManage,
        Permission::IntegrationsManage,
    ];

    /// The stable wire/string identifier (`"bans.create"`).
    pub const fn as_str(self) -> &'static str {
        match self {
            Permission::OrgManage => "org.manage",
            Permission::StaffManage => "staff.manage",
            Permission::RolesManage => "roles.manage",
            Permission::BansView => "bans.view",
            Permission::BansCreate => "bans.create",
            Permission::BansRevoke => "bans.revoke",
            Permission::PlayersView => "players.view",
            Permission::PlayersViewPii => "players.view_pii",
            Permission::ServersView => "servers.view",
            Permission::ServersRestart => "servers.restart",
            Permission::ServersManage => "servers.manage",
            Permission::StoreManage => "store.manage",
            Permission::SupportRespond => "support.respond",
            Permission::SitesEdit => "sites.edit",
            Permission::BillingManage => "billing.manage",
            Permission::IntegrationsManage => "integrations.manage",
        }
    }

    /// The area this permission groups under — the segment before the dot in its
    /// string form (`"bans"`, `"players"`, `"roles"`, …), for UI grouping.
    pub const fn area(self) -> &'static str {
        match self {
            Permission::OrgManage => "org",
            Permission::StaffManage => "staff",
            Permission::RolesManage => "roles",
            Permission::BansView | Permission::BansCreate | Permission::BansRevoke => "bans",
            Permission::PlayersView | Permission::PlayersViewPii => "players",
            Permission::ServersView | Permission::ServersRestart | Permission::ServersManage => {
                "servers"
            }
            Permission::StoreManage => "store",
            Permission::SupportRespond => "support",
            Permission::SitesEdit => "sites",
            Permission::BillingManage => "billing",
            Permission::IntegrationsManage => "integrations",
        }
    }

    /// A human-readable description for the catalog/UI.
    pub const fn description(self) -> &'static str {
        match self {
            Permission::OrgManage => "Manage organization settings, deletion, and transfer",
            Permission::StaffManage => "Invite and remove staff members",
            Permission::RolesManage => "Create and edit roles and permissions",
            Permission::BansView => "View bans",
            Permission::BansCreate => "Create bans",
            Permission::BansRevoke => "Revoke bans",
            Permission::PlayersView => "View player profiles",
            Permission::PlayersViewPii => "View player PII (IPs, raw identifiers)",
            Permission::ServersView => "View the server roster and status",
            Permission::ServersRestart => "Restart servers",
            Permission::ServersManage => "Add, configure, or remove server connections",
            Permission::StoreManage => "Manage the store integration and catalog",
            Permission::SupportRespond => "Respond to support tickets",
            Permission::SitesEdit => "Edit the white-label site",
            Permission::BillingManage => "Manage Cupboard billing and subscription",
            Permission::IntegrationsManage => {
                "Connect external services like BattleMetrics and manage import/sync"
            }
        }
    }

    /// Parse a permission from its stable string form. Returns `None` for unknown
    /// strings (e.g. a permission retired in a newer build).
    pub fn from_wire(s: &str) -> Option<Permission> {
        Permission::ALL.iter().copied().find(|p| p.as_str() == s)
    }
}

impl std::fmt::Display for Permission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A shipped default role: tenants get a per-org copy at organization creation, which
/// they may then clone/edit — except the immutable Owner (Decision 32).
#[derive(Debug, Clone, Copy)]
pub struct RoleTemplate {
    /// Display name, unique within an org.
    pub name: &'static str,
    /// Owner is immutable (always full access); the rest are editable starting points.
    pub immutable: bool,
    /// The permissions granted. Owner uses [`Permission::ALL`].
    pub permissions: &'static [Permission],
}

/// The default role templates instantiated for every new organization. The creator is
/// assigned **Owner**.
pub const DEFAULT_ROLE_TEMPLATES: &[RoleTemplate] = &[
    RoleTemplate {
        name: "Owner",
        immutable: true,
        permissions: Permission::ALL,
    },
    RoleTemplate {
        name: "Admin",
        immutable: false,
        // Everything except org-level management (deletion/transfer stays with Owner).
        permissions: &[
            Permission::StaffManage,
            Permission::RolesManage,
            Permission::BansView,
            Permission::BansCreate,
            Permission::BansRevoke,
            Permission::PlayersView,
            Permission::PlayersViewPii,
            Permission::ServersView,
            Permission::ServersRestart,
            Permission::ServersManage,
            Permission::StoreManage,
            Permission::SupportRespond,
            Permission::SitesEdit,
            Permission::BillingManage,
            Permission::IntegrationsManage,
        ],
    },
    RoleTemplate {
        name: "Moderator",
        immutable: false,
        permissions: &[
            Permission::BansView,
            Permission::BansCreate,
            Permission::BansRevoke,
            Permission::PlayersView,
            Permission::PlayersViewPii,
            Permission::ServersView,
            Permission::SupportRespond,
        ],
    },
    RoleTemplate {
        name: "Support",
        immutable: false,
        permissions: &[
            Permission::SupportRespond,
            Permission::PlayersView,
            Permission::BansView,
        ],
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_roundtrips_for_every_permission() {
        for p in Permission::ALL {
            assert_eq!(Permission::from_wire(p.as_str()), Some(*p));
            // area() must be the prefix of as_str().
            assert!(p.as_str().starts_with(p.area()));
        }
        assert_eq!(Permission::from_wire("nonsense.permission"), None);
    }

    #[test]
    fn owner_template_is_full_and_immutable() {
        let owner = DEFAULT_ROLE_TEMPLATES
            .iter()
            .find(|t| t.name == "Owner")
            .unwrap();
        assert!(owner.immutable);
        assert_eq!(owner.permissions.len(), Permission::ALL.len());
    }
}
