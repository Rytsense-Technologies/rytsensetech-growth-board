/**
 * POST /api/fixes/:id — toggle done state in KV; append activity entry.
 * POST { deleted: true } — durably remove the fix (writes a tombstone).
 * Requires header X-Board-Token (see functions/_lib/auth.js).
 */
import { responder, preflight, requireAuth, callerOf } from '../../_lib/auth.js';
import { checkRev, conflictBody, nextRev } from '../../_lib/store.js';
import { readJson, trimmed, str, LIMITS } from '../../_lib/validate.js';

const STATE_KEY = 'state';
const METHODS = 'POST, OPTIONS';

async function readState(env) {
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

export async function onRequestPost(context) {
  const { env, params, request } = context;
  const json = responder(request, METHODS);

  const denied = await requireAuth(request, env, json);
  if (denied) return denied;

  if (!env.FIXES) {
    return json({ error: 'FIXES_KV_UNBOUND' }, 503);
  }

  const id = params.id;
  if (!id) return json({ error: 'missing id' }, 400);

  const parsed = await readJson(request, json);
  if (parsed.response) return parsed.response;
  const body = parsed.body;

  const state = await readState(env);
  state.items = state.items || {};
  state.activity = state.activity || [];
  state.tombstones = state.tombstones || {};

  // Toggling a fix that already has a KV entry is an update, so it must echo the
  // rev from GET /api/fixes. The first toggle of a fix creates its entry and is
  // therefore safe as last-write-wins.
  const isNew = !state.items[id] && !state.tombstones[id];
  const conflict = checkRev(body, state, isNew);
  if (conflict) {
    return json(
      conflictBody(conflict, { id, item: state.items[id] || null }),
      409
    );
  }

  const who = trimmed(body.doneBy, LIMITS.person) || callerOf(request);
  const now = new Date().toISOString();

  if (body.deleted === true) {
    // Durable deletion. WHY a tombstone instead of just dropping the key: the
    // GET merge re-creates anything present in either side, so a plain delete
    // resurrected the fix on the next read and re-inflated the done/total ratio.
    delete state.items[id];
    state.tombstones[id] = { deletedAt: now, deletedBy: who };
    state.activity.unshift({
      date: now,
      who,
      activityType: 'fix',
      url: null,
      note: `Deleted ${id}`,
    });
    state.activity = state.activity.slice(0, 200);
    state.rev = nextRev(state);
    state.updatedAt = now;
    await env.FIXES.put(STATE_KEY, JSON.stringify(state));
    return json({ id, deleted: true, ok: true, rev: state.rev });
  }

  const done = !!body.done;
  const doneAt = done ? now : null;
  const title = str(body.title, LIMITS.title) || (state.items[id] || {}).title || null;
  // Un-deleting is explicit: writing the fix again clears its tombstone.
  delete state.tombstones[id];
  state.items[id] = { done, doneAt, doneBy: who, title };

  if (done) {
    state.activity.unshift({
      date: doneAt,
      who,
      activityType: 'fix_completed',
      url: null,
      note: `Marked ${id} done`,
    });
    state.activity = state.activity.slice(0, 200);
  }

  state.rev = nextRev(state);
  state.updatedAt = now;
  await env.FIXES.put(STATE_KEY, JSON.stringify(state));
  return json({ id, done, doneAt, doneBy: who, ok: true, rev: state.rev });
}

export async function onRequestOptions(context) {
  return preflight(context.request, METHODS);
}
