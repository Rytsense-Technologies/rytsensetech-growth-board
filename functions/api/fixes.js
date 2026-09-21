/**
 * GET /api/fixes — merge seed + KV done-state
 * Seed is optionally POSTed once via {seed:true, items:[...]} or read from request;
 * primary seed lives in Pages static asset; KV stores overrides only.
 *
 * Binding: FIXES (KV namespace)
 * Keys:
 *   state — JSON { items: { [id]: { done, doneAt, doneBy } }, activity: [] }
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
  if (!env.FIXES) return { items: {}, activity: [] };
  const raw = await env.FIXES.get(STATE_KEY);
  if (!raw) return { items: {}, activity: [] };
  try {
    return JSON.parse(raw);
  } catch {
    return { items: {}, activity: [] };
  }
}

async function writeState(env, state) {
  if (!env.FIXES) throw new Error('FIXES KV binding missing');
  await env.FIXES.put(STATE_KEY, JSON.stringify(state));
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.FIXES) {
    return json(
      {
        error: 'FIXES_KV_UNBOUND',
        message: 'Create a KV namespace and bind it as FIXES in wrangler.toml, then redeploy.',
        items: [],
      },
      503
    );
  }

  // Optional: client can pass seed via ? use static file instead
  let seedItems = [];
  try {
    const origin = new URL(request.url).origin;
    const seedRes = await fetch(new URL('/data/fixes.json', origin).toString(), {
      cf: { cacheTtl: 60 },
    });
    if (seedRes.ok) {
      const seed = await seedRes.json();
      seedItems = seed.items || [];
    }
  } catch {
    /* ignore — return KV-only */
  }

  const state = await readState(env);
  const items = seedItems.map((item) => {
    const ov = state.items[item.id];
    if (!ov) return item;
    return {
      ...item,
      done: !!ov.done,
      doneAt: ov.doneAt || null,
      doneBy: ov.doneBy || null,
    };
  });

  // Include KV-only ids not in seed
  for (const id of Object.keys(state.items)) {
    if (!items.find((i) => i.id === id)) {
      const ov = state.items[id];
      items.push({
        id,
        title: id,
        type: 'custom',
        done: !!ov.done,
        doneAt: ov.doneAt || null,
        doneBy: ov.doneBy || null,
      });
    }
  }

  return json({ items, activity: state.activity || [], source: 'kv' });
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
