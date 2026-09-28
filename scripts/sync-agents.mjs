#!/usr/bin/env node
/**
 * sync-agents.mjs — regenerate SEO-agents-main/ from the upstream toolkit.
 *
 * The dashboard vendors the SEO agent toolkit so the Bridge can read it. That
 * copy silently drifted 65 files and five commits behind upstream, and what it
 * was missing mattered: the house rules that require every agent finding to
 * carry evidence and a [measured]/[not checked] label. The copy WITHOUT the
 * anti-fabrication rules was the copy publishing to this dashboard.
 *
 * So the copy is generated, never edited here:
 *
 *   node scripts/sync-agents.mjs [--source <path-to-SEO-agents>] [--check]
 *
 * --check exits non-zero instead of writing, for CI.
 *
 * Client data never crosses: memory/ and output/ hold a real engagement and
 * .env holds an API key, so they are excluded by name rather than by .gitignore,
 * which does not travel between repos.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const DEST = join(REPO, 'SEO-agents-main');
const MANIFEST = join(DEST, '.vendor-manifest.json');

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.pytest_cache', '.ruff_cache',
  '.venv', 'venv', 'memory', 'output', '.cache', 'htmlcov', '.github',
]);
const SKIP_FILES = new Set(['.env', '.env.local']);
const SKIP_EXT = new Set(['.pyc', '.pyo', '.log']);
// Text we normalise to LF. CRLF in this copy previously made the agent
// frontmatter parser match nothing at all, so every check passed by doing
// nothing — the worst kind of green.
const TEXT_EXT = new Set(['.md', '.py', '.mjs', '.js', '.json', '.txt', '.toml', '.sh', '.ps1', '.yml', '.yaml']);

const args = process.argv.slice(2);
const check = args.includes('--check');
const sourceArg = args.indexOf('--source');
const SOURCE = resolve(
  sourceArg !== -1 ? args[sourceArg + 1] : process.env.SEO_AGENTS_PATH || join(REPO, '..', 'SEO-agents'),
);

function walk(root, base = root, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (SKIP_DIRS.has(entry)) continue;
    if (statSync(full).isDirectory()) walk(full, base, out);
    else {
      const rel = relative(base, full);
      const ext = entry.slice(entry.lastIndexOf('.'));
      if (!SKIP_FILES.has(entry) && !SKIP_EXT.has(ext)) out.push(rel);
    }
  }
  return out;
}

function read(path, rel) {
  const raw = readFileSync(path);
  const ext = rel.slice(rel.lastIndexOf('.'));
  return TEXT_EXT.has(ext) ? Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : raw;
}

const digest = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

if (!existsSync(SOURCE)) {
  console.error(`sync-agents: upstream toolkit not found at ${SOURCE}`);
  console.error('Pass --source <path>, or set SEO_AGENTS_PATH.');
  console.error('Clone it: git clone https://github.com/Rytsense-Technologies/SEO-agents');
  process.exit(2);
}

let upstreamCommit = 'unknown';
try {
  upstreamCommit = execFileSync('git', ['-C', SOURCE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  console.warn('sync-agents: upstream is not a git checkout — recording commit as "unknown"');
}

const incoming = walk(SOURCE);
const existing = walk(DEST).filter((r) => r !== '.vendor-manifest.json');
const files = {};
let written = 0;

for (const rel of incoming.sort()) {
  const buf = read(join(SOURCE, rel), rel);
  files[rel.split(sep).join('/')] = digest(buf);
  if (check) continue;
  const target = join(DEST, rel);
  mkdirSync(dirname(target), { recursive: true });
  const before = existsSync(target) ? readFileSync(target) : null;
  if (!before || !before.equals(buf)) {
    writeFileSync(target, buf);
    written += 1;
  }
}

const removed = existing.filter((r) => !incoming.includes(r));
if (!check) for (const rel of removed) rmSync(join(DEST, rel), { force: true });

if (check) {
  const current = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : null;
  const same = current && JSON.stringify(current.files) === JSON.stringify(files);
  if (!same) {
    console.error('sync-agents --check: the vendored copy does not match upstream.');
    console.error('Run: node scripts/sync-agents.mjs   and commit the result.');
    process.exit(1);
  }
  console.log(`sync-agents --check: vendored copy matches upstream (${Object.keys(files).length} files)`);
  process.exit(0);
}

writeFileSync(MANIFEST, `${JSON.stringify({
  upstreamRepo: 'https://github.com/Rytsense-Technologies/SEO-agents',
  upstreamCommit,
  vendoredAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  fileCount: Object.keys(files).length,
  generatedBy: 'scripts/sync-agents.mjs',
  why: 'Generated copy — edit upstream, then re-sync. scripts/check-vendor-drift.mjs guards it.',
  files,
}, null, 2)}\n`);

console.log(`sync-agents: ${Object.keys(files).length} files from ${upstreamCommit.slice(0, 8)}`);
console.log(`  ${written} written, ${removed.length} removed`);
for (const rel of removed.slice(0, 10)) console.log(`  - ${rel}`);
