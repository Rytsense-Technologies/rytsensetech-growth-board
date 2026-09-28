/**
 * GET  /api/tasks — seed ∪ KV overrides ∪ KV created customs (public, no token)
 * POST /api/tasks — create custom task { title, details?, team?, priority?, status?, dueDate?, assignee?, owner?, rev? }
 *                   requires header X-Board-Token (see functions/_lib/auth.js)
 * KV key "tasks": { overrides:{}, created:[], history:[], rev, updatedAt }
 */
import { responder, preflight, requireAuth, callerOf } from '../_lib/auth.js';
import { checkRev, conflictBody, nextRev, appendActivity } from '../_lib/store.js';
import {
  readJson,
  trimmed,
  str,
  pick,
  dateish,
  LIMITS,
  STATUSES,
  PRIORITIES,
  TEAMS,
  OWNERS,
} from '../_lib/validate.js';

const KEY = 'tasks';
const ACTIVITY_KEY = 'activity';
const METHODS = 'GET, POST, OPTIONS';

async function loadSeed(request) {
  try {
    const origin = new URL(request.url).origin;
    const res = await fetch(new URL('/data/tasks.json', origin).toString());
    if (res.ok) return await res.json();
  } catch {
    /* ignore */
  }
  return { tasks: [] };
}

async function loadStore(env) {
  if (!env.FIXES) return { overrides: {}, created: [] };
  const raw = await env.FIXES.get(KEY);
  if (!raw) return { overrides: {}, created: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      overrides: parsed.overrides || {},
      created: parsed.created || [],
      history: parsed.history || [],
      rev: parsed.rev,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return { overrides: {}, created: [] };
  }
}

function mergeTask(seed, ov) {
  if (!ov) return { ...seed };
  return {
    ...seed,
    ...ov,
    notes: Array.isArray(ov.notes) ? ov.notes : seed.notes || [],
  };
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function summary(tasks) {
  const now = startOfDay(new Date());
  const in3 = new Date(now);
  in3.setDate(in3.getDate() + 3);
  const open = tasks.filter((t) => t.status !== 'done');
  const overdue = open.filter((t) => {
    if (!t.dueDate) return false;
    return startOfDay(t.dueDate) < now;
  });
  const dueSoon = open.filter((t) => {
    if (!t.dueDate) return false;
    const d = startOfDay(t.dueDate);
    return d >= now && d <= in3;
  });
  const done = tasks.filter((t) => t.status === 'done').length;
  return {
    total: tasks.length,
    open: open.length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    inProgress: tasks.filter((t) => t.status === 'in-progress').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
    done,
    completePct: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    openCritical: open.filter((t) => t.priority === 'critical').length,
    overdue: overdue.length,
    dueSoon: dueSoon.length,
  };
}

function normalizeTeam(ownerOrTeam) {
  const m = {
    Dev: 'Development',
    Development: 'Development',
    Content: 'Content',
    SEO: 'SEO',
    Marketing: 'Marketing',
  };
  return m[ownerOrTeam] || ownerOrTeam || 'SEO';
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const json = responder(request, METHODS);
  const seed = await loadSeed(request);
  const store = await loadStore(env);
  const seeded = (seed.tasks || []).map((t) =>
    mergeTask(
      {
        ...t,
        team: t.team || normalizeTeam(t.owner),
        details: t.details || t.rationale || '',
      },
      store.overrides[t.id]
    )
  );
  const created = (store.created || []).map((t) =>
    mergeTask(t, store.overrides[t.id])
  );
  const byId = new Map();
  seeded.forEach((t) => byId.set(t.id, t));
  created.forEach((t) => byId.set(t.id, t));
  const tasks = Array.from(byId.values());
  return json({
    tasks,
    summary: summary(tasks),
    source: env.FIXES ? 'kv' : 'seed',
    // Writers must echo this back — see functions/_lib/store.js for why.
    rev: Number.isFinite(Number(store.rev)) ? Number(store.rev) : 0,
    // WHY not `|| new Date().toISOString()`: the old fallback made updatedAt mean
    // "when you asked", not "when this last changed" — a board nobody had touched
    // for a week still looked freshly updated on every page load. Null is honest.
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

  const title = trimmed(body.title, LIMITS.title);
  if (!title) return json({ error: 'title required' }, 400);

  const status = body.status == null ? 'todo' : pick(body.status, STATUSES);
  if (status === undefined) {
    return json({ error: 'invalid status', allowed: STATUSES }, 400);
  }
  const priority = body.priority == null ? 'medium' : pick(body.priority, PRIORITIES);
  if (priority === undefined) {
    return json({ error: 'invalid priority', allowed: PRIORITIES }, 400);
  }
  const owner = body.owner == null ? 'SEO' : pick(body.owner, OWNERS);
  if (owner === undefined) {
    return json({ error: 'invalid owner', allowed: OWNERS }, 400);
  }
  const team = body.team == null ? null : pick(body.team, TEAMS);
  if (team === undefined) {
    return json({ error: 'invalid team', allowed: TEAMS }, 400);
  }
  const dueDate = dateish(body.dueDate);
  if (dueDate === undefined) return json({ error: 'invalid dueDate' }, 400);

  const now = new Date().toISOString();
  const requestedId = trimmed(body.id, LIMITS.id);
  const id =
    requestedId ||
    `T-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

  const store = await loadStore(env);

  // A caller-supplied id that already exists is an UPDATE wearing a create's
  // clothes — the old code silently replaced the existing entry, so a spoofed id
  // could erase a real custom task. Updates must carry a rev; only genuinely new
  // records may be written without one.
  let collides = (store.created || []).some((t) => t.id === id);
  if (!collides && requestedId) {
    const seedForId = await loadSeed(request);
    collides = (seedForId.tasks || []).some((t) => t.id === id);
  }
  const conflict = checkRev(body, store, !collides);
  if (conflict) {
    return json(conflictBody(conflict, { id, exists: collides }), 409);
  }

  const details =
    str(body.details != null ? body.details : body.rationale, LIMITS.details) || '';
  const task = {
    id,
    source: 'custom',
    title,
    location: str(body.location, LIMITS.url),
    rationale: details,
    details,
    effort: str(body.effort, LIMITS.shortEnum) || '1h',
    owner,
    team: normalizeTeam(team || body.owner || 'SEO'),
    assignee: trimmed(body.assignee, LIMITS.person),
    status,
    priority,
    dueDate,
    createdAt: now,
    completedAt: status === 'done' ? now : null,
    notes: [],
  };

  store.created = [task, ...(store.created || []).filter((t) => t.id !== id)].slice(
    0,
    200
  );
  store.rev = nextRev(store);
  store.updatedAt = now;
  await env.FIXES.put(KEY, JSON.stringify(store));

  // The audit write is no longer swallowed by `catch { /* ignore */ }` — a failed
  // audit write used to leave a log that looked complete but was missing events.
  const logged = await appendActivity(env, ACTIVITY_KEY, {
    id: `act-task-new-${id}`,
    date: now,
    who: trimmed(body.doneBy, LIMITS.person) || task.assignee || callerOf(request),
    activityType: 'task',
    note: `Created task ${id}: ${task.title}`,
    taskId: id,
  });

  const out = { ok: true, task, rev: store.rev };
  if (!logged.ok) out.activityWarning = `activity log not written: ${logged.error}`;
  return json(out);
}

export async function onRequestOptions(context) {
  return preflight(context.request, METHODS);
}
