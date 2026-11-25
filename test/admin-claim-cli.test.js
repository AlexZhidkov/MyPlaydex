import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyAdminClaim, main, parseCliArgs } from '../src/admin-claim-cli.js';

test('parseCliArgs parses grant/revoke/inspect actions with --email or --uid and --project', () => {
  assert.deepEqual(
    parseCliArgs(['--grant', '--email=admin@example.com'], {}),
    {
      action: 'grant',
      target: { email: 'admin@example.com' },
      project: 'myplaydex',
      useAdc: false
    }
  );

  assert.deepEqual(
    parseCliArgs(['--revoke', '--uid', 'uid-123', '--project=custom-proj', '--use-adc'], {}),
    {
      action: 'revoke',
      target: { uid: 'uid-123' },
      project: 'custom-proj',
      useAdc: true
    }
  );

  assert.deepEqual(
    parseCliArgs(['--inspect', '--email', 'viewer@example.com'], { FIREBASE_PROJECT_ID: 'env-proj', FIREBASE_USE_ADC: 'true' }),
    {
      action: 'inspect',
      target: { email: 'viewer@example.com' },
      project: 'env-proj',
      useAdc: true
    }
  );
});

test('parseCliArgs throws descriptive errors on missing, conflicting, or empty arguments', () => {
  assert.throws(() => parseCliArgs(['--email=a@b.com']), /action/i);
  assert.throws(() => parseCliArgs(['--grant', '--revoke', '--email=a@b.com']), /exactly one/i);
  assert.throws(() => parseCliArgs(['--grant']), /--email.*--uid|--uid.*--email/i);
  assert.throws(() => parseCliArgs(['--grant', '--email=a@b.com', '--uid=123']), /cannot specify both/i);
  assert.throws(() => parseCliArgs(['--grant', '--email=   ']), /non-empty/i);
  assert.throws(() => parseCliArgs(['--grant', '--uid=']), /non-empty/i);
  assert.throws(() => parseCliArgs(['--grant', '--email', '--uid=123']), /non-empty/i);
  assert.throws(() => parseCliArgs(['--grant', '--email=a@b.com', '--unknown']), /unknown/i);
});

test('applyAdminClaim grants and revokes admin claim while preserving existing custom claims', async () => {
  const calls = [];
  const mockAuth = {
    async getUserByEmail(email) {
      calls.push(['getUserByEmail', email]);
      return { uid: 'u-1', email, customClaims: { role: 'beta', admin: false } };
    },
    async getUser(uid) {
      calls.push(['getUser', uid]);
      return { uid, email: 'u@example.com', customClaims: { role: 'beta', admin: true } };
    },
    async setCustomUserClaims(uid, claims) {
      calls.push(['setCustomUserClaims', uid, claims]);
    }
  };

  const grantResult = await applyAdminClaim({
    auth: mockAuth,
    target: { email: 'admin@example.com' },
    action: 'grant'
  });

  assert.equal(grantResult.uid, 'u-1');
  assert.equal(grantResult.email, 'admin@example.com');
  assert.deepEqual(grantResult.claims, { role: 'beta', admin: true });
  assert.deepEqual(calls[1], ['setCustomUserClaims', 'u-1', { role: 'beta', admin: true }]);

  const revokeResult = await applyAdminClaim({
    auth: mockAuth,
    target: { uid: 'u-1' },
    action: 'revoke'
  });

  assert.deepEqual(revokeResult.claims, { role: 'beta' });
  assert.deepEqual(calls[3], ['setCustomUserClaims', 'u-1', { role: 'beta' }]);
});

test('applyAdminClaim inspects claims without mutating and surfaces user lookup errors', async () => {
  let mutated = false;
  const mockAuth = {
    async getUser(uid) {
      if (uid === 'missing') {
        const err = new Error('There is no user record corresponding to the provided identifier.');
        err.code = 'auth/user-not-found';
        throw err;
      }
      return { uid, email: 'op@example.com', customClaims: { admin: true } };
    },
    async setCustomUserClaims() {
      mutated = true;
    }
  };

  const inspectResult = await applyAdminClaim({
    auth: mockAuth,
    target: { uid: 'u-2' },
    action: 'inspect'
  });

  assert.equal(mutated, false);
  assert.deepEqual(inspectResult, {
    action: 'inspect',
    uid: 'u-2',
    email: 'op@example.com',
    claims: { admin: true }
  });

  await assert.rejects(
    () => applyAdminClaim({ auth: mockAuth, target: { uid: 'missing' }, action: 'grant' }),
    /no user record/i
  );
});

test('main executes end-to-end with injected auth client and package.json registers admin:claim script', async () => {
  const logs = [];
  const logger = { log: msg => logs.push(msg), error: msg => logs.push(msg) };
  const mockAuth = {
    async getUserByEmail(email) {
      return { uid: 'uid-admin', email, customClaims: {} };
    },
    async setCustomUserClaims() {}
  };

  const result = await main(['--grant', '--email=alex@example.com'], {}, { auth: mockAuth, logger });
  assert.equal(result.uid, 'uid-admin');
  assert.deepEqual(result.claims, { admin: true });
  assert.ok(logs.some(line => line.includes('uid-admin') && line.includes('grant')));

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['admin:claim'], 'node src/admin-claim-cli.js');
});
