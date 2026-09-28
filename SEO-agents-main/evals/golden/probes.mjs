/**
 * probes.mjs — the live-measurement half of the golden-set eval.
 *
 * Every golden assertion carries a probe. The probe is the GRADING AUTHORITY;
 * the value stored in rytsensetech.com.json is only a tripwire that tells us the
 * site moved. That inversion is deliberate and it is the whole design:
 *
 *   Audit 2026-09-19, §4.4 — a golden set whose stored numbers are the pass
 *   condition rots into a lie the first time the client ships a release. On
 *   2026-09-25 the /us/ sitemap went 240 → 250 URLs. A frozen golden set would
 *   have failed three correct agents; this one reports DRIFT and prints the
 *   rebaseline command.
 *
 * Every probe returns { value, measured, note } — and `measured: false` is a
 * first-class result, never a zero. This is the same guarantee serp.py makes
 * with notChecked/None (§3.1 of the audit: a failed query that vanishes from
 * serp-batch.json turns "not measured" into "not ranking"). An eval harness that
 * reproduced that bug would be worse than no harness.
 *
 * Adding a probe: export a function on PROBES keyed by the `verify.kind` string
 * an assertion uses. Nothing else needs to change.
 */

import { readFileSync, existsSync } from 'node:fs';

const UA = 'Mozilla/5.0 (compatible; SEOAgentEval/1.0; +golden-set regression eval)';
const TIMEOUT_MS = 20000;

/** A probe result. `measured: false` is UNMEASURED — never a pass, never a fail. */
export const measured = (value, note) => ({ value, measured: true, note });
export const unmeasured = (note) => ({ value: null, measured: false, note });

// ----------------------------------------------------------------- fetch layer

/**
 * One network read. Network failure is UNMEASURED, not a failing assertion —
 * grading an agent on our own DNS hiccup is exactly the conflation §3.1 warns
 * about.
 */
export async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: ctl.signal });
    const body = await r.text();
    return { ok: true, status: r.status, body, url: r.url };
  } catch (e) {
    return { ok: false, status: null, body: '', error: String(e.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

/** Bounded-concurrency fan-out. 6 is polite; the client's origin is not ours. */
export async function getAll(urls, concurrency = 6) {
  const out = new Array(urls.length);
  let i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const n = i++;
      out[n] = { requested: urls[n], ...(await get(urls[n])) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

// --------------------------------------------------------------- HTML helpers

export const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
export const title = (html) => (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
export const canonicalHref = (html) =>
  html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
  html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i)?.[1] ??
  null;

/** Visible words only. The soft-404 test turns on "200 with an empty body". */
export function bodyWords(html) {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
  return stripped.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
}

export function jsonLdBlocks(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(m[1].trim())); } catch { /* malformed JSON-LD is itself a finding, not our job here */ }
  }
  return out;
}

/** Walk any object graph and yield every node carrying `key`. */
export function collectKey(node, key, acc = []) {
  if (Array.isArray(node)) { for (const n of node) collectKey(n, key, acc); return acc; }
  if (node && typeof node === 'object') {
    if (key in node) acc.push(node[key]);
    for (const v of Object.values(node)) collectKey(v, key, acc);
  }
  return acc;
}

/**
 * In-body links only: everything after the last nav/header block and before the
 * footer. The withdrawn "55 of 115" figure (board bd_tjb17fg0, adjudicated
 * withdrawn by seo-orchestrator) came from counting nav+footer chrome as
 * editorial links. Getting this boundary right is the whole point of the probe.
 */
export function inBodyRegion(html) {
  const main = html.match(/<main[\s\S]*?<\/main>/i);
  if (main) return main[0];
  const art = html.match(/<article[\s\S]*?<\/article>/i);
  if (art) return art[0];
  return html.replace(/<header[\s\S]*?<\/header>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ').replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
}

export const hrefs = (html) => [...html.matchAll(/<a[^>]+href=["']([^"'#][^"']*)["']/gi)].map((m) => m[1]);

// ------------------------------------------------------------ sitemap walking

const sitemapCache = new Map();

/** Walk a sitemap index one level down. Returns { total, unique, perChild }. */
export async function walkSitemap(indexUrl) {
  if (sitemapCache.has(indexUrl)) return sitemapCache.get(indexUrl);
  const idx = await get(indexUrl);
  if (!idx.ok || idx.status !== 200) {
    const r = unmeasured(`sitemap index ${indexUrl} → ${idx.status ?? idx.error}`);
    return r;
  }
  const children = locs(idx.body);
  const perChild = {};
  const all = [];
  for (const child of children) {
    const c = await get(child);
    if (!c.ok || c.status !== 200) return unmeasured(`sub-sitemap ${child} → ${c.status ?? c.error}`);
    const l = locs(c.body);
    perChild[child.split('/').pop()] = l.length;
    all.push(...l);
  }
  const res = measured({ total: all.length, unique: new Set(all).size, children: children.length, perChild, urls: all });
  sitemapCache.set(indexUrl, res);
  return res;
}

// ---------------------------------------------------------------- SERP source

/**
 * SERP assertions read the cached batch by default. Burning provider credits on
 * every eval run is how an eval stops being run at all — and §3.5 of the audit
 * showed the cache already mixes rows up to an hour apart, so a cached read is
 * reported as what it is rather than as a point-in-time measurement.
 */
export function readSerpBatch(file) {
  if (!existsSync(file)) return unmeasured(`no cached SERP batch at ${file} — produce it with: python tools/serp.py batch <keywords file> --location "United States" --out ${file.replace(/\/[^/]+$/, '')}`);
  try {
    const rows = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(rows) || !rows.length) return unmeasured(`${file} holds no rows`);
    return measured(rows);
  } catch (e) {
    return unmeasured(`${file} is not readable JSON: ${e.message}`);
  }
}

// ------------------------------------------------------------- probe registry

export const PROBES = {
  /** cfg: { index, field: total|unique|children } */
  async 'sitemap-count'(cfg) {
    const w = await walkSitemap(cfg.index);
    if (!w.measured) return w;
    return measured(w.value[cfg.field ?? 'total'], `perChild=${JSON.stringify(w.value.perChild)}`);
  },

  /** cfg: { indexes: {global, us} } — asserts global + us == total. */
  async 'sitemap-inventory'(cfg) {
    const g = await walkSitemap(cfg.indexes.global);
    const u = await walkSitemap(cfg.indexes.us);
    if (!g.measured) return g;
    if (!u.measured) return u;
    const total = g.value.total + u.value.total;
    return measured(total, `global ${g.value.total} + us ${u.value.total}`);
  },

  /** cfg: { index, expectStatus } — status code census over every sitemap URL. DEEP. */
  async 'sitemap-status-census'(cfg) {
    const w = await walkSitemap(cfg.index);
    if (!w.measured) return w;
    const res = await getAll(w.value.urls);
    const failed = res.filter((r) => !r.ok);
    // If a fifth of the fan-out failed at the transport layer we did not measure
    // this; we measured our own network. Say so rather than inventing a rate.
    if (failed.length > res.length * 0.2) return unmeasured(`${failed.length}/${res.length} requests failed at transport level`);
    const want = cfg.expectStatus ?? 200;
    const hits = res.filter((r) => r.status === want).length;
    return measured(hits, `${hits}/${res.length} returned ${want}; ${failed.length} transport failures`);
  },

  /** cfg: { url, field: status|bodyWords|bytes|hasTitle } */
  async 'page-shape'(cfg) {
    const r = await get(cfg.url);
    if (!r.ok) return unmeasured(`${cfg.url}: ${r.error}`);
    const shape = { status: r.status, bodyWords: bodyWords(r.body), bytes: r.body.length, hasTitle: title(r.body).length > 0 };
    return measured(shape[cfg.field], `status=${shape.status} words=${shape.bodyWords} title=${shape.hasTitle}`);
  },

  /**
   * cfg: { url, control } — a soft 404 is only a defect if the real 404 path
   * works. Without the control we would be reporting "the site 200s everything".
   */
  async 'soft-404'(cfg) {
    const [page, ctrl] = await Promise.all([get(cfg.url), get(cfg.control)]);
    if (!page.ok || !ctrl.ok) return unmeasured(`fetch failed: ${page.error ?? ctrl.error}`);
    if (ctrl.status !== 404) return unmeasured(`control ${cfg.control} returned ${ctrl.status}, not 404 — cannot distinguish a soft 404 from a site that never 404s`);
    const soft = page.status === 200 && bodyWords(page.body) === 0 && !title(page.body);
    return measured(soft, `page=${page.status}/${bodyWords(page.body)}w control=${ctrl.status}`);
  },

  /** cfg: { url } → the canonical's host, plus whether that host resolves. */
  async 'canonical-host'(cfg) {
    const r = await get(cfg.url);
    if (!r.ok) return unmeasured(`${cfg.url}: ${r.error}`);
    const href = canonicalHref(r.body);
    if (!href) return measured('NONE', 'no rel=canonical emitted');
    let host;
    try { host = new URL(href).host; } catch { return measured('MALFORMED', href); }
    const probe = await get(href);
    return measured(host, probe.ok ? `canonical target → HTTP ${probe.status}` : `canonical target does not resolve (${probe.error})`);
  },

  /** cfg: { urls: [a, b] } — do two URLs serve byte-identical <title>? */
  async 'title-collision'(cfg) {
    const [a, b] = await getAll(cfg.urls, 2);
    if (!a.ok || !b.ok) return unmeasured(`fetch failed: ${a.error ?? b.error}`);
    const ta = title(a.body), tb = title(b.body);
    return measured(ta === tb && ta.length > 0, `"${ta.slice(0, 60)}" vs "${tb.slice(0, 60)}"`);
  },

  /** cfg: { urls, pattern, flags, mode: urlsWithMatch|totalMatches } */
  async 'regex-census'(cfg) {
    const res = await getAll(cfg.urls);
    const failed = res.filter((r) => !r.ok);
    if (failed.length) return unmeasured(`${failed.length}/${res.length} fetches failed (${failed[0].error})`);
    // A 404 has no matches, so a census over dead URLs returns a confident zero.
    // That is the not-measured/not-present conflation again, and it would have
    // turned a stale URL list into a silent PASS on "zero noindex".
    const notOk = res.filter((r) => r.status !== 200);
    if (notOk.length) return unmeasured(`${notOk.length}/${res.length} URLs did not return 200 (${notOk[0].requested} → ${notOk[0].status}) — a census over dead URLs is not a measurement`);
    const re = new RegExp(cfg.pattern, cfg.flags ?? 'gi');
    let urlsWith = 0, total = 0;
    const which = [];
    for (const r of res) {
      const n = [...r.body.matchAll(re)].length;
      total += n;
      if (n) { urlsWith++; which.push(r.requested); }
    }
    return measured(cfg.mode === 'totalMatches' ? total : urlsWith, `${urlsWith} of ${res.length} URLs matched, ${total} total; ${which.map((u) => new URL(u).pathname).join(' ')}`);
  },

  /**
   * cfg: { urls, hrefPattern, region: article|main, mode: totalLinks|urlsWithLink }
   *
   * Counts links in the EDITORIAL region only — never nav, header or footer.
   * This probe exists because of one specific incident: board bd_tjb17fg0,
   * "55 of 115 crawled /us/ blog posts DO carry in-body links", adjudicated
   * withdrawn (bd_7t75z3nr) because it counted header-nav and footer chrome.
   * A regex over whole-page HTML would reproduce that artifact exactly, so this
   * kind slices the region first and only then looks for hrefs.
   */
  async 'in-body-link-census'(cfg) {
    const res = await getAll(cfg.urls);
    const bad = res.filter((r) => !r.ok || r.status !== 200);
    if (bad.length) return unmeasured(`${bad.length}/${res.length} URLs unusable (${bad[0].requested} → ${bad[0].status ?? bad[0].error})`);
    const re = new RegExp(`href=["']([^"']*${cfg.hrefPattern})["']`, 'g');
    let total = 0, withLink = 0;
    const detail = [];
    for (const r of res) {
      const region = cfg.region === 'article'
        ? (r.body.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? '')
        : inBodyRegion(r.body);
      if (!region) return unmeasured(`${r.requested} has no <${cfg.region ?? 'main'}> region — cannot separate editorial links from chrome, which is exactly how the withdrawn 55-of-115 figure was produced`);
      const hits = [...region.matchAll(re)].map((m) => m[1]);
      total += hits.length;
      if (hits.length) { withLink++; detail.push(`${new URL(r.requested).pathname}→${hits.length}`); }
    }
    return measured(cfg.mode === 'urlsWithLink' ? withLink : total, `${withLink} of ${res.length} pages carry one; ${total} links total. ${detail.join(' ')}`);
  },

  /** cfg: { urls } — count of DISTINCT (ratingValue, ratingCount) pairs in JSON-LD. */
  async 'aggregate-rating-census'(cfg) {
    const res = await getAll(cfg.urls);
    if (res.some((r) => !r.ok)) return unmeasured('one or more fetches failed');
    const pairs = new Set();
    for (const r of res) {
      for (const block of jsonLdBlocks(r.body)) {
        for (const ar of collectKey(block, 'aggregateRating')) {
          if (ar && typeof ar === 'object') pairs.add(`${ar.ratingValue}/${ar.ratingCount ?? ar.reviewCount}`);
        }
      }
    }
    return measured(pairs.size, `distinct: ${[...pairs].join(', ') || 'none'}`);
  },

  /** cfg: { sources: [{url, pattern}] } — how many DISTINCT values across sources. */
  async 'contradiction-census'(cfg) {
    const res = await getAll(cfg.sources.map((s) => s.url));
    const vals = new Set();
    const seen = [];
    for (let i = 0; i < res.length; i++) {
      if (!res[i].ok) return unmeasured(`${cfg.sources[i].url}: ${res[i].error}`);
      const m = res[i].body.match(new RegExp(cfg.sources[i].pattern, 'i'));
      if (m) { vals.add(m[1]); seen.push(`${new URL(cfg.sources[i].url).pathname}=${m[1]}`); }
    }
    return measured(vals.size, seen.join(' | '));
  },

  /** cfg: { url, pattern } — count hreflang alternates on one page. */
  async 'hreflang-count'(cfg) {
    const r = await get(cfg.url);
    if (!r.ok) return unmeasured(`${cfg.url}: ${r.error}`);
    return measured([...r.body.matchAll(/<link[^>]+hreflang=["']([^"']+)["']/gi)].length, cfg.url);
  },

  /** cfg: { url, urlPattern, against } — /us/ URLs listed in an llms.txt file. */
  async 'llms-txt-coverage'(cfg) {
    const r = await get(cfg.url);
    if (!r.ok || r.status !== 200) return unmeasured(`${cfg.url} → ${r.status ?? r.error}`);
    const listed = new Set([...r.body.matchAll(new RegExp(cfg.urlPattern, 'g'))].map((m) => m[0]));
    return measured(listed.size, `${listed.size} matching URLs listed in ${cfg.url}`);
  },

  /** cfg: { urls: [[a,b], …], nGram } — max 6-gram Jaccard across page pairs, as a percent. DEEP. */
  async 'jaccard-pairs'(cfg) {
    const flat = cfg.urls.flat();
    const res = await getAll(flat);
    if (res.some((r) => !r.ok)) return unmeasured('one or more fetches failed');
    const byUrl = Object.fromEntries(res.map((r) => [r.requested, r.body]));
    const grams = (html, n) => {
      const w = inBodyRegion(html).replace(/<[^>]+>/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
      const s = new Set();
      for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' '));
      return s;
    };
    let max = 0;
    const detail = [];
    for (const [a, b] of cfg.urls) {
      const ga = grams(byUrl[a], cfg.nGram ?? 6), gb = grams(byUrl[b], cfg.nGram ?? 6);
      const inter = [...ga].filter((g) => gb.has(g)).length;
      const union = new Set([...ga, ...gb]).size || 1;
      const pct = (inter / union) * 100;
      detail.push(`${new URL(a).pathname}:${pct.toFixed(1)}%`);
      max = Math.max(max, pct);
    }
    return measured(Number(max.toFixed(1)), detail.join(' '));
  },

  /**
   * cfg: { index, limit, metric } — crawl the tree and measure the in-body link
   * graph. DEEP: this is a few hundred fetches.
   *   metric: leakPct | orphanCount | inBodyLinks | chromeLinks
   */
  async 'link-graph'(cfg) {
    const w = await walkSitemap(cfg.index);
    if (!w.measured) return w;
    const urls = w.value.urls.slice(0, cfg.limit ?? 400);
    const res = await getAll(urls, 8);
    const ok = res.filter((r) => r.ok && r.status === 200);
    if (ok.length < urls.length * 0.8) return unmeasured(`only ${ok.length}/${urls.length} pages fetched — too thin to build a link graph`);

    const norm = (href, base) => { try { return new URL(href, base).href.replace(/\/?$/, '/'); } catch { return null; } };
    const inbound = new Map(urls.map((u) => [u.replace(/\/?$/, '/'), 0]));
    let inBody = 0, chrome = 0, leaked = 0;

    for (const r of ok) {
      const body = inBodyRegion(r.body);
      const bodyLinks = hrefs(body).map((h) => norm(h, r.requested)).filter(Boolean);
      const allLinks = hrefs(r.body).map((h) => norm(h, r.requested)).filter(Boolean);
      const internal = bodyLinks.filter((u) => u.includes(cfg.host));
      inBody += internal.length;
      chrome += allLinks.length - bodyLinks.length;
      leaked += internal.filter((u) => !new URL(u).pathname.startsWith(cfg.treePrefix)).length;
      for (const u of new Set(internal)) if (inbound.has(u)) inbound.set(u, inbound.get(u) + 1);
    }

    const metrics = {
      leakPct: inBody ? Number(((leaked / inBody) * 100).toFixed(1)) : null,
      orphanCount: [...inbound.values()].filter((n) => n === 0).length,
      inBodyLinks: inBody,
      chromeLinks: chrome,
    };
    return measured(metrics[cfg.metric], `crawled ${ok.length}; inBody=${inBody} chrome=${chrome} leak=${metrics.leakPct}% orphans=${metrics.orphanCount}`);
  },

  /**
   * cfg: { file, metric } — read the cached SERP batch. Never burns credits.
   *   metric: targetInTop10 | rowsMeasured | minDepth | vendorMean | aiOverviewAllUnchecked
   */
  async 'serp-batch'(cfg) {
    const b = readSerpBatch(cfg.file);
    if (!b.measured) return b;
    const rows = b.value;

    // §3.1: a row written by a failed query must not silently shrink the
    // denominator. If the harness cannot tell measured from missing, it cannot
    // tell "not ranking" from "not checked" — the exact bug it exists to catch.
    const rowsMeasured = rows.filter((r) => r.measured !== false && !r.error).length;
    const depths = rows.map((r) => (r.organic ?? []).length);
    const minDepth = depths.length ? Math.min(...depths) : 0;

    if (cfg.metric === 'rowsMeasured') return measured(rowsMeasured, `${rowsMeasured}/${rows.length} rows carry results`);
    if (cfg.metric === 'minDepth') return measured(minDepth, `depths ${Math.min(...depths)}–${Math.max(...depths)}`);

    if (cfg.metric === 'targetInTop10') {
      if (rowsMeasured < rows.length) return unmeasured(`${rows.length - rowsMeasured} of ${rows.length} queries have no result row — cannot distinguish absent from unmeasured`);
      if (minDepth < 10) return unmeasured(`shallowest SERP returned ${minDepth} organic slots — a top-10 claim is not supported by ${minDepth}-result data`);
      const hits = rows.filter((r) => (r.organic ?? []).slice(0, 10).some((o) => (o.domain ?? o.url ?? '').includes(cfg.target))).length;
      return measured(hits, `${hits} of ${rows.length} queries, ${depths.reduce((a, b) => a + b, 0)} organic slots scanned`);
    }

    if (cfg.metric === 'targetInAnySlot') {
      // The weaker claim that the data DOES support. Absence from the slots that
      // were actually retrieved is measurable at any depth; absence from "the
      // top 10" is not, when a row came back with 9.
      if (rowsMeasured < rows.length) return unmeasured(`${rows.length - rowsMeasured} of ${rows.length} queries have no result row`);
      const hits = rows.reduce((n, r) => n + (r.organic ?? []).filter((o) => (o.domain ?? o.url ?? '').includes(cfg.target)).length, 0);
      return measured(hits, `${hits} hits across ${depths.reduce((a, b) => a + b, 0)} retrieved organic slots`);
    }

    if (cfg.metric === 'vendorMean') {
      const dirs = new Set(cfg.directories ?? []);
      const media = new Set(cfg.media ?? []);
      const perQuery = rows.map((r) => (r.organic ?? []).slice(0, 10).filter((o) => {
        const d = (o.domain ?? '').replace(/^www\./, '');
        return !dirs.has(d) && !media.has(d);
      }).length);
      const mean = perQuery.reduce((a, b) => a + b, 0) / (perQuery.length || 1);
      return measured(Number(mean.toFixed(1)), `${rows.length} queries`);
    }

    if (cfg.metric === 'aiOverviewAllUnchecked') {
      // The honesty guarantee, graded. Every serper row must carry aiOverview
      // null AND name it in notChecked. A single row reporting `false` would
      // license an agent to write "no AI Overview" about a SERP nobody looked at.
      const bad = rows.filter((r) => r.provider === 'serper' && (r.aiOverview !== null || !(r.notChecked ?? []).includes('aiOverview')));
      return measured(bad.length === 0, `${rows.length} rows; ${bad.length} violate aiOverview=null + notChecked`);
    }

    return unmeasured(`unknown serp-batch metric "${cfg.metric}"`);
  },
};

export const PROBE_KINDS = Object.keys(PROBES);
