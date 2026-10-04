import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

// Exercise the release artifacts through Next.js, with disposable data only.
const [apiImage, webImage] = process.argv.slice(2);
if (!apiImage || !webImage)
  throw new Error(
    "Usage: node scripts/smoke-images.mjs <api-image> <web-image>",
  );
const prefix = `cupboard-smoke-${randomBytes(6).toString("hex")}`;
const names = ["db", "api", "web"].map((name) => `${prefix}-${name}`);
const [db, api, web] = names;
const password = randomBytes(24).toString("hex");
const rconPassword = randomBytes(24).toString("hex");
const secretKey = randomBytes(32).toString("hex");
let stage = "starting containers";
const docker = (args, env = {}) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  }).trim();
async function eventually(check) {
  for (let i = 0; i < 90; i++) {
    try {
      if (await check()) return;
    } catch {
      // Startup may still be migrating or binding its listener.
    }
    await delay(1000);
  }
  throw new Error("Container readiness timed out");
}
let networkCreated = false;
try {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const webPort = reservation.address().port;
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  docker(["network", "create", prefix]);
  networkCreated = true;
  docker(
    [
      "run",
      "-d",
      "--name",
      db,
      "--network",
      prefix,
      "--env",
      "POSTGRES_PASSWORD",
      "--env",
      "POSTGRES_USER=cupboard",
      "--env",
      "POSTGRES_DB=cupboard",
      "postgres:18-bookworm",
    ],
    { POSTGRES_PASSWORD: password },
  );
  await eventually(() => {
    docker(["exec", db, "pg_isready", "-U", "cupboard", "-d", "cupboard"]);
    return true;
  });
  docker([
    "run",
    "-d",
    "--name",
    web,
    "--network",
    prefix,
    "-p",
    `127.0.0.1:${webPort}:3000`,
    "--env",
    `CUPBOARD_API_URL=http://${api}:8080`,
    webImage,
  ]);
  const port = docker(["port", web, "3000/tcp"]).split(":").at(-1);
  const origin = `http://127.0.0.1:${port}`;
  docker(
    [
      "run",
      "-d",
      "--name",
      api,
      "--network",
      prefix,
      "--env",
      "DATABASE_URL",
      "--env",
      "CUPBOARD_SECRET_KEY",
      "--env",
      `CUPBOARD_WEB_ORIGINS=${origin}`,
      "--env",
      "CUPBOARD_INSECURE_COOKIES=1",
      apiImage,
    ],
    {
      DATABASE_URL: `postgres://cupboard:${password}@${db}:5432/cupboard`,
      CUPBOARD_SECRET_KEY: secretKey,
    },
  );
  const client = () => {
    let cookie = "";
    return async (path, body, status = 200) => {
      stage = `${body === undefined ? "GET" : "POST"} ${path}`;
      const response = await fetch(`${origin}/app-api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin,
          cookie,
          "content-type": "application/json",
          "x-cupboard-request": "1",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(response.status, status, `${path} status`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const setCookie = response.headers
        .getSetCookie()
        .find((value) => value.startsWith("cupboard_session="));
      if (setCookie) {
        if (!setCookie.startsWith("cupboard_session=;")) {
          assert.ok(/httponly/i.test(setCookie), "Session needs HttpOnly");
          assert.ok(
            /samesite=lax/i.test(setCookie),
            "Session needs SameSite=Lax",
          );
        }
        cookie = setCookie.split(";")[0];
      }
      const text = await response.text();
      for (const secret of [password, rconPassword, secretKey])
        assert.ok(!text.includes(secret), "API exposed a secret");
      return JSON.parse(text);
    };
  };
  const anonymous = client();
  await eventually(async () => {
    await anonymous("auth/me", undefined, 401);
    return true;
  });
  const login = await fetch(`${origin}/login`);
  assert.equal(login.status, 200);
  const html = await login.text();
  const asset = html.match(/(?:src|href)="([^\"]*\/_next\/static\/[^\"]+)"/);
  assert.ok(asset, "Login page has no bundled browser assets");
  assert.equal(
    (await fetch(new URL(asset[1].replaceAll("&amp;", "&"), origin))).status,
    200,
  );
  const owner = client();
  const email = `${prefix}@example.com`;
  await owner("auth/signup", { name: "Release check", email, password });
  await owner("organizations", { name: "Release check" });
  await owner("auth/logout", {});
  await owner("auth/login", { email, password });
  const server = await owner("servers", {
    name: "Unreachable test server",
    rconHost: "127.0.0.1",
    rconPort: 1,
    rconPassword,
    a2sHost: "127.0.0.1",
    a2sPort: 1,
  });
  const checked = await owner(`servers/${server.id}/check`, {});
  assert.ok(["unreachable", "timeout"].includes(checked.rconStatus));
  assert.ok(["unreachable", "timeout"].includes(checked.a2sStatus));
  assert.ok(checked.checkedAt > 0);
  const outsider = client();
  await outsider("auth/signup", {
    name: "Other tenant",
    email: `other-${email}`,
    password,
  });
  await outsider("organizations", { name: "Other tenant" });
  assert.deepEqual(await outsider("servers"), []);
  assert.deepEqual((await outsider("servers/health")).servers, []);
  await outsider(`servers/${server.id}/check`, {}, 404);
  await anonymous("servers", undefined, 401);
  docker(["restart", api, web]);
  await eventually(async () => {
    await owner("auth/me");
    return true;
  });
  const saved = await owner("servers");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, server.id);
  assert.equal(saved[0].name, server.name);
  const health = await owner("servers/health");
  assert.equal(health.servers[0].id, server.id);
  assert.ok(health.servers[0].checkedAt > 0);
  const rechecked = await owner(`servers/${server.id}/check`, {});
  assert.ok(
    ["unreachable", "timeout"].includes(rechecked.rconStatus),
    "Stored credential could not be decrypted after restart",
  );
  for (const name of [api, web]) {
    const logs = docker(["logs", name]);
    for (const secret of [password, rconPassword, secretKey])
      assert.ok(!logs.includes(secret), "Container log exposed a secret");
  }
  console.log(
    "Release image smoke passed: assets, sign-in, tenant isolation, server check, health, secrets, and restart persistence.",
  );
} catch {
  // Child-process errors can contain environment or response details. Do not dump them.
  console.error(
    `Release image smoke failed at ${stage}. Reproduce with the two image tags and inspect the failing step locally.`,
  );
  process.exitCode = 1;
} finally {
  for (const name of names.reverse()) {
    try {
      docker(["rm", "-f", "-v", name]);
    } catch {
      /* May not have started. */
    }
  }
  if (networkCreated) {
    try {
      docker(["network", "rm", prefix]);
    } catch {
      console.error(`Could not remove smoke network ${prefix}`);
      process.exitCode = 1;
    }
  }
}
