#[cfg(debug_assertions)]
#[tokio::main]
async fn main() {
    let result = async {
        if std::env::var("NODE_ENV").as_deref() == Ok("production")
            || !std::env::var("CUPBOARD_DEV_SEED_WORKSPACE")
                .is_ok_and(|v| v.starts_with("cupboard-dev-"))
        {
            return Err("Use npm run dev:seed in a managed development worktree.");
        }
        let database_url = std::env::var("DATABASE_URL").map_err(|_| "Use npm run dev:seed.")?;
        let parsed = reqwest::Url::parse(&database_url).map_err(|_| "Invalid seed database.")?;
        if parsed.scheme() != "postgres"
            || parsed.host_str() != Some("127.0.0.1")
            || parsed.username() != "cupboard"
            || parsed.password() != Some("cupboard-local-only")
            || parsed.path() != "/cupboard"
            || parsed.query().is_some()
        {
            return Err("Dev seeding requires the managed loopback database.");
        }
        let path = std::env::args().nth(1).ok_or("Use npm run dev:seed.")?;
        let account = serde_json::from_slice(
            &std::fs::read(path).map_err(|_| "Dev account file unreadable.")?,
        )
        .map_err(|_| "Dev account file invalid.")?;
        let pool =
            cupboard::connect(&std::env::var("DATABASE_URL").map_err(|_| "Use npm run dev:seed.")?)
                .await?;
        let result = cupboard::dev_seed::seed(&pool, &account).await;
        pool.close().await;
        result
    }
    .await;
    if let Err(message) = result {
        eprintln!("{message}");
        std::process::exit(1);
    }
}
#[cfg(not(debug_assertions))]
fn main() {
    eprintln!("Development seeding is unavailable in release builds.");
    std::process::exit(1);
}
