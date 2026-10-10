import { readFileSync, existsSync } from 'fs';
import { google } from 'googleapis';
import {
  REVIEW_BATCH,
  REVIEW_ORDER,
  parseReview,
} from './scope.js';

const SPECIALIST = new URL('../../SEO-agents-main/.claude/agents/technical-seo-engineer.md', import.meta.url);

function specialistExcerpt() {
  if (!existsSync(SPECIALIST)) return 'You are the technical SEO engineer.';
  return readFileSync(SPECIALIST, 'utf8').slice(0, 2500);
}

async function claude(messages, tools) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const err = new Error('ANTHROPIC_API_KEY missing');
    err.status = 503;
    throw err;
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      max_tokens: 1200,
      system: specialistExcerpt(),
      messages,
      tools,
    }),
  });
  if (!res.ok) throw new Error('anthropic ' + res.status + ' ' + (await res.text()));
  return res.json();
}

function toolText(content) {
  return (content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

async function refreshToken(db, connection) {
  if (!connection.vault_secret_id) return null;
  const { data, error } = await db.rpc('read_connection_secret', { p_id: connection.vault_secret_id });
  if (error) throw error;
  return data;
}

function oauthClient(refresh) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({ refresh_token: refresh });
  return client;
}

export async function runDailySync(db) {
  const { data: connections, error } = await db
    .from('connections')
    .select('id, organization_id, site_id, provider, status, external_property_id, vault_secret_id')
    .eq('status', 'connected');
  if (error) throw error;
  const results = [];
  for (const connection of connections || []) {
    try {
      if (connection.provider === 'gsc') await syncGsc(db, connection);
      else if (connection.provider === 'ga4') await syncGa4(db, connection);
      else if (connection.provider === 'clarity') await syncClarity(db, connection);
      await db.from('connections').update({ last_sync_at: new Date().toISOString(), last_error: null, status: 'connected' }).eq('id', connection.id);
      results.push({ id: connection.id, ok: true });
    } catch (err) {
      await db.from('connections').update({ status: 'error', last_error: String(err.message || err).slice(0, 400) }).eq('id', connection.id);
      results.push({ id: connection.id, ok: false, error: String(err.message || err) });
    }
  }
  if (process.env.CLARITY_URL) {
    const { data: sites } = await db.from('sites').select('id, organization_id');
    for (const site of sites || []) {
      try {
        await syncClarity(db, { organization_id: site.organization_id, site_id: site.id });
      } catch {
        /* one site's clarity failure does not stop the job */
      }
    }
  }
  await db.from('agent_runs').insert({
    organization_id: (connections && connections[0] && connections[0].organization_id) || '11111111-1111-4111-8111-111111111111',
    kind: 'daily-sync',
    status: 'succeeded',
    detail: { results },
  });
  return { results };
}

async function syncGsc(db, connection) {
  const token = await refreshToken(db, connection);
  if (!token) throw new Error('missing refresh token');
  const auth = oauthClient(token);
  const sc = google.searchconsole({ version: 'v1', auth });
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const siteUrl = connection.external_property_id;
  const totals = await sc.searchanalytics.query({
    siteUrl,
    requestBody: { startDate: fmt(start), endDate: fmt(end), dimensions: [] },
  });
  const row = (totals.data.rows && totals.data.rows[0]) || {};
  const day = fmt(end);
  await db.from('metric_daily').upsert({
    organization_id: connection.organization_id,
    site_id: connection.site_id,
    day,
    source: 'gsc',
    payload: {
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      ctr: row.ctr != null ? +(row.ctr * 100).toFixed(2) : null,
      position: row.position || null,
      period: { startDate: fmt(start), endDate: fmt(end) },
    },
  }, { onConflict: 'site_id,day,source' });
  const pages = await sc.searchanalytics.query({
    siteUrl,
    requestBody: { startDate: fmt(start), endDate: fmt(end), dimensions: ['page'], rowLimit: 500 },
  });
  await db.from('search_pages').delete().eq('site_id', connection.site_id);
  const pageRows = (pages.data.rows || []).map((r) => ({
    organization_id: connection.organization_id,
    site_id: connection.site_id,
    period_start: fmt(start),
    period_end: fmt(end),
    page: r.keys[0],
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr != null ? +(r.ctr * 100).toFixed(2) : null,
    position: r.position,
  }));
  if (pageRows.length) await db.from('search_pages').insert(pageRows);
}

async function syncGa4(db, connection) {
  const token = await refreshToken(db, connection);
  if (!token) throw new Error('missing refresh token');
  const auth = oauthClient(token);
  const data = google.analyticsdata({ version: 'v1beta', auth });
  const property = connection.external_property_id;
  const report = await data.properties.runReport({
    property,
    requestBody: {
      dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
    },
  });
  const metrics = (report.data.rows && report.data.rows[0] && report.data.rows[0].metricValues) || [];
  const day = new Date();
  day.setUTCDate(day.getUTCDate() - 1);
  await db.from('metric_daily').upsert({
    organization_id: connection.organization_id,
    site_id: connection.site_id,
    day: day.toISOString().slice(0, 10),
    source: 'ga4',
    payload: {
      sessions: Number(metrics[0] && metrics[0].value) || 0,
      activeUsers: Number(metrics[1] && metrics[1].value) || 0,
    },
  }, { onConflict: 'site_id,day,source' });
}

async function syncClarity(db, connection) {
  const url = process.env.CLARITY_URL;
  if (!url) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error('clarity ' + res.status);
  const body = await res.json();
  const day = new Date().toISOString().slice(0, 10);
  await db.from('metric_daily').upsert({
    organization_id: connection.organization_id,
    site_id: connection.site_id,
    day,
    source: 'clarity',
    payload: { status: 'ok', raw: body },
  }, { onConflict: 'site_id,day,source' });
}

export async function runWeeklyReview(db, siteId) {
  let query = db.from('issues').select('id, organization_id, site_id, category, url, action, note').eq('status', 'open');
  if (siteId) query = query.eq('site_id', siteId);
  const { data: issues, error } = await query.limit(400);
  if (error) throw error;
  const { data: reviewed } = await db.from('issue_reviews').select('issue_id');
  const done = new Set((reviewed || []).map((r) => r.issue_id));
  const pending = (issues || [])
    .filter((i) => !done.has(i.id))
    .sort((a, b) => REVIEW_ORDER.indexOf(a.category) - REVIEW_ORDER.indexOf(b.category))
    .slice(0, REVIEW_BATCH);
  let wrote = 0;
  for (const issue of pending) {
    let observed = null;
    if (issue.url && String(issue.url).startsWith('http')) {
      try {
        const head = await fetch(issue.url, { method: 'HEAD', redirect: 'manual' });
        observed = String(head.status);
      } catch {
        observed = null;
      }
    }
    try {
      const message = await claude([
        {
          role: 'user',
          content:
            'Return one JSON object with why, fix, owner_team, effort, observed_status. ' +
            'Use this observed HTTP status if not null, and do not invent a different one: ' +
            JSON.stringify(observed) +
            '\nIssue: ' +
            JSON.stringify({ url: issue.url, action: issue.action, note: issue.note, category: issue.category }),
        },
      ]);
      const review = parseReview(toolText(message.content));
      review.observed_status = observed;
      await db.from('issue_reviews').insert({
        issue_id: issue.id,
        organization_id: issue.organization_id,
        why: review.why,
        fix: review.fix,
        owner_team: review.owner_team,
        effort: review.effort,
        observed_status: observed,
        agents: ['technical-seo-engineer'],
      });
      wrote += 1;
    } catch {
      /* skip invalid model output */
    }
  }
  if (pending[0]) {
    await db.from('agent_runs').insert({
      organization_id: pending[0].organization_id,
      site_id: pending[0].site_id,
      kind: 'weekly-review',
      status: 'succeeded',
      detail: { considered: pending.length, wrote },
    });
  }
  return { considered: pending.length, wrote };
}

const ASK_TOOLS = [
  { name: 'search_metrics', description: 'Daily metrics for this site', input_schema: { type: 'object', properties: { days: { type: 'number' } } } },
  { name: 'list_issues', description: 'Open issues for this site', input_schema: { type: 'object', properties: { category: { type: 'string' } } } },
  { name: 'list_tasks', description: 'Tasks for this company', input_schema: { type: 'object', properties: {} } },
  { name: 'page_detail', description: 'One URL metrics', input_schema: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'] } },
];

async function runTool(db, orgId, siteId, name, input) {
  if (name === 'search_metrics') {
    const { data } = await db.from('metric_daily').select('day, source, payload').eq('site_id', siteId).eq('organization_id', orgId).order('day', { ascending: false }).limit(input.days || 14);
    return data || [];
  }
  if (name === 'list_issues') {
    let q = db.from('issues').select('id, url, category, action, priority, status').eq('site_id', siteId).eq('organization_id', orgId).limit(30);
    if (input.category) q = q.eq('category', input.category);
    const { data } = await q;
    return data || [];
  }
  if (name === 'list_tasks') {
    const { data } = await db.from('tasks').select('id, title, status, priority, assignee').eq('organization_id', orgId).limit(30);
    return data || [];
  }
  if (name === 'page_detail') {
    const { data } = await db.from('search_pages').select('page, clicks, impressions, ctr, position').eq('site_id', siteId).eq('organization_id', orgId).ilike('page', '%' + input.page + '%').limit(5);
    return data || [];
  }
  return [];
}

export async function answerAsk(db, { organizationId, siteId, userId, message, threadId }) {
  let thread = threadId;
  if (!thread) {
    const { data, error } = await db.from('ask_threads').insert({ organization_id: organizationId, site_id: siteId, user_id: userId }).select('id').single();
    if (error) throw error;
    thread = data.id;
  } else {
    const { data } = await db.from('ask_threads').select('id, organization_id, site_id').eq('id', thread).maybeSingle();
    if (!data || data.organization_id !== organizationId || data.site_id !== siteId) {
      const err = new Error('forbidden');
      err.status = 403;
      throw err;
    }
  }
  await db.from('ask_messages').insert({ thread_id: thread, organization_id: organizationId, role: 'user', content: message });
  const messages = [{ role: 'user', content: message }];
  let answer = '';
  for (let i = 0; i < 4; i += 1) {
    const response = await claude(messages, ASK_TOOLS);
    const toolUses = (response.content || []).filter((b) => b.type === 'tool_use');
    answer = toolText(response.content);
    if (!toolUses.length) break;
    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const use of toolUses) {
      const out = await runTool(db, organizationId, siteId, use.name, use.input || {});
      results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out).slice(0, 12000) });
    }
    messages.push({ role: 'user', content: results });
  }
  if (!answer) answer = 'I do not have that data for this site yet.';
  await db.from('ask_messages').insert({ thread_id: thread, organization_id: organizationId, role: 'assistant', content: answer });
  return { threadId: thread, answer };
}
