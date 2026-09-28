/**
 * grade.mjs — the grading rule for the golden set.
 *
 * Four outcomes, and the ordering between them is the entire contract:
 *
 *   PASS        live matches the stored tripwire AND the agent matches live.
 *   DRIFT       live differs from the stored tripwire. The SITE changed. Print
 *               the rebaseline command; do not fail the agent for having been
 *               right when it measured.
 *   FAIL        the agent's claim differs from live (and from the tripwire).
 *               This is the only accuracy signal in the harness.
 *   UNMEASURED  provider or network failure, or no agent claim to grade.
 *               Never silently a pass, never silently a fail.
 *
 * The refinement over the audit's §4.4 sketch: the sketch made live-vs-stored
 * DRIFT and agent-vs-live FAIL two independent tests, which double-punishes the
 * honest case. On 2026-09-25 the /us/ sitemap moved 240 → 250. US-AUDIT-REPORT.md
 * correctly says 240 — that was true when it was measured. Grading it as FAIL
 * would train the team to chase the site instead of reporting what it saw. So:
 * when live has drifted and the agent matches the RETIRED value, the outcome is
 * DRIFT with `agentMatched: "stored"`. An agent matching neither live nor stored
 * is FAIL even under drift, because that number came from nowhere.
 */

import { readFileSync } from 'node:fs';

export const OUTCOMES = ['PASS', 'FAIL', 'DRIFT', 'UNMEASURED', 'SKIPPED'];

/** Numeric compare with the assertion's declared tolerance. Booleans compare strictly. */
export function matches(a, b, tolerance = 0) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) <= tolerance;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Pull the agent's claimed value out of the reports.
 *
 * Per-report and per-match — not the concatenate-and-lowercase blob that made
 * `fixture` mode report 94% recall against a corpus nobody audited (audit §4.2).
 * A claim is only a claim if a single report states it.
 */
export function extractClaim(reportPaths, assertion) {
  const pattern = assertion.reportPattern;
  if (!pattern) return { found: false, reason: 'assertion declares no reportPattern' };
  const re = new RegExp(pattern, 'gi');
  const hits = [];
  for (const p of reportPaths) {
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(re)) {
      // First non-empty capture group, else the whole match. Alternation in a
      // reportPattern leaves the unused branch undefined.
      const raw = m.slice(1).find((g) => g !== undefined) ?? m[0];
      const i = m.index ?? 0;
      hits.push({
        file: p,
        raw,
        value: mapClaim(raw, assertion.claimMap),
        context: text.slice(Math.max(0, i - 120), i + 120).replace(/\s+/g, ' '),
      });
    }
  }
  if (!hits.length) return { found: false, reason: 'no report states this claim' };
  return { found: true, hits, value: hits[0].value, file: hits[0].file, raw: hits[0].raw };
}

/**
 * Some assertions grade a phrase, not a number — "emits no hreflang", "HTTP 200"
 * on a soft-404. `claimMap` translates the matched text into the same units the
 * probe returns, with "*" meaning "any match of this pattern asserts the claim".
 */
function mapClaim(raw, claimMap) {
  if (!claimMap) return parseClaim(raw);
  const key = String(raw).trim();
  if (key in claimMap) return claimMap[key];
  if ('*' in claimMap) return claimMap['*'];
  return parseClaim(raw);
}

function parseClaim(raw) {
  const s = String(raw).replace(/[,\s]/g, '');
  if (/^(true|yes|present|confirmed)$/i.test(s)) return true;
  if (/^(false|no|absent|none)$/i.test(s)) return false;
  const n = Number(s.replace(/%$/, ''));
  return Number.isFinite(n) ? n : raw;
}

/**
 * Grade one assertion.
 *
 * @param a      the assertion from the golden JSON
 * @param probe  { value, measured, note } from PROBES
 * @param claim  the result of extractClaim()
 */
export function grade(a, probe, claim) {
  const tol = a.expect?.tolerance ?? 0;
  const stored = a.expect?.value;

  if (!probe.measured) {
    return { outcome: 'UNMEASURED', why: probe.note ?? 'probe returned no measurement', live: null, stored, claim: claim.value };
  }

  const live = probe.value;
  const liveMatchesStored = matches(live, stored, tol);

  if (!claim.found) {
    // No agent said anything. That is not a pass. It may be a coverage hole in
    // the reports or a missing agent — either way it must be visible.
    return {
      outcome: 'UNMEASURED',
      why: `${claim.reason} — nothing to grade (live = ${fmt(live)})`,
      live, stored, claim: null, liveMatchesStored, probeNote: probe.note,
    };
  }

  const claimMatchesLive = matches(claim.value, live, tol);
  const claimMatchesStored = matches(claim.value, stored, tol);

  if (!liveMatchesStored) {
    // The site moved. Rebaseline; do not punish an agent that reported either
    // the current truth or the truth as of its own measurement.
    const agentMatched = claimMatchesLive ? 'live' : claimMatchesStored ? 'stored' : 'neither';
    if (agentMatched === 'neither') {
      return {
        outcome: 'FAIL', live, stored, claim: claim.value, drifted: true, agentMatched,
        why: `site drifted (${fmt(stored)} → ${fmt(live)}) and the report says ${fmt(claim.value)} — which matches neither`,
        evidence: claim.hits?.[0], probeNote: probe.note,
      };
    }
    return {
      outcome: 'DRIFT', live, stored, claim: claim.value, agentMatched,
      why: `live is ${fmt(live)}, stored tripwire is ${fmt(stored)} — the site changed`,
      rebaseline: rebaselineCmd(a, live),
      evidence: claim.hits?.[0], probeNote: probe.note,
    };
  }

  if (!claimMatchesLive) {
    return {
      outcome: 'FAIL', live, stored, claim: claim.value,
      why: `report claims ${fmt(claim.value)}; live measurement is ${fmt(live)}`,
      evidence: claim.hits?.[0], probeNote: probe.note,
    };
  }

  return { outcome: 'PASS', live, stored, claim: claim.value, probeNote: probe.note };
}

/**
 * Closes the loop between the eval and the store agents actually read. A DRIFT
 * that only prints to a terminal gets lost; the correction has to land in
 * memory or the next wave reads the retired number (audit §1.2).
 */
export function rebaselineCmd(a, live) {
  const metric = a.memoryKey ?? a.id.replace(/-/g, '_');
  return `python tools/memory.py baseline ${a.domain ?? '<domain>'} --metric ${metric} --value ${JSON.stringify(live)} --source "golden eval ${a.id} live probe" --why "site drifted from ${JSON.stringify(a.expect?.value)}"`;
}

/**
 * Regexes for figures that evidence has already retired. A withdrawn number
 * reappearing is a regression, not a near miss — "55 of 115" was adjudicated
 * withdrawn on the board (bd_7t75z3nr) and still surfaced in narrative prose.
 */
export function checkMustNotClaim(reportPaths, rules) {
  const violations = [];
  for (const rule of rules ?? []) {
    const re = new RegExp(rule.pattern, 'gi');
    for (const p of reportPaths) {
      let text;
      try { text = readFileSync(p, 'utf8'); } catch { continue; }
      for (const m of text.matchAll(re)) {
        const i = m.index ?? 0;
        const ctx = text.slice(Math.max(0, i - 260), i + 260);
        // A report may narrate a retired figure as long as it says it is
        // retired. US-AUDIT-REPORT.md's corrections table does exactly this and
        // must not be flagged; a fresh claim of the same number must be.
        if (new RegExp(rule.allowNear ?? '\\b(withdrawn|withdrew|retired|superseded|corrected|adjudicated|previously held|was wrong|not \\d)\\b', 'i').test(ctx)) continue;
        violations.push({ rule: rule.id, file: p, text: m[0], why: rule.why, context: ctx.replace(/\s+/g, ' ').slice(0, 200) });
      }
    }
  }
  return violations;
}

const fmt = (v) => (v === null || v === undefined ? 'n/a' : typeof v === 'object' ? JSON.stringify(v) : String(v));
