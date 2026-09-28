#!/usr/bin/env node
// Copies static dashboard + Intelligence Report into .cf-pages/ and deploys.
// Pages Functions live in /functions at repo root (picked up from cwd).
//
// Usage: npm run deploy:cf   (runs scripts/validate-data.mjs first — see package.json)
//
// AUTHORITATIVE DEPLOY PATH: .github/workflows/deploy-pages.yml, which deploys
// git HEAD. This script deploys the LOCAL WORKING TREE, which is a different
// source, so running both at once publishes whichever finishes last. Use this
// script only as the documented manual/emergency path (README → Deploying).

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

// Files the site cannot function without. This list used to be advisory: the
// loop warned and deployed anyway, so a missing data/latest.json produced a
// successful deploy of a dataless site and exit code 0 — the same silent
// failure class as the 4b2cf2d PLACEHOLDER push. Missing means stop.
const REQUIRED = new Set([
  'index.html',
  'report.html',
  'ops.html',
  'platform.html',
  'tasks.html',
  'data/latest.json',
]);

const missingRequired = [];
for (const [src, dest] of staticFiles) {
  const from = join(root, src);
  if (!existsSync(from)) {
    if (REQUIRED.has(src)) missingRequired.push(src);
    else console.warn('Skip missing optional file:', src);
    continue;
  }
  cpSync(from, join(out, dest));
}
if (missingRequired.length) {
  console.error('Refusing to deploy — required files are missing:');
  for (const f of missingRequired) console.error('  ' + f);
  process.exit(1);
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

// Pinned to the same major CI installs (deploy-pages.yml: `npm install wrangler@4`).
// Unpinned `npx --yes wrangler` resolved to whatever the registry served, so the
// two deploy paths could run different major versions of the deploy tool.
const WRANGLER = 'wrangler@4';

const result = spawnSync(
  'npx',
  [
    '--yes',
    WRANGLER,
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

const exitCode = result.status ?? 1;
recordDeploymentStatus(exitCode);
process.exit(exitCode);

/**
 * Write the deploy's REAL outcome into data/latest.json.
 *
 * WHY: cloudflare.deployment.status used to be *predicted* by the same Claude run
 * that performed the deploy (scripts/claude-scheduler-daily-refresh.txt:142,
 * 158-161 told it to write status "queued"/"ok" when the push succeeded). The one
 * tile that would reveal a failed deploy was therefore written before the deploy
 * happened, by the process that might fail — a failed deploy reported "ok".
 * Commit e42d622 is a human hand-correcting exactly that field.
 *
 * Now it comes from wrangler's exit code, after wrangler returns.
 *
 * Note the one-cycle lag this implies, and why it is still the honest option: the
 * deployment Cloudflare just made is immutable, so this status is published by the
 * NEXT deploy. The tile therefore shows the last deploy's observed result rather
 * than a guess about the current one. `observedAt` and `source` say so in the data.
 */
function recordDeploymentStatus(code) {
  const latestPath = join(root, 'data', 'latest.json');
  try {
    const doc = JSON.parse(readFileSync(latestPath, 'utf8'));
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    doc.cloudflare = doc.cloudflare || {};
    doc.cloudflare.deployment = {
      ...(doc.cloudflare.deployment || {}),
      status: code === 0 ? 'success' : 'failed',
      url: 'https://rytsensetech-growth-board.pages.dev',
      observedAt: now,
      // deployedAt is kept (index.html:749 renders it) but is now an observation:
      // the moment wrangler returned, not a time the refresh predicted in advance.
      deployedAt: now,
      source: 'wrangler-exit-code',
      exitCode: code,
      // Reminder for any consumer: this describes the PREVIOUS deploy, because
      // the deploy that published this file had already finished when it was written.
      describes: 'previous deploy',
    };
    if (code !== 0) {
      doc.cloudflare.deployment.note = `wrangler pages deploy exited ${code} — the site still serves the previous deployment.`;
    } else {
      delete doc.cloudflare.deployment.note;
    }
    writeFileSync(latestPath, JSON.stringify(doc, null, 2) + '\n');
    console.log(
      `Recorded observed deploy status "${doc.cloudflare.deployment.status}" (wrangler exit ${code}) in data/latest.json.`
    );
    if (code === 0) {
      console.log('Commit that change so the next deploy publishes the real status.');
    }
  } catch (e) {
    // Never let bookkeeping change the deploy's own outcome.
    console.warn('Could not record deploy status in data/latest.json:', e.message);
  }
}
