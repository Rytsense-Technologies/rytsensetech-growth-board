/**
 * GET /api/goals — merge seed goals.json with KV overrides
 * POST /api/goals — body { id, target } updates target for a goal id
 */
const KEY = 'goals';

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

export async function onRequestGet(context) {
  const { env, request } = context;
  let seed = { targets: [] };
  try {
    const origin = new URL(request.url).origin;
    const res = await fetch(new URL('/data/goals.json', origin).toString());
    if (res.ok) seed = await res.json();
  } catch { /* ignore */ }

  if (!env.FIXES) return json({ ...seed, source: 'seed' });

  const raw = await env.FIXES.get(KEY);
  let overrides = {};
  if (raw) {
    try {
      overrides = JSON.parse(raw).overrides || {};
    } catch { /* ignore */ }
  }
  const targets = (seed.targets || []).map((t) => ({
    ...t,
    target: overrides[t.id] != null ? overrides[t.id] : t.target,
  }));
  return json({ targets, source: 'kv', updatedAt: new Date().toISOString() });
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
  if (!body.id) return json({ error: 'missing id' }, 400);
  const raw = await env.FIXES.get(KEY);
  let store = { overrides: {} };
  if (raw) {
    try {
      store = JSON.parse(raw);
    } catch { /* ignore */ }
  }
  store.overrides = store.overrides || {};
  store.overrides[body.id] = body.target;
  store.updatedAt = new Date().toISOString();
  await env.FIXES.put(KEY, JSON.stringify(store));
  return json({ ok: true, id: body.id, target: body.target });
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
