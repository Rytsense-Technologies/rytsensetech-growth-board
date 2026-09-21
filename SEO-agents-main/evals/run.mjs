#!/usr/bin/env node
/**
 * run.mjs — evaluation harness for the SEO agent team.
 *
 * Three modes, cheapest first:
 *
 *   static     Validate all agent definitions without running anything.
 *              Frontmatter, tool grants, required sections, guardrail language,
 *              and cross-references. Runs in milliseconds; run it in CI.
 *
 *   fixture    Score a produced report against the planted defects in
 *              evals/fixtures/. Measures recall and catches fabrication.
 *
 *   score      Rubric-score any deliverable on the 5 axes in evals/rubric.md.
 *
 * The static mode is the one that catches real regressions — an agent whose
 * guardrail language was edited away, or which was granted Write when it should
 * be read-only.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const AGENT_DIR = '.claude/agents';
const CMD_DIR = '.claude/commands';
const FIXTURE = 'evals/fixtures/expected-findings.json';

const c = { r: s => `\x1b[31m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` };

// --------------------------------------------------------------- static evals

// Agents that must never be able to mutate anything. A read-only auditor that
// can edit its own evidence is not an auditor.
const READ_ONLY_AGENTS = ['seo-qa-auditor', 'seo-director', 'opportunity-validator', 'competitor-analyst', 'keyword-strategist', 'search-intent-analyst', 'topical-authority-strategist', 'seo-forecaster', 'experiment-designer', 'seo-project-manager'];

// Every agent must state where its output goes, or the orchestrator cannot
// chain it to the next wave.
const REQUIRE_OUTPUT_SECTION = true;

// Agents handling data must carry explicit anti-fabrication language.
const DATA_AGENTS = ['gsc-data-analyst', 'ga4-data-analyst', 'log-file-analyst', 'index-coverage-analyst', 'serp-landscape-analyst', 'seo-forecaster', 'backlink-auditor', 'keyword-strategist', 'opportunity-finder', 'opportunity-validator'];
const HONESTY_RE = /\b(never (invent|fabricat|estimat|report)|do not (invent|fabricat|simulat|estimat)|never simulate|without a source|mark(ed)? as (an )?(estimate|inference|unverified)|say so|state that|stop — do not|label(led)? it)\b/i;

// Agents that can act destructively must carry a safety block.
const DESTRUCTIVE_AGENTS = ['content-pruning-specialist', 'site-migration-specialist', 'backlink-auditor'];
const SAFETY_RE = /\b(never delete|rollback|safety rules?|do not prune|never bulk|kill criteria|do not recommend)\b/i;

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, body: text.slice(end + 4) };
}

function staticEval() {
  const files = readdirSync(AGENT_DIR).filter(f => f.endsWith('.md'));
  const names = new Set(files.map(f => basename(f, '.md')));
  const results = [];
  let fail = 0, warn = 0;

  for (const f of files) {
    const name = basename(f, '.md');
    const text = readFileSync(join(AGENT_DIR, f), 'utf8');
    const parsed = parseFrontmatter(text);
    const errs = [], warns = [];

    if (!parsed) { errs.push('no valid YAML frontmatter'); results.push({ name, errs, warns }); fail++; continue; }
    const { fm, body } = parsed;

    if (!fm.name) errs.push('frontmatter missing "name"');
    else if (fm.name !== name) errs.push(`name "${fm.name}" does not match filename "${name}"`);
    if (!fm.description) errs.push('frontmatter missing "description"');
    else if (fm.description.length < 60) warns.push(`description is only ${fm.description.length} chars — too thin for reliable auto-delegation`);
    if (!fm.tools) warns.push('no explicit tools grant — agent inherits everything');

    const tools = (fm.tools ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (READ_ONLY_AGENTS.includes(name)) {
      const mutating = tools.filter(t => ['Write', 'Edit', 'NotebookEdit'].includes(t));
      // Write is allowed for report output; Edit is not — it lets an agent alter
      // another agent's deliverable.
      if (mutating.includes('Edit')) errs.push(`${name} is designated read-only but is granted Edit`);
    }

    if (REQUIRE_OUTPUT_SECTION && !/##\s*Output/i.test(body)) errs.push('no "## Output" section — orchestrator cannot chain this agent');

    if (body.length < 800) warns.push(`body is only ${body.length} chars — likely too thin to steer behaviour`);

    if (DATA_AGENTS.includes(name) && !HONESTY_RE.test(body)) errs.push('data agent lacks explicit anti-fabrication language');

    // An agent instructed to run a shell tool but not granted Bash cannot do its
    // job. Caught live on 2026-09-17: serp-landscape-analyst was told to use
    // tools/serp.mjs with no Bash grant and had to fall back to WebSearch.
    const needsShell = /node tools\/[a-z-]+\.mjs/.test(body);
    const isReviewer = READ_ONLY_AGENTS.includes(name);
    if (needsShell && !tools.includes('Bash') && !isReviewer) {
      errs.push('body instructs running a tools/ script but Bash is not granted — the agent cannot execute it');
    }
    if (needsShell && isReviewer && !/do not have the Bash tool/i.test(body)) {
      warns.push('reviewer references shell tools it cannot run; relies on the protocol fallback');
    }
    if (DESTRUCTIVE_AGENTS.includes(name) && !SAFETY_RE.test(body)) errs.push('destructive-capable agent lacks a safety block');

    // Cross-references must resolve.
    for (const m of body.matchAll(/`([a-z][a-z0-9-]{4,})`/g)) {
      const ref = m[1];
      if (/-(specialist|engineer|analyst|strategist|auditor|writer|editor|architect|builder|monitor|researcher|copywriter|designer|forecaster|director|manager|optimizer)$/.test(ref) && !names.has(ref)) {
        errs.push(`references unknown agent "${ref}"`);
      }
    }

    results.push({ name, errs, warns });
    if (errs.length) fail++;
    if (warns.length) warn++;
  }

  // Retired tools must not linger in any agent body.
  const RETIRED = ['serp.mjs', 'board.mjs', 'memory.mjs'];
  for (const f of files) {
    const text = readFileSync(join(AGENT_DIR, f), 'utf8');
    for (const r of RETIRED) {
      if (text.includes(r)) {
        const rec = results.find(x => x.name === basename(f, '.md'));
        if (rec) rec.errs.push(`references retired tool ${r} — use the .py port`);
      }
    }
  }
  fail = results.filter(r => r.errs.length).length;

  // Commands must only reference agents that exist.
  const cmdErrs = [];
  if (existsSync(CMD_DIR)) {
    for (const f of readdirSync(CMD_DIR).filter(x => x.endsWith('.md'))) {
      const text = readFileSync(join(CMD_DIR, f), 'utf8');
      for (const m of text.matchAll(/`([a-z][a-z0-9-]{4,})`/g)) {
        const ref = m[1];
        if (/-(specialist|engineer|analyst|strategist|auditor|writer|editor|architect|builder|monitor|researcher|copywriter|designer|forecaster|director|manager|optimizer|recon)$/.test(ref) && !names.has(ref)) {
          cmdErrs.push(`${f}: unknown agent "${ref}"`);
        }
      }
    }
  }

  console.log(`\nSTATIC EVAL — ${files.length} agents\n${'='.repeat(60)}`);
  for (const r of results) {
    if (!r.errs.length && !r.warns.length) continue;
    console.log(`\n${r.errs.length ? c.r('FAIL') : c.y('WARN')}  ${r.name}`);
    for (const e of r.errs) console.log(`  ${c.r('x')} ${e}`);
    for (const w of r.warns) console.log(`  ${c.y('!')} ${w}`);
  }
  if (cmdErrs.length) { console.log(`\n${c.r('FAIL')}  commands`); for (const e of cmdErrs) console.log(`  ${c.r('x')} ${e}`); }

  const passed = files.length - fail;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed}/${files.length} agents pass · ${fail} failing · ${warn} with warnings · ${cmdErrs.length} command errors`);
  process.exit(fail + cmdErrs.length ? 1 : 0);
}

// -------------------------------------------------------------- fixture evals

function fixtureEval(reportPaths) {
  if (!existsSync(FIXTURE)) { console.error(`missing ${FIXTURE}`); process.exit(1); }
  const spec = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  const paths = reportPaths.length ? reportPaths
    : (existsSync('output') ? walk('output').filter(p => p.endsWith('.md')) : []);
  if (!paths.length) { console.error('no reports found. Run the team against evals/fixtures/site first, then re-run.'); process.exit(1); }

  const corpus = paths.map(p => readFileSync(p, 'utf8')).join('\n').toLowerCase();

  const found = [], missed = [];
  for (const d of spec.plantedDefects) {
    const hits = d.keywords.filter(k => corpus.includes(k.toLowerCase())).length;
    // Require at least two distinct keyword hits — one is too easy to match by
    // coincidence in a long report.
    (hits >= Math.min(2, d.keywords.length) ? found : missed).push({ ...d, hits });
  }

  const violations = [];
  for (const rule of spec.mustNotClaim) {
    const re = new RegExp(rule.pattern, 'gi');
    for (const p of paths) {
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(re)) {
        // Allow it if the sentence hedges or cites — same logic as guard.mjs.
        const i = m.index ?? 0;
        const ctx = text.slice(Math.max(0, i - 200), i + 200);
        if (/\b(est\.|estimate|inferred|unverified|assumption|hypothetical|example|illustrat|not available|no data|would be)\b/i.test(ctx)) continue;
        violations.push({ rule: rule.id, file: p, text: m[0], summary: rule.summary });
      }
    }
  }

  const recall = found.length / spec.plantedDefects.length;
  const critFound = found.filter(d => d.severity === 'CRITICAL').length;
  const critTotal = spec.plantedDefects.filter(d => d.severity === 'CRITICAL').length;
  const sevScore = critTotal ? critFound / critTotal : 1;
  const fabScore = violations.length ? 0 : 1;
  const w = spec.scoring;
  const score = recall * w.recallWeight + sevScore * w.severityWeight + fabScore * w.fabricationWeight;
  const pass = violations.length === 0 && score >= w.passThreshold;

  console.log(`\nFIXTURE EVAL — ${paths.length} report(s)\n${'='.repeat(60)}`);
  console.log(`\nFound ${found.length}/${spec.plantedDefects.length} planted defects (recall ${(recall * 100).toFixed(0)}%)`);
  console.log(`Critical defects found: ${critFound}/${critTotal}`);
  if (missed.length) {
    console.log(`\n${c.y('MISSED')}`);
    for (const m of missed) console.log(`  [${m.severity}] ${m.id} — ${m.summary}  ${c.d(`(expected from ${m.agent})`)}`);
  }
  if (violations.length) {
    console.log(`\n${c.r('FABRICATION VIOLATIONS — automatic fail')}`);
    for (const v of violations) console.log(`  ${v.file}: "${v.text}"  — ${v.summary}`);
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Score ${(score * 100).toFixed(0)}% (threshold ${(w.passThreshold * 100).toFixed(0)}%) — ${pass ? c.g('PASS') : c.r('FAIL')}`);
  if (!pass && !violations.length) console.log(c.d('Failed on recall. Check whether the missing agents ran at all.'));

  mkdirSync('evals/results', { recursive: true });
  writeFileSync('evals/results/fixture-latest.json', JSON.stringify({ at: new Date().toISOString(), score, recall, critFound, critTotal, found: found.map(f => f.id), missed: missed.map(m => m.id), violations }, null, 2));
  process.exit(pass ? 0 : 1);
}

function walk(d) {
  const out = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------- rubric

function scoreReport(path) {
  if (!existsSync(path)) { console.error(`missing ${path}`); process.exit(1); }
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');

  const checks = [
    { axis: 'Evidence', test: () => (text.match(/\b(per GSC|per GA4|Search Console|source:|measured|retrieved|fetched)\b/gi) ?? []).length, hint: 'claims tied to a named source' },
    { axis: 'Specificity', test: () => (text.match(/https?:\/\/\S+|`[^`]+`/g) ?? []).length, hint: 'concrete URLs, files, or code referenced' },
    { axis: 'Actionability', test: () => (text.match(/^\s*(\d+\.|[-*])\s+\S/gm) ?? []).length, hint: 'discrete actions listed' },
    { axis: 'Prioritization', test: () => (text.match(/\b(CRITICAL|HIGH|MEDIUM|LOW|priority|effort|impact)\b/g) ?? []).length, hint: 'severity or effort stated' },
    { axis: 'Honesty', test: () => (text.match(/\b(could not|unverified|estimate|inferred|unknown|assumption|limitation|blind spot)\b/gi) ?? []).length, hint: 'limits acknowledged' },
  ];

  console.log(`\nRUBRIC — ${path}  (${lines.length} lines)\n${'='.repeat(60)}`);
  let total = 0;
  for (const ch of checks) {
    const n = ch.test();
    const s = n === 0 ? 1 : n < 3 ? 2 : n < 8 ? 3 : n < 20 ? 4 : 5;
    total += s;
    console.log(`  ${ch.axis.padEnd(16)} ${'*'.repeat(s).padEnd(5)} ${s}/5  ${c.d(`${n} signals — ${ch.hint}`)}`);
  }
  const fab = (text.match(/\b\d{3,}\s*(searches|sessions|backlinks)\b/gi) ?? []).length;
  console.log(`\n  Overall ${(total / checks.length).toFixed(1)}/5`);
  if (fab) console.log(c.r(`  ${fab} possible unsourced figure(s) — run: node tools/guard.mjs lint ${path}`));
  console.log(c.d('\n  Heuristic only. It measures the shape of a good report, not whether the\n  analysis is correct. A human still reads the thing.'));
}

// --------------------------------------------------------------------- main

const mode = process.argv[2];
if (mode === 'static') staticEval();
else if (mode === 'fixture') fixtureEval(process.argv.slice(3));
else if (mode === 'score') scoreReport(process.argv[3]);
else {
  console.log(`usage:
  node evals/run.mjs static                 validate all agent definitions (fast, CI-safe)
  node evals/run.mjs fixture [reports…]     score output against planted fixture defects
  node evals/run.mjs score <file>           rubric-score one deliverable`);
  process.exit(mode ? 1 : 0);
}
