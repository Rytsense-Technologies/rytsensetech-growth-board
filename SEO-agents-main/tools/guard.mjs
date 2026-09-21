#!/usr/bin/env node
/**
 * guard.mjs — enforcement layer for the SEO agent team.
 *
 * Prose guardrails in agent files are instructions a model can drift from.
 * This runs as a Claude Code hook, so it is mechanical: it inspects tool calls
 * before they execute and agent outputs after they are written.
 *
 * Modes (argv[2]):
 *   pre-tool    PreToolUse  — block dangerous or out-of-policy calls
 *   post-write  PostToolUse — lint written deliverables for fabrication
 *   lint <file> standalone  — lint a file manually, no hook context
 *
 * Hook contract: exit 0 = allow, exit 2 = block (stderr shown to the agent).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

const MODE = process.argv[2];

// --------------------------------------------------------------- hook payload

function readStdin() {
  try { return JSON.parse(readFileSync(0, 'utf8')); } catch { return null; }
}
function block(msg) { console.error(msg); process.exit(2); }
function allow() { process.exit(0); }
function warn(msg) { console.error(msg); process.exit(0); }

// ----------------------------------------------------------------- pre-tool

const DESTRUCTIVE = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\//, why: 'recursive delete from a root path' },
  { re: /\bgit\s+push\s+.*--force(?!-with-lease)/, why: 'force push without --force-with-lease' },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'hard reset discards uncommitted work' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, why: 'git clean -f deletes untracked files irreversibly' },
  { re: />\s*\/dev\/sd[a-z]/, why: 'raw device write' },
  { re: /\bcurl\b[^|]*\|\s*(ba)?sh/, why: 'piping a remote script straight into a shell' },
  { re: /\bDROP\s+(TABLE|DATABASE)\b/i, why: 'destructive SQL' },
];

// Unbounded waits. An agent told "never end your turn while children are running"
// will reach for a poll loop if you let it — and a poll with nothing to watch
// never exits. Observed 2026-09-17: a "Wait for remaining agents" loop ran 42
// minutes after its children had finished and the report had shipped, holding a
// task slot open where only the user could see it. Child completions are
// delivered as notifications; there is nothing to poll for.
const WAIT_LOOPS = [
  { re: /\bwhile\s+(true|:)\b/, why: 'an unbounded `while true` loop' },
  { re: /\buntil\s+.*;\s*do\b/, why: 'an `until ... do` loop with no timeout' },
  { re: /\bfor\s*\(\s*;\s*;\s*\)/, why: 'an unbounded `for(;;)` loop' },
  { re: /\bsleep\s+([6-9]\d|\d{3,})\b/, why: 'a sleep of 60s or more' },
  { re: /\bsleep\b[\s\S]{0,60}\b(done|loop|again)\b/, why: 'a sleep inside a loop' },
  { re: /\bwait\b\s*$/, why: 'a bare `wait` for background jobs' },
];

// Things that would publish or mutate a live property. The team drafts; humans ship.
const LIVE_MUTATION = [
  { re: /\bwp\s+post\s+(create|update|delete)\b/, why: 'publishing to WordPress' },
  { re: /\bshopify\b.*\b(publish|push)\b/, why: 'publishing to Shopify' },
  { re: /\bnetlify\s+deploy\b|\bvercel\s+(deploy|--prod)\b/, why: 'deploying a site' },
  { re: /\bgcloud\b.*\bdeploy\b|\baws\s+s3\s+sync\b/, why: 'deploying to cloud hosting' },
  { re: /\bgit\s+push\b(?!.*--dry-run)/, why: 'pushing commits' },
];

const SECRET_PATTERNS = [
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, label: 'OpenAI-style API key' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, label: 'Anthropic API key' },
  { re: /\bghp_[A-Za-z0-9]{30,}\b/, label: 'GitHub personal access token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key id' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/, label: 'Google API key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'private key' },
  { re: /\b(?:SERPER|SERPAPI|VALUESERP)_API_KEY\s*=\s*['"]?[A-Za-z0-9]{16,}/, label: 'SERP provider key' },
];

// Files the team must never write into, even with repo access.
const PROTECTED_PATHS = [
  /(^|[\\/])\.env(\.local)?$/,
  /(^|[\\/])\.git[\\/]/,
  /(^|[\\/])(id_rsa|id_ed25519|\.npmrc|\.pypirc)$/,
  /(^|[\\/])node_modules[\\/]/,
];

function preTool(p) {
  const tool = p?.tool_name ?? '';
  const input = p?.tool_input ?? {};

  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(input.command ?? '');
    for (const d of DESTRUCTIVE) {
      if (d.re.test(cmd)) block(
        `GUARDRAIL: blocked — ${d.why}.\n` +
        `Command: ${cmd.slice(0, 200)}\n` +
        `If this is genuinely intended, the human operator must run it themselves.`
      );
    }
    for (const w of WAIT_LOOPS) {
      if (w.re.test(cmd)) block(
        `GUARDRAIL: blocked — ${w.why}.\n` +
        `Child agents report back through notifications; there is nothing to poll for, so a wait loop\n` +
        `never exits and leaks a process nobody but the user can see. Simply continue your turn.\n` +
        `If you genuinely must block on external state, use a bounded check with an exit condition —\n` +
        `e.g. \`python tools/board.py pending <domain>\` once, not in a loop.\n` +
        `Command: ${cmd.slice(0, 200)}`
      );
    }
    for (const m of LIVE_MUTATION) {
      if (m.re.test(cmd)) block(
        `GUARDRAIL: blocked — ${m.why}.\n` +
        `The SEO team drafts changes; it does not publish them. Produce the change as a file or a ticket and ask the operator to ship it.\n` +
        `Command: ${cmd.slice(0, 200)}`
      );
    }
    for (const s of SECRET_PATTERNS) {
      if (s.re.test(cmd)) block(`GUARDRAIL: blocked — a ${s.label} appears in this command. Never pass secrets on a command line; use environment variables.`);
    }
  }

  if (tool === 'Write' || tool === 'Edit') {
    const path = String(input.file_path ?? '');
    for (const re of PROTECTED_PATHS) {
      if (re.test(path)) block(`GUARDRAIL: blocked — "${path}" is a protected path. Agents do not write credentials, git internals, or vendored dependencies.`);
    }
    const content = String(input.content ?? input.new_string ?? '');
    for (const s of SECRET_PATTERNS) {
      if (s.re.test(content)) block(`GUARDRAIL: blocked — this write contains what looks like a ${s.label}. Use a placeholder and document the env var instead.`);
    }
  }

  allow();
}

// ---------------------------------------------------------------- fabrication
// The characteristic failure of AI SEO work is confident invented numbers.
// These are heuristics that flag, not prove. They warn; they do not block,
// because a false block on real GSC data would be worse than a false warning.

const HEDGES = /\b(est\.|estimate[ds]?|estimated|approx|approximately|inferred|unverified|assumption|assumed|projected|directional|could not (verify|determine|fetch)|no data|not measured|heuristic)\b/i;
const SOURCED = /\b(gsc|search console|ga4|analytics|per (the )?logs?|source:|measured|retrieved|from the (api|data|export)|tool call)\b/i;

const CLAIMS = [
  { re: /\b(\d{1,3}(,\d{3})+|\d{3,})\s*(monthly\s+)?(searches|search volume|searches\/mo|queries per month)/gi, label: 'search volume' },
  { re: /\bvolume[:\s]+\d{2,}/gi, label: 'search volume' },
  { re: /\b(DR|DA|domain rating|domain authority)\s*(of\s*)?[:=]?\s*\d{1,3}\b/gi, label: 'authority metric' },
  { re: /\b\d{1,3}(\.\d+)?%\s*(of\s+)?(traffic|clicks|CTR|conversion|bounce|increase|decrease|lift|growth)/gi, label: 'percentage metric' },
  { re: /\bby\s+\d{1,3}(\.\d+)?%/gi, label: 'quantified change' },
  { re: /\b(will|should|expect\w*|anticipat\w*|project\w*)\b[^.]{0,60}\b(increase|grow|improve|lift|boost|gain|double|triple)\b[^.]{0,40}\d/gi, label: 'forecast' },
  { re: /\branks?\s+(at\s+)?#?\s*\d{1,2}\s+for\b/gi, label: 'ranking position' },
  { re: /\b\d{2,}\s+(backlinks|referring domains|linking domains)\b/gi, label: 'link count' },
];

export function lintFabrication(text, file = '') {
  const lines = text.split('\n');
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('>') || /^\s*\|?\s*-{3,}/.test(line)) continue; // quotes, table rules
    for (const c of CLAIMS) {
      c.re.lastIndex = 0;
      let m;
      while ((m = c.re.exec(line)) !== null) {
        const ctx = [lines[i - 1] ?? '', line, lines[i + 1] ?? ''].join(' ');
        if (HEDGES.test(ctx) || SOURCED.test(ctx)) continue;
        findings.push({ file, line: i + 1, label: c.label, text: m[0].trim(), context: line.trim().slice(0, 160) });
      }
    }
  }
  return findings;
}

const PROHIBITED_TACTICS = [
  { re: /\bPBN\b|private blog network/i, label: 'private blog network' },
  { re: /\bbuy(ing)? (back)?links\b|paid link (building|placement)/i, label: 'paid links' },
  { re: /\blink (farm|exchange scheme|wheel)\b/i, label: 'link scheme' },
  { re: /\bcloak(ing|ed)\b/i, label: 'cloaking' },
  { re: /\bdoorway page/i, label: 'doorway pages' },
  { re: /\bhidden text\b|display:\s*none.{0,40}keyword/i, label: 'hidden text' },
  { re: /\bfake reviews?\b|incentiviz(e|ed) reviews?/i, label: 'fake reviews' },
  { re: /\bastroturf/i, label: 'astroturfing' },
];

export function lintTactics(text, file = '') {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const t of PROHIBITED_TACTICS) {
      if (!t.re.test(lines[i])) continue;
      // Agents are supposed to name these in order to refuse them. Only flag
      // when the surrounding text reads as a recommendation rather than a refusal.
      const ctx = [lines[i - 1] ?? '', lines[i], lines[i + 1] ?? ''].join(' ');
      if (/\b(never|avoid|do not|don't|refuse|prohibited|not recommend|against|risk|penalt)/i.test(ctx)) continue;
      out.push({ file, line: i + 1, label: t.label, context: lines[i].trim().slice(0, 160) });
    }
  }
  return out;
}

function postWrite(p) {
  const path = String(p?.tool_input?.file_path ?? '');
  if (!/output[\\/].*\.md$/.test(path) || !existsSync(path)) allow();

  const text = readFileSync(path, 'utf8');
  const fab = lintFabrication(text, path);
  const tac = lintTactics(text, path);
  if (!fab.length && !tac.length) allow();

  const rel = relative(process.cwd(), path) || path;
  const msg = [`GUARDRAIL REVIEW — ${rel}`, ''];
  if (fab.length) {
    msg.push(`${fab.length} unsourced quantitative claim(s). Each must cite a tool call, or be hedged as an estimate:`);
    for (const f of fab.slice(0, 12)) msg.push(`  L${f.line} [${f.label}] ${f.text}  —  ${f.context}`);
    if (fab.length > 12) msg.push(`  …and ${fab.length - 12} more`);
    msg.push('', 'Fix by either: (a) citing the source inline ("per GSC, 16-month window"), or (b) labelling it ("est., inferred from SERP composition"). Do not delete the number to silence this — state where it came from.');
  }
  if (tac.length) {
    msg.push('', `${tac.length} possible prohibited-tactic recommendation(s):`);
    for (const t of tac) msg.push(`  L${t.line} [${t.label}] ${t.context}`);
    msg.push('', 'If you are naming the tactic in order to refuse it, say so explicitly in the same sentence.');
  }
  warn(msg.join('\n'));
}

// ------------------------------------------------------------------ standalone

function lintFiles(files) {
  let total = 0;
  for (const f of files) {
    if (!existsSync(f)) { console.error(`missing: ${f}`); continue; }
    const text = readFileSync(f, 'utf8');
    const fab = lintFabrication(text, f);
    const tac = lintTactics(text, f);
    total += fab.length + tac.length;
    if (fab.length || tac.length) {
      console.log(`\n${f}`);
      for (const x of fab) console.log(`  L${x.line} [unsourced ${x.label}] ${x.text}`);
      for (const x of tac) console.log(`  L${x.line} [tactic: ${x.label}] ${x.context}`);
    }
  }
  console.log(total ? `\n${total} finding(s).` : 'Clean — no unsourced claims or prohibited tactics found.');
  process.exit(total ? 1 : 0);
}

// ----------------------------------------------------------------------- main

if (MODE === 'pre-tool') preTool(readStdin());
else if (MODE === 'post-write') postWrite(readStdin());
else if (MODE === 'lint') lintFiles(process.argv.slice(3));
else if (MODE === 'selftest') {
  const bad = `The keyword has 12,000 monthly searches and a DR of 68.\nWe expect this to increase traffic by 40%.\nWe recommend building a PBN for faster results.`;
  const good = `Per GSC (16-month window, non-brand), the query drew 4,102 impressions.\nEst. volume: medium — inferred from SERP composition.\nNever use a PBN; the penalty risk is real.`;
  console.log('BAD  →', lintFabrication(bad).length, 'fabrication,', lintTactics(bad).length, 'tactic');
  console.log('GOOD →', lintFabrication(good).length, 'fabrication,', lintTactics(good).length, 'tactic');
  const ok = lintFabrication(bad).length >= 3 && lintTactics(bad).length === 1
    && lintFabrication(good).length === 0 && lintTactics(good).length === 0;
  // wait-loop detection
  const loops = [
    'while true; do sleep 5; done',
    'until [ -f done.txt ]; do sleep 2; done',
    'sleep 300',
    'wait',
  ];
  const safe = [
    'python tools/board.py pending example.com',
    'sleep 2',
    'python tools/serp.py search "x"',
  ];
  let loopOk = true;
  for (const c of loops) if (!WAIT_LOOPS.some(w => w.re.test(c))) { console.log('  MISSED loop:', c); loopOk = false; }
  for (const c of safe)  if (WAIT_LOOPS.some(w => w.re.test(c))) { console.log('  FALSE POSITIVE:', c); loopOk = false; }
  console.log('LOOPS →', loopOk ? 'all 4 blocked, 3 safe commands allowed' : 'FAILED');

  console.log(ok && loopOk ? 'selftest PASS' : 'selftest FAIL');
  process.exit(ok && loopOk ? 0 : 1);
} else {
  console.error('usage: guard.mjs <pre-tool|post-write|lint <files…>|selftest>');
  process.exit(1);
}
