/**
 * GET /api/export — full KV snapshot as one JSON document. Token-protected.
 *
 * WHY THIS EXISTS
 * The team's actual work product — every status, assignee, due date, note and
 * roster change — exists in exactly one place: the FIXES KV namespace. git holds
 * only the seed files, so `git log data/tasks.json` shows what the seed was, never
 * what the board displayed. The daily metric history is backed up; the human work
 * was not backed up at all. If that namespace is lost, it is all gone.
 *
 * This is the snapshot primitive. No dependencies, no streaming, no pagination —
 * the whole board is a handful of small JSON values. Point a scheduled job at it:
 *
 *   curl -sS -H "X-Board-Token: $BOARD_PUBLISH_TOKEN" \
 *     https://rytsensetech-growth-board.pages.dev/api/export \
 *     > backups/board-$(date +%F).json
 *
 * Token-protected because the export is every KV value in one response, which is
 * a strictly larger disclosure than any single public GET.
 */
import { responder, preflight, requireAuth } from '../_lib/auth.js';

const METHODS = 'GET, OPTIONS';

/** Every key this board writes. Keep in sync when a new KV key is introduced. */
const KEYS = ['tasks', 'state', 'goals', 'team', 'activity', 'engagements'];

export async function onRequestGet(context) {
  const { env, request } = context;
  const json = responder(request, METHODS);

  // Auth first: refuse before touching KV, and refuse when the secret is unset.
  const denied = await requireAuth(request, env, json);
  if (denied) return denied;

  if (!env.FIXES) return json({ error: 'FIXES_KV_UNBOUND' }, 503);

  const exportedAt = new Date().toISOString();
  const keys = {};
  const errors = {};

  for (const key of KEYS) {
    try {
      const raw = await env.FIXES.get(key);
      if (raw == null) {
        keys[key] = null; // never written — distinct from "failed to read"
        continue;
      }
      try {
        keys[key] = JSON.parse(raw);
      } catch {
        // Keep the raw text rather than dropping it: an unparseable value is
        // exactly the value a backup most needs to preserve.
        keys[key] = { unparseable: true, raw };
      }
    } catch (e) {
      errors[key] = e && e.message ? e.message : String(e);
    }
  }

  const complete = Object.keys(errors).length === 0;
  return json(
    {
      format: 'rytsensetech-growth-board/kv-export@1',
      exportedAt,
      namespace: 'FIXES',
      // An incomplete export must never be mistaken for a good backup.
      complete,
      keys,
      ...(complete ? {} : { errors, warning: 'PARTIAL_EXPORT' }),
    },
    complete ? 200 : 500
  );
}

export async function onRequestOptions(context) {
  return preflight(context.request, METHODS);
}
