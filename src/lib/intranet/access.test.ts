/**
 * The rules an admin write has to pass before it reaches the database.
 *
 * These matter more than they look. Row-level security refuses a write by
 * changing nothing and reporting success, so a refusal produced here is often
 * the only one an admin will actually read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProfileWrite, isRole, isStatus, ROLES, STATUSES } from './access.ts';

const ADMIN = 'a1b2c3';
const SOMEBODY_ELSE = 'd4e5f6';

test('allows a role or status change aimed at somebody else', () => {
  for (const role of ROLES) {
    assert.deepEqual(checkProfileWrite(ADMIN, SOMEBODY_ELSE, { role }), { ok: true });
  }
  for (const status of STATUSES) {
    assert.deepEqual(checkProfileWrite(ADMIN, SOMEBODY_ELSE, { status }), { ok: true });
  }
});

test('refuses an admin acting on their own row', () => {
  // No self-revoke and no self-demote: the last admin locking themselves out
  // leaves nobody who can let them back in.
  const patches = [{ status: 'revoked' }, { role: 'viewer' }, { status: 'active', role: 'admin' }];
  for (const patch of patches) {
    const res = checkProfileWrite(ADMIN, ADMIN, patch);
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /your own access/i);
  }
});

test('rejects a role that is not one of the three', () => {
  for (const role of ['owner', 'ADMIN', 'superuser', 'admin ', '', 1, null]) {
    assert.equal(
      checkProfileWrite(ADMIN, SOMEBODY_ELSE, { role }).ok,
      false,
      `expected ${JSON.stringify(role)} to be refused`,
    );
  }
});

test('rejects a status that is not one of the three', () => {
  for (const status of ['approved', 'Active', 'deleted', '', 42]) {
    assert.equal(
      checkProfileWrite(ADMIN, SOMEBODY_ELSE, { status }).ok,
      false,
      `expected ${JSON.stringify(status)} to be refused`,
    );
  }
});

test('refuses a write with nobody acting, and one with nobody to act on', () => {
  assert.equal(checkProfileWrite('', SOMEBODY_ELSE, { status: 'active' }).ok, false);
  assert.equal(checkProfileWrite(ADMIN, '', { status: 'active' }).ok, false);
});

test('refuses a write that would change nothing', () => {
  assert.equal(checkProfileWrite(ADMIN, SOMEBODY_ELSE, {}).ok, false);
});

test('the guards agree with the lists they guard', () => {
  for (const role of ROLES) assert.equal(isRole(role), true);
  for (const status of STATUSES) assert.equal(isStatus(status), true);
  assert.equal(isRole('estimator '), false);
  assert.equal(isStatus(undefined), false);
});
