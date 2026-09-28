#!/usr/bin/env node
/**
 * validate-data.mjs — gate every file in data/ before it can reach the live site.
 *
 * WHY THIS EXISTS (three recorded incidents, all caught by a human or not at all):
 *
 *   1. 4b2cf2d (2026-09-24 16:19) pushed data/latest.json containing the literal
 *      11-byte string "PLACEHOLDER". It matched deploy-pages.yml's `paths: data/**`
 *      and went live. The board rendered "Connecting…" forever because index.html's
 *      .catch() swallows the JSON parse error.
 *   2. d7360a9 ("fix: revert accidental placeholder push") restored 504 bytes that
 *      were HTML-entity-encoded (&quot; for ", &#10; for newline) — also not JSON.
 *      The site stayed broken until 92d1f8f.
 *   3. 2026-09-25: a refresh trimmed gscByQuery.rows from 500 to 30 (-94%),
 *      gscByPage and ga4ByPage from 200 to 30, and still marked every section
 *      "status": "ok" — with a note saying it had been capped. Three days of
 *      analysis ran against a silently reduced sample.
 *
 * Every check below maps to one of those. Non-zero exit blocks the deploy; the
 * message names the file, the key, and expected vs actual.
 *
 * Plain Node, no dependencies. Usage:
 *   node scripts/validate-data.mjs                 # validate working tree
 *   node scripts/validate-data.mjs --base HEAD~1   # compare row counts to another ref
 *   node scripts/validate-data.mjs --no-git        # skip the row-count band check
 *   node scripts/validate-data.mjs --strict-history # treat history gaps as failures
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, join, posix } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagValue = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const BASE_REF = flagValue('--base', 'HEAD');
const USE_GIT = !hasFlag('--no-git');
const STRICT_HISTORY = hasFlag('--strict-history');

/* --------------------------------------------------------------------------
 * Tunables. Minimum sizes are deliberately far below the real file sizes —
 * they exist to catch "PLACEHOLDER" (11 B) and the entity-encoded stub (504 B),
 * not to police normal variation.
 * ----------------------------------------------------------------------- */
const MIN_BYTES = {
  'latest.json': 4000,
  'audit.json': 2000,
  'tasks.json': 1000,
  'fixes.json': 500,
  'goals.json': 200,
  'team.json': 100,
  'engagements.json': 100,
  'activity.json': 40,
  _default: 40,
};

/** Largest allowed shrink of any array, versus the previous committed version. */
const MAX_ROW_DROP = 0.5;

/** Arrays shorter than this in the base version are not band-checked. */
const MIN_TRACKED_ARRAY = 10;

/** Sections of latest.json that must carry a status, with the keys they own. */
const LATEST_SECTIONS = {
  clarity: {},
  github: {},
  cloudflare: {},
  gscByCountry: {},
  gscByPage: { rowsAt: 'rows' },
  gscByQuery: { rowsAt: 'rows' },
  gscCannibalization: { rowsAt: 'rows' },
  ga4ByCountry: {},
  ga4ByPage: { rowsAt: 'rows' },
  ga4AiTraffic: { rowsAt: 'rows' },
  opportunities: { rowsAt: 'rows' },
};

const VALID_STATUS = new Set(['ok', 'unavailable', 'partial', 'skipped']);

/**
 * A section marked "ok" must not be carrying a note that admits truncation.
 * This is the exact September failure: status "ok" + note "GitHub push capped at
 * top 30 of 500 rows". If the data was capped, the status is "partial", not "ok".
 */
const TRUNCATION_WORDS =
  /\b(capp?ed|truncat\w*|trimmed|top \d+ of \d+|row[_ -]?limit|size limit|partial|subset|not the full|shrunk)\b/i;

/* ------------------------------ reporting ------------------------------- */

const errors = [];
const warnings = [];
const fail = (file, key, msg) => errors.push(`${file}: ${key} — ${msg}`);
const warn = (file, key, msg) => warnings.push(`${file}: ${key} — ${msg}`);

/* ------------------------------ helpers --------------------------------- */

function listDataFiles() {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const relPath = rel ? posix.join(rel, name) : name;
      if (statSync(abs).isDirectory()) walk(abs, relPath);
      else if (name.endsWith('.json')) out.push({ abs, rel: relPath });
    }
  };
  walk(DATA_DIR, '');
  return out;
}

/** Previous committed content of data/<rel>, or null when unavailable. */
function committedVersion(rel) {
  if (!USE_GIT) return null;
  try {
    const raw = execFileSync('git', ['show', `${BASE_REF}:data/${rel}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } catch {
    return null; // new file, or the base ref does not parse — nothing to compare
  }
}

/** Collect every array in an object tree, keyed by dotted path. */
function arrayCounts(node, prefix = '', acc = {}) {
  if (Array.isArray(node)) {
    acc[prefix || '(root)'] = node.length;
    return acc;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      arrayCounts(v, prefix ? `${prefix}.${k}` : k, acc);
    }
  }
  return acc;
}

function requirePath(file, obj, path, predicate, expectation) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !(p in cur)) {
      fail(file, path, `expected ${expectation}, got <missing>`);
      return undefined;
    }
    cur = cur[p];
  }
  if (predicate && !predicate(cur)) {
    fail(file, path, `expected ${expectation}, got ${JSON.stringify(cur)?.slice(0, 80)}`);
    return undefined;
  }
  return cur;
}

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isArr = (v) => Array.isArray(v);

/* --------------------------- generic file checks ------------------------- */

/**
 * Returns the parsed document, or null when the file failed a check that makes
 * further inspection meaningless.
 */
function checkFileIntegrity(file, abs) {
  const bytes = statSync(abs).size;
  const raw = readFileSync(abs, 'utf8');
  const trimmed = raw.trim();
  const name = file.split('/').pop();
  const min = MIN_BYTES[name] ?? MIN_BYTES[file] ?? MIN_BYTES._default;

  if (trimmed.length === 0) {
    fail(file, '(whole file)', 'expected JSON, got an empty file');
    return null;
  }

  // Incident 1: the literal word PLACEHOLDER (or any non-JSON opening byte).
  if (!/^[[{]/.test(trimmed)) {
    fail(
      file,
      '(whole file)',
      `expected JSON starting with { or [, got ${JSON.stringify(trimmed.slice(0, 24))} ` +
        `(this is the 4b2cf2d "PLACEHOLDER" failure mode)`
    );
    return null;
  }

  // Incident 2: HTML-entity-encoded "JSON" (&quot; / &#10;) — parses as nothing.
  if (/&(quot|#10|#34|amp|lt|gt);/.test(trimmed.slice(0, 400))) {
    fail(
      file,
      '(whole file)',
      'expected raw JSON, got HTML-entity-encoded text (&quot;/&#10;) — this is the d7360a9 failure mode'
    );
    return null;
  }

  if (bytes < min) {
    fail(file, '(whole file)', `expected at least ${min} bytes, got ${bytes}`);
    return null;
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    fail(file, '(whole file)', `expected parseable JSON, got a parse error: ${e.message}`);
    return null;
  }

  if (doc === null || typeof doc !== 'object') {
    fail(file, '(whole file)', `expected an object or array, got ${typeof doc}`);
    return null;
  }
  return doc;
}

/* ------------------------ latest.json schema checks ---------------------- */

function checkLatest(file, doc) {
  requirePath(file, doc, 'site', (v) => typeof v === 'string' && v.length > 0, 'a non-empty site string');

  // --- updatedAt: must parse, must not be in the future -------------------
  const updatedAt = requirePath(file, doc, 'updatedAt', (v) => typeof v === 'string', 'an ISO-8601 string');
  if (typeof updatedAt === 'string') {
    const t = Date.parse(updatedAt);
    if (Number.isNaN(t)) {
      fail(file, 'updatedAt', `expected a parseable ISO-8601 timestamp, got ${JSON.stringify(updatedAt)}`);
    } else {
      const skewMs = 5 * 60 * 1000; // tolerate clock skew between the runner and us
      if (t > Date.now() + skewMs) {
        fail(
          file,
          'updatedAt',
          `expected a timestamp at or before now, got ${updatedAt} (${Math.round(
            (t - Date.now()) / 60000
          )} min in the future)`
        );
      }
      const ageHours = (Date.now() - t) / 3.6e6;
      if (ageHours > 48) {
        warn(file, 'updatedAt', `data is ${ageHours.toFixed(1)}h old — the daily refresh has not landed`);
      }
    }
  }

  // --- core sections the front page reads without a status gate -----------
  // Schema derived from the current file plus scripts/claude-scheduler-daily-refresh.txt:45-115.
  requirePath(file, doc, 'gsc.period.startDate', (v) => typeof v === 'string', 'a YYYY-MM-DD string');
  requirePath(file, doc, 'gsc.period.endDate', (v) => typeof v === 'string', 'a YYYY-MM-DD string');
  for (const k of ['clicks', 'impressions', 'ctr', 'position']) {
    requirePath(file, doc, `gsc.current.${k}`, isFiniteNum, 'a number');
    requirePath(file, doc, `gsc.prior.${k}`, isFiniteNum, 'a number');
  }
  for (const k of ['clicks', 'clicksPercent', 'impressions', 'impressionsPercent', 'ctr', 'position']) {
    requirePath(file, doc, `gsc.change.${k}`, (v) => v === null || isFiniteNum(v), 'a number or null');
  }
  requirePath(file, doc, 'gsc.quickWins', isArr, 'an array');

  for (const k of ['sessions', 'activeUsers', 'engagementRate', 'pageViews']) {
    requirePath(file, doc, `ga4.totals.${k}`, isFiniteNum, 'a number');
  }
  requirePath(file, doc, 'ga4.daily', isArr, 'an array');
  requirePath(file, doc, 'ga4.channels', isArr, 'an array');

  // --- every section carries a status, and "ok" means ok ------------------
  for (const [section, spec] of Object.entries(LATEST_SECTIONS)) {
    const node = doc[section];
    if (node === undefined) continue; // additive sections are genuinely optional
    if (node === null || typeof node !== 'object') {
      fail(file, section, `expected an object with a status, got ${JSON.stringify(node)?.slice(0, 60)}`);
      continue;
    }
    const status = node.status;
    if (typeof status !== 'string') {
      fail(file, `${section}.status`, `expected one of ${[...VALID_STATUS].join('/')}, got <missing>`);
      continue;
    }
    if (!VALID_STATUS.has(status)) {
      fail(file, `${section}.status`, `expected one of ${[...VALID_STATUS].join('/')}, got ${JSON.stringify(status)}`);
    }

    // The September failure: "ok" plus a note admitting the rows were capped.
    if (status === 'ok' && typeof node.note === 'string' && TRUNCATION_WORDS.test(node.note)) {
      fail(
        file,
        `${section}.status`,
        `expected "partial" (the note says the data was truncated), got "ok" — note: ${JSON.stringify(
          node.note.slice(0, 120)
        )}`
      );
    }

    if (status !== 'ok' && !node.note) {
      warn(file, `${section}.note`, `status is "${status}" with no note explaining why`);
    }

    if (spec.rowsAt) {
      const rows = node[spec.rowsAt];
      if (status === 'ok' && !Array.isArray(rows)) {
        fail(file, `${section}.${spec.rowsAt}`, `expected an array (status is "ok"), got ${typeof rows}`);
      }
      if (status === 'ok' && Array.isArray(rows) && rows.length === 0) {
        fail(file, `${section}.${spec.rowsAt}`, 'expected at least 1 row (status is "ok"), got 0');
      }
    }
  }
}

/* ----------------------- row-count band vs. previous --------------------- */

/**
 * A >50% drop in any array fails loudly rather than shipping. This is the check
 * that would have caught 2026-09-25: gscByQuery.rows 500 -> 30.
 */
function checkRowBand(file, doc) {
  const prev = committedVersion(file);
  if (!prev) return;
  const before = arrayCounts(prev);
  const after = arrayCounts(doc);
  for (const [path, prevLen] of Object.entries(before)) {
    // Small arrays (a roster, a handful of goals) change by hand for legitimate
    // reasons; the band check is aimed at refresh-produced row sets.
    if (prevLen < MIN_TRACKED_ARRAY) continue;
    const nowLen = after[path];
    if (nowLen === undefined) {
      fail(file, path, `expected an array (${prevLen} entries in ${BASE_REF}), got <missing>`);
      continue;
    }
    const floor = Math.ceil(prevLen * (1 - MAX_ROW_DROP));
    if (nowLen < floor) {
      const drop = (((prevLen - nowLen) / prevLen) * 100).toFixed(0);
      fail(
        file,
        path,
        `expected at least ${floor} entries (${(MAX_ROW_DROP * 100).toFixed(0)}% of the ${prevLen} in ${BASE_REF}), ` +
          `got ${nowLen} — a ${drop}% drop`
      );
    }
  }
}

/* ----------------------------- history index ----------------------------- */

/**
 * Each refresh makes three separate Contents API commits (latest.json, then
 * history/<date>.json, then history/index.json — verified 13:04:03/11/19 on
 * 2026-09-25). Dying between commit 1 and 3 leaves the index without that day,
 * and the trend charts silently lose it. 2026-09-20 is already missing.
 *
 * The index is derivable from the snapshot files, so we derive it and compare.
 * Run `node scripts/repair-history-index.mjs` to rewrite it from disk.
 */
function checkHistoryIndex() {
  const dir = join(DATA_DIR, 'history');
  if (!existsSync(dir)) return;
  const file = 'history/index.json';
  const indexPath = join(dir, 'index.json');

  const derived = readdirSync(dir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .map((n) => n.replace(/\.json$/, ''))
    .sort();

  if (!existsSync(indexPath)) {
    fail(file, 'dates', `expected an index listing ${derived.length} snapshots, got <missing file>`);
    return;
  }

  let idx;
  try {
    idx = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (e) {
    fail(file, '(whole file)', `expected parseable JSON, got a parse error: ${e.message}`);
    return;
  }

  const listed = Array.isArray(idx.dates) ? [...idx.dates].sort() : null;
  if (!listed) {
    fail(file, 'dates', 'expected an array of YYYY-MM-DD strings, got <missing>');
    return;
  }

  const missingFromIndex = derived.filter((d) => !listed.includes(d));
  const missingFromDisk = listed.filter((d) => !derived.includes(d));
  if (missingFromIndex.length) {
    fail(
      file,
      'dates',
      `expected every snapshot on disk to be listed; ${missingFromIndex.join(', ')} ` +
        `${missingFromIndex.length === 1 ? 'is' : 'are'} missing (run scripts/repair-history-index.mjs)`
    );
  }
  if (missingFromDisk.length) {
    fail(
      file,
      'dates',
      `expected every listed date to have a snapshot file; data/history/${missingFromDisk[0]}.json is missing ` +
        `(${missingFromDisk.length} total)`
    );
  }

  // Calendar gaps: a day that no snapshot exists for at all. This is a WARN by
  // default because 2026-09-20 is already lost and unrecoverable — failing on it
  // would block every deploy forever. --strict-history escalates it.
  const gaps = [];
  if (derived.length >= 2) {
    const first = Date.parse(derived[0] + 'T00:00:00Z');
    const last = Date.parse(derived[derived.length - 1] + 'T00:00:00Z');
    for (let t = first; t <= last; t += 86400000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (!derived.includes(d)) gaps.push(d);
    }
  }
  if (gaps.length) {
    const msg = `expected a snapshot for every day between ${derived[0]} and ${derived[derived.length - 1]}, ` +
      `missing ${gaps.join(', ')} — a refresh died between its history commits`;
    if (STRICT_HISTORY) fail(file, 'dates', msg);
    else warn(file, 'dates', msg);
  }
}

/* --------------------------------- main ---------------------------------- */

function main() {
  if (!existsSync(DATA_DIR)) {
    console.error('validate-data: data/ does not exist — nothing to validate, refusing to deploy.');
    process.exit(1);
  }

  const files = listDataFiles();
  if (files.length === 0) {
    console.error('validate-data: data/ contains no JSON files — refusing to deploy.');
    process.exit(1);
  }

  for (const { abs, rel } of files) {
    const doc = checkFileIntegrity(rel, abs);
    if (!doc) continue;
    if (rel === 'latest.json') checkLatest(rel, doc);
    checkRowBand(rel, doc);
  }

  checkHistoryIndex();

  for (const w of warnings) console.warn(`WARN  ${w}`);

  if (errors.length) {
    console.error('');
    console.error(`validate-data: ${errors.length} problem${errors.length === 1 ? '' : 's'} — deploy blocked.`);
    for (const e of errors) console.error(`FAIL  ${e}`);
    console.error('');
    console.error('Nothing was deployed. Fix the data (or the refresh that produced it) and re-run.');
    console.error('See scripts/validate-data.mjs for why each check exists.');
    process.exit(1);
  }

  console.log(
    `validate-data: OK — ${files.length} file${files.length === 1 ? '' : 's'} in data/ checked` +
      (warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : '') +
      (USE_GIT ? ` (row counts compared against ${BASE_REF})` : ' (row-count band check skipped)')
  );
}

main();
