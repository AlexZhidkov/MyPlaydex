import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreAdapter } from '../src/firestore-adapter.js';

test('Seam 3: batchUpsertActivities runs safely in dryRun mode without Firestore instance', async () => {
  const adapter = createFirestoreAdapter({ dryRun: true });
  const activities = [
    { id: 'stirling_1', title: 'Sunset Volleyball', sport: 'volleyball' },
    { id: 'dlgsc_2', title: 'Perth Futsal', sport: 'soccer' }
  ];

  const result = await adapter.batchUpsertActivities(activities);

  assert.equal(result.total, 2);
  assert.equal(result.upserted, 2);
  assert.equal(result.dryRun, true);
  assert.equal(result.batches, 1);
  assert.equal(result.failed, 0);
});

test('Seam 3: batchUpsertActivities chunks writes into <=500 doc batches and merges idempotently', async () => {
  const committedBatches = [];
  const setOperations = [];

  // Mock Firestore DB object
  const mockDb = {
    collection(colName) {
      assert.equal(colName, 'activities');
      return {
        doc(id) {
          return { id, path: `activities/${id}` };
        }
      };
    },
    batch() {
      const ops = [];
      return {
        set(docRef, data, options) {
          ops.push({ docRef, data, options });
          setOperations.push({ docRef, data, options });
        },
        async commit() {
          committedBatches.push([...ops]);
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false, batchSize: 500 });

  // Generate 505 items to verify 2 chunks (500 + 5)
  const items = Array.from({ length: 505 }, (_, i) => ({
    id: `act_${i}`,
    title: `Activity ${i}`,
    sport: 'soccer'
  }));

  const result = await adapter.batchUpsertActivities(items);

  assert.equal(result.total, 505);
  assert.equal(result.upserted, 505);
  assert.equal(result.batches, 2);
  assert.equal(committedBatches.length, 2);
  assert.equal(committedBatches[0].length, 500);
  assert.equal(committedBatches[1].length, 5);

  // Verify merge option is used for idempotency
  assert.equal(setOperations[0].options.merge, true);
  assert.equal(setOperations[0].docRef.id, 'act_0');
});

test('Seam 3: batchUpsertActivities handles empty list gracefully', async () => {
  const adapter = createFirestoreAdapter({ dryRun: true });
  const result = await adapter.batchUpsertActivities([]);
  assert.equal(result.total, 0);
  assert.equal(result.upserted, 0);
  assert.equal(result.batches, 0);
});

test('Seam 3: batchUpsertActivities captures batch commit failures without crashing', async () => {
  const failingDb = {
    collection() {
      return { doc(id) { return { id }; } };
    },
    batch() {
      return {
        set() {},
        async commit() {
          throw new Error('Firestore deadline exceeded');
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: failingDb, dryRun: false });
  const items = [{ id: 'fail_1', title: 'Failing Activity' }];

  const result = await adapter.batchUpsertActivities(items);

  assert.equal(result.total, 1);
  assert.equal(result.upserted, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /Firestore deadline exceeded/);
});

test('Seam 3: initFirestoreFromEnv correctly parses JSON and base64 service account keys', async () => {
  const { initFirestoreFromEnv } = await import('../src/firestore-adapter.js');

  // Empty env defaults to dryRun
  const emptyRes = await initFirestoreFromEnv({});
  assert.equal(emptyRes.dryRun, true);
  assert.equal(emptyRes.db, null);

  // Raw JSON
  const jsonKey = JSON.stringify({ project_id: 'perth-sports-dev', private_key: 'test' });
  const jsonRes = await initFirestoreFromEnv({ FIREBASE_SERVICE_ACCOUNT_KEY: jsonKey });
  assert.equal(jsonRes.projectId, 'perth-sports-dev');

  // Base64 encoded
  const b64Key = Buffer.from(jsonKey).toString('base64');
  const b64Res = await initFirestoreFromEnv({ FIREBASE_SERVICE_ACCOUNT_KEY: b64Key });
  assert.equal(b64Res.projectId, 'perth-sports-dev');

  // Corrupt string throws
  await assert.rejects(
    () => initFirestoreFromEnv({ FIREBASE_SERVICE_ACCOUNT_KEY: 'not-valid-json' }),
    /Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY/
  );
});

