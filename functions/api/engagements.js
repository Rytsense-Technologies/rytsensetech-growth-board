/**
 * GET  /api/engagements — seed engagements.json ∪ KV list (newest first)
 * POST /api/engagements — publish one engagement; also appends activity entries
 *
 * Binding: FIXES (KV) key "engagements"
 * Optional header: X-Board-Token matching BOARD_PUBLISH_TOKEN (if set)
 */
const KEY = 'engagements';
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

function authorized(request, env) {
  const required = env.BOARD_PUBLISH_TOKEN;
  if (!required) return true;
  const got = request.headers.get('X-Board-Token') || '';
  return got === required;
}

async function loadSeed(request) {
  try {
    const origin = new URL(request.url).origin;
    const res = await fetch(new URL('/data/engagements.json', origin).toString());
    if (res.ok) return await res.json();
  } catch {
    /* ignore */
  }
  return { engagements: [] };
}

async function loadKv(env) {
  if (!env.FIXES) return null;
  const raw = await env.FIXES.get(KEY);
  if (!raw) return { engagements: [] };
  try {
    return JSON.parse(raw);
  } catch {
    return { engagements: [] };
  }
}

function mergeLists(seedList, kvList) {
  const map = new Map();
  (seedList || []).forEach((e) => {
    if (e && e.id) map.set(e.id, e);
  });
  (kvList || []).forEach((e) => {
    if (e && e.id) map.set(e.id, e);
  });
  return Array.from(map.values()).sort((a, b) =>
    String(b.finishedAt || b.startedAt || '').localeCompare(
      String(a.finishedAt || a.startedAt || '')
    )
  );
}

function normalizeEngagement(body) {
  const now = new Date().toISOString();
  const id =
    body.id ||
    `eng-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const findings = Array.isArray(body.findings)
    ? body.findings.slice(0, 50).map((f) => ({
        id: f.id || null,
        severity: f.severity || 'info',
        title: String(f.title || '').slice(0, 240),
        agent: f.agent || null,
        url: f.url || null,
      }))
    : [];
  return {
    id,
    domain: body.domain || 'rytsensetech.com',
    run: body.run || id,
    command: body.command || 'custom',
    startedAt: body.startedAt || now,
    finishedAt: body.finishedAt || now,
    agentsUsed: Array.isArray(body.agentsUsed)
      ? body.agentsUsed.slice(0, 60)
      : [],
    summary: String(body.summary || '').slice(0, 1200),
    verdict: body.verdict || {},
    findings,
    deliverables: Array.isArray(body.deliverables)
      ? body.deliverables.slice(0, 30)
      : [],
    source: 'api',
    publishedAt: now,
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const seed = await loadSeed(request);
  const kv = await loadKv(env);
  const engagements = mergeLists(
    seed.engagements,
    kv ? kv.engagements : []
  );
  return json({
    engagements,
    latest: engagements[0] || null,
    source: kv ? 'kv' : 'seed',
    updatedAt: new Date().toISOString(),
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!authorized(request, env)) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!env.FIXES) return json({ error: 'FIXES_KV_UNBOUND' }, 503);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (!body.summary && !(body.findings && body.findings.length)) {
    return json({ error: 'need summary or findings' }, 400);
  }

  const engagement = normalizeEngagement(body);
  const kv = (await loadKv(env)) || { engagements: [] };
  const others = (kv.engagements || []).filter((e) => e.id !== engagement.id);
  kv.engagements = [engagement, ...others].slice(0, 40);
  kv.updatedAt = engagement.publishedAt;
  await env.FIXES.put(KEY, JSON.stringify(kv));

  // Mirror into activity log so Ops Activity Tracker sees agent work
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
    const entry = {
      id: `act-${engagement.id}`,
      date: engagement.finishedAt,
      who: 'seo-agents',
      activityType: 'agent-engagement',
      url: null,
      note: `${engagement.command}: ${engagement.summary.slice(0, 180)} (${(engagement.findings || []).length} findings)`,
      engagementId: engagement.id,
    };
    act.entries = [entry, ...(act.entries || []).filter((e) => e.id !== entry.id)].slice(
      0,
      500
    );
    act.updatedAt = engagement.publishedAt;
    await env.FIXES.put(ACTIVITY_KEY, JSON.stringify(act));
  } catch {
    /* activity mirror is best-effort */
  }

  return json({ ok: true, engagement });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Board-Token',
    },
  });
}
