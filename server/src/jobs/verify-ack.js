// Human claimed "I fixed this". Live-probe connected tools for that item only,
// ask the model once, then confirm or reopen — and patch only that item's keys.
// Never invent HTTP status, PSI scores, or GSC metrics. Never full-site sync.

import { pickAutoModel, isAutoModel } from '../jobs.js';
import { probeClaimLive } from './live-probe.js';

export const KINDS = new Set([
  'gsc_issue',
  'psi_issue',
  'audit_finding',
  'fix',
  'task',
  'kpi',
  'keyword',
  'page',
  'channel',
  'cannibalization',
  'content_idea',
  'topic_trend',
  'internal_link',
  'clarity',
  'deploy',
  'ops',
  'board',
]);

export function parseVerify(text) {
  let raw = String(text || '').trim();
  // Strip markdown fences if the model wraps JSON.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('not json');
  let obj;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('not json');
  }
  const verdict = String(obj.verdict || '').toLowerCase();
  if (verdict !== 'confirmed' && verdict !== 'failed') throw new Error('bad verdict');
  return {
    verdict,
    reason: String(obj.reason || '').trim() || (verdict === 'confirmed' ? 'Looks fixed' : 'Still present'),
    evidence_used: Array.isArray(obj.evidence_used) ? obj.evidence_used.map(String) : [],
  };
}

export function shapeAck(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    claimSnapshot: row.claim_snapshot || {},
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    verifyStatus: row.verify_status,
    verifyDetail: row.verify_detail || {},
    verifiedAt: row.verified_at,
  };
}

async function anthropicModel(key) {
  const pinned = (process.env.ANTHROPIC_MODEL || '').trim();
  if (!isAutoModel(pinned)) return pinned;
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (res.ok) {
      const body = await res.json();
      const ids = (body.data || []).map((m) => m.id).filter(Boolean);
      return pickAutoModel(ids);
    }
  } catch { /* fall through */ }
  return pickAutoModel([]);
}

async function callAnthropicVerify(key, model, evidence, { forceRetryHint } = {}) {
  const userPayload =
    'Human claimed this item is fixed. Verify against live connected tools for this item only.\n' +
    JSON.stringify(evidence) +
    (forceRetryHint
      ? '\n\nIMPORTANT: Your previous reply was not valid JSON. Reply with ONLY one JSON object and nothing else.'
      : '');
  // Prefill `{` so the model continues as JSON (then we prepend it when parsing).
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system:
        'You verify one Growth Board "Addressed" claim. The human says this specific item is fixed. ' +
        'The dashboard may still show a stale row — your job is to decide from LIVE tool evidence whether the live site is fixed. ' +
        'Use ONLY the evidence JSON. Prefer live.* fields (HTTP, GSC URL inspection / page metrics, PSI re-scan) over stored snapshots. ' +
        'Do not invent HTTP status, scores, clicks, or impressions. ' +
        'If live evidence shows the problem is gone → verdict confirmed (the board will clear/update only this item). ' +
        'If live evidence shows it is still broken → verdict failed, and reason must explain why it still appears / what is still wrong. ' +
        'If live tools failed or evidence is inconclusive for a claimed fix → verdict failed. ' +
        'Reply with exactly one JSON object and no markdown: ' +
        '{"verdict":"confirmed"|"failed","reason":string,"evidence_used":string[]}.',
      messages: [
        { role: 'user', content: userPayload },
        { role: 'assistant', content: '{' },
      ],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error('anthropic ' + res.status + (errBody ? ': ' + errBody.slice(0, 180) : ''));
  }
  const body = await res.json();
  const continuation = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const text = '{' + continuation;
  return parseVerify(text);
}

async function askModel(evidence) {
  // Deterministic live tool signals win (same item, no invented metrics).
  if (evidence.hard_fail) {
    return { verdict: 'failed', reason: evidence.hard_fail, evidence_used: evidence.keys || [] };
  }
  if (evidence.hard_pass) {
    return { verdict: 'confirmed', reason: evidence.hard_pass, evidence_used: evidence.keys || [] };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      verdict: 'failed',
      reason: 'ANTHROPIC_API_KEY missing and no hard pass evidence',
      evidence_used: evidence.keys || [],
    };
  }
  const model = await anthropicModel(key);
  try {
    return await callAnthropicVerify(key, model, evidence);
  } catch (err) {
    // One retry for blank / non-JSON model replies.
    if (/not json|bad verdict/i.test(String(err.message || ''))) {
      try {
        return await callAnthropicVerify(key, model, evidence, { forceRetryHint: true });
      } catch (err2) {
        throw new Error(String(err2.message || err2).slice(0, 240));
      }
    }
    throw err;
  }
}

async function httpStatus(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15000) });
    return String(head.status);
  } catch {
    try {
      const get = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000) });
      return String(get.status);
    } catch {
      return null;
    }
  }
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return String(url || '');
  }
}

async function evidenceFor(db, ack) {
  const snap = ack.claim_snapshot || {};
  const keys = [];
  const out = {
    source_kind: ack.source_kind,
    source_id: ack.source_id,
    title: snap.title || null,
    url: snap.url || null,
    note: snap.note || null,
    keys,
  };

  if (ack.source_kind === 'gsc_issue') {
    const { data: issue } = await db.from('issues').select('*').eq('id', ack.source_id).eq('site_id', ack.site_id).maybeSingle();
    out.issue = issue
      ? { id: issue.id, url: issue.url, action: issue.action, category: issue.category, status: issue.status, note: issue.note }
      : null;
    const url = (issue && issue.url) || snap.url;
    out.url = url || null;
    out.observed_status = await httpStatus(url);
    keys.push('observed_status', 'issue');
    if (url) {
      const path = pathOf(url);
      const { data: pages } = await db
        .from('search_pages')
        .select('page, clicks, impressions, ctr, position')
        .eq('site_id', ack.site_id)
        .eq('organization_id', ack.organization_id)
        .order('impressions', { ascending: false })
        .limit(500);
      out.search_pages = (pages || []).filter((p) => p.page === path || p.page === url).slice(0, 3);
      keys.push('search_pages');
    }
    // Hard pass: claimed as 404/403/error and live is now 200.
    const cat = String((issue && issue.category) || '').toLowerCase();
    if (out.observed_status === '200' && ['404', '403', 'error', 'not-indexed'].includes(cat)) {
      out.hard_pass = `Live HTTP ${out.observed_status} for previously ${cat} URL`;
    }
    if (out.observed_status && ['404', '403', '500', '502', '503'].includes(out.observed_status) && ['404', '403', 'error'].includes(cat)) {
      out.hard_fail = `Live HTTP still ${out.observed_status}`;
    }
    return out;
  }

  if (ack.source_kind === 'psi_issue') {
    const { data: issue } = await db
      .from('psi_issues')
      .select('id, audit_id, severity, title, strategy, task_id, psi_scores!inner(page_url, metric_date, mobile_score, desktop_score)')
      .eq('id', ack.source_id)
      .eq('site_id', ack.site_id)
      .maybeSingle();
    out.psi_issue = issue || null;
    keys.push('psi_issue');
    const page = issue && issue.psi_scores && issue.psi_scores.page_url;
    const auditId = issue && issue.audit_id;
    out.url = page || snap.url || null;
    if (page && auditId) {
      const { data: latest } = await db
        .from('psi_scores')
        .select('metric_date')
        .eq('site_id', ack.site_id)
        .order('metric_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latest) {
        const { data: still } = await db
          .from('psi_issues')
          .select('id, severity, audit_id, psi_scores!inner(page_url, metric_date)')
          .eq('site_id', ack.site_id)
          .eq('audit_id', auditId)
          .eq('psi_scores.page_url', page)
          .eq('psi_scores.metric_date', latest.metric_date)
          .in('severity', ['critical', 'high'])
          .limit(5);
        out.latest_scan_date = latest.metric_date;
        out.still_open_on_latest = still || [];
        keys.push('still_open_on_latest', 'latest_scan_date');
        if (!(still || []).length) out.hard_pass = `Audit ${auditId} not critical/high on ${latest.metric_date}`;
        else out.hard_fail = `Audit ${auditId} still critical/high on ${latest.metric_date}`;
      }
    }
    return out;
  }

  if (ack.source_kind === 'task') {
    const { data: task } = await db.from('tasks').select('*').eq('id', ack.source_id).eq('organization_id', ack.organization_id).maybeSingle();
    out.task = task
      ? { id: task.id, title: task.title, status: task.status, issue_id: task.issue_id, source: task.source, details: (task.details || '').slice(0, 400) }
      : null;
    keys.push('task');
    if (task && task.issue_id) {
      const nested = await evidenceFor(db, {
        ...ack,
        source_kind: 'gsc_issue',
        source_id: task.issue_id,
        claim_snapshot: snap,
      });
      out.linked_issue_evidence = nested;
      keys.push('linked_issue_evidence');
      if (nested.hard_pass) out.hard_pass = nested.hard_pass;
      if (nested.hard_fail) out.hard_fail = nested.hard_fail;
    } else if (snap.url) {
      out.observed_status = await httpStatus(snap.url);
      keys.push('observed_status');
    } else {
      out.hard_pass = 'No measurable URL or issue link; accepting human claim with caveat';
    }
    return out;
  }

  if (ack.source_kind === 'audit_finding' || ack.source_kind === 'fix') {
    out.snapshot = snap;
    keys.push('snapshot');
    if (snap.url) {
      out.observed_status = await httpStatus(snap.url);
      keys.push('observed_status');
      const path = pathOf(snap.url);
      const { data: pages } = await db
        .from('search_pages')
        .select('page, clicks, impressions, position')
        .eq('site_id', ack.site_id)
        .order('impressions', { ascending: false })
        .limit(500);
      out.search_pages = (pages || []).filter((p) => p.page === path || p.page === snap.url).slice(0, 3);
      keys.push('search_pages');
    } else {
      out.hard_pass = 'No URL on finding; accepting human claim with caveat';
    }
    return out;
  }

  // KPI / keyword / page / cannibalization / content / etc. — use claim snapshot + stored board data.
  return evidenceBoard(db, ack, out, keys, snap);
}

async function loadOverview(db, siteId) {
  const { data } = await db
    .from('site_snapshots')
    .select('document, updated_at')
    .eq('site_id', siteId)
    .eq('kind', 'overview')
    .maybeSingle();
  return data || null;
}

function pickMetric(doc, metricKey) {
  if (!doc || !metricKey) return null;
  const g = doc.gsc && doc.gsc.current ? doc.gsc.current : null;
  const a = doc.ga4 && doc.ga4.totals ? doc.ga4.totals : null;
  const map = {
    'gsc.clicks': g && g.clicks,
    'gsc.impressions': g && g.impressions,
    'gsc.ctr': g && g.ctr,
    'gsc.position': g && g.position,
    'ga4.sessions': a && a.sessions,
    'ga4.activeUsers': a && a.activeUsers,
    'ga4.engagementRate': a && a.engagementRate,
  };
  if (Object.prototype.hasOwnProperty.call(map, metricKey)) return map[metricKey];
  const parts = String(metricKey).split('.');
  let cur = doc;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[p];
  }
  return typeof cur === 'number' ? cur : null;
}

async function evidenceBoard(db, ack, out, keys, snap) {
  out.snapshot = snap;
  keys.push('snapshot');

  const overview = await loadOverview(db, ack.site_id);
  if (overview) {
    out.overview_updated_at = overview.updated_at;
    keys.push('overview_updated_at');
    const doc = overview.document || {};
    if (ack.source_kind === 'kpi' || snap.metricKey) {
      out.current_metric = pickMetric(doc, snap.metricKey);
      out.claimed_metric = snap.metricValue != null ? Number(snap.metricValue) : null;
      out.current_gsc = doc.gsc && doc.gsc.current ? doc.gsc.current : null;
      out.current_ga4 = doc.ga4 && doc.ga4.totals ? doc.ga4.totals : null;
      keys.push('current_metric', 'current_gsc', 'current_ga4');
      if (snap.warn && out.current_metric != null && out.claimed_metric != null) {
        // Lower-is-worse problem metrics (critical tasks, position when high): still bad if not improved.
        const worseIsHigher = !/ctr|engagement|score|clicks|impressions|sessions|users/i.test(String(snap.metricKey || ''));
        if (worseIsHigher && out.current_metric >= out.claimed_metric && out.claimed_metric > 0) {
          out.hard_fail = `Metric ${snap.metricKey} still ${out.current_metric} (was ${out.claimed_metric})`;
        }
      }
    }
    if (ack.source_kind === 'cannibalization' || snap.query) {
      const cann = doc.gscCannibalization;
      if (cann && Array.isArray(cann.rows) && snap.query) {
        const still = cann.rows.filter((r) => r.query === snap.query).slice(0, 3);
        out.cannibalization_rows = still;
        keys.push('cannibalization_rows');
        if (still.length && (still[0].pages || []).length > 1) {
          out.hard_fail = `Query still cannibalized across ${(still[0].pages || []).length} pages`;
        } else if (cann.status === 'ok' && snap.query && !still.length) {
          out.hard_pass = 'Query no longer in cannibalization list';
        }
      }
    }
    if (ack.source_kind === 'channel' && snap.title) {
      const channels = (doc.ga4 && doc.ga4.channels) || [];
      out.channel_row = channels.find((c) => c.channel === snap.title) || null;
      keys.push('channel_row');
    }
  }

  const url = snap.url || snap.targetUrl || snap.sourceUrl || null;
  if (url) {
    out.url = url;
    out.observed_status = await httpStatus(url);
    keys.push('observed_status');
    if (snap.sourceUrl && snap.targetUrl) {
      out.source_status = await httpStatus(snap.sourceUrl);
      out.target_status = await httpStatus(snap.targetUrl);
      keys.push('source_status', 'target_status');
      if (out.source_status === '200' && out.target_status === '200') {
        out.hard_pass = out.hard_pass || 'Source and target URLs return HTTP 200';
      }
      if (['404', '403', '500', '502', '503'].includes(out.source_status) || ['404', '403', '500', '502', '503'].includes(out.target_status)) {
        out.hard_fail = `Link endpoints not healthy (${out.source_status}/${out.target_status})`;
      }
    }
  }

  if (snap.query || ack.source_kind === 'keyword' || ack.source_kind === 'content_idea' || ack.source_kind === 'topic_trend') {
    const q = snap.query || snap.title || null;
    if (q) {
      const { data: qs } = await db
        .from('search_queries')
        .select('query, clicks, impressions, ctr, position')
        .eq('site_id', ack.site_id)
        .eq('query', q)
        .limit(5);
      out.search_queries = qs || [];
      keys.push('search_queries');
    }
  }

  if (snap.page || ack.source_kind === 'page' || (snap.url && ack.source_kind === 'page')) {
    const page = snap.page || pathOf(snap.url);
    if (page) {
      const { data: pages } = await db
        .from('search_pages')
        .select('page, clicks, impressions, ctr, position')
        .eq('site_id', ack.site_id)
        .eq('page', page)
        .limit(5);
      out.search_pages = pages || [];
      keys.push('search_pages');
    }
  }

  if (!out.hard_pass && !out.hard_fail && !url && !snap.query && !snap.metricKey && !snap.page) {
    out.hard_pass = 'Informational board row with no measurable URL/query/metric; accepting human claim with caveat';
  }
  // Healthy KPI / info claim (human reviewed, not a warn tile): accept without requiring the LLM.
  if (!out.hard_pass && !out.hard_fail && !snap.warn && (snap.metricKey || ack.source_kind === 'kpi' || ack.source_kind === 'channel' || ack.source_kind === 'clarity' || ack.source_kind === 'deploy')) {
    out.hard_pass = 'Healthy/info board claim with no warn flag; accepting human Addressed mark';
  }
  return out;
}

async function applyClaimSideEffects(db, ack, actorLabel) {
  const now = new Date().toISOString();
  if (ack.source_kind === 'gsc_issue') {
    await db.from('issues').update({ status: 'fixed' }).eq('id', ack.source_id).eq('site_id', ack.site_id);
  }
  if (ack.source_kind === 'task') {
    const { data: task } = await db.from('tasks').select('id, status, organization_id').eq('id', ack.source_id).maybeSingle();
    if (task && task.status !== 'done') {
      await db.from('tasks').update({ status: 'done', completed_at: now }).eq('id', task.id);
      await db.from('task_events').insert({
        task_id: task.id,
        organization_id: task.organization_id,
        actor: actorLabel || 'ack',
        from_status: task.status,
        to_status: 'done',
        note: 'addressed checkbox',
      });
    }
  }
  if (ack.source_kind === 'psi_issue') {
    const { data: issue } = await db.from('psi_issues').select('id, task_id').eq('id', ack.source_id).maybeSingle();
    if (issue && issue.task_id) {
      const { data: task } = await db.from('tasks').select('id, status, organization_id').eq('id', issue.task_id).maybeSingle();
      if (task && task.status !== 'done') {
        await db.from('tasks').update({ status: 'done', completed_at: now }).eq('id', task.id);
        await db.from('task_events').insert({
          task_id: task.id,
          organization_id: task.organization_id,
          actor: actorLabel || 'ack',
          from_status: task.status,
          to_status: 'done',
          note: 'addressed checkbox (psi)',
        });
      }
    }
    await db.from('psi_issues').update({ reviewed_at: now }).eq('id', ack.source_id);
  }
}

async function applyConfirmedPatches(db, ack, evidence, actorLabel) {
  const now = new Date().toISOString();
  const reason = (evidence && evidence.live && evidence.live.http && evidence.live.http.status)
    ? `live HTTP ${evidence.live.http.status}`
    : 'live verify confirmed';
  const patches = [];

  if (ack.source_kind === 'gsc_issue') {
    await db.from('issues').update({
      status: 'fixed',
      note: [ack.claim_snapshot && ack.claim_snapshot.note, `Verified live (${reason})`].filter(Boolean).join(' · ').slice(0, 500),
    }).eq('id', ack.source_id).eq('site_id', ack.site_id);
    patches.push('issues');
    const httpStatus = evidence?.live?.http?.status || evidence?.observed_status || null;
    await db.from('issue_reviews').insert({
      issue_id: ack.source_id,
      organization_id: ack.organization_id,
      why: 'Human marked Addressed; live tools confirmed.',
      fix: (ack.claim_snapshot && ack.claim_snapshot.note) || 'Verified live',
      observed_status: httpStatus ? String(httpStatus) : 'confirmed_live',
      reviewed_at: now,
      agents: ['ack-verify'],
    });
    patches.push('issue_reviews');
  }

  if (ack.source_kind === 'psi_issue') {
    await db.from('psi_issues').update({ reviewed_at: now }).eq('id', ack.source_id);
    patches.push('psi_issues');
  }

  if (ack.source_kind === 'task') {
    await db.from('tasks').update({ status: 'done', completed_at: now }).eq('id', ack.source_id);
    patches.push('tasks');
  }

  // Record which live patches already ran during probe.
  if (evidence?.live?.patches?.length) patches.push(...evidence.live.patches);

  await db.from('agent_runs').insert({
    organization_id: ack.organization_id,
    site_id: ack.site_id,
    kind: 'ack-patch',
    status: 'succeeded',
    detail: {
      ack_id: ack.id,
      source_kind: ack.source_kind,
      source_id: ack.source_id,
      patches: [...new Set(patches)],
      actor: actorLabel || 'ack-verify',
      note: 'Targeted update only — not a full sync',
    },
  });
  return patches;
}

async function applyFailedSideEffects(db, ack, actorLabel) {
  if (ack.source_kind === 'gsc_issue') {
    await db.from('issues').update({ status: 'open' }).eq('id', ack.source_id).eq('site_id', ack.site_id);
  }
  if (ack.source_kind === 'task') {
    const { data: task } = await db.from('tasks').select('id, status, organization_id').eq('id', ack.source_id).maybeSingle();
    if (task && task.status === 'done') {
      await db.from('tasks').update({ status: 'todo', completed_at: null }).eq('id', task.id);
      await db.from('task_events').insert({
        task_id: task.id,
        organization_id: task.organization_id,
        actor: actorLabel || 'ack-verify',
        from_status: 'done',
        to_status: 'todo',
        note: 'verify failed — reopened',
      });
    }
  }
  if (ack.source_kind === 'psi_issue') {
    const { data: issue } = await db.from('psi_issues').select('id, task_id').eq('id', ack.source_id).maybeSingle();
    if (issue && issue.task_id) {
      const { data: task } = await db.from('tasks').select('id, status, organization_id').eq('id', issue.task_id).maybeSingle();
      if (task && task.status === 'done') {
        await db.from('tasks').update({ status: 'todo', completed_at: null }).eq('id', task.id);
        await db.from('task_events').insert({
          task_id: task.id,
          organization_id: task.organization_id,
          actor: actorLabel || 'ack-verify',
          from_status: 'done',
          to_status: 'todo',
          note: 'verify failed — reopened (psi)',
        });
      }
    }
  }
}

export async function claimAck(db, {
  organizationId,
  siteId,
  sourceKind,
  sourceId,
  snapshot = {},
  claimedBy,
}) {
  if (!KINDS.has(sourceKind)) {
    const err = new Error('invalid sourceKind');
    err.status = 400;
    throw err;
  }
  if (!sourceId) {
    const err = new Error('sourceId required');
    err.status = 400;
    throw err;
  }
  const now = new Date().toISOString();
  const row = {
    organization_id: organizationId,
    site_id: siteId,
    source_kind: sourceKind,
    source_id: String(sourceId),
    claim_snapshot: {
      title: snapshot.title || null,
      url: snapshot.url || null,
      note: snapshot.note || null,
      query: snapshot.query || null,
      page: snapshot.page || null,
      metricKey: snapshot.metricKey || null,
      metricValue: snapshot.metricValue != null ? snapshot.metricValue : null,
      warn: !!snapshot.warn,
      sourceUrl: snapshot.sourceUrl || null,
      targetUrl: snapshot.targetUrl || null,
      expected: snapshot.expected || null,
    },
    claimed_by: claimedBy || null,
    claimed_at: now,
    verify_status: 'pending',
    verify_detail: {},
    verified_at: null,
    updated_at: now,
  };
  const { data, error } = await db
    .from('acknowledgements')
    .upsert(row, { onConflict: 'organization_id,site_id,source_kind,source_id' })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  await applyClaimSideEffects(db, data, claimedBy);
  return data;
}

export async function unclaimAck(db, { organizationId, siteId, sourceKind, sourceId, actorLabel }) {
  const { data: ack } = await db
    .from('acknowledgements')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('site_id', siteId)
    .eq('source_kind', sourceKind)
    .eq('source_id', sourceId)
    .maybeSingle();
  if (!ack) return null;
  await applyFailedSideEffects(db, ack, actorLabel || 'human-uncheck');
  await db.from('acknowledgements').delete().eq('id', ack.id);
  return ack;
}

function applyLiveHardSignals(evidence, live) {
  if (!live) return evidence;
  evidence.live = live;
  evidence.keys = [...(evidence.keys || []), 'live', ...(live.tools_used || [])];

  if (live.http && live.http.status) {
    evidence.observed_status = live.http.status;
    evidence.keys.push('observed_status');
  }
  if (live.psi && live.psi.claimed_audit_cleared) {
    evidence.hard_pass = `Live PSI re-scan: audit cleared on ${live.psi.metricDate}`;
  }
  if (live.psi && Array.isArray(live.psi.claimed_audit_still_open) && live.psi.claimed_audit_still_open.length) {
    evidence.hard_fail = `Live PSI re-scan: audit still ${live.psi.claimed_audit_still_open.map((a) => a.severity).join('/')} on ${live.psi.pageUrl}`;
  }
  if (live.gsc && live.gsc.inspection && /not.?found|excluded|error|blocked/i.test(String(live.gsc.inspection.coverageState || ''))) {
    if (evidence.source_kind === 'gsc_issue') {
      evidence.hard_fail = evidence.hard_fail || `GSC inspection: ${live.gsc.inspection.coverageState}`;
    }
  }
  if (live.http && ['404', '403', '500', '502', '503'].includes(String(live.http.status)) && (evidence.source_kind === 'gsc_issue' || evidence.source_kind === 'page' || evidence.source_kind === 'internal_link')) {
    evidence.hard_fail = evidence.hard_fail || `Live HTTP still ${live.http.status}`;
  }
  if (live.http && live.http.status === '200' && evidence.source_kind === 'gsc_issue') {
    const cat = String((evidence.issue && evidence.issue.category) || '').toLowerCase();
    if (['404', '403', 'error', 'not-indexed'].includes(cat)) {
      evidence.hard_pass = evidence.hard_pass || `Live HTTP 200 for previously ${cat} URL`;
    }
  }
  return evidence;
}

export async function verifyAck(db, ackId, { actorLabel } = {}) {
  const { data: ack, error } = await db.from('acknowledgements').select('*').eq('id', ackId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!ack) {
    const err = new Error('ack not found');
    err.status = 404;
    throw err;
  }

  // 1) Stored context  2) Live tools for THIS item only  3) LLM  4) Targeted patch
  let evidence = await evidenceFor(db, ack);
  let live = null;
  try {
    live = await probeClaimLive(db, ack);
    evidence = applyLiveHardSignals(evidence, live);
  } catch (err) {
    evidence.live_error = String(err.message || err).slice(0, 300);
    evidence.keys = [...(evidence.keys || []), 'live_error'];
  }

  let result;
  try {
    result = await askModel(evidence);
  } catch (err) {
    result = { verdict: 'failed', reason: 'verify error: ' + err.message, evidence_used: evidence.keys || [] };
  }
  const now = new Date().toISOString();
  const detail = {
    reason: result.reason,
    evidence_used: result.evidence_used,
    evidence,
    live_tools: live && live.tools_used ? live.tools_used : [],
    patches: live && live.patches ? live.patches : [],
  };
  if (result.verdict === 'confirmed') {
    await db.from('acknowledgements').update({
      verify_status: 'confirmed',
      verify_detail: detail,
      verified_at: now,
      updated_at: now,
    }).eq('id', ack.id);
    try {
      detail.patches = await applyConfirmedPatches(db, ack, evidence, actorLabel || 'ack-verify');
    } catch (err) {
      detail.patch_error = String(err.message || err).slice(0, 300);
    }
  } else {
    await applyFailedSideEffects(db, ack, actorLabel || 'ack-verify');
    await db.from('acknowledgements').update({
      verify_status: 'failed',
      verify_detail: detail,
      verified_at: now,
      updated_at: now,
    }).eq('id', ack.id);
  }
  await db.from('agent_runs').insert({
    organization_id: ack.organization_id,
    site_id: ack.site_id,
    kind: 'ack-verify',
    status: result.verdict === 'confirmed' ? 'succeeded' : 'failed',
    detail: {
      ack_id: ack.id,
      source_kind: ack.source_kind,
      source_id: ack.source_id,
      verdict: result.verdict,
      reason: result.reason,
      live_tools: detail.live_tools,
      patches: detail.patches,
      scope: 'item-only',
    },
  });
  const { data: fresh } = await db.from('acknowledgements').select('*').eq('id', ack.id).single();
  return fresh;
}

export async function listAcks(db, { siteId, sinceDay = null }) {
  let q = db
    .from('acknowledgements')
    .select('*')
    .eq('site_id', siteId)
    .order('claimed_at', { ascending: false })
    .limit(2000);
  if (sinceDay) q = q.gte('claimed_at', sinceDay);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(shapeAck);
}

export async function ackTodaySummary(db, siteId) {
  const day = new Date().toISOString().slice(0, 10);
  const rows = await listAcks(db, { siteId, sinceDay: day });
  return {
    day,
    claimed: rows.length,
    pending: rows.filter((r) => r.verifyStatus === 'pending').length,
    confirmed: rows.filter((r) => r.verifyStatus === 'confirmed').length,
    failed: rows.filter((r) => r.verifyStatus === 'failed').length,
    items: rows,
  };
}
