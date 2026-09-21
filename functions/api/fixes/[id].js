/**
 * POST /api/fixes/:id — toggle done state in KV; append activity entry
 */
const STATE_KEY = 'state';

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

async function readState(env) {
  const raw = await env.FIXES.get(STATE_KEY);
  if (!raw) return { items: {}, activity: [] };
  try {
    return JSON.parse(raw);
  } catch {
    return { items: {}, activity: [] };
  }
}

export async function onRequestPost(context) {
  const { env, params, request } = context;
  if (!env.FIXES) {
    return json({ error: 'FIXES_KV_UNBOUND' }, 503);
  }

  const id = params.id;
  if (!id) return json({ error: 'missing id' }, 400);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const done = !!body.done;
  const doneBy = body.doneBy || 'dashboard';
  const doneAt = done ? new Date().toISOString() : null;

  const state = await readState(env);
  state.items = state.items || {};
  state.activity = state.activity || [];
  state.items[id] = { done, doneAt, doneBy };

  if (done) {
    state.activity.unshift({
      date: doneAt,
      who: doneBy,
      activityType: 'fix_completed',
      url: null,
      note: `Marked ${id} done`,
    });
    state.activity = state.activity.slice(0, 200);
  }

  await env.FIXES.put(STATE_KEY, JSON.stringify(state));
  return json({ id, done, doneAt, doneBy, ok: true });
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
