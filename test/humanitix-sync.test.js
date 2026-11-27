import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileCacheStore } from '../src/file-cache.js';
import {
  DEFAULT_DELAY_MS,
  DEFAULT_MAX_FETCHES,
  DEFAULT_MAX_PAGES,
  HUMANITIX_CACHE_TTL_MS,
  parseCliArgs,
  runHumanitixSync
} from '../src/humanitix-sync.js';
import { HUMANITIX_API_SEARCH_URL } from '../src/crawlers/humanitix-crawler.js';
import { getDefaultCrawlers } from '../src/crawler-runner.js';

function makeRawEvent(overrides = {}) {
  return {
    _id: 'hx-101',
    hostname: 'https://events.humanitix.com/',
    slug: 'perth-morning-run',
    name: 'Perth Morning Run',
    timezone: 'Australia/Perth',
    isRecurring: false,
    suspendSales: false,
    offSaleDateIds: [],
    dates: [
      {
        _id: 'd1',
        startDate: '2026-12-03T10:00:00.000Z',
        endDate: '2026-12-03T12:00:00.000Z'
      }
    ],
    eventLocation: {
      type: 'address',
      venueName: 'Kings Park',
      address: 'Fraser Ave, Kings Park WA 6005, Australia',
      addressComponents: [
        { long_name: 'Perth', short_name: 'Perth', types: ['locality'] },
        { long_name: 'Western Australia', short_name: 'WA', types: ['administrative_area_level_1'] },
        { long_name: 'Australia', short_name: 'AU', types: ['country'] },
        { long_name: '6005', short_name: '6005', types: ['postal_code'] }
      ]
    },
    pricing: { minimumPrice: 0, maximumPrice: 0 },
    ...overrides
  };
}

function buildHumanitixHtml(initialEvents, stateKey = 'sk-1') {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        initialEvents,
        initialStateKey: stateKey,
        locale: 'AU',
        geobox: {
          name: 'Perth',
          countryCode: 'AU',
          address: 'Perth WA, Australia',
          latLng: { lat: -31.9505, lng: 115.8605 },
          northeast: { lat: -31.4, lng: 116.4 },
          southwest: { lat: -32.5, lng: 115.5 },
          area: 1234
        }
      }
    }
  })}</script></body></html>`;
}

function createMemoryAdapter() {
  const activities = new Map();
  const organizers = new Map();
  return {
    activities,
    organizers,
    async getAllVenues() { return []; },
    async getAllOrganizers() { return []; },
    async batchUpsertActivities(items) {
      for (const item of items) {
        activities.set(item.id, item);
      }
      return { upserted: items.length };
    },
    async upsertOrganizer(org) {
      organizers.set(org.id, org);
    }
  };
}

test('Humanitix Sync CLI: parseCliArgs applies defaults and parses drip flags', () => {
  const defaults = parseCliArgs([], {});
  assert.equal(defaults.maxFetches, DEFAULT_MAX_FETCHES);
  assert.equal(defaults.maxFetches, 8);
  assert.equal(defaults.maxPages, DEFAULT_MAX_PAGES);
  assert.equal(defaults.maxPages, 3);
  assert.equal(defaults.delayMs, DEFAULT_DELAY_MS);
  assert.equal(defaults.delayMs, 3500);
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.refresh, false);

  const custom = parseCliArgs(
    ['--dry-run', '--refresh', '--max-fetches=4', '--max-pages=2', '--delay-ms=500', '--use-adc', '--project=demo-proj'],
    {}
  );
  assert.equal(custom.dryRun, true);
  assert.equal(custom.refresh, true);
  assert.equal(custom.maxFetches, 4);
  assert.equal(custom.maxPages, 2);
  assert.equal(custom.delayMs, 500);
  assert.equal(custom.useAdc, true);
  assert.equal(custom.project, 'demo-proj');
});

test('Humanitix Sync: 24h cache avoids live fetches and rotates stalest feeds first within --max-fetches budget', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hx-sync-rot-'));
  const cachePath = path.join(tmpDir, 'humanitix-sync-cache.json');
  const cacheStore = createFileCacheStore(cachePath, { flushEvery: 1 });
  const now = new Date('2026-11-27T12:00:00+08:00');

  const feeds = [
    { slug: 'sportsAndFitness', humanitixCategory: 'sportsAndFitness', category: 'sports', priority: 1 },
    { slug: 'healthAndWellness', humanitixCategory: 'healthAndWellness', category: 'health', priority: 1 },
    { slug: 'music', humanitixCategory: 'music', category: 'music', priority: 1 }
  ];

  // sportsAndFitness page 0: fresh (2h old) -> cache hit
  await cacheStore.write('https://humanitix.com/au/search/au--wa--perth?categories=sportsAndFitness', {
    fetchedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    body: buildHumanitixHtml([makeRawEvent({ _id: '101', name: 'Perth Morning Run' })])
  });

  // healthAndWellness page 0: expired (30h old) -> stale
  await cacheStore.write('https://humanitix.com/au/search/au--wa--perth?categories=healthAndWellness', {
    fetchedAt: new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString(),
    body: buildHumanitixHtml([])
  });

  // music page 0: uncached (-Infinity) -> stalest, fetched first!
  const fetched = [];
  const adapter = createMemoryAdapter();

  const summary = await runHumanitixSync({
    adapter,
    cacheStore,
    sleepFn: async () => {},
    randomFn: () => 0.5,
    options: {
      feeds,
      maxPages: 1,
      maxFetches: 1,
      delayMs: 1000,
      now
    },
    fetchFn: async (url) => {
      fetched.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => buildHumanitixHtml([makeRawEvent({ _id: '202', name: 'Freo Live Jazz' })])
      };
    },
    logger: { log() {}, warn() {}, error() {} }
  });

  assert.equal(summary.cacheHits, 1);
  assert.equal(summary.liveFetches, 1);
  assert.equal(summary.stoppedReason, 'max_fetches');
  assert.equal(fetched.length, 1);
  assert.ok(fetched[0].includes('categories=music'));
  assert.equal(adapter.activities.size, 2);
  assert.equal(adapter.organizers.size, 0, 'nameless Humanitix listings must not create /organizers docs');
});

test('Humanitix Sync: circuit breaker trips on HTTP 429/403 without caching error response', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hx-sync-cb-'));
  const cachePath = path.join(tmpDir, 'humanitix-sync-cache.json');
  const cacheStore = createFileCacheStore(cachePath, { flushEvery: 1 });
  const feeds = [
    { slug: 'sportsAndFitness', humanitixCategory: 'sportsAndFitness', category: 'sports', priority: 1 },
    { slug: 'music', humanitixCategory: 'music', category: 'music', priority: 1 }
  ];

  const adapter = createMemoryAdapter();
  const summary = await runHumanitixSync({
    adapter,
    cacheStore,
    sleepFn: async () => {},
    options: {
      feeds,
      maxPages: 1,
      maxFetches: 5,
      now: '2026-11-27T12:00:00+08:00'
    },
    fetchFn: async () => ({ ok: false, status: 429, statusText: 'Too Many Requests' }),
    logger: { log() {}, warn() {}, error() {} }
  });

  assert.equal(summary.circuitBreakerTripped, true);
  assert.equal(summary.rateLimitedResponses, 1);
  assert.equal(summary.liveFetches, 1);
  assert.equal(summary.stoppedReason, 'circuit_breaker');

  const cached = await cacheStore.read('https://humanitix.com/au/search/au--wa--perth?categories=sportsAndFitness');
  assert.equal(cached, null);
});

test('Humanitix Sync: paginates /api/search, caches API page, and respects localOnly default opt-in', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hx-sync-api-'));
  const cachePath = path.join(tmpDir, 'humanitix-sync-cache.json');
  const cacheStore = createFileCacheStore(cachePath, { flushEvery: 1 });
  const feeds = [
    { slug: 'sportsAndFitness', humanitixCategory: 'sportsAndFitness', category: 'sports', priority: 1 }
  ];
  const adapter = createMemoryAdapter();

  const summary = await runHumanitixSync({
    adapter,
    cacheStore,
    sleepFn: async () => {},
    options: {
      feeds,
      maxPages: 2,
      maxFetches: 5,
      now: '2026-11-27T12:00:00+08:00'
    },
    fetchFn: async (url) => {
      if (url === HUMANITIX_API_SEARCH_URL) {
        return {
          ok: true,
          status: 200,
          json: async () => [makeRawEvent({ _id: 'p1-1', name: 'Page 1 Pickleball' })]
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => buildHumanitixHtml([makeRawEvent({ _id: 'p0-1', name: 'Page 0 Tennis' })])
      };
    },
    logger: { log() {}, warn() {}, error() {} }
  });

  assert.equal(summary.liveFetches, 2);
  assert.equal(summary.upserted, 2);
  assert.equal(HUMANITIX_CACHE_TTL_MS, 24 * 60 * 60 * 1000);

  const cachedApiPage = await cacheStore.read('https://humanitix.com/au/search/au--wa--perth?categories=sportsAndFitness#api-page=1');
  assert.ok(cachedApiPage);

  const defaultNames = getDefaultCrawlers().map(c => c.name);
  assert.equal(defaultNames.includes('humanitix'), false);
  const optedInNames = getDefaultCrawlers({ includeHumanitix: true }).map(c => c.name);
  assert.equal(optedInNames.includes('humanitix'), true);
});
