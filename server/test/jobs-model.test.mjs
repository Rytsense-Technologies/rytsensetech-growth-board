import test from 'node:test';
import assert from 'node:assert/strict';
import { isAutoModel, pickAutoModel } from '../src/jobs.js';

test('auto, latest, and empty mean pick at runtime', () => {
  assert.equal(isAutoModel('auto'), true);
  assert.equal(isAutoModel('latest'), true);
  assert.equal(isAutoModel(''), true);
  assert.equal(isAutoModel('claude-sonnet-4-5'), false);
});

test('auto prefers opus over sonnet', () => {
  assert.equal(
    pickAutoModel(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']),
    'claude-opus-5-5'
  );
  assert.equal(pickAutoModel([]), 'claude-opus-5-5');
});
