#!/usr/bin/env node
/**
 * repair-history-index.mjs — rebuild data/history/index.json from the snapshot
 * files that actually exist on disk.
 *
 * WHY: every refresh writes three separate GitHub Contents API commits
 * (data/latest.json, then data/history/<date>.json, then data/history/index.json
 * — verified at 13:04:03 / 13:04:11 / 13:04:19 on 2026-09-25). There is no
 * transaction. A run that dies after commit 1 or 2 leaves the index without that
 * day, and report.html / platform.html drive their trend charts off the index,
 * so the day silently vanishes from the series with no error. 2026-09-20 was
 * lost exactly this way and nothing flagged it.
 *
 * The index carries no information the filenames do not, so it is derivable.
 * That makes a partial run repairable instead of permanent:
 *
 *   node scripts/repair-history-index.mjs --check   # exit 1 if out of sync
 *   node scripts/repair-history-index.mjs           # rewrite it from disk
 *
 * scripts/validate-data.mjs runs the same comparison on every deploy, so an
 * index that drifts from the files blocks the deploy instead of degrading a chart.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_DIR = join(ROOT, 'data', 'history');
const INDEX_PATH = join(HISTORY_DIR, 'index.json');

/** Keep the same 90-day cap the refresh prompt specifies. */
const MAX_DAYS = 90;

const checkOnly = process.argv.includes('--check');

if (!existsSync(HISTORY_DIR)) {
  console.error(`repair-history-index: ${HISTORY_DIR} does not exist.`);
  process.exit(1);
}

const derived = readdirSync(HISTORY_DIR)
  .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
  .map((n) => n.replace(/\.json$/, ''))
  .sort()
  .slice(-MAX_DAYS);

let current = null;
if (existsSync(INDEX_PATH)) {
  try {
    current = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  } catch (e) {
    console.warn(`repair-history-index: existing index does not parse (${e.message}) — rebuilding.`);
  }
}

const listed = Array.isArray(current?.dates) ? [...current.dates].sort() : [];
const inSync = listed.length === derived.length && listed.every((d, i) => d === derived[i]);

if (inSync) {
  console.log(`repair-history-index: in sync — ${derived.length} snapshots listed.`);
  process.exit(0);
}

const missingFromIndex = derived.filter((d) => !listed.includes(d));
const missingFromDisk = listed.filter((d) => !derived.includes(d));

console.log(`repair-history-index: index lists ${listed.length} dates, disk holds ${derived.length}.`);
if (missingFromIndex.length) console.log(`  not listed but on disk : ${missingFromIndex.join(', ')}`);
if (missingFromDisk.length) console.log(`  listed but no snapshot : ${missingFromDisk.join(', ')}`);

if (checkOnly) {
  console.error('repair-history-index: out of sync (run without --check to rebuild).');
  process.exit(1);
}

// Keep updatedAt honest: it records when the index was last derived, and says so.
const next = {
  updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  dates: derived,
};
writeFileSync(INDEX_PATH, JSON.stringify(next, null, 2) + '\n');
console.log(`repair-history-index: rewrote data/history/index.json with ${derived.length} dates.`);
console.log('Note: a date with no snapshot file cannot be recovered here — that day was never written.');
