#!/usr/bin/env node
// One-time import of the current JSON board into Supabase.
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment or server/.env
import { readFileSync, existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { supabaseAdmin, RYTSENSE_ORG, RYTSENSE_SITE } from '../server/src/db.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(root, 'server', '.env'));

const db = supabaseAdmin();
if (!db) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const org = RYTSENSE_ORG;
const site = RYTSENSE_SITE;

function load(name) {
  const path = join(root, 'data', name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const latest = load('latest.json');
if (latest) {
  const { error } = await db.from('site_snapshots').upsert({
    site_id: site,
    kind: 'overview',
    document: latest,
    updated_at: latest.updatedAt || new Date().toISOString(),
  });
  if (error) throw error;
  const period = latest.gsc && latest.gsc.period;
  const day = (period && period.endDate) || String(latest.updatedAt || '').slice(0, 10);
  if (day && latest.gsc && latest.gsc.current) {
    await db.from('metric_daily').upsert({
      organization_id: org,
      site_id: site,
      day,
      source: 'gsc',
      payload: { ...latest.gsc.current, period },
    }, { onConflict: 'site_id,day,source' });
  }
  if (day && latest.ga4 && latest.ga4.totals) {
    await db.from('metric_daily').upsert({
      organization_id: org,
      site_id: site,
      day,
      source: 'ga4',
      payload: latest.ga4.totals,
    }, { onConflict: 'site_id,day,source' });
  }
  const pages = (latest.gscByPage && latest.gscByPage.rows) || [];
  await db.from('search_pages').delete().eq('site_id', site);
  for (let i = 0; i < pages.length; i += 200) {
    const chunk = pages.slice(i, i + 200).map((row) => ({
      organization_id: org,
      site_id: site,
      period_start: period && period.startDate,
      period_end: period && period.endDate,
      page: row.page,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    }));
    if (chunk.length) {
      const { error: pageError } = await db.from('search_pages').insert(chunk);
      if (pageError) throw pageError;
    }
  }
  const queries = (latest.gscByQuery && latest.gscByQuery.rows) || [];
  await db.from('search_queries').delete().eq('site_id', site);
  for (let i = 0; i < queries.length; i += 200) {
    const chunk = queries.slice(i, i + 200).map((row) => ({
      organization_id: org,
      site_id: site,
      period_start: period && period.startDate,
      period_end: period && period.endDate,
      query: row.query,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    }));
    if (chunk.length) {
      const { error: queryError } = await db.from('search_queries').insert(chunk);
      if (queryError) throw queryError;
    }
  }
  console.log('overview snapshot, pages', pages.length, 'queries', queries.length);
}

const historyDir = join(root, 'data', 'history');
if (existsSync(historyDir)) {
  for (const file of readdirSync(historyDir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
    const doc = JSON.parse(readFileSync(join(historyDir, file), 'utf8'));
    const day = file.slice(0, 10);
    const { error } = await db.from('metric_daily').upsert({
      organization_id: org,
      site_id: site,
      day,
      source: 'history',
      payload: doc,
    }, { onConflict: 'site_id,day,source' });
    if (error) throw error;
  }
  console.log('history imported');
}

const issuesDoc = load('gsc-issues.json');
if (issuesDoc && Array.isArray(issuesDoc.issues)) {
  await db.from('issue_reviews').delete().eq('organization_id', org);
  for (let i = 0; i < issuesDoc.issues.length; i += 200) {
    const chunk = issuesDoc.issues.slice(i, i + 200).map((issue) => ({
      id: issue.id,
      organization_id: org,
      site_id: site,
      category: issue.category,
      category_label: issue.categoryLabel,
      url: issue.url,
      action: issue.action,
      note: issue.note,
      market: issue.market,
      priority: issue.priority,
      status: issue.status || 'open',
      source: issue.source,
    }));
    const { error } = await db.from('issues').upsert(chunk);
    if (error) throw error;
    const reviews = issuesDoc.issues.slice(i, i + 200).filter((issue) => issue.agentReview).map((issue) => ({
      issue_id: issue.id,
      organization_id: org,
      why: issue.agentReview.why,
      fix: issue.agentReview.fix,
      owner_team: issue.agentReview.ownerTeam,
      effort: issue.agentReview.effort,
      observed_status: issue.agentReview.observedStatus == null ? null : String(issue.agentReview.observedStatus),
      agents: issue.agentReview.agents || [],
      reviewed_at: issue.agentReview.reviewedAt || new Date().toISOString(),
    }));
    if (reviews.length) {
      const { error: reviewError } = await db.from('issue_reviews').insert(reviews);
      if (reviewError) throw reviewError;
    }
  }
  console.log('issues', issuesDoc.issues.length);
}

const taskDoc = load('tasks.json');
if (taskDoc && Array.isArray(taskDoc.tasks)) {
  const rows = taskDoc.tasks.map((task) => ({
    id: task.id,
    organization_id: org,
    site_id: site,
    title: task.title,
    details: task.details || task.rationale || '',
    status: task.status || 'todo',
    priority: task.priority,
    assignee: task.assignee,
    team: task.team,
    due_date: task.dueDate || null,
    source: task.source || 'seed',
    created_at: task.createdAt || new Date().toISOString(),
  }));
  const { error } = await db.from('tasks').upsert(rows);
  if (error) throw error;
  console.log('tasks', rows.length);
}

for (const [file, kind] of [
  ['internal-links.json', 'internal-links'],
  ['content-ideas.json', 'content-ideas'],
  ['topic-trends.json', 'topic-trends'],
]) {
  const doc = load(file);
  if (!doc) continue;
  const { error } = await db.from('recommendations').upsert({
    id: kind + '-rytsense',
    organization_id: org,
    site_id: site,
    kind,
    document: doc,
  });
  if (error) throw error;
}

console.log('import complete for Rytsense');
