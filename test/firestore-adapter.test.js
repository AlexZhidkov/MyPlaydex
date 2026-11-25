import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import { createFirestoreAdapter } from '../src/firestore-adapter.js';
import { parseFirestoreDocument } from '../public/js/app.js';

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

test('Seam 2: batchUpsertActivities atomically upserts activities, organizers, and regions using merge: true without writing to venues', async () => {
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

  // Verifies activities, organizers, and regions are upserted atomically while venues is locked down
  assert.ok(accessedCollections.has('activities'));
  assert.equal(accessedCollections.has('venues'), false);
  assert.ok(accessedCollections.has('organizers'));
  assert.ok(accessedCollections.has('regions'));

  // Every operation must use { merge: true }
  assert.ok(setOperations.every(op => op.options?.merge === true));

  // Verify paths written
  const writtenPaths = setOperations.map(op => op.docRef.path);
  assert.ok(writtenPaths.includes('activities/stirling_1'));
  assert.equal(writtenPaths.includes('venues/venue_scarborough_qd66s4'), false);
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

test('Seam 2: getActivities retrieves existing records via getAll and returns empty map in dryRun', async () => {
  const dryAdapter = createFirestoreAdapter({ dryRun: true });
  const dryResult = await dryAdapter.getActivities(['act_1', 'act_2']);
  assert.equal(dryResult.size, 0);

  const mockDb = {
    collection(colName) {
      return {
        doc(id) {
          return { id, colName };
        }
      };
    },
    async getAll(...docRefs) {
      return docRefs.map(ref => ({
        id: ref.id,
        exists: ref.id === 'act_1',
        data() {
          return { id: ref.id, title: 'Existing Activity', verified: true };
        }
      }));
    }
  };

  const liveAdapter = createFirestoreAdapter({ db: mockDb, dryRun: false });
  const liveResult = await liveAdapter.getActivities(['act_1', 'act_missing']);
  assert.equal(liveResult.size, 1);
  assert.equal(liveResult.has('act_1'), true);
  assert.equal(liveResult.get('act_1').title, 'Existing Activity');
  assert.equal(liveResult.has('act_missing'), false);
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

test('Seam 1: scanActivities retrieves records and supports onlyUnverified filtering', async () => {
  // 1. Dry run without db returns empty array
  const dryAdapter = createFirestoreAdapter({ dryRun: true });
  const dryResults = await dryAdapter.scanActivities();
  assert.deepEqual(dryResults, []);

  // 2. Mock db with activities
  const mockDocs = [
    { id: 'act_1', data: () => ({ id: 'act_1', title: 'Tennis', verified: true, source_url: 'https://tennis.org' }) },
    { id: 'act_2', data: () => ({ id: 'act_2', title: 'Soccer', verified: false, source_url: null, raw_source_url: 'http://broken.soccer' }) },
    { id: 'act_3', data: () => ({ id: 'act_3', title: 'Running', source_url: 'http://run.org' }) } // verified field missing
  ];

  const mockDb = {
    collection(name) {
      assert.equal(name, 'activities');
      return {
        async get() {
          return { docs: mockDocs };
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });

  // Scan all
  const allActivities = await adapter.scanActivities();
  assert.equal(allActivities.length, 3);
  assert.equal(allActivities[0].id, 'act_1');

  // Scan with onlyUnverified
  const unverifiedActivities = await adapter.scanActivities({ onlyUnverified: true });
  assert.equal(unverifiedActivities.length, 2);
  assert.deepEqual(unverifiedActivities.map(a => a.id), ['act_2', 'act_3']);
});

test('Seam 1: batchUpdateActivityUrls updates verified status, source_url, raw_source_url with chunking and merge: true', async () => {
  // 1. Dry run returns counts without writing
  const dryAdapter = createFirestoreAdapter({ dryRun: true });
  const updates = [
    { id: 'act_1', verified: true, source_url: 'https://repaired.org', raw_source_url: 'http://repaired.org' }
  ];
  const dryResult = await dryAdapter.batchUpdateActivityUrls(updates);
  assert.equal(dryResult.total, 1);
  assert.equal(dryResult.updated, 1);
  assert.equal(dryResult.failed, 0);
  assert.equal(dryResult.dryRun, true);

  // 2. Live adapter with mock db
  const committedBatches = [];
  const mockDb = {
    collection(name) {
      assert.equal(name, 'activities');
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
        },
        async commit() {
          committedBatches.push(ops);
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false, batchSize: 2 });
  const multiUpdates = [
    { id: 'act_1', verified: true, source_url: 'https://canonical.com/1', raw_source_url: 'http://raw.com/1' },
    { id: 'act_2', verified: false, source_url: null, raw_source_url: 'http://broken.com/2' },
    { id: 'act_3', verified: true, source_url: 'https://canonical.com/3', raw_source_url: 'http://raw.com/3' }
  ];

  const result = await adapter.batchUpdateActivityUrls(multiUpdates);
  assert.equal(result.total, 3);
  assert.equal(result.updated, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.batches, 2); // 3 items with batchSize 2 -> 2 batches
  assert.equal(committedBatches.length, 2);

  // Check first operation
  const firstOp = committedBatches[0][0];
  assert.equal(firstOp.docRef.id, 'act_1');
  assert.equal(firstOp.options.merge, true);
  assert.equal(firstOp.data.verified, true);
  assert.equal(firstOp.data.source_url, 'https://canonical.com/1');
  assert.equal(firstOp.data.raw_source_url, 'http://raw.com/1');
  assert.ok(firstOp.data.updated_at instanceof Timestamp, 'batchUpdateActivityUrls should write updated_at as Timestamp');
});

test('Seam 2: batchUpsertActivities merges subcategories arrays for shared organizer.id without writing to venues', async () => {
  const writtenDocs = new Map();
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
          for (const op of ops) {
            writtenDocs.set(op.docRef.path, op.data);
          }
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });

  const activities = [
    {
      id: 'stirling_1',
      region_id: 'perth',
      title: 'Loftus Futsal',
      category: 'sports',
      subcategory: 'soccer',
      source_url: 'https://loftus.example.com/futsal',
      raw_source_url: 'https://loftus.example.com/futsal',
      verified: true,
      venue: {
        id: 'venue_loftus_qd66hd',
        name: 'Loftus Centre',
        coordinates: { lat: -31.93, lng: 115.84 },
        geohash: 'qd66hd16e'
      },
      organizer: {
        id: 'org_loftus_rec',
        name: 'Loftus Recreation'
      },
      updated_at: '2026-11-13T00:00:00.000Z'
    },
    {
      id: 'stirling_2',
      region_id: 'perth',
      title: 'Loftus Basketball',
      category: 'sports',
      subcategory: 'basketball',
      source_url: 'https://loftus.example.com/basketball',
      raw_source_url: 'https://loftus.example.com/basketball',
      verified: true,
      venue: {
        id: 'venue_loftus_qd66hd',
        name: 'Loftus Centre',
        coordinates: { lat: -31.93, lng: 115.84 },
        geohash: 'qd66hd16e'
      },
      organizer: {
        id: 'org_loftus_rec',
        name: 'Loftus Recreation'
      },
      updated_at: '2026-11-13T01:00:00.000Z'
    }
  ];

  const result = await adapter.batchUpsertActivities(activities);
  assert.equal(result.upserted, 2);

  assert.equal(writtenDocs.has('venues/venue_loftus_qd66hd'), false);

  const orgDoc = writtenDocs.get('organizers/org_loftus_rec');
  assert.ok(orgDoc);
  assert.deepEqual(orgDoc.subcategories, ['soccer', 'basketball']);
  assert.equal(orgDoc.subcategory, 'soccer');
});

test('Seam 2: batchUpsertOrganizers, batchUpsertVenues, and batchUpsertListings upsert canonical records and merge subcategories', async () => {
  const writtenDocs = new Map();
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
          for (const op of ops) {
            writtenDocs.set(op.docRef.path, op.data);
          }
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });

  await adapter.batchUpsertOrganizers([
    {
      id: 'org_multi_club',
      region_id: 'perth',
      name: 'Multi Sport Club',
      category: 'sports',
      subcategory: 'tennis',
      subcategories: ['tennis'],
      coordinates: { lat: -31.95, lng: 115.86 },
      geohash: 'qd66h1234',
      verified: true,
      source_url: 'https://multisport.org.au',
      raw_source_url: 'https://multisport.org.au',
      updated_at: '2026-11-13T00:00:00.000Z'
    },
    {
      id: 'org_multi_club',
      region_id: 'perth',
      name: 'Multi Sport Club',
      category: 'sports',
      subcategory: 'pickleball',
      subcategories: ['pickleball'],
      coordinates: { lat: -31.95, lng: 115.86 },
      geohash: 'qd66h1234',
      verified: true,
      source_url: 'https://multisport.org.au',
      raw_source_url: 'https://multisport.org.au',
      updated_at: '2026-11-13T01:00:00.000Z'
    }
  ]);

  const orgDoc = writtenDocs.get('organizers/org_multi_club');
  assert.deepEqual(orgDoc.subcategories, ['tennis', 'pickleball']);

  await adapter.batchUpsertVenues([
    {
      id: 'venue_arena_qd66h1',
      region_id: 'perth',
      name: 'Perth Arena',
      category: 'sports',
      subcategory: 'volleyball',
      subcategories: ['volleyball'],
      coordinates: { lat: -31.95, lng: 115.86 },
      geohash: 'qd66h1234',
      verified: true,
      source_url: 'https://arena.org.au',
      raw_source_url: 'https://arena.org.au',
      updated_at: '2026-11-13T00:00:00.000Z'
    },
    {
      id: 'venue_arena_qd66h1',
      region_id: 'perth',
      name: 'Perth Arena',
      category: 'sports',
      subcategory: 'basketball',
      subcategories: ['basketball'],
      coordinates: { lat: -31.95, lng: 115.86 },
      geohash: 'qd66h1234',
      verified: true,
      source_url: 'https://arena.org.au',
      raw_source_url: 'https://arena.org.au',
      updated_at: '2026-11-13T01:00:00.000Z'
    }
  ]);

  const venueDoc = writtenDocs.get('venues/venue_arena_qd66h1');
  assert.deepEqual(venueDoc.subcategories, ['volleyball', 'basketball']);

  // Mixed batchUpsertListings handles organizer, venue, and activity together
  const mixedRes = await adapter.batchUpsertListings([
    {
      id: 'org_mixed_club',
      region_id: 'perth',
      name: 'Mixed Club',
      subcategory: 'running',
      subcategories: ['running'],
      coordinates: { lat: -31.95, lng: 115.86 },
      geohash: 'qd66h1234'
    },
    {
      id: 'venue_mixed_qd66h1',
      region_id: 'perth',
      name: 'Mixed Venue',
      subcategory: 'walking',
      subcategories: ['walking'],
      coordinates: { lat: -31.95, lng: 115.86 },
      geohash: 'qd66h1234'
    }
  ]);
  assert.equal(mixedRes.upserted, 2);
  assert.ok(writtenDocs.has('organizers/org_mixed_club'));
  assert.ok(writtenDocs.has('venues/venue_mixed_qd66h1'));
});

test('Seam 2: getListings, scanOrganizers, scanVenues, and batchUpdateListingUrls route across activities, organizers, and venues', async () => {
  const store = {
    activities: new Map([
      ['stirling_1', { id: 'stirling_1', title: 'Tennis', verified: true, source_url: 'https://tennis.org' }]
    ]),
    organizers: new Map([
      ['org_club_a', { id: 'org_club_a', name: 'Club A', verified: false, source_url: null, raw_source_url: 'http://cluba.org' }]
    ]),
    venues: new Map([
      ['venue_park_qd66h1', { id: 'venue_park_qd66h1', name: 'Park Venue', verified: true, source_url: 'https://park.org' }]
    ])
  };

  const mockDb = {
    collection(colName) {
      return {
        doc(id) {
          return { id, colName, path: `${colName}/${id}` };
        },
        async get() {
          const map = store[colName] || new Map();
          return {
            docs: Array.from(map.values()).map(d => ({
              id: d.id,
              data: () => d
            }))
          };
        }
      };
    },
    async getAll(...docRefs) {
      return docRefs.map(ref => {
        const doc = store[ref.colName]?.get(ref.id);
        return {
          id: ref.id,
          exists: Boolean(doc),
          data: () => doc
        };
      });
    },
    batch() {
      const ops = [];
      return {
        set(docRef, data, options) {
          ops.push({ docRef, data, options });
        },
        async commit() {
          for (const op of ops) {
            const colMap = store[op.docRef.colName];
            if (colMap) {
              const existing = colMap.get(op.docRef.id) || {};
              colMap.set(op.docRef.id, { ...existing, ...op.data });
            }
          }
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });

  const docs = await adapter.getListings(['stirling_1', 'org_club_a', 'venue_park_qd66h1']);
  assert.equal(docs.size, 3);
  assert.equal(docs.get('org_club_a').name, 'Club A');
  assert.equal(docs.get('venue_park_qd66h1').name, 'Park Venue');

  const orgs = await adapter.scanOrganizers({ onlyUnverified: true });
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0].id, 'org_club_a');

  const venues = await adapter.scanVenues();
  assert.equal(venues.length, 1);
  assert.equal(venues[0].id, 'venue_park_qd66h1');

  const updateRes = await adapter.batchUpdateListingUrls([
    { id: 'org_club_a', verified: true, source_url: 'https://cluba.org', raw_source_url: 'http://cluba.org' },
    { id: 'venue_park_qd66h1', verified: false, source_url: null, raw_source_url: 'https://park.org' }
  ]);
  assert.equal(updateRes.updated, 2);
  assert.equal(store.organizers.get('org_club_a').verified, true);
  assert.equal(store.organizers.get('org_club_a').source_url, 'https://cluba.org');
  assert.equal(store.venues.get('venue_park_qd66h1').verified, false);
  assert.equal(store.venues.get('venue_park_qd66h1').source_url, null);

  // Separate batchUpsertOrganizers call merges subcategories with the existing Firestore doc
  await adapter.batchUpsertOrganizers([
    {
      id: 'org_club_a',
      region_id: 'perth',
      name: 'Club A',
      subcategory: 'volleyball',
      subcategories: ['volleyball']
    }
  ]);
  await adapter.batchUpsertOrganizers([
    {
      id: 'org_club_a',
      region_id: 'perth',
      name: 'Club A',
      subcategory: 'basketball',
      subcategories: ['basketball']
    }
  ]);
  assert.deepEqual(store.organizers.get('org_club_a').subcategories, ['volleyball', 'basketball']);
});

test('Seam 2: batchUpsertActivities persists expire_at on /activities documents for one-off and weekly recurring activities', async () => {
  const writtenActivities = new Map();

  const mockDb = {
    collection(colName) {
      return {
        doc(id) {
          return { id, colName };
        }
      };
    },
    batch() {
      const ops = [];
      return {
        set(docRef, data) {
          ops.push({ docRef, data });
        },
        async commit() {
          for (const op of ops) {
            if (op.docRef.colName === 'activities') {
              writtenActivities.set(op.docRef.id, op.data);
            }
          }
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });

  await adapter.batchUpsertActivities([
    {
      id: 'stirling_oneoff',
      region_id: 'perth',
      title: 'One-off Tournament',
      subcategory: 'tennis',
      venue: { id: 'venue_1_qd66h1', name: 'Court 1', coordinates: { lat: -31.95, lng: 115.86 }, geohash: 'qd66h1234' },
      organizer: { id: 'org_1', name: 'Club 1' },
      schedule: { start_date: '2026-11-15', end_date: '2026-11-16', recurrence: 'none' }
    },
    {
      id: 'stirling_weekly',
      region_id: 'perth',
      title: 'Weekly Social Hit',
      subcategory: 'tennis',
      venue: { id: 'venue_1_qd66h1', name: 'Court 1', coordinates: { lat: -31.95, lng: 115.86 }, geohash: 'qd66h1234' },
      organizer: { id: 'org_1', name: 'Club 1' },
      schedule: { start_date: '2026-11-15', end_date: null, recurrence: 'weekly' }
    }
  ]);

  const oneOffDoc = writtenActivities.get('stirling_oneoff');
  assert.ok(oneOffDoc.expire_at instanceof Timestamp, 'non-recurring activity should persist expire_at Timestamp');
  assert.equal(oneOffDoc.expire_at.toDate().toISOString(), '2026-11-17T16:00:00.000Z');

  const weeklyDoc = writtenActivities.get('stirling_weekly');
  assert.equal(weeklyDoc.expire_at, null, 'weekly recurring activity should persist expire_at: null');
});

test('Seam 2: batchUpsertActivities writes created_at and updated_at as native Firestore Timestamps across activities, organizers, and regions', async () => {
  const writtenByCollection = {
    activities: new Map(),
    organizers: new Map(),
    regions: new Map()
  };

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
          for (const op of ops) {
            if (writtenByCollection[op.docRef.colName]) {
              writtenByCollection[op.docRef.colName].set(op.docRef.id, op.data);
            }
          }
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });
  const createdIso = '2026-11-01T00:00:00.000Z';
  const updatedIso = '2026-11-10T12:30:00.000Z';

  await adapter.batchUpsertActivities([
    {
      id: 'stirling_ts_1',
      region_id: 'perth',
      title: 'Social Tennis',
      subcategory: 'tennis',
      venue: { id: 'venue_1_qd66h1', name: 'Court 1', coordinates: { lat: -31.95, lng: 115.86 }, geohash: 'qd66h1234' },
      organizer: { id: 'org_1', name: 'Club 1' },
      schedule: { start_date: '2026-11-15', end_date: null, recurrence: 'weekly' },
      created_at: createdIso,
      updated_at: updatedIso
    }
  ]);

  for (const [colName, docs] of Object.entries(writtenByCollection)) {
    assert.equal(docs.size, 1, `Expected 1 document in ${colName}`);
    const doc = Array.from(docs.values())[0];
    assert.ok(doc.created_at instanceof Timestamp, `${colName}.created_at must be a Firestore Timestamp`);
    assert.ok(doc.updated_at instanceof Timestamp, `${colName}.updated_at must be a Firestore Timestamp`);
    assert.equal(doc.updated_at.toDate().toISOString(), updatedIso, `${colName}.updated_at should preserve timestamp`);
  }

  assert.equal(
    writtenByCollection.activities.get('stirling_ts_1').created_at.toDate().toISOString(),
    createdIso
  );
});

test('Seam 2: batchUpsertOrganizers and batchUpsertVenues write native Timestamps and preserve created_at on merge', async () => {
  const existingCreated = Timestamp.fromDate(new Date('2026-10-01T00:00:00.000Z'));
  const existingUpdated = Timestamp.fromDate(new Date('2026-10-05T00:00:00.000Z'));
  const writtenDocs = new Map();

  const mockDb = {
    collection(colName) {
      return {
        doc(id) {
          return { id, colName, path: `${colName}/${id}` };
        }
      };
    },
    async getAll(...docRefs) {
      return docRefs.map((ref) => {
        if (ref.path === 'organizers/org_club_a') {
          return {
            exists: true,
            id: ref.id,
            data: () => ({
              id: 'org_club_a',
              region_id: 'perth',
              name: 'Club A',
              subcategory: 'tennis',
              subcategories: ['tennis'],
              created_at: existingCreated,
              updated_at: existingUpdated
            })
          };
        }
        if (ref.path === 'venues/venue_court_1_qd66h1') {
          return {
            exists: true,
            id: ref.id,
            data: () => ({
              id: 'venue_court_1_qd66h1',
              region_id: 'perth',
              name: 'Court 1',
              subcategory: 'tennis',
              subcategories: ['tennis'],
              created_at: '2026-09-15T00:00:00.000Z',
              updated_at: '2026-09-20T00:00:00.000Z'
            })
          };
        }
        return { exists: false, id: ref.id, data: () => undefined };
      });
    },
    batch() {
      const ops = [];
      return {
        set(docRef, data, options) {
          ops.push({ docRef, data, options });
        },
        async commit() {
          for (const op of ops) {
            writtenDocs.set(op.docRef.path, op.data);
          }
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });
  const nextUpdatedIso = '2026-11-12T08:00:00.000Z';

  await adapter.batchUpsertOrganizers([
    {
      id: 'org_club_a',
      region_id: 'perth',
      name: 'Club A',
      subcategory: 'pickleball',
      subcategories: ['pickleball'],
      coordinates: { lat: -31.95, lng: 115.86 },
      geohash: 'qd66h1234',
      updated_at: nextUpdatedIso
    }
  ]);

  await adapter.batchUpsertVenues([
    {
      id: 'venue_court_1_qd66h1',
      region_id: 'perth',
      name: 'Court 1',
      subcategory: 'tennis',
      subcategories: ['tennis'],
      coordinates: { lat: -31.95, lng: 115.86 },
      geohash: 'qd66h1234',
      updated_at: nextUpdatedIso
    }
  ]);

  const mergedOrg = writtenDocs.get('organizers/org_club_a');
  assert.ok(mergedOrg.created_at instanceof Timestamp);
  assert.ok(mergedOrg.updated_at instanceof Timestamp);
  assert.equal(mergedOrg.created_at.toDate().toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(mergedOrg.updated_at.toDate().toISOString(), nextUpdatedIso);

  const venueDoc = writtenDocs.get('venues/venue_court_1_qd66h1');
  assert.ok(venueDoc.created_at instanceof Timestamp);
  assert.ok(venueDoc.updated_at instanceof Timestamp);
  assert.equal(venueDoc.created_at.toDate().toISOString(), '2026-09-15T00:00:00.000Z');
  assert.equal(venueDoc.updated_at.toDate().toISOString(), nextUpdatedIso);
});

test('Integration: Timestamp fields persisted by adapter round-trip through REST timestampValue deserialization', async () => {
  const writtenActivities = new Map();
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
        set(docRef, data) {
          ops.push({ docRef, data });
        },
        async commit() {
          for (const op of ops) {
            if (op.docRef.colName === 'activities') {
              writtenActivities.set(op.docRef.id, op.data);
            }
          }
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });
  await adapter.batchUpsertActivities([
    {
      id: 'stirling_roundtrip',
      region_id: 'perth',
      title: 'Round-Trip Basketball',
      subcategory: 'basketball',
      venue: { id: 'venue_1_qd66h1', name: 'Court 1', coordinates: { lat: -31.95, lng: 115.86 }, geohash: 'qd66h1234' },
      organizer: { id: 'org_1', name: 'Club 1' },
      schedule: { start_date: '2026-11-15', end_date: null, recurrence: 'weekly' },
      created_at: '2026-11-01T00:00:00.000Z',
      updated_at: '2026-11-12T06:15:00.000Z'
    }
  ]);

  const persisted = writtenActivities.get('stirling_roundtrip');
  const restDoc = {
    name: 'projects/myplaydex/databases/(default)/documents/activities/stirling_roundtrip',
    fields: {
      id: { stringValue: persisted.id },
      title: { stringValue: persisted.title },
      created_at: { timestampValue: persisted.created_at.toDate().toISOString() },
      updated_at: { timestampValue: persisted.updated_at.toDate().toISOString() }
    }
  };

  const clientDoc = parseFirestoreDocument(restDoc);
  assert.ok(clientDoc.created_at instanceof Date);
  assert.ok(clientDoc.updated_at instanceof Date);
  assert.equal(clientDoc.created_at.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(clientDoc.updated_at.toISOString(), '2026-11-12T06:15:00.000Z');
});

test('Seam 2: batchUpsertVenues and batchUpsertOrganizers deduplicate by google_place_id and merge subcategories onto existing doc ID', async () => {
  const store = {
    venues: new Map([
      ['venue_old_arena_name_qd66d1', {
        id: 'venue_old_arena_name_qd66d1',
        name: 'Old Arena Name',
        google_place_id: 'ChIJ_arena_123',
        category: 'sports',
        subcategory: 'basketball',
        subcategories: ['basketball'],
        needs_review: false,
        review_reason: null
      }]
    ]),
    organizers: new Map([
      ['org_old_club_name', {
        id: 'org_old_club_name',
        name: 'Old Club Name',
        google_place_id: 'ChIJ_club_456',
        category: 'sports',
        subcategory: 'volleyball',
        subcategories: ['volleyball'],
        needs_review: false,
        review_reason: null
      }]
    ])
  };

  const mockDb = {
    collection(colName) {
      return {
        doc(id) {
          return { id, colName, path: `${colName}/${id}` };
        },
        where(field, op, value) {
          return {
            async get() {
              const colMap = store[colName] || new Map();
              const matched = [];
              for (const [docId, data] of colMap.entries()) {
                if (op === '==' && data[field] === value) {
                  matched.push({ id: docId, exists: true, data: () => ({ ...data }) });
                } else if (op === 'in' && Array.isArray(value) && value.includes(data[field])) {
                  matched.push({ id: docId, exists: true, data: () => ({ ...data }) });
                }
              }
              return { docs: matched };
            }
          };
        }
      };
    },
    async getAll(...docRefs) {
      return docRefs.map(ref => {
        const data = store[ref.colName]?.get(ref.id);
        return data
          ? { id: ref.id, exists: true, data: () => ({ ...data }) }
          : { id: ref.id, exists: false, data: () => undefined };
      });
    },
    batch() {
      const ops = [];
      return {
        set(docRef, data) {
          ops.push({ docRef, data });
        },
        async commit() {
          for (const op of ops) {
            if (!store[op.docRef.colName]) store[op.docRef.colName] = new Map();
            store[op.docRef.colName].set(op.docRef.id, op.data);
          }
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });

  await adapter.batchUpsertVenues([
    {
      id: 'venue_renamed_arena_qd66d2',
      name: 'Renamed Arena',
      google_place_id: 'ChIJ_arena_123',
      category: 'sports',
      subcategory: 'volleyball',
      subcategories: ['volleyball'],
      needs_review: false,
      review_reason: null
    }
  ]);

  await adapter.batchUpsertOrganizers([
    {
      id: 'org_renamed_club',
      source: 'google_places',
      name: 'Renamed Club',
      google_place_id: 'ChIJ_club_456',
      category: 'sports',
      subcategory: 'tennis',
      subcategories: ['tennis'],
      needs_review: false,
      review_reason: null
    }
  ]);

  // No duplicate documents created under new slug IDs
  assert.equal(store.venues.size, 1);
  assert.equal(store.venues.has('venue_renamed_arena_qd66d2'), false);
  const updatedVenue = store.venues.get('venue_old_arena_name_qd66d1');
  assert.equal(updatedVenue.id, 'venue_old_arena_name_qd66d1');
  assert.equal(updatedVenue.name, 'Renamed Arena');
  assert.deepEqual(updatedVenue.subcategories, ['basketball', 'volleyball']);

  assert.equal(store.organizers.size, 1);
  assert.equal(store.organizers.has('org_renamed_club'), false);
  const updatedOrg = store.organizers.get('org_old_club_name');
  assert.equal(updatedOrg.id, 'org_old_club_name');
  assert.equal(updatedOrg.name, 'Renamed Club');
  assert.deepEqual(updatedOrg.subcategories, ['volleyball', 'tennis']);
});

test('Seam 2: batchUpsertRecords preserves needs_review: false and curated fields on human-approved /organizers and /activities', async () => {
  const store = {
    activities: new Map([
      ['stirling_approved_1', {
        id: 'stirling_approved_1',
        region_id: 'perth',
        title: 'Curated Beach Volleyball',
        name: 'Curated Beach Volleyball',
        address: 'Curated Esplanade, Scarborough WA 6019',
        coordinates: { lat: -31.8942, lng: 115.7571 },
        google_place_id: 'ChIJCuratedActivityPlace',
        subcategory: 'volleyball',
        subcategories: ['volleyball'],
        venue: {
          id: 'venue_scarborough_canonical',
          name: 'Scarborough Beach Amphitheatre',
          coordinates: { lat: -31.8942, lng: 115.7571 },
          geohash: 'qd66s4b9x',
          google_place_id: 'ChIJCanonicalVenue1'
        },
        organizer: {
          id: 'org_curated_club',
          name: 'Curated Club Name'
        },
        needs_review: false,
        review_reason: null,
        created_at: Timestamp.fromDate(new Date('2026-10-01T00:00:00.000Z')),
        updated_at: Timestamp.fromDate(new Date('2026-10-15T00:00:00.000Z'))
      }]
    ]),
    organizers: new Map([
      ['org_curated_club', {
        id: 'org_curated_club',
        region_id: 'perth',
        name: 'Curated Club Name',
        address: '100 Curated Way, Subiaco WA 6008',
        coordinates: { lat: -31.944, lng: 115.838 },
        geohash: 'qd66h8xyz',
        google_place_id: 'ChIJCuratedOrgPlace',
        subcategory: 'volleyball',
        subcategories: ['volleyball'],
        needs_review: false,
        review_reason: null,
        created_at: Timestamp.fromDate(new Date('2026-10-01T00:00:00.000Z')),
        updated_at: Timestamp.fromDate(new Date('2026-10-15T00:00:00.000Z'))
      }]
    ]),
    venues: new Map(),
    regions: new Map()
  };

  const mockDb = {
    collection(colName) {
      return {
        doc(id) {
          return { id, colName, path: `${colName}/${id}` };
        }
      };
    },
    async getAll(...docRefs) {
      return docRefs.map(ref => {
        const data = store[ref.colName]?.get(ref.id);
        return { id: ref.id, exists: Boolean(data), data: () => data };
      });
    },
    batch() {
      const ops = [];
      return {
        set(docRef, data) {
          ops.push({ docRef, data });
        },
        async commit() {
          for (const op of ops) {
            store[op.docRef.colName]?.set(op.docRef.id, op.data);
          }
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });

  await adapter.batchUpsertListings([
    {
      id: 'stirling_approved_1',
      region_id: 'perth',
      source: 'stirling',
      source_id: 'approved_1',
      title: 'Raw Crawled Title',
      name: 'Raw Crawled Name',
      address: 'Raw Unmatched Address',
      coordinates: { lat: -31.9000, lng: 115.8000 },
      google_place_id: 'ChIJWrongPlace',
      subcategory: 'volleyball',
      subcategories: ['volleyball', 'beach_volleyball'],
      venue: {
        id: null,
        name: 'Raw Unmatched Venue',
        coordinates: { lat: -31.9000, lng: 115.8000 },
        geohash: 'qd66aaaaa'
      },
      organizer: {
        id: 'org_curated_club',
        name: 'Raw Crawled Org Name'
      },
      needs_review: true,
      review_reason: 'unmatched_venue',
      schedule: { start_date: '2026-11-20', end_date: null, recurrence: 'weekly' },
      verified: true,
      source_url: 'https://example.com/approved',
      raw_source_url: 'https://example.com/approved',
      updated_at: '2026-11-18T00:00:00.000Z'
    },
    {
      id: 'org_curated_club',
      entity_type: 'organizer',
      region_id: 'perth',
      name: 'Raw Crawled Org Name',
      address: 'Raw Crawled Org Address',
      coordinates: { lat: -31.999, lng: 115.999 },
      geohash: 'qd66zzzzz',
      google_place_id: null,
      subcategory: 'tennis',
      subcategories: ['tennis'],
      needs_review: true,
      review_reason: 'crawler_created',
      updated_at: '2026-11-18T00:00:00.000Z'
    }
  ]);

  const savedActivity = store.activities.get('stirling_approved_1');
  assert.equal(savedActivity.needs_review, false);
  assert.equal(savedActivity.review_reason, null);
  assert.equal(savedActivity.venue.id, 'venue_scarborough_canonical');
  assert.equal(savedActivity.venue.name, 'Scarborough Beach Amphitheatre');
  assert.equal(savedActivity.venue.google_place_id, 'ChIJCanonicalVenue1');
  assert.equal(savedActivity.organizer.id, 'org_curated_club');
  assert.equal(savedActivity.organizer.name, 'Curated Club Name');
  assert.equal(savedActivity.name, 'Curated Beach Volleyball');
  assert.equal(savedActivity.address, 'Curated Esplanade, Scarborough WA 6019');
  assert.deepEqual(savedActivity.coordinates, { lat: -31.8942, lng: 115.7571 });
  assert.equal(savedActivity.google_place_id, 'ChIJCuratedActivityPlace');

  const savedOrg = store.organizers.get('org_curated_club');
  assert.equal(savedOrg.needs_review, false);
  assert.equal(savedOrg.review_reason, null);
  assert.equal(savedOrg.name, 'Curated Club Name');
  assert.equal(savedOrg.address, '100 Curated Way, Subiaco WA 6008');
  assert.deepEqual(savedOrg.coordinates, { lat: -31.944, lng: 115.838 });
  assert.equal(savedOrg.google_place_id, 'ChIJCuratedOrgPlace');
  assert.deepEqual(savedOrg.subcategories, ['volleyball', 'tennis']);
  assert.equal(store.venues.size, 0);
});

test('batchApplyActivityDeduplication respects dryRun, handles empty inputs, chunks sets before deletes within batchSize, and converts audit/expire timestamps', async () => {
  const dryAdapter = createFirestoreAdapter({ dryRun: true });
  const emptyRes = await dryAdapter.batchApplyActivityDeduplication({ updates: [], deleteIds: [] });
  assert.deepEqual(emptyRes, { updated: 0, deleted: 0, failed: 0, batches: 0, errors: [], dryRun: true });

  const dryRes = await dryAdapter.batchApplyActivityDeduplication({
    updates: [{ id: 'act_1', title: 'Activity 1' }],
    deleteIds: ['act_2', 'act_1']
  });
  assert.equal(dryRes.updated, 1);
  assert.equal(dryRes.deleted, 1);
  assert.equal(dryRes.dryRun, true);
  assert.equal(dryRes.batches, 1);

  const committedBatches = [];
  const operationsLog = [];
  const mockDb = {
    collection(colName) {
      assert.equal(colName, 'activities');
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
          ops.push({ type: 'set', docRef, data, options });
          operationsLog.push({ type: 'set', id: docRef.id, data, options });
        },
        delete(docRef) {
          ops.push({ type: 'delete', docRef });
          operationsLog.push({ type: 'delete', id: docRef.id });
        },
        async commit() {
          if (ops.length > 4) {
            throw new Error(`Batch limit exceeded: ${ops.length}`);
          }
          committedBatches.push([...ops]);
        }
      };
    }
  };

  const liveAdapter = createFirestoreAdapter({ db: mockDb, dryRun: false, batchSize: 4 });
  const expireDate = new Date('2026-12-10T16:00:00.000Z');
  const res = await liveAdapter.batchApplyActivityDeduplication({
    updates: [
      { id: 'survivor_1', title: 'Survivor 1', expire_at: expireDate, _private: 'strip-me' },
      { id: 'survivor_2', title: 'Survivor 2', expire_at: null },
      { id: 'survivor_3', title: 'Survivor 3' }
    ],
    deleteIds: ['dup_1', 'dup_2', 'dup_2', 'survivor_1', 'dup_3']
  });

  assert.equal(res.dryRun, false);
  assert.equal(res.failed, 0);
  assert.equal(res.updated, 3);
  assert.equal(res.deleted, 3);
  assert.equal(res.batches, 2);
  assert.equal(committedBatches.length, 2);
  assert.equal(committedBatches[0].length, 4);
  assert.equal(committedBatches[1].length, 2);

  // Sets precede deletes and survivor_1 is never deleted
  assert.deepEqual(
    operationsLog.map(o => `${o.type}:${o.id}`),
    ['set:survivor_1', 'set:survivor_2', 'set:survivor_3', 'delete:dup_1', 'delete:dup_2', 'delete:dup_3']
  );

  const firstSet = operationsLog[0];
  assert.equal(firstSet.options.merge, true);
  assert.equal('_private' in firstSet.data, false);
  assert.ok(firstSet.data.created_at instanceof Timestamp);
  assert.ok(firstSet.data.updated_at instanceof Timestamp);
  assert.ok(firstSet.data.expire_at instanceof Timestamp);
  assert.equal(firstSet.data.expire_at.toDate().toISOString(), '2026-12-10T16:00:00.000Z');
});

test('batchApplyActivityDeduplication coerces ISO expire_at and Timestamp-like created_at, and aborts delete chunks if a set chunk fails', async () => {
  const committedDocs = [];
  const committedDeletes = [];
  let commitCount = 0;

  const failingDb = {
    collection() {
      return { doc: id => ({ id }) };
    },
    batch() {
      const ops = [];
      return {
        set(docRef, data) {
          ops.push({ type: 'set', id: docRef.id, data });
        },
        delete(docRef) {
          ops.push({ type: 'delete', id: docRef.id });
        },
        async commit() {
          commitCount += 1;
          if (commitCount === 1) {
            for (const op of ops) {
              if (op.type === 'set') committedDocs.push(op);
            }
            return;
          }
          if (commitCount === 2) {
            throw new Error('Batch 2 write failed');
          }
          for (const op of ops) {
            if (op.type === 'delete') committedDeletes.push(op.id);
          }
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: failingDb, dryRun: false, batchSize: 4 });
  const createdMs = Date.parse('2026-10-01T00:00:00.000Z');
  const res = await adapter.batchApplyActivityDeduplication({
    updates: [
      {
        id: 's1',
        title: 'S1',
        created_at: { toMillis: () => createdMs },
        expire_at: '2026-12-15T16:00:00.000Z'
      },
      { id: 's2', title: 'S2' },
      { id: 's3', title: 'S3' },
      { id: 's4', title: 'S4' },
      { id: 's5', title: 'S5' }
    ],
    deleteIds: ['d1', 'd2', 'd3', 'd4']
  });

  assert.equal(committedDocs[0].data.created_at.toMillis(), createdMs);
  assert.ok(committedDocs[0].data.expire_at instanceof Timestamp);
  assert.equal(committedDocs[0].data.expire_at.toDate().toISOString(), '2026-12-15T16:00:00.000Z');
  assert.equal(res.updated, 4);
  assert.equal(res.deleted, 0);
  assert.equal(res.failed, 5);
  assert.equal(committedDeletes.length, 0);
  assert.match(res.errors[0].message, /Batch 2 write failed/);
});





