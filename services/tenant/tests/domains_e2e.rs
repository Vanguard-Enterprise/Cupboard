//! End-to-end for PR5: the custom-domain state machine (via a stub provisioner) and
//! resolution of an active custom domain to its site. Requires TEST_DATABASE_URL(_APP);
//! skips when unset.

use cupboard_tenant::cache::SiteCache;
use cupboard_tenant::certmgr::{CertProvisioner, DomainSpec, ProvisionError};
use cupboard_tenant::domain::domains;
use cupboard_tenant::domains_loop::{process_domain, DomainsConfig};
use sqlx::PgPool;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tokio::sync::OnceCell;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();

async fn setup() -> Option<(PgPool, PgPool)> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let app_url = std::env::var("TEST_DATABASE_URL_APP").unwrap_or_else(|_| owner_url.clone());
    let owner = cupboard_db::connect_scoped(&owner_url, 5, "tenant,public")
        .await
        .expect("owner");
    let app = cupboard_db::connect_scoped(&app_url, 5, "tenant,public")
        .await
        .expect("app");
    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS tenant")
                .execute(&owner)
                .await
                .expect("schema");
            MIGRATOR.run(&owner).await.expect("migrate");
        })
        .await;
    Some((owner, app))
}

/// A stub provisioner that records calls and reports the cert as ready only once armed.
#[derive(Default)]
struct StubProvisioner {
    ensured: Mutex<Vec<String>>,
    torn_down: Mutex<Vec<String>>,
    ready: AtomicBool,
}

impl CertProvisioner for StubProvisioner {
    async fn ensure(&self, spec: &DomainSpec) -> Result<(), ProvisionError> {
        self.ensured.lock().unwrap().push(spec.domain.clone());
        Ok(())
    }
    async fn certificate_ready(&self, _cert_name: &str) -> Result<bool, ProvisionError> {
        Ok(self.ready.load(Ordering::Relaxed))
    }
    async fn teardown(&self, spec: &DomainSpec) -> Result<(), ProvisionError> {
        self.torn_down.lock().unwrap().push(spec.domain.clone());
        Ok(())
    }
}

fn config() -> DomainsConfig {
    DomainsConfig {
        edge_ips: vec![],
        sites_suffix: "sites.test".into(),
    }
}

/// Load a domain row by id directly (not via claim_due, which only returns DUE rows;
/// transitions push next_check_at into the future).
async fn load(owner: &PgPool, id: Uuid) -> domains::SiteDomain {
    sqlx::query_as::<_, domains::SiteDomain>(
        "SELECT id, tenant_id, site_id, domain, status, cert_secret_name, \
                ingressroute_name, last_checked_at, last_error, attempt_count, \
                next_check_at, created_at, updated_at \
         FROM site_domains WHERE id = $1",
    )
    .bind(id)
    .fetch_one(owner)
    .await
    .expect("domain present")
}

#[tokio::test]
async fn domain_lifecycle_dns_issue_active_and_resolve() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP domain_lifecycle_dns_issue_active_and_resolve: TEST_DATABASE_URL unset");
        return;
    };
    let tenant = Uuid::new_v4();
    let slug = format!("dm{}", &Uuid::new_v4().simple().to_string()[..8]);
    sqlx::query("INSERT INTO sites (tenant_id, slug) VALUES ($1, $2)")
        .bind(tenant)
        .bind(&slug)
        .execute(&owner)
        .await
        .unwrap();
    let domain = format!(
        "store-{}.example.gg",
        &Uuid::new_v4().simple().to_string()[..8]
    );
    let row = domains::add_domain(&app, cupboard_domain::TenantId(tenant), &domain)
        .await
        .expect("add domain");
    assert_eq!(row.status, "pending_dns");

    let prov = StubProvisioner::default();
    let cache = SiteCache::disabled();
    let cfg = config();

    // DNS not pointing at us yet -> failed_dns.
    let d = load(&owner, row.id).await;
    process_domain(&owner, &prov, &cache, &d, false, &cfg).await;
    let d = load(&owner, row.id).await;
    assert_eq!(d.status, "failed_dns");
    assert!(prov.ensured.lock().unwrap().is_empty());

    // DNS now points at us -> ensure() + issuing.
    process_domain(&owner, &prov, &cache, &d, true, &cfg).await;
    let d = load(&owner, row.id).await;
    assert_eq!(d.status, "issuing");
    assert_eq!(prov.ensured.lock().unwrap().len(), 1);

    // Cert not ready yet -> stays issuing.
    process_domain(&owner, &prov, &cache, &d, false, &cfg).await;
    let d = load(&owner, row.id).await;
    assert_eq!(d.status, "issuing");

    // Cert becomes ready -> active, and the domain now resolves to the site.
    prov.ready.store(true, Ordering::Relaxed);
    process_domain(&owner, &prov, &cache, &d, false, &cfg).await;
    let d = load(&owner, row.id).await;
    assert_eq!(d.status, "active");

    let resolved = domains::resolve_by_domain(&owner, &domain)
        .await
        .unwrap()
        .expect("active domain resolves");
    assert_eq!(resolved.tenant_id, tenant);
    assert_eq!(resolved.slug, slug);

    // Disable -> teardown + row deleted; no longer resolves.
    domains::remove_domain(&app, cupboard_domain::TenantId(tenant), row.id)
        .await
        .unwrap();
    let d = load(&owner, row.id).await;
    assert_eq!(d.status, "disabled");
    process_domain(&owner, &prov, &cache, &d, false, &cfg).await;
    assert_eq!(prov.torn_down.lock().unwrap().len(), 1);
    assert!(domains::resolve_by_domain(&owner, &domain)
        .await
        .unwrap()
        .is_none());
    let gone: i64 = sqlx::query_scalar("SELECT count(*) FROM site_domains WHERE id = $1")
        .bind(row.id)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(gone, 0, "disabled domain row is deleted after teardown");
}

#[tokio::test]
async fn domain_cap_and_isolation() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP domain_cap_and_isolation: TEST_DATABASE_URL unset");
        return;
    };
    let tenant = Uuid::new_v4();
    let slug = format!("cap{}", &Uuid::new_v4().simple().to_string()[..8]);
    sqlx::query("INSERT INTO sites (tenant_id, slug) VALUES ($1, $2)")
        .bind(tenant)
        .bind(&slug)
        .execute(&owner)
        .await
        .unwrap();
    let t = cupboard_domain::TenantId(tenant);
    for i in 0..domains::MAX_DOMAINS_PER_TENANT {
        let dom = format!(
            "d{i}-{}.example.gg",
            &Uuid::new_v4().simple().to_string()[..6]
        );
        domains::add_domain(&app, t, &dom)
            .await
            .expect("add within cap");
    }
    let over = format!(
        "over-{}.example.gg",
        &Uuid::new_v4().simple().to_string()[..6]
    );
    let err = domains::add_domain(&app, t, &over)
        .await
        .expect_err("cap enforced");
    assert!(matches!(
        err,
        cupboard_tenant::error::AppError::BadRequest(_)
    ));

    // RLS: tenant B cannot see tenant A's domains.
    let other = Uuid::new_v4();
    let mut tx = cupboard_db::begin_tenant_tx(&app, cupboard_domain::TenantId(other))
        .await
        .unwrap();
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM site_domains WHERE tenant_id = $1")
        .bind(tenant)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(visible, 0, "tenant B must not see tenant A's domains");

    // A domain under our own platform suffix is rejected up front.
    assert!(domains::validate_domain(&format!("{slug}.sites.test"), "sites.test").is_err());
}
