// Live probes for one Addressed claim. Never invent metrics — only what tools return.
import { google } from 'googleapis';
import { refreshOnePsiPage } from './sync-psi.js';

export async function liveHttp(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15000) });
    return {
      status: String(head.status),
      finalUrl: head.url || url,
      ok: head.status >= 200 && head.status < 400,
    };
  } catch {
    try {
      const get = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000) });
      return {
        status: String(get.status),
        finalUrl: get.url || url,
        ok: get.status >= 200 && get.status < 400,
      };
    } catch (err) {
      return { status: null, error: String(err.message || err).slice(0, 200), ok: false };
    }
  }
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

async function gscConnection(db, siteId) {
  const { data } = await db
    .from('connections')
    .select('id, organization_id, site_id, provider, status, external_property_id, vault_secret_id')
    .eq('site_id', siteId)
    .eq('provider', 'gsc')
    .eq('status', 'connected')
    .maybeSingle();
  return data || null;
}

async function refreshToken(db, connection) {
  if (!connection?.vault_secret_id) return null;
  const { data, error } = await db.rpc('read_connection_secret', { p_id: connection.vault_secret_id });
  if (error) throw error;
  return data;
}

export async function liveGscPage(db, { siteId, organizationId, pageUrl }) {
  const connection = await gscConnection(db, siteId);
  if (!connection) return { skipped: true, reason: 'gsc_not_connected' };
  const token = await refreshToken(db, connection);
  if (!token) return { skipped: true, reason: 'gsc_missing_token' };
  const auth = oauthClient(token);
  const sc = google.searchconsole({ version: 'v1', auth });
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const siteUrl = connection.external_property_id;
  const pathOrUrl = pageUrl;
  const pages = await sc.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: fmt(start),
      endDate: fmt(end),
      dimensions: ['page'],
      dimensionFilterGroups: [{
        filters: [{ dimension: 'page', operator: 'equals', expression: pathOrUrl }],
      }],
      rowLimit: 5,
    },
  });
  const row = (pages.data.rows && pages.data.rows[0]) || null;
  const payload = row
    ? {
        page: row.keys[0],
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr != null ? +(row.ctr * 100).toFixed(2) : null,
        position: row.position,
        period_start: fmt(start),
        period_end: fmt(end),
      }
    : { page: pathOrUrl, clicks: 0, impressions: 0, ctr: null, position: null, period_start: fmt(start), period_end: fmt(end), absent: true };

  // Targeted write: only this page row for the site (not a full GSC replace).
  const { data: existing } = await db
    .from('search_pages')
    .select('id')
    .eq('site_id', siteId)
    .eq('page', payload.page)
    .limit(1);
  if (existing && existing[0]) {
    await db.from('search_pages').update({
      clicks: payload.clicks,
      impressions: payload.impressions,
      ctr: payload.ctr,
      position: payload.position,
      period_start: payload.period_start,
      period_end: payload.period_end,
    }).eq('id', existing[0].id);
  } else if (!payload.absent) {
    await db.from('search_pages').insert({
      organization_id: organizationId,
      site_id: siteId,
      ...payload,
    });
  }

  let inspection = null;
  try {
    const inspect = await sc.urlInspection.index.inspect({
      requestBody: { inspectionUrl: /^https?:\/\//i.test(pageUrl) ? pageUrl : siteUrl.replace(/\/$/, '') + pageUrl, siteUrl },
    });
    const idx = inspect.data?.inspectionResult?.indexStatusResult || {};
    inspection = {
      coverageState: idx.coverageState || null,
      robotsTxtState: idx.robotsTxtState || null,
      pageFetchState: idx.pageFetchState || null,
      indexingState: idx.indexingState || null,
      verdict: inspect.data?.inspectionResult?.indexStatusResult?.verdict || null,
    };
  } catch (err) {
    inspection = { error: String(err.message || err).slice(0, 200) };
  }

  return { skipped: false, search_page: payload, inspection, patched: true };
}

export async function livePsi(db, { organizationId, siteId, pageUrl }) {
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return { skipped: true, reason: 'no_https_url' };
  try {
    const result = await refreshOnePsiPage(db, { organizationId, siteId, pageUrl });
    return { skipped: false, ...result, patched: true };
  } catch (err) {
    return { skipped: false, error: String(err.message || err).slice(0, 300), patched: false };
  }
}

/**
 * Gather live tool evidence for one acknowledgement and patch only that item's store.
 * Full-site sync is never triggered here.
 */
export async function probeClaimLive(db, ack) {
  const snap = ack.claim_snapshot || {};
  const url = snap.url || snap.targetUrl || snap.sourceUrl || snap.page || null;
  const absoluteUrl = url && /^https?:\/\//i.test(url)
    ? url
    : (url && String(url).startsWith('/') ? null : url);
  const out = {
    tools_used: [],
    http: null,
    gsc: null,
    psi: null,
    patches: [],
  };

  const httpUrl = absoluteUrl || (snap.url && /^https?:\/\//i.test(snap.url) ? snap.url : null);
  if (httpUrl) {
    out.http = await liveHttp(httpUrl);
    out.tools_used.push('http');
  }
  if (snap.sourceUrl) {
    out.http_source = await liveHttp(snap.sourceUrl);
    out.tools_used.push('http_source');
  }
  if (snap.targetUrl && snap.targetUrl !== httpUrl) {
    out.http_target = await liveHttp(snap.targetUrl);
    out.tools_used.push('http_target');
  }

  const pageForGsc = snap.page || snap.url || absoluteUrl;
  if (pageForGsc && (ack.source_kind === 'gsc_issue' || ack.source_kind === 'page' || ack.source_kind === 'keyword' || ack.source_kind === 'internal_link' || ack.source_kind === 'fix' || ack.source_kind === 'audit_finding' || ack.source_kind === 'task')) {
    try {
      out.gsc = await liveGscPage(db, {
        siteId: ack.site_id,
        organizationId: ack.organization_id,
        pageUrl: pageForGsc,
      });
      out.tools_used.push('gsc');
      if (out.gsc && out.gsc.patched) out.patches.push('search_pages');
    } catch (err) {
      out.gsc = { error: String(err.message || err).slice(0, 300) };
      out.tools_used.push('gsc');
    }
  }

  if (ack.source_kind === 'psi_issue' || (httpUrl && ack.source_kind === 'page')) {
    let pageUrl = httpUrl;
    if (ack.source_kind === 'psi_issue') {
      const { data: issue } = await db
        .from('psi_issues')
        .select('id, audit_id, psi_scores(page_url)')
        .eq('id', ack.source_id)
        .maybeSingle();
      pageUrl = (issue && issue.psi_scores && issue.psi_scores.page_url) || httpUrl;
      out.claimed_audit_id = issue && issue.audit_id;
    }
    if (pageUrl) {
      out.psi = await livePsi(db, {
        organizationId: ack.organization_id,
        siteId: ack.site_id,
        pageUrl,
      });
      out.tools_used.push('psi');
      if (out.psi && out.psi.patched) out.patches.push('psi_scores', 'psi_issues');
      if (out.claimed_audit_id && out.psi && Array.isArray(out.psi.audits)) {
        const still = out.psi.audits.filter(
          (a) => a.audit_id === out.claimed_audit_id && (a.severity === 'critical' || a.severity === 'high')
        );
        out.psi.claimed_audit_still_open = still;
        if (!still.length && !out.psi.error) out.psi.claimed_audit_cleared = true;
      }
    }
  }

  return out;
}
