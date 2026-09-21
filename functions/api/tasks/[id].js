/**
 * POST /api/tasks/:id — patch task fields + optional note
 * Supports seed ids and custom created ids in KV.
 */
const KEY = 'tasks';
const ACTIVITY_KEY = 'activity';

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

async function loadStore(env) {
  const raw = await env.FIXES.get(KEY);
  if (!raw) return { overrides: {}, created: [] };
  try {
    const p = JSON.parse(raw);
    return {
      overrides: p.overrides || {},
      created: p.created || [],
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

async function appendActivity(env, entry) {
  try {
    const raw = await env.FIXES.get(ACTIVITY_KEY);
    let act = { entries: [] };
    if (raw) {
      try {
        act = JSON.parse(raw);
      } catch {
        /* ignore */
      }
    }
    act.entries = [entry, ...(act.entries || [])].slice(0, 500);
    act.updatedAt = entry.date;
    await env.FIXES.put(ACTIVITY_KEY, JSON.stringify(act));
  } catch {
    /* ignore */
  }
}

export async function onRequestPost(context) {
  const { env, params, request } = context;
  if (!env.FIXES) return json({ error: 'FIXES_KV_UNBOUND' }, 503);
  const id = params.id;
  if (!id) return json({ error: 'missing id' }, 400);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const base = await findBase(request, env, id);
  if (!base) return json({ error: 'unknown task id' }, 404);

  const store = await loadStore(env);
  store.overrides = store.overrides || {};
  const prev = { ...base, ...(store.overrides[id] || {}) };
  const next = { ...prev };
  const who = body.doneBy || body.author || body.assignee || 'dashboard';
  const now = new Date().toISOString();
  const logs = [];

  if (body.status != null && body.status !== prev.status) {
    const allowed = ['todo', 'in-progress', 'blocked', 'done'];
    if (!allowed.includes(body.status)) return json({ error: 'invalid status' }, 400);
    next.status = body.status;
    next.completedAt = body.status === 'done' ? now : null;
    logs.push(`Status changed: ${id} ${base.title} → ${body.status}`);
  }
  if (body.assignee !== undefined && body.assignee !== prev.assignee) {
    next.assignee = body.assignee || null;
    logs.push(`${id} assigned to ${next.assignee || 'unassigned'}`);
  }
  if (body.dueDate !== undefined && body.dueDate !== prev.dueDate) {
    next.dueDate = body.dueDate || null;
    logs.push(`${id} due date → ${next.dueDate || 'none'}`);
  }
  if (body.owner != null) next.owner = body.owner;
  if (body.team != null) next.team = body.team;
  if (body.priority != null) next.priority = body.priority;
  if (body.title != null) next.title = String(body.title).slice(0, 200);
  if (body.details != null) {
    next.details = body.details;
    next.rationale = body.details;
  }
  if (body.note && body.note.text) {
    const note = {
      date: now,
      author: body.note.author || who,
      text: String(body.note.text).slice(0, 2000),
    };
    next.notes = [note, ...(next.notes || [])].slice(0, 100);
    logs.push(`${id} note: ${note.text.slice(0, 120)}`);
  }

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

  store.updatedAt = now;
  await env.FIXES.put(KEY, JSON.stringify(store));

  for (const note of logs) {
    await appendActivity(env, {
      id: `act-task-${id}-${Date.now()}`,
      date: now,
      who,
      activityType: 'task',
      note,
      taskId: id,
    });
  }

  return json({ ok: true, task: { ...base, ...store.overrides[id] } });
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
