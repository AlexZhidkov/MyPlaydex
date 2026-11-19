import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPlacesSync, parseCliArgs, main } from '../src/places-sync.js';

const EXPECTED_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.businessStatus'
].join(',');

test('Seam 1: runPlacesSync queries Pro-tier fields for targeted suburb, filters CLOSED_PERMANENTLY, and classifies venues & organizers', async () => {
  const fetchCalls = [];
  const upsertedVenues = [];
  const upsertedOrganizers = [];

  const mockFetch = async (url, init) => {
    fetchCalls.push({ url, init, body: JSON.parse(init.body) });
    const types = JSON.parse(init.body).includedTypes || [];

    if (types.includes('sports_complex') || types.includes('fitness_center')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            places: [
              {
                id: 'ChIJ_sports_1',
                displayName: { text: 'Scarborough Beach Pool' },
                formattedAddress: '171 The Esplanade, Scarborough WA 6019',
                location: { latitude: -31.8942, longitude: 115.7571 },
                types: ['swimming_pool', 'sports_complex', 'point_of_interest'],
                primaryType: 'swimming_pool',
                businessStatus: 'OPERATIONAL'
              },
              {
                id: 'ChIJ_closed_1',
                displayName: { text: 'Closed Tennis Centre' },
                formattedAddress: '99 Old Rd, Scarborough WA 6019',
                location: { latitude: -31.895, longitude: 115.758 },
                types: ['tennis_court'],
                primaryType: 'tennis_court',
                businessStatus: 'CLOSED_PERMANENTLY'
              }
            ]
          };
        }
      };
    }

    if (types.includes('community_center') || types.includes('cultural_center')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            places: [
              {
                id: 'ChIJ_culture_1',
                displayName: { text: 'Scarborough Community Hall' },
                formattedAddress: '10 Gildercliffe St, Scarborough WA 6019',
                location: { latitude: -31.896, longitude: 115.762 },
                types: ['community_center', 'event_venue'],
                primaryType: 'community_center',
                businessStatus: 'OPERATIONAL'
              }
            ]
          };
        }
      };
    }

    if (types.includes('park')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            places: [
              {
                id: 'ChIJ_park_1',
                displayName: { text: 'Abbett Park' },
                formattedAddress: 'Deanmore Rd, Scarborough WA 6019',
                location: { latitude: -31.892, longitude: 115.765 },
                types: ['park'],
                primaryType: 'park',
                businessStatus: 'OPERATIONAL'
              }
            ]
          };
        }
      };
    }

    if (types.includes('sports_club')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            places: [
              {
                id: 'ChIJ_club_1',
                displayName: { text: 'Scarborough Surf Life Saving Club' },
                formattedAddress: '163 The Esplanade, Scarborough WA 6019',
                location: { latitude: -31.8945, longitude: 115.7568 },
                types: ['sports_club'],
                primaryType: 'sports_club',
                businessStatus: 'OPERATIONAL'
              }
            ]
          };
        }
      };
    }

    return { ok: true, status: 200, async json() { return { places: [] }; } };
  };

  const mockAdapter = {
    isDryRun: () => false,
    async batchUpsertVenues(venues) {
      upsertedVenues.push(...venues);
      return { total: venues.length, upserted: venues.length, failed: 0, batches: 1, errors: [], dryRun: false };
    },
    async batchUpsertOrganizers(organizers) {
      upsertedOrganizers.push(...organizers);
      return { total: organizers.length, upserted: organizers.length, failed: 0, batches: 1, errors: [], dryRun: false };
    }
  };

  const summary = await runPlacesSync({
    adapter: mockAdapter,
    fetchFn: mockFetch,
    apiKey: 'test-places-key',
    cacheStore: { read: async () => null, write: async () => {} },
    options: { suburb: 'Scarborough', entity: 'all', dryRun: false },
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });

  // 3 venue queries + 1 organizer query = 4 requests for 1 suburb
  assert.equal(fetchCalls.length, 4);
  for (const call of fetchCalls) {
    assert.equal(call.url, 'https://places.googleapis.com/v1/places:searchNearby');
    assert.equal(call.init.headers['X-Goog-Api-Key'], 'test-places-key');
    const fieldMask = call.init.headers['X-Goog-FieldMask'];
    assert.equal(fieldMask, EXPECTED_FIELD_MASK);
    assert.equal(fieldMask.includes('websiteUri'), false);
    assert.equal(fieldMask.includes('nationalPhoneNumber'), false);
    assert.equal(fieldMask.includes('regularOpeningHours'), false);
    assert.equal(call.body.locationRestriction.circle.radius, 3500);
  }

  // CLOSED_PERMANENTLY excluded
  assert.equal(upsertedVenues.length, 3);
  assert.equal(upsertedVenues.some(v => v.google_place_id === 'ChIJ_closed_1'), false);

  const pool = upsertedVenues.find(v => v.google_place_id === 'ChIJ_sports_1');
  assert.ok(pool);
  assert.equal(pool.category, 'sports');
  assert.equal(pool.primary_type, 'swimming_pool');
  assert.deepEqual(pool.google_types, ['swimming_pool', 'sports_complex', 'point_of_interest']);
  assert.equal(pool.needs_review, false);
  assert.equal(pool.review_reason, null);
  assert.equal(pool.verified, false);
  assert.equal(pool.source_url, null);

  const hall = upsertedVenues.find(v => v.google_place_id === 'ChIJ_culture_1');
  assert.ok(hall);
  assert.equal(hall.category, 'community');
  assert.deepEqual(hall.subcategories, ['other']);
  assert.equal(hall.needs_review, false);

  const park = upsertedVenues.find(v => v.google_place_id === 'ChIJ_park_1');
  assert.ok(park);
  assert.equal(park.category, 'outdoors');
  assert.deepEqual(park.subcategories, ['other']);

  assert.equal(upsertedOrganizers.length, 1);
  const club = upsertedOrganizers[0];
  assert.equal(club.google_place_id, 'ChIJ_club_1');
  assert.equal(club.primary_type, 'sports_club');
  assert.deepEqual(club.google_types, ['sports_club']);
  assert.equal(club.needs_review, false);
  assert.equal(club.review_reason, null);

  assert.equal(summary.suburbsQueried, 1);
  assert.equal(summary.venuesCount, 3);
  assert.equal(summary.organizersCount, 1);
});

test('Seam 1: runPlacesSync de-overlaps inner-city centroids within 2.0 km on full sweep and respects --limit and --entity', async () => {
  const queriedCentroids = [];

  const mockFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    queriedCentroids.push(body.locationRestriction.circle.center);
    return { ok: true, status: 200, async json() { return { places: [] }; } };
  };

  const mockAdapter = {
    isDryRun: () => true
  };

  // Perth (-31.9505, 115.8605) and Northbridge (-31.9472, 115.8576) are ~0.46 km apart (< 2.0 km),
  // Highgate (-31.9419, 115.8679) is ~1.19 km from Perth (< 2.0 km),
  // East Perth (-31.9566, 115.8748) is ~1.51 km from Perth (< 2.0 km),
  // West Perth (-31.9461, 115.8450) is ~1.54 km from Perth (< 2.0 km),
  // Kings Park (-31.9608, 115.8322) is ~2.90 km from Perth (>= 2.0 km).
  const summary = await runPlacesSync({
    adapter: mockAdapter,
    fetchFn: mockFetch,
    apiKey: 'test-key',
    cacheStore: { read: async () => null, write: async () => {} },
    options: { entity: 'venues', limit: 2, dryRun: true },
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });

  // 2 suburbs * 3 venue queries = 6 requests (no organizer query when entity='venues')
  assert.equal(summary.suburbsQueried, 2);
  assert.equal(queriedCentroids.length, 6);
  // First suburb is Perth, second non-overlapping suburb within >= 2.0km is Kings Park
  assert.equal(queriedCentroids[0].latitude, -31.9505);
  assert.equal(queriedCentroids[3].latitude, -31.9608);
});

test('Seam 1: runPlacesSync reuses local checkpoint cache across runs unless --refresh is passed', async () => {
  let fetchCount = 0;
  const memoryCache = new Map();
  const cacheStore = {
    async read(key) {
      return memoryCache.get(key) || null;
    },
    async write(key, val) {
      memoryCache.set(key, val);
    }
  };

  const mockFetch = async () => {
    fetchCount++;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          places: [
            {
              id: 'ChIJ_cached_venue',
              displayName: { text: 'Subiaco Oval' },
              formattedAddress: 'Subiaco Rd, Subiaco WA 6008',
              location: { latitude: -31.9445, longitude: 115.8300 },
              types: ['stadium'],
              primaryType: 'stadium',
              businessStatus: 'OPERATIONAL'
            }
          ]
        };
      }
    };
  };

  const upsertedBatches = [];
  const mockAdapter = {
    isDryRun: () => false,
    async batchUpsertVenues(venues) {
      upsertedBatches.push(venues);
      return { total: venues.length, upserted: venues.length, failed: 0, batches: 1, errors: [], dryRun: false };
    },
    async batchUpsertOrganizers(organizers) {
      return { total: organizers.length, upserted: organizers.length, failed: 0, batches: 1, errors: [], dryRun: false };
    }
  };

  // Run 1: populates cache (4 requests for 1 suburb)
  const first = await runPlacesSync({
    adapter: mockAdapter,
    fetchFn: mockFetch,
    apiKey: 'test-key',
    cacheStore,
    options: { suburb: 'Subiaco', dryRun: false },
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });
  assert.equal(fetchCount, 4);
  assert.equal(first.cacheHits, 0);

  // Run 2: reuses cache (0 additional requests)
  const second = await runPlacesSync({
    adapter: mockAdapter,
    fetchFn: mockFetch,
    apiKey: 'test-key',
    cacheStore,
    options: { suburb: 'Subiaco', dryRun: false },
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });
  assert.equal(fetchCount, 4);
  assert.equal(second.cacheHits, 1);

  // Run 3: --refresh bypasses cache (+4 requests)
  const third = await runPlacesSync({
    adapter: mockAdapter,
    fetchFn: mockFetch,
    apiKey: 'test-key',
    cacheStore,
    options: { suburb: 'Subiaco', refresh: true, dryRun: false },
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });
  assert.equal(fetchCount, 8);
  assert.equal(third.cacheHits, 0);
});

test('Seam 3: parseCliArgs parses --suburb, --entity, --dry-run, --refresh, --limit, --use-adc, and --project', () => {
  const defaults = parseCliArgs([]);
  assert.deepEqual(defaults, {
    suburb: undefined,
    entity: 'all',
    dryRun: false,
    refresh: false,
    limit: undefined,
    useAdc: false,
    project: 'myplaydex'
  });

  const parsed = parseCliArgs([
    '--suburb=Fremantle',
    '--entity=venues',
    '--dry-run',
    '--refresh',
    '--limit=5',
    '--use-adc',
    '--project=custom-proj'
  ]);
  assert.deepEqual(parsed, {
    suburb: 'Fremantle',
    entity: 'venues',
    dryRun: true,
    refresh: true,
    limit: 5,
    useAdc: true,
    project: 'custom-proj'
  });
});

test('Seam 3: main runs end-to-end in dry-run mode without requiring Firestore credentials and registers sync:places script', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['sync:places'], 'node src/places-sync.js');

  const gitignore = await fs.readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.ok(gitignore.includes('.scratch/places-sync-cache.json'));

  const summary = await main(
    ['--suburb=Perth', '--dry-run', '--entity=organizers'],
    { GOOGLE_PLACES_API_KEY: 'test-key' },
    {
      fetchFn: async () => ({ ok: true, status: 200, async json() { return { places: [] }; } }),
      cacheStore: { read: async () => null, write: async () => {} },
      logger: { log: () => {}, warn: () => {}, error: () => {} }
    }
  );

  assert.equal(summary.dryRun, true);
  assert.equal(summary.suburbsQueried, 1);
  assert.equal(summary.organizersCount, 0);
});

test('Seam 1: runPlacesSync classifies sports primaryType with park in types as sports and preserves cached organizers on --refresh --entity=venues', async () => {
  const memoryCache = new Map([
    ['Perth', {
      sports_recreation: [],
      community_culture_campuses: [],
      parks_outdoors: [],
      organizers: [
        {
          id: 'ChIJ_cached_org',
          displayName: { text: 'Perth City Organizer' },
          formattedAddress: 'Perth WA 6000',
          location: { latitude: -31.9505, longitude: 115.8605 },
          types: ['sports_club'],
          primaryType: 'sports_club',
          businessStatus: 'OPERATIONAL'
        }
      ]
    }]
  ]);

  const cacheStore = {
    async read(key) {
      return memoryCache.get(key) || null;
    },
    async write(key, val) {
      memoryCache.set(key, val);
    }
  };

  const mockFetch = async (url, init) => {
    const types = JSON.parse(init.body).includedTypes || [];
    if (types.includes('sports_complex')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            places: [
              {
                id: 'ChIJ_tennis_in_park',
                displayName: { text: 'Robertson Park Tennis Centre' },
                formattedAddress: '176 Fitzgerald St, Perth WA 6000',
                location: { latitude: -31.943, longitude: 115.859 },
                types: ['tennis_court', 'park', 'point_of_interest'],
                primaryType: 'tennis_court',
                businessStatus: 'OPERATIONAL'
              }
            ]
          };
        }
      };
    }
    return { ok: true, status: 200, async json() { return { places: [] }; } };
  };

  const upsertedVenues = [];
  const mockAdapter = {
    isDryRun: () => false,
    async batchUpsertVenues(venues) {
      upsertedVenues.push(...venues);
      return { total: venues.length, upserted: venues.length, failed: 0, batches: 1, errors: [], dryRun: false };
    }
  };

  await runPlacesSync({
    adapter: mockAdapter,
    fetchFn: mockFetch,
    apiKey: 'test-key',
    cacheStore,
    options: { suburb: 'Perth', entity: 'venues', refresh: true, dryRun: false },
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });

  assert.equal(upsertedVenues.length, 1);
  assert.equal(upsertedVenues[0].category, 'sports');
  assert.deepEqual(upsertedVenues[0].subcategories, ['tennis']);

  // Cached organizers for Perth must be preserved
  const perthCache = memoryCache.get('Perth');
  assert.equal(perthCache.organizers.length, 1);
  assert.equal(perthCache.organizers[0].id, 'ChIJ_cached_org');
});

test('Seam 3: main loads GOOGLE_PLACES_API_KEY from .env when not already set in env', async () => {
  const scratchDir = fileURLToPath(new URL('../.scratch', import.meta.url));
  await fs.mkdir(scratchDir, { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(scratchDir, 'test-env-'));
  const envFilePath = path.join(tmpDir, 'test.env');
  try {
    await fs.writeFile(
      envFilePath,
      '# Comment line\n\nGOOGLE_PLACES_API_KEY="env-file-key"\n',
      'utf8'
    );

    let capturedApiKey = null;
    const env = {};
    const summary = await main(
      ['--suburb=Perth', '--dry-run', '--entity=organizers'],
      env,
      {
        envFilePath,
        fetchFn: async (_url, init) => {
          capturedApiKey = init?.headers?.['X-Goog-Api-Key'] || null;
          return { ok: true, status: 200, async json() { return { places: [] }; } };
        },
        cacheStore: { read: async () => null, write: async () => {} },
        logger: { log: () => {}, warn: () => {}, error: () => {} }
      }
    );

    assert.equal(env.GOOGLE_PLACES_API_KEY, 'env-file-key');
    assert.equal(capturedApiKey, 'env-file-key');
    assert.equal(summary.dryRun, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('main writes timestamped INFO logs to disk when configured with --log-file', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-places-log-'));
  const logFilePath = path.join(tmpDir, 'places-sync.log');

  try {
    const summary = await main(
      ['--suburb=Perth', '--dry-run', '--entity=organizers', `--log-file=${logFilePath}`],
      { GOOGLE_PLACES_API_KEY: 'test-key' },
      {
        fetchFn: async () => ({ ok: true, status: 200, async json() { return { places: [] }; } }),
        cacheStore: { read: async () => null, write: async () => {} },
        logger: { log: () => {}, warn: () => {}, error: () => {} }
      }
    );

    assert.equal(summary.dryRun, true);
    const logContent = await fs.readFile(logFilePath, 'utf8');
    assert.match(logContent, /^\[\d{4}-\d{2}-\d{2}T.*Z\] \[INFO\] \[Places Sync\] Initializing run/m);
    assert.match(logContent, /^\[\d{4}-\d{2}-\d{2}T.*Z\] \[INFO\] \[Places Sync\] Suburbs: 1/m);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});



