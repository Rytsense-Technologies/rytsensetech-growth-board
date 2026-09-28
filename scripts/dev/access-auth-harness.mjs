#!/usr/bin/env node
/**
 * Harness for functions/_lib/auth.js — the Cloudflare Access path and the
 * unchanged shared-token path.
 *
 * WHY THIS EXISTS: "the header was present" is not verification, and the only way
 * to know this verifier actually rejects an expired, wrong-audience or unsigned
 * token is to mint those tokens and watch it say no. Nothing here touches the
 * network or the live site: a real RSA key pair is generated in-process with
 * WebCrypto, and the team's /cdn-cgi/access/certs endpoint is replaced with a
 * local stub via the module's test seam.
 *
 *   node scripts/dev/access-auth-harness.mjs
 *
 * Exits non-zero on the first failing case.
 */

import {
  requireAuth,
  callerOf,
  authenticate,
  AUTH_HEADER,
  ACCESS_HEADER,
  SERVICE_CALLER,
  __testing,
} from '../../functions/_lib/auth.js';

const TEAM = 'rytsensetech.cloudflareaccess.com';
const ISS = `https://${TEAM}`;
const AUD = 'a'.repeat(64);
const CERTS_URL = `${ISS}/cdn-cgi/access/certs`;
const TOKEN = 'board-token-for-the-publisher-cli';

const ENV = {
  BOARD_PUBLISH_TOKEN: TOKEN,
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
};

/* ---------------------------------------------------------------- *
 * Test crypto: real RS256 keys, minted locally.
 * ---------------------------------------------------------------- */

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function makeKeyPair(kid) {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

async function sign(keyPair, payload, headerOverrides = {}) {
  const header = { alg: 'RS256', typ: 'JWT', kid: keyPair.kid, ...headerOverrides };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(input)
  );
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function claims(extra = {}) {
  return {
    iss: ISS,
    aud: [AUD],
    email: 'priya@rytsensetech.com',
    exp: nowSec() + 600,
    nbf: nowSec() - 10,
    iat: nowSec() - 10,
    ...extra,
  };
}

/* ---------------------------------------------------------------- *
 * Fake certs endpoint. `state` lets a case make it fail or rotate.
 * ---------------------------------------------------------------- */

const certs = { keys: [], fetches: 0, fail: false };

function installFakeFetch() {
  __testing.setFetch(async (url) => {
    certs.fetches += 1;
    if (String(url) !== CERTS_URL) throw new Error(`unexpected fetch: ${url}`);
    if (certs.fail) throw new Error('simulated network failure');
    return {
      ok: true,
      status: 200,
      json: async () => ({ keys: certs.keys.map((k) => k.jwk) }),
    };
  });
}

/* ---------------------------------------------------------------- *
 * Request/response doubles — Pages Functions shapes, nothing more.
 * ---------------------------------------------------------------- */

function req(headers = {}) {
  return new Request('https://rytsensetech-growth-board.pages.dev/api/tasks', {
    method: 'POST',
    headers,
  });
}

/** Same signature the endpoints' responder() produces. */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

/* ---------------------------------------------------------------- *
 * Runner
 * ---------------------------------------------------------------- */

let failures = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push(`  PASS  ${name}`);
  } catch (e) {
    failures += 1;
    results.push(`  FAIL  ${name}\n          ${e && e.message ? e.message : e}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** Run requireAuth and report {allowed, caller, status, body}. */
async function gate(request, env = ENV) {
  const denied = await requireAuth(request, env, json);
  if (!denied) return { allowed: true, caller: callerOf(request), status: 200 };
  return { allowed: false, status: denied.status, body: await denied.json() };
}

async function main() {
  installFakeFetch();
  const primary = await makeKeyPair('kid-primary');
  const rotated = await makeKeyPair('kid-rotated');
  certs.keys = [primary];

  await check('valid Access JWT passes and yields the email as caller', async () => {
    __testing.resetKeyCache();
    const jwt = await sign(primary, claims());
    const r = await gate(req({ [ACCESS_HEADER]: jwt }));
    assert(r.allowed, `expected allow, got ${r.status} ${JSON.stringify(r.body)}`);
    assert(
      r.caller === 'priya@rytsensetech.com',
      `caller was ${r.caller}, expected the email claim`
    );
  });

  await check('expired Access JWT is refused with 401 ACCESS_EXPIRED', async () => {
    __testing.resetKeyCache();
    const jwt = await sign(primary, claims({ exp: nowSec() - 3600, nbf: nowSec() - 7200 }));
    const r = await gate(req({ [ACCESS_HEADER]: jwt }));
    assert(!r.allowed && r.status === 401, 'expected a 401');
    assert(r.body.reason === 'ACCESS_EXPIRED', `reason was ${r.body.reason}`);
  });

  await check('wrong-audience Access JWT is refused', async () => {
    __testing.resetKeyCache();
    const jwt = await sign(primary, claims({ aud: ['b'.repeat(64)] }));
    const r = await gate(req({ [ACCESS_HEADER]: jwt }));
    assert(!r.allowed && r.status === 401, 'expected a 401');
    assert(r.body.reason === 'ACCESS_BAD_AUDIENCE', `reason was ${r.body.reason}`);
  });

  await check('wrong-issuer Access JWT is refused', async () => {
    __testing.resetKeyCache();
    const jwt = await sign(primary, claims({ iss: 'https://evil.cloudflareaccess.com' }));
    const r = await gate(req({ [ACCESS_HEADER]: jwt }));
    assert(!r.allowed && r.body.reason === 'ACCESS_BAD_ISSUER', `reason ${r.body?.reason}`);
  });

  await check('a tampered payload fails the signature check', async () => {
    __testing.resetKeyCache();
    const jwt = await sign(primary, claims());
    const [h, , s] = jwt.split('.');
    const forged = `${h}.${b64url(
      JSON.stringify(claims({ email: 'attacker@example.com' }))
    )}.${s}`;
    const r = await gate(req({ [ACCESS_HEADER]: forged }));
    assert(!r.allowed && r.body.reason === 'ACCESS_BAD_SIGNATURE', `reason ${r.body?.reason}`);
  });

  await check('an unsigned "alg:none" token is refused before any key lookup', async () => {
    __testing.resetKeyCache();
    const t = `${b64url(JSON.stringify({ alg: 'none', kid: 'kid-primary' }))}.${b64url(
      JSON.stringify(claims())
    )}.`;
    const r = await gate(req({ [ACCESS_HEADER]: t }));
    assert(!r.allowed && r.body.reason === 'ACCESS_BAD_ALG', `reason ${r.body?.reason}`);
  });

  await check('a malformed token is refused', async () => {
    __testing.resetKeyCache();
    const r = await gate(req({ [ACCESS_HEADER]: 'not-a-jwt' }));
    assert(!r.allowed && r.body.reason === 'ACCESS_MALFORMED', `reason ${r.body?.reason}`);
  });

  await check('an unknown kid triggers exactly one re-fetch, then passes', async () => {
    __testing.resetKeyCache();
    certs.keys = [primary];
    // Warm the cache so the rotated key genuinely is "unknown" at request time.
    await gate(req({ [ACCESS_HEADER]: await sign(primary, claims()) }));
    certs.keys = [primary, rotated]; // Cloudflare rotated inside our TTL
    const before = certs.fetches;
    const r = await gate(req({ [ACCESS_HEADER]: await sign(rotated, claims()) }));
    assert(r.allowed, `expected allow after re-fetch, got ${JSON.stringify(r.body)}`);
    assert(
      certs.fetches === before + 1,
      `expected 1 re-fetch, saw ${certs.fetches - before}`
    );
  });

  await check('a kid that is unknown even after the re-fetch is refused', async () => {
    __testing.resetKeyCache();
    certs.keys = [primary];
    const ghost = await makeKeyPair('kid-never-published');
    const r = await gate(req({ [ACCESS_HEADER]: await sign(ghost, claims()) }));
    assert(!r.allowed && r.body.reason === 'ACCESS_UNKNOWN_KID', `reason ${r.body?.reason}`);
  });

  await check('a junk kid repeated in a loop does not re-fetch every time', async () => {
    __testing.resetKeyCache();
    certs.keys = [primary];
    const ghost = await makeKeyPair('kid-junk');
    await gate(req({ [ACCESS_HEADER]: await sign(ghost, claims()) })); // 2 fetches
    const before = certs.fetches;
    for (let i = 0; i < 5; i += 1) {
      const r = await gate(req({ [ACCESS_HEADER]: await sign(ghost, claims()) }));
      assert(!r.allowed, 'a junk kid must stay refused');
    }
    assert(certs.fetches === before, `expected 0 further fetches, saw ${certs.fetches - before}`);
  });

  await check('a JWKS fetch failure DENIES (never allows)', async () => {
    __testing.resetKeyCache();
    certs.fail = true;
    try {
      const r = await gate(req({ [ACCESS_HEADER]: await sign(primary, claims()) }));
      assert(!r.allowed, 'a certs outage must not authorise anyone');
      assert(r.status === 401, `expected 401, got ${r.status}`);
      assert(
        r.body.reason === 'ACCESS_KEYS_UNAVAILABLE',
        `reason was ${r.body.reason}`
      );
    } finally {
      certs.fail = false;
    }
  });

  await check('a failed fetch is not cached as an empty key set', async () => {
    __testing.resetKeyCache();
    certs.fail = true;
    await gate(req({ [ACCESS_HEADER]: await sign(primary, claims()) }));
    certs.fail = false;
    certs.keys = [primary];
    const r = await gate(req({ [ACCESS_HEADER]: await sign(primary, claims()) }));
    assert(r.allowed, 'the next request after an outage should verify normally');
  });

  await check('token path still works and records service:publisher', async () => {
    __testing.resetKeyCache();
    const r = await gate(req({ [AUTH_HEADER]: TOKEN }));
    assert(r.allowed, `expected allow, got ${JSON.stringify(r.body)}`);
    assert(r.caller === SERVICE_CALLER, `caller was ${r.caller}`);
  });

  await check('a wrong token is still 401 BAD_TOKEN, body shape unchanged', async () => {
    __testing.resetKeyCache();
    const r = await gate(req({ [AUTH_HEADER]: 'wrong' }));
    assert(!r.allowed && r.status === 401, 'expected a 401');
    assert(r.body.error === 'unauthorized', 'error field changed');
    assert(r.body.reason === 'BAD_TOKEN', `reason was ${r.body.reason}`);
    assert(typeof r.body.message === 'string', 'message field missing');
  });

  await check('no credential at all is 401', async () => {
    __testing.resetKeyCache();
    const r = await gate(req());
    assert(!r.allowed && r.body.reason === 'BAD_TOKEN', `reason ${r.body?.reason}`);
  });

  await check('an unset BOARD_PUBLISH_TOKEN still fails CLOSED', async () => {
    __testing.resetKeyCache();
    const r = await gate(req({ [AUTH_HEADER]: TOKEN }), { ...ENV, BOARD_PUBLISH_TOKEN: '' });
    assert(!r.allowed && r.body.reason === 'SECRET_UNSET', `reason ${r.body?.reason}`);
  });

  await check('missing Access config: Access unavailable, token path unaffected', async () => {
    __testing.resetKeyCache();
    const local = { BOARD_PUBLISH_TOKEN: TOKEN }; // wrangler pages dev
    const jwt = await sign(primary, claims());

    const viaAccess = await gate(req({ [ACCESS_HEADER]: jwt }), local);
    assert(!viaAccess.allowed, 'an unconfigured Access path must not authorise');
    assert(
      viaAccess.body.reason === 'ACCESS_NOT_CONFIGURED',
      `reason was ${viaAccess.body.reason}`
    );

    const viaToken = await gate(req({ [AUTH_HEADER]: TOKEN }), local);
    assert(viaToken.allowed, 'the token path must keep working locally');
    assert(viaToken.caller === SERVICE_CALLER, `caller was ${viaToken.caller}`);
  });

  await check('a bad Access token does not block a valid X-Board-Token', async () => {
    __testing.resetKeyCache();
    const stale = await sign(primary, claims({ exp: nowSec() - 3600 }));
    const r = await gate(req({ [ACCESS_HEADER]: stale, [AUTH_HEADER]: TOKEN }));
    assert(r.allowed, 'a machine sending both should still authenticate as a machine');
    assert(r.caller === SERVICE_CALLER, `caller was ${r.caller}`);
  });

  await check('callerOf falls back to "dashboard" without a successful gate', async () => {
    const r = req();
    assert(callerOf(r) === 'dashboard', `fallback was ${callerOf(r)}`);
  });

  await check('authenticate() reports the decision without a Response', async () => {
    __testing.resetKeyCache();
    const ok = await authenticate(req({ [AUTH_HEADER]: TOKEN }), ENV);
    assert(ok.ok && ok.caller === SERVICE_CALLER, 'expected ok/service:publisher');
    const bad = await authenticate(req({ [AUTH_HEADER]: 'nope' }), ENV);
    assert(!bad.ok && bad.status === 401, 'expected a refusal with status 401');
  });

  console.log('\nauth.js — Cloudflare Access + shared token\n');
  console.log(results.join('\n'));
  const total = results.length;
  console.log(`\n${total - failures}/${total} passed\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
