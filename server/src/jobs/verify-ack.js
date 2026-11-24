// Human claimed "Addressed / live". Gather stored evidence, ask the model once,
// then confirm or reopen. Never invent HTTP status, PSI scores, or GSC metrics.

import { pickAutoModel, isAutoModel } from '../jobs.js';

const KINDS = new Set(['gsc_issue', 'psi_issue', 'audit_finding', 'fix', 'task']);

export function parseVerify(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('not json');
  const obj = JSON.parse(raw.slice(start, end + 1));
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

async function askModel(evidence) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // No model: confirm only when evidence itself already proves the fix.
    if (evidence.hard_pass) {
      return { verdict: 'confirmed', reason: evidence.hard_pass, evidence_used: evidence.keys || [] };
    }
    if (evidence.hard_fail) {
      return { verdict: 'failed', reason: evidence.hard_fail, evidence_used: evidence.keys || [] };
    }
    return {
      verdict: 'failed',
      reason: 'ANTHROPIC_API_KEY missing and no hard pass evidence',
      evidence_used: evidence.keys || [],
    };
  }
  const model = await anthropicModel(key);
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
        'You verify whether a Growth Board issue was fixed in live. ' +
        'Use ONLY the evidence JSON. Do not invent HTTP status, scores, clicks, or impressions. ' +
        'If evidence is missing or inconclusive, verdict must be failed. ' +
        'Return one JSON object: { "verdict": "confirmed"|"failed", "reason": string, "evidence_used": string[] }.',
      messages: [
        {
          role: 'user',
          content: 'Evidence:\n' + JSON.stringify(evidence),
        },
      ],
    }),
  });
  if (!res.ok) throw new Error('anthropic ' + res.status);
  const body = await res.json();
  const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return parseVerify(text);
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

  // audit_finding | fix — snapshot from the client is the identity; prove via URL when present.
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

export async function verifyAck(db, ackId, { actorLabel } = {}) {
  const { data: ack, error } = await db.from('acknowledgements').select('*').eq('id', ackId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!ack) {
    const err = new Error('ack not found');
    err.status = 404;
    throw err;
  }
  const evidence = await evidenceFor(db, ack);
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
  };
  if (result.verdict === 'confirmed') {
    await db.from('acknowledgements').update({
      verify_status: 'confirmed',
      verify_detail: detail,
      verified_at: now,
      updated_at: now,
    }).eq('id', ack.id);
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
    detail: { ack_id: ack.id, source_kind: ack.source_kind, source_id: ack.source_id, verdict: result.verdict, reason: result.reason },
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
