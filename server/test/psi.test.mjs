import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractMetrics, extractIssues, pickPages, runPSISync, urlsFromSitemapXml } from '../src/jobs/sync-psi.js';
import { groupIssues, taskFor, createPSITasks, urlTemplate } from '../src/jobs/create-psi-tasks.js';
import { summarize, latestPerPage, trend } from '../src/routes/psi.js';

// ---- schema columns, read from the real migrations ----
function columns(file, table) {
  const sql = readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8');
  const m = sql.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`, 'i'));
  assert.ok(m, `table ${table} in ${file}`);
  return new Set(m[1].split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((w) => /^[a-z_]+$/.test(w) && !['unique', 'primary', 'check'].includes(w)));
}
const SCHEMA = {
  tasks: columns('0001_product.sql', 'tasks'),
  task_events: columns('0001_product.sql', 'task_events'),
  psi_scores: columns('0002_psi.sql', 'psi_scores'),
  psi_issues: columns('0002_psi.sql', 'psi_issues'),
};
function assertColumns(table, row) {
  for (const k of Object.keys(row)) assert.ok(SCHEMA[table].has(k), `${table}.${k} does not exist`);
}

// ---- Lighthouse fixture ----
function lighthouse(perfScore, { renderBlocking = 0, unusedJs = 0.4 } = {}) {
  return {
    lighthouseResult: {
      categories: {
        performance: {
          score: perfScore,
          auditRefs: [
            { id: 'largest-contentful-paint', group: 'metrics' },
            { id: 'render-blocking-resources' },
            { id: 'unused-javascript' },
            { id: 'uses-http2' },
            { id: 'server-response-time' },
            { id: 'screenshot-thumbnails', group: 'hidden' },
          ],
        },
      },
      audits: {
        'largest-contentful-paint': { score: 0.1, numericValue: 4210, scoreDisplayMode: 'numeric', title: 'LCP' },
        'first-contentful-paint': { numericValue: 1800 },
        'cumulative-layout-shift': { numericValue: 0.123456 },
        'server-response-time': { score: 1, numericValue: 320, scoreDisplayMode: 'metricSavings', title: 'Server response' },
        'render-blocking-resources': { score: renderBlocking, scoreDisplayMode: 'metricSavings', title: 'Eliminate render-blocking resources', description: 'See [docs](https://x)', displayValue: 'Potential savings of 1,200 ms', details: { type: 'opportunity' } },
        'unused-javascript': { score: unusedJs, scoreDisplayMode: 'metricSavings', title: 'Reduce unused JavaScript', details: { type: 'opportunity' } },
        'uses-http2': { score: null, scoreDisplayMode: 'notApplicable', title: 'HTTP/2' },
        'screenshot-thumbnails': { score: null, scoreDisplayMode: 'informative' },
      },
    },
  };
}

test('extractMetrics reads the performance category score and converts ms to s', () => {
  assert.deepEqual(extractMetrics(lighthouse(0.42)), { score: 42, lcp: 4.21, fcp: 1.8, cls: 0.1235, ttfb: 0.32 });
  assert.deepEqual(extractMetrics({}), { score: null, lcp: null, fcp: null, cls: null, ttfb: null });
});

test('extractIssues keeps failing performance audits only, skipping metrics/hidden/N/A/passing', () => {
  const issues = extractIssues(lighthouse(0.42), 'mobile');
  assert.deepEqual(issues.map((i) => [i.audit_id, i.severity, i.impact_score]), [
    ['render-blocking-resources', 'critical', 100],
    ['unused-javascript', 'high', 60],
  ]);
  assert.equal(issues[0].issue_type, 'opportunity');
  assert.equal(issues[0].strategy, 'mobile');
  for (const i of issues) assertColumns('psi_issues', i);
});

test('pickPages keeps own-host URLs from GSC, dedupes, falls back to homepage', () => {
  const rows = [
    { page: 'https://rytsensetech.com/' },
    { page: 'https://www.rytsensetech.com/us/#hero' },
    { page: 'https://www.rytsensetech.com/us/' },
    { page: 'https://other.com/x' },
    { page: 'not a url' },
  ];
  assert.deepEqual(pickPages(rows, 'rytsensetech.com'), ['https://rytsensetech.com/', 'https://www.rytsensetech.com/us/']);
  assert.deepEqual(pickPages([], 'rytsensetech.com'), ['https://rytsensetech.com/']);
});

test('urlsFromSitemapXml reads loc entries', () => {
  const xml = `<?xml version="1.0"?>
  <urlset><url><loc>https://rytsensetech.com/us/</loc></url>
  <url><loc>https://rytsensetech.com/contact/</loc></url></urlset>`;
  assert.deepEqual(urlsFromSitemapXml(xml), [
    'https://rytsensetech.com/us/',
    'https://rytsensetech.com/contact/',
  ]);
});

test('pickPages turns GSC paths into site URLs and drops utm params', () => {
  const rows = [
    { page: '/?utm_source=google-listing' },
    { page: '/us/blog/carc-codes-medical-billing/' },
    { page: '/' },
  ];
  assert.deepEqual(pickPages(rows, 'rytsensetech.com'), [
    'https://rytsensetech.com/',
    'https://rytsensetech.com/us/blog/carc-codes-medical-billing/',
  ]);
});

test('summary uses the latest row per page and ignores issues whose task is done', () => {
  const rows = [
    { page_url: 'a', metric_date: '2026-10-28', mobile_score: 40, desktop_score: 80, psi_issues: [{ severity: 'critical' }, { severity: 'high', tasks: { status: 'done' } }] },
    { page_url: 'b', metric_date: '2026-10-28', mobile_score: 60, desktop_score: null, psi_issues: [{ severity: 'high' }] },
    { page_url: 'a', metric_date: '2026-10-27', mobile_score: 10, desktop_score: 10, psi_issues: [{ severity: 'critical' }, { severity: 'critical' }] },
  ];
  assert.equal(latestPerPage(rows).length, 2);
  assert.deepEqual(summarize(rows), { avg_mobile_score: 50, avg_desktop_score: 80, critical_issues: 1, high_issues: 1, pages_scanned: 2, last_scan: '2026-10-28' });
  assert.deepEqual(trend(rows).map((t) => t.date), ['2026-10-27', '2026-10-28']);
});

test('urlTemplate collapses blog and service slugs, keeps unique pages', () => {
  assert.equal(urlTemplate('https://rytsensetech.com/'), '/');
  assert.equal(urlTemplate('https://rytsensetech.com/us/'), '/us');
  assert.equal(urlTemplate('https://rytsensetech.com/us/blog/carc-codes-medical-billing/'), '/us/blog/:slug');
  assert.equal(urlTemplate('https://rytsensetech.com/services/ai-development/'), '/services/:slug');
  assert.equal(urlTemplate('https://rytsensetech.com/freight-broker-roi-calculator/'), '/freight-broker-roi-calculator');
});

test('mobile + desktop findings for one audit become one task', () => {
  const page = { page_url: 'https://rytsensetech.com/us/' };
  const groups = groupIssues([
    { id: 1, audit_id: 'unused-javascript', strategy: 'mobile', severity: 'high', impact_score: 60, title: 'Reduce unused JavaScript', psi_scores: page },
    { id: 2, audit_id: 'unused-javascript', strategy: 'desktop', severity: 'critical', impact_score: 90, title: 'Reduce unused JavaScript', psi_scores: page },
    { id: 3, audit_id: 'render-blocking-resources', strategy: 'mobile', severity: 'high', impact_score: 55, title: 'Eliminate render-blocking resources', psi_scores: page },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].auditId, 'unused-javascript'); // critical sorts first
  const t = taskFor(groups[0], { domain: 'rytsensetech.com' });
  assert.equal(t.title, '[PSI] /us: Reduce unused JavaScript');
  assert.equal(t.priority, 'critical');
  assert.match(t.details, /desktop: critical/);
  assert.match(t.details, /mobile: high/);
});

test('same audit on two blog posts is one cluster, not two tasks', () => {
  const groups = groupIssues([
    { id: 1, audit_id: 'unused-javascript', strategy: 'mobile', severity: 'critical', impact_score: 90, title: 'Reduce unused JavaScript', psi_scores: { page_url: 'https://rytsensetech.com/us/blog/aaa/' } },
    { id: 2, audit_id: 'unused-javascript', strategy: 'mobile', severity: 'high', impact_score: 50, title: 'Reduce unused JavaScript', psi_scores: { page_url: 'https://rytsensetech.com/us/blog/bbb/' } },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].template, '/us/blog/:slug');
  assert.equal(groups[0].urlCount, 2);
  const t = taskFor(groups[0], { domain: 'rytsensetech.com' });
  assert.equal(t.title, '[PSI] /us/blog/:slug: Reduce unused JavaScript');
  assert.match(t.details, /2 URL/);
});

// ---- minimal fake Supabase client: records writes, answers reads from a resolver ----
function fakeDb(resolve) {
  const writes = [];
  const db = {
    writes,
    from(table) {
      const q = { table, op: 'select', filters: [], payload: null };
      const run = () => {
        if (q.op !== 'select') writes.push({ table, op: q.op, payload: q.payload, filters: q.filters });
        return Promise.resolve(resolve(q) || { data: null, error: null });
      };
      const b = {
        select() { if (q.op === 'select') q.op = 'select'; return b; },
        insert(p) { q.op = 'insert'; q.payload = p; return b; },
        upsert(p, o) { q.op = 'upsert'; q.payload = p; q.opts = o; return b; },
        update(p) { q.op = 'update'; q.payload = p; return b; },
        then(ok, bad) { return run().then(ok, bad); },
        single() { return run(); },
        maybeSingle() { return run(); },
      };
      for (const m of ['eq', 'neq', 'in', 'is', 'not', 'gte', 'order', 'limit', 'or', 'range']) b[m] = (...a) => { q.filters.push([m, ...a]); return b; };
      return b;
    },
  };
  return db;
}
const SITE = { id: 'site-1', organization_id: 'org-1', domain: 'rytsensetech.com' };

test('runPSISync writes schema-valid rows for every page', async () => {
  const db = fakeDb((q) => {
    if (q.table === 'sites') return { data: [SITE], error: null };
    if (q.table === 'search_pages') return { data: [{ page: 'https://rytsensetech.com/' }, { page: 'https://rytsensetech.com/us/' }], error: null };
    if (q.table === 'psi_scores' && q.op === 'upsert') return { data: { id: 'score-' + q.payload.page_url }, error: null };
    return { data: null, error: null };
  });
  const calls = [];
  const fetchImpl = async (url) => {
    if (!url.includes('pagespeedonline')) return { ok: false, text: async () => '' };
    calls.push(url);
    assert.match(url, /^https:\/\/www\.googleapis\.com\/pagespeedonline\/v5\/runPagespeed\?/);
    return { ok: true, json: async () => lighthouse(url.includes('strategy=mobile') ? 0.42 : 0.91) };
  };
  const out = await runPSISync(db, { fetchImpl });
  assert.equal(calls.length, 4);
  assert.deepEqual([out.syncedPages, out.syncedIssues, out.errors], [2, 8, 0]);
  const scores = db.writes.filter((w) => w.table === 'psi_scores');
  assert.equal(scores[0].payload.mobile_score, 42);
  assert.equal(scores[0].payload.desktop_score, 91);
  for (const w of scores) assertColumns('psi_scores', w.payload);
  for (const w of db.writes.filter((w) => w.table === 'psi_issues')) for (const row of w.payload) assertColumns('psi_issues', row);
});

test('runPSISync offset/limit scans a slice and reports done', async () => {
  const pages = [
    { page: 'https://rytsensetech.com/' },
    { page: 'https://rytsensetech.com/us/' },
    { page: 'https://rytsensetech.com/contact/' },
  ];
  const db = fakeDb((q) => {
    if (q.table === 'sites') return { data: [SITE], error: null };
    if (q.table === 'search_pages') return { data: pages, error: null };
    if (q.table === 'psi_scores' && q.op === 'upsert') return { data: { id: 'score' }, error: null };
    return { data: null, error: null };
  });
  const fetchImpl = async (url) => {
    if (!url.includes('pagespeedonline')) return { ok: false, text: async () => '' };
    return { ok: true, json: async () => lighthouse(0.9) };
  };
  const first = await runPSISync(db, { fetchImpl, offset: 0, limit: 1 });
  assert.equal(first.syncedPages, 1);
  assert.equal(first.totalPages, 3);
  assert.equal(first.done, false);
  assert.equal(first.nextOffset, 1);
  const rest = await runPSISync(db, { fetchImpl, offset: 1, limit: 2 });
  assert.equal(rest.syncedPages, 2);
  assert.equal(rest.done, true);
  assert.equal(rest.nextOffset, 3);
});

test('runPSISync counts a failing page as an error and keeps going', async () => {
  const db = fakeDb((q) => {
    if (q.table === 'sites') return { data: [SITE], error: null };
    if (q.table === 'search_pages') return { data: [{ page: 'https://rytsensetech.com/' }, { page: 'https://rytsensetech.com/bad' }], error: null };
    if (q.op === 'upsert' && q.table === 'psi_scores') return { data: { id: 's' }, error: null };
    return { data: null, error: null };
  });
  const fetchImpl = async (url) => {
    if (!url.includes('pagespeedonline')) return { ok: false, text: async () => '' };
    return url.includes('%2Fbad')
      ? { ok: false, status: 400, json: async () => ({ error: { message: 'Lighthouse returned error' } }) }
      : { ok: true, json: async () => lighthouse(0.9) };
  };
  const out = await runPSISync(db, { fetchImpl });
  assert.equal(out.syncedPages, 1);
  assert.equal(out.errors, 1);
  assert.match(out.sites[0].failures[0].error, /400: Lighthouse returned error/);
});

test('createPSITasks inserts a schema-valid Development task, links issues, posts to Slack', async () => {
  process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/x';
  const page = { page_url: 'https://rytsensetech.com/us/', metric_date: '2026-10-28' };
  const db = fakeDb((q) => {
    if (q.table === 'sites') return { data: [SITE], error: null };
    if (q.table === 'psi_scores') return { data: { metric_date: '2026-10-28' }, error: null };
    if (q.table === 'psi_issues' && q.op === 'select') return { data: [
      { id: 'i1', audit_id: 'unused-javascript', strategy: 'mobile', severity: 'critical', impact_score: 90, title: 'Reduce unused JavaScript', psi_scores: page },
      { id: 'i2', audit_id: 'unused-javascript', strategy: 'desktop', severity: 'high', impact_score: 60, title: 'Reduce unused JavaScript', psi_scores: page },
    ], error: null };
    if (q.table === 'tasks' && q.op === 'select') return { data: null, error: null };
    return { data: null, error: null };
  });
  const slack = [];
  const out = await createPSITasks(db, { fetchImpl: async (url, init) => { slack.push(JSON.parse(init.body)); return { ok: true }; } });
  delete process.env.SLACK_WEBHOOK_URL;

  assert.equal(out.tasksCreated, 1);
  const task = db.writes.find((w) => w.table === 'tasks' && w.op === 'insert').payload;
  assertColumns('tasks', task);
  assert.match(task.id, /^T-/);
  assert.equal(task.status, 'todo');            // tasks.status check constraint
  assert.equal(task.team, 'Development');
  assert.equal(task.priority, 'critical');
  assertColumns('task_events', db.writes.find((w) => w.table === 'task_events').payload);
  const link = db.writes.find((w) => w.table === 'psi_issues' && w.op === 'update');
  assert.equal(link.payload.task_id, task.id);
  assert.deepEqual(link.filters.find((f) => f[0] === 'in'), ['in', 'id', ['i1', 'i2']]);
  assert.equal(slack.length, 1);
  assert.match(slack[0].text, /1 new PageSpeed task for rytsensetech.com/);
});

test('createPSITasks links to an existing open task instead of duplicating', async () => {
  const page = { page_url: 'https://rytsensetech.com/', metric_date: '2026-10-28' };
  const db = fakeDb((q) => {
    if (q.table === 'sites') return { data: [SITE], error: null };
    if (q.table === 'psi_scores') return { data: { metric_date: '2026-10-28' }, error: null };
    if (q.table === 'psi_issues' && q.op === 'select') return { data: [{ id: 'i1', audit_id: 'a', strategy: 'mobile', severity: 'high', impact_score: 50, title: 'T', psi_scores: page }], error: null };
    if (q.table === 'tasks' && q.op === 'select') return { data: { id: 'T-existing' }, error: null };
    return { data: null, error: null };
  });
  const out = await createPSITasks(db, { fetchImpl: async () => ({ ok: true }) });
  assert.deepEqual([out.tasksCreated, out.linkedExisting], [0, 1]);
  assert.ok(!db.writes.some((w) => w.table === 'tasks'));
  assert.equal(db.writes.find((w) => w.table === 'psi_issues').payload.task_id, 'T-existing');
});
