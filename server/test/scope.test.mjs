import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAsk,
  canReadOrg,
  canWriteTask,
  assertSameOrg,
  parseReview,
  membershipFor,
} from '../src/scope.js';

const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = '33333333-3333-4333-8333-333333333333';

function member(org) {
  return {
    isPlatformAdmin: false,
    memberships: [{ organization_id: org, role: 'seo' }],
  };
}

test('company B cannot read company A', () => {
  assert.equal(canReadOrg(member(orgB), orgA), false);
  assert.equal(canReadOrg(member(orgA), orgA), true);
});

test('platform admin does not see a company unless support mode names it', () => {
  const admin = { isPlatformAdmin: true, memberships: [], supportOrgId: null };
  assert.equal(canReadOrg(admin, orgA), false);
  admin.supportOrgId = orgA;
  assert.equal(canReadOrg(admin, orgA), true);
  assert.equal(canReadOrg(admin, orgB), false);
});

test('viewer cannot ask or write tasks', () => {
  assert.equal(canAsk('viewer'), false);
  assert.equal(canWriteTask('viewer'), false);
  assert.equal(canAsk('seo'), true);
});

test('cross-org row is rejected', () => {
  assert.throws(() => assertSameOrg(orgA, orgB), /forbidden/);
  assert.doesNotThrow(() => assertSameOrg(orgA, orgA));
});

test('review JSON without required fields is rejected', () => {
  assert.throws(() => parseReview('{"why":"x"}'));
  const ok = parseReview('{"why":"blocked","fix":"allow googlebot","owner_team":"Dev","effort":"1h","observed_status":"403"}');
  assert.equal(ok.observed_status, '403');
});

test('membership does not leak from another company', () => {
  assert.equal(membershipFor(member(orgB), orgA), null);
});
