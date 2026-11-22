import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverUrl, probeUrl, createUrlProber, createUrlVerifier, normalizeFacebookUrl } from '../src/url-verifier.js';

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

test('Seam 3: verifyListings supports legacy external_url and url fields from existing Firestore documents', async () => {
  const mockFetch = async (url) => ({
    ok: true,
    status: 200,
    url
  });

  const verifier = createUrlVerifier({ fetch: mockFetch });

  const legacyListings = [
    {
      id: 'legacy_1',
      title: 'Legacy Listing with external_url',
      external_url: 'https://example.com/legacy-link'
    },
    {
      id: 'legacy_2',
      title: 'Legacy Listing with url',
      url: 'http://example.com/legacy-http'
    }
  ];

  const results = await verifier.verifyListings(legacyListings);

  assert.equal(results[0].verified, true);
  assert.equal(results[0].source_url, 'https://example.com/legacy-link');
  assert.equal(results[0].raw_source_url, 'https://example.com/legacy-link');

  assert.equal(results[1].verified, true);
  assert.equal(results[1].source_url, 'https://example.com/legacy-http');
  assert.equal(results[1].raw_source_url, 'http://example.com/legacy-http');
});

test('Seam 3: verifyListings verifies Organizer and Venue Listings, deduplicates via db/adapter, and degrades unreachable links', async () => {
  const probedUrls = [];
  const mockFetch = async (url) => {
    probedUrls.push(url);
    if (url.includes('dead-club')) {
      return { ok: false, status: 404, url, body: null };
    }
    return {
      ok: true,
      status: 200,
      url: url.replace('http:', 'https:'),
      body: null
    };
  };

  const store = {
    organizers: new Map([
      ['org_already_ok', {
        id: 'org_already_ok',
        name: 'Already OK Club',
        source_url: 'https://okclub.org.au',
        raw_source_url: 'https://okclub.org.au',
        verified: true
      }]
    ]),
    venues: new Map([
      ['venue_healed_qd66h1', {
        id: 'venue_healed_qd66h1',
        name: 'Healed Venue',
        source_url: null,
        raw_source_url: 'http://healedvenue.org.au',
        verified: false
      }]
    ]),
    activities: new Map()
  };

  const mockDb = {
    collection(colName) {
      return {
        doc(id) {
          return { id, colName };
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
    }
  };

  const verifier = createUrlVerifier({ db: mockDb, fetch: mockFetch });
  const results = await verifier.verifyListings([
    {
      id: 'org_already_ok',
      name: 'Already OK Club',
      source_url: 'https://okclub.org.au',
      raw_source_url: 'https://okclub.org.au',
      verified: true
    },
    {
      id: 'org_website_only',
      name: 'Website Only Club',
      website: 'http://websiteonly.org.au'
    },
    {
      id: 'org_dead',
      name: 'Dead Club',
      source_url: 'https://dead-club.org.au',
      raw_source_url: 'https://dead-club.org.au'
    },
    {
      id: 'venue_healed_qd66h1',
      name: 'Healed Venue',
      raw_source_url: 'http://healedvenue.org.au',
      verified: false
    }
  ]);

  assert.equal(probedUrls.includes('https://okclub.org.au'), false);

  const websiteOrganizer = results.find(r => r.id === 'org_website_only');
  assert.equal(websiteOrganizer.verified, true);
  assert.equal(websiteOrganizer.source_url, 'https://websiteonly.org.au/');
  assert.equal(websiteOrganizer.raw_source_url, 'http://websiteonly.org.au');

  const deadOrganizer = results.find(r => r.id === 'org_dead');
  assert.equal(deadOrganizer.verified, false);
  assert.equal(deadOrganizer.source_url, null);
  assert.equal(deadOrganizer.raw_source_url, 'https://dead-club.org.au');

  const healedVenue = results.find(r => r.id === 'venue_healed_qd66h1');
  assert.equal(healedVenue.verified, true);
  assert.equal(healedVenue.source_url, 'https://healedvenue.org.au/');
  assert.equal(healedVenue.raw_source_url, 'http://healedvenue.org.au');
});

test('Seam 1 (Issue #19): normalizeFacebookUrl and recoverUrl canonicalize Facebook hosts, strip tracking params, and reject interstitials', () => {
  // Hostname normalization & http -> https upgrade
  assert.equal(normalizeFacebookUrl('http://m.facebook.com/perthsoccerclub'), 'https://www.facebook.com/perthsoccerclub');
  assert.equal(normalizeFacebookUrl('https://mbasic.facebook.com/perthsoccerclub'), 'https://www.facebook.com/perthsoccerclub');
  assert.equal(normalizeFacebookUrl('https://web.facebook.com/perthsoccerclub'), 'https://www.facebook.com/perthsoccerclub');
  assert.equal(normalizeFacebookUrl('http://fb.me/perthsoccerclub'), 'https://www.facebook.com/perthsoccerclub');
  assert.equal(normalizeFacebookUrl('fb.com/perthsoccerclub'), 'https://www.facebook.com/perthsoccerclub');
  assert.equal(normalizeFacebookUrl('https://facebook.com/perthsoccerclub'), 'https://www.facebook.com/perthsoccerclub');

  // Strips tracking params while preserving route identifiers
  assert.equal(
    normalizeFacebookUrl('https://m.facebook.com/events/123456789/?acontext=%7B%22ref%22%3A1%7D&fbclid=IwAR0xyz&ref=page_internal&aref=123&__cft__[0]=abc&__tn__=def'),
    'https://www.facebook.com/events/123456789/'
  );
  assert.equal(
    normalizeFacebookUrl('https://www.facebook.com/profile.php?id=100064512345678&fbclid=abc&__tn__=C'),
    'https://www.facebook.com/profile.php?id=100064512345678'
  );

  // Rewrites legacy /#!/ hashbang Facebook URLs and rejects /#!/login interstitials
  assert.equal(
    normalizeFacebookUrl('https://www.facebook.com/#!/BalcattaSC?sk=wall'),
    'https://www.facebook.com/BalcattaSC?sk=wall'
  );
  assert.equal(
    normalizeFacebookUrl('https://www.facebook.com/#!/pages/Allen-Park-Tennis-Club/149044861790239?sk=wall&fbclid=drop'),
    'https://www.facebook.com/pages/Allen-Park-Tennis-Club/149044861790239?sk=wall'
  );
  assert.equal(normalizeFacebookUrl('https://www.facebook.com/#!/login'), null);

  // Rejects interstitial paths (/login, /checkpoint, /sharer) and non-Facebook URLs
  assert.equal(normalizeFacebookUrl('https://www.facebook.com/login'), null);
  assert.equal(normalizeFacebookUrl('https://m.facebook.com/login.php?next=https%3A%2F%2Fwww.facebook.com%2Fclub'), null);
  assert.equal(normalizeFacebookUrl('https://www.facebook.com/checkpoint/12345'), null);
  assert.equal(normalizeFacebookUrl('https://www.facebook.com/sharer/sharer.php?u=https://example.com'), null);
  assert.equal(normalizeFacebookUrl('https://example.com/perthsoccerclub'), null);
  assert.equal(normalizeFacebookUrl(''), null);

  // recoverUrl delegates Facebook URLs to canonicalization
  assert.equal(
    recoverUrl('http://m.facebook.com/events/987654321?fbclid=xyz'),
    'https://www.facebook.com/events/987654321'
  );
  assert.equal(recoverUrl('https://www.facebook.com/login'), null);
});

test('Seam 2 & 3 (Issue #19): URL verifier bypasses probing for valid Facebook URLs and probeUrl rejects /login and /checkpoint redirect overwrites', async () => {
  const probedUrls = [];
  const mockFetch = async (url, init) => {
    probedUrls.push({ url, method: init.method });
    if (url === 'https://example.com/organizer-login-redirect') {
      return {
        ok: true,
        status: 200,
        url: 'https://example.com/login?next=%2Forganizer',
        body: null
      };
    }
    if (url === 'https://example.com/organizer-checkpoint-redirect') {
      if (init.method === 'HEAD') {
        return { ok: false, status: 405, url, body: null };
      }
      return {
        ok: true,
        status: 200,
        url: 'https://example.com/checkpoint/challenge',
        body: { cancel() {} }
      };
    }
    return { ok: true, status: 200, url, body: null };
  };

  // 1. probeUrl never overwrites candidate URL with /login or /checkpoint redirect destination
  const loginRedirectRes = await probeUrl('https://example.com/organizer-login-redirect', { fetch: mockFetch });
  assert.equal(loginRedirectRes.reachable, true);
  assert.equal(loginRedirectRes.url, 'https://example.com/organizer-login-redirect');

  const checkpointRedirectRes = await probeUrl('https://example.com/organizer-checkpoint-redirect', { fetch: mockFetch });
  assert.equal(checkpointRedirectRes.reachable, true);
  assert.equal(checkpointRedirectRes.url, 'https://example.com/organizer-checkpoint-redirect');

  // 2. createUrlVerifier bypasses probing for valid Facebook URLs and degrades interstitials without network calls
  probedUrls.length = 0;
  const verifier = createUrlVerifier({ fetch: mockFetch, force: true });
  const results = await verifier.verifyListings([
    {
      id: 'org_fb_organizer',
      source_url: 'http://m.facebook.com/PerthVolleyballOrganizer?fbclid=IwAR123&ref=bookmarks'
    },
    {
      id: 'act_fb_activity',
      source_url: 'https://fb.me/events/555666777?acontext=%7B%7D'
    },
    {
      id: 'org_fb_login',
      source_url: 'https://www.facebook.com/login.php?next=123'
    },
    {
      id: 'org_normal_site',
      source_url: 'https://example.com/organizer-login-redirect'
    }
  ]);

  // Zero network requests to Facebook domains
  assert.equal(probedUrls.some(p => p.url.includes('facebook.com') || p.url.includes('fb.me')), false);
  assert.equal(probedUrls.length, 1);
  assert.equal(probedUrls[0].url, 'https://example.com/organizer-login-redirect');

  const fbOrganizer = results.find(r => r.id === 'org_fb_organizer');
  assert.equal(fbOrganizer.verified, true);
  assert.equal(fbOrganizer.source_url, 'https://www.facebook.com/PerthVolleyballOrganizer');
  assert.equal(fbOrganizer.raw_source_url, 'http://m.facebook.com/PerthVolleyballOrganizer?fbclid=IwAR123&ref=bookmarks');

  const fbActivity = results.find(r => r.id === 'act_fb_activity');
  assert.equal(fbActivity.verified, true);
  assert.equal(fbActivity.source_url, 'https://www.facebook.com/events/555666777');
  assert.equal(fbActivity.raw_source_url, 'https://fb.me/events/555666777?acontext=%7B%7D');

  const fbLogin = results.find(r => r.id === 'org_fb_login');
  assert.equal(fbLogin.verified, false);
  assert.equal(fbLogin.source_url, null);
  assert.equal(fbLogin.raw_source_url, 'https://www.facebook.com/login.php?next=123');

  const normalSite = results.find(r => r.id === 'org_normal_site');
  assert.equal(normalSite.verified, true);
  assert.equal(normalSite.source_url, 'https://example.com/organizer-login-redirect');
});

test('Seam 3 (Issue #43): createUrlVerifier fails over to healthy secondary Source Reference when primary URL fails', async () => {
  const probedUrls = [];
  const mockProber = {
    async probeAll(urls) {
      probedUrls.push(...urls);
      return urls.map(url => {
        if (url === 'https://www.eventbrite.com.au/e/broken-event') {
          return { reachable: false, status: 404, url: null, error: 'HTTP 404' };
        }
        if (url === 'https://www.meetup.com/perth-sports/events/12345') {
          return { reachable: true, status: 200, url: 'https://www.meetup.com/perth-sports/events/12345' };
        }
        return { reachable: false, status: 500, url: null, error: 'Unexpected URL' };
      });
    }
  };

  const verifier = createUrlVerifier({ prober: mockProber, force: true });
  const results = await verifier.verifyListings([
    {
      id: 'eventbrite_broken_1',
      source: 'eventbrite',
      source_id: 'broken_1',
      source_url: 'https://www.eventbrite.com.au/e/broken-event',
      raw_source_url: 'https://www.eventbrite.com.au/e/broken-event',
      verified: true,
      sources: [
        {
          source: 'eventbrite',
          source_id: 'broken_1',
          source_key: 'eventbrite_broken_1',
          source_url: 'https://www.eventbrite.com.au/e/broken-event',
          raw_source_url: 'https://www.eventbrite.com.au/e/broken-event',
          verified: true
        },
        {
          source: 'meetup',
          source_id: '12345',
          source_key: 'meetup_12345',
          source_url: 'https://www.meetup.com/perth-sports/events/12345',
          raw_source_url: 'https://www.meetup.com/perth-sports/events/12345',
          verified: true
        }
      ]
    }
  ]);

  assert.equal(results.length, 1);
  const act = results[0];
  assert.equal(act.verified, true);
  assert.equal(act.source_url, 'https://www.meetup.com/perth-sports/events/12345');
  assert.equal(act.raw_source_url, 'https://www.meetup.com/perth-sports/events/12345');

  const ebRef = act.sources.find(s => s.source_key === 'eventbrite_broken_1');
  assert.equal(ebRef.verified, false);
  assert.equal(ebRef.source_url, null);
  assert.equal(ebRef.raw_source_url, 'https://www.eventbrite.com.au/e/broken-event');

  const meetupRef = act.sources.find(s => s.source_key === 'meetup_12345');
  assert.equal(meetupRef.verified, true);
  assert.equal(meetupRef.source_url, 'https://www.meetup.com/perth-sports/events/12345');
});

test('Seam 3 (Issue #43): createUrlVerifier evaluates secondary Source References in priority order (eventbrite > meetup > council > facebook)', async () => {
  const probedUrls = [];
  const mockProber = {
    async probeAll(urls) {
      probedUrls.push(...urls);
      return urls.map(url => {
        if (url.includes('dead')) {
          return { reachable: false, status: 404, url: null, error: 'HTTP 404' };
        }
        return { reachable: true, status: 200, url };
      });
    }
  };

  const verifier = createUrlVerifier({ prober: mockProber, force: true });

  // 1. eventbrite fails, meetup + council + facebook healthy -> meetup wins, council not probed
  const [meetupWins, councilWins, fbWins] = await verifier.verifyListings([
    {
      id: 'act_meetup_wins',
      source: 'eventbrite',
      source_url: 'https://www.eventbrite.com.au/e/dead-1',
      raw_source_url: 'https://www.eventbrite.com.au/e/dead-1',
      verified: true,
      sources: [
        { source: 'facebook', source_id: 'fb1', source_key: 'facebook_fb1', source_url: 'https://www.facebook.com/events/111', raw_source_url: 'https://www.facebook.com/events/111', verified: true },
        { source: 'stirling', source_id: 'c1', source_key: 'stirling_c1', source_url: 'https://stirling.wa.gov.au/events/111', raw_source_url: 'https://stirling.wa.gov.au/events/111', verified: true },
        { source: 'meetup', source_id: 'm1', source_key: 'meetup_m1', source_url: 'https://www.meetup.com/perth/events/111', raw_source_url: 'https://www.meetup.com/perth/events/111', verified: true },
        { source: 'eventbrite', source_id: 'e1', source_key: 'eventbrite_e1', source_url: 'https://www.eventbrite.com.au/e/dead-1', raw_source_url: 'https://www.eventbrite.com.au/e/dead-1', verified: true }
      ]
    },
    {
      id: 'act_council_wins',
      source: 'eventbrite',
      source_url: 'https://www.eventbrite.com.au/e/dead-2',
      raw_source_url: 'https://www.eventbrite.com.au/e/dead-2',
      verified: true,
      sources: [
        { source: 'facebook', source_id: 'fb2', source_key: 'facebook_fb2', source_url: 'https://www.facebook.com/events/222', raw_source_url: 'https://www.facebook.com/events/222', verified: true },
        { source: 'council', source_id: 'c2', source_key: 'council_c2', source_url: 'https://perth.wa.gov.au/events/222', raw_source_url: 'https://perth.wa.gov.au/events/222', verified: true },
        { source: 'meetup', source_id: 'm2', source_key: 'meetup_m2', source_url: 'https://www.meetup.com/perth/events/dead-2', raw_source_url: 'https://www.meetup.com/perth/events/dead-2', verified: true },
        { source: 'eventbrite', source_id: 'e2', source_key: 'eventbrite_e2', source_url: 'https://www.eventbrite.com.au/e/dead-2', raw_source_url: 'https://www.eventbrite.com.au/e/dead-2', verified: true }
      ]
    },
    {
      id: 'act_fb_wins',
      source: 'meetup',
      source_url: 'https://www.meetup.com/perth/events/dead-3',
      raw_source_url: 'https://www.meetup.com/perth/events/dead-3',
      verified: true,
      sources: [
        { source: 'facebook', source_id: 'fb3', source_key: 'facebook_fb3', source_url: 'https://m.facebook.com/events/333?fbclid=xyz', raw_source_url: 'https://m.facebook.com/events/333?fbclid=xyz', verified: true },
        { source: 'council', source_id: 'c3', source_key: 'council_c3', source_url: 'https://perth.wa.gov.au/events/dead-3', raw_source_url: 'https://perth.wa.gov.au/events/dead-3', verified: true },
        { source: 'meetup', source_id: 'm3', source_key: 'meetup_m3', source_url: 'https://www.meetup.com/perth/events/dead-3', raw_source_url: 'https://www.meetup.com/perth/events/dead-3', verified: true }
      ]
    }
  ]);

  assert.equal(meetupWins.verified, true);
  assert.equal(meetupWins.source_url, 'https://www.meetup.com/perth/events/111');
  assert.equal(probedUrls.includes('https://stirling.wa.gov.au/events/111'), false);

  assert.equal(councilWins.verified, true);
  assert.equal(councilWins.source_url, 'https://perth.wa.gov.au/events/222');
  assert.equal(councilWins.sources.find(s => s.source_key === 'eventbrite_e2').verified, false);
  assert.equal(councilWins.sources.find(s => s.source_key === 'meetup_m2').verified, false);
  assert.equal(councilWins.sources.find(s => s.source_key === 'council_c2').verified, true);

  assert.equal(fbWins.verified, true);
  assert.equal(fbWins.source_url, 'https://www.facebook.com/events/333');
  assert.equal(fbWins.sources.find(s => s.source_key === 'facebook_fb3').verified, true);
  assert.equal(fbWins.sources.find(s => s.source_key === 'facebook_fb3').source_url, 'https://www.facebook.com/events/333');
  assert.equal(probedUrls.some(u => u.includes('facebook.com')), false);
});

test('Seam 3 (Issue #43): createUrlVerifier degrades to Unverified Listing when all Source References fail while preserving history for self-healing', async () => {
  let meetupHealthy = false;
  const mockProber = {
    async probeAll(urls) {
      return urls.map(url => {
        if (meetupHealthy && url === 'https://www.meetup.com/perth/events/heal-1') {
          return { reachable: true, status: 200, url };
        }
        return { reachable: false, status: 404, url: null, error: 'HTTP 404' };
      });
    }
  };

  const initialActivity = {
    id: 'eventbrite_all_dead',
    source: 'eventbrite',
    source_url: 'https://www.eventbrite.com.au/e/all-dead',
    raw_source_url: 'https://www.eventbrite.com.au/e/all-dead',
    verified: true,
    sources: [
      {
        source: 'eventbrite',
        source_id: 'all_dead',
        source_key: 'eventbrite_all_dead',
        source_url: 'https://www.eventbrite.com.au/e/all-dead',
        raw_source_url: 'https://www.eventbrite.com.au/e/all-dead',
        verified: true
      },
      {
        source: 'meetup',
        source_id: 'heal_1',
        source_key: 'meetup_heal_1',
        source_url: 'https://www.meetup.com/perth/events/heal-1',
        raw_source_url: 'https://www.meetup.com/perth/events/heal-1',
        verified: true
      },
      {
        source: 'council',
        source_id: 'dead_c',
        source_key: 'council_dead_c',
        source_url: null,
        raw_source_url: 'http://perth.wa.gov.au/events/dead-c',
        verified: false
      }
    ]
  };

  // Run 1: all links fail -> degrades to Unverified Listing, preserves raw_source_url history
  const verifier1 = createUrlVerifier({ prober: mockProber, force: true });
  const [degraded] = await verifier1.verifyListings([initialActivity]);

  assert.equal(degraded.verified, false);
  assert.equal(degraded.source_url, null);
  assert.equal(degraded.raw_source_url, 'https://www.eventbrite.com.au/e/all-dead');
  assert.equal(degraded.sources.length, 3);
  for (const ref of degraded.sources) {
    assert.equal(ref.verified, false);
    assert.equal(ref.source_url, null);
  }
  assert.equal(degraded.sources.find(s => s.source_key === 'eventbrite_all_dead').raw_source_url, 'https://www.eventbrite.com.au/e/all-dead');
  assert.equal(degraded.sources.find(s => s.source_key === 'meetup_heal_1').raw_source_url, 'https://www.meetup.com/perth/events/heal-1');
  assert.equal(degraded.sources.find(s => s.source_key === 'council_dead_c').raw_source_url, 'http://perth.wa.gov.au/events/dead-c');

  // Run 2: meetup link recovers -> self-heals without force because existing verified is false
  meetupHealthy = true;
  const verifier2 = createUrlVerifier({
    prober: mockProber,
    existingDocsMap: new Map([[degraded.id, degraded]])
  });
  const [healed] = await verifier2.verifyListings([degraded]);

  assert.equal(healed.verified, true);
  assert.equal(healed.source_url, 'https://www.meetup.com/perth/events/heal-1');
  assert.equal(healed.sources.find(s => s.source_key === 'meetup_heal_1').verified, true);
  assert.equal(healed.sources.find(s => s.source_key === 'eventbrite_all_dead').verified, false);
});

test('Seam 3 (Issue #43): createUrlVerifier fails over to existing Firestore Source References during ingestion', async () => {
  const mockProber = {
    async probeAll(urls) {
      return urls.map(url => {
        if (url.includes('dead-incoming')) {
          return { reachable: false, status: 404, url: null, error: 'HTTP 404' };
        }
        return { reachable: true, status: 200, url };
      });
    }
  };

  const existingDocsMap = new Map([
    [
      'eventbrite_ingest_1',
      {
        id: 'eventbrite_ingest_1',
        source: 'eventbrite',
        source_url: 'https://www.eventbrite.com.au/e/dead-incoming',
        raw_source_url: 'https://www.eventbrite.com.au/e/dead-incoming',
        verified: true,
        sources: [
          {
            source: 'eventbrite',
            source_id: 'ingest_1',
            source_key: 'eventbrite_ingest_1',
            source_url: 'https://www.eventbrite.com.au/e/dead-incoming',
            raw_source_url: 'https://www.eventbrite.com.au/e/dead-incoming',
            verified: true
          },
          {
            source: 'meetup',
            source_id: 'm_backup',
            source_key: 'meetup_m_backup',
            source_url: 'https://www.meetup.com/perth/events/backup',
            raw_source_url: 'https://www.meetup.com/perth/events/backup',
            verified: true
          }
        ]
      }
    ]
  ]);

  const verifier = createUrlVerifier({ prober: mockProber, existingDocsMap, force: true });
  const [verified] = await verifier.verifyListings([
    {
      id: 'eventbrite_ingest_1',
      source: 'eventbrite',
      source_id: 'ingest_1',
      source_url: 'https://www.eventbrite.com.au/e/dead-incoming'
    }
  ]);

  assert.equal(verified.verified, true);
  assert.equal(verified.source_url, 'https://www.meetup.com/perth/events/backup');
  assert.equal(verified.sources.find(s => s.source_key === 'meetup_m_backup').verified, true);
  assert.equal(verified.sources.find(s => s.source_key === 'eventbrite_ingest_1').verified, false);
});





