/**
 * GET  /api/goals — merge seed goals.json with KV overrides (public, no token)
 * POST /api/goals — body { id, target, rev } updates the target for a goal id
 *                   requires header X-Board-Token (see functions/_lib/auth.js)
 */
import { responder, preflight, requireAuth } from '../_lib/auth.js';
import { checkRev, conflictBody, nextRev } from '../_lib/store.js';
import { readJson, trimmed, finite, LIMITS } from '../_lib/validate.js';

const KEY = 'goals';
const METHODS = 'GET, POST, OPTIONS';
const ID_SHAPE = /^[A-Za-z0-9_.-]+$/;

async function loadSeed(request) {
  try {
    const origin = new URL(request.url).origin;
    const res = await fetch(new URL('/data/goals.json', origin).toString());
    if (res.ok) return await res.json();
  } catch {
    /* ignore */
  }
  return null;
}

async function loadStore(env) {
  const raw = await env.FIXES.get(KEY);
  if (!raw) return { overrides: {} };
  try {
    const p = JSON.parse(raw);
    return { overrides: p.overrides || {}, rev: p.rev, updatedAt: p.updatedAt };
  } catch {
    return { overrides: {} };
  }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const json = responder(request, METHODS);
  const seed = (await loadSeed(request)) || { targets: [] };

  if (!env.FIXES) return json({ ...seed, source: 'seed', rev: 0 });

  const store = await loadStore(env);
  const overrides = store.overrides || {};
  const targets = (seed.targets || []).map((t) => ({
    ...t,
    target: overrides[t.id] != null ? overrides[t.id] : t.target,
  }));
  return json({
    targets,
    source: 'kv',
    rev: Number.isFinite(Number(store.rev)) ? Number(store.rev) : 0,
    // Honest timestamp: when a target last changed, not when this was requested.
    updatedAt: store.updatedAt || seed.updatedAt || null,
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const json = responder(request, METHODS);

  const denied = await requireAuth(request, env, json);
  if (denied) return denied;

  if (!env.FIXES) return json({ error: 'FIXES_KV_UNBOUND' }, 503);

  const parsed = await readJson(request, json);
  if (parsed.response) return parsed.response;
  const body = parsed.body;

  const id = trimmed(body.id, LIMITS.id);
  if (!id) return json({ error: 'missing id' }, 400);
  if (!ID_SHAPE.test(id)) return json({ error: 'invalid id' }, 400);

  // The id must name a goal that actually exists. Otherwise the overrides map is
  // an unbounded, attacker-chosen key space that nothing ever reads or prunes.
  const seed = await loadSeed(request);
  if (seed && Array.isArray(seed.targets) && seed.targets.length) {
    if (!seed.targets.some((t) => t.id === id)) {
      return json({ error: 'unknown goal id' }, 404);
    }
  }

  // WHY this check exists: body.target was stored verbatim, so an object or array
  // could land in a field the dashboard does arithmetic on. The goal inputs post
  // input.value, i.e. a string, so numeric strings are coerced; '' clears.
  const target = finite(body.target);
  if (target === undefined) {
    return json({ error: 'target must be a finite number or empty' }, 400);
  }

  const store = await loadStore(env);
  store.overrides = store.overrides || {};
  const isNew = store.overrides[id] === undefined;
  const conflict = checkRev(body, store, isNew);
  if (conflict) {
    return json(
      conflictBody(conflict, { id, target: store.overrides[id] ?? null }),
      409
    );
  }

  store.overrides[id] = target;
  store.rev = nextRev(store);
  store.updatedAt = new Date().toISOString();
  await env.FIXES.put(KEY, JSON.stringify(store));
  return json({ ok: true, id, target, rev: store.rev });
}

export async function onRequestOptions(context) {
  return preflight(context.request, METHODS);
}
