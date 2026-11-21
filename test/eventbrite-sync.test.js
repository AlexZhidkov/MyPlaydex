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
  EVENTBRITE_CACHE_TTL_MS,
  main,
  parseCliArgs,
  runEventbriteSync
} from '../src/eventbrite-sync.js';
import { getDefaultCrawlers } from '../src/crawler-runner.js';

function buildEventbriteHtml(events, pageCount = 1) {
  return `
    <html>
      <body>
        <script>
          window.__SERVER_DATA__ = ${JSON.stringify({
            search_data: {
              events: {
                pagination: { page_count: pageCount },
                results: events
              }
            }
          })};
        </script>
      </body>
    </html>
  `;
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

test('Eventbrite Sync CLI: parseCliArgs applies defaults and parses drip flags', () => {
  const defaults = parseCliArgs([], {});
  assert.equal(defaults.maxFetches, DEFAULT_MAX_FETCHES);
  assert.equal(defaults.maxFetches, 8);
  assert.equal(defaults.maxPages, DEFAULT_MAX_PAGES);
  assert.equal(defaults.maxPages, 5);
  assert.equal(defaults.delayMs, DEFAULT_DELAY_MS);
  assert.equal(defaults.delayMs, 3500);
  assert.equal(defaults.dryRun, false);
  assert.equal(defaults.refresh, false);

  const custom = parseCliArgs(
    ['--dry-run', '--refresh', '--max-fetches=3', '--max-pages=2', '--delay-ms=1000', '--use-adc', '--project=demo-proj'],
    {}
  );
  assert.equal(custom.dryRun, true);
  assert.equal(custom.refresh, true);
  assert.equal(custom.maxFetches, 3);
  assert.equal(custom.maxPages, 2);
  assert.equal(custom.delayMs, 1000);
  assert.equal(custom.useAdc, true);
  assert.equal(custom.project, 'demo-proj');
});

test('Eventbrite Sync: 24h cache avoids live fetches and rotates stalest feeds/pages first within --max-fetches budget', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eb-sync-rot-'));
  const cachePath = path.join(tmpDir, 'eventbrite-sync-cache.json');
  const cacheStore = createFileCacheStore(cachePath, { flushEvery: 1 });
  const now = new Date('2026-11-21T12:00:00+08:00');

  const feeds = [
    { slug: 'sports', url: 'https://www.eventbrite.com.au/d/australia--perth/sports--events/', category: 'sports', priority: 1 },
    { slug: 'health', url: 'https://www.eventbrite.com.au/d/australia--perth/health--events/', category: 'health', priority: 1 },
    { slug: 'arts', url: 'https://www.eventbrite.com.au/d/australia--perth/arts--events/', category: 'arts', priority: 1 }
  ];

  // sports page 1: fresh (2 hours old) -> should be served from cache
  await cacheStore.write('https://www.eventbrite.com.au/d/australia--perth/sports--events/?page=1', {
    fetchedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    body: buildEventbriteHtml([
      {
        id: '101',
        name: 'Perth Morning Run',
        url: 'https://www.eventbrite.com.au/e/perth-run-101',
        start_date: '2026-12-01',
        primary_venue: { name: 'Kings Park', address: { latitude: -31.9608, longitude: 115.8447 } }
      }
    ], 1)
  });

  // health page 1: expired (30 hours old) -> older than 24h TTL
  await cacheStore.write('https://www.eventbrite.com.au/d/australia--perth/health--events/?page=1', {
    fetchedAt: new Date(now.getTime() - 30 * 60 * 60 * 1000).toISOString(),
    body: buildEventbriteHtml([], 1)
  });

  // arts page 1: uncached -> stalest (-Infinity), must be fetched BEFORE health!

  const fetchedUrls = [];
  const mockFetch = async (url) => {
    fetchedUrls.push(url);
    if (url.includes('/arts--events/')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return buildEventbriteHtml([
            {
              id: '202',
              name: 'Fremantle Life Drawing',
              url: 'https://www.eventbrite.com.au/e/freo-art-202',
              start_date: '2026-12-02',
              primary_venue: { name: 'Fremantle Arts Centre', address: { latitude: -32.049, longitude: 115.754 } }
            }
          ], 1);
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return buildEventbriteHtml([], 1);
      }
    };
  };

  try {
    const adapter = createMemoryAdapter();
    const summary = await runEventbriteSync({
      adapter,
      fetchFn: mockFetch,
      cacheStore,
      sleepFn: async () => {},
      options: {
        feeds,
        maxFetches: 1,
        maxPages: 5,
        delayMs: 0,
        now
      }
    });

    assert.equal(summary.cacheHits, 1);
    assert.equal(summary.liveFetches, 1);
    assert.equal(summary.stoppedReason, 'max_fetches');
    assert.deepEqual(fetchedUrls, [
      'https://www.eventbrite.com.au/d/australia--perth/arts--events/?page=1'
    ], 'Uncached feed must be fetched before expired cached feed');
    assert.equal(adapter.activities.size, 2, 'Should persist both cached sports and newly fetched arts listings');
    assert.equal(adapter.activities.get('eventbrite_101')?.category, 'sports');
    assert.equal(adapter.activities.get('eventbrite_202')?.category, 'arts');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Eventbrite Sync: applies jittered delayMs between live fetches', async () => {
  const sleepCalls = [];
  const feeds = [
    { slug: 'sports', url: 'https://www.eventbrite.com.au/d/australia--perth/sports--events/', category: 'sports', priority: 1 },
    { slug: 'music', url: 'https://www.eventbrite.com.au/d/australia--perth/music--events/', category: 'music', priority: 1 }
  ];

  // randomFn returning 0.0 -> 0.7x; returning 1.0 -> 1.3x
  let randIdx = 0;
  const randomValues = [0.0, 1.0];

  const summary = await runEventbriteSync({
    adapter: createMemoryAdapter(),
    fetchFn: async () => ({
      ok: true,
      status: 200,
      async text() { return buildEventbriteHtml([], 1); }
    }),
    sleepFn: async (ms) => { sleepCalls.push(ms); },
    randomFn: () => randomValues[randIdx++ % randomValues.length],
    options: {
      feeds,
      maxFetches: 8,
      delayMs: 3500,
      dryRun: true,
      now: new Date('2026-11-21T12:00:00+08:00')
    }
  });

  assert.equal(summary.liveFetches, 2);
  assert.deepEqual(sleepCalls, [2450], 'Second fetch should sleep 3500 * 0.7 = 2450ms');
});

test('Eventbrite Sync: trips circuit breaker on HTTP 429 or 403 and never caches blocked responses', async () => {
  for (const blockedStatus of [429, 403]) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `eb-sync-cb-${blockedStatus}-`));
    const cachePath = path.join(tmpDir, 'eventbrite-sync-cache.json');
    const cacheStore = createFileCacheStore(cachePath, { flushEvery: 1 });

    const feeds = [
      { slug: 'sports', url: 'https://www.eventbrite.com.au/d/australia--perth/sports--events/', category: 'sports', priority: 1 },
      { slug: 'music', url: 'https://www.eventbrite.com.au/d/australia--perth/music--events/', category: 'music', priority: 1 }
    ];

    const fetchedUrls = [];
    const mockFetch = async (url) => {
      fetchedUrls.push(url);
      if (url.includes('/sports--events/')) {
        return {
          ok: false,
          status: blockedStatus,
          statusText: blockedStatus === 429 ? 'Too Many Requests' : 'Forbidden',
          async text() { return 'Blocked'; }
        };
      }
      return {
        ok: true,
        status: 200,
        async text() { return buildEventbriteHtml([], 1); }
      };
    };

    try {
      const summary = await runEventbriteSync({
        adapter: createMemoryAdapter(),
        fetchFn: mockFetch,
        cacheStore,
        sleepFn: async () => {},
        options: {
          feeds,
          maxFetches: 8,
          delayMs: 0,
          now: new Date('2026-11-21T12:00:00+08:00')
        }
      });

      assert.equal(summary.circuitBreakerTripped, true);
      assert.equal(summary.stoppedReason, 'circuit_breaker');
      assert.equal(summary.rateLimitedResponses, 1);
      assert.equal(fetchedUrls.length, 1, 'Circuit breaker must halt subsequent network requests');
      const cached = await cacheStore.read('https://www.eventbrite.com.au/d/australia--perth/sports--events/?page=1');
      assert.equal(cached, null, `HTTP ${blockedStatus} response must never be cached`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }
});

test('Eventbrite Sync: stores large HTML payloads in .body.gz sidecar cache', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eb-sync-gz-'));
  const cachePath = path.join(tmpDir, 'eventbrite-sync-cache.json');
  const cacheStore = createFileCacheStore(cachePath, { flushEvery: 1 });
  const largePadding = 'x'.repeat(70000);
  const largeHtml = `${buildEventbriteHtml([], 1)}<!-- ${largePadding} -->`;

  try {
    await runEventbriteSync({
      adapter: createMemoryAdapter(),
      fetchFn: async () => ({
        ok: true,
        status: 200,
        async text() { return largeHtml; }
      }),
      cacheStore,
      sleepFn: async () => {},
      options: {
        feeds: [{ slug: 'sports', url: 'https://www.eventbrite.com.au/d/australia--perth/sports--events/', category: 'sports', priority: 1 }],
        maxFetches: 1,
        delayMs: 0,
        dryRun: true,
        now: new Date('2026-11-21T12:00:00+08:00')
      }
    });

    const sidecarFiles = await fs.readdir(`${cachePath}.d`);
    assert.ok(sidecarFiles.some(f => f.endsWith('.body.gz')), 'Large Eventbrite HTML must be stored as .body.gz sidecar');
    assert.equal(EVENTBRITE_CACHE_TTL_MS, 24 * 60 * 60 * 1000);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Eventbrite Sync CLI: package.json registers sync:eventbrite, GitHub Actions workflow excludes eventbrite, and default harness disables eventbrite', async () => {
  const pkg = JSON.parse(await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['sync:eventbrite'], 'node src/eventbrite-sync.js');

  const workflow = await fs.readFile(path.resolve(process.cwd(), '.github/workflows/crawler-harness.yml'), 'utf8');
  assert.equal(/\beventbrite\b/i.test(workflow), false, 'GitHub Actions crawler workflow must not include eventbrite');

  const defaultCrawlers = getDefaultCrawlers();
  assert.equal(defaultCrawlers.some(c => c.name === 'eventbrite'), false, 'Default harness must keep eventbrite disabled');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eb-sync-main-'));
  const cacheStore = createFileCacheStore(path.join(tmpDir, 'cache.json'));
  try {
    const summary = await main(['--dry-run', '--max-fetches=0', '--delay-ms=0'], {}, {
      cacheStore,
      firestoreEnv: { db: null, dryRun: true, projectId: 'myplaydex' },
      logger: { log() {}, warn() {}, error() {} }
    });
    assert.equal(summary.dryRun, true);
    assert.equal(summary.liveFetches, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
