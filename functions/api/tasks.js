/**
 * GET  /api/tasks — seed ∪ KV overrides ∪ KV created customs
 * POST /api/tasks — create custom task { title, details?, team?, priority?, status?, dueDate?, assignee?, owner? }
 * KV key "tasks": { overrides:{}, created:[], updatedAt }
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
    updatedAt: store.updatedAt || seed.updatedAt || new Date().toISOString(),
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
  if (!body.title || !String(body.title).trim()) {
    return json({ error: 'title required' }, 400);
  }
  const now = new Date().toISOString();
  const id =
    body.id ||
    `T-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const task = {
    id,
    source: 'custom',
    title: String(body.title).slice(0, 200),
    location: body.location || null,
    rationale: body.details || body.rationale || '',
    details: body.details || body.rationale || '',
    effort: body.effort || '1h',
    owner: body.owner || 'SEO',
    team: normalizeTeam(body.team || body.owner || 'SEO'),
    assignee: body.assignee || null,
    status: body.status || 'todo',
    priority: body.priority || 'medium',
    dueDate: body.dueDate || null,
    createdAt: now,
    completedAt: body.status === 'done' ? now : null,
    notes: [],
  };
  const store = await loadStore(env);
  store.created = [task, ...(store.created || []).filter((t) => t.id !== id)].slice(
    0,
    200
  );
  store.updatedAt = now;
  await env.FIXES.put(KEY, JSON.stringify(store));

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
    act.entries = [
      {
        id: `act-task-new-${id}`,
        date: now,
        who: body.doneBy || body.assignee || 'dashboard',
        activityType: 'task',
        note: `Created task ${id}: ${task.title}`,
        taskId: id,
      },
      ...(act.entries || []),
    ].slice(0, 500);
    act.updatedAt = now;
    await env.FIXES.put(ACTIVITY_KEY, JSON.stringify(act));
  } catch {
    /* ignore */
  }

  return json({ ok: true, task });
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
