import express from 'express';

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

const avg = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

// Rows arrive newest first; keep the first (latest) row per page.
export function latestPerPage(rows) {
  const seen = new Map();
  for (const row of rows || []) if (!seen.has(row.page_url)) seen.set(row.page_url, row);
  return [...seen.values()];
}

export function summarize(rows) {
  const latest = latestPerPage(rows);
  const issues = latest.flatMap((r) => r.psi_issues || []);
  const open = issues.filter((i) => !i.tasks || i.tasks.status !== 'done');
  return {
    avg_mobile_score: avg(latest.map((r) => r.mobile_score)),
    avg_desktop_score: avg(latest.map((r) => r.desktop_score)),
    critical_issues: open.filter((i) => i.severity === 'critical').length,
    high_issues: open.filter((i) => i.severity === 'high').length,
    pages_scanned: latest.length,
    last_scan: latest.reduce((m, r) => (r.metric_date > m ? r.metric_date : m), '') || null,
  };
}

export function trend(rows) {
  const byDay = new Map();
  for (const r of rows || []) {
    if (!byDay.has(r.metric_date)) byDay.set(r.metric_date, { m: [], d: [] });
    byDay.get(r.metric_date).m.push(r.mobile_score);
    byDay.get(r.metric_date).d.push(r.desktop_score);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, avg_mobile_score: avg(v.m), avg_desktop_score: avg(v.d) }));
}

function windowStart(days) {
  const n = Math.min(Math.max(parseInt(days || '28', 10) || 28, 1), 90);
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {object} deps
 * @param {(req, res) => Promise<object|null>} deps.authorize resolves the site the caller may read, or sends an error and returns null
 * @param {(res, data, status?) => void} deps.send JSON responder (sets CORS headers)
 */
export function createPsiRouter({ authorize, send }) {
  const router = express.Router();

  // GET /api/psi/scores?site_id=&days=28
  router.get('/psi/scores', async (req, res) => {
    const site = await authorize(req, res);
    if (!site) return;
    const { data, error } = await req.db
      .from('psi_scores')
      .select(`id, page_url, metric_date,
        mobile_score, desktop_score, lcp_mobile, lcp_desktop, fcp_mobile, fcp_desktop,
        cls_mobile, cls_desktop, ttfb_mobile, ttfb_desktop,
        psi_issues(id, strategy, audit_id, severity, title, impact_score, estimated_savings, task_id, tasks(id, status, assignee))`)
      .eq('site_id', site.id)
      .gte('metric_date', windowStart(req.query.days))
      .order('metric_date', { ascending: false })
      .limit(5000);
    if (error) return send(res, { error: error.message }, 500);
    send(res, {
      siteId: site.id,
      domain: site.domain,
      summary: summarize(data),
      scores: latestPerPage(data),
      trend: trend(data),
    });
  });

  // GET /api/psi/issues?site_id=&severity=critical,high&category=&has_task=true|false&strategy=&scope=latest|all
  router.get('/psi/issues', async (req, res) => {
    const site = await authorize(req, res);
    if (!site) return;
    const severity = String(req.query.severity || 'critical,high').split(',').map((s) => s.trim()).filter((s) => SEVERITIES.has(s));
    if (!severity.length) return send(res, { error: 'severity must be one of critical, high, medium, low' }, 400);

    let scoreFilterDate = null;
    if (req.query.scope !== 'all') {
      const { data: latest } = await req.db.from('psi_scores').select('metric_date').eq('site_id', site.id).order('metric_date', { ascending: false }).limit(1).maybeSingle();
      if (!latest) return send(res, { issues: [] });
      scoreFilterDate = latest.metric_date;
    }

    let query = req.db
      .from('psi_issues')
      .select('id, strategy, audit_id, title, severity, impact_score, estimated_savings, category, task_id, psi_scores!inner(page_url, metric_date), tasks(id, status, assignee, title)')
      .eq('site_id', site.id)
      .in('severity', severity);
    if (scoreFilterDate) query = query.eq('psi_scores.metric_date', scoreFilterDate);
    else query = query.gte('psi_scores.metric_date', windowStart(req.query.days));
    if (req.query.category) query = query.eq('category', String(req.query.category));
    if (req.query.strategy === 'mobile' || req.query.strategy === 'desktop') query = query.eq('strategy', req.query.strategy);
    if (req.query.has_task === 'true') query = query.not('task_id', 'is', null);
    else if (req.query.has_task === 'false') query = query.is('task_id', null);

    const { data, error } = await query.order('impact_score', { ascending: false }).limit(200);
    if (error) return send(res, { error: error.message }, 500);
    send(res, { issues: data || [] });
  });

  return router;
}
