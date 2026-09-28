#!/usr/bin/env node
/**
 * run.mjs — evaluation harness for the SEO agent team.
 *
 * Four modes, cheapest first:
 *
 *   static     Validate all agent definitions without running anything.
 *              Frontmatter, tool grants, required sections, guardrail language,
 *              and cross-references. Runs in milliseconds; run it in CI.
 *
 *   fixture    Score a report produced against evals/fixtures/site against the
 *              defects planted there. Measures recall and catches fabrication.
 *
 *   golden     THE accuracy eval. Grades what agents claimed about a real client
 *              site against a LIVE re-measurement of that site. See
 *              evals/golden/README.md.
 *
 *   score      Rubric-score any deliverable on the 5 axes in evals/rubric.md.
 *
 * `static` catches regressions in the agent definitions. `golden` is the only
 * mode that measures whether the analysis was CORRECT — which is the thing the
 * team is actually paid for, and which nothing measured until 2026-09-25.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
import { PROBES } from './golden/probes.mjs';
import { extractClaim, grade, checkMustNotClaim } from './golden/grade.mjs';

const AGENT_DIR = '.claude/agents';
const CMD_DIR = '.claude/commands';
const FIXTURE = 'evals/fixtures/expected-findings.json';
const GOLDEN_DIR = 'evals/golden';

const c = { r: s => `\x1b[31m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[36m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` };

// --------------------------------------------------------------- static evals

// Agents that must never be able to mutate anything. A read-only auditor that
// can edit its own evidence is not an auditor.
const READ_ONLY_AGENTS = ['seo-qa-auditor', 'seo-director', 'opportunity-validator', 'competitor-analyst', 'keyword-strategist', 'search-intent-analyst', 'topical-authority-strategist', 'seo-forecaster', 'experiment-designer', 'seo-project-manager'];

// Agents handling data must carry explicit anti-fabrication language.
const DATA_AGENTS = ['gsc-data-analyst', 'ga4-data-analyst', 'log-file-analyst', 'index-coverage-analyst', 'serp-landscape-analyst', 'seo-forecaster', 'backlink-auditor', 'keyword-strategist', 'opportunity-finder', 'opportunity-validator'];
const HONESTY_RE = /\b(never (invent|fabricat|estimat|report)|do not (invent|fabricat|simulat|estimat)|never simulate|without a source|mark(ed)? as (an )?(estimate|inference|unverified)|say so|state that|stop — do not|label(led)? it)\b/i;

// Agents that can act destructively must carry a safety block.
const DESTRUCTIVE_AGENTS = ['content-pruning-specialist', 'site-migration-specialist', 'backlink-auditor'];
const SAFETY_RE = /\b(never delete|rollback|safety rules?|do not prune|never bulk|kill criteria|do not recommend)\b/i;

// Tool scripts that were ported to Python. An agent still told to run the Node
// version will fail at the shell.
const RETIRED_TOOLS = ['serp.mjs', 'board.mjs', 'memory.mjs'];

const AGENT_NAME_SUFFIX = /-(specialist|engineer|analyst|strategist|auditor|writer|editor|architect|builder|monitor|researcher|copywriter|designer|forecaster|director|manager|optimizer)$/;

/**
 * The house rules, as a table.
 *
 * A second agent is auditing the 52 agent files as this is written; whatever it
 * concludes lands here as one more row rather than as another branch buried in
 * a 100-line loop. Each rule gets { id, level, check } where `check` returns a
 * message string when the rule is violated and a falsy value when it holds.
 *
 * `level` is 'error' (fails the run) or 'warn' (reported, exit 0).
 */
const STATIC_RULES = [
  {
    id: 'frontmatter-name-matches-file',
    level: 'error',
    check: ({ fm, name }) => {
      if (!fm.name) return 'frontmatter missing "name"';
      if (fm.name !== name) return `name "${fm.name}" does not match filename "${name}"`;
    },
  },
  {
    id: 'frontmatter-has-description',
    level: 'error',
    check: ({ fm }) => (!fm.description ? 'frontmatter missing "description"' : null),
  },
  {
    id: 'description-thick-enough',
    level: 'warn',
    check: ({ fm }) =>
      fm.description && fm.description.length < 60
        ? `description is only ${fm.description.length} chars — too thin for reliable auto-delegation`
        : null,
  },
  {
    id: 'explicit-tools-grant',
    level: 'warn',
    check: ({ fm }) => (!fm.tools ? 'no explicit tools grant — agent inherits everything' : null),
  },
  {
    id: 'read-only-agents-have-no-edit',
    level: 'error',
    // Write is allowed for report output; Edit is not — it lets an agent alter
    // another agent's deliverable.
    check: ({ name, tools }) =>
      READ_ONLY_AGENTS.includes(name) && tools.includes('Edit')
        ? `${name} is designated read-only but is granted Edit`
        : null,
  },
  {
    id: 'has-output-section',
    level: 'error',
    check: ({ body }) => (!/##\s*Output/i.test(body) ? 'no "## Output" section — orchestrator cannot chain this agent' : null),
  },
  {
    id: 'body-thick-enough',
    level: 'warn',
    check: ({ body }) => (body.length < 800 ? `body is only ${body.length} chars — likely too thin to steer behaviour` : null),
  },
  {
    id: 'data-agents-carry-anti-fabrication-language',
    level: 'error',
    check: ({ name, body }) =>
      DATA_AGENTS.includes(name) && !HONESTY_RE.test(body) ? 'data agent lacks explicit anti-fabrication language' : null,
  },
  {
    id: 'shell-instructions-need-bash',
    level: 'error',
    // Caught live on 2026-09-17: serp-landscape-analyst was told to use
    // tools/serp.mjs with no Bash grant and had to fall back to WebSearch.
    // Widened 2026-09-25 to cover `python tools/*.py` — the audit found the
    // .mjs-only regex stopped checking anything the moment the tools were
    // ported, so the rule silently went green (§4.1 item 9).
    check: ({ name, body, tools }) => {
      const needsShell = /(node\s+tools\/[a-z-]+\.mjs|python3?\s+tools\/[a-z_]+\.py)/.test(body);
      if (!needsShell || READ_ONLY_AGENTS.includes(name)) return null;
      return tools.includes('Bash') ? null : 'body instructs running a tools/ script but Bash is not granted — the agent cannot execute it';
    },
  },
  {
    id: 'reviewers-acknowledge-no-shell',
    level: 'warn',
    check: ({ name, body }) => {
      const needsShell = /(node\s+tools\/[a-z-]+\.mjs|python3?\s+tools\/[a-z_]+\.py)/.test(body);
      return needsShell && READ_ONLY_AGENTS.includes(name) && !/do not have the Bash tool/i.test(body)
        ? 'reviewer references shell tools it cannot run; relies on the protocol fallback'
        : null;
    },
  },
  {
    id: 'destructive-agents-carry-safety-block',
    level: 'error',
    check: ({ name, body }) =>
      DESTRUCTIVE_AGENTS.includes(name) && !SAFETY_RE.test(body) ? 'destructive-capable agent lacks a safety block' : null,
  },
  {
    id: 'agent-cross-references-resolve',
    level: 'error',
    check: ({ body, names }) => {
      const bad = [];
      for (const m of body.matchAll(/`([a-z][a-z0-9-]{4,})`/g)) {
        if (AGENT_NAME_SUFFIX.test(m[1]) && !names.has(m[1])) bad.push(m[1]);
      }
      return bad.length ? `references unknown agent(s): ${[...new Set(bad)].join(', ')}` : null;
    },
  },
  {
    id: 'no-retired-tool-names',
    level: 'error',
    check: ({ text }) => {
      const hits = RETIRED_TOOLS.filter((r) => text.includes(r));
      return hits.length ? `references retired tool(s) ${hits.join(', ')} — use the .py port` : null;
    },
  },
];

function parseFrontmatter(text) {
  // Normalise CRLF first. Found 2026-09-25: 20 of the 52 agent files had been
  // rewritten with CRLF, and `(.*)$` never matches a line ending in \r because
  // JS treats \r as a line terminator and `$` (no /m) only matches end-of-input.
  // Every frontmatter key parsed as absent and the whole suite reported "missing
  // name" — a checker that fails open on a line-ending change is worse than no
  // checker, since it fails LOUDLY on the wrong thing and hides the real rules.
  text = text.replace(/\r\n?/g, '\n');
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
  const files = readdirSync(AGENT_DIR).filter((f) => f.endsWith('.md'));
  const names = new Set(files.map((f) => basename(f, '.md')));
  const results = [];

  for (const f of files) {
    const name = basename(f, '.md');
    const text = readFileSync(join(AGENT_DIR, f), 'utf8');
    const parsed = parseFrontmatter(text);
    if (!parsed) { results.push({ name, errs: ['no valid YAML frontmatter'], warns: [] }); continue; }

    const ctx = {
      name, text, names,
      fm: parsed.fm,
      body: parsed.body,
      tools: (parsed.fm.tools ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    };

    const errs = [], warns = [];
    for (const rule of STATIC_RULES) {
      const msg = rule.check(ctx);
      if (msg) (rule.level === 'error' ? errs : warns).push(`[${rule.id}] ${msg}`);
    }
    results.push({ name, errs, warns });
  }

  // Commands must only reference agents that exist.
  const cmdErrs = [];
  if (existsSync(CMD_DIR)) {
    for (const f of readdirSync(CMD_DIR).filter((x) => x.endsWith('.md'))) {
      const text = readFileSync(join(CMD_DIR, f), 'utf8');
      for (const m of text.matchAll(/`([a-z][a-z0-9-]{4,})`/g)) {
        const ref = m[1];
        if ((AGENT_NAME_SUFFIX.test(ref) || ref.endsWith('-recon')) && !names.has(ref)) cmdErrs.push(`${f}: unknown agent "${ref}"`);
      }
    }
  }

  const fail = results.filter((r) => r.errs.length).length;
  const warn = results.filter((r) => r.warns.length).length;

  console.log(`\nSTATIC EVAL — ${files.length} agents, ${STATIC_RULES.length} rules\n${'='.repeat(60)}`);
  for (const r of results) {
    if (!r.errs.length && !r.warns.length) continue;
    console.log(`\n${r.errs.length ? c.r('FAIL') : c.y('WARN')}  ${r.name}`);
    for (const e of r.errs) console.log(`  ${c.r('x')} ${e}`);
    for (const w of r.warns) console.log(`  ${c.y('!')} ${w}`);
  }
  if (cmdErrs.length) { console.log(`\n${c.r('FAIL')}  commands`); for (const e of cmdErrs) console.log(`  ${c.r('x')} ${e}`); }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${files.length - fail}/${files.length} agents pass · ${fail} failing · ${warn} with warnings · ${cmdErrs.length} command errors`);
  process.exit(fail + cmdErrs.length ? 1 : 0);
}

// -------------------------------------------------------------- fixture evals

/**
 * Split a report into claim blocks — one per heading section or bullet. The old
 * harness concatenated and lowercased every report into one 150 KB blob and
 * called a defect "found" on two keyword hits ANYWHERE in it, which is how
 * `node evals/run.mjs fixture` reported 94% recall against a fixture site that
 * had never been audited (audit §4.2). "sitemap" and "404" co-occur in any long
 * SEO document. Evidence has to sit next to the claim or it is not evidence.
 */
function claimBlocks(text) {
  const blocks = [];
  let heading = '';
  let buf = [];
  const flush = () => { if (buf.join(' ').trim()) blocks.push(`${heading}\n${buf.join('\n')}`); buf = []; };
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line)) { flush(); heading = line; continue; }
    if (/^\s*([-*]|\d+\.)\s/.test(line)) { flush(); buf.push(line); continue; }
    if (!line.trim()) { flush(); continue; }
    buf.push(line);
  }
  flush();
  return blocks;
}

function fixtureEval(argv) {
  if (!existsSync(FIXTURE)) { console.error(`missing ${FIXTURE}`); process.exit(1); }
  const spec = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const reportPaths = argv.filter((a) => !a.startsWith('--'));

  // The single most important change in this file. `fixture` used to default to
  // walking output/ — the REAL rytsensetech.com deliverables — and score them
  // against a planted-defect spec for a site nobody had ever audited. It printed
  // "94% recall" and a fabrication violation against a correctly sourced ranking
  // statement, because the fixture's own rule text says "no rank data exists for
  // this fixture". A number that looks like a strong pass and measures nothing
  // is worse than no number (audit §4.2).
  if (!reportPaths.length) {
    console.error(`${c.r('fixture mode needs an explicit report path.')}

It no longer defaults to output/. output/ holds the real client deliverables,
and scoring those against ${basename(FIXTURE)} produced a meaningless 94% recall
plus false fabrication flags on correctly sourced figures (audit §4.2).

  1. run the team against evals/fixtures/site
  2. write its reports under ${spec.corpusRoot ?? 'output/fixture.example'}/
  3. node evals/run.mjs fixture ${spec.corpusRoot ?? 'output/fixture.example'}/*.md`);
    process.exit(1);
  }

  // And refuse to score anything outside the fixture corpus even when it is
  // named explicitly — a stray glob is exactly how this happened the first time.
  const corpusRoot = resolve(spec.corpusRoot ?? 'output/fixture.example');
  const strays = reportPaths.filter((p) => !resolve(p).startsWith(corpusRoot + sep) && resolve(p) !== corpusRoot);
  if (strays.length && !argv.includes('--allow-outside-corpus')) {
    console.error(`${c.r('refusing to score real client output as fixture output.')}

These paths are outside the fixture corpus (${spec.corpusRoot ?? 'output/fixture.example'}):
${strays.map((p) => `  ${p}`).join('\n')}

The planted defects in ${basename(FIXTURE)} describe evals/fixtures/site, not a
client site. Scoring a client report against them measures nothing. If you really
mean it, pass --allow-outside-corpus and know that the score is not a score.`);
    process.exit(1);
  }

  const missingFiles = reportPaths.filter((p) => !existsSync(p));
  if (missingFiles.length) { console.error(`missing report(s): ${missingFiles.join(', ')}`); process.exit(1); }

  // Per-report, per-block matching. A defect counts as found when one block of
  // one report carries >= 2 of its keywords AND names the file the defect lives
  // in — the claim and its evidence in the same breath.
  const requireFile = spec.scoring?.requireFileMention !== false;
  const found = [], missed = [];
  for (const d of spec.plantedDefects) {
    let hit = null;
    for (const p of reportPaths) {
      for (const block of claimBlocks(readFileSync(p, 'utf8'))) {
        const lower = block.toLowerCase();
        const hits = d.keywords.filter((k) => lower.includes(k.toLowerCase()));
        if (hits.length < Math.min(2, d.keywords.length)) continue;
        if (requireFile && d.file && !lower.includes(d.file.toLowerCase())) continue;
        hit = { file: p, hits, block: block.replace(/\s+/g, ' ').slice(0, 140) };
        break;
      }
      if (hit) break;
    }
    (hit ? found : missed).push({ ...d, evidence: hit });
  }

  const violations = checkMustNotClaim(reportPaths, spec.mustNotClaim.map((r) => ({
    ...r,
    why: r.summary,
    allowNear: r.allowNear ?? '\\b(est\\.|estimate|inferred|unverified|assumption|hypothetical|example|illustrat|not available|no data|would be)\\b',
  })));

  const recall = found.length / spec.plantedDefects.length;
  const critFound = found.filter((d) => d.severity === 'CRITICAL').length;
  const critTotal = spec.plantedDefects.filter((d) => d.severity === 'CRITICAL').length;
  const sevScore = critTotal ? critFound / critTotal : 1;
  const w = spec.scoring;
  const score = recall * w.recallWeight + sevScore * w.severityWeight + (violations.length ? 0 : 1) * w.fabricationWeight;
  const pass = violations.length === 0 && score >= w.passThreshold;

  console.log(`\nFIXTURE EVAL — ${reportPaths.length} report(s) from ${spec.corpusRoot ?? 'output/fixture.example'}\n${'='.repeat(60)}`);
  console.log(`\nFound ${found.length}/${spec.plantedDefects.length} planted defects (recall ${(recall * 100).toFixed(0)}%)`);
  console.log(`Critical defects found: ${critFound}/${critTotal}`);
  if (missed.length) {
    console.log(`\n${c.y('MISSED')}`);
    for (const m of missed) console.log(`  [${m.severity}] ${m.id} — ${m.summary}  ${c.d(`(expected from ${m.agent})`)}`);
  }
  if (violations.length) {
    console.log(`\n${c.r('FABRICATION VIOLATIONS — automatic fail')}`);
    for (const v of violations) console.log(`  ${v.file}: "${v.text}"  — ${v.why}`);
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Score ${(score * 100).toFixed(0)}% (threshold ${(w.passThreshold * 100).toFixed(0)}%) — ${pass ? c.g('PASS') : c.r('FAIL')}`);

  mkdirSync('evals/results', { recursive: true });
  writeFileSync('evals/results/fixture-latest.json', JSON.stringify({ at: new Date().toISOString(), corpus: reportPaths, score, recall, critFound, critTotal, found: found.map((f) => f.id), missed: missed.map((m) => m.id), violations }, null, 2));
  process.exit(pass ? 0 : 1);
}

// ----------------------------------------------------------------- golden set

const COST_TIERS = {
  cheap: () => true,
  deep: (o) => o.deep,
  serp: () => true,          // reads the cached batch — no credits
  'serp-live': (o) => o.live, // re-measures; burns credits
};

async function goldenEval(argv) {
  const opts = {
    live: argv.includes('--live'),
    deep: argv.includes('--deep'),
    only: argv.find((a) => a.startsWith('--only='))?.slice(7),
  };
  const positional = argv.filter((a) => !a.startsWith('--'));
  const domain = positional[0] ?? 'rytsensetech.com';
  const specPath = join(GOLDEN_DIR, `${domain}.json`);
  if (!existsSync(specPath)) {
    console.error(`no golden set for "${domain}". Expected ${specPath}.\nSee ${GOLDEN_DIR}/README.md to create one.`);
    process.exit(1);
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));

  const reportPaths = positional.slice(1).length
    ? positional.slice(1)
    : (spec.reportGlobs ?? ['output/**/*.md']).flatMap((g) => walk(g.split('/**')[0])).filter((p) => p.endsWith('.md'));
  if (!reportPaths.length) { console.error('no reports to grade. Pass report paths explicitly.'); process.exit(1); }

  const today = new Date().toISOString().slice(0, 10);
  const results = [];

  for (const a of spec.assertions) {
    if (opts.only && !a.id.includes(opts.only)) continue;
    const assertion = { ...a, domain };
    const tier = COST_TIERS[a.cost ?? 'cheap'];

    if (!tier(opts)) {
      results.push({ a: assertion, outcome: 'SKIPPED', why: `cost tier "${a.cost}" — pass ${a.cost === 'deep' ? '--deep' : '--live'} to run it` });
      continue;
    }

    const probeFn = PROBES[a.verify?.kind];
    if (!probeFn) {
      results.push({ a: assertion, outcome: 'UNMEASURED', why: `no probe registered for kind "${a.verify?.kind}"` });
      continue;
    }

    let probe;
    try {
      probe = await probeFn({ ...a.verify, file: a.verify.file ?? spec.serpBatch });
    } catch (e) {
      // A thrown probe is a harness bug or a transport failure. Either way it is
      // UNMEASURED. Swallowing it into a pass is the failure mode this whole
      // file exists to prevent.
      probe = { value: null, measured: false, note: `probe threw: ${e.message}` };
    }

    const claim = extractClaim(reportPaths, assertion);
    const g = grade(assertion, probe, claim);
    g.expired = a.staleAfter && today > a.staleAfter;
    results.push({ a: assertion, ...g });
  }

  const violations = checkMustNotClaim(reportPaths, spec.mustNotClaim);

  // ---------------------------------------------------------------- reporting
  const tally = { PASS: 0, FAIL: 0, DRIFT: 0, UNMEASURED: 0, SKIPPED: 0 };
  const paint = { PASS: c.g, FAIL: c.r, DRIFT: c.y, UNMEASURED: c.b, SKIPPED: c.d };

  console.log(`\nGOLDEN EVAL — ${domain}  (${results.length} assertions, ${reportPaths.length} reports)`);
  console.log(`${'='.repeat(72)}`);
  console.log(c.d(`baselined ${spec.baselinedAt} · live probe is the authority, the stored value is a tripwire`));
  console.log(c.d(`flags: --deep (full-tree crawls) --live (re-measure SERPs, burns credits) --only=<id>`));

  for (const r of results) {
    tally[r.outcome]++;
    const tag = paint[r.outcome](r.outcome.padEnd(10));
    const vol = r.a.volatility ? c.d(`[${r.a.volatility[0].toUpperCase()}]`) : '';
    console.log(`\n${tag} ${r.a.id} ${vol}`);
    if (r.why) console.log(`  ${r.why}`);
    if (r.outcome === 'PASS') console.log(c.d(`  live=${fmtv(r.live)} · report agrees`));
    if (r.evidence) console.log(c.d(`  report: ${r.evidence.file} — …${r.evidence.context.slice(40, 160)}…`));
    if (r.probeNote) console.log(c.d(`  probe: ${r.probeNote}`));
    if (r.rebaseline) console.log(`  ${c.y('rebaseline:')} ${r.rebaseline}`);
    if (r.expired) console.log(`  ${c.y(`EXPIRED — staleAfter ${r.a.staleAfter} has passed; re-verify and re-baseline`)}`);
  }

  if (violations.length) {
    console.log(`\n${c.r('RETIRED FIGURES REAPPEARED — automatic fail')}`);
    for (const v of violations) {
      console.log(`  ${c.r('x')} [${v.rule}] ${v.file}: "${v.text}"`);
      console.log(c.d(`      ${v.why}`));
      console.log(c.d(`      …${v.context}…`));
    }
  }

  const drifted = results.filter((r) => r.outcome === 'DRIFT');
  if (drifted.length) {
    console.log(`\n${c.y('REBASELINE — run these so the correction lands in the store agents read:')}`);
    for (const r of drifted) console.log(`  ${r.rebaseline}`);
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(
    `${c.g(`${tally.PASS} PASS`)} · ${c.r(`${tally.FAIL} FAIL`)} · ${c.y(`${tally.DRIFT} DRIFT`)} · ` +
    `${c.b(`${tally.UNMEASURED} UNMEASURED`)} · ${c.d(`${tally.SKIPPED} SKIPPED`)} · ${violations.length ? c.r(`${violations.length} retired-figure violation(s)`) : '0 retired-figure violations'}`
  );
  console.log(c.d('DRIFT = the site changed, not the agent. UNMEASURED and SKIPPED are never passes.'));

  mkdirSync('evals/results', { recursive: true });
  writeFileSync(
    'evals/results/golden-latest.json',
    JSON.stringify({ at: new Date().toISOString(), domain, opts, tally, violations, results: results.map((r) => ({ id: r.a.id, outcome: r.outcome, live: r.live, stored: r.stored, claim: r.claim, why: r.why, expired: r.expired })) }, null, 2)
  );

  // Exit 1 on accuracy failures and on retired figures only. DRIFT is news, not
  // a build break — failing CI for a client shipping a release trains people to
  // stop running the eval.
  process.exit(tally.FAIL + violations.length ? 1 : 0);
}

const fmtv = (v) => (v === null || v === undefined ? 'n/a' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function walk(d) {
  if (!existsSync(d)) return [];
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
  console.log(c.d('\n  Heuristic only. It measures the shape of a good report, not whether the\n  analysis is correct. For that, run: node evals/run.mjs golden'));
}

// --------------------------------------------------------------------- main

const mode = process.argv[2];
if (mode === 'static') staticEval();
else if (mode === 'fixture') fixtureEval(process.argv.slice(3));
else if (mode === 'golden') await goldenEval(process.argv.slice(3));
else if (mode === 'score') scoreReport(process.argv[3]);
else {
  console.log(`usage:
  node evals/run.mjs static                      validate all agent definitions (fast, CI-safe)
  node evals/run.mjs fixture <reports…>          score fixture-site output against planted defects
  node evals/run.mjs golden [domain] [reports…]  grade agent claims against a LIVE re-measurement
      --deep    also run full-tree crawls (hundreds of requests)
      --live    also re-measure SERPs (burns provider credits)
      --only=<substring of assertion id>
  node evals/run.mjs score <file>                rubric-score one deliverable`);
  process.exit(mode ? 1 : 0);
}
