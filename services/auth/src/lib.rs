//! Cupboard Auth: operator accounts, sessions/JWT, tenant orgs, custom RBAC, staff
//! invites (Phase 1), and player (storefront customer) login via Steam OpenID with a
//! disjoint token keypair (Phase 5). The binary (`main.rs`) is a thin boot wrapper over
//! this library so integration tests can drive the real router + domain.

pub mod config;
pub mod domain;
pub mod error;
pub mod http;
pub mod privacy_worker;
pub mod retention_loop;
pub mod state;
