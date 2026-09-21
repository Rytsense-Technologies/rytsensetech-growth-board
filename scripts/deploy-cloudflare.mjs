#!/usr/bin/env node
// Copies static dashboard + Intelligence Report into .cf-pages/ and deploys.
// Pages Functions live in /functions at repo root (picked up from cwd).
// Usage: npm run deploy:cf

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.cf-pages');
const tokenFile = join(root, 'secrets', 'cloudflare-api-token.txt');

function loadToken() {
  if (process.env.CLOUDFLARE_API_TOKEN?.trim()) {
    return process.env.CLOUDFLARE_API_TOKEN.trim();
  }
  if (existsSync(tokenFile)) {
    const t = readFileSync(tokenFile, 'utf8').trim();
    if (t) return t;
  }
  return null;
}

const token = loadToken();
if (token) {
  process.env.CLOUDFLARE_API_TOKEN = token;
  console.log('Using CLOUDFLARE_API_TOKEN (env or secrets/cloudflare-api-token.txt).');
} else {
  console.log(
    'No CLOUDFLARE_API_TOKEN found — falling back to wrangler OAuth login (may fail in unattended runs).'
  );
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'data'), { recursive: true });

const staticFiles = [
  ['index.html', 'index.html'],
  ['report.html', 'report.html'],
  ['ops.html', 'ops.html'],
  ['platform.html', 'platform.html'],
  ['tasks.html', 'tasks.html'],
  ['assets/rts-report.css', 'assets/rts-report.css'],
  ['assets/site-nav.css', 'assets/site-nav.css'],
  ['assets/site-nav.js', 'assets/site-nav.js'],
  ['data/latest.json', 'data/latest.json'],
  ['data/audit.json', 'data/audit.json'],
  ['data/fixes.json', 'data/fixes.json'],
  ['data/activity.json', 'data/activity.json'],
  ['data/goals.json', 'data/goals.json'],
  ['data/engagements.json', 'data/engagements.json'],
  ['data/tasks.json', 'data/tasks.json'],
  ['data/team.json', 'data/team.json'],
];

// Ensure assets/ exists in staging when CSS is present
mkdirSync(join(out, 'assets'), { recursive: true });

// Optional history snapshots (Phase 2) — copy if present
const historyDir = join(root, 'data', 'history');
if (existsSync(historyDir)) {
  mkdirSync(join(out, 'data', 'history'), { recursive: true });
  // copy only recent files is fine; deploy script copies whole folder lightly via recursive
  cpSync(historyDir, join(out, 'data', 'history'), { recursive: true });
}

for (const [src, dest] of staticFiles) {
  const from = join(root, src);
  if (!existsSync(from)) {
    console.warn('Skip missing file:', src);
    continue;
  }
  cpSync(from, join(out, dest));
}

writeFileSync(
  join(out, '_headers'),
  `/*
  Cache-Control: public, max-age=60
/data/*
  Cache-Control: public, max-age=60, must-revalidate
/api/*
  Cache-Control: no-store
`
);

console.log('Staging static files in .cf-pages/ …');
console.log('Pages Functions: functions/ (repo root) — Fixes API at /api/fixes');

const result = spawnSync(
  'npx',
  [
    '--yes',
    'wrangler',
    'pages',
    'deploy',
    out,
    '--project-name=rytsensetech-growth-board',
    '--commit-dirty=true',
  ],
  {
    stdio: 'inherit',
    shell: true,
    cwd: root,
    env: process.env,
  }
);
process.exit(result.status ?? 1);
