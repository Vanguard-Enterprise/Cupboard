//! Proves the RCON-credential path end-to-end through Postgres: `create` seals the
//! password under the envelope master key and stores it as `bytea`; `list_enabled_configs`
//! reads it back on the owner pool and decrypts it. This is the exact path the Collector
//! depends on (Fleet → decrypted config feed).
//!
//! Requires the same test DB as `rls.rs` (PG18 + `cupboard_app`). Skips when unset.

use sqlx::PgPool;
use tokio::sync::OnceCell;
use uuid::Uuid;

use cupboard_domain::TenantId;

// Fleet is a binary crate, so its domain module isn't importable here; the test mirrors
// the exact seal + SQL the service uses and then decrypts, which proves the same path.

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static MIGRATED: OnceCell<()> = OnceCell::const_new();

async fn setup() -> Option<(PgPool, PgPool)> {
    let owner_url = std::env::var("TEST_DATABASE_URL").ok()?;
    let app_url = std::env::var("TEST_DATABASE_URL_APP").unwrap_or_else(|_| owner_url.clone());
    let owner = cupboard_db::connect_scoped(&owner_url, 5, "fleet,public")
        .await
        .expect("connect owner");
    let app = cupboard_db::connect_scoped(&app_url, 5, "fleet,public")
        .await
        .expect("connect app");
    MIGRATED
        .get_or_init(|| async {
            sqlx::query("CREATE SCHEMA IF NOT EXISTS fleet")
                .execute(&owner)
                .await
                .expect("ensure schema");
            MIGRATOR.run(&owner).await.expect("migrate");
        })
        .await;
    Some((owner, app))
}

#[tokio::test]
async fn rcon_password_round_trips_through_postgres() {
    let Some((owner, app)) = setup().await else {
        eprintln!("SKIP rcon_password_round_trips_through_postgres: TEST_DATABASE_URL unset");
        return;
    };

    let master_key = [42u8; 32];
    let tenant = Uuid::new_v4();
    let secret = "changeme123";

    // Seal exactly as the service's `create` does, and INSERT on the tenant-bound app pool.
    let sealed = cupboard_crypto::seal(&master_key, secret.as_bytes()).unwrap();
    let mut tx = cupboard_db::begin_tenant_tx(&app, TenantId(tenant))
        .await
        .expect("begin tenant tx");
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO servers \
         (tenant_id, name, rcon_host, rcon_port, rcon_password_enc, rcon_password_dek) \
         VALUES ($1, 'roundtrip', '203.0.113.9', 28016, $2, $3) RETURNING id",
    )
    .bind(tenant)
    .bind(&sealed.ciphertext)
    .bind(&sealed.wrapped_dek)
    .fetch_one(&mut *tx)
    .await
    .expect("insert server");
    tx.commit().await.expect("commit");

    // Read back on the owner pool and decrypt, mirroring `list_enabled_configs`.
    #[derive(sqlx::FromRow)]
    struct Row {
        enc: Vec<u8>,
        dek: Vec<u8>,
    }
    let row: Row = sqlx::query_as(
        "SELECT rcon_password_enc AS enc, rcon_password_dek AS dek FROM servers WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&owner)
    .await
    .expect("read back");

    let plaintext = cupboard_crypto::open(
        &master_key,
        &cupboard_crypto::Envelope {
            wrapped_dek: row.dek,
            ciphertext: row.enc,
        },
    )
    .expect("decrypt");
    assert_eq!(
        String::from_utf8(plaintext).unwrap(),
        secret,
        "RCON password must survive the seal→store→fetch→open round-trip"
    );

    // And the ciphertext at rest must not be the plaintext.
    let stored: Vec<u8> = sqlx::query_scalar("SELECT rcon_password_enc FROM servers WHERE id = $1")
        .bind(id)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert!(
        !stored.windows(secret.len()).any(|w| w == secret.as_bytes()),
        "plaintext RCON password must not appear in the stored ciphertext"
    );
}
