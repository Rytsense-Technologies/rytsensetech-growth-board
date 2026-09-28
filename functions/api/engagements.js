/**
 * GET  /api/engagements — seed engagements.json ∪ KV list, newest first (public)
 * POST /api/engagements — publish one engagement; also appends an activity entry
 *
 * Binding: FIXES (KV) key "engagements"
 * REQUIRED header: X-Board-Token matching BOARD_PUBLISH_TOKEN.
 *
 * WHY "required" and not "optional (if set)": this file's own authorized() used to
 * `return true` when BOARD_PUBLISH_TOKEN was unset — and it was unset — so the one
 * endpoint that looked protected was in fact wide open, letting anyone publish a
 * forged "the SEO agent team found X" report into the feed the team trusts as
 * ground truth. Config that is missing is now a refusal, not a bypass.
 */
import { responder, preflight, requireAuth } from '../_lib/auth.js';
import { checkRev, conflictBody, nextRev, appendActivity } from '../_lib/store.js';
import { readJson, trimmed, str, LIMITS } from '../_lib/validate.js';

const KEY = 'engagements';
const ACTIVITY_KEY = 'activity';
const METHODS = 'GET, POST, OPTIONS';

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
    const p = JSON.parse(raw);
    return { engagements: p.engagements || [], rev: p.rev, updatedAt: p.updatedAt };
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
    trimmed(body.id, LIMITS.id) ||
    `eng-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const findings = Array.isArray(body.findings)
    ? body.findings.slice(0, 50).map((f) => ({
        id: trimmed(f && f.id, LIMITS.id),
        severity: str(f && f.severity, LIMITS.shortEnum) || 'info',
        title: str(f && f.title, 240) || '',
        agent: str(f && f.agent, LIMITS.shortEnum),
        url: str(f && f.url, LIMITS.url),
      }))
    : [];
  return {
    id,
    domain: str(body.domain, LIMITS.name) || 'rytsensetech.com',
    run: str(body.run, LIMITS.id) || id,
    command: str(body.command, LIMITS.name) || 'custom',
    startedAt: str(body.startedAt, 40) || now,
    finishedAt: str(body.finishedAt, 40) || now,
    agentsUsed: Array.isArray(body.agentsUsed)
      ? body.agentsUsed.slice(0, 60).map((a) => str(a, LIMITS.name)).filter(Boolean)
      : [],
    summary: str(body.summary, LIMITS.summary) || '',
    verdict: body.verdict && typeof body.verdict === 'object' ? body.verdict : {},
    deliverables: Array.isArray(body.deliverables)
      ? body.deliverables.slice(0, 30)
      : [],
    findings,
    source: 'api',
    publishedAt: now,
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const json = responder(request, METHODS);
  const seed = await loadSeed(request);
  const kv = await loadKv(env);
  const engagements = mergeLists(seed.engagements, kv ? kv.engagements : []);
  return json({
    engagements,
    latest: engagements[0] || null,
    source: kv ? 'kv' : 'seed',
    rev: kv && Number.isFinite(Number(kv.rev)) ? Number(kv.rev) : 0,
    updatedAt: (kv && kv.updatedAt) || seed.updatedAt || null,
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

  if (!body.summary && !(Array.isArray(body.findings) && body.findings.length)) {
    return json({ error: 'need summary or findings' }, 400);
  }

  const engagement = normalizeEngagement(body);
  const kv = (await loadKv(env)) || { engagements: [] };

  // Publishing a new run needs no rev — it cannot overwrite anyone. Re-publishing
  // an id that is already in the list replaces a stored report, so it must echo
  // the rev from GET /api/engagements.
  const isNew = !(kv.engagements || []).some((e) => e && e.id === engagement.id);
  const conflict = checkRev(body, kv, isNew);
  if (conflict) {
    return json(conflictBody(conflict, { id: engagement.id }), 409);
  }

  const others = (kv.engagements || []).filter((e) => e.id !== engagement.id);
  kv.engagements = [engagement, ...others].slice(0, 40);
  kv.rev = nextRev(kv);
  kv.updatedAt = engagement.publishedAt;
  await env.FIXES.put(KEY, JSON.stringify(kv));

  // Mirror into activity log so the Ops Activity Tracker sees agent work. No
  // longer best-effort-and-silent: a mirror that fails is reported to the caller.
  const logged = await appendActivity(env, ACTIVITY_KEY, {
    id: `act-${engagement.id}`,
    date: engagement.finishedAt,
    who: 'seo-agents',
    activityType: 'agent-engagement',
    url: null,
    note: `${engagement.command}: ${engagement.summary.slice(0, 180)} (${engagement.findings.length} findings)`,
    engagementId: engagement.id,
  });

  const out = { ok: true, engagement, rev: kv.rev };
  if (!logged.ok) out.activityWarning = `activity mirror not written: ${logged.error}`;
  return json(out);
}

export async function onRequestOptions(context) {
  return preflight(context.request, METHODS);
}
