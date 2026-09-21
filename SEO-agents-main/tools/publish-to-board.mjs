#!/usr/bin/env node
/**
 * publish-to-board.mjs — bridge SEO-agents engagements → Growth Board
 *
 * Writes/merges into ../../data/engagements.json (repo relative from SEO-agents-main)
 * and optionally POSTs to the live Pages API so platform.html updates without redeploy.
 *
 * Usage:
 *   node tools/publish-to-board.mjs --file path/to/engagement.json
 *   node tools/publish-to-board.mjs --from-audit ../../data/audit.json
 *   node tools/publish-to-board.mjs --file eng.json --post
 *   node tools/publish-to-board.mjs --file eng.json --post --url https://rytsensetech-growth-board.pages.dev
 *
 * Env:
 *   BOARD_URL              default https://rytsensetech-growth-board.pages.dev
 *   BOARD_PUBLISH_TOKEN    optional; sent as X-Board-Token
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const agentsRoot = join(here, '..');
const boardRoot = resolve(agentsRoot, '..');
const engagementsPath = join(boardRoot, 'data', 'engagements.json');

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}
function has(flag) {
  return process.argv.includes(flag);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fromAudit(audit) {
  const critical = audit.criticalIssues || [];
  const high = audit.highIssues || [];
  const findings = [
    ...critical.map((c) => ({
      id: c.id,
      severity: 'critical',
      title: c.title,
      agent: 'seo-qa-auditor',
      url: null,
    })),
    ...high.map((h) => ({
      id: h.id,
      severity: 'high',
      title: h.title,
      agent: 'seo-director',
      url: null,
    })),
  ];
  const id = `eng-${(audit.auditedAt || 'unknown').replace(/[^0-9-]/g, '')}-audit`;
  return {
    id,
    domain: audit.site || 'rytsensetech.com',
    run: audit.auditedRange || audit.auditedAt || id,
    command: '/seo-360',
    startedAt: `${audit.auditedAt || '2026-09-17'}T00:00:00.000Z`,
    finishedAt: `${audit.auditedAt || '2026-09-18'}T00:00:00.000Z`,
    agentsUsed: ['seo-orchestrator', 'seo-director', 'seo-qa-auditor'],
    summary: (audit.verdict && audit.verdict.summary) || audit.title || '',
    verdict: {
      market: audit.verdict && audit.verdict.market,
      criticalCount:
        (audit.verdict && audit.verdict.criticalCount) ?? critical.length,
      highCount: (audit.verdict && audit.verdict.highCount) ?? high.length,
      easyWins: (audit.easyWins || []).length,
    },
    findings,
    deliverables: ['data/audit.json', 'report.html'],
    source: 'publish-tool',
  };
}

function mergeLocal(engagement) {
  mkdirSync(dirname(engagementsPath), { recursive: true });
  let store = { engagements: [] };
  if (existsSync(engagementsPath)) {
    try {
      store = loadJson(engagementsPath);
    } catch {
      store = { engagements: [] };
    }
  }
  const rest = (store.engagements || []).filter((e) => e.id !== engagement.id);
  store.engagements = [engagement, ...rest].slice(0, 40);
  store.updatedAt = new Date().toISOString();
  writeFileSync(engagementsPath, JSON.stringify(store, null, 2) + '\n');
  return engagementsPath;
}

async function postRemote(engagement, baseUrl) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/engagements`;
  const headers = { 'Content-Type': 'application/json' };
  const token = process.env.BOARD_PUBLISH_TOKEN;
  if (token) headers['X-Board-Token'] = token;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(engagement),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`POST ${url} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return body;
}

async function main() {
  let engagement = null;

  if (has('--from-audit')) {
    const path = resolve(arg('--from-audit', join(boardRoot, 'data', 'audit.json')));
    engagement = fromAudit(loadJson(path));
  } else if (has('--file')) {
    engagement = loadJson(resolve(arg('--file')));
  } else {
    console.error(`Usage:
  node tools/publish-to-board.mjs --file engagement.json [--post]
  node tools/publish-to-board.mjs --from-audit ../../data/audit.json [--post]
`);
    process.exit(1);
  }

  if (!engagement.id) {
    engagement.id = `eng-${Date.now().toString(36)}`;
  }
  engagement.publishedAt = new Date().toISOString();
  engagement.source = engagement.source || 'publish-tool';

  const path = mergeLocal(engagement);
  console.log('Wrote', path);
  console.log('Engagement', engagement.id, '—', (engagement.findings || []).length, 'findings');

  if (has('--post')) {
    const base =
      arg('--url') ||
      process.env.BOARD_URL ||
      'https://rytsensetech-growth-board.pages.dev';
    const result = await postRemote(engagement, base);
    console.log('Posted to', base, '→', result.ok ? 'ok' : JSON.stringify(result));
  } else {
    console.log('Tip: add --post to push live without waiting for deploy.');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
