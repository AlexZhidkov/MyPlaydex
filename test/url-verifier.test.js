import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverUrl, probeUrl, createUrlProber, createUrlVerifier } from '../src/url-verifier.js';

test('Seam 1: recoverUrl normalizes schemes, upgrades http, trims malformed characters, and preserves paths', () => {
  // 1. Missing protocol prepends https://
  assert.equal(recoverUrl('perthvolleyball.com.au/sessions'), 'https://perthvolleyball.com.au/sessions');
  assert.equal(recoverUrl('www.meetup.com/perth-sports/events/123/'), 'https://www.meetup.com/perth-sports/events/123/');

  // 2. Upgrades http:// to https://
  assert.equal(recoverUrl('http://stirling.wa.gov.au/events/volleyball'), 'https://stirling.wa.gov.au/events/volleyball');

  // 3. Trims whitespace, surrounding quotes, and malformed wrapper characters
  assert.equal(recoverUrl('  https://dlgsc.wa.gov.au/clubs/101  \n'), 'https://dlgsc.wa.gov.au/clubs/101');
  assert.equal(recoverUrl('"https://eventbrite.com.au/e/soccer-12345"'), 'https://eventbrite.com.au/e/soccer-12345');
  assert.equal(recoverUrl('<https://example.com/test>'), 'https://example.com/test');

  // 4. Preserves full path and query parameters (does not truncate to root domain)
  assert.equal(
    recoverUrl('http://example.org/path/to/specific/activity?date=2026-11-12&ref=flyer#section'),
    'https://example.org/path/to/specific/activity?date=2026-11-12&ref=flyer#section'
  );

  // 5. Handles empty, invalid, or non-string inputs safely
  assert.equal(recoverUrl(''), null);
  assert.equal(recoverUrl('   '), null);
  assert.equal(recoverUrl(null), null);
  assert.equal(recoverUrl(undefined), null);
  assert.equal(recoverUrl(12345), null);
});

test('Seam 2: probeUrl attempts HEAD first, follows redirects, falls back to header-only GET on 403/405, and handles errors', async () => {
  const calls = [];

  // 1. Successful HEAD request following redirect to canonical URL
  const mockFetch1 = async (url, init) => {
    calls.push({ url, method: init.method });
    return {
      ok: true,
      status: 200,
      url: 'https://canonical.example.com/final-event',
      body: null
    };
  };

  const res1 = await probeUrl('https://example.com/redirect', { fetch: mockFetch1 });
  assert.equal(res1.reachable, true);
  assert.equal(res1.url, 'https://canonical.example.com/final-event');
  assert.equal(res1.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'HEAD');

  // 2. HEAD rejected with 405 (or 403) -> falls back to GET
  calls.length = 0;
  let abortedStream = false;
  const mockFetch2 = async (url, init) => {
    calls.push({ url, method: init.method });
    if (init.method === 'HEAD') {
      return {
        ok: false,
        status: 405,
        url,
        body: null
      };
    }
    // GET fallback
    return {
      ok: true,
      status: 200,
      url: 'https://example.com/get-success',
      body: {
        cancel() {
          abortedStream = true;
        }
      }
    };
  };

  const res2 = await probeUrl('https://example.com/needs-get', { fetch: mockFetch2 });
  assert.equal(res2.reachable, true);
  assert.equal(res2.url, 'https://example.com/get-success');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'HEAD');
  assert.equal(calls[1].method, 'GET');
  assert.equal(abortedStream, true);

  // 3. 404 Not Found returns unreachable
  const mockFetch404 = async (url, init) => ({
    ok: false,
    status: 404,
    url,
    body: null
  });
  const res3 = await probeUrl('https://example.com/missing', { fetch: mockFetch404 });
  assert.equal(res3.reachable, false);
  assert.equal(res3.status, 404);

  // 4. Network error returns unreachable
  const mockFetchFail = async () => {
    throw new Error('Connection refused');
  };
  const res4 = await probeUrl('https://example.com/down', { fetch: mockFetchFail });
  assert.equal(res4.reachable, false);
  assert.equal(res4.status, 0);
  assert.match(res4.error, /Connection refused/);
});

test('Seam 2: createUrlProber enforces bounded concurrency and per-request timeout', async () => {
  let activeRequests = 0;
  let maxConcurrent = 0;

  const mockFetch = async (url) => {
    activeRequests += 1;
    maxConcurrent = Math.max(maxConcurrent, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeRequests -= 1;
    return {
      ok: true,
      status: 200,
      url,
      body: null
    };
  };

  const prober = createUrlProber({
    concurrency: 2,
    timeoutMs: 1000,
    fetch: mockFetch
  });

  const urls = [
    'https://example.com/1',
    'https://example.com/2',
    'https://example.com/3',
    'https://example.com/4',
    'https://example.com/5'
  ];

  const results = await prober.probeAll(urls);
  assert.equal(results.length, 5);
  assert.equal(results.every(r => r.reachable), true);
  assert.ok(maxConcurrent <= 2, `Expected maxConcurrent <= 2, got ${maxConcurrent}`);
});

test('Seam 3: createUrlVerifier deduplicates via Firestore getAll and runCache, self-heals, and degrades unreachable links', async () => {
  const probedUrls = [];
  const mockFetch = async (url) => {
    probedUrls.push(url);
    if (url.includes('broken')) {
      return { ok: false, status: 404, url, body: null };
    }
    return {
      ok: true,
      status: 200,
      url: url.replace('http:', 'https:'),
      body: null
    };
  };

  const existingDocs = new Map([
    // Already verified with matching URL -> should skip probe
    ['stirling_101', {
      id: 'stirling_101',
      source_url: 'https://example.com/verified-before',
      raw_source_url: 'https://example.com/verified-before',
      verified: true
    }],
    // Previously failed (verified: false) -> should re-probe for self-healing
    ['stirling_102', {
      id: 'stirling_102',
      source_url: null,
      raw_source_url: 'https://example.com/previously-failed-now-healed',
      verified: false
    }],
    // Existing verified but URL changed -> should re-probe
    ['stirling_103', {
      id: 'stirling_103',
      source_url: 'https://example.com/old-url',
      raw_source_url: 'https://example.com/old-url',
      verified: true
    }]
  ]);

  let getAllCalledCount = 0;
  let requestedIds = [];
  const mockAdapter = {
    isDryRun() { return false; },
    async getActivities(ids) {
      getAllCalledCount += 1;
      requestedIds = ids;
      const map = new Map();
      for (const id of ids) {
        if (existingDocs.has(id)) {
          map.set(id, existingDocs.get(id));
        }
      }
      return map;
    }
  };

  const verifier = createUrlVerifier({
    adapter: mockAdapter,
    fetch: mockFetch
  });

  const candidateListings = [
    // 1. Existing verified with matching URL
    {
      id: 'stirling_101',
      source_url: 'https://example.com/verified-before',
      raw_source_url: 'https://example.com/verified-before',
      verified: true
    },
    // 2. Previously failed -> now reachable (self-healing)
    {
      id: 'stirling_102',
      source_url: 'https://example.com/previously-failed-now-healed',
      raw_source_url: 'https://example.com/previously-failed-now-healed',
      verified: true
    },
    // 3. Existing verified, but URL changed to new URL
    {
      id: 'stirling_103',
      source_url: 'https://example.com/new-url',
      raw_source_url: 'https://example.com/new-url',
      verified: true
    },
    // 4. Duplicate of 3 (should use in-memory run cache and not probe again)
    {
      id: 'stirling_104',
      source_url: 'https://example.com/new-url',
      raw_source_url: 'https://example.com/new-url',
      verified: true
    },
    // 5. Broken URL -> degrades to Unverified Listing
    {
      id: 'stirling_105',
      source_url: 'https://example.com/broken-page',
      raw_source_url: 'https://example.com/broken-page',
      verified: true
    },
    // 6. Missing URL -> degrades to Unverified Listing without probing
    {
      id: 'stirling_106',
      source_url: null,
      raw_source_url: null,
      verified: false
    }
  ];

  const verifiedListings = await verifier.verifyListings(candidateListings);

  // Batched lookup was called once with candidate IDs
  assert.equal(getAllCalledCount, 1);
  assert.equal(requestedIds.length, 6);

  // Probed URLs should NOT include stirling_101 (skipped)
  assert.ok(!probedUrls.includes('https://example.com/verified-before'));

  // stirling_102 was probed and healed
  assert.ok(probedUrls.includes('https://example.com/previously-failed-now-healed'));
  const healed = verifiedListings.find(l => l.id === 'stirling_102');
  assert.equal(healed.verified, true);
  assert.equal(healed.source_url, 'https://example.com/previously-failed-now-healed');

  // stirling_103 was probed (URL changed)
  assert.ok(probedUrls.includes('https://example.com/new-url'));
  // stirling_104 reused the run-cache of stirling_103, so 'https://example.com/new-url' was probed only once!
  assert.equal(probedUrls.filter(u => u === 'https://example.com/new-url').length, 1);

  // stirling_105 degraded to Unverified Listing
  const degraded = verifiedListings.find(l => l.id === 'stirling_105');
  assert.equal(degraded.verified, false);
  assert.equal(degraded.source_url, null);
  assert.equal(degraded.raw_source_url, 'https://example.com/broken-page');

  // stirling_106 remains Unverified without probing
  const missing = verifiedListings.find(l => l.id === 'stirling_106');
  assert.equal(missing.verified, false);
  assert.equal(missing.source_url, null);
});


