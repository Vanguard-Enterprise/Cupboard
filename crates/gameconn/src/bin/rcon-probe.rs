//! Manual RCON smoke test — the Phase 2 PR1 spike that proves the connection path
//! against a real server before any service scaffolding exists.
//!
//! Usage:
//!   cargo run -p cupboard-gameconn --bin rcon-probe -- <host> <port> <password>
//!   RCON_HOST=... RCON_PORT=... RCON_PASSWORD=... cargo run -p cupboard-gameconn --bin rcon-probe
//!
//! Dials the server, runs `playerlist`, and prints the parsed roster (Steam ID, IP,
//! name, family-share flag). Not part of CI — it needs a live server.

use cupboard_gameconn::RconClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (host, port, password) = match args.as_slice() {
        [host, port, password] => (host.clone(), port.parse::<u16>()?, password.clone()),
        [] => (
            std::env::var("RCON_HOST")
                .map_err(|_| "set RCON_HOST or pass <host> <port> <password>")?,
            std::env::var("RCON_PORT")
                .map_err(|_| "set RCON_PORT")?
                .parse::<u16>()?,
            std::env::var("RCON_PASSWORD").map_err(|_| "set RCON_PASSWORD")?,
        ),
        _ => return Err("usage: rcon-probe <host> <port> <password>".into()),
    };

    eprintln!("connecting to {host}:{port} ...");
    let mut client = RconClient::connect(&host, port, &password).await?;
    eprintln!("connected; querying playerlist");

    let players = client.playerlist().await?;
    println!("{} player(s) online:", players.len());
    for p in &players {
        let share = if p.is_family_share() {
            format!(" (family-share of {})", p.owner_steam_id)
        } else {
            String::new()
        };
        println!(
            "  {:<20} {:<16} ping={:<4} {}s  {}{}",
            p.steam_id,
            p.ip(),
            p.ping,
            p.connected_seconds,
            p.display_name,
            share
        );
    }
    Ok(())
}
