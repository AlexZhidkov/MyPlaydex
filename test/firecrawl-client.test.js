import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileCacheStore } from '../src/file-cache.js';
import { createFirecrawlClient, createFirecrawlClientFromEnv } from '../src/firecrawl-client.js';

test('createFirecrawlClient returns null when baseUrl is missing or invalid', () => {
  assert.equal(createFirecrawlClient({}), null);
  assert.equal(createFirecrawlClient({ baseUrl: '' }), null);
  assert.equal(createFirecrawlClient({ baseUrl: 'not-a-url' }), null);
  assert.equal(createFirecrawlClient({ baseUrl: 'ftp://127.0.0.1:3002' }), null);
  assert.equal(createFirecrawlClientFromEnv({}), null);
});

test('createFirecrawlClient enforces serial execution (concurrency = 1), jittered pacing, and auth headers', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const sleeps = [];
  const seenAuth = [];

  const fetchFn = async (url, init) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    seenAuth.push(init?.headers?.Authorization ?? null);
    await new Promise(resolve => setTimeout(resolve, 15));
    inFlight -= 1;

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          data: {
            html: '<html><body><a href="https://www.facebook.com/TestClub">FB</a></body></html>',
            links: ['https://www.facebook.com/TestClub'],
            markdown: 'Test'
          }
        };
      }
    };
  };

  const client = createFirecrawlClient({
    baseUrl: 'http://127.0.0.1:3002/',
    token: 'secret-token',
    fetchFn,
    sleepFn: async (ms) => { sleeps.push(ms); },
    randomFn: () => 0.5, // factor = 1.0
    delayMs: 1000
  });

  assert.equal(client.baseUrl, 'http://127.0.0.1:3002');

  const [r1, r2, r3] = await Promise.all([
    client.scrape('https://one.example.com'),
    client.scrape('https://two.example.com'),
    client.scrape('https://three.example.com')
  ]);

  assert.equal(maxInFlight, 1, 'Expected strict serial execution (concurrency = 1)');
  assert.deepEqual(sleeps, [1000, 1000], 'Expected jittered pacing between live requests');
  assert.deepEqual(seenAuth, ['Bearer secret-token', 'Bearer secret-token', 'Bearer secret-token']);
  assert.equal(r1.fromCache, false);
  assert.equal(r2.fromCache, false);
  assert.equal(r3.fromCache, false);
  assert.deepEqual(r1.links, ['https://www.facebook.com/TestClub']);
});

test('createFirecrawlClient caches scrape and map responses via file-cache.js with TTL and refresh', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-fc-cache-'));
  const cachePath = path.join(tmpDir, 'firecrawl-cache.json');
  const cacheStore = createFileCacheStore(cachePath);

  let nowMs = Date.parse('2026-11-24T10:00:00Z');
  let fetchCalls = 0;
  const largeHtml = `<html><body>${'a'.repeat(70 * 1024)}<a href="https://www.facebook.com/LargeSpaClub">FB</a></body></html>`;

  const fetchFn = async (url, init) => {
    fetchCalls += 1;
    if (url.endsWith('/v2/map')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            links: [{ url: 'https://spa.example.com/events' }, 'https://spa.example.com/contact']
          };
        }
      };
    }
    const body = JSON.parse(init.body);
    assert.equal(body.onlyMainContent, false);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          data: {
            rawHtml: largeHtml,
            links: ['https://www.facebook.com/LargeSpaClub'],
            markdown: 'Large SPA'
          }
        };
      }
    };
  };

  const client = createFirecrawlClient({
    baseUrl: 'http://127.0.0.1:3002',
    fetchFn,
    sleepFn: async () => {},
    nowFn: () => nowMs,
    cacheStore,
    cacheTtlMs: 60 * 60 * 1000
  });

  // First scrape: live
  const s1 = await client.scrape('https://spa.example.com', { formats: ['rawHtml', 'links'], onlyMainContent: false });
  assert.equal(s1.fromCache, false);
  assert.equal(fetchCalls, 1);

  // Second scrape within TTL: cached
  const s2 = await client.scrape('https://spa.example.com', { formats: ['rawHtml', 'links'], onlyMainContent: false });
  assert.equal(s2.fromCache, true);
  assert.equal(fetchCalls, 1);
  assert.ok(s2.html.includes('LargeSpaClub'));
  assert.deepEqual(s2.links, ['https://www.facebook.com/LargeSpaClub']);

  // Advance past TTL: re-fetches
  nowMs += 2 * 60 * 60 * 1000;
  const s3 = await client.scrape('https://spa.example.com', { formats: ['rawHtml', 'links'], onlyMainContent: false });
  assert.equal(s3.fromCache, false);
  assert.equal(fetchCalls, 2);

  // Map caches and normalizes object/string links
  const m1 = await client.map('https://spa.example.com');
  assert.equal(m1.fromCache, false);
  assert.deepEqual(m1.links, ['https://spa.example.com/events', 'https://spa.example.com/contact']);
  const m2 = await client.map('https://spa.example.com');
  assert.equal(m2.fromCache, true);
  assert.equal(fetchCalls, 3);

  await client.flushCache();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('createFirecrawlClient surfaces HTTP and API errors cleanly', async () => {
  const errorClient = createFirecrawlClient({
    baseUrl: 'http://127.0.0.1:3002',
    sleepFn: async () => {},
    fetchFn: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { success: false, code: 'RENDER_FAILED', error: 'the page did not finish loading in time' };
      }
    })
  });

  await assert.rejects(
    () => errorClient.scrape('https://slow.example.com'),
    /RENDER_FAILED|did not finish loading in time/
  );
});
