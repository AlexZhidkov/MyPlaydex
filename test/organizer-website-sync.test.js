import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createFileCacheStore } from '../src/file-cache.js';
import {
  DEFAULT_MAP_CACHE_TTL_MS,
  DEFAULT_MAX_DOMAINS,
  DEFAULT_MAX_URLS_PER_DOMAIN,
  DEFAULT_PRODUCTIVE_COOLDOWN_MS,
  DEFAULT_ZERO_YIELD_BACKOFF_MS,
  extractOrganizerWebsiteActivities,
  filterCandidateUrls,
  main,
  parseCliArgs,
  runOrganizerWebsiteSync,
  selectDripOrganizerTargets
} from '../src/organizer-website-sync.js';

function createMemoryAdapter({ organizers = [], venues = [], activities = [] } = {}) {
  const upsertedBatches = [];
  return {
    upsertedBatches,
    async scanOrganizers() {
      return organizers;
    },
    async scanVenues() {
      return venues;
    },
    async scanActivities() {
      return activities;
    },
    async batchUpsertActivities(items) {
      upsertedBatches.push(items);
      return { upserted: items.length };
    }
  };
}

describe('Organizer Website Drip Sync (Issue #53)', () => {
  it('Seam 1: parseCliArgs handles --dry-run, --apply, domain caps, and main degrades cleanly when FIRECRAWL_LOCAL_URL is unset', async () => {
    const defaultArgs = parseCliArgs([], {});
    assert.equal(defaultArgs.dryRun, true);
    assert.equal(defaultArgs.maxDomains, DEFAULT_MAX_DOMAINS);
    assert.equal(defaultArgs.maxUrlsPerDomain, DEFAULT_MAX_URLS_PER_DOMAIN);
    assert.equal(defaultArgs.firecrawlUrl, null);

    const applyArgs = parseCliArgs([
      '--apply',
      '--max-domains=7',
      '--max-urls-per-domain=3',
      '--firecrawl-url=http://127.0.0.1:3002',
      '--organizer=org_1'
    ], {});
    assert.equal(applyArgs.dryRun, false);
    assert.equal(applyArgs.maxDomains, 7);
    assert.equal(applyArgs.maxUrlsPerDomain, 3);
    assert.equal(applyArgs.firecrawlUrl, 'http://127.0.0.1:3002');
    assert.equal(applyArgs.organizer, 'org_1');

    const bothFlags = parseCliArgs(['--apply', '--dry-run'], {});
    assert.equal(bothFlags.dryRun, true);

    const disabledArgs = parseCliArgs(['--no-firecrawl'], { FIRECRAWL_LOCAL_URL: 'http://127.0.0.1:3002' });
    assert.equal(disabledArgs.firecrawlUrl, null);

    const logs = [];
    const summary = await main(['--dry-run'], {}, {
      adapter: createMemoryAdapter(),
      logger: { log: msg => logs.push(msg), warn: msg => logs.push(msg), error: msg => logs.push(msg) }
    });
    assert.equal(summary.firecrawlAvailable, false);
    assert.equal(summary.skippedReason, 'firecrawl_unconfigured');
    assert.equal(summary.processedDomains, 0);
    assert.equal(summary.upsertedCount, 0);
  });

  it('Seam 2: filterCandidateUrls selects high-signal paths and PDFs, caps to 3-5 URLs, and falls back to homepage', () => {
    const baseUrl = 'https://www.perthclub.org.au/';
    const links = [
      'https://www.perthclub.org.au/about',
      'https://www.perthclub.org.au/contact',
      'https://www.perthclub.org.au/events',
      'https://www.perthclub.org.au/calendar',
      'https://www.perthclub.org.au/whats-on',
      'https://www.perthclub.org.au/timetable',
      'https://www.perthclub.org.au/schedule',
      'https://www.perthclub.org.au/classes',
      'https://www.perthclub.org.au/sessions',
      'https://www.perthclub.org.au/fixtures',
      'https://www.perthclub.org.au/docs/spring-timetable.pdf',
      'https://www.perthclub.org.au/events#top',
      'https://other-domain.com/events'
    ];

    const filtered5 = filterCandidateUrls(links, baseUrl, { maxUrls: 5 });
    assert.equal(filtered5.length, 5);
    assert.ok(filtered5.every(u => u.includes('perthclub.org.au')));
    assert.ok(!filtered5.some(u => u.includes('/about') || u.includes('/contact')));
    assert.ok(!filtered5.some(u => u.includes('other-domain.com')));

    const filtered3 = filterCandidateUrls(links, baseUrl, { maxUrls: 3 });
    assert.equal(filtered3.length, 3);

    const fallback = filterCandidateUrls([
      'https://www.perthclub.org.au/about',
      'https://www.perthclub.org.au/privacy-policy'
    ], baseUrl, { maxUrls: 5 });
    assert.deepEqual(fallback, ['https://www.perthclub.org.au/']);
  });

  it('Seam 3: selectDripOrganizerTargets prioritizes Tier-1 Organizers and applies 7-day productive / 30-day zero-yield backoff', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-org-drip-'));
    const cacheStore = createFileCacheStore(path.join(tmpDir, 'cache.json'));
    const now = new Date('2026-11-25T10:00:00+08:00');
    const nowMs = now.getTime();

    // Productive domain crawled 3 days ago -> within 7-day cooldown (skipped)
    await cacheStore.write('drip_checkpoint|https://productive-recent.org.au/', {
      lastCrawledAt: new Date(nowMs - 3 * 24 * 60 * 60 * 1000).toISOString(),
      lastYieldCount: 2
    });
    // Productive domain crawled 8 days ago -> past 7-day cooldown (eligible!)
    await cacheStore.write('drip_checkpoint|https://productive-due.org.au/', {
      lastCrawledAt: new Date(nowMs - 8 * 24 * 60 * 60 * 1000).toISOString(),
      lastYieldCount: 3
    });
    // Zero-yield domain crawled 15 days ago -> within 30-day backoff (skipped)
    await cacheStore.write('drip_checkpoint|https://zero-recent.org.au/', {
      lastCrawledAt: new Date(nowMs - 15 * 24 * 60 * 60 * 1000).toISOString(),
      lastYieldCount: 0
    });
    // Zero-yield domain crawled 31 days ago -> past 30-day backoff (eligible!)
    await cacheStore.write('drip_checkpoint|https://zero-due.org.au/', {
      lastCrawledAt: new Date(nowMs - 31 * 24 * 60 * 60 * 1000).toISOString(),
      lastYieldCount: 0
    });

    const organizersCatalog = [
      { id: 'org_has_fb', name: 'FB Club', website: 'https://fbclub.org.au', contact: { facebook: 'https://facebook.com/fbclub' } },
      { id: 'org_has_active', name: 'Active Club', website: 'https://activeclub.org.au' },
      { id: 'org_prod_recent', name: 'Prod Recent', website: 'https://productive-recent.org.au' },
      { id: 'org_prod_due', name: 'Prod Due', website: 'https://productive-due.org.au' },
      { id: 'org_zero_recent', name: 'Zero Recent', website: 'https://zero-recent.org.au' },
      { id: 'org_zero_due', name: 'Zero Due', website: 'https://zero-due.org.au' },
      { id: 'org_never', name: 'Never Crawled Tier 1', website: 'https://nevercrawled.org.au' }
    ];

    const activitiesCatalog = [
      {
        id: 'council_1',
        source: 'council',
        organizer: { id: 'org_has_active', name: 'Active Club' },
        expire_at: new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString()
      }
    ];

    const targets = await selectDripOrganizerTargets({
      organizersCatalog,
      activitiesCatalog,
      cacheStore,
      now
    });

    const selectedIds = targets.map(t => t.organizer.id);
    assert.ok(!selectedIds.includes('org_prod_recent'));
    assert.ok(!selectedIds.includes('org_zero_recent'));

    // Tier 1 (0 active activities, no FB/EB/Meetup) must come before Tier 2 (org_has_fb, org_has_active)
    const neverIdx = selectedIds.indexOf('org_never');
    const zeroDueIdx = selectedIds.indexOf('org_zero_due');
    const prodDueIdx = selectedIds.indexOf('org_prod_due');
    const activeIdx = selectedIds.indexOf('org_has_active');
    const fbIdx = selectedIds.indexOf('org_has_fb');

    assert.equal(neverIdx, 0);
    assert.ok(zeroDueIdx > neverIdx && zeroDueIdx < activeIdx);
    assert.ok(prodDueIdx > neverIdx && prodDueIdx < activeIdx);
    assert.ok(activeIdx > prodDueIdx && fbIdx > prodDueIdx);
    assert.equal(DEFAULT_PRODUCTIVE_COOLDOWN_MS, 7 * 24 * 60 * 60 * 1000);
    assert.equal(DEFAULT_ZERO_YIELD_BACKOFF_MS, 30 * 24 * 60 * 60 * 1000);
    assert.ok(DEFAULT_MAP_CACHE_TTL_MS >= 14 * 24 * 60 * 60 * 1000);
  });

  it('Seam 4: extractOrganizerWebsiteActivities parses Schema.org Event JSON-LD, enforces guardrails, and grounds to scraped URL', () => {
    const now = new Date('2026-11-25T10:00:00+08:00');
    const scrapedUrl = 'https://www.perthvolleyball.org.au/events';
    const html = `
      <html><head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "SportsEvent",
                "name": "Thursday Social Volleyball",
                "description": "Mixed social 6v6 volleyball night.",
                "startDate": "2026-12-03T18:30:00",
                "endDate": "2026-12-03T20:30:00",
                "location": {
                  "@type": "Place",
                  "name": "Loftus Recreation Centre",
                  "address": {
                    "@type": "PostalAddress",
                    "streetAddress": "99 Loftus St",
                    "addressLocality": "Leederville",
                    "addressRegion": "WA",
                    "postalCode": "6007",
                    "addressCountry": "AU"
                  },
                  "geo": { "latitude": -31.9369, "longitude": 115.8442 }
                },
                "offers": { "@type": "Offer", "price": "12", "priceCurrency": "AUD" }
              },
              {
                "@type": "Event",
                "name": "PastAGM Meeting",
                "startDate": "2026-10-01T18:00:00"
              },
              {
                "@type": "Event",
                "name": "Online Webinar",
                "eventAttendanceMode": "https://schema.org/OnlineEventAttendanceMode",
                "startDate": "2026-12-10T18:00:00"
              }
            ]
          }
        </script>
      </head><body></body></html>
    `;

    const extracted = extractOrganizerWebsiteActivities(html, {
      scrapedUrl,
      organizer: { id: 'org_perth_vb', name: 'Perth Volleyball' },
      now
    });

    assert.equal(extracted.length, 1);
    const activity = extracted[0];
    assert.equal(activity.title, 'Thursday Social Volleyball');
    assert.equal(activity.source, 'organizer_website');
    assert.equal(activity.source_url, scrapedUrl);
    assert.equal(activity.raw_source_url, scrapedUrl);
    assert.equal(activity.verified, true);
    assert.equal(activity.start_date, '2026-12-03T18:30:00+08:00');
    assert.equal(activity.venue_name, 'Loftus Recreation Centre');
    assert.deepEqual(activity.coordinates, { lat: -31.9369, lng: 115.8442 });
    assert.equal(activity.cost_description, '$12 AUD');
  });

  it('Seam 5: runOrganizerWebsiteSync runs map->scrape->sanitize->reconcile->dedupe and persists only on --apply', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-org-sync-'));
    const cacheStore = createFileCacheStore(path.join(tmpDir, 'cache.json'));
    const now = new Date('2026-11-25T10:00:00+08:00');

    const mapCalls = [];
    const scrapeCalls = [];
    const firecrawlClient = {
      async map(url, opts) {
        mapCalls.push({ url, opts });
        return {
          url,
          links: [
            'https://club.org.au/about',
            'https://club.org.au/events',
            'https://club.org.au/timetable'
          ],
          fromCache: false
        };
      },
      async scrape(url) {
        scrapeCalls.push(url);
        if (url === 'https://club.org.au/events') {
          return {
            url,
            html: `<script type="application/ld+json">${JSON.stringify({
              '@type': 'Event',
              name: 'Saturday Club Run',
              startDate: '2026-12-05T08:00:00',
              location: {
                '@type': 'Place',
                name: 'Kings Park',
                geo: { latitude: -31.9615, longitude: 115.8435 }
              }
            })}</script>`,
            links: []
          };
        }
        return { url, html: '<html><body>No JSON-LD here</body></html>', links: [] };
      },
      async flushCache() {}
    };

    const organizers = [
      { id: 'org_club', name: 'Perth Running Club', website: 'https://club.org.au' }
    ];
    const venues = [
      { id: 'venue_kings_park', name: 'Kings Park', coordinates: { lat: -31.9615, lng: 115.8435 } }
    ];

    const dryAdapter = createMemoryAdapter({ organizers, venues });
    const drySummary = await runOrganizerWebsiteSync({
      adapter: dryAdapter,
      firecrawlClient,
      cacheStore,
      options: { dryRun: true, maxDomains: 5, maxUrlsPerDomain: 3, now },
      logger: { log() {}, warn() {}, error() {} }
    });

    assert.equal(drySummary.firecrawlAvailable, true);
    assert.equal(drySummary.processedDomains, 1);
    assert.equal(drySummary.extractedCount, 1);
    assert.equal(drySummary.validCount, 1);
    assert.equal(drySummary.upsertedCount, 0);
    assert.equal(dryAdapter.upsertedBatches.length, 0);
    assert.ok(mapCalls[0].opts.cacheTtlMs >= 14 * 24 * 60 * 60 * 1000);
    assert.deepEqual(scrapeCalls, ['https://club.org.au/events', 'https://club.org.au/timetable']);

    const applyAdapter = createMemoryAdapter({ organizers, venues });
    const applySummary = await runOrganizerWebsiteSync({
      adapter: applyAdapter,
      firecrawlClient,
      cacheStore,
      options: { dryRun: false, maxDomains: 5, maxUrlsPerDomain: 3, now },
      logger: { log() {}, warn() {}, error() {} }
    });

    assert.equal(applySummary.upsertedCount, 1);
    assert.equal(applyAdapter.upsertedBatches.length, 1);
    const saved = applyAdapter.upsertedBatches[0][0];
    assert.equal(saved.source, 'organizer_website');
    assert.equal(saved.source_url, 'https://club.org.au/events');
    assert.equal(saved.verified, true);
    assert.equal(saved.organizer.id, 'org_club');
    assert.equal(saved.venue.id, 'venue_kings_park');
    assert.ok(saved.sources.some(s => s.source === 'organizer_website' && s.source_url === 'https://club.org.au/events'));

    // Second run with same now should skip org_club because productive checkpoint was written on apply
    const secondAdapter = createMemoryAdapter({ organizers, venues });
    const secondSummary = await runOrganizerWebsiteSync({
      adapter: secondAdapter,
      firecrawlClient,
      cacheStore,
      options: { dryRun: false, maxDomains: 5, maxUrlsPerDomain: 3, now },
      logger: { log() {}, warn() {}, error() {} }
    });
    assert.equal(secondSummary.processedDomains, 0);

    // Date-only Activity flags needs_review and zero-yield domain records 0-yield checkpoint
    const zeroAndDateOnlyClient = {
      async map(url) {
        return { url, links: [`${url}/events`], fromCache: false };
      },
      async scrape(url) {
        if (url.includes('dateonly.org.au')) {
          return {
            url,
            html: `<script type="application/ld+json">${JSON.stringify({
              '@type': 'Event',
              name: 'Open Day',
              startDate: '2026-12-12',
              location: { '@type': 'Place', name: 'Kings Park', geo: { latitude: -31.9615, longitude: 115.8435 } }
            })}</script>`,
            links: []
          };
        }
        return { url, html: '<html><body>Brochure</body></html>', links: [] };
      },
      async flushCache() {}
    };
    const mixedAdapter = createMemoryAdapter({
      organizers: [
        { id: 'org_dateonly', name: 'Date Only Club', website: 'https://dateonly.org.au' },
        { id: 'org_brochure', name: 'Brochure Club', website: 'https://brochure.org.au' }
      ],
      venues
    });
    const mixedSummary = await runOrganizerWebsiteSync({
      adapter: mixedAdapter,
      firecrawlClient: zeroAndDateOnlyClient,
      cacheStore,
      options: { dryRun: false, maxDomains: 5, maxUrlsPerDomain: 3, now },
      logger: { log() {}, warn() {}, error() {} }
    });
    assert.equal(mixedSummary.processedDomains, 2);
    assert.equal(mixedSummary.upsertedCount, 1);
    assert.equal(mixedAdapter.upsertedBatches[0][0].needs_review, true);
    const brochureCp = await cacheStore.read('drip_checkpoint|https://brochure.org.au/');
    assert.equal(brochureCp.lastYieldCount, 0);
  });

  it('Seam 6: invokes Gemini Flash Markdown fallback only when JSON-LD yields 0, skips when GEMINI_API_KEY is unset, and enforces weekly/dated + Unreviewed Listing guardrails', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-org-gemini-'));
    const cacheStore = createFileCacheStore(path.join(tmpDir, 'cache.json'));
    const now = new Date('2026-11-25T10:00:00+08:00');

    const geminiCalls = [];
    const firecrawlClient = {
      async map(url) {
        return {
          url,
          links: [new URL('/events', url).href, new URL('/timetable', url).href],
          fromCache: false
        };
      },
      async scrape(url) {
        if (url.endsWith('/events')) {
          return {
            url,
            html: `<script type="application/ld+json">${JSON.stringify({
              '@type': 'Event',
              name: 'JSON-LD Club Event',
              startDate: '2026-12-05T08:00:00',
              location: { '@type': 'Place', name: 'Kings Park', geo: { latitude: -31.9615, longitude: 115.8435 } }
            })}</script>`,
            markdown: '# JSON-LD Club Event\nDec 5 8am at Kings Park',
            links: []
          };
        }
        return {
          url,
          html: '<html><body><p>Tuesday Social Badminton 7pm-9pm</p></body></html>',
          markdown: '# Timetable\n- Tuesday Social Badminton 7pm-9pm\n- Beginners Clinic 2026-12-10\n- AGM Notice',
          links: []
        };
      },
      async flushCache() {}
    };

    const geminiClient = {
      async extractActivitiesFromMarkdown(payload) {
        geminiCalls.push(payload);
        return {
          activities: [
            {
              title: 'Tuesday Social Badminton',
              category: 'sports',
              weekday: 'Tuesday',
              start_date: null,
              end_date: null,
              start_time: '19:00',
              end_time: '21:00',
              venue_name: null,
              is_noise: false,
              confidence: 'high'
            },
            {
              title: 'Friday Park Run',
              category: 'sports',
              weekday: 'Friday',
              start_date: null,
              end_date: null,
              start_time: '07:00',
              end_time: '08:00',
              venue_name: 'Kings Park',
              is_noise: false,
              confidence: 'high'
            },
            {
              title: 'Unmatched Venue Class',
              category: 'sports',
              weekday: null,
              start_date: '2026-12-10',
              end_date: null,
              start_time: '18:00',
              end_time: null,
              venue_name: 'Mystery Unlisted Hall',
              is_noise: false,
              confidence: 'high'
            },
            {
              title: 'Low Confidence Clinic',
              category: 'sports',
              weekday: null,
              start_date: '2026-12-11',
              end_date: null,
              start_time: '18:00',
              end_time: null,
              venue_name: 'Kings Park',
              is_noise: false,
              confidence: 'low'
            },
            {
              title: 'Missing Time Open Day',
              category: 'sports',
              weekday: null,
              start_date: '2026-12-12',
              end_date: null,
              start_time: null,
              end_time: null,
              venue_name: 'Kings Park',
              is_noise: false,
              confidence: 'high'
            },
            {
              title: 'Annual General Meeting',
              category: 'community',
              weekday: 'Wednesday',
              start_time: '18:00',
              is_noise: false,
              confidence: 'high'
            }
          ]
        };
      }
    };

    const organizers = [
      {
        id: 'org_home',
        name: 'Perth Badminton Club',
        website: 'https://badminton.org.au',
        venue: {
          id: 'venue_home_hall',
          name: 'Perth Badminton Hall',
          coordinates: { lat: -31.9505, lng: 115.8605 }
        }
      }
    ];
    const venues = [
      { id: 'venue_kings_park', name: 'Kings Park', coordinates: { lat: -31.9615, lng: 115.8435 } }
    ];

    const adapter = createMemoryAdapter({ organizers, venues });
    const summary = await runOrganizerWebsiteSync({
      adapter,
      firecrawlClient,
      geminiClient,
      cacheStore,
      options: { dryRun: false, maxDomains: 5, maxUrlsPerDomain: 3, now },
      logger: { log() {}, warn() {}, error() {} }
    });

    // Only /timetable (0 JSON-LD) should invoke Gemini; /events (1 JSON-LD) must NOT invoke Gemini
    assert.equal(geminiCalls.length, 1);
    assert.equal(geminiCalls[0].sourceUrl, 'https://badminton.org.au/timetable');
    assert.equal(summary.llmFallbackCalls, 1);
    assert.equal(summary.upsertedCount, 6);

    const saved = adapter.upsertedBatches[0];
    const weekly = saved.find(a => a.title === 'Tuesday Social Badminton');
    assert.ok(weekly);
    assert.equal(weekly.schedule.recurrence, 'weekly');
    assert.equal(weekly.expire_at, null);
    assert.equal(weekly.venue.id, 'venue_home_hall');
    assert.equal(weekly.needs_review, false);

    const canonicalDirect = saved.find(a => a.title === 'Friday Park Run');
    assert.ok(canonicalDirect);
    assert.equal(canonicalDirect.venue.id, 'venue_kings_park');
    assert.equal(canonicalDirect.needs_review, false);

    const unmatchedVenue = saved.find(a => a.title === 'Unmatched Venue Class');
    assert.ok(unmatchedVenue);
    assert.equal(unmatchedVenue.schedule.recurrence, 'none');
    assert.ok(unmatchedVenue.expire_at instanceof Date);
    assert.equal(unmatchedVenue.needs_review, true);
    assert.equal(unmatchedVenue.review_reason, 'unmatched_venue');

    const lowConf = saved.find(a => a.title === 'Low Confidence Clinic');
    assert.ok(lowConf);
    assert.equal(lowConf.needs_review, true);
    assert.equal(lowConf.review_reason, 'low_confidence');

    const missingTime = saved.find(a => a.title === 'Missing Time Open Day');
    assert.ok(missingTime);
    assert.equal(missingTime.needs_review, true);
    assert.equal(missingTime.review_reason, 'missing_start_time');

    // When GEMINI_API_KEY is unset in main(), sync skips Gemini fallback cleanly
    const unsetSummary = await main(
      ['--apply', '--max-domains', '1'],
      { FIRECRAWL_LOCAL_URL: 'http://127.0.0.1:3002' },
      {
        adapter: createMemoryAdapter({ organizers, venues }),
        firecrawlClient,
        cacheStore: createFileCacheStore(path.join(tmpDir, 'cache-unset.json')),
        logger: { log() {}, warn() {}, error() {} }
      }
    );
    assert.equal(unsetSummary.llmFallbackCalls, 0);
    assert.equal(unsetSummary.upsertedCount, 1);
  });
});
