//! Local development fixtures. This module is absent from release builds.
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use rand_core::OsRng;
use serde::Deserialize;
use sqlx::PgPool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedAccount {
    pub account_id: String,
    pub organization_id: String,
    pub email: String,
    pub password: String,
    pub dev_machine: Option<SeedMachine>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeedMachine {
    pub id: String,
    pub credential: String,
}

pub async fn seed(pool: &PgPool, account: &SeedAccount) -> Result<(), &'static str> {
    if uuid::Uuid::parse_str(&account.account_id).is_err()
        || uuid::Uuid::parse_str(&account.organization_id).is_err()
        || !account.email.ends_with("@example.test")
        || account.password.len() < 16
        || account.password.len() > 128
    {
        return Err("Invalid development account file.");
    }
    if account.dev_machine.as_ref().is_some_and(|machine| {
        uuid::Uuid::parse_str(&machine.id).is_err()
            || machine.credential.len() != 64
            || !machine.credential.bytes().all(|b| b.is_ascii_hexdigit())
    }) {
        return Err("Invalid development machine credential.");
    }
    let mut tx = pool.begin().await.map_err(|_| "Seed transaction failed.")?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 48))")
        .bind(&account.account_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| "Seed lock failed.")?;
    let existing: Option<(String, String, String)> =
        sqlx::query_as("SELECT id,password_hash,email FROM accounts WHERE id=$1 OR email=$2")
            .bind(&account.account_id)
            .bind(&account.email)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| "Seed account lookup failed.")?;
    if existing
        .as_ref()
        .is_some_and(|(id, _, email)| id != &account.account_id || email != &account.email)
    {
        return Err("Seed email belongs to another account; no data changed.");
    }
    let unchanged = existing.as_ref().is_some_and(|(_, hash, _)| {
        PasswordHash::new(hash).ok().is_some_and(|hash| {
            Argon2::default()
                .verify_password(account.password.as_bytes(), &hash)
                .is_ok()
        })
    });
    if !unchanged {
        let hash = Argon2::default()
            .hash_password(
                account.password.as_bytes(),
                &SaltString::generate(&mut OsRng),
            )
            .map_err(|_| "Seed password hashing failed.")?
            .to_string();
        sqlx::query("INSERT INTO accounts(id,name,email,password_hash) VALUES($1,'Dev Operator',$2,$3) ON CONFLICT(id) DO UPDATE SET password_hash=EXCLUDED.password_hash WHERE accounts.email=EXCLUDED.email")
            .bind(&account.account_id).bind(&account.email).bind(hash).execute(&mut *tx).await.map_err(|_| "Seed account write failed.")?;
    }
    let owner: Option<String> =
        sqlx::query_scalar("SELECT owner_account_id FROM organizations WHERE id=$1 FOR UPDATE")
            .bind(&account.organization_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| "Seed organization lookup failed.")?;
    match owner {
        Some(owner) if owner != account.account_id => {
            return Err("Seed organization belongs to another account; no data changed.");
        }
        None => {
            let user = sqlx::query_as(
                "SELECT id,name,email,password_hash FROM accounts WHERE id=$1 AND email=$2",
            )
            .bind(&account.account_id)
            .bind(&account.email)
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| "Seed identity mismatch.")?;
            crate::team::create_organization(
                &mut tx,
                &account.organization_id,
                "Northstar Games",
                &user,
            )
            .await
            .map_err(|_| "Seed organization creation failed.")?;
        }
        _ => {}
    }
    sqlx::query("INSERT INTO organization_roles(organization_id,id,name,description,permissions,system,position) VALUES($1,'dev-moderator','Moderator','Handles player reports.',ARRAY['servers.view','players.moderate'],false,2) ON CONFLICT(organization_id,id) DO NOTHING")
        .bind(&account.organization_id).execute(&mut *tx).await.map_err(|_| "Seed role write failed.")?;
    for (id, name, email) in [
        ("dev-alex", "Alex Morgan", "alex@example.test"),
        ("dev-jamie", "Jamie Rivera", "jamie@example.test"),
    ] {
        sqlx::query("INSERT INTO organization_members(id,organization_id,name,email,status) VALUES($1,$2,$3,$4,'invited') ON CONFLICT(organization_id,email) DO NOTHING")
            .bind(format!("{}-{id}", account.organization_id)).bind(&account.organization_id).bind(name).bind(email).execute(&mut *tx).await.map_err(|_| "Seed member write failed.")?;
        sqlx::query("INSERT INTO organization_member_roles(organization_id,member_id,role_id) SELECT organization_id,id,'dev-moderator' FROM organization_members WHERE organization_id=$1 AND email=$2 AND status='invited' ON CONFLICT(organization_id,member_id,role_id) DO NOTHING")
            .bind(&account.organization_id).bind(email).execute(&mut *tx).await.map_err(|_| "Seed member role write failed.")?;
    }
    if let Some(machine) = &account.dev_machine {
        let result = sqlx::query("INSERT INTO machines(id,organization_id,name,address,provider,notes,tags,agent_hash,enrolled_at) VALUES($1,$2,'use1-wings-01','10.1.70.10','Wings','Managed development Wings telemetry.','[\"wings\",\"game-server\"]'::jsonb, $3,(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint) ON CONFLICT(id) DO UPDATE SET agent_hash=EXCLUDED.agent_hash,enrolled_at=COALESCE(machines.enrolled_at,EXCLUDED.enrolled_at) WHERE machines.organization_id=EXCLUDED.organization_id AND machines.notes=EXCLUDED.notes")
            .bind(&machine.id).bind(&account.organization_id).bind(crate::auth::digest(&machine.credential)).execute(&mut *tx).await.map_err(|_| "Seed machine write failed.")?;
        if result.rows_affected() != 1 {
            return Err("Development machine belongs to another organization; no data changed.");
        }
    }
    tx.commit().await.map_err(|_| "Seed commit failed.")
}
