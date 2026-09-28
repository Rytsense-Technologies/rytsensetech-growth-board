/**
 * Shared fail-closed auth + narrowed CORS for the Growth Board write API.
 *
 * WHY THIS EXISTS
 * Until 2026-09-28 every mutating endpoint (tasks, tasks/:id, fixes/:id, goals,
 * team, activity) accepted anonymous writes, and engagements.js had a check that
 * returned `true` when BOARD_PUBLISH_TOKEN was unset — i.e. it failed OPEN, which
 * on a board with no secret configured is the same as no check at all. One POST to
 * /api/team with action:"replace" could wipe the whole roster; one POST to
 * /api/tasks/:id could silently rewrite any task. Combined with
 * `Access-Control-Allow-Origin: *`, any page on the internet could script those
 * writes cross-origin. Hence: one helper, fail CLOSED, used by every writer.
 *
 * WHY A SECOND CREDENTIAL (Cloudflare Access)
 * A shared token is the right credential for a machine and the wrong one for a
 * person. The board URL is posted to a Slack channel every day, so "knows the URL"
 * was never access control: six write endpoints were reachable by anyone who had
 * seen that message. And one token shared by five humans cannot answer "who
 * changed this?" — which is why every activity and history entry recorded the
 * actor as the literal string `dashboard`. Cloudflare Access sits in front of the
 * Pages domain, authenticates the humans against the identity provider, and stamps
 * each request with a signed JWT carrying their email. We verify that JWT
 * ourselves rather than trusting the header's presence: the header is trustworthy
 * because the signature is checked, not because Cloudflare usually strips
 * client-supplied copies of it.
 *
 * TWO ACCEPTED CREDENTIALS, both fail closed:
 *   1. `X-Board-Token: <BOARD_PUBLISH_TOKEN>`  → caller "service:publisher"
 *      (publisher CLI, scheduled jobs — unchanged in every respect)
 *   2. `Cf-Access-Jwt-Assertion: <JWT>`        → caller = the Access `email` claim
 *
 * DEPLOYMENT — writes return 401 until this secret exists:
 *
 *   wrangler pages secret put BOARD_PUBLISH_TOKEN --project-name rytsensetech-growth-board
 *
 * (or Cloudflare dashboard → Pages → the project → Settings → Environment
 * variables → add BOARD_PUBLISH_TOKEN as an encrypted secret, then redeploy.)
 * The 401 body names the missing secret on purpose, so an operator hitting a dead
 * Save button gets a cause instead of a mystery.
 *
 * For the Access path set ACCESS_TEAM_DOMAIN and ACCESS_AUD as plain (non-secret)
 * environment variables — see docs/ACCESS.md.
 *
 * Contract: GET stays public (the dashboards read without a token), except
 * /api/export which is a whole-board backup and is gated like the writers. Every
 * POST requires one of the two credentials above.
 */

/** The Pages origins that may drive this API from a browser. */
const ALLOWED_ORIGINS = [
  'https://rytsensetech-growth-board.pages.dev',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
];

/** Cloudflare gives every preview deploy <hash>.<project>.pages.dev — allow those too. */
const PREVIEW_SUFFIX = '.rytsensetech-growth-board.pages.dev';

const ALLOWED_HEADERS = 'Content-Type, X-Board-Token';

export const AUTH_HEADER = 'X-Board-Token';
export const SECRET_NAME = 'BOARD_PUBLISH_TOKEN';

/** Cloudflare Access injects this on every request that passed its policy. */
export const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion';

/** Identity recorded for the shared-token path. Not a person; the name says so. */
export const SERVICE_CALLER = 'service:publisher';

/** Clock skew tolerated on exp/nbf. Access tokens are minted one hop away. */
const CLOCK_SKEW_SECONDS = 60;

/** How long a fetched JWKS stays usable before we go back to the team domain. */
const JWKS_TTL_MS = 10 * 60 * 1000;

/**
 * Floor between JWKS fetches triggered by an unknown `kid`, so a junk kid sent in
 * a loop cannot turn this Function into a fetch amplifier against our own edge.
 */
const JWKS_REFETCH_MIN_MS = 30 * 1000;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && u.hostname.endsWith(PREVIEW_SUFFIX);
  } catch {
    return false;
  }
}

/**
 * CORS headers for a response. An un-allow-listed (or absent) Origin gets NO
 * Access-Control-Allow-Origin at all — same-origin dashboard fetches never need
 * it, and server-to-server callers (publish-to-board.mjs) send no Origin.
 *
 * Cf-Access-Jwt-Assertion is deliberately NOT added to Access-Control-Allow-Headers:
 * it is injected at the edge, never set by page JavaScript, so advertising it would
 * only invite a client to try supplying its own.
 */
export function corsHeaders(request, methods) {
  const origin = request ? request.headers.get('Origin') : null;
  const headers = {
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    Vary: 'Origin',
  };
  if (isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/**
 * Build this route's json() helper. Keeps the existing `json(data, status)` call
 * style while binding the request (for Origin echo) and the route's real methods.
 */
export function responder(request, methods) {
  return function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...corsHeaders(request, methods),
      },
    });
  };
}

/** Standard OPTIONS preflight for a route. Advertises only what the route serves. */
export function preflight(request, methods) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, methods),
  });
}

/**
 * Constant-time compare. Hashing first keeps the comparison length-independent,
 * so a wrong-length token leaks nothing through timing either.
 */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const xa = new Uint8Array(ha);
  const xb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < xa.length; i += 1) diff |= xa[i] ^ xb[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * Cloudflare Access JWT verification
 * ------------------------------------------------------------------ */

function base64UrlToBytes(input) {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJsonSegment(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

/**
 * Normalise ACCESS_TEAM_DOMAIN. Operators copy it from the dashboard in three
 * shapes — "acme", "acme.cloudflareaccess.com", "https://acme.cloudflareaccess.com"
 * — and the issuer check must not depend on which one was pasted.
 */
function teamOrigin(teamDomain) {
  const raw = String(teamDomain || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  const host = raw.replace(/^https?:\/\//, '');
  if (!host || host.includes('/')) return null;
  const full = host.includes('.') ? host : `${host}.cloudflareaccess.com`;
  return `https://${full}`;
}

/**
 * Module-scope key cache. One isolate serves many requests, so this turns "a JWKS
 * fetch per API call" into "one per TTL per isolate". Only SUCCESSFUL fetches are
 * cached: remembering a failure as an empty key set would later read as "no key
 * matched", which is a quieter and more misleading failure than a live one.
 */
const jwksCache = {
  origin: null,
  keys: null,
  fetchedAt: 0,
  lastForcedAt: 0,
};

/**
 * Test seam: the harness under scripts/dev swaps this to serve a fake JWKS and to
 * simulate a certs endpoint that is down. Production always uses global fetch.
 */
let fetchImpl = (...args) => fetch(...args);

async function loadJwks(origin, { force = false } = {}) {
  const now = Date.now();
  const fresh =
    jwksCache.origin === origin &&
    jwksCache.keys &&
    now - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (fresh && !force) return jwksCache.keys;
  // The floor counts only FORCED re-fetches. Counting ordinary TTL fetches too
  // would make a genuine key rotation invisible for the length of the floor,
  // which is the failure this re-fetch exists to prevent.
  if (force && jwksCache.keys && now - jwksCache.lastForcedAt < JWKS_REFETCH_MIN_MS) {
    return jwksCache.keys;
  }
  if (force) jwksCache.lastForcedAt = now;
  // Any failure here throws, and the caller turns the throw into a 401. There is
  // deliberately no fallback to "allow": an unreachable certs endpoint means we
  // cannot tell a real token from a forged one, and that is a refusal.
  const res = await fetchImpl(`${origin}/cdn-cgi/access/certs`);
  if (!res || !res.ok) {
    throw new Error(`certs fetch failed: ${res ? res.status : 'no response'}`);
  }
  const body = await res.json();
  const keys = Array.isArray(body && body.keys) ? body.keys : null;
  if (!keys || !keys.length) throw new Error('certs response had no keys');

  jwksCache.origin = origin;
  jwksCache.keys = keys;
  jwksCache.fetchedAt = now;
  return keys;
}

async function verifySignature(jwk, signingInput, signature) {
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature,
    new TextEncoder().encode(signingInput)
  );
}

function audienceMatches(aud, expected) {
  if (Array.isArray(aud)) return aud.includes(expected);
  return aud === expected;
}

/**
 * Verify a Cloudflare Access JWT end to end. Returns { ok: true, email } or
 * { ok: false, reason }. Never throws for a bad token — a bad token is an answer,
 * not an accident — and never returns ok for a token it could not check.
 */
async function verifyAccessJwt(token, env) {
  const origin = teamOrigin(env.ACCESS_TEAM_DOMAIN);
  const expectedAud = String(env.ACCESS_AUD || '').trim();
  if (!origin || !expectedAud) return { ok: false, reason: 'ACCESS_NOT_CONFIGURED' };

  const parts = String(token).split('.');
  if (parts.length !== 3) return { ok: false, reason: 'ACCESS_MALFORMED' };

  let header;
  let payload;
  try {
    header = decodeJsonSegment(parts[0]);
    payload = decodeJsonSegment(parts[1]);
  } catch {
    return { ok: false, reason: 'ACCESS_MALFORMED' };
  }

  // Pin the algorithm. Trusting whatever `alg` the token names is how "alg:none"
  // and RS256→HS256 confusion get in; this verifier only ever does RS256.
  if (!header || header.alg !== 'RS256' || !header.kid) {
    return { ok: false, reason: 'ACCESS_BAD_ALG' };
  }

  let signature;
  try {
    signature = base64UrlToBytes(parts[2]);
  } catch {
    return { ok: false, reason: 'ACCESS_MALFORMED' };
  }

  let keys;
  try {
    keys = await loadJwks(origin);
    if (!keys.some((k) => k.kid === header.kid)) {
      // An unknown kid usually means Cloudflare rotated the signing key inside our
      // cache window. Re-fetch once before concluding the token is bogus.
      keys = await loadJwks(origin, { force: true });
    }
  } catch {
    return { ok: false, reason: 'ACCESS_KEYS_UNAVAILABLE' };
  }

  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'ACCESS_UNKNOWN_KID' };

  let valid = false;
  try {
    valid = await verifySignature(jwk, `${parts[0]}.${parts[1]}`, signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'ACCESS_BAD_SIGNATURE' };

  // Claims are only worth reading once the signature says they are Cloudflare's.
  if (payload.iss !== origin) return { ok: false, reason: 'ACCESS_BAD_ISSUER' };
  if (!audienceMatches(payload.aud, expectedAud)) {
    return { ok: false, reason: 'ACCESS_BAD_AUDIENCE' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || nowSec > payload.exp + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'ACCESS_EXPIRED' };
  }
  if (typeof payload.nbf === 'number' && nowSec < payload.nbf - CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'ACCESS_NOT_YET_VALID' };
  }

  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  if (!email) return { ok: false, reason: 'ACCESS_NO_IDENTITY' };
  return { ok: true, email };
}

/* ------------------------------------------------------------------ *
 * Caller identity
 * ------------------------------------------------------------------ */

/**
 * Identity of the authenticated caller, keyed by the Request object. A WeakMap
 * rather than a changed return value, so `if (denied) return denied;` keeps
 * meaning exactly what it means today in all seven endpoints: the gate is
 * unchanged, the identity is an extra fact they can now ask for. Entries are
 * collected with the request.
 */
const callers = new WeakMap();

/**
 * Who authenticated this request: the Access email, SERVICE_CALLER for the token
 * path, or `fallback` when asked without a successful requireAuth. The fallback
 * keeps the old literal `dashboard` as the worst case rather than writing an empty
 * or invented actor into history.
 *
 *   who: trimmed(body.who, LIMITS.person) || callerOf(request),
 */
export function callerOf(request, fallback = 'dashboard') {
  return callers.get(request) || fallback;
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

/**
 * Authenticate a request against both accepted credentials. Returns
 * { ok: true, caller } or { ok: false, status, body }. Exported for the harness
 * and for any caller that wants the decision without a Response; the endpoints
 * use requireAuth().
 */
export async function authenticate(request, env) {
  const accessToken = request.headers.get(ACCESS_HEADER);
  if (accessToken) {
    const result = await verifyAccessJwt(accessToken, env);
    if (result.ok) return { ok: true, caller: result.email };

    // An Access token that was presented and did not verify is a refusal in its
    // own right. It never falls through to the token path — but a caller that also
    // sent X-Board-Token is still allowed to be the machine it claims to be.
    if (!request.headers.get(AUTH_HEADER)) {
      return {
        ok: false,
        status: 401,
        body: {
          error: 'unauthorized',
          reason: result.reason,
          message:
            result.reason === 'ACCESS_NOT_CONFIGURED'
              ? 'Cloudflare Access is not configured on this deployment ' +
                `(ACCESS_TEAM_DOMAIN / ACCESS_AUD). Use ${AUTH_HEADER} instead.`
              : 'The Cloudflare Access token did not verify. Reload the board to ' +
                're-authenticate with Access.',
        },
      };
    }
  }

  const required = env[SECRET_NAME];
  if (!required) {
    // Fail CLOSED. Say which secret is missing so the failure explains itself.
    return {
      ok: false,
      status: 401,
      body: {
        error: 'unauthorized',
        reason: 'SECRET_UNSET',
        secret: SECRET_NAME,
        message:
          `${SECRET_NAME} is not set on this deployment, so writes are refused. ` +
          `Set it with: wrangler pages secret put ${SECRET_NAME} --project-name rytsensetech-growth-board`,
      },
    };
  }

  const got = request.headers.get(AUTH_HEADER) || '';
  if (!got || !(await safeEqual(got, required))) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'unauthorized',
        reason: 'BAD_TOKEN',
        message: `Send header ${AUTH_HEADER} with the value of ${SECRET_NAME}.`,
      },
    };
  }

  return { ok: true, caller: SERVICE_CALLER };
}

/**
 * Gate a mutating handler. Returns null when the caller is authorised, or a ready
 * 401 Response when it is not. Never returns "allowed" because config is missing —
 * an unset secret is a refusal, not a bypass.
 *
 * MISSING ACCESS CONFIGURATION IS NOT A BYPASS. When ACCESS_TEAM_DOMAIN or
 * ACCESS_AUD are absent — local `wrangler pages dev`, or a preview deploy that
 * never received the variables — the Access credential is simply UNAVAILABLE:
 * every Access token is refused because there is nothing to verify it against, and
 * the X-Board-Token path keeps working exactly as before. There is no state of
 * this file in which auth is skipped.
 *
 *   const denied = await requireAuth(request, env, json);
 *   if (denied) return denied;
 *   // ...and later, for the actor: callerOf(request)
 */
export async function requireAuth(request, env, json) {
  const result = await authenticate(request, env);
  if (result.ok) {
    callers.set(request, result.caller);
    return null;
  }
  return json(result.body, result.status);
}

/**
 * Test-only seams, used by scripts/dev/access-auth-harness.mjs. Exported because
 * this file has no dependencies and no build step, so there is nowhere else to
 * inject a fake certs endpoint or reset a module-scope cache between cases.
 * Production code never calls these.
 */
export const __testing = {
  setFetch(fn) {
    fetchImpl = fn || ((...args) => fetch(...args));
  },
  resetKeyCache() {
    jwksCache.origin = null;
    jwksCache.keys = null;
    jwksCache.fetchedAt = 0;
    jwksCache.lastForcedAt = 0;
  },
  jwksCache,
  teamOrigin,
};
