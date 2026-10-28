import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { google } from 'googleapis';
import { supabaseAdmin, RYTSENSE_ORG, RYTSENSE_SITE } from './db.js';
import {
  canAdminOrg,
  canAsk,
  canReadOrg,
  canWriteTask,
} from './scope.js';
import { answerAsk, runDailySync, runWeeklyReview } from './jobs.js';
import { runPSISync } from './jobs/sync-psi.js';
import { createPSITasks } from './jobs/create-psi-tasks.js';
import { createPsiRouter } from './routes/psi.js';

const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function corsOrigin(req) {
  const origin = (req && req.get && req.get('origin')) || '';
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return origin;
  if (/^https:\/\/([a-z0-9-]+\.)?rytsensetech-growth-board\.pages\.dev$/i.test(origin)) return origin;
  const allowed = (process.env.PUBLIC_APP_URL || '*').replace(/\/$/, '');
  if (origin && (allowed === '*' || origin === allowed)) return origin || allowed;
  return allowed;
}

function json(res, data, status = 200) {
  res.set('access-control-allow-origin', corsOrigin(res.req));
  res.set('vary', 'Origin');
  res.set('access-control-allow-headers', 'authorization, content-type, x-cron-secret, x-support-org');
  res.set('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
  return res.status(status).json(data);
}

async function actorFrom(req, db) {
  const header = req.get('authorization') || '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;
  const userId = data.user.id;
  const { data: admin } = await db.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle();
  const { data: memberships } = await db.from('members').select('organization_id, role, organizations(status)').eq('user_id', userId);
  return {
    userId,
    email: data.user.email,
    isPlatformAdmin: Boolean(admin),
    supportOrgId: req.get('x-support-org') || null,
    memberships: memberships || [],
  };
}

function orgStatus(membership) {
  return membership && membership.organizations && membership.organizations.status;
}

function requireActor(actor, res) {
  if (!actor) {
    json(res, { error: 'login required' }, 401);
    return false;
  }
  return true;
}

function siteAccess(actor, site) {
  if (!site) return { error: 'not found', status: 404 };
  if (site.organizations && site.organizations.status === 'suspended' && !(actor.isPlatformAdmin && actor.supportOrgId === site.organization_id)) {
    return { error: 'company suspended', status: 403 };
  }
  if (!canReadOrg(actor, site.organization_id)) return { error: 'forbidden', status: 403 };
  const membership = (actor.memberships || []).find((m) => m.organization_id === site.organization_id);
  return { membership, role: membership ? membership.role : actor.isPlatformAdmin ? 'admin' : null };
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return json(res, {});
    next();
  });

  app.get('/api/health', (_req, res) => {
    json(res, { ok: true, database: Boolean(supabaseAdmin()) });
  });

  app.use('/api', (req, res, next) => {
    const path = req.path || '';
    if (path.includes('/jobs/') || path.includes('/oauth/google/callback') || path.endsWith('/health')) return next();
    const db = supabaseAdmin();
    if (!db) return json(res, { error: 'database not configured' }, 503);
    req.db = db;
    next();
  });

  app.get('/api/me', async (req, res) => {
    const actor = await actorFrom(req, req.db);
    if (!requireActor(actor, res)) return;
    json(res, { user: { id: actor.userId, email: actor.email }, isPlatformAdmin: actor.isPlatformAdmin, memberships: actor.memberships });
  });

  app.get('/api/admin/companies', async (req, res) => {
    const actor = await actorFrom(req, req.db);
    if (!requireActor(actor, res)) return;
    if (!actor.isPlatformAdmin) return json(res, { error: 'forbidden' }, 403);
    const { data, error } = await req.db.from('organizations').select('id, name, slug, status, created_at').order('created_at');
    if (error) return json(res, { error: error.message }, 500);
    await req.db.from('audit_log').insert({ actor_id: actor.userId, action: 'list_companies', detail: {} });
    json(res, { companies: data });
  });

  app.post('/api/admin/companies', async (req, res) => {
    const actor = await actorFrom(req, req.db);
    if (!requireActor(actor, res)) return;
    if (!actor.isPlatformAdmin) return json(res, { error: 'forbidden' }, 403);
    const name = String(req.body.name || '').trim();
    const domain = String(req.body.domain || '').trim().toLowerCase();
    const email = String(req.body.adminEmail || '').trim();
    if (!name || !domain || !email) return json(res, { error: 'name, domain, adminEmail required' }, 400);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';
    const { data: org, error } = await req.db.from('organizations').insert({ name, slug, status: 'active' }).select('id').single();
    if (error) return json(res, { error: error.message }, 400);
    const { data: site, error: siteError } = await req.db.from('sites').insert({ organization_id: org.id, domain, name }).select('id').single();
    if (siteError) return json(res, { error: siteError.message }, 400);
    const invited = await req.db.auth.admin.inviteUserByEmail(email);
    if (invited.error) return json(res, { error: invited.error.message, organizationId: org.id, siteId: site.id }, 400);
    await req.db.from('members').insert({ organization_id: org.id, user_id: invited.data.user.id, role: 'admin' });
    await req.db.from('audit_log').insert({ actor_id: actor.userId, organization_id: org.id, action: 'create_company', detail: { domain, email } });
    json(res, { organizationId: org.id, siteId: site.id });
  });

  app.post('/api/admin/companies/:id/suspend', async (req, res) => {
    const actor = await actorFrom(req, req.db);
    if (!requireActor(actor, res)) return;
    if (!actor.isPlatformAdmin) return json(res, { error: 'forbidden' }, 403);
    const status = req.body.status === 'active' ? 'active' : 'suspended';
    const { error } = await req.db.from('organizations').update({ status }).eq('id', req.params.id);
    if (error) return json(res, { error: error.message }, 400);
    await req.db.from('audit_log').insert({ actor_id: actor.userId, organization_id: req.params.id, action: 'set_status', detail: { status } });
    json(res, { ok: true, status });
  });

  app.get('/api/sites/current/overview', async (req, res) => {
    const actor = await actorFrom(req, req.db);
    if (!requireActor(actor, res)) return;
    const site = await resolveSite(req, actor);
    if (site.error) return json(res, { error: site.error }, site.status);
    const { data: snap } = await req.db.from('site_snapshots').select('document, updated_at').eq('site_id', site.row.id).eq('kind', 'overview').maybeSingle();
    if (snap && snap.document) return json(res, { ...snap.document, organizationId: site.row.organization_id, siteId: site.row.id });
    const { data: days } = await req.db.from('metric_daily').select('day, source, payload').eq('site_id', site.row.id).order('day', { ascending: false }).limit(40);
    json(res, assembleOverview(site.row, days || []));
  });

  app.get('/api/sites/current/issues', async (req, res) => {
    const actor = await actorFrom(req, req.db);
    if (!requireActor(actor, res)) return;
    const site = await resolveSite(req, actor);
    if (site.error) return json(res, { error: site.error }, site.status);
    const { data: issues } = await req.db.from('issues').select('*').eq('site_id', site.row.id).limit(1000);
    const ids = (issues || []).map((i) => i.id);
    const { data: reviews } = ids.length
      ? await req.db.from('issue_reviews').select('*').in('issue_id', ids)
      : { data: [] };
    const byIssue = new Map();
    for (const review of reviews || []) byIssue.set(review.issue_id, review);
    const shaped = (issues || []).map((i) => ({
      id: i.id,
      category: i.category,
      categoryLabel: i.category_label,
      url: i.url,
      action: i.action,
      note: i.note,
      market: i.market,
      priority: i.priority,
      status: i.status,
      agentReview: byIssue.get(i.id)
        ? {
            why: byIssue.get(i.id).why,
            fix: byIssue.get(i.id).fix,
            ownerTeam: byIssue.get(i.id).owner_team,
            effort: byIssue.get(i.id).effort,
            observedStatus: byIssue.get(i.id).observed_status,
          }
        : null,
    }));
    json(res, {
      issues: shaped,
      totals: { all: shaped.length, open: shaped.filter((i) => i.status !== 'fixed').length },
    });
  });

  app.get('/api/sites/current/tasks', async (req, res) => taskList(req, res));
  app.get('/api/tasks', async (req, res) => taskList(req, res));

  app.post('/api/tasks', async (req, res) => {
    const actor = await actorFrom(req, req.db);
    if (!requireActor(actor, res)) return;
    const site = await resolveSite(req, actor);
    if (site.error) return json(res, { error: site.error }, site.status);
    if (!canWriteTask(site.role)) return json(res, { error: 'forbidden' }, 403);
    const id = req.body.id || `T-${Date.now().toString(36)}`;
    const task = {
      id,
      organization_id: site.row.organization_id,
      site_id: site.row.id,
      issue_id: req.body.issueId || null,
      title: String(req.body.title || '').slice(0, 200),
      details: req.body.details || '',
      status: 'todo',
      priority: req.body.priority || 'medium',
      assignee: null,
      team: req.body.team || 'SEO',
      source: 'human',
    };
    if (!task.title) return json(res, { error: 'title required' }, 400);
    const { error } = await req.db.from('tasks').insert(task);
    if (error) return json(res, { error: error.message }, 400);
    await req.db.from('task_events').insert({
      task_id: id,
      organization_id: site.row.organization_id,
      actor: actor.email,
      from_status: null,
      to_status: 'todo',
      note: 'created',
    });
    json(res, { ok: true, task });
  });

  app.post('/api/tasks/:id', async (req, res) => {
    const actor = await actorFrom(req, req.db);
    if (!requireActor(actor, res)) return;
    const { data: task } = await req.db.from('tasks').select('*').eq('id', req.params.id).maybeSingle();
    if (!task) return json(res, { error: 'not found' }, 404);
    if (!canReadOrg(actor, task.organization_id)) return json(res, { error: 'forbidden' }, 403);
    const membership = (actor.memberships || []).find((m) => m.organization_id === task.organization_id);
    if (!canWriteTask(membership && membership.role)) return json(res, { error: 'forbidden' }, 403);
    const next = req.body.status || task.status;
    await req.db.from('tasks').update({
      status: next,
      assignee: req.body.assignee === undefined ? task.assignee : req.body.assignee,
      completed_at: next === 'done' ? new Date().toISOString() : null,
    }).eq('id', task.id);
    await req.db.from('task_events').insert({
      task_id: task.id,
      organization_id: task.organization_id,
      actor: actor.email,
      from_status: task.status,
      to_status: next,
      note: req.body.note || null,
    });
    json(res, { ok: true });
  });

  app.get('/api/sites/current/sync', async (req, res) => {
    const actor = await actorFrom(req, req.db);
    if (!requireActor(actor, res)) return;
    const site = await resolveSite(req, actor);
    if (site.error) return json(res, { error: site.error }, site.status);
    const { data } = await req.db.from('connections').select('provider, status, last_sync_at, last_error').eq('site_id', site.row.id);
    json(res, { connections: data || [] });
  });

  app.get('/api/sites/current/export/issues.csv', async (req, res) => {
    const actor = await actorFrom(req, req.db);
    if (!requireActor(actor, res)) return;
    const site = await resolveSite(req, actor);
    if (site.error) return json(res, { error: site.error }, site.status);
    const { data } = await req.db.from('issues').select('id, url, category, priority, status, action').eq('site_id', site.row.id);
    const lines = ['id,url,category,priority,status,action'].concat(
      (data || []).map((i) => [i.id, i.url, i.category, i.priority, i.status, i.action].map(csv).join(','))
    );
    res.set('content-type', 'text/csv');
    res.send(lines.join('\n'));
  });

  app.post('/api/ask', async (req, res) => {
    const actor = await actorFrom(req, req.db);
    if (!requireActor(actor, res)) return;
    const site = await resolveSite(req, actor);
    if (site.error) return json(res, { error: site.error }, site.status);
    if (!canAsk(site.role)) return json(res, { error: 'forbidden' }, 403);
    const message = String(req.body.message || '').trim();
    if (!message) return json(res, { error: 'message required' }, 400);
    try {
      const out = await answerAsk(req.db, {
        organizationId: site.row.organization_id,
        siteId: site.row.id,
        userId: actor.userId,
        message,
        threadId: req.body.threadId || null,
      });
      json(res, out);
    } catch (err) {
      json(res, { error: err.message }, err.status || 500);
    }
  });

  app.get('/api/oauth/google/start', async (req, res) => {
    const actor = await actorFrom(req, req.db);
    if (!requireActor(actor, res)) return;
    const site = await resolveSite(req, actor);
    if (site.error) return json(res, { error: site.error }, site.status);
    if (!canAdminOrg(site.role)) return json(res, { error: 'forbidden' }, 403);
    const client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/webmasters.readonly',
        'https://www.googleapis.com/auth/analytics.readonly',
      ],
      state: JSON.stringify({ siteId: site.row.id, userId: actor.userId }),
    });
    res.redirect(url);
  });

  app.get('/api/oauth/google/callback', async (req, res) => {
    const db = supabaseAdmin();
    if (!db) return json(res, { error: 'database not configured' }, 503);
    const client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
    const { tokens } = await client.getToken(req.query.code);
    if (!tokens.refresh_token) return json(res, { error: 'no refresh token' }, 400);
    const state = JSON.parse(req.query.state || '{}');
    const { data: secretId, error } = await db.rpc('store_connection_secret', {
      p_name: 'gsc-' + state.siteId,
      p_secret: tokens.refresh_token,
    });
    if (error) return json(res, { error: error.message }, 500);
    const { data: site } = await db.from('sites').select('id, organization_id').eq('id', state.siteId).single();
    for (const provider of ['gsc', 'ga4']) {
      await db.from('connections').upsert({
        organization_id: site.organization_id,
        site_id: site.id,
        provider,
        status: 'connected',
        vault_secret_id: secretId,
        last_error: null,
      }, { onConflict: 'site_id,provider' });
    }
    res.redirect((process.env.PUBLIC_APP_URL || '/') + '?connected=1');
  });

  // Page Speed Insights: read endpoints (/api/psi/scores, /api/psi/issues)
  app.use('/api', createPsiRouter({
    send: json,
    authorize: async (req, res) => {
      const actor = await actorFrom(req, req.db);
      if (!requireActor(actor, res)) return null;
      const siteId = req.query.site_id || req.query.siteId || null;
      const site = await resolveSite({ db: req.db, query: { siteId }, body: {} }, actor);
      if (site.error) {
        json(res, { error: site.error }, site.status);
        return null;
      }
      return site.row;
    },
  }));

  // PSI cron jobs. Monday weekly: POST /api/jobs/psi-weekly (scan then create Dev tasks).
  // Body (optional): { "siteId": "<uuid>" } to limit to one site; default is every active site.
  function psiJob(run) {
    return async (req, res) => {
      if (!cronOk(req)) return json(res, { error: 'forbidden' }, 403);
      const db = supabaseAdmin();
      if (!db) return json(res, { error: 'database not configured' }, 503);
      req.setTimeout(0);
      res.setTimeout(0);
      try {
        json(res, { ok: true, result: await run(db, { siteId: (req.body && req.body.siteId) || null }) });
      } catch (err) {
        console.error('PSI job error:', err);
        json(res, { error: err.message }, 500);
      }
    };
  }
  app.post('/api/jobs/psi-sync', psiJob((db, opts) => runPSISync(db, opts)));
  app.post('/api/jobs/psi-tasks', psiJob((db, opts) => createPSITasks(db, opts)));
  app.post('/api/jobs/psi-weekly', psiJob(async (db, opts) => {
    const sync = await runPSISync(db, opts);
    const tasks = await createPSITasks(db, opts);
    return { sync, tasks };
  }));

  app.post('/api/jobs/sync', async (req, res) => {
    if (!cronOk(req)) return json(res, { error: 'forbidden' }, 403);
    const db = supabaseAdmin();
    if (!db) return json(res, { error: 'database not configured' }, 503);
    try {
      json(res, await runDailySync(db));
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  app.post('/api/jobs/review', async (req, res) => {
    if (!cronOk(req)) return json(res, { error: 'forbidden' }, 403);
    const db = supabaseAdmin();
    if (!db) return json(res, { error: 'database not configured' }, 503);
    try {
      json(res, await runWeeklyReview(db, (req.body && req.body.siteId) || null));
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  async function taskList(req, res) {
    const actor = await actorFrom(req, req.db);
    if (!requireActor(actor, res)) return;
    const site = await resolveSite(req, actor);
    if (site.error) return json(res, { error: site.error }, site.status);
    const { data } = await req.db.from('tasks').select('*').eq('organization_id', site.row.organization_id);
    const tasks = (data || []).map(toTask);
    const open = tasks.filter((t) => t.status !== 'done');
    json(res, {
      tasks,
      summary: {
        open: open.length,
        openCritical: open.filter((t) => t.priority === 'critical').length,
        overdue: open.filter((t) => t.dueDate && new Date(t.dueDate) < new Date()).length,
      },
    });
  }

  async function resolveSite(req, actor) {
    const requested = req.query.siteId || (req.body && req.body.siteId) || null;
    let query = req.db.from('sites').select('id, organization_id, domain, name, organizations(status)');
    if (requested) query = query.eq('id', requested);
    else if (actor.supportOrgId && actor.isPlatformAdmin) query = query.eq('organization_id', actor.supportOrgId);
    else if (actor.memberships[0]) query = query.eq('organization_id', actor.memberships[0].organization_id);
    else if (!actor.isPlatformAdmin) return { error: 'no company', status: 403 };
    else query = query.eq('id', RYTSENSE_SITE);
    const { data, error } = await query.limit(1).maybeSingle();
    if (error) return { error: error.message, status: 500 };
    if (!data) return { error: 'not found', status: 404 };
    const access = siteAccess(actor, data);
    if (access.error) return access;
    if (orgStatus(actor.memberships.find((m) => m.organization_id === data.organization_id)) === 'suspended' && actor.supportOrgId !== data.organization_id) {
      return { error: 'company suspended', status: 403 };
    }
    return { row: data, role: access.role };
  }

  return app;
}

function cronOk(req) {
  const secret = process.env.CRON_SECRET;
  return secret && req.get('x-cron-secret') === secret;
}

function csv(value) {
  return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
}

function toTask(row) {
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee,
    team: row.team,
    dueDate: row.due_date,
    source: row.source,
  };
}

function assembleOverview(site, days) {
  const gsc = days.find((d) => d.source === 'gsc');
  const ga4 = days.filter((d) => d.source === 'ga4');
  return {
    site: site.domain,
    organizationId: site.organization_id || RYTSENSE_ORG,
    siteId: site.id,
    updatedAt: (gsc && gsc.day) || new Date().toISOString(),
    gsc: gsc ? { current: gsc.payload, period: gsc.payload.period || null } : null,
    ga4: {
      totals: ga4[0] ? ga4[0].payload : null,
      daily: ga4.map((d) => ({ date: d.day, sessions: d.payload.sessions })),
    },
  };
}

const port = Number(process.env.PORT || 8787);
const startedDirectly = /index\.js$/i.test(process.argv[1] || '');
if (startedDirectly) {
  createApp()
    .listen(port, '0.0.0.0', () => {
      console.log('Growth Board API on ' + port);
    })
    .on('error', (err) => {
      console.error('API listen failed:', err.message);
      process.exit(1);
    });
}
