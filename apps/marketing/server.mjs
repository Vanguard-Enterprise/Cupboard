import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cupboard — run your Rust community from one place</title>
<meta name="description" content="Cupboard brings moderation, players, performance, stores, and support together for Rust server communities.">
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090b10;color:#f6f7fb}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 75% 10%,#31225d66,transparent 34%),#090b10}a{color:inherit;text-decoration:none}.wrap{width:min(1120px,calc(100% - 40px));margin:auto}nav{height:76px;display:flex;align-items:center;justify-content:space-between}.brand{font-size:20px;font-weight:800;letter-spacing:-.03em}.navlinks{display:flex;gap:12px;align-items:center}.button{display:inline-flex;padding:11px 17px;border:1px solid #ffffff24;border-radius:11px;font-weight:700}.primary{background:#7657ff;border-color:#7657ff;box-shadow:0 10px 35px #7657ff44}.hero{padding:112px 0 96px;max-width:820px}.eyebrow{color:#9b88ff;font-weight:800;text-transform:uppercase;letter-spacing:.14em;font-size:12px}h1{font-size:clamp(48px,8vw,88px);line-height:.98;letter-spacing:-.065em;margin:20px 0 26px}.lead{font-size:clamp(18px,2.2vw,23px);line-height:1.55;color:#b8bdca;max-width:690px}.actions{display:flex;gap:12px;margin-top:34px;flex-wrap:wrap}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding-bottom:100px}.card{padding:26px;border:1px solid #ffffff16;border-radius:18px;background:#11141bcc}.card h2{font-size:18px;margin:0 0 10px}.card p{color:#9da4b4;line-height:1.55;margin:0}footer{border-top:1px solid #ffffff12;padding:28px 0 42px;color:#777f90;font-size:14px}@media(max-width:760px){.grid{grid-template-columns:1fr}.hero{padding-top:70px}.navlinks .quiet{display:none}}
</style></head><body><div class="wrap"><nav><a class="brand" href="/">Cupboard</a><div class="navlinks"><a class="button quiet" href="#platform">Platform</a><a class="button primary" href="/app/login">Open dashboard</a></div></nav><main><section class="hero"><div class="eyebrow">Operations for Rust communities</div><h1>Less tab juggling.<br>More server building.</h1><p class="lead">Cupboard unifies player intelligence, moderation, performance, commerce, and support so your team can operate a better community from one calm workspace.</p><div class="actions"><a class="button primary" href="/app/login">Open staging dashboard</a><a class="button" href="#platform">Explore the platform</a></div></section><section class="grid" id="platform"><article class="card"><h2>Know your players</h2><p>See identity, history, reports, bans, and evasion signals together instead of piecing them across tools.</p></article><article class="card"><h2>Operate in real time</h2><p>Monitor fleet health, chat, and performance with workflows designed for live server teams.</p></article><article class="card"><h2>Grow sustainably</h2><p>Run storefronts, subscriptions, support, and staff permissions without losing operational control.</p></article></section></main><footer>Cupboard staging · Vanguard Enterprise</footer></div></body></html>`;

createServer((req, res) => {
  if (req.url === "/healthz" || req.url === "/readyz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"status":"ok","service":"cupboard-marketing"}');
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }); return res.end();
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" });
  res.end(req.method === "HEAD" ? undefined : page);
}).listen(port, "0.0.0.0");
