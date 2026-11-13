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
  assert.equal(typeof firstOp.data.updated_at, 'string');
});

test('Seam 2: batchUpsertActivities merges subcategories arrays for shared organizer.id and venue.id', async () => {
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

  const venueDoc = writtenDocs.get('venues/venue_loftus_qd66hd');
  assert.ok(venueDoc);
  assert.deepEqual(venueDoc.subcategories, ['soccer', 'basketball']);
  assert.equal(venueDoc.subcategory, 'soccer');

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


