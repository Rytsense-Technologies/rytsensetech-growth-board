/**
 * Shared input validation for the Growth Board write API.
 *
 * WHY THIS EXISTS
 * The 2026-09-28 review found the allow-list discipline applied in exactly one
 * place — status in tasks/[id].js — and nowhere else. goals.js stored `body.target`
 * verbatim, so an object or array could land where the dashboard does arithmetic;
 * tasks/[id].js stored owner/team/priority/details/rationale with no enum and no
 * length cap, so a megabyte string persists forever in KV and renders on every
 * page load; an unvalidated `priority` silently breaks the openCritical KPI tile
 * on the homepage, because a typo matches no bucket and is counted nowhere.
 * The rule: every enumerated field gets an allow-list, every string gets a cap,
 * every number must be finite, and every body gets a size ceiling.
 */

/**
 * Hard ceiling on a request body. Cloudflare caps at the edge too, but nothing
 * in-app did, and a 24-task board has no legitimate megabyte-scale write.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** String caps, in characters. Chosen to match what the UI can actually produce. */
export const LIMITS = {
  title: 200,
  details: 4000,
  note: 2000,
  name: 80,
  person: 80,
  shortEnum: 40,
  url: 500,
  id: 120,
  summary: 1200,
};

export const STATUSES = ['todo', 'in-progress', 'blocked', 'done'];
export const PRIORITIES = ['critical', 'high', 'medium', 'low'];
export const TEAMS = ['Development', 'Marketing', 'Content', 'SEO'];
export const OWNERS = ['Dev', 'Development', 'Content', 'SEO', 'Marketing'];
export const ACTIVITY_TYPES = [
  'fix',
  'content',
  'tech',
  'outreach',
  'note',
  'task',
  'fix_completed',
  'agent-engagement',
];

/**
 * Read + parse a JSON body with a size ceiling.
 * Returns { body } on success or { response } holding a ready 400/413.
 */
export async function readJson(request, json, max = MAX_BODY_BYTES) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) {
    return { response: json({ error: 'body too large', maxBytes: max }, 413) };
  }
  let text = '';
  try {
    text = await request.text();
  } catch {
    return { response: json({ error: 'invalid json' }, 400) };
  }
  // Content-Length can be absent (chunked) — measure what actually arrived.
  if (new TextEncoder().encode(text).length > max) {
    return { response: json({ error: 'body too large', maxBytes: max }, 413) };
  }
  if (!text) return { body: {} };
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { response: json({ error: 'body must be a json object' }, 400) };
    }
    return { body };
  } catch {
    return { response: json({ error: 'invalid json' }, 400) };
  }
}

/** Coerce to a capped string. Objects/arrays are rejected rather than stringified. */
export function str(value, max) {
  if (value == null) return null;
  if (typeof value === 'object') return null;
  return String(value).slice(0, max);
}

/** Trimmed capped string, or null when empty. */
export function trimmed(value, max) {
  const s = str(value, max);
  if (s == null) return null;
  const t = s.trim();
  return t ? t : null;
}

/** Allow-list check. Returns the value when permitted, undefined when not. */
export function pick(value, allowed) {
  if (typeof value !== 'string') return undefined;
  return allowed.includes(value) ? value : undefined;
}

/**
 * Finite number, accepting the numeric strings the goal inputs actually send
 * (platform.html posts `input.value`, which is always a string).
 * Returns undefined for anything non-finite — objects, arrays, NaN, Infinity.
 */
export function finite(value) {
  if (value == null || value === '') return null; // explicit "clear this target"
  if (typeof value === 'object' || typeof value === 'boolean') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** ISO-ish date string (YYYY-MM-DD or full ISO), or null. Rejects garbage. */
export function dateish(value) {
  if (value == null || value === '') return null;
  const s = str(value, 40);
  if (s == null) return undefined;
  return Number.isNaN(Date.parse(s)) ? undefined : s;
}
