/**
 * GET /api/activity — list activity log (seed file merged with KV)
 * POST /api/activity — append {date, who, activityType, url, note}
 * Reuses FIXES KV namespace with key "activity"
 */
const KEY = 'activity';

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

async function loadKv(env) {
  if (!env.FIXES) return null;
  const raw = await env.FIXES.get(KEY);
  if (!raw) return { entries: [] };
  try {
    return JSON.parse(raw);
  } catch {
    return { entries: [] };
  }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  let seed = { entries: [] };
  try {
    const origin = new URL(request.url).origin;
    const res = await fetch(new URL('/data/activity.json', origin).toString());
    if (res.ok) seed = await res.json();
  } catch { /* ignore */ }

  const kv = await loadKv(env);
  if (!kv) {
    return json({ ...seed, source: 'seed', warning: 'FIXES_KV_UNBOUND' });
  }
  const map = new Map();
  (seed.entries || []).forEach((e, i) => map.set(e.id || `seed-${i}`, e));
  (kv.entries || []).forEach((e) => map.set(e.id, e));
  const entries = Array.from(map.values()).sort((a, b) =>
    String(b.date || '').localeCompare(String(a.date || ''))
  );
  return json({ entries, source: 'kv' });
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
  const entry = {
    id: body.id || `a-${Date.now()}`,
    date: body.date || new Date().toISOString(),
    who: body.who || 'dashboard',
    activityType: body.activityType || 'note',
    url: body.url || null,
    note: body.note || '',
  };
  const kv = (await loadKv(env)) || { entries: [] };
  kv.entries = [entry, ...(kv.entries || [])].slice(0, 500);
  kv.updatedAt = new Date().toISOString();
  await env.FIXES.put(KEY, JSON.stringify(kv));
  return json({ ok: true, entry });
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
