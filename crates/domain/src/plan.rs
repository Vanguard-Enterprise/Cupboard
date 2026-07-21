//! The **plan catalog**: the code-defined source of truth for subscription tiers and
//! the one-off service catalog (Phase 6 decision I). Stripe is payment truth; this
//! module is gating/catalog truth: every limit the platform enforces (rate limiting,
//! key/domain caps) and every service card the UI shows reads from here, never from
//! Stripe metadata.
//!
//! Wire format is the stable string (`"team"`), which is what lands in the JWT `plan`
//! claim and the `org_plans` mirror. An **absent** plan (no subscription row, no claim)
//! always means [`Plan::Free`].

use serde::{Deserialize, Serialize};

/// A subscription tier. The string form (`as_str`) is the stable identifier.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Plan {
    /// The default tier (absence of a subscription).
    #[default]
    Free,
    Team,
    Enterprise,
}

/// The limits a plan entitles an organization to. Enforced at the gateway (rate) and
/// the owning services (keys, domains).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanLimits {
    /// API requests per minute (gateway rate limiter, decision N).
    pub rate_per_min: u32,
    /// Maximum live API keys per organization.
    pub max_api_keys: u32,
    /// Maximum custom storefront domains per organization.
    pub max_custom_domains: u32,
}

impl Plan {
    /// Every plan, in ascending-tier order.
    pub const ALL: &'static [Plan] = &[Plan::Free, Plan::Team, Plan::Enterprise];

    /// The stable wire/string identifier (`"free"`).
    pub const fn as_str(self) -> &'static str {
        match self {
            Plan::Free => "free",
            Plan::Team => "team",
            Plan::Enterprise => "enterprise",
        }
    }

    /// Parse a plan from its stable string form. Returns `None` for unknown strings.
    pub fn from_wire(s: &str) -> Option<Plan> {
        Plan::ALL.iter().copied().find(|p| p.as_str() == s)
    }

    /// Resolve an optional wire value (e.g. the JWT `plan` claim) to a plan. Absent or
    /// unknown values gate as [`Plan::Free`]: the safe floor, never an escalation.
    pub fn from_claim(claim: Option<&str>) -> Plan {
        claim.and_then(Plan::from_wire).unwrap_or(Plan::Free)
    }

    /// The limits table (decision N; figures resolved with Frank, 2026-07-13).
    pub const fn limits(self) -> PlanLimits {
        match self {
            Plan::Free => PlanLimits {
                rate_per_min: 60,
                max_api_keys: 1,
                max_custom_domains: 1,
            },
            Plan::Team => PlanLimits {
                rate_per_min: 300,
                max_api_keys: 5,
                max_custom_domains: 3,
            },
            Plan::Enterprise => PlanLimits {
                rate_per_min: 1000,
                max_api_keys: 20,
                max_custom_domains: 10,
            },
        }
    }
}

impl std::fmt::Display for Plan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A one-off purchasable service (Phase 6 decision I; Resolved with Frank #2). The
/// catalog is code-defined exactly like the plan table: Stripe is payment truth, this
/// is catalog/display truth (Stripe-price-driven catalogs were rejected). Purchase is
/// self-serve via Checkout (payment mode); fulfillment is manual/human, which the UI
/// card states.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServiceItem {
    /// Stable identifier, stored in `billing_purchases.service_key`.
    pub key: &'static str,
    /// Display name.
    pub name: &'static str,
    /// Short, honest description of what is being bought.
    pub description: &'static str,
    /// The env var (`STRIPE_PRICE_<SERVICE>` configmap pattern) that carries the
    /// Stripe price id this service checks out with.
    pub price_env: &'static str,
    /// Display price in minor units (code-defined truth; must match the Stripe price).
    pub price_amount: i64,
    /// ISO currency code (lowercase, the Stripe convention).
    pub currency: &'static str,
}

/// Every purchasable service. v1 sells Custom Design only ($250 one-time); migration
/// assistance is deferred per Frank.
pub const SERVICES: &[ServiceItem] = &[ServiceItem {
    key: "custom_design",
    name: "Custom Design",
    description: "A one-time professional design service: a custom look and layout \
                  for your community's storefront, delivered by a designer.",
    price_env: "STRIPE_PRICE_CUSTOM_DESIGN",
    price_amount: 25_000,
    currency: "usd",
}];

impl ServiceItem {
    /// Look a service up by its stable key. `None` for unknown keys.
    pub fn by_key(key: &str) -> Option<&'static ServiceItem> {
        SERVICES.iter().find(|s| s.key == key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_catalog_lookup() {
        let svc = ServiceItem::by_key("custom_design").expect("v1 sells custom design");
        assert_eq!(svc.name, "Custom Design");
        assert_eq!(svc.price_env, "STRIPE_PRICE_CUSTOM_DESIGN");
        assert_eq!((svc.price_amount, svc.currency), (25_000, "usd"));
        assert!(ServiceItem::by_key("gold_plating").is_none());
        // Keys are unique (the ledger's service_key must be unambiguous).
        for (i, a) in SERVICES.iter().enumerate() {
            assert!(SERVICES.iter().skip(i + 1).all(|b| b.key != a.key));
        }
    }

    #[test]
    fn wire_roundtrips_for_every_plan() {
        for p in Plan::ALL {
            assert_eq!(Plan::from_wire(p.as_str()), Some(*p));
        }
        assert_eq!(Plan::from_wire("platinum"), None);
    }

    #[test]
    fn absent_or_unknown_plan_is_free() {
        assert_eq!(Plan::from_claim(None), Plan::Free);
        assert_eq!(Plan::from_claim(Some("platinum")), Plan::Free);
        assert_eq!(Plan::from_claim(Some("enterprise")), Plan::Enterprise);
        assert_eq!(Plan::default(), Plan::Free);
    }

    #[test]
    fn limits_scale_monotonically_with_tier() {
        let (f, t, e) = (
            Plan::Free.limits(),
            Plan::Team.limits(),
            Plan::Enterprise.limits(),
        );
        assert_eq!(
            (f.rate_per_min, f.max_api_keys, f.max_custom_domains),
            (60, 1, 1)
        );
        assert_eq!(
            (t.rate_per_min, t.max_api_keys, t.max_custom_domains),
            (300, 5, 3)
        );
        assert_eq!(
            (e.rate_per_min, e.max_api_keys, e.max_custom_domains),
            (1000, 20, 10)
        );
        assert!(f.rate_per_min < t.rate_per_min && t.rate_per_min < e.rate_per_min);
    }
}
