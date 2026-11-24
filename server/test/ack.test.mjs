import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseVerify,
  shapeAck,
  claimAck,
  verifyAck,
  unclaimAck,
} from '../src/jobs/verify-ack.js';

function columns(file, table) {
  const sql = readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8');
  const m = sql.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`, 'i'));
  assert.ok(m, `table ${table} in ${file}`);
  return new Set(
    m[1]
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((w) => /^[a-z_]+$/.test(w) && !['unique', 'primary', 'check'].includes(w))
  );
}

test('acknowledgements migration has required columns', () => {
  const cols = columns('0003_ack.sql', 'acknowledgements');
  for (const c of [
    'organization_id', 'site_id', 'source_kind', 'source_id',
    'claim_snapshot', 'claimed_by', 'claimed_at',
    'verify_status', 'verify_detail', 'verified_at',
  ]) assert.ok(cols.has(c), c);
});

test('parseVerify accepts confirmed and failed only', () => {
  assert.equal(parseVerify('{"verdict":"confirmed","reason":"ok","evidence_used":["x"]}').verdict, 'confirmed');
  assert.equal(parseVerify('noise {"verdict":"failed","reason":"still 404"} more').verdict, 'failed');
  assert.throws(() => parseVerify('{"verdict":"maybe","reason":"x"}'));
});

function fakeDb(resolve) {
  const writes = [];
  const db = {
    writes,
    from(table) {
      const q = { table, op: 'select', filters: [], payload: null };
      const run = () => {
        if (q.op !== 'select') writes.push({ table, op: q.op, payload: q.payload, filters: q.filters });
        return Promise.resolve(resolve(q) || { data: null, error: null });
      };
      const b = {
        select() { return b; },
        insert(p) { q.op = 'insert'; q.payload = p; return b; },
        upsert(p) { q.op = 'upsert'; q.payload = p; return b; },
        update(p) { q.op = 'update'; q.payload = p; return b; },
        delete() { q.op = 'delete'; return b; },
        then(ok, bad) { return run().then(ok, bad); },
        single() { return run(); },
        maybeSingle() { return run(); },
      };
      for (const m of ['eq', 'neq', 'in', 'is', 'not', 'gte', 'order', 'limit', 'or', 'range']) {
        b[m] = (...a) => { q.filters.push([m, ...a]); return b; };
      }
      return b;
    },
  };
  return db;
}

test('claimAck upserts pending and marks GSC issue fixed', async () => {
  const db = fakeDb((q) => {
    if (q.table === 'acknowledgements' && q.op === 'upsert') {
      return {
        data: {
          id: 'ack-1',
          organization_id: 'org-1',
          site_id: 'site-1',
          source_kind: 'gsc_issue',
          source_id: 'I-1',
          claim_snapshot: q.payload.claim_snapshot,
          claimed_by: 'tester',
          claimed_at: q.payload.claimed_at,
          verify_status: 'pending',
          verify_detail: {},
        },
        error: null,
      };
    }
    return { data: null, error: null };
  });
  const row = await claimAck(db, {
    organizationId: 'org-1',
    siteId: 'site-1',
    sourceKind: 'gsc_issue',
    sourceId: 'I-1',
    snapshot: { title: '404 page', url: 'https://rytsensetech.com/missing' },
    claimedBy: 'tester',
  });
  assert.equal(row.verify_status, 'pending');
  const issueUpdate = db.writes.find((w) => w.table === 'issues' && w.op === 'update');
  assert.equal(issueUpdate.payload.status, 'fixed');
  assert.equal(shapeAck(row).sourceKind, 'gsc_issue');
});

test('verifyAck confirmed keeps fixed; failed reopens issue', async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  let ack = {
    id: 'ack-1',
    organization_id: 'org-1',
    site_id: 'site-1',
    source_kind: 'gsc_issue',
    source_id: 'I-1',
    claim_snapshot: { url: 'https://example.com/gone', title: '404' },
    claimed_by: 'tester',
    claimed_at: new Date().toISOString(),
    verify_status: 'pending',
    verify_detail: {},
  };

  // Hard-fail path: issue category 404 + observed 404 → failed without Anthropic
  const dbFail = fakeDb((q) => {
    if (q.table === 'acknowledgements' && q.op === 'select') return { data: ack, error: null };
    if (q.table === 'issues' && q.op === 'select') {
      return { data: { id: 'I-1', url: 'https://example.com/gone', category: '404', action: 'fix', status: 'fixed', note: '' }, error: null };
    }
    if (q.table === 'search_pages') return { data: [], error: null };
    if (q.table === 'acknowledgements' && q.op === 'update') {
      ack = { ...ack, ...q.payload };
      return { data: ack, error: null };
    }
    return { data: null, error: null };
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 404, ok: false });
  try {
    const failed = await verifyAck(dbFail, 'ack-1');
    assert.equal(failed.verify_status, 'failed');
    const reopen = dbFail.writes.find((w) => w.table === 'issues' && w.op === 'update');
    assert.equal(reopen.payload.status, 'open');
  } finally {
    globalThis.fetch = originalFetch;
    if (prevKey) process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('unclaimAck deletes row and reopens', async () => {
  const ack = {
    id: 'ack-2',
    organization_id: 'org-1',
    site_id: 'site-1',
    source_kind: 'gsc_issue',
    source_id: 'I-2',
    claim_snapshot: {},
    verify_status: 'confirmed',
  };
  const db = fakeDb((q) => {
    if (q.table === 'acknowledgements' && q.op === 'select') return { data: ack, error: null };
    return { data: null, error: null };
  });
  await unclaimAck(db, {
    organizationId: 'org-1',
    siteId: 'site-1',
    sourceKind: 'gsc_issue',
    sourceId: 'I-2',
    actorLabel: 'tester',
  });
  assert.ok(db.writes.some((w) => w.table === 'issues' && w.payload.status === 'open'));
  assert.ok(db.writes.some((w) => w.table === 'acknowledgements' && w.op === 'delete'));
});
