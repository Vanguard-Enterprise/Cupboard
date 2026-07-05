//! Cupboard Tenant: commerce (external store providers — PayNow/Tebex) and white-label
//! sites (themes, config, hostname resolution, custom domains). Phase 5. The public
//! storefront (`apps/web`) renders through this service's `/public/*` surface; operators
//! manage their site and store through the JWT-gated `/sites/*` and `/store/*` surfaces.

pub mod cache;
pub mod config;
pub mod domain;
pub mod error;
pub mod http;
pub mod state;
