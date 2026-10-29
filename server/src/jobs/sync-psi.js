// Weekly Page Speed Insights sync (Monday). Stores scores until the next run.
// For each active site: every Search Console URL plus sitemap URLs, run Lighthouse
// via the PageSpeed Insights API (mobile + desktop), store one psi_scores row per
// page per day and one psi_issues row per failing performance audit per strategy.

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const CONCURRENCY = 3;          // pages in flight at once (each = 2 PSI calls)
const REQUEST_TIMEOUT_MS = 90_000;
const SITEMAP_TIMEOUT_MS = 20_000;

export function pageCap() {
  const n = Number(process.env.PSI_MAX_PAGES);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return Number.MAX_SAFE_INTEGER;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchPSI(url, strategy, { fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ url, strategy, category: 'performance' });
  const key = process.env.GOOGLE_PAGESPEED_API_KEY;
  if (key) params.set('key', key);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetchImpl(`${PSI_ENDPOINT}?${params}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 2) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
      throw new Error(`PSI ${strategy} ${res.status}${detail ? ': ' + detail : ''}`);
    }
    await sleep(5000);
  }
}

const seconds = (audit) => (audit && Number.isFinite(audit.numericValue) ? +(audit.numericValue / 1000).toFixed(3) : null);

export function extractMetrics(data) {
  const lh = (data && data.lighthouseResult) || {};
  const audits = lh.audits || {};
  const perf = lh.categories && lh.categories.performance;
  const cls = audits['cumulative-layout-shift'];
  return {
    score: perf && Number.isFinite(perf.score) ? Math.round(perf.score * 100) : null,
    lcp: seconds(audits['largest-contentful-paint']),
    fcp: seconds(audits['first-contentful-paint']),
    cls: cls && Number.isFinite(cls.numericValue) ? +cls.numericValue.toFixed(4) : null,
    ttfb: seconds(audits['server-response-time']),
  };
}

export function severityFor(score) {
  if (score < 0.25) return 'critical';
  if (score < 0.5) return 'high';
  if (score < 0.75) return 'medium';
  return 'low';
}

const SKIP_MODES = new Set(['notApplicable', 'informative', 'manual', 'error']);

// Only audits that belong to the performance category and are not the headline
// metrics themselves (those are stored as columns on psi_scores).
export function extractIssues(data, strategy) {
  const lh = (data && data.lighthouseResult) || {};
  const audits = lh.audits || {};
  const refs = (lh.categories && lh.categories.performance && lh.categories.performance.auditRefs) || [];
  const issues = [];
  for (const ref of refs) {
    if (ref.group === 'metrics' || ref.group === 'hidden') continue;
    const audit = audits[ref.id];
    if (!audit || SKIP_MODES.has(audit.scoreDisplayMode) || !Number.isFinite(audit.score)) continue;
    const severity = severityFor(audit.score);
    if (severity === 'low') continue;
    issues.push({
      strategy,
      audit_id: ref.id,
      issue_type: audit.details && audit.details.type === 'opportunity' ? 'opportunity' : 'diagnostic',
      severity,
      title: audit.title,
      description: audit.description || null,
      impact_score: Math.round((1 - audit.score) * 100),
      estimated_savings: audit.displayValue || null,
      category: 'performance',
    });
  }
  return issues;
}

export function urlsFromSitemapXml(xml) {
  const out = [];
  const re = /<loc>\s*([^<]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml || '')))) out.push(m[1].trim());
  return out;
}

export async function collectSitemapPages(domain, { fetchImpl = fetch } = {}) {
  const host = String(domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!host) return [];
  const seeds = [];
  for (const origin of [`https://${host}`, `https://www.${host}`]) {
    try {
      const robots = await fetchImpl(`${origin}/robots.txt`, { signal: AbortSignal.timeout(SITEMAP_TIMEOUT_MS) });
      if (robots && robots.ok && typeof robots.text === 'function') {
        const text = await robots.text();
        for (const line of String(text || '').split(/\r?\n/)) {
          const sm = line.match(/^sitemap:\s*(\S+)/i);
          if (sm) seeds.push(sm[1]);
        }
      }
    } catch { /* robots.txt is optional */ }
    seeds.push(`${origin}/sitemap.xml`);
  }
  const seenXml = new Set();
  const urls = [];
  for (const start of seeds) await walkSitemap(start, 0, seenXml, urls, fetchImpl);
  return urls;
}

async function walkSitemap(url, depth, seenXml, urls, fetchImpl) {
  if (depth > 2 || seenXml.has(url) || urls.length > 20000) return;
  seenXml.add(url);
  let xml = '';
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(SITEMAP_TIMEOUT_MS) });
    if (!res || !res.ok || typeof res.text !== 'function') return;
    xml = await res.text();
  } catch { return; }
  const locs = urlsFromSitemapXml(xml);
  const isIndex = /<sitemapindex/i.test(xml);
  for (const loc of locs) {
    if (isIndex) await walkSitemap(loc, depth + 1, seenXml, urls, fetchImpl);
    else urls.push(loc);
  }
}

async function loadSearchPages(db, siteId) {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from('search_pages')
      .select('page, impressions')
      .eq('site_id', siteId)
      .order('impressions', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`search_pages: ${error.message}`);
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function mergePages(gscPages, sitemapPages, limit) {
  const out = [];
  const seen = new Set();
  for (const href of [...gscPages, ...sitemapPages]) {
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
    if (out.length >= limit) break;
  }
  return out;
}

// GSC in this board stores paths ("/us/blog/...") as well as full URLs.
export function pickPages(rows, domain, limit = pageCap(), opts = {}) {
  const host = String(domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    let raw = String(row.page || '').trim();
    if (!raw) continue;
    if (raw.startsWith('/')) raw = `https://${host}${raw}`;
    else if (!/^https?:\/\//i.test(raw)) continue;
    let u;
    try { u = new URL(raw); } catch { continue; }
    if (u.hostname.replace(/^www\./, '').toLowerCase() !== host) continue;
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(key) || key === 'gclid' || key === 'fbclid') u.searchParams.delete(key);
    }
    const href = u.toString();
    if (seen.has(href)) continue;
    seen.add(href);
    out.push(href);
    if (out.length >= limit) break;
  }
  if (!out.length && host && opts.fallback !== false) out.push(`https://${host}/`);
  return out;
}

async function mapPool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function syncSite(db, site, metricDate, deps) {
  const result = { siteId: site.id, domain: site.domain, syncedPages: 0, syncedIssues: 0, errors: 0, failures: [] };
  const limit = pageCap();
  const rows = await loadSearchPages(db, site.id);
  const fromGsc = pickPages(rows, site.domain, limit);
  const sitemapUrls = await collectSitemapPages(site.domain, deps);
  const fromSitemap = pickPages(sitemapUrls.map((page) => ({ page })), site.domain, limit, { fallback: false });
  const pages = mergePages(fromGsc, fromSitemap, limit);
  console.log(`[PSI Sync] ${site.domain}: scanning ${pages.length} pages (${fromGsc.length} from Search Console, ${fromSitemap.length} from sitemap)`);

  await mapPool(pages, CONCURRENCY, async (pageUrl) => {
    try {
      const [mobile, desktop] = await Promise.all([
        fetchPSI(pageUrl, 'mobile', deps),
        fetchPSI(pageUrl, 'desktop', deps),
      ]);
      const m = extractMetrics(mobile);
      const d = extractMetrics(desktop);
      const { data: score, error: scoreError } = await db
        .from('psi_scores')
        .upsert({
          organization_id: site.organization_id,
          site_id: site.id,
          page_url: pageUrl,
          metric_date: metricDate,
          mobile_score: m.score, desktop_score: d.score,
          lcp_mobile: m.lcp, lcp_desktop: d.lcp,
          fcp_mobile: m.fcp, fcp_desktop: d.fcp,
          cls_mobile: m.cls, cls_desktop: d.cls,
          ttfb_mobile: m.ttfb, ttfb_desktop: d.ttfb,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'organization_id,site_id,page_url,metric_date' })
        .select('id')
        .single();
      if (scoreError) throw new Error(`psi_scores: ${scoreError.message}`);
      result.syncedPages++;

      const issues = [...extractIssues(mobile, 'mobile'), ...extractIssues(desktop, 'desktop')].map((i) => ({
        ...i,
        organization_id: site.organization_id,
        site_id: site.id,
        psi_score_id: score.id,
      }));
      if (issues.length) {
        // Re-running on the same day refreshes the rows; task_id is never overwritten.
        const { error: issueError } = await db.from('psi_issues').upsert(issues, { onConflict: 'psi_score_id,strategy,audit_id' });
        if (issueError) throw new Error(`psi_issues: ${issueError.message}`);
        result.syncedIssues += issues.length;
      }
    } catch (err) {
      result.errors++;
      result.failures.push({ page: pageUrl, error: err.message });
      console.error(`[PSI Sync] ${pageUrl}: ${err.message}`);
    }
  });
  return result;
}

// siteId: limit to one site; omit to sync every site in an active organization.
export async function runPSISync(db, { siteId = null, fetchImpl } = {}) {
  if (!db) throw new Error('database not configured');
  if (!process.env.GOOGLE_PAGESPEED_API_KEY) console.warn('[PSI Sync] GOOGLE_PAGESPEED_API_KEY not set; using the unauthenticated quota');

  let query = db.from('sites').select('id, organization_id, domain, organizations!inner(status)').eq('organizations.status', 'active');
  if (siteId) query = query.eq('id', siteId);
  const { data: sites, error } = await query;
  if (error) throw new Error(`sites: ${error.message}`);
  if (siteId && !(sites || []).length) throw new Error(`site not found or company suspended: ${siteId}`);

  const metricDate = new Date().toISOString().slice(0, 10);
  const started = Date.now();
  const perSite = [];
  for (const site of sites || []) perSite.push(await syncSite(db, site, metricDate, { fetchImpl }));

  const total = (k) => perSite.reduce((a, s) => a + s[k], 0);
  const out = { syncedPages: total('syncedPages'), syncedIssues: total('syncedIssues'), errors: total('errors'), seconds: Math.round((Date.now() - started) / 1000), sites: perSite };
  console.log(`[PSI Sync] done: ${out.syncedPages} pages, ${out.syncedIssues} issues, ${out.errors} errors in ${out.seconds}s`);
  return out;
}
