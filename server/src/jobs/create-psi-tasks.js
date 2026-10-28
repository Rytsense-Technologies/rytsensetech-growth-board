// Weekly: turn critical/high PSI issues from the latest scan into Development tasks.
// One task per (page, audit); mobile + desktop findings for the same audit share it.

const MAX_TASKS_PER_SITE = 25;
const DEV_TEAM = 'Development'; // matches the team name used in data/tasks.json and tasks.html

function pathOf(url) {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url || 'unknown'; }
}

async function notifySlack(text, fetchImpl = fetch) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return false;
  try {
    const body = { text };
    if (process.env.SLACK_DEV_CHANNEL) body.channel = process.env.SLACK_DEV_CHANNEL; // ignored by most app webhooks
    const res = await fetchImpl(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.ok;
  } catch (err) {
    console.error('[PSI Tasks] Slack notification failed:', err.message);
    return false;
  }
}

export function groupIssues(issues) {
  const groups = new Map();
  for (const issue of issues || []) {
    const page = issue.psi_scores && issue.psi_scores.page_url;
    const key = `${page}::${issue.audit_id}`;
    if (!groups.has(key)) groups.set(key, { page, auditId: issue.audit_id, title: issue.title, issues: [] });
    groups.get(key).issues.push(issue);
  }
  const rank = (g) => (g.issues.some((i) => i.severity === 'critical') ? 2 : 1) * 1000 + Math.max(...g.issues.map((i) => i.impact_score || 0));
  return [...groups.values()].sort((a, b) => rank(b) - rank(a));
}

export function taskFor(group, site) {
  const critical = group.issues.some((i) => i.severity === 'critical');
  const lines = [...group.issues]
    .sort((a, b) => a.strategy.localeCompare(b.strategy))
    .map((i) => `- ${i.strategy}: ${i.severity}, impact ${i.impact_score}/100${i.estimated_savings ? ` (${i.estimated_savings})` : ''}`);
  const description = (group.issues[0].description || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return {
    title: `[PSI] ${pathOf(group.page)}: ${group.title}`.slice(0, 200),
    details: [
      `PageSpeed Insights flagged "${group.title}" on ${group.page}.`,
      '',
      ...lines,
      '',
      description,
      '',
      `Re-test: https://pagespeed.web.dev/analysis?url=${encodeURIComponent(group.page)}`,
      `Lighthouse audit id: ${group.auditId} · site ${site.domain}`,
    ].join('\n').trim(),
    priority: critical ? 'critical' : 'high',
  };
}

async function createForSite(db, site, fetchImpl) {
  const out = { siteId: site.id, domain: site.domain, tasksCreated: 0, linkedExisting: 0, created: [] };

  const { data: latest } = await db.from('psi_scores').select('metric_date').eq('site_id', site.id).order('metric_date', { ascending: false }).limit(1).maybeSingle();
  if (!latest) return out;

  // Only issues from the most recent scan, so already-fixed problems don't become tasks.
  const { data: issues, error } = await db
    .from('psi_issues')
    .select('id, audit_id, strategy, title, description, severity, impact_score, estimated_savings, psi_scores!inner(page_url, metric_date)')
    .eq('site_id', site.id)
    .eq('psi_scores.metric_date', latest.metric_date)
    .in('severity', ['critical', 'high'])
    .is('task_id', null)
    .limit(500);
  if (error) throw new Error(`psi_issues: ${error.message}`);

  for (const group of groupIssues(issues).slice(0, MAX_TASKS_PER_SITE)) {
    const draft = taskFor(group, site);
    const ids = group.issues.map((i) => i.id);
    const now = new Date().toISOString();

    // Reuse an open task with the same title; a done task means this is a regression, so make a new one.
    const { data: existing } = await db
      .from('tasks')
      .select('id')
      .eq('organization_id', site.organization_id)
      .eq('site_id', site.id)
      .eq('title', draft.title)
      .neq('status', 'done')
      .limit(1)
      .maybeSingle();

    let taskId = existing && existing.id;
    if (!taskId) {
      taskId = `T-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const { error: taskError } = await db.from('tasks').insert({
        id: taskId,
        organization_id: site.organization_id,
        site_id: site.id,
        title: draft.title,
        details: draft.details,
        status: 'todo',
        priority: draft.priority,
        assignee: null,
        team: DEV_TEAM,
        source: 'psi',
      });
      if (taskError) { console.error('[PSI Tasks] task insert failed:', taskError.message); continue; }
      await db.from('task_events').insert({
        task_id: taskId, organization_id: site.organization_id, actor: 'psi-bot', from_status: null, to_status: 'todo', note: 'created from PageSpeed Insights',
      });
      out.tasksCreated++;
      out.created.push({ id: taskId, title: draft.title, priority: draft.priority });
    } else {
      out.linkedExisting++;
    }

    const { error: linkError } = await db.from('psi_issues').update({ task_id: taskId, reviewed_at: now }).in('id', ids);
    if (linkError) console.error('[PSI Tasks] link failed:', linkError.message);
  }

  if (out.created.length) {
    const appUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
    const list = out.created.slice(0, 10).map((t) => `• ${t.priority === 'critical' ? ':red_circle:' : ':large_orange_circle:'} ${t.title} (${t.id})`).join('\n');
    const more = out.created.length > 10 ? `\n…and ${out.created.length - 10} more` : '';
    out.slackNotified = await notifySlack(
      `:zap: ${out.created.length} new PageSpeed task${out.created.length === 1 ? '' : 's'} for ${site.domain} (Development)\n${list}${more}${appUrl ? `\n${appUrl}/tasks.html` : ''}`,
      fetchImpl
    );
  }
  return out;
}

export async function createPSITasks(db, { siteId = null, fetchImpl = fetch } = {}) {
  if (!db) throw new Error('database not configured');
  let query = db.from('sites').select('id, organization_id, domain, organizations!inner(status)').eq('organizations.status', 'active');
  if (siteId) query = query.eq('id', siteId);
  const { data: sites, error } = await query;
  if (error) throw new Error(`sites: ${error.message}`);

  const perSite = [];
  for (const site of sites || []) perSite.push(await createForSite(db, site, fetchImpl));
  const result = {
    tasksCreated: perSite.reduce((a, s) => a + s.tasksCreated, 0),
    linkedExisting: perSite.reduce((a, s) => a + s.linkedExisting, 0),
    sites: perSite,
  };
  console.log(`[PSI Tasks] done: ${result.tasksCreated} created, ${result.linkedExisting} linked to existing`);
  return result;
}
