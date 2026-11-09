import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreAdapter } from '../src/firestore-adapter.js';

test('Seam 2: batchUpsertActivities runs safely in dryRun mode without Firestore instance', async () => {
  const adapter = createFirestoreAdapter({ dryRun: true });
  const activities = [
    {
      id: 'stirling_1',
      region_id: 'perth',
      title: 'Sunset Volleyball',
      subcategory: 'volleyball',
      venue: { id: 'venue_beach_qd66s4', name: 'Beach', coordinates: { lat: -31.89, lng: 115.75 }, geohash: 'qd66s4b9x' },
      organizer: { id: 'org_beach_club', name: 'Beach Club' }
    },
    {
      id: 'dlgsc_2',
      region_id: 'perth',
      title: 'Perth Futsal',
      subcategory: 'soccer',
      venue: { id: 'venue_loftus_qd66hd', name: 'Loftus', coordinates: { lat: -31.93, lng: 115.84 }, geohash: 'qd66hd16e' },
      organizer: { id: 'org_futsal_club', name: 'Futsal Club' }
    }
  ];

  const result = await adapter.batchUpsertActivities(activities);

  assert.equal(result.total, 2);
  assert.equal(result.upserted, 2);
  assert.equal(result.dryRun, true);
  assert.equal(result.batches, 1);
  assert.equal(result.failed, 0);
});

test('Seam 2: batchUpsertActivities atomically upserts activities, venues, organizers, and regions using merge: true', async () => {
  const committedBatches = [];
  const setOperations = [];
  const accessedCollections = new Set();

  const mockDb = {
    collection(colName) {
      accessedCollections.add(colName);
      return {
        doc(id) {
          return { id, colName, path: `${colName}/${id}` };
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

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });

  const activities = [
    {
      id: 'stirling_1',
      region_id: 'perth',
      source: 'stirling',
      source_id: '1',
      source_url: 'https://example.com/1',
      title: 'Beach Volleyball',
      category: 'sports',
      subcategory: 'volleyball',
      venue: {
        id: 'venue_scarborough_qd66s4',
        name: 'Scarborough Beach',
        coordinates: { lat: -31.8942, lng: 115.7571 },
        geohash: 'qd66s4b9x'
      },
      organizer: {
        id: 'org_scarborough_club',
        name: 'Scarborough Club'
      },
      schedule: {
        start_date: '2026-11-12',
        end_date: null,
        start_time: '17:30',
        end_time: '19:30',
        recurrence: 'weekly',
        day_of_week: 4
      },
      cost: { is_free: true, display_price: 'Free' },
      demographics: { gender: 'all', age: 'adults' },
      verified: true,
      created_at: '2026-11-01T00:00:00.000Z',
      updated_at: '2026-11-01T00:00:00.000Z'
    }
  ];

  const result = await adapter.batchUpsertActivities(activities);

  assert.equal(result.total, 1);
  assert.equal(result.upserted, 1);
  assert.equal(committedBatches.length, 1);

  // Verifies all 4 canonical collections are upserted atomically in the same batch
  assert.ok(accessedCollections.has('activities'));
  assert.ok(accessedCollections.has('venues'));
  assert.ok(accessedCollections.has('organizers'));
  assert.ok(accessedCollections.has('regions'));

  // Every operation must use { merge: true }
  assert.ok(setOperations.every(op => op.options?.merge === true));

  // Verify paths written
  const writtenPaths = setOperations.map(op => op.docRef.path);
  assert.ok(writtenPaths.includes('activities/stirling_1'));
  assert.ok(writtenPaths.includes('venues/venue_scarborough_qd66s4'));
  assert.ok(writtenPaths.includes('organizers/org_scarborough_club'));
  assert.ok(writtenPaths.includes('regions/perth'));
});

test('Seam 2: batchUpsertActivities chunks writes so no single Firestore batch exceeds batch limit', async () => {
  const committedBatches = [];

  const mockDb = {
    collection(colName) {
      return {
        doc(id) {
          return { id, colName, path: `${colName}/${id}` };
        }
      };
    },
    batch() {
      const ops = [];
      return {
        set(docRef, data, options) {
          ops.push({ docRef, data, options });
        },
        async commit() {
          // Hard guard against Firestore SDK 500 limit
          if (ops.length > 500) {
            throw new Error(`Firestore batch limit exceeded: ${ops.length} writes in one batch`);
          }
          committedBatches.push([...ops]);
        }
      };
    }
  };

  // Set batchSize to 20 operations to thoroughly test chunking boundary
  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false, batchSize: 20 });

  // 15 activities * ~4 entities = ~60 write operations -> should chunk into multiple batches of <= 20 ops
  const activities = Array.from({ length: 15 }, (_, i) => ({
    id: `act_${i}`,
    region_id: 'perth',
    title: `Activity ${i}`,
    subcategory: 'soccer',
    venue: {
      id: `venue_${i}_qd66hd`,
      name: `Venue ${i}`,
      coordinates: { lat: -31.93, lng: 115.84 },
      geohash: 'qd66hd16e'
    },
    organizer: {
      id: `org_${i}`,
      name: `Organizer ${i}`
    },
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  }));

  const result = await adapter.batchUpsertActivities(activities);

  assert.equal(result.total, 15);
  assert.equal(result.upserted, 15);
  assert.ok(result.batches > 1);
  assert.equal(committedBatches.length, result.batches);

  // Every single committed batch must not exceed the batch limit
  for (const batch of committedBatches) {
    assert.ok(batch.length <= 20, `Batch size ${batch.length} exceeded limit of 20`);
    assert.ok(batch.length > 0);
  }
});

test('Seam 2: batchUpsertActivities handles empty list gracefully', async () => {
  const adapter = createFirestoreAdapter({ dryRun: true });
  const result = await adapter.batchUpsertActivities([]);
  assert.equal(result.total, 0);
  assert.equal(result.upserted, 0);
  assert.equal(result.batches, 0);
});

test('Seam 2: batchUpsertActivities captures batch commit failures without crashing', async () => {
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
  const items = [{ id: 'fail_1', title: 'Failing Activity', venue: { id: 'v1', coordinates: { lat: 0, lng: 0 } }, organizer: { id: 'o1' } }];

  const result = await adapter.batchUpsertActivities(items);

  assert.equal(result.total, 1);
  assert.equal(result.upserted, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /Firestore deadline exceeded/);
});

test('Seam 2: initFirestoreFromEnv correctly parses JSON and base64 service account keys', async () => {
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

