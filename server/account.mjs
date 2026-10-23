/**
 * Accounts for stock.html: Google sign-in, cookie sessions, a per-user list
 * of favourite stocks. Shared by the Pages Functions under functions/api/ (.mjs so Node tests can import it),
 * which are thin wrappers around handle().
 *
 * Runtime: Cloudflare Pages Functions (Workers). Needs, in the Pages project:
 *   DB                a D1 database binding (tables are created on first use)
 *   GOOGLE_CLIENT_ID  the OAuth client ID the sign-in button was issued for
 *
 * Sign-in flow: the page gets an ID token (a JWT signed by Google) from
 * Google Identity Services and POSTs it to /api/login. The token's signature,
 * issuer, audience and expiry are checked here against Google's published
 * keys; nothing else from the browser is trusted. A random session token is
 * then set as an HttpOnly cookie; only its SHA-256 is stored.
 *
 * Favourites are just a list. Which stocks get main-force / broker data is
 * still decided by the site owner's stocks.txt.
 */

const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const COOKIE = "atlas_session";
const SESSION_DAYS = 30;
const MAX_FAVOURITES = 100;
const CODE_RE = /^[0-9A-Z]{4,6}$/;
const CLOCK_SKEW = 60;   // seconds of leeway on exp / iat

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY, email TEXT, name TEXT, picture TEXT,
     favourites TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`
];

// ── Small helpers ─────────────────────────────────────────────

const now = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder();

function b64urlBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function sha256Hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...d].map(x => x.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8",
               "Cache-Control": "no-store", ...headers }
  });
}
const fail = (status, error) => json({ error }, status);

function cookieOf(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// ── Google ID token ───────────────────────────────────────────

let jwksCache = { keys: null, until: 0 };

async function googleKeys(fetchImpl) {
  if (jwksCache.keys && jwksCache.until > Date.now()) return jwksCache.keys;
  const r = await fetchImpl(GOOGLE_JWKS);
  if (!r.ok) throw new Error(`JWKS fetch failed: ${r.status}`);
  const age = /max-age=(\d+)/.exec(r.headers.get("Cache-Control") || "");
  const keys = (await r.json()).keys || [];
  jwksCache = { keys, until: Date.now() + (age ? +age[1] : 3600) * 1000 };
  return keys;
}

/**
 * Verify a Google ID token. Returns its claims, or throws with a reason.
 * `getKeys` is injectable so tests can sign with their own key pair.
 */
export async function verifyGoogleIdToken(token, clientId, { getKeys, at = now() } = {}) {
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  let header, c, sig;
  try {
    header = b64urlJson(parts[0]); c = b64urlJson(parts[1]); sig = b64urlBytes(parts[2]);
  } catch {
    throw new Error("malformed token");
  }
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  const keys = await (getKeys || (() => googleKeys(fetch)))();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, sig, enc.encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("bad signature");

  if (!GOOGLE_ISSUERS.includes(c.iss)) throw new Error("wrong issuer");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) throw new Error("wrong audience");
  if (typeof c.exp !== "number" || c.exp + CLOCK_SKEW < at) throw new Error("expired");
  if (typeof c.iat === "number" && c.iat - CLOCK_SKEW > at) throw new Error("issued in the future");
  if (!c.sub) throw new Error("no subject");
  return c;
}

// ── Storage ───────────────────────────────────────────────────

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  schemaReady = true;
}

export function cleanFavourites(codes) {
  if (!Array.isArray(codes)) throw new Error("codes must be an array");
  const out = [];
  for (const c of codes) {
    const code = String(c).trim().toUpperCase();
    if (!CODE_RE.test(code)) throw new Error(`not a stock code: ${String(c).slice(0, 12)}`);
    if (!out.includes(code)) out.push(code);
  }
  if (out.length > MAX_FAVOURITES) throw new Error(`at most ${MAX_FAVOURITES} stocks`);
  return out;
}

async function currentUser(request, db) {
  const token = cookieOf(request, COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await db.prepare(
    `SELECT u.id, u.email, u.name, u.picture, u.favourites, s.token_hash
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(await sha256Hex(token), now()).first();
  return row || null;
}

const publicUser = u => ({
  user: { email: u.email, name: u.name, picture: u.picture },
  favourites: JSON.parse(u.favourites || "[]")
});

// A state-changing request must come from this site: same Origin (when the
// browser sends one) and a JSON body, which a cross-site form cannot send.
function sameSite(request) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  return (request.headers.get("Content-Type") || "").startsWith("application/json");
}

// ── Routes ────────────────────────────────────────────────────

/**
 * route: "config" | "login" | "logout" | "me" | "favourites"
 * opts.getKeys: test hook for the Google key set.
 */
export async function handle(route, { request, env }, opts = {}) {
  const method = request.method;

  if (route === "config" && method === "GET") {
    // The client ID is public (it is in every sign-in button); serving it lets
    // the page stay free of deployment-specific values.
    return json({ googleClientId: env.GOOGLE_CLIENT_ID || null, accounts: !!(env.DB && env.GOOGLE_CLIENT_ID) });
  }

  if (!env.DB || !env.GOOGLE_CLIENT_ID) return fail(503, "accounts are not configured");
  const db = env.DB;
  await ensureSchema(db);

  if (route === "login" && method === "POST") {
    if (!sameSite(request)) return fail(403, "cross-site request");
    let body;
    try { body = await request.json(); } catch { return fail(400, "invalid JSON"); }
    let claims;
    try {
      claims = await verifyGoogleIdToken(body && body.credential, env.GOOGLE_CLIENT_ID,
                                         { getKeys: opts.getKeys });
    } catch (e) {
      return fail(401, `sign-in rejected: ${e.message}`);
    }
    const t = now();
    await db.prepare(
      `INSERT INTO users (id, email, name, picture, favourites, created_at, updated_at)
            VALUES (?, ?, ?, ?, '[]', ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name,
            picture = excluded.picture, updated_at = excluded.updated_at`)
      .bind(claims.sub, claims.email || null, claims.name || null, claims.picture || null, t, t).run();
    const token = randomToken();
    await db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`)
      .bind(await sha256Hex(token), claims.sub, t + SESSION_DAYS * 86400).run();
    // Opportunistic cleanup; there is no cron here.
    await db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(t).run();
    const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(claims.sub).first();
    return json(publicUser(user), 200, { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) });
  }

  if (route === "logout" && method === "POST") {
    if (!sameSite(request)) return fail(403, "cross-site request");
    const token = cookieOf(request, COOKIE);
    if (token) await db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256Hex(token)).run();
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }

  const user = await currentUser(request, db);

  if (route === "me" && method === "GET") {
    return user ? json(publicUser(user)) : fail(401, "not signed in");
  }

  if (route === "favourites" && method === "PUT") {
    if (!user) return fail(401, "not signed in");
    if (!sameSite(request)) return fail(403, "cross-site request");
    let codes;
    try { codes = cleanFavourites((await request.json()).codes); }
    catch (e) { return fail(400, e.message); }
    await db.prepare(`UPDATE users SET favourites = ?, updated_at = ? WHERE id = ?`)
      .bind(JSON.stringify(codes), now(), user.id).run();
    return json({ favourites: codes });
  }

  return fail(405, "method not allowed");
}
