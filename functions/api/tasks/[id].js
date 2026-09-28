/**
 * POST /api/tasks/:id — patch task fields + optional note
 * Supports seed ids and custom created ids in KV.
 * Requires header X-Board-Token (see functions/_lib/auth.js) and a `rev` echoed
 * from the last GET /api/tasks (see functions/_lib/store.js).
 */
import { responder, preflight, requireAuth, callerOf } from '../../_lib/auth.js';
import {
  checkRev,
  conflictBody,
  nextRev,
  recordChanges,
  change,
  appendActivity,
} from '../../_lib/store.js';
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
} from '../../_lib/validate.js';

const KEY = 'tasks';
const ACTIVITY_KEY = 'activity';
const METHODS = 'POST, OPTIONS';

async function loadStore(env) {
  const raw = await env.FIXES.get(KEY);
  if (!raw) return { overrides: {}, created: [] };
  try {
    const p = JSON.parse(raw);
    return {
      overrides: p.overrides || {},
      created: p.created || [],
      history: p.history || [],
      rev: p.rev,
      updatedAt: p.updatedAt,
    };
  } catch {
    return { overrides: {}, created: [] };
  }
}

async function findBase(request, env, id) {
  try {
    const origin = new URL(request.url).origin;
    const res = await fetch(new URL('/data/tasks.json', origin).toString());
    if (res.ok) {
      const seed = await res.json();
      const hit = (seed.tasks || []).find((t) => t.id === id);
      if (hit) return hit;
    }
  } catch {
    /* ignore */
  }
  const store = await loadStore(env);
  return (store.created || []).find((t) => t.id === id) || null;
}

export async function onRequestPost(context) {
  const { env, params, request } = context;
  const json = responder(request, METHODS);

  const denied = await requireAuth(request, env, json);
  if (denied) return denied;

  if (!env.FIXES) return json({ error: 'FIXES_KV_UNBOUND' }, 503);
  const id = params.id;
  if (!id) return json({ error: 'missing id' }, 400);

  const parsed = await readJson(request, json);
  if (parsed.response) return parsed.response;
  const body = parsed.body;

  const base = await findBase(request, env, id);
  if (!base) return json({ error: 'unknown task id' }, 404);

  const store = await loadStore(env);
  store.overrides = store.overrides || {};
  const prev = { ...base, ...(store.overrides[id] || {}) };

  // Every request here patches a record that already exists, so `rev` is never
  // optional: without it, two analysts saving within the same second both read
  // version N, both write N+1, and the second write erases the first — on a
  // different task, because all 24 tasks share one KV value. 409 carries the
  // current task so the client can merge instead of clobber.
  const conflict = checkRev(body, store, false);
  if (conflict) {
    return json(conflictBody(conflict, { task: prev }), 409);
  }

  const next = { ...prev };
  const who = trimmed(body.doneBy || body.author || body.assignee, LIMITS.person) || callerOf(request);
  const now = new Date().toISOString();
  const logs = [];
  const changes = [];

  if (body.status != null && body.status !== prev.status) {
    if (!pick(body.status, STATUSES)) {
      return json({ error: 'invalid status', allowed: STATUSES }, 400);
    }
    changes.push(change(id, 'status', prev.status, body.status, who, now));
    next.status = body.status;
    next.completedAt = body.status === 'done' ? now : null;
    logs.push(`Status changed: ${id} ${base.title} → ${body.status}`);
  }
  if (body.assignee !== undefined && body.assignee !== prev.assignee) {
    const assignee = trimmed(body.assignee, LIMITS.person);
    changes.push(change(id, 'assignee', prev.assignee, assignee, who, now));
    next.assignee = assignee;
    logs.push(`${id} assigned to ${next.assignee || 'unassigned'}`);
  }
  if (body.dueDate !== undefined && body.dueDate !== prev.dueDate) {
    const dueDate = dateish(body.dueDate);
    if (dueDate === undefined) return json({ error: 'invalid dueDate' }, 400);
    changes.push(change(id, 'dueDate', prev.dueDate, dueDate, who, now));
    next.dueDate = dueDate;
    logs.push(`${id} due date → ${next.dueDate || 'none'}`);
  }

  // WHY these four now log and validate: until 2026-09-28 owner/team/priority/
  // title/details were assigned straight from the body with no allow-list, no
  // length cap and NO log line at all, so someone could rewrite a task's title
  // and priority and leave no trace anywhere. An unvalidated priority also
  // silently breaks the openCritical KPI tile on the homepage.
  if (body.owner != null && body.owner !== prev.owner) {
    if (!pick(body.owner, OWNERS)) {
      return json({ error: 'invalid owner', allowed: OWNERS }, 400);
    }
    changes.push(change(id, 'owner', prev.owner, body.owner, who, now));
    next.owner = body.owner;
    logs.push(`${id} owner → ${body.owner}`);
  }
  if (body.team != null && body.team !== prev.team) {
    if (!pick(body.team, TEAMS)) {
      return json({ error: 'invalid team', allowed: TEAMS }, 400);
    }
    changes.push(change(id, 'team', prev.team, body.team, who, now));
    next.team = body.team;
    logs.push(`${id} team → ${body.team}`);
  }
  if (body.priority != null && body.priority !== prev.priority) {
    if (!pick(body.priority, PRIORITIES)) {
      return json({ error: 'invalid priority', allowed: PRIORITIES }, 400);
    }
    changes.push(change(id, 'priority', prev.priority, body.priority, who, now));
    next.priority = body.priority;
    logs.push(`${id} priority → ${body.priority}`);
  }
  if (body.title != null) {
    const title = trimmed(body.title, LIMITS.title);
    if (!title) return json({ error: 'title cannot be empty' }, 400);
    if (title !== prev.title) {
      changes.push(change(id, 'title', prev.title, title, who, now));
      next.title = title;
      logs.push(`${id} title changed`);
    }
  }
  if (body.details != null) {
    const details = str(body.details, LIMITS.details);
    if (details == null) return json({ error: 'invalid details' }, 400);
    if (details !== prev.details) {
      changes.push(change(id, 'details', prev.details, details, who, now));
      next.details = details;
      next.rationale = details;
      logs.push(`${id} details changed`);
    }
  }
  if (body.note && body.note.text) {
    const text = str(body.note.text, LIMITS.note);
    if (!text) return json({ error: 'invalid note' }, 400);
    const note = {
      date: now,
      author: trimmed(body.note.author, LIMITS.person) || who,
      text,
    };
    next.notes = [note, ...(next.notes || [])].slice(0, 100);
    logs.push(`${id} note: ${note.text.slice(0, 120)}`);
  }

  // History is written from the PREVIOUS values, before the overwrite below.
  recordChanges(store, changes);

  store.overrides[id] = {
    status: next.status,
    assignee: next.assignee,
    dueDate: next.dueDate,
    owner: next.owner,
    team: next.team,
    priority: next.priority,
    title: next.title,
    details: next.details,
    rationale: next.rationale,
    completedAt: next.completedAt,
    notes: next.notes || [],
  };

  // Keep created list in sync for custom tasks
  store.created = (store.created || []).map((t) =>
    t.id === id ? { ...t, ...store.overrides[id] } : t
  );

  store.rev = nextRev(store);
  store.updatedAt = now;
  await env.FIXES.put(KEY, JSON.stringify(store));

  // appendActivity no longer hides its own failures: a lost audit entry used to
  // leave a log that looked complete while missing the event entirely.
  const activityErrors = [];
  for (let i = 0; i < logs.length; i += 1) {
    const logged = await appendActivity(env, ACTIVITY_KEY, {
      id: `act-task-${id}-${Date.now()}-${i}`,
      date: now,
      who,
      activityType: 'task',
      note: logs[i],
      taskId: id,
    });
    if (!logged.ok) activityErrors.push(logged.error);
  }

  const out = {
    ok: true,
    task: { ...base, ...store.overrides[id] },
    rev: store.rev,
    changed: changes.map((c) => c.field),
  };
  if (activityErrors.length) {
    out.activityWarning = `activity log not written: ${activityErrors.join('; ')}`;
  }
  return json(out);
}

export async function onRequestOptions(context) {
  return preflight(context.request, METHODS);
}
