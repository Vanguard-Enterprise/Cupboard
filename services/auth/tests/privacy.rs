//! Integration tests for the Phase 7 privacy-job data layer (migration 0009 + 0010,
//! `domain::privacy`): the CHECK constraints on job shape, the exactly-once worker
//! claim, the stale-running crash-recovery reclaim, the dry-run/confirm status guard,
//! the one-time bundle download, and the `players.erase` Owner/Admin backfill against
//! a pre-existing org.
//!
//! Requires a Postgres reachable via `TEST_DATABASE_URL` (owner role; privacy_jobs is
//! owner-pool only). Skips (passes) when unset, so `cargo test` stays green where no
//! database is provisioned; CI sets it to run for real.

use chrono::{Duration, Utc};
use cupboard_auth::domain::privacy::{self, NewPrivacyJob};
use cupboard_auth::error::AppError;
use sqlx::PgPool;
use tokio::sync::OnceCell;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

// Tests run in parallel against one shared DB; migrate exactly once across them all.
static MIGRATED: OnceCell<()> = OnceCell::const_new();

// The claim primitive scans queued jobs globally, so every test here serializes on one
// lock: a sibling test's queued job would otherwise be claimed out from under it.
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Connect the owner pool and ensure the schema is migrated once. Returns `None`
/// (skip) when no test database is configured.
async fn setup() -> Option<PgPool> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let owner = cupboard_db::connect_scoped(&owner_url, 5, "auth,public")
        .await
        .expect("connect owner");
    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS auth")
                .execute(&owner)
                .await
                .expect("ensure schema");
            MIGRATOR.run(&owner).await.expect("migrate");
        })
        .await;
    Some(owner)
}

/// A well-formed platform-scope job naming the subject by steam id.
fn platform_job(kind: &str) -> NewPrivacyJob {
    NewPrivacyJob {
        kind: kind.into(),
        scope_kind: "platform".into(),
        tenant_id: None,
        steam_id: Some("76561198000000001".into()),
        discord_id: None,
        player_account_id: None,
        requested_by: Some(Uuid::new_v4()),
        requested_via: "runbook".into(),
    }
}

#[tokio::test]
async fn check_constraints_reject_bad_job_shapes() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP check_constraints_reject_bad_job_shapes: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;

    // The migration applied and a well-formed insert round-trips the defaults.
    let job = privacy::create_job(&owner, platform_job("export"))
        .await
        .expect("create well-formed job");
    assert_eq!(job.status, "queued");
    assert_eq!(job.scope_kind, "platform");
    assert!(job.dry_run_counts.is_none() && job.result_counts.is_none());

    let insert = |scope: &str, tenant: Option<Uuid>, steam: Option<&str>| {
        let owner = owner.clone();
        let (scope, steam) = (scope.to_string(), steam.map(str::to_string));
        async move {
            sqlx::query(
                "INSERT INTO privacy_jobs (kind, scope_kind, tenant_id, steam_id, requested_via) \
                 VALUES ('erase', $1, $2, $3, 'runbook')",
            )
            .bind(scope)
            .bind(tenant)
            .bind(steam)
            .execute(&owner)
            .await
        }
    };

    // A platform-scope job must not carry a tenant id.
    let err = insert("platform", Some(Uuid::new_v4()), Some("765611980000..."))
        .await
        .expect_err("platform job with tenant_id must be rejected");
    assert!(
        err.to_string().contains("privacy_jobs_tenant_scope"),
        "unexpected error: {err}"
    );

    // A tenant-scope job must carry one.
    let err = insert("tenant", None, Some("765611980000..."))
        .await
        .expect_err("tenant job without tenant_id must be rejected");
    assert!(err.to_string().contains("privacy_jobs_tenant_scope"));

    // At least one subject identifier is required.
    let err = insert("platform", None, None)
        .await
        .expect_err("job with no subject identifier must be rejected");
    assert!(err.to_string().contains("privacy_jobs_subject"));

    sqlx::query("DELETE FROM privacy_jobs WHERE id = $1")
        .bind(job.id)
        .execute(&owner)
        .await
        .expect("cleanup");
}

#[tokio::test]
async fn claim_next_queued_claims_exactly_once() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP claim_next_queued_claims_exactly_once: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;

    // Clear queued leftovers so the single job below is the only claimable row.
    sqlx::query("DELETE FROM privacy_jobs WHERE status = 'queued'")
        .execute(&owner)
        .await
        .expect("clear queue");
    let job = privacy::create_job(&owner, platform_job("erase"))
        .await
        .expect("create job");

    // Two concurrent claimers race for the one queued job: SKIP LOCKED must hand it to
    // exactly one of them.
    let (a, b) = tokio::join!(
        privacy::claim_next_queued(&owner),
        privacy::claim_next_queued(&owner)
    );
    let (a, b) = (a.expect("claim a"), b.expect("claim b"));
    let claimed: Vec<_> = [a, b].into_iter().flatten().collect();
    assert_eq!(claimed.len(), 1, "exactly one claimer must win");
    assert_eq!(claimed[0].id, job.id);
    assert_eq!(claimed[0].status, "running");
    assert!(claimed[0].updated_at >= job.updated_at);

    // Nothing left to claim.
    assert!(privacy::claim_next_queued(&owner)
        .await
        .expect("third claim")
        .is_none());
}

#[tokio::test]
async fn reclaim_stale_running_requeues_only_stale_jobs() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP reclaim_stale_running_requeues_only_stale_jobs: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;

    // Clear any running leftovers so the reclaim count below is deterministic.
    sqlx::query("DELETE FROM privacy_jobs WHERE status = 'running'")
        .execute(&owner)
        .await
        .expect("clear running");

    // Two running jobs: one crashed long ago (stale updated_at), one freshly claimed.
    let stale = privacy::create_job(&owner, platform_job("erase"))
        .await
        .expect("create stale job");
    let fresh = privacy::create_job(&owner, platform_job("export"))
        .await
        .expect("create fresh job");
    sqlx::query("UPDATE privacy_jobs SET status = 'running' WHERE id IN ($1, $2)")
        .bind(stale.id)
        .bind(fresh.id)
        .execute(&owner)
        .await
        .expect("mark running");
    sqlx::query("UPDATE privacy_jobs SET updated_at = now() - interval '2 hours' WHERE id = $1")
        .bind(stale.id)
        .execute(&owner)
        .await
        .expect("backdate stale job");

    let reclaimed = privacy::reclaim_stale_running(&owner, Duration::minutes(30))
        .await
        .expect("reclaim");
    assert_eq!(reclaimed, 1, "exactly the stale job is reclaimed");
    let stale_after = privacy::get_job(&owner, stale.id)
        .await
        .expect("get")
        .expect("stale job exists");
    assert_eq!(
        stale_after.status, "queued",
        "a stale running job is requeued (idempotent walkers make a re-run safe)"
    );
    let fresh_after = privacy::get_job(&owner, fresh.id)
        .await
        .expect("get")
        .expect("fresh job exists");
    assert_eq!(
        fresh_after.status, "running",
        "a fresh running job must NOT be reclaimed"
    );

    sqlx::query("DELETE FROM privacy_jobs WHERE id IN ($1, $2)")
        .bind(stale.id)
        .bind(fresh.id)
        .execute(&owner)
        .await
        .expect("cleanup");
}

#[tokio::test]
async fn dry_run_confirm_flow_guards_status() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP dry_run_confirm_flow_guards_status: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;

    let job = privacy::create_job(&owner, platform_job("erase"))
        .await
        .expect("create job");
    let counts = serde_json::json!({ "identity": { "player_identifiers": 3 } });
    privacy::store_dry_run(&owner, job.id, &counts)
        .await
        .expect("store dry run");
    let parked = privacy::get_job(&owner, job.id)
        .await
        .expect("get")
        .expect("job exists");
    assert_eq!(parked.status, "awaiting_confirm");
    assert_eq!(parked.dry_run_counts.as_ref(), Some(&counts));

    // Only awaiting_confirm rows confirm; a second confirm is a conflict, an unknown
    // id a not-found.
    privacy::confirm_job(&owner, job.id).await.expect("confirm");
    let queued = privacy::get_job(&owner, job.id)
        .await
        .expect("get")
        .expect("job exists");
    assert_eq!(queued.status, "queued");
    let err = privacy::confirm_job(&owner, job.id)
        .await
        .expect_err("re-confirming a queued job must refuse");
    assert!(matches!(err, AppError::Conflict(_)), "got: {err:?}");
    let err = privacy::confirm_job(&owner, Uuid::new_v4())
        .await
        .expect_err("confirming an unknown job must refuse");
    assert!(matches!(err, AppError::NotFound(_)));

    // Terminal transitions + the requester-filtered listing.
    privacy::fail_job(&owner, job.id, "identity walker unreachable")
        .await
        .expect("fail");
    let failed = privacy::get_job(&owner, job.id)
        .await
        .expect("get")
        .expect("job exists");
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.error.as_deref(), Some("identity walker unreachable"));
    let results = serde_json::json!({ "auth": { "player_identities": 2 } });
    privacy::finish_job(&owner, job.id, &results)
        .await
        .expect("finish");
    let done = privacy::get_job(&owner, job.id)
        .await
        .expect("get")
        .expect("job exists");
    assert_eq!(done.status, "completed");
    assert_eq!(done.result_counts.as_ref(), Some(&results));
    let err = privacy::finish_job(&owner, Uuid::new_v4(), &results)
        .await
        .expect_err("finishing an unknown job must refuse");
    assert!(matches!(err, AppError::NotFound(_)));

    let listed = privacy::list_jobs(&owner, job.requested_by, 10)
        .await
        .expect("list");
    assert_eq!(listed.len(), 1, "requester filter must scope the listing");
    assert_eq!(listed[0].id, job.id);

    sqlx::query("DELETE FROM privacy_jobs WHERE id = $1")
        .bind(job.id)
        .execute(&owner)
        .await
        .expect("cleanup");
}

#[tokio::test]
async fn take_bundle_once_returns_bytes_exactly_once() {
    let Some(owner) = setup().await else {
        eprintln!("SKIP take_bundle_once_returns_bytes_exactly_once: TEST_DATABASE_URL unset");
        return;
    };
    let _guard = LOCK.lock().await;

    let job = privacy::create_job(&owner, platform_job("export"))
        .await
        .expect("create job");
    let bytes = b"gzip-bundle-bytes".to_vec();
    privacy::store_bundle(&owner, job.id, &bytes, Utc::now() + Duration::days(7))
        .await
        .expect("store bundle");

    // First take returns the bytes and burns them; the second gets nothing.
    let taken = privacy::take_bundle_once(&owner, job.id)
        .await
        .expect("first take");
    assert_eq!(taken.as_deref(), Some(bytes.as_slice()));
    assert!(privacy::take_bundle_once(&owner, job.id)
        .await
        .expect("second take")
        .is_none());
    let downloaded = privacy::get_job(&owner, job.id)
        .await
        .expect("get")
        .expect("job exists");
    assert!(downloaded.downloaded_at.is_some());

    // An expired bundle is never handed out, even though the bytes are still stored.
    privacy::store_bundle(&owner, job.id, &bytes, Utc::now() - Duration::hours(1))
        .await
        .expect("store expired bundle");
    assert!(privacy::take_bundle_once(&owner, job.id)
        .await
        .expect("expired take")
        .is_none());

    sqlx::query("DELETE FROM privacy_jobs WHERE id = $1")
        .bind(job.id)
        .execute(&owner)
        .await
        .expect("cleanup");
}

#[tokio::test]
async fn players_erase_backfill_grants_existing_owner_and_admin_roles() {
    let Some(owner) = setup().await else {
        eprintln!(
            "SKIP players_erase_backfill_grants_existing_owner_and_admin_roles: \
             TEST_DATABASE_URL unset"
        );
        return;
    };
    let _guard = LOCK.lock().await;

    // An org that predates the deploy: its roles were materialized from the OLD
    // templates, so none carry players.erase yet.
    let org_id: Uuid = sqlx::query_scalar(
        "INSERT INTO organizations (name, slug) \
         VALUES ('Backfill Org', 'pb-'||gen_random_uuid()) RETURNING id",
    )
    .fetch_one(&owner)
    .await
    .expect("insert org");
    let role = |name: &'static str, immutable: bool| {
        let owner = owner.clone();
        async move {
            sqlx::query_scalar::<_, Uuid>(
                "INSERT INTO roles (organization_id, name, immutable) \
                 VALUES ($1, $2, $3) RETURNING id",
            )
            .bind(org_id)
            .bind(name)
            .bind(immutable)
            .fetch_one(&owner)
            .await
            .expect("insert role")
        }
    };
    let owner_role = role("Owner", true).await;
    let admin_role = role("Admin", false).await;
    let mod_role = role("Moderator", false).await;

    // Re-run the actual migration file against the now-populated org (its statements
    // are idempotent upserts, so replaying is exactly the deploy-time behavior).
    sqlx::raw_sql(include_str!(
        "../migrations/0010_backfill_players_erase.sql"
    ))
    .execute(&owner)
    .await
    .expect("replay backfill");

    let granted: Vec<Uuid> = sqlx::query_scalar(
        "SELECT role_id FROM role_permissions \
         WHERE organization_id = $1 AND permission = 'players.erase'",
    )
    .bind(org_id)
    .fetch_all(&owner)
    .await
    .expect("read grants");
    assert!(granted.contains(&owner_role), "Owner must be backfilled");
    assert!(granted.contains(&admin_role), "Admin must be backfilled");
    assert!(
        !granted.contains(&mod_role),
        "Moderator must NOT be backfilled"
    );

    // The catalog row exists (FK target for the grants above and the roles UI).
    let area: String = sqlx::query_scalar(
        "SELECT area FROM permission_catalog WHERE permission = 'players.erase'",
    )
    .fetch_one(&owner)
    .await
    .expect("catalog row");
    assert_eq!(area, "players");
}
