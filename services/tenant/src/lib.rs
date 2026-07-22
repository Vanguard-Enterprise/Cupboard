//! Cupboard Tenant: commerce (external store providers: PayNow/Tebex), white-label
//! sites (themes, config, hostname resolution, custom domains), and platform billing
//! (Stripe subscriptions, Phase 6). The public storefront (`apps/web`) renders through
//! this service's `/public/*` surface; operators manage their site, store, and
//! subscription through the JWT-gated `/sites/*`, `/store/*`, and `/billing/*` surfaces.

pub mod billing_loop;
pub mod cache;
pub mod certmgr;
pub mod config;
pub mod domain;
pub mod domains_loop;
pub mod error;
pub mod http;
pub mod providers;
pub mod retention_loop;
pub mod state;
pub mod store;
pub mod stripe;
