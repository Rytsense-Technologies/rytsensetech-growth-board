/**
 * GET  /api/activity — list activity log, seed file merged with KV (public, no token)
 * POST /api/activity — append {date, who, activityType, url, note}
 *                      requires header X-Board-Token (see functions/_lib/auth.js)
 * Reuses FIXES KV namespace with key "activity"
 *
 * WHY this one needs auth as much as any other: this log is the audit trail every
 * other endpoint writes into, and it is capped at 500 entries — so anonymous
 * flooding did not just add noise, it EVICTED the team's real history.
 */
import { responder, preflight, requireAuth, callerOf } from '../_lib/auth.js';
import { checkRev, conflictBody, nextRev } from '../_lib/store.js';
import {
  readJson,
  trimmed,
  str,
  pick,
  dateish,
  LIMITS,
  ACTIVITY_TYPES,
} from '../_lib/validate.js';

const KEY = 'activity';
const METHODS = 'GET, POST, OPTIONS';
const MAX_ENTRIES = 500;

async function loadKv(env) {
  if (!env.FIXES) return null;
  const raw = await env.FIXES.get(KEY);
  if (!raw) return { entries: [] };
  try {
    const p = JSON.parse(raw);
    return { entries: p.entries || [], rev: p.rev, updatedAt: p.updatedAt };
  } catch {
    return { entries: [] };
  }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const json = responder(request, METHODS);
  let seed = { entries: [] };
  try {
    const origin = new URL(request.url).origin;
    const res = await fetch(new URL('/data/activity.json', origin).toString());
    if (res.ok) seed = await res.json();
  } catch { /* ignore */ }

  const kv = await loadKv(env);
  if (!kv) {
    return json({ ...seed, source: 'seed', rev: 0, warning: 'FIXES_KV_UNBOUND' });
  }
  const map = new Map();
  (seed.entries || []).forEach((e, i) => map.set(e.id || `seed-${i}`, e));
  (kv.entries || []).forEach((e) => map.set(e.id, e));
  const entries = Array.from(map.values()).sort((a, b) =>
    String(b.date || '').localeCompare(String(a.date || ''))
  );
  return json({
    entries,
    source: 'kv',
    rev: Number.isFinite(Number(kv.rev)) ? Number(kv.rev) : 0,
    updatedAt: kv.updatedAt || seed.updatedAt || null,
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

  const date = dateish(body.date) || new Date().toISOString();
  if (body.date != null && dateish(body.date) === undefined) {
    return json({ error: 'invalid date' }, 400);
  }
  const activityType =
    body.activityType == null ? 'note' : pick(body.activityType, ACTIVITY_TYPES);
  if (activityType === undefined) {
    return json({ error: 'invalid activityType', allowed: ACTIVITY_TYPES }, 400);
  }
  const note = str(body.note, LIMITS.note);
  if (note == null && body.note != null) return json({ error: 'invalid note' }, 400);

  const entry = {
    id: trimmed(body.id, LIMITS.id) || `a-${Date.now()}`,
    date,
    who: trimmed(body.who, LIMITS.person) || callerOf(request),
    activityType,
    url: trimmed(body.url, LIMITS.url),
    note: note || '',
  };

  const kv = (await loadKv(env)) || { entries: [] };
  // An append with a fresh id creates a new record, so it needs no rev. Reusing
  // an existing entry id rewrites history and must echo the current rev.
  const isNew = !(kv.entries || []).some((e) => e && e.id === entry.id);
  const conflict = checkRev(body, kv, isNew);
  if (conflict) {
    return json(conflictBody(conflict, { id: entry.id }), 409);
  }

  kv.entries = [entry, ...(kv.entries || []).filter((e) => e && e.id !== entry.id)].slice(
    0,
    MAX_ENTRIES
  );
  kv.rev = nextRev(kv);
  kv.updatedAt = new Date().toISOString();
  await env.FIXES.put(KEY, JSON.stringify(kv));
  return json({ ok: true, entry, rev: kv.rev });
}

export async function onRequestOptions(context) {
  return preflight(context.request, METHODS);
}
