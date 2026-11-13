//! Local development fixtures. This module is absent from release builds.
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use rand_core::OsRng;
use serde::Deserialize;
use sqlx::PgPool;

use crate::secrets::SecretKey;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedAccount {
    pub account_id: String,
    pub organization_id: String,
    pub email: String,
    pub password: String,
    pub dev_machine: Option<SeedMachine>,
    /// Example servers and machines that `scripts/dev-fleet.mjs` keeps live.
    #[serde(default)]
    pub example_fleet: Option<ExampleFleet>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExampleFleet {
    pub rcon_password: String,
    pub servers: Vec<ExampleServer>,
    pub machines: Vec<ExampleMachine>,
}
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExampleServer {
    pub id: String,
    pub name: String,
    pub behavior: String,
    pub max_players: u16,
    pub rcon_port: u16,
    pub a2s_port: u16,
}
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExampleMachine {
    pub id: String,
    pub credential: String,
    pub name: String,
    pub behavior: String,
    pub address: String,
    pub provider: String,
    pub tags: Vec<String>,
}
const SERVER_BEHAVIORS: [&str; 4] = ["busy", "steady", "rcon-rejects", "offline"];
const MACHINE_BEHAVIORS: [&str; 4] = ["steady", "busy", "database", "silent"];
const EXAMPLE_TAGS: [&str; 4] = ["wings", "game-server", "database", "backups"];

fn valid_name(name: &str) -> bool {
    (1..=80).contains(&name.chars().count()) && !name.chars().any(char::is_control)
}
fn valid_credential(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
impl ExampleFleet {
    fn valid(&self) -> bool {
        self.rcon_password.len() == 32
            && self.rcon_password.bytes().all(|b| b.is_ascii_hexdigit())
            && self.servers.len() <= 8
            && self.machines.len() <= 8
            && self.servers.iter().all(|s| {
                uuid::Uuid::parse_str(&s.id).is_ok()
                    && valid_name(&s.name)
                    && SERVER_BEHAVIORS.contains(&s.behavior.as_str())
                    && (1..=255).contains(&s.max_players)
                    && s.rcon_port >= 1024
                    && s.a2s_port >= 1024
            })
            && self.machines.iter().all(|m| {
                uuid::Uuid::parse_str(&m.id).is_ok()
                    && valid_credential(&m.credential)
                    && valid_name(&m.name)
                    && m.provider.chars().count() <= 80
                    && MACHINE_BEHAVIORS.contains(&m.behavior.as_str())
                    && m.address.parse::<std::net::IpAddr>().is_ok()
                    && m.tags.iter().all(|t| EXAMPLE_TAGS.contains(&t.as_str()))
            })
    }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeedMachine {
    pub id: String,
    pub credential: String,
}

pub async fn seed(
    pool: &PgPool,
    account: &SeedAccount,
    key: Option<&SecretKey>,
) -> Result<(), &'static str> {
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
    if account
        .example_fleet
        .as_ref()
        .is_some_and(|fleet| !fleet.valid())
    {
        return Err("Invalid example fleet in the development account file.");
    }
    if account.example_fleet.is_some() && key.is_none() {
        return Err("Example servers need this worktree's CUPBOARD_SECRET_KEY.");
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
    if let (Some(fleet), Some(key)) = (&account.example_fleet, key) {
        seed_fleet(&mut tx, &account.organization_id, fleet, key).await?;
    }
    tx.commit().await.map_err(|_| "Seed commit failed.")
}

/// Example servers point at the simulator's loopback ports; example machines
/// get agent credentials so the simulator can report for them. A silent
/// machine starts with an old reading, so it shows as not reporting. Rows an
/// operator edited keep their names; only connection details are refreshed.
async fn seed_fleet(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
    fleet: &ExampleFleet,
    key: &SecretKey,
) -> Result<(), &'static str> {
    let elsewhere =
        "An example server or machine belongs to another organization; no data changed.";
    for server in &fleet.servers {
        let sealed = key
            .encrypt(&fleet.rcon_password, org, &server.id, "rcon")
            .map_err(|_| "Example server password could not be sealed.")?;
        let result = sqlx::query("INSERT INTO servers(id,organization_id,name,rcon_host,rcon_port,rcon_password_encrypted,a2s_host,a2s_port) VALUES($1,$2,$3,'127.0.0.1',$4,$5,'127.0.0.1',$6) ON CONFLICT(id) DO UPDATE SET rcon_host=EXCLUDED.rcon_host,rcon_port=EXCLUDED.rcon_port,rcon_password_encrypted=EXCLUDED.rcon_password_encrypted,a2s_host=EXCLUDED.a2s_host,a2s_port=EXCLUDED.a2s_port WHERE servers.organization_id=EXCLUDED.organization_id")
            .bind(&server.id)
            .bind(org)
            .bind(&server.name)
            .bind(i32::from(server.rcon_port))
            .bind(sealed)
            .bind(i32::from(server.a2s_port))
            .execute(&mut **tx)
            .await
            .map_err(|_| "Example server write failed.")?;
        if result.rows_affected() != 1 {
            return Err(elsewhere);
        }
    }
    for machine in &fleet.machines {
        let silent = machine.behavior == "silent";
        let health = silent.then(|| {
            serde_json::json!({
                "hostname": machine.name,
                "os": "Ubuntu 24.04 LTS",
                "agentVersion": "dev-example",
                "cpuCount": 4,
                "loadOne": 0.4,
                "cpuUsagePercent": 9.5,
                "memoryTotalBytes": 17_179_869_184_u64,
                "memoryAvailableBytes": 11_811_160_064_u64,
                "diskTotalBytes": 8_796_093_022_208_u64,
                "diskAvailableBytes": 2_199_023_255_552_u64,
                "uptimeSeconds": 3_456_000
            })
        });
        let result = sqlx::query("INSERT INTO machines(id,organization_id,name,address,provider,notes,tags,agent_hash,enrolled_at,health,last_seen_at) VALUES($1,$2,$3,$4,$5,'Example machine for local development.',$6,$7,(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint-604800000,$8,CASE WHEN $8::jsonb IS NULL THEN NULL ELSE (EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint-172800000 END) ON CONFLICT(id) DO UPDATE SET agent_hash=EXCLUDED.agent_hash WHERE machines.organization_id=EXCLUDED.organization_id")
            .bind(&machine.id)
            .bind(org)
            .bind(&machine.name)
            .bind(&machine.address)
            .bind(&machine.provider)
            .bind(serde_json::json!(machine.tags))
            .bind(crate::auth::digest(&machine.credential))
            .bind(health)
            .execute(&mut **tx)
            .await
            .map_err(|_| "Example machine write failed.")?;
        if result.rows_affected() != 1 {
            return Err(elsewhere);
        }
    }
    Ok(())
}
