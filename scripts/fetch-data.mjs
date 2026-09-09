// Pulls fresh SEO/marketing data from Search Console, GA4 and Clarity and
// writes it to data/latest.json. Run by the GitHub Actions workflow on a
// schedule (see .github/workflows/refresh.yml) and committed back to the
// repo, which triggers a Vercel redeploy of the static dashboard.
//
// Required secrets/env vars (set as GitHub Actions repo secrets):
//   GOOGLE_SERVICE_ACCOUNT_JSON  - full JSON key of a Google Cloud service
//                                  account with access to GSC + GA4 (see README)
//   GSC_SITE_URL                 - e.g. https://rytsensetech.com/
//   GA4_PROPERTY_ID              - e.g. 423166919 (numeric id only)
//   CLARITY_API_TOKEN            - optional, from Clarity project settings

import { google } from 'googleapis';
import fs from 'fs';

const SITE_URL = requireEnv('GSC_SITE_URL');
const GA4_PROPERTY = requireEnv('GA4_PROPERTY_ID');
const CLARITY_TOKEN = process.env.CLARITY_API_TOKEN || '';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}. See README.md for setup.`);
    process.exit(1);
  }
  return v;
}

const credsJson = JSON.parse(requireEnv('GOOGLE_SERVICE_ACCOUNT_JSON'));

const auth = new google.auth.GoogleAuth({
  credentials: credsJson,
  scopes: [
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/analytics.readonly',
  ],
});

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}
function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

async function fetchGSC(authClient) {
  const webmasters = google.webmasters({ version: 'v3', auth: authClient });

  const currentStart = dateStr(daysAgo(28));
  const currentEnd = dateStr(daysAgo(1));
  const priorStart = dateStr(daysAgo(56));
  const priorEnd = dateStr(daysAgo(29));

  async function totals(startDate, endDate) {
    const res = await webmasters.searchanalytics.query({
      siteUrl: SITE_URL,
      requestBody: { startDate, endDate, dimensions: [] },
    });
    const row = (res.data.rows && res.data.rows[0]) || {};
    return {
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      ctr: round((row.ctr || 0) * 100),
      position: round(row.position || 0, 1),
    };
  }

  const current = await totals(currentStart, currentEnd);
  const prior = await totals(priorStart, priorEnd);

  const change = {
    clicks: current.clicks - prior.clicks,
    clicksPercent: prior.clicks ? round(((current.clicks - prior.clicks) / prior.clicks) * 100) : 0,
    impressions: current.impressions - prior.impressions,
    impressionsPercent: prior.impressions
      ? round(((current.impressions - prior.impressions) / prior.impressions) * 100)
      : 0,
    ctr: round(current.ctr - prior.ctr),
    position: round(current.position - prior.position, 1),
  };

  // "Near-miss" keywords: ranking positions 4-15 with meaningful impressions —
  // the classic quick-win zone (already visible, not yet clicked much).
  // Opportunity score here is our own estimate (impression volume weighted by
  // how far off page-one-top the query sits and how much CTR headroom is
  // left) — treat it as directional, not an official Search Console metric.
  const qRes = await webmasters.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: currentStart,
      endDate: currentEnd,
      dimensions: ['query'],
      rowLimit: 5000,
    },
  });
  const quickWins = (qRes.data.rows || [])
    .map((r) => ({
      query: r.keys[0],
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: round((r.ctr || 0) * 100),
      position: round(r.position || 0, 1),
    }))
    .filter((r) => r.position >= 4 && r.position <= 15 && r.impressions >= 100)
    .map((r) => ({
      ...r,
      opportunity: Math.round(r.impressions * (1 - r.ctr / 100) * 0.05 * (16 - r.position)),
    }))
    .sort((a, b) => b.opportunity - a.opportunity)
    .slice(0, 8);

  return {
    period: { startDate: currentStart, endDate: currentEnd },
    current,
    prior,
    change,
    quickWins,
  };
}

async function fetchGA4(authClient) {
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth: authClient });
  const property = `properties/${GA4_PROPERTY}`;

  const dailyRes = await analyticsdata.properties.runReport({
    property,
    requestBody: {
      dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'sessions' },
        { name: 'activeUsers' },
        { name: 'engagementRate' },
        { name: 'screenPageViews' },
      ],
    },
  });

  const dailyRows = dailyRes.data.rows || [];
  let sessions = 0,
    activeUsers = 0,
    pageViews = 0,
    engWeighted = 0;
  const daily = dailyRows
    .map((r) => {
      const s = +r.metricValues[0].value;
      const u = +r.metricValues[1].value;
      const eng = +r.metricValues[2].value;
      const pv = +r.metricValues[3].value;
      sessions += s;
      activeUsers += u;
      pageViews += pv;
      engWeighted += eng * s;
      return { date: r.dimensionValues[0].value, sessions: s };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const totals = {
    sessions,
    activeUsers,
    pageViews,
    engagementRate: sessions ? round(engWeighted / sessions, 4) : 0,
  };

  const chanRes = await analyticsdata.properties.runReport({
    property,
    requestBody: {
      dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'conversions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    },
  });
  const channels = (chanRes.data.rows || []).map((r) => ({
    channel: r.dimensionValues[0].value,
    sessions: +r.metricValues[0].value,
    activeUsers: +r.metricValues[1].value,
    conversions: Math.round(+r.metricValues[2].value),
  }));

  return { totals, daily, channels };
}

async function fetchClarity() {
  if (!CLARITY_TOKEN) {
    return {
      status: 'unavailable',
      note: 'No CLARITY_API_TOKEN secret set — add one from your Clarity project settings (Settings > Data Export > API tokens) to enable this section.',
    };
  }
  try {
    const res = await fetch(
      'https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=1',
      { headers: { Authorization: `Bearer ${CLARITY_TOKEN}` } }
    );
    if (!res.ok) throw new Error(`Clarity API returned ${res.status}`);
    const data = await res.json();
    return { status: 'ok', data };
  } catch (e) {
    return { status: 'unavailable', note: `Clarity fetch failed: ${e.message}` };
  }
}

async function main() {
  const authClient = await auth.getClient();
  const [gsc, ga4, clarity] = await Promise.all([
    fetchGSC(authClient),
    fetchGA4(authClient),
    fetchClarity(),
  ]);

  const out = {
    site: SITE_URL.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    updatedAt: new Date().toISOString(),
    gsc,
    ga4,
    clarity,
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/latest.json', JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote data/latest.json for', out.site, 'at', out.updatedAt);
}

main().catch((e) => {
  console.error('fetch-data failed:', e);
  process.exit(1);
});
