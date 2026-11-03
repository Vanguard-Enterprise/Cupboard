use crate::auth::{
    self, Account, ApiResult, AuthSession, account, bounded, forbidden, internal, invalid,
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection, PgPool, Postgres, Transaction};
use tower_sessions::Session;

pub const PERMISSIONS: &[&str] = &[
    "infrastructure.view",
    "infrastructure.manage",
    "servers.view",
    "servers.manage",
    "players.moderate",
    "integrations.manage",
    "billing.manage",
    "organization.manage",
];
#[derive(FromRow)]
pub struct Context {
    pub organization_id: String,
    pub organization_name: String,
    pub member_id: String,
    pub is_owner: bool,
    pub position: i32,
    pub permissions: Vec<String>,
}
pub(crate) async fn organization_id(session: &Session) -> ApiResult<String> {
    session
        .get("organization_id")
        .await
        .map_err(|_| internal())?
        .ok_or_else(forbidden)
}
pub async fn context(pool: &PgPool, user: &Account, session: &Session) -> ApiResult<Context> {
    let mut conn = pool.acquire().await?;
    context_on(&mut conn, &user.id, &organization_id(session).await?).await
}
// Tenant membership is checked here, alongside data access, not trusted from a route or client ID.
pub(crate) async fn context_on(
    conn: &mut PgConnection,
    user_id: &str,
    org: &str,
) -> ApiResult<Context> {
    let mut ctx: Context = sqlx::query_as("SELECT o.id AS organization_id,o.name AS organization_name,m.id AS member_id,(o.owner_account_id=m.account_id) AS is_owner,COALESCE((SELECT min(r.position) FROM organization_member_roles mr JOIN organization_roles r ON r.organization_id=mr.organization_id AND r.id=mr.role_id WHERE mr.organization_id=o.id AND mr.member_id=m.id),2147483647) AS position,ARRAY(SELECT DISTINCT p FROM organization_member_roles mr JOIN organization_roles r ON r.organization_id=mr.organization_id AND r.id=mr.role_id CROSS JOIN unnest(r.permissions) p WHERE mr.organization_id=o.id AND mr.member_id=m.id) AS permissions FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE o.id=$1 AND m.account_id=$2 AND m.status='active'")
        .bind(org).bind(user_id).fetch_optional(conn).await?.ok_or_else(forbidden)?;
    if ctx.is_owner {
        ctx.permissions = PERMISSIONS.iter().map(|p| p.to_string()).collect();
    }
    Ok(ctx)
}
fn manage(ctx: &Context) -> ApiResult<()> {
    if !ctx.permissions.iter().any(|p| p == "organization.manage") {
        Err(forbidden())
    } else {
        Ok(())
    }
}
fn can_grant(ctx: &Context, role: &Role) -> ApiResult<()> {
    if role.id != "owner"
        && (ctx.is_owner
            || (role.position > ctx.position
                && role.permissions.iter().all(|p| ctx.permissions.contains(p))))
    {
        Ok(())
    } else {
        Err(forbidden())
    }
}
async fn assigned_roles(conn: &mut PgConnection, ctx: &Context, ids: &[String]) -> ApiResult<()> {
    if ids.is_empty()
        || ids.len() > 100
        || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
    {
        return Err(invalid("Choose one or more distinct roles."));
    }
    for id in ids {
        can_grant(ctx, &role(conn, &ctx.organization_id, id).await?)?;
    }
    Ok(())
}
async fn set_roles(
    conn: &mut PgConnection,
    org: &str,
    member: &str,
    ids: &[String],
) -> ApiResult<()> {
    sqlx::query("DELETE FROM organization_member_roles WHERE organization_id=$1 AND member_id=$2")
        .bind(org)
        .bind(member)
        .execute(&mut *conn)
        .await?;
    for id in ids {
        sqlx::query("INSERT INTO organization_member_roles(organization_id,member_id,role_id) VALUES($1,$2,$3)").bind(org).bind(member).bind(id).execute(&mut *conn).await?;
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize, FromRow, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Role {
    pub id: String,
    pub name: String,
    pub description: String,
    pub permissions: Vec<String>,
    pub system: bool,
    pub position: i32,
}
#[derive(Clone, Serialize, Deserialize, FromRow, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Member {
    pub id: String,
    pub name: String,
    pub email: String,
    pub role_ids: Vec<String>,
    pub status: String,
    pub last_active_at: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Team {
    roles: Vec<Role>,
    users: Vec<Member>,
    revision: i64,
    current_user_id: String,
}
pub async fn create_organization(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    name: &str,
    account: &Account,
) -> ApiResult<()> {
    sqlx::query("INSERT INTO organizations(id,name,owner_account_id) VALUES($1,$2,$3)")
        .bind(id)
        .bind(name)
        .bind(&account.id)
        .execute(&mut **tx)
        .await?;
    for (position, role, name) in [(0, "owner", "Owner"), (1, "administrator", "Administrator")] {
        sqlx::query("INSERT INTO organization_roles(organization_id,id,name,description,permissions,system,position) VALUES($1,$2,$3,'Full organization access.',$4,true,$5)").bind(id).bind(role).bind(name).bind(PERMISSIONS).bind(position).execute(&mut **tx).await?;
    }
    let member = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO organization_members(id,organization_id,account_id,name,email,status) VALUES($1,$2,$3,$4,$5,'active')").bind(&member).bind(id).bind(&account.id).bind(&account.name).bind(&account.email).execute(&mut **tx).await?;
    set_roles(tx, id, &member, &["owner".into()]).await?;
    Ok(())
}
pub fn routes() -> Router<PgPool> {
    Router::new()
        .route("/app-api/team", get(read).post(mutate))
        .route("/app-api/invitations/accept", post(accept))
        .route("/app-api/organizations", post(create))
}
async fn load(conn: &mut PgConnection, ctx: &Context) -> ApiResult<Team> {
    manage(ctx)?;
    let roles=sqlx::query_as("SELECT id,name,description,permissions,system,position FROM organization_roles WHERE organization_id=$1 ORDER BY position").bind(&ctx.organization_id).fetch_all(&mut *conn).await?;
    let users=sqlx::query_as("SELECT m.id,m.name,m.email,ARRAY(SELECT mr.role_id FROM organization_member_roles mr JOIN organization_roles r ON r.organization_id=mr.organization_id AND r.id=mr.role_id WHERE mr.organization_id=m.organization_id AND mr.member_id=m.id ORDER BY r.position) AS role_ids,m.status,to_char(a.last_login_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS last_active_at FROM organization_members m LEFT JOIN accounts a ON a.id=m.account_id WHERE m.organization_id=$1 ORDER BY m.name").bind(&ctx.organization_id).fetch_all(&mut *conn).await?;
    let revision = sqlx::query_scalar("SELECT revision FROM organizations WHERE id=$1")
        .bind(&ctx.organization_id)
        .fetch_one(&mut *conn)
        .await?;
    Ok(Team {
        roles,
        users,
        revision,
        current_user_id: ctx.member_id.clone(),
    })
}
async fn read(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
) -> ApiResult<Json<Team>> {
    let user = account(&auth)?;
    let org = organization_id(&session).await?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR SHARE")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    let ctx = context_on(&mut tx, &user.id, &org).await?;
    let team = load(&mut tx, &ctx).await?;
    tx.commit().await?;
    Ok(Json(team))
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Change {
    CreateRole { role: Role },
    UpdateRole { role: Role },
    DeleteRole { id: String },
    ReorderRoles { ids: Vec<String> },
    Invite { user: Member },
    UpdateUser { user: Member },
    RemoveUser { id: String },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Mutation {
    revision: i64,
    change: Change,
}
async fn role(conn: &mut PgConnection, org: &str, id: &str) -> ApiResult<Role> {
    sqlx::query_as("SELECT id,name,description,permissions,system,position FROM organization_roles WHERE organization_id=$1 AND id=$2").bind(org).bind(id).fetch_optional(conn).await?.ok_or(auth::ApiError(StatusCode::NOT_FOUND,"Role not found."))
}
async fn member(conn: &mut PgConnection, org: &str, id: &str) -> ApiResult<Member> {
    sqlx::query_as("SELECT m.id,m.name,m.email,ARRAY(SELECT mr.role_id FROM organization_member_roles mr JOIN organization_roles r ON r.organization_id=mr.organization_id AND r.id=mr.role_id WHERE mr.organization_id=m.organization_id AND mr.member_id=m.id ORDER BY r.position) AS role_ids,m.status,NULL::text AS last_active_at FROM organization_members m WHERE m.organization_id=$1 AND m.id=$2").bind(org).bind(id).fetch_optional(conn).await?.ok_or(auth::ApiError(StatusCode::NOT_FOUND,"User not found."))
}
fn validate_role(role: &mut Role) -> ApiResult<()> {
    role.name = bounded(
        &role.name,
        80,
        "Enter a role name of at most 80 characters.",
    )?;
    if role.description.encode_utf16().count() > 500
        || role.permissions.len() > PERMISSIONS.len()
        || role
            .permissions
            .iter()
            .any(|p| !PERMISSIONS.contains(&p.as_str()))
    {
        return Err(invalid(
            "Choose valid permissions and a description of at most 500 characters.",
        ));
    }
    role.permissions.sort();
    role.permissions.dedup();
    Ok(())
}
async fn mutate(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Json(input): Json<Mutation>,
) -> ApiResult<Json<Value>> {
    let account = account(&auth)?;
    let org = organization_id(&session).await?;
    let mut tx = pool.begin().await?;
    let revision: Option<i64> =
        sqlx::query_scalar("SELECT revision FROM organizations WHERE id=$1 FOR UPDATE")
            .bind(&org)
            .fetch_optional(&mut *tx)
            .await?;
    let ctx = context_on(&mut tx, &account.id, &org).await?;
    manage(&ctx)?;
    if revision != Some(input.revision) {
        return Err(auth::ApiError(
            StatusCode::CONFLICT,
            "Team settings changed. Refresh and review your changes.",
        ));
    }
    let mut invitation_token = None;
    match input.change {
        Change::CreateRole { mut role } => {
            validate_role(&mut role)?;
            role.id = uuid::Uuid::new_v4().to_string();
            role.system = false;
            role.position = sqlx::query_scalar("SELECT COALESCE(max(position),1)+1 FROM organization_roles WHERE organization_id=$1").bind(&org).fetch_one(&mut *tx).await?;
            can_grant(&ctx, &role)?;
            sqlx::query("INSERT INTO organization_roles(organization_id,id,name,description,permissions,system,position) VALUES($1,$2,$3,$4,$5,false,$6)").bind(&org).bind(role.id).bind(role.name).bind(role.description).bind(role.permissions).bind(role.position).execute(&mut *tx).await?;
        }
        Change::UpdateRole { role: mut updated } => {
            validate_role(&mut updated)?;
            let existing = role(&mut tx, &org, &updated.id).await?;
            if existing.system {
                return Err(forbidden());
            }
            can_grant(&ctx, &existing)?;
            if existing.position != updated.position {
                return Err(invalid("Use role reordering to change permission levels."));
            }
            can_grant(&ctx, &updated)?;
            if existing.system != updated.system
                || (existing.system && existing.name != updated.name)
            {
                return Err(invalid("Built-in role names cannot be changed."));
            }
            sqlx::query("UPDATE organization_roles SET name=$3,description=$4,permissions=$5 WHERE organization_id=$1 AND id=$2").bind(&org).bind(updated.id).bind(updated.name).bind(updated.description).bind(updated.permissions).execute(&mut *tx).await?;
        }
        Change::DeleteRole { id } => {
            let existing = role(&mut tx, &org, &id).await?;
            can_grant(&ctx, &existing)?;
            if existing.system {
                return Err(forbidden());
            }
            sqlx::query("DELETE FROM organization_roles WHERE organization_id=$1 AND id=$2")
                .bind(&org)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE organization_roles SET position=position-1 WHERE organization_id=$1 AND position>$2").bind(&org).bind(existing.position).execute(&mut *tx).await?;
        }
        Change::ReorderRoles { ids } => {
            let existing: Vec<Role> = sqlx::query_as("SELECT id,name,description,permissions,system,position FROM organization_roles WHERE organization_id=$1 ORDER BY position").bind(&org).fetch_all(&mut *tx).await?;
            if ids.len() != existing.len()
                || ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len()
                || ids.first().map(String::as_str) != Some("owner")
                || ids.get(1).map(String::as_str) != Some("administrator")
            {
                return Err(invalid(
                    "Include every role once and keep Owner and Administrator at the top.",
                ));
            }
            for (index, id) in ids.iter().enumerate() {
                let role = existing
                    .iter()
                    .find(|r| &r.id == id)
                    .ok_or_else(|| invalid("Role not found."))?;
                let position = i32::try_from(index).map_err(|_| invalid("Too many roles."))?;
                if role.position != position {
                    can_grant(&ctx, role)?;
                    if !ctx.is_owner && position <= ctx.position {
                        return Err(forbidden());
                    }
                }
                sqlx::query(
                    "UPDATE organization_roles SET position=$3 WHERE organization_id=$1 AND id=$2",
                )
                .bind(&org)
                .bind(id)
                .bind(position)
                .execute(&mut *tx)
                .await?;
            }
        }
        Change::Invite { user } => {
            let name = bounded(&user.name, 100, "Enter a name of at most 100 characters.")?;
            let email = auth::normalize_email(&user.email)?;
            assigned_roles(&mut tx, &ctx, &user.role_ids).await?;
            let member_id = uuid::Uuid::new_v4().to_string();
            let token = auth::secret();
            sqlx::query("INSERT INTO organization_members(id,organization_id,name,email,status,invitation_hash,invitation_expires_at) VALUES($1,$2,$3,$4,'invited',$5,now()+interval '7 days')").bind(&member_id).bind(&org).bind(name).bind(email).bind(auth::digest(&token)).execute(&mut *tx).await?;
            set_roles(&mut tx, &org, &member_id, &user.role_ids).await?;
            invitation_token = Some(token);
        }
        Change::UpdateUser { user } => {
            let existing = member(&mut tx, &org, &user.id).await?;
            assigned_roles(&mut tx, &ctx, &existing.role_ids).await?;
            assigned_roles(&mut tx, &ctx, &user.role_ids).await?;
            if user.id == ctx.member_id {
                return Err(invalid("You cannot change your own membership."));
            }
            if user.name != existing.name || user.email != existing.email {
                return Err(invalid(
                    "Account names and email addresses cannot be changed here.",
                ));
            }
            if (existing.status == "invited" && user.status != "invited")
                || (existing.status != "invited"
                    && !["active", "suspended"].contains(&user.status.as_str()))
            {
                return Err(invalid("Invitations must be accepted by the invited user."));
            }
            sqlx::query(
                "UPDATE organization_members SET status=$3 WHERE organization_id=$1 AND id=$2",
            )
            .bind(&org)
            .bind(&user.id)
            .bind(user.status)
            .execute(&mut *tx)
            .await?;
            set_roles(&mut tx, &org, &user.id, &user.role_ids).await?;
        }
        Change::RemoveUser { id } => {
            let existing = member(&mut tx, &org, &id).await?;
            assigned_roles(&mut tx, &ctx, &existing.role_ids).await?;
            if id == ctx.member_id {
                return Err(invalid("You cannot remove your own membership."));
            }
            sqlx::query("DELETE FROM organization_members WHERE organization_id=$1 AND id=$2")
                .bind(&org)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            if existing.status != "invited" {
                crate::alerts::record(
                    &mut tx,
                    &org,
                    "member.removed",
                    &format!("{} was removed", existing.name),
                    &format!(
                        "{} removed {} from the organization.",
                        account.name, existing.email
                    ),
                )
                .await?;
            }
        }
    }
    let owners:i64=sqlx::query_scalar("SELECT count(*) FROM organization_members m JOIN organizations o ON o.id=m.organization_id JOIN organization_member_roles mr ON mr.organization_id=m.organization_id AND mr.member_id=m.id WHERE m.organization_id=$1 AND mr.role_id='owner' AND m.status='active' AND m.account_id=o.owner_account_id").bind(&org).fetch_one(&mut *tx).await?;
    if owners == 0 {
        return Err(invalid("An organization must have an active owner."));
    }
    sqlx::query("UPDATE organizations SET revision=revision+1 WHERE id=$1")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    // Re-read authorization after role changes before returning any tenant data.
    let ctx = context_on(&mut tx, &account.id, &org).await?;
    let team = load(&mut tx, &ctx).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"team":team,"invitationToken":invitation_token}),
    ))
}
#[derive(Deserialize)]
struct Accept {
    token: String,
}
async fn accept(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Json(input): Json<Accept>,
) -> ApiResult<Json<Value>> {
    let user = account(&auth)?;
    if input.token.len() != 64 || !input.token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("This invitation is invalid or has expired."));
    }
    let hash = auth::digest(&input.token);
    let org: Option<String> = sqlx::query_scalar(
        "SELECT organization_id FROM organization_members WHERE invitation_hash=$1",
    )
    .bind(&hash)
    .fetch_optional(&pool)
    .await?;
    let org = org.ok_or(invalid("This invitation is invalid or has expired."))?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    let changed=sqlx::query("UPDATE organization_members SET account_id=$1,name=$2,status='active',invitation_hash=NULL,invitation_expires_at=NULL WHERE organization_id=$3 AND invitation_hash=$4 AND email=$5 AND status='invited' AND invitation_expires_at>now()").bind(&user.id).bind(&user.name).bind(&org).bind(hash).bind(&user.email).execute(&mut *tx).await?;
    if changed.rows_affected() != 1 {
        return Err(invalid(
            "This invitation is invalid, expired, or belongs to another email address.",
        ));
    }
    crate::alerts::record(
        &mut tx,
        &org,
        "member.joined",
        &format!("{} joined", user.name),
        &format!("{} accepted an invitation to the organization.", user.email),
    )
    .await?;
    sqlx::query("UPDATE organizations SET revision=revision+1 WHERE id=$1")
        .bind(&org)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    session
        .insert("organization_id", org)
        .await
        .map_err(|_| internal())?;
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateOrganization {
    name: String,
}
async fn create(
    State(pool): State<PgPool>,
    auth: AuthSession,
    session: Session,
    Json(input): Json<CreateOrganization>,
) -> ApiResult<Json<Value>> {
    let user = account(&auth)?;
    let name = bounded(
        &input.name,
        100,
        "Enter an organization name of at most 100 characters.",
    )?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = pool.begin().await?;
    create_organization(&mut tx, &id, &name, user).await?;
    tx.commit().await?;
    session
        .insert("organization_id", &id)
        .await
        .map_err(|_| internal())?;
    Ok(Json(json!({"id":id,"name":name})))
}

#[cfg(test)]
mod text_tests {
    use super::{Role, validate_role};

    #[test]
    fn role_text_limits_match_browser_utf16_lengths() {
        for (character, units) in [("界", 1), ("😀", 2)] {
            let mut role = Role {
                id: "custom".into(),
                name: character.repeat(80 / units),
                description: character.repeat(500 / units),
                permissions: vec![],
                system: false,
                position: 2,
            };
            assert!(validate_role(&mut role).is_ok());
            role.name.push_str(character);
            assert!(validate_role(&mut role).is_err());
            role.name = "Valid".into();
            role.description.push_str(character);
            assert!(validate_role(&mut role).is_err());
        }
    }
}
