/**
 * GET /api/fixes — merge seed + KV done-state (public, no token)
 *
 * Binding: FIXES (KV namespace)
 * Keys:
 *   state — JSON {
 *     items:      { [id]: { done, doneAt, doneBy, title? } },
 *     tombstones: { [id]: { deletedAt, deletedBy } },
 *     activity:   [],
 *     rev, updatedAt
 *   }
 */
import { responder, preflight } from '../_lib/auth.js';

const STATE_KEY = 'state';
const METHODS = 'GET, OPTIONS';

async function readState(env) {
  if (!env.FIXES) return { items: {}, activity: [], tombstones: {} };
  const raw = await env.FIXES.get(STATE_KEY);
  if (!raw) return { items: {}, activity: [], tombstones: {} };
  try {
    const p = JSON.parse(raw);
    return {
      items: p.items || {},
      activity: p.activity || [],
      tombstones: p.tombstones || {},
      rev: p.rev,
      updatedAt: p.updatedAt,
    };
  } catch {
    return { items: {}, activity: [], tombstones: {} };
  }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const json = responder(request, METHODS);
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
  const tombstones = state.tombstones || {};
  const items = seedItems
    // A deleted fix stays deleted even if it is still present in the seed file —
    // deletion is recorded as a durable tombstone, not as an absence.
    .filter((item) => !tombstones[item.id])
    .map((item) => {
      const ov = state.items[item.id];
      if (!ov) return item;
      return {
        ...item,
        done: !!ov.done,
        doneAt: ov.doneAt || null,
        doneBy: ov.doneBy || null,
      };
    });

  // Include KV-only ids not in the seed — but ONLY ones that carry a real title.
  // WHY: this loop used to re-inject every KV id with `title = id`, so a fix that
  // had been removed from data/fixes.json came back as a ghost row named "W7",
  // inflating the done/total ratio that a goal is measured on. A KV entry with no
  // title is a leftover toggle for a fix that no longer exists, not a fix.
  for (const id of Object.keys(state.items)) {
    if (tombstones[id]) continue;
    const ov = state.items[id];
    if (!ov || !ov.title) continue;
    if (items.find((i) => i.id === id)) continue;
    items.push({
      id,
      title: ov.title,
      type: ov.type || 'custom',
      done: !!ov.done,
      doneAt: ov.doneAt || null,
      doneBy: ov.doneBy || null,
    });
  }

  return json({
    items,
    activity: state.activity || [],
    source: 'kv',
    rev: Number.isFinite(Number(state.rev)) ? Number(state.rev) : 0,
    updatedAt: state.updatedAt || null,
  });
}

export async function onRequestOptions(context) {
  return preflight(context.request, METHODS);
}
