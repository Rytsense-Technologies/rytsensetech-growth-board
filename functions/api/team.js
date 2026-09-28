/**
 * GET  /api/team — seed data/team.json ∪ KV members (public, no token)
 * POST /api/team — { action:'add'|'remove'|'replace', member?, id?, members?, rev? }
 *                  requires header X-Board-Token (see functions/_lib/auth.js)
 * KV key "team": { members:[], history:[], rev, updatedAt }
 */
import { responder, preflight, requireAuth, callerOf } from '../_lib/auth.js';
import { checkRev, conflictBody, nextRev, recordChanges, change } from '../_lib/store.js';
import { readJson, trimmed, pick, LIMITS, TEAMS } from '../_lib/validate.js';

const KEY = 'team';
const METHODS = 'GET, POST, OPTIONS';
const MAX_MEMBERS = 100;
const COLOR_SHAPE = /^#[0-9A-Fa-f]{3,8}$/;
const ID_SHAPE = /^[A-Za-z0-9_.-]+$/;

const COLORS = ['#0d9488', '#c2410c', '#146c43', '#b45309', '#7c3aed', '#0369a1', '#be123c'];

async function loadSeed(request) {
  try {
    const origin = new URL(request.url).origin;
    const res = await fetch(new URL('/data/team.json', origin).toString());
    if (res.ok) return await res.json();
  } catch {
    /* ignore */
  }
  return { members: [] };
}

async function loadKv(env) {
  if (!env.FIXES) return null;
  const raw = await env.FIXES.get(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Shape a member. Returns null when the input cannot be trusted. */
function normalizeMember(input, fallbackColor) {
  if (!input || typeof input !== 'object') return null;
  const name = trimmed(input.name, LIMITS.name);
  if (!name) return null;
  const team = input.team == null ? 'Development' : pick(input.team, TEAMS);
  if (team === undefined) return null;
  const id = trimmed(input.id, LIMITS.id);
  if (id && !ID_SHAPE.test(id)) return null;
  const color = trimmed(input.color, 20);
  if (color && !COLOR_SHAPE.test(color)) return null;
  return {
    id:
      id ||
      `m-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${Date.now()
        .toString(36)
        .slice(-3)}`,
    name,
    team,
    color: color || fallbackColor,
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const json = responder(request, METHODS);
  const seed = await loadSeed(request);
  const kv = await loadKv(env);
  const members = (kv && kv.members) || seed.members || [];
  return json({
    members,
    source: kv ? 'kv' : 'seed',
    rev: kv && Number.isFinite(Number(kv.rev)) ? Number(kv.rev) : 0,
    updatedAt: (kv && kv.updatedAt) || seed.updatedAt || null,
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

  const seed = await loadSeed(request);
  const store = (await loadKv(env)) || { members: seed.members || [] };
  let members = Array.isArray(store.members) ? [...store.members] : [];

  // 'add' creates a record that does not exist yet, so it is safe without a rev.
  // 'replace' and 'remove' mutate the existing roster — action:"replace" used to
  // let one anonymous request wipe all five members with no backup and no
  // history — so they must echo the rev from GET /api/team.
  const isNew = body.action === 'add';
  const conflict = checkRev(body, store, isNew);
  if (conflict) {
    return json(conflictBody(conflict, { members }), 409);
  }

  const who = trimmed(body.who, LIMITS.person) || callerOf(request);
  const now = new Date().toISOString();
  const changes = [];

  if (body.action === 'replace' && Array.isArray(body.members)) {
    if (body.members.length > MAX_MEMBERS) {
      return json({ error: 'too many members', max: MAX_MEMBERS }, 400);
    }
    const next = [];
    for (let i = 0; i < body.members.length; i += 1) {
      const m = normalizeMember(body.members[i], COLORS[i % COLORS.length]);
      if (!m) return json({ error: `invalid member at index ${i}`, allowedTeams: TEAMS }, 400);
      next.push(m);
    }
    changes.push(
      change('team', 'members', members.map((m) => m.name).join(','), next.map((m) => m.name).join(','), who, now)
    );
    members = next;
  } else if (body.action === 'remove' && body.id) {
    const id = trimmed(body.id, LIMITS.id);
    const gone = members.find((m) => m.id === id);
    if (!gone) return json({ error: 'unknown member id' }, 404);
    changes.push(change('team', 'removed', gone.name, null, who, now));
    members = members.filter((m) => m.id !== id);
  } else if (body.action === 'add' && body.member) {
    if (members.length >= MAX_MEMBERS) {
      return json({ error: 'too many members', max: MAX_MEMBERS }, 400);
    }
    const member = normalizeMember(body.member, COLORS[members.length % COLORS.length]);
    if (!member) return json({ error: 'invalid member', allowedTeams: TEAMS }, 400);
    if (members.some((m) => String(m.name).toLowerCase() === member.name.toLowerCase())) {
      return json({ error: 'member exists' }, 409);
    }
    changes.push(change('team', 'added', null, member.name, who, now));
    members.push(member);
  } else {
    return json({ error: 'invalid action' }, 400);
  }

  store.members = members;
  recordChanges(store, changes);
  store.rev = nextRev(store);
  store.updatedAt = now;
  await env.FIXES.put(KEY, JSON.stringify(store));
  return json({ ok: true, members: store.members, rev: store.rev, updatedAt: store.updatedAt });
}

export async function onRequestOptions(context) {
  return preflight(context.request, METHODS);
}
