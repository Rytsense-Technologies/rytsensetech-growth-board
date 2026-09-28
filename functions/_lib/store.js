/**
 * Optimistic concurrency, change history, and an honest activity append for the
 * Growth Board KV stores.
 *
 * WHY THIS EXISTS
 * Every task on this board lives in ONE KV value under the key "tasks", and each
 * writer does a whole-blob read-modify-write. Cloudflare KV has no conditional
 * put, so two analysts saving within the same second both read version N and both
 * write N+1: the second write silently erases the first — and because the blob
 * holds all 24 tasks, the change it erases is usually on a *completely unrelated*
 * task. The client had no version token to send, so last-write-wins was
 * unavoidable even in principle (2026-09-28 review, §4.2).
 *
 * The fix is a monotonic `rev` on each store. A reader gets `rev` in the GET
 * payload; a writer echoes it back; a mismatch is a 409 carrying the current
 * state, so the client can merge instead of clobber. A write with no `rev` is
 * still accepted — but only for a genuinely NEW record, never for an update to a
 * record that already exists, which is the case that loses someone's work.
 */

/** Change history is bounded — KV holds one value, not an event store. */
export const HISTORY_MAX = 400;

export function currentRev(store) {
  const r = Number(store && store.rev);
  return Number.isFinite(r) && r >= 0 ? Math.floor(r) : 0;
}

export function nextRev(store) {
  return currentRev(store) + 1;
}

/**
 * Check a writer's `rev` against the store.
 * Returns null when the write may proceed, or { reason, expected } when it may not.
 *
 * @param {object} body    parsed request body (may carry `rev`)
 * @param {object} store   the KV store just read
 * @param {boolean} isNew  true only when this write creates a record that does
 *                         not exist yet — the one case where no-rev is safe.
 */
export function checkRev(body, store, isNew) {
  const expected = currentRev(store);
  const got = body ? body.rev : undefined;
  if (got == null || got === '') {
    if (isNew) return null; // creating something new cannot overwrite anyone
    return {
      reason: 'rev required for updates',
      expected,
    };
  }
  const n = Number(got);
  if (!Number.isFinite(n)) return { reason: 'invalid rev', expected };
  if (Math.floor(n) !== expected) return { reason: 'rev mismatch', expected };
  return null;
}

/** Body of a 409 — always carries the current rev plus the caller-supplied state. */
export function conflictBody(conflict, state) {
  return {
    error: 'conflict',
    reason: conflict.reason,
    expectedRev: conflict.expected,
    message:
      'The board changed since you loaded it. Re-read the current state, merge your edit, and retry with the rev below.',
    rev: conflict.expected,
    current: state,
  };
}

/**
 * Append compact change entries to the store's history BEFORE the new values are
 * written. tasks/[id].js used to overwrite title/details/owner/team/priority with
 * no record of the previous value at all — the activity log only ever mentioned
 * status, assignee and due date, so a title and priority rewrite left no trace.
 */
export function recordChanges(store, changes) {
  if (!changes.length) return store;
  store.history = [...changes, ...(store.history || [])].slice(0, HISTORY_MAX);
  return store;
}

/** Build one history entry. Values are capped so history cannot grow unbounded. */
export function change(id, field, from, to, who, at) {
  const cap = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return '[object]';
    return String(v).slice(0, 200);
  };
  return { id, field, from: cap(from), to: cap(to), who, at };
}

/**
 * Append to the activity log and REPORT failure.
 *
 * Previously every call site wrapped this in `try { … } catch { /* ignore *\/ }`,
 * so a KV write failure lost the audit entry while the data change succeeded —
 * the log could be missing events rather than merely incomplete, which is worse
 * than having no log, because it looks complete. Callers now surface the error.
 *
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function appendActivity(env, key, entry, cap = 500) {
  try {
    const raw = await env.FIXES.get(key);
    let act = { entries: [] };
    if (raw) {
      try {
        act = JSON.parse(raw);
      } catch {
        act = { entries: [] };
      }
    }
    act.entries = [entry, ...(act.entries || []).filter((e) => e && e.id !== entry.id)].slice(
      0,
      cap
    );
    act.rev = nextRev(act);
    act.updatedAt = entry.date;
    await env.FIXES.put(key, JSON.stringify(act));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
