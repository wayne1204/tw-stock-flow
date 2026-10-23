/**
 * Accounts backend (lib/account.mjs, served by functions/api/*).
 *
 * Runs the real handlers against:
 *   - a D1 stand-in over node:sqlite, so every SQL statement actually executes;
 *   - ID tokens signed here with a throwaway RSA key, offered to the verifier
 *     as the "Google" key set. A token Google did not sign (wrong key), for
 *     another client, expired, or from another issuer must be refused.
 */
"use strict";

const path = require("path");
const { pathToFileURL } = require("url");

const ORIGIN = "https://atlas.example";
const CLIENT_ID = "test-client.apps.googleusercontent.com";

function d1(sqlite) {
  const db = new sqlite.DatabaseSync(":memory:");
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() { return db.prepare(sql).get(...args) || null; },
        async run() { db.prepare(sql).run(...args); return { success: true }; },
        async all() { return { results: db.prepare(sql).all(...args) }; }
      };
      return stmt;
    }
  };
}

const b64url = buf => Buffer.from(buf).toString("base64url");

async function signer() {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const sign = async (claims, { kid = "k1", key = kp.privateKey } = {}) => {
    const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const body = b64url(JSON.stringify(claims));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + body));
    return `${head}.${body}.${b64url(sig)}`;
  };
  return { jwk, sign };
}

const claimsFor = (over = {}) => {
  const t = Math.floor(Date.now() / 1000);
  return { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "g-123", email: "a@example.com",
           name: "Ann", picture: "https://example.com/p.png", iat: t - 10, exp: t + 3600, ...over };
};

function req(method, route, { body, cookie, origin = ORIGIN, type = "application/json" } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = type;
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  return new Request(`${ORIGIN}/api/${route}`, {
    method, headers, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body))
  });
}

module.exports = {
  name: "accounts backend — Google sign-in, sessions, favourites",

  needs() {
    try { require("node:sqlite"); } catch { return "node:sqlite unavailable (needs Node 22.5+)"; }
    return null;
  },

  async run(t) {
    const sqlite = require("node:sqlite");
    const acc = await import(pathToFileURL(path.join(__dirname, "..", "..", "server", "account.mjs")).href);
    const { jwk, sign } = await signer();
    const other = await signer();                       // a key Google never published
    const env = { DB: d1(sqlite), GOOGLE_CLIENT_ID: CLIENT_ID };
    const opts = { getKeys: async () => [jwk] };
    const call = (route, r, e = env) => acc.handle(route, { request: r, env: e }, opts);
    const body = async r => r.json();

    // ── config / not configured ──
    let r = await call("config", req("GET", "config"), {});
    t.eq("config without bindings reports accounts off", await body(r), { googleClientId: null, accounts: false });
    r = await call("me", req("GET", "me"), {});
    t.eq("API answers 503 until DB + client ID are set", r.status, 503);
    r = await call("config", req("GET", "config"));
    t.eq("config exposes the public client ID", (await body(r)).googleClientId, CLIENT_ID);

    // ── token verification ──
    const reject = async (label, token) => {
      const res = await call("login", req("POST", "login", { body: { credential: token } }));
      t.eq(`login refuses ${label}`, res.status, 401);
    };
    await reject("a token signed by another key", await other.sign(claimsFor()));
    await reject("an unknown key id", await sign(claimsFor(), { kid: "nope" }));
    await reject("another app's token", await sign(claimsFor({ aud: "someone-else" })));
    await reject("an expired token", await sign(claimsFor({ exp: Math.floor(Date.now() / 1000) - 3600 })));
    await reject("a non-Google issuer", await sign(claimsFor({ iss: "https://evil.example" })));
    await reject("garbage", "not.a.jwt");
    const tampered = (await sign(claimsFor())).split(".");
    tampered[1] = b64url(JSON.stringify(claimsFor({ sub: "admin" })));
    await reject("a tampered payload", tampered.join("."));

    r = await call("login", req("POST", "login", { body: { credential: await sign(claimsFor()) }, origin: "https://evil.example" }));
    t.eq("login refuses a cross-site origin", r.status, 403);
    r = await call("login", req("POST", "login", { body: "credential=x", type: "application/x-www-form-urlencoded" }));
    t.eq("login refuses a form post", r.status, 403);

    // ── sign in ──
    r = await call("login", req("POST", "login", { body: { credential: await sign(claimsFor()) } }));
    t.eq("valid Google token signs in", r.status, 200);
    const setCookie = r.headers.get("Set-Cookie") || "";
    t.ok("session cookie is HttpOnly, Secure, SameSite=Lax",
      /HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Lax/.test(setCookie), setCookie.replace(/=[0-9a-f]{64}/, "=…"));
    const cookie = setCookie.split(";")[0];
    t.eq("login returns the profile and an empty list", await body(r),
      { user: { email: "a@example.com", name: "Ann", picture: "https://example.com/p.png" }, favourites: [] });
    const stored = await env.DB.prepare("SELECT token_hash FROM sessions").first();
    t.ok("only a hash of the session token is stored", stored && !cookie.includes(stored.token_hash));

    r = await call("me", req("GET", "me", { cookie }));
    t.eq("me with the cookie", (await body(r)).user.email, "a@example.com");
    r = await call("me", req("GET", "me"));
    t.eq("me without a cookie is 401", r.status, 401);
    r = await call("me", req("GET", "me", { cookie: "atlas_session=" + "0".repeat(64) }));
    t.eq("me with a made-up token is 401", r.status, 401);

    // ── favourites ──
    r = await call("favourites", req("PUT", "favourites", { body: { codes: ["2330", "6488", "2330", " 0050 "] }, cookie }));
    t.eq("favourites saved, normalised, de-duplicated", await body(r), { favourites: ["2330", "6488", "0050"] });
    r = await call("me", req("GET", "me", { cookie }));
    t.eq("favourites persist", (await body(r)).favourites, ["2330", "6488", "0050"]);
    r = await call("favourites", req("PUT", "favourites", { body: { codes: ["2330; DROP TABLE users"] }, cookie }));
    t.eq("non-code rejected", r.status, 400);
    r = await call("favourites", req("PUT", "favourites", { body: { codes: Array.from({ length: 101 }, (_, i) => String(1000 + i)) }, cookie }));
    t.eq("more than 100 rejected", r.status, 400);
    r = await call("favourites", req("PUT", "favourites", { body: { codes: ["2317"] } }));
    t.eq("favourites need a session", r.status, 401);
    r = await call("favourites", req("PUT", "favourites", { body: { codes: ["2317"] }, cookie, origin: "https://evil.example" }));
    t.eq("favourites refuse a cross-site origin", r.status, 403);

    // ── a second user is separate; re-login keeps the list ──
    const c2 = (await call("login", req("POST", "login", { body: { credential: await sign(claimsFor({ sub: "g-456", email: "b@example.com" })) } })))
      .headers.get("Set-Cookie").split(";")[0];
    t.eq("another user starts empty", (await body(await call("me", req("GET", "me", { cookie: c2 })))).favourites, []);
    const c3 = (await call("login", req("POST", "login", { body: { credential: await sign(claimsFor({ name: "Ann B." })) } })))
      .headers.get("Set-Cookie").split(";")[0];
    const again = await body(await call("me", req("GET", "me", { cookie: c3 })));
    t.eq("signing in again keeps the list and updates the profile", [again.favourites, again.user.name],
      [["2330", "6488", "0050"], "Ann B."]);

    // ── logout / expiry ──
    r = await call("logout", req("POST", "logout", { body: {}, cookie }));
    t.ok("logout clears the cookie", /Max-Age=0/.test(r.headers.get("Set-Cookie") || ""));
    t.eq("the old session no longer works", (await call("me", req("GET", "me", { cookie }))).status, 401);
    t.eq("other sessions of the same user survive", (await call("me", req("GET", "me", { cookie: c3 }))).status, 200);
    await env.DB.prepare("UPDATE sessions SET expires_at = 0").run();
    t.eq("an expired session is refused", (await call("me", req("GET", "me", { cookie: c3 }))).status, 401);

    t.eq("unknown method is 405", (await call("me", req("DELETE", "me", { cookie: c2 }))).status, 405);
  }
};
