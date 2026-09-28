#!/usr/bin/env node
/**
 * check-vendor-drift.mjs — fail the build when the vendored agent copy rots.
 *
 * Runs in CI, where the upstream repo is not checked out, so it cannot diff
 * against upstream. It checks the two things it can prove locally:
 *
 *   1. Nobody hand-edited SEO-agents-main/ — every file still hashes to what
 *      the manifest recorded when it was generated.
 *   2. The copy is not stale — it was vendored within MAX_AGE_DAYS.
 *
 * Both failures have already happened. The copy drifted 65 files and five
 * commits behind upstream, and the drift was invisible because nothing looked.
 * The specific damage: the house rules that stop agents inventing numbers
 * landed upstream, and the copy feeding this dashboard never got them.
 *
 *   node scripts/check-vendor-drift.mjs [--max-age-days N]
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEST = resolve(HERE, '..', 'SEO-agents-main');
const MANIFEST = join(DEST, '.vendor-manifest.json');

const argIdx = process.argv.indexOf('--max-age-days');
const MAX_AGE_DAYS = argIdx !== -1 ? Number(process.argv[argIdx + 1]) : 21;

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.pytest_cache', '.venv', 'venv']);

function walk(root, base = root, out = []) {
  for (const entry of readdirSync(root)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

const fail = (msg) => {
  console.error(`check-vendor-drift: ${msg}`);
  console.error('\nFix: run `node scripts/sync-agents.mjs` against a current checkout of');
  console.error('https://github.com/Rytsense-Technologies/SEO-agents and commit the result.');
  console.error('Never edit SEO-agents-main/ directly — it is generated, and a local edit');
  console.error('is lost on the next sync while silently diverging from the agents that run.');
  process.exit(1);
};

if (!existsSync(DEST)) fail('SEO-agents-main/ is missing entirely.');
if (!existsSync(MANIFEST)) fail('SEO-agents-main/.vendor-manifest.json is missing — the copy is unverifiable.');

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch (err) {
  fail(`the manifest is not valid JSON (${err.message}).`);
}

const actual = walk(DEST).filter((r) => r !== '.vendor-manifest.json');
const expected = Object.keys(manifest.files || {});

const missing = expected.filter((r) => !actual.includes(r));
const extra = actual.filter((r) => !expected.includes(r));
const changed = [];
for (const rel of expected) {
  if (missing.includes(rel)) continue;
  const buf = readFileSync(join(DEST, ...rel.split('/')));
  if (createHash('sha256').update(buf).digest('hex').slice(0, 16) !== manifest.files[rel]) changed.push(rel);
}

const problems = [];
if (missing.length) problems.push(`${missing.length} file(s) missing: ${missing.slice(0, 5).join(', ')}`);
if (extra.length) problems.push(`${extra.length} unexpected file(s): ${extra.slice(0, 5).join(', ')}`);
if (changed.length) problems.push(`${changed.length} file(s) edited in place: ${changed.slice(0, 5).join(', ')}`);
if (problems.length) fail(`the vendored copy does not match its manifest.\n  - ${problems.join('\n  - ')}`);

const ageDays = (Date.now() - Date.parse(manifest.vendoredAt)) / 86400000;
if (!Number.isFinite(ageDays)) fail(`the manifest has no usable vendoredAt (${manifest.vendoredAt}).`);
if (ageDays > MAX_AGE_DAYS) {
  fail(`the copy was vendored ${Math.round(ageDays)} days ago (limit ${MAX_AGE_DAYS}), from upstream `
    + `${String(manifest.upstreamCommit).slice(0, 8)}. It drifted 65 files last time nobody checked.`);
}

console.log(`check-vendor-drift: ${expected.length} files intact, vendored ${Math.round(ageDays)} day(s) ago `
  + `from ${String(manifest.upstreamCommit).slice(0, 8)} — OK`);
