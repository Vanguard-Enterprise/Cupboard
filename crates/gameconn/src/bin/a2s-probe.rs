//! Manual A2S smoke test — proves the A2S_INFO path (challenge flow + Rust keyword
//! counts) against a real server, mirroring `rcon-probe`.
//!
//! Usage:
//!   cargo run -p cupboard-gameconn --bin a2s-probe -- <host> <query_port>
//!
//! Not part of CI — it needs a live server.

use std::time::Duration;

use cupboard_gameconn::a2s;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [host, port] = args.as_slice() else {
        return Err("usage: a2s-probe <host> <query_port>".into());
    };

    eprintln!("querying A2S_INFO on {host}:{port} ...");
    let info = a2s::query_info(host, port.parse()?, Duration::from_secs(5)).await?;
    println!("hostname    : {}", info.hostname);
    println!("map         : {}", info.map);
    println!("players     : {}/{}", info.players, info.max_players);
    println!("queued      : {:?}", info.queued);
    println!("keywords    : {:?}", info.keywords);
    Ok(())
}
