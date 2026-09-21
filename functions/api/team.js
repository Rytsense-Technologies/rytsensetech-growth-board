/**
 * GET  /api/team — seed data/team.json ∪ KV members
 * POST /api/team — { action:'add'|'remove'|'replace', member?, id?, members? }
 * KV key "team"
 */
const KEY = 'team';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

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

export async function onRequestGet(context) {
  const { env, request } = context;
  const seed = await loadSeed(request);
  const kv = await loadKv(env);
  const members = (kv && kv.members) || seed.members || [];
  return json({
    members,
    source: kv ? 'kv' : 'seed',
    updatedAt: (kv && kv.updatedAt) || seed.updatedAt,
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.FIXES) return json({ error: 'FIXES_KV_UNBOUND' }, 503);
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const seed = await loadSeed(request);
  const kv = (await loadKv(env)) || { members: seed.members || [] };
  let members = Array.isArray(kv.members) ? [...kv.members] : [];

  if (body.action === 'replace' && Array.isArray(body.members)) {
    members = body.members;
  } else if (body.action === 'remove' && body.id) {
    members = members.filter((m) => m.id !== body.id);
  } else if (body.action === 'add' && body.member && body.member.name) {
    const name = String(body.member.name).trim().slice(0, 80);
    const team = body.member.team || 'Development';
    const id =
      body.member.id ||
      `m-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${Date.now().toString(36).slice(-3)}`;
    if (members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      return json({ error: 'member exists' }, 409);
    }
    members.push({
      id,
      name,
      team,
      color: body.member.color || COLORS[members.length % COLORS.length],
    });
  } else {
    return json({ error: 'invalid action' }, 400);
  }

  const store = { members, updatedAt: new Date().toISOString() };
  await env.FIXES.put(KEY, JSON.stringify(store));
  return json({ ok: true, members: store.members, updatedAt: store.updatedAt });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
