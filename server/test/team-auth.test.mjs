import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkTeamLogin,
  signTeamToken,
  verifyTeamToken,
  teamActor,
  teamUsername,
} from '../src/team-auth.js';

test('shared team login accepts the constant username and password', () => {
  assert.equal(checkTeamLogin('rytsensetech', 'Admin@123#'), true);
  assert.equal(checkTeamLogin('RytsenseTech', 'Admin@123#'), true);
  assert.equal(checkTeamLogin('rytsensetech', 'wrong'), false);
  assert.equal(checkTeamLogin('other', 'Admin@123#'), false);
});

test('team token round-trips and becomes a Rytsense admin actor', () => {
  const token = signTeamToken();
  const payload = verifyTeamToken(token);
  assert.ok(payload);
  assert.equal(payload.username, teamUsername());
  const actor = teamActor({ get: () => null }, payload);
  assert.equal(actor.isPlatformAdmin, true);
  assert.equal(actor.memberships[0].role, 'admin');
});

test('tampered team token is rejected', () => {
  const token = signTeamToken();
  assert.equal(verifyTeamToken(token.slice(0, -2) + 'xx'), null);
  assert.equal(verifyTeamToken('not-a-token'), null);
});

test('team session expires after 30 minutes', () => {
  const fresh = verifyTeamToken(signTeamToken());
  assert.ok(fresh);
  assert.ok(fresh.exp - Date.now() <= 30 * 60 * 1000 + 1000);
  assert.equal(verifyTeamToken(signTeamToken({ exp: Date.now() - 1000, iat: Date.now() - 31 * 60 * 1000 })), null);
});
