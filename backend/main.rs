use std::{env, net::SocketAddr, process::ExitCode};

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("Cupboard: {message}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), &'static str> {
    let url = env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?;
    let bind: SocketAddr = env::var("CUPBOARD_API_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()
        .map_err(|_| "CUPBOARD_API_BIND must be an IP address and port")?;
    let key = cupboard::servers::SecretKey::parse(
        &env::var("CUPBOARD_SECRET_KEY").map_err(|_| "CUPBOARD_SECRET_KEY is required")?,
    )?;
    let storage = cupboard::storage::FileStore::from_env()?;
    let pool = cupboard::connect(&url).await?;
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|_| "API listener could not bind")?;
    println!("Cupboard API listening on {bind}");
    let config = cupboard::auth::AuthConfig {
        origins: env::var("CUPBOARD_WEB_ORIGINS")
            .map_err(|_| "CUPBOARD_WEB_ORIGINS is required")?
            .split(',')
            .map(|s| s.trim().to_owned())
            .collect(),
        secure_cookies: env::var("CUPBOARD_INSECURE_COOKIES").as_deref() != Ok("1"),
    };
    let monitor = tokio::spawn(cupboard::servers::monitor(pool.clone(), key.clone()));
    let mut app = cupboard::router_with_auth(pool.clone(), config).layer(axum::Extension(key));
    let cleanup = storage.map(|storage| {
        app = app.clone().layer(axum::Extension(storage.clone()));
        tokio::spawn(cupboard::cleanup_files(pool.clone(), storage))
    });
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await
        .map_err(|_| "API listener failed");
    if let Some(cleanup) = cleanup {
        cleanup.abort();
        let _ = cleanup.await;
    }
    monitor.abort();
    let _ = monitor.await;
    pool.close().await;
    result
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {},
                    _ = terminate.recv() => {},
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
