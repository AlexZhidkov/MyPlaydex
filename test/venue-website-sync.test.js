import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileCacheStore } from '../src/file-cache.js';
import { createFirestoreAdapter } from '../src/firestore-adapter.js';
import { CANONICAL_CATEGORIES } from '../src/sanitizer.js';
import { PERTH_SUBURB_CENTROIDS } from '../public/shared/perth-centroids.js';
import { isWithinPerthRadius } from '../src/venue-resolver.js';
import {
  MAJOR_VENUE_SEEDS,
  findMajorVenueSeed
} from '../src/major-venue-seeds.js';
import {
  DEFAULT_VENUE_COOLDOWN_MS,
  VENUE_COOLDOWN_KEY_PREFIX,
  VENUE_WEBSITE_SOURCE,
  extractVenueJsonLdActivities,
  ingestVenueActivity,
  isVenueWithinCooldown,
  main,
  parseCliArgs,
  resolveCanonicalVenueForSeed,
  runVenueWebsiteSync,
  selectVenueSeeds
} from '../src/venue-website-sync.js';

function createMemoryAdapter({ venues = [], activities = [] } = {}) {
  const upsertedBatches = [];
  return {
    upsertedBatches,
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

function createSilentLogger() {
  const logs = [];
  const warns = [];
  const errors = [];
  return {
    logs,
    warns,
    errors,
    log: msg => logs.push(msg),
    warn: msg => warns.push(msg),
    error: msg => errors.push(msg)
  };
}

describe('Major-Venue Calendar Sync (Issue #62)', () => {
  it('Seam 1: MAJOR_VENUE_SEEDS defines core Greater Perth major Venues and findMajorVenueSeed matches by slug, name, or alias', () => {
    assert.ok(Array.isArray(MAJOR_VENUE_SEEDS));
    assert.ok(MAJOR_VENUE_SEEDS.length >= 13);

    const slugs = new Set();
    for (const seed of MAJOR_VENUE_SEEDS) {
      assert.equal(typeof seed.slug, 'string');
      assert.ok(seed.slug.length > 0);
      assert.ok(!slugs.has(seed.slug), `Duplicate seed slug: ${seed.slug}`);
      slugs.add(seed.slug);

      assert.equal(typeof seed.name, 'string');
      assert.ok(seed.name.length > 0);
      assert.ok(Array.isArray(seed.aliases));
      assert.match(seed.whatsOnUrl, /^https:\/\//);
      assert.equal(typeof seed.address, 'string');
      assert.equal(typeof seed.suburb, 'string');
      assert.equal(seed.regionId, 'perth');
      assert.ok(isWithinPerthRadius(seed.coordinates), `Seed ${seed.slug} outside Greater Perth`);
      assert.ok(CANONICAL_CATEGORIES.includes(seed.defaultCategory), `Invalid category for ${seed.slug}: ${seed.defaultCategory}`);
    }

    assert.equal(findMajorVenueSeed('optus-stadium')?.name, 'Optus Stadium');
    assert.equal(findMajorVenueSeed('RAC Arena')?.slug, 'rac-arena');
    assert.equal(findMajorVenueSeed('Perth Stadium')?.slug, 'optus-stadium');
    assert.equal(findMajorVenueSeed('STCWA')?.slug, 'state-theatre-centre');
    assert.equal(findMajorVenueSeed('unknown-venue-xyz'), null);
  });

  it('Seam 2: parseCliArgs defaults to dry-run, supports --apply and --venue filter, and degrades cleanly when Firecrawl is unconfigured', async () => {
    const defaultArgs = parseCliArgs([], {});
    assert.equal(defaultArgs.dryRun, true);
    assert.equal(defaultArgs.venue, undefined);
    assert.equal(defaultArgs.firecrawlUrl, null);
    assert.equal(defaultArgs.project, 'myplaydex');

    const applyArgs = parseCliArgs([
      '--apply',
      '--venue=rac-arena',
      '--refresh',
      '--firecrawl-url=http://127.0.0.1:3002'
    ], {});
    assert.equal(applyArgs.dryRun, false);
    assert.equal(applyArgs.venue, 'rac-arena');
    assert.equal(applyArgs.refresh, true);
    assert.equal(applyArgs.firecrawlUrl, 'http://127.0.0.1:3002');

    const spaceVenueArgs = parseCliArgs(['--venue', 'Optus Stadium', '--apply', '--dry-run'], {});
    assert.equal(spaceVenueArgs.dryRun, true);
    assert.equal(spaceVenueArgs.venue, 'Optus Stadium');

    const disabledArgs = parseCliArgs(['--no-firecrawl'], { FIRECRAWL_LOCAL_URL: 'http://127.0.0.1:3002' });
    assert.equal(disabledArgs.firecrawlUrl, null);

    assert.equal(selectVenueSeeds(MAJOR_VENUE_SEEDS).length, MAJOR_VENUE_SEEDS.length);
    assert.deepEqual(selectVenueSeeds(MAJOR_VENUE_SEEDS, 'optus-stadium').map(s => s.slug), ['optus-stadium']);
    assert.deepEqual(selectVenueSeeds(MAJOR_VENUE_SEEDS, 'does-not-exist'), []);

    const logger = createSilentLogger();
    const unconfiguredSummary = await main([], {}, {
      adapter: createMemoryAdapter(),
      logger
    });
    assert.equal(unconfiguredSummary.firecrawlAvailable, false);
    assert.equal(unconfiguredSummary.skippedReason, 'firecrawl_unconfigured');
    assert.equal(unconfiguredSummary.upsertedCount, 0);

    const unknownVenueAdapter = createMemoryAdapter();
    const unknownVenueSummary = await runVenueWebsiteSync({
      adapter: unknownVenueAdapter,
      firecrawlClient: {
        async scrape() {
          throw new Error('Should not scrape on unknown venue');
        }
      },
      options: { venue: 'nonexistent-venue', dryRun: false },
      logger
    });
    assert.equal(unknownVenueSummary.skippedReason, 'venue_not_found');
    assert.equal(unknownVenueSummary.processedVenues, 0);
    assert.equal(unknownVenueAdapter.upsertedBatches.length, 0);

    const scrapedUrls = [];
    const fakeFirecrawl = {
      async scrape(url) {
        scrapedUrls.push(url);
        return {
          url,
          html: `<html><head><script type="application/ld+json">${JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'MusicEvent',
            name: 'Perth Symphony Live',
            startDate: '2026-12-15T19:30:00+08:00',
            url: 'https://premier.ticketek.com.au/shows/show.aspx?sh=SYMPHONY26'
          })}</script></head><body></body></html>`,
          markdown: ''
        };
      },
      async flushCache() {}
    };

    const dryRunAdapter = createMemoryAdapter();
    const dryRunSummary = await runVenueWebsiteSync({
      adapter: dryRunAdapter,
      firecrawlClient: fakeFirecrawl,
      options: {
        venue: 'rac-arena',
        dryRun: true,
        now: new Date('2026-11-27T10:00:00+08:00')
      },
      logger
    });
    assert.equal(dryRunSummary.dryRun, true);
    assert.equal(dryRunSummary.processedVenues, 1);
    assert.equal(dryRunSummary.validCount, 1);
    assert.equal(dryRunSummary.upsertedCount, 0);
    assert.equal(dryRunAdapter.upsertedBatches.length, 0);
    assert.deepEqual(scrapedUrls, ['https://www.racarena.com.au/whats-on']);

    const applyAdapter = createMemoryAdapter();
    const applySummary = await runVenueWebsiteSync({
      adapter: applyAdapter,
      firecrawlClient: fakeFirecrawl,
      options: {
        venue: 'rac-arena',
        dryRun: false,
        now: new Date('2026-11-27T10:00:00+08:00')
      },
      logger
    });
    assert.equal(applySummary.dryRun, false);
    assert.equal(applySummary.upsertedCount, 1);
    assert.equal(applyAdapter.upsertedBatches.length, 1);
    assert.equal(applyAdapter.upsertedBatches[0][0].source, VENUE_WEBSITE_SOURCE);
  });

  it('Seam 3: extractVenueJsonLdActivities maps 9 canonical categories, prefers offers.url ticketing links, and enforces 6-month horizon and hard drops', () => {
    const venueSeed = findMajorVenueSeed('crown-perth');
    const now = new Date('2026-11-27T10:00:00+08:00');
    const html = `
      <html><head><script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "TheaterEvent",
            "name": "Wicked The Musical",
            "startDate": "2027-01-15T19:30:00+08:00",
            "endDate": "2027-01-15T22:15:00+08:00",
            "url": "https://www.crownperth.com.au/entertainment/live-theatre/wicked",
            "offers": {
              "@type": "Offer",
              "price": "129",
              "priceCurrency": "AUD",
              "url": "http://premier.ticketek.com.au/shows/show.aspx?sh=WICKED27"
            }
          },
          {
            "@type": "FoodEvent",
            "name": "Swan Valley Gourmet Dinner",
            "startDate": "2027-02-10T18:00:00+08:00",
            "url": "/entertainment/live-theatre/gourmet-dinner"
          },
          {
            "@type": "Event",
            "name": "Perth Wildcats vs Sydney Kings",
            "startDate": "2027-01-20T18:30:00+08:00",
            "description": "NBL basketball clash"
          },
          {
            "@type": "Event",
            "name": "Too Far Future Show",
            "startDate": "2027-07-01T19:00:00+08:00"
          },
          {
            "@type": "Event",
            "name": "Past Show",
            "startDate": "2026-11-01T19:00:00+08:00"
          },
          {
            "@type": "Event",
            "name": "Cancelled Show",
            "eventStatus": "https://schema.org/EventCancelled",
            "startDate": "2026-12-20T19:00:00+08:00"
          },
          {
            "@type": "Event",
            "name": "Livestream Only Show",
            "eventAttendanceMode": "https://schema.org/OnlineEventAttendanceMode",
            "startDate": "2026-12-21T19:00:00+08:00"
          }
        ]
      }
      </script></head><body></body></html>
    `;

    const extracted = extractVenueJsonLdActivities(html, {
      scrapedUrl: venueSeed.whatsOnUrl,
      venueSeed,
      now
    });

    assert.equal(extracted.length, 3);

    const wicked = extracted.find(a => a.title === 'Wicked The Musical');
    assert.ok(wicked);
    assert.equal(wicked.category, 'arts');
    assert.equal(wicked.source, 'venue_website');
    assert.equal(wicked.verified, true);
    assert.equal(wicked.source_url, 'https://premier.ticketek.com.au/shows/show.aspx?sh=WICKED27');
    assert.equal(wicked.sources.length, 1);
    assert.equal(wicked.sources[0].verified, true);
    assert.equal(wicked.schedule.recurrence, 'none');
    assert.equal(wicked.organizer, undefined);

    const dinner = extracted.find(a => a.title === 'Swan Valley Gourmet Dinner');
    assert.ok(dinner);
    assert.equal(dinner.category, 'food');
    assert.equal(dinner.source_url, 'https://www.crownperth.com.au/entertainment/live-theatre/gourmet-dinner');

    const basketball = extracted.find(a => a.title === 'Perth Wildcats vs Sydney Kings');
    assert.ok(basketball);
    assert.equal(basketball.category, 'sports');
    assert.equal(basketball.source_url, venueSeed.whatsOnUrl);
  });

  it('Seam 4: runVenueWebsiteSync uses Gemini Flash Markdown fallback only when JSON-LD is empty and emits discrete dated Activities', async () => {
    const now = new Date('2026-11-27T10:00:00+08:00');
    const logger = createSilentLogger();
    const geminiCalls = [];

    const fakeGemini = {
      async extractActivitiesFromMarkdown(params) {
        geminiCalls.push(params);
        return {
          activities: [
            {
              title: 'Bluey Live On Stage',
              category: 'family',
              start_date: '2027-01-12',
              start_time: '11:00',
              end_time: '12:15',
              ticket_url: 'https://www.ticketmaster.com.au/bluey-perth',
              is_noise: false,
              confidence: 'high'
            },
            {
              title: 'Weekly Venue Tour',
              category: 'travel',
              weekday: 'Saturday',
              start_date: null,
              start_time: '10:00',
              is_noise: false,
              confidence: 'high'
            },
            {
              title: 'Next Year Holiday Show',
              category: 'arts',
              start_date: '2027-08-01',
              start_time: '19:00',
              is_noise: false,
              confidence: 'high'
            }
          ]
        };
      }
    };

    const adapter = createMemoryAdapter();
    const summary = await runVenueWebsiteSync({
      adapter,
      firecrawlClient: {
        async scrape(url) {
          return {
            url,
            html: '<html><body><p>No JSON-LD here</p></body></html>',
            markdown: '# What\'s On\nBluey Live On Stage - 12 Jan 2027 11:00am'
          };
        }
      },
      geminiClient: fakeGemini,
      options: {
        venue: 'pcec',
        dryRun: false,
        now
      },
      logger
    });

    assert.equal(geminiCalls.length, 1);
    assert.equal(geminiCalls[0].venueName, 'Perth Convention and Exhibition Centre');
    assert.equal(geminiCalls[0].organizerName, '');
    assert.equal(summary.llmFallbackCalls, 1);
    assert.equal(summary.extractedCount, 1);
    assert.equal(summary.upsertedCount, 1);

    const upserted = adapter.upsertedBatches[0][0];
    assert.equal(upserted.title, 'Bluey Live On Stage');
    assert.equal(upserted.category, 'family');
    assert.equal(upserted.schedule.recurrence, 'none');
    assert.equal(upserted.schedule.start_date, '2027-01-12');
    assert.equal(upserted.source_url, 'https://www.ticketmaster.com.au/bluey-perth');
    assert.equal(upserted.verified, true);

    // JSON-LD present -> Gemini should NOT be called
    const jsonLdSummary = await runVenueWebsiteSync({
      adapter: createMemoryAdapter(),
      firecrawlClient: {
        async scrape(url) {
          return {
            url,
            html: `<script type="application/ld+json">${JSON.stringify({
              '@type': 'SportsEvent',
              name: 'West Coast Eagles vs Fremantle Dockers',
              startDate: '2027-03-20T17:10:00+08:00'
            })}</script>`,
            markdown: '# Optus Stadium'
          };
        }
      },
      geminiClient: fakeGemini,
      options: {
        venue: 'optus-stadium',
        dryRun: true,
        now
      },
      logger
    });
    assert.equal(geminiCalls.length, 1);
    assert.equal(jsonLdSummary.llmFallbackCalls, 0);
    assert.equal(jsonLdSummary.validCount, 1);
  });

  it('Seam 5: ingestVenueActivity anchors to canonical Venue, suppresses Organizer creation and unmatched_organizer across Firestore persistence', async () => {
    const venueSeed = findMajorVenueSeed('his-majestys-theatre');
    const catalogVenue = {
      id: 'venue_his_majestys_theatre_qd66hr',
      name: "His Majesty's Theatre",
      coordinates: { lat: -31.9522, lng: 115.8528 },
      geohash: 'qd66hr24f',
      google_place_id: 'ChIJ_his_maj_123'
    };

    const [raw] = extractVenueJsonLdActivities(
      `<script type="application/ld+json">${JSON.stringify({
        '@type': 'TheaterEvent',
        name: 'WA Ballet Gala',
        startDate: '2027-02-05T19:30:00+08:00',
        offers: { url: 'https://www.artsculturetrust.wa.gov.au/tickets/wa-ballet-gala' }
      })}</script>`,
      {
        scrapedUrl: venueSeed.whatsOnUrl,
        venueSeed,
        now: new Date('2026-11-27T10:00:00+08:00')
      }
    );

    const ingested = ingestVenueActivity(raw, {
      venueSeed,
      venuesCatalog: [catalogVenue]
    });

    assert.equal(ingested.venue.id, catalogVenue.id);
    assert.equal(ingested.venue.google_place_id, 'ChIJ_his_maj_123');
    assert.equal(ingested.organizer, null);
    assert.equal(ingested.needs_review, false);
    assert.equal(ingested.review_reason, null);
    assert.equal(ingested.verified, true);
    assert.equal(ingested.sources.length, 1);
    assert.equal(ingested.sources[0].source, 'venue_website');
    assert.equal(ingested.sources[0].verified, true);

    const writesByCollection = new Map();
    const mockDb = {
      collection(colName) {
        return {
          doc(docId) {
            return { _col: colName, _id: docId };
          }
        };
      },
      async getAll(...refs) {
        return refs.map(ref => ({ id: ref._id, exists: false, data: () => null }));
      },
      batch() {
        const ops = [];
        return {
          set(docRef, data) {
            ops.push({ col: docRef._col, id: docRef._id, data });
          },
          async commit() {
            for (const op of ops) {
              if (!writesByCollection.has(op.col)) {
                writesByCollection.set(op.col, []);
              }
              writesByCollection.get(op.col).push(op);
            }
          }
        };
      }
    };

    const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });
    const upsertRes = await adapter.batchUpsertActivities([ingested]);
    assert.equal(upsertRes.upserted, 1);
    assert.equal(writesByCollection.get('activities')?.length, 1);
    assert.equal(writesByCollection.get('organizers') ?? undefined, undefined);
    assert.equal(writesByCollection.get('activities')[0].data.organizer, null);
    assert.equal(writesByCollection.get('activities')[0].data.verified, true);
  });

  it('Seam 6: runVenueWebsiteSync merges cleanly with existing lower-priority Activities and is idempotent on re-run', async () => {
    const venueSeed = findMajorVenueSeed('rac-arena');
    const now = new Date('2026-11-27T10:00:00+08:00');
    const logger = createSilentLogger();

    const existingCouncilActivity = {
      id: 'council_existing_concert_1',
      region_id: 'perth',
      source: 'council',
      source_id: 'existing_concert_1',
      source_key: 'council_existing_concert_1',
      source_url: 'https://visitperth.com/events/coldplay-perth',
      raw_source_url: 'https://visitperth.com/events/coldplay-perth',
      verified: true,
      sources: [
        {
          source: 'council',
          source_id: 'existing_concert_1',
          source_key: 'council_existing_concert_1',
          source_url: 'https://visitperth.com/events/coldplay-perth',
          raw_source_url: 'https://visitperth.com/events/coldplay-perth',
          verified: true
        }
      ],
      source_keys: ['council_existing_concert_1'],
      title: 'Coldplay Music of the Spheres',
      category: 'music',
      subcategory: 'music',
      venue: {
        id: 'venue_rac_arena_qd66hr',
        name: 'RAC Arena',
        coordinates: venueSeed.coordinates,
        geohash: 'qd66hr111'
      },
      organizer: null,
      schedule: {
        recurrence: 'none',
        start_date: '2027-02-18',
        end_date: '2027-02-18',
        start_time: '19:30',
        end_time: null,
        days_of_week: [],
        timezone: 'Australia/Perth'
      },
      needs_review: false,
      review_reason: null
    };

    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'MusicEvent',
      name: 'Coldplay Music of the Spheres',
      startDate: '2027-02-18T19:30:00+08:00',
      offers: { url: 'https://premier.ticketek.com.au/shows/show.aspx?sh=COLDPLAY27' }
    })}</script>`;

    const adapter = createMemoryAdapter({
      venues: [
        {
          id: 'venue_rac_arena_qd66hr',
          name: 'RAC Arena',
          coordinates: venueSeed.coordinates,
          geohash: 'qd66hr111'
        }
      ],
      activities: [existingCouncilActivity]
    });

    const summary1 = await runVenueWebsiteSync({
      adapter,
      firecrawlClient: {
        async scrape(url) {
          return { url, html, markdown: '' };
        }
      },
      options: { venue: 'rac-arena', dryRun: false, now },
      logger
    });

    assert.equal(summary1.upsertedCount, 1);
    const merged = adapter.upsertedBatches[0][0];
    assert.equal(merged.id, 'council_existing_concert_1');
    assert.equal(merged.source, 'council');
    assert.equal(merged.source_url, 'https://premier.ticketek.com.au/shows/show.aspx?sh=COLDPLAY27');
    assert.equal(merged.verified, true);
    assert.equal(merged.sources.length, 2);
    assert.ok(merged.sources.some(s => s.source === 'council'));
    assert.ok(merged.sources.some(s => s.source === 'venue_website'));
    assert.equal(merged.needs_review, false);

    // Re-run with merged catalog -> idempotent (same canonical ID and 2 source refs)
    const rerunAdapter = createMemoryAdapter({
      venues: [
        {
          id: 'venue_rac_arena_qd66hr',
          name: 'RAC Arena',
          coordinates: venueSeed.coordinates,
          geohash: 'qd66hr111'
        }
      ],
      activities: [merged]
    });

    const summary2 = await runVenueWebsiteSync({
      adapter: rerunAdapter,
      firecrawlClient: {
        async scrape(url) {
          return { url, html, markdown: '' };
        }
      },
      options: { venue: 'rac-arena', dryRun: false, now },
      logger
    });

    assert.equal(summary2.upsertedCount, 1);
    const reMerged = rerunAdapter.upsertedBatches[0][0];
    assert.equal(reMerged.id, 'council_existing_concert_1');
    assert.equal(reMerged.sources.length, 2);
  });

  it('Seam 7 (Issue #63): parseCliArgs parses detail fan-out flags and runVenueWebsiteSync caps new detail scrapes per run with incremental cache checkpointing', async () => {
    const defaultArgs = parseCliArgs([], {});
    assert.equal(defaultArgs.maxDetailScrapes, 25);
    assert.equal(defaultArgs.detailCacheTtlMs, 10 * 24 * 60 * 60 * 1000);

    const customArgs = parseCliArgs([
      '--max-detail-scrapes=15',
      '--detail-cache-ttl-days',
      '14'
    ], {});
    assert.equal(customArgs.maxDetailScrapes, 15);
    assert.equal(customArgs.detailCacheTtlMs, 14 * 24 * 60 * 60 * 1000);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-venue-sync-'));
    const cachePath = path.join(tempDir, 'venue-sync-cache.json');
    const logger = createSilentLogger();
    const now = new Date('2026-11-27T10:00:00+08:00');
    const crownSeed = findMajorVenueSeed('crown-perth');

    try {
      const indexHtml = `<script type="application/ld+json">${JSON.stringify([
        {
          '@type': 'TheaterEvent',
          name: 'Show One',
          startDate: '2027-01-10',
          url: 'https://www.crownperth.com.au/entertainment/live-theatre/show-1'
        },
        {
          '@type': 'TheaterEvent',
          name: 'Show Two',
          startDate: '2027-01-11',
          url: 'https://www.crownperth.com.au/entertainment/live-theatre/show-2'
        },
        {
          '@type': 'TheaterEvent',
          name: 'Show Three',
          startDate: '2027-01-12',
          url: 'https://www.crownperth.com.au/entertainment/live-theatre/show-3'
        },
        {
          '@type': 'TheaterEvent',
          name: 'Show Four',
          startDate: '2027-01-13',
          url: 'https://www.crownperth.com.au/entertainment/live-theatre/show-4'
        },
        {
          '@type': 'TheaterEvent',
          name: 'Show One Duplicate Link',
          startDate: '2027-01-14',
          url: 'https://www.crownperth.com.au/entertainment/live-theatre/show-1'
        }
      ])}</script>`;

      const detailScrapesRun1 = [];
      const fakeFirecrawl = {
        async scrape(url) {
          if (url === crownSeed.whatsOnUrl) {
            return { url, html: indexHtml, markdown: '', links: [] };
          }
          detailScrapesRun1.push(url);
          if (url.endsWith('/show-3')) {
            throw new Error('Transient 503');
          }
          const num = url.slice(-1);
          return {
            url,
            html: `<script type="application/ld+json">${JSON.stringify({
              '@type': 'TheaterEvent',
              name: `Show ${num}`,
              startDate: `2027-01-1${num}T19:30:00+08:00`,
              offers: { url: `https://premier.ticketek.com.au/shows/show.aspx?sh=SHOW${num}` }
            })}</script>`,
            markdown: '',
            links: []
          };
        },
        async flushCache() {}
      };

      // Run 1: cap at 2 detail scrapes -> Show 1 & Show 2 scraped, Show 3/4/dup capped or deduped
      const cacheStore1 = createFileCacheStore(cachePath, { flushEvery: 10 });
      const summary1 = await runVenueWebsiteSync({
        adapter: createMemoryAdapter(),
        firecrawlClient: fakeFirecrawl,
        detailCacheStore: cacheStore1,
        options: {
          venue: 'crown-perth',
          dryRun: true,
          maxDetailScrapes: 2,
          now
        },
        logger
      });

      assert.equal(summary1.detailScrapesAttempted, 2);
      assert.equal(summary1.detailScrapesCapped, 2);
      assert.equal(summary1.detailCacheHits, 0);
      assert.equal(detailScrapesRun1.length, 2);
      assert.equal(summary1.validCount, 4);

      // Verify checkpoint was flushed to disk even though flushEvery was 10
      const diskJson = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      assert.ok(diskJson['venue_detail|https://www.crownperth.com.au/entertainment/live-theatre/show-1']);
      assert.ok(diskJson['venue_detail|https://www.crownperth.com.au/entertainment/live-theatre/show-2']);

      // Run 2: Show 1 & Show 2 hit cache, Show 3 fails gracefully, Show 4 is scraped
      const detailScrapesRun2 = [];
      const cacheStore2 = createFileCacheStore(cachePath, { flushEvery: 10 });
      const summary2 = await runVenueWebsiteSync({
        adapter: createMemoryAdapter(),
        firecrawlClient: {
          async scrape(url) {
            if (url === crownSeed.whatsOnUrl) {
              return { url, html: indexHtml, markdown: '', links: [] };
            }
            detailScrapesRun2.push(url);
            if (url.endsWith('/show-3')) {
              throw new Error('Transient 503');
            }
            return {
              url,
              html: `<script type="application/ld+json">${JSON.stringify({
                '@type': 'TheaterEvent',
                name: 'Show Four',
                startDate: '2027-01-13T19:30:00+08:00',
                offers: { url: 'https://premier.ticketek.com.au/shows/show.aspx?sh=SHOW4' }
              })}</script>`,
              markdown: '',
              links: []
            };
          },
          async flushCache() {}
        },
        detailCacheStore: cacheStore2,
        options: {
          venue: 'crown-perth',
          dryRun: true,
          maxDetailScrapes: 2,
          now
        },
        logger
      });

      assert.equal(summary2.detailCacheHits, 2);
      assert.equal(summary2.detailScrapesAttempted, 2);
      assert.equal(summary2.detailScrapesFailed, 1);
      assert.equal(summary2.detailScrapesCapped, 0);
      assert.equal(detailScrapesRun2.length, 2);
      assert.equal(summary2.validCount, 4);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Major-Venue Seed Expansion & Refresh Cooldown (Issue #64)', () => {
  it('Seam 1: MAJOR_VENUE_SEEDS covers 15 Greater Perth major Venues with verified URLs and non-centroid coordinates', () => {
    assert.equal(MAJOR_VENUE_SEEDS.length, 15);

    const expectedSlugs = [
      'optus-stadium',
      'rac-arena',
      'crown-perth',
      'perth-concert-hall',
      'pcec',
      'hbf-park',
      'hbf-stadium',
      'hbf-arena',
      'mandurah-pac',
      'his-majestys-theatre',
      'state-theatre-centre',
      'astor-theatre',
      'fremantle-arts-centre',
      'subiaco-arts-centre',
      'the-rechabite'
    ];
    for (const slug of expectedSlugs) {
      assert.ok(MAJOR_VENUE_SEEDS.some(s => s.slug === slug), `Missing expected seed: ${slug}`);
    }

    const slugs = new Set();
    const names = new Set();
    const urls = new Set();
    const categories = new Set();

    for (const seed of MAJOR_VENUE_SEEDS) {
      assert.ok(!slugs.has(seed.slug), `Duplicate slug: ${seed.slug}`);
      slugs.add(seed.slug);

      assert.ok(!names.has(seed.name), `Duplicate name: ${seed.name}`);
      names.add(seed.name);

      assert.match(seed.whatsOnUrl, /^https:\/\//);
      assert.ok(!urls.has(seed.whatsOnUrl), `Duplicate whatsOnUrl: ${seed.whatsOnUrl}`);
      urls.add(seed.whatsOnUrl);

      assert.equal(typeof seed.address, 'string');
      assert.ok(seed.address.trim().length > 0);
      assert.equal(typeof seed.suburb, 'string');
      assert.ok(seed.suburb.trim().length > 0);
      assert.equal(seed.regionId, 'perth');
      assert.ok(CANONICAL_CATEGORIES.includes(seed.defaultCategory), `Invalid category: ${seed.defaultCategory}`);
      categories.add(seed.defaultCategory);

      assert.ok(isWithinPerthRadius(seed.coordinates), `Seed ${seed.slug} outside Greater Perth`);

      const matchesCentroid = PERTH_SUBURB_CENTROIDS.some(
        c => Math.abs(c.lat - seed.coordinates.lat) < 1e-6 && Math.abs(c.lng - seed.coordinates.lng) < 1e-6
      );
      assert.equal(matchesCentroid, false, `Seed ${seed.slug} coordinates match a suburb centroid`);
    }

    for (const expectedCategory of ['sports', 'music', 'arts', 'community']) {
      assert.ok(categories.has(expectedCategory), `Missing category coverage: ${expectedCategory}`);
    }

    assert.equal(findMajorVenueSeed('Perth HPC')?.slug, 'hbf-stadium');
    assert.equal(findMajorVenueSeed('Perth High Performance Centre')?.slug, 'hbf-stadium');
    assert.equal(findMajorVenueSeed('Arena Joondalup')?.slug, 'hbf-arena');
    assert.equal(findMajorVenueSeed('Walyalup Fremantle Arts Centre')?.slug, 'fremantle-arts-centre');
    assert.equal(findMajorVenueSeed('Subiaco Arts Centre')?.slug, 'subiaco-arts-centre');
    assert.equal(findMajorVenueSeed('SAC')?.slug, 'subiaco-arts-centre');
    assert.equal(findMajorVenueSeed('The Rechabite')?.slug, 'the-rechabite');
  });

  it('Seam 2: resolveCanonicalVenueForSeed rejects uncertain neighbor matches, resolves aliases, and anchors every seed without suburb-centroid fallback', () => {
    const venuesCatalog = [
      {
        id: 'venue_duxton_hotel_perth_qd66hw',
        name: 'Duxton Hotel Perth',
        coordinates: { lat: -31.9579762, lng: 115.8649443 },
        geohash: 'qd66hw123'
      },
      {
        id: 'venue_hbf_arena_outdoor_netball_qd676p',
        name: 'HBF Arena Outdoor Netball',
        coordinates: { lat: -31.7334397, lng: 115.7601996 },
        geohash: 'qd676p123'
      },
      {
        id: 'venue_arena_joondalup_qd676n',
        name: 'Arena Joondalup',
        coordinates: { lat: -31.7346458, lng: 115.760704 },
        geohash: 'qd676n456'
      },
      {
        id: 'venue_perth_hpc_qd664x',
        name: 'Perth HPC',
        coordinates: { lat: -31.9524891, lng: 115.782189 },
        geohash: 'qd664x789'
      },
      {
        id: 'venue_astor_theatre_perth_qd66kd',
        name: 'Astor Theatre Perth',
        coordinates: { lat: -31.934086, lng: 115.872059 },
        geohash: 'qd66kd111'
      },
      {
        id: 'venue_walyalup_fremantle_arts_centre_qd63dj',
        name: 'Walyalup Fremantle Arts Centre',
        coordinates: { lat: -32.0476894, lng: 115.7540023 },
        geohash: 'qd63dj222'
      }
    ];

    const concertHall = resolveCanonicalVenueForSeed(findMajorVenueSeed('perth-concert-hall'), venuesCatalog);
    assert.notEqual(concertHall.id, 'venue_duxton_hotel_perth_qd66hw');
    assert.equal(concertHall.name, 'Perth Concert Hall');
    assert.deepEqual(concertHall.coordinates, findMajorVenueSeed('perth-concert-hall').coordinates);

    const hbfArena = resolveCanonicalVenueForSeed(findMajorVenueSeed('hbf-arena'), venuesCatalog);
    assert.equal(hbfArena.id, 'venue_arena_joondalup_qd676n');
    assert.equal(hbfArena.name, 'Arena Joondalup');

    const hbfStadium = resolveCanonicalVenueForSeed(findMajorVenueSeed('hbf-stadium'), venuesCatalog);
    assert.equal(hbfStadium.id, 'venue_perth_hpc_qd664x');
    assert.equal(hbfStadium.name, 'Perth HPC');

    const astor = resolveCanonicalVenueForSeed(findMajorVenueSeed('astor-theatre'), venuesCatalog);
    assert.equal(astor.id, 'venue_astor_theatre_perth_qd66kd');

    const fac = resolveCanonicalVenueForSeed(findMajorVenueSeed('fremantle-arts-centre'), venuesCatalog);
    assert.equal(fac.id, 'venue_walyalup_fremantle_arts_centre_qd63dj');

    for (const seed of MAJOR_VENUE_SEEDS) {
      const ingested = ingestVenueActivity(
        {
          source_id: `test_${seed.slug}`,
          source_url: seed.whatsOnUrl,
          title: `Test Show at ${seed.name}`,
          category: seed.defaultCategory,
          start_date: '2027-02-01T19:30:00+08:00',
          schedule: { recurrence: 'none', start_date: '2027-02-01', start_time: '19:30' }
        },
        { venueSeed: seed, venuesCatalog }
      );
      assert.ok(ingested, `ingestVenueActivity returned null for ${seed.slug}`);
      assert.equal(ingested.needs_review, false, `Unexpected needs_review for ${seed.slug}`);
      assert.equal(ingested.review_reason, null, `Unexpected review_reason for ${seed.slug}`);
      assert.equal(typeof ingested.venue.coordinates.lat, 'number');
      assert.equal(typeof ingested.venue.coordinates.lng, 'number');
    }
  });

  it('Seam 3: parseCliArgs and isVenueWithinCooldown enforce per-venue 2-3 day cooldown with --force/--refresh overrides', () => {
    const defaultArgs = parseCliArgs([], {});
    assert.equal(defaultArgs.force, false);
    assert.equal(defaultArgs.refresh, false);
    assert.equal(defaultArgs.venueCooldownMs, DEFAULT_VENUE_COOLDOWN_MS);
    assert.equal(defaultArgs.venueCooldownMs, 2 * 24 * 60 * 60 * 1000);

    const forceArgs = parseCliArgs(['--force', '--cooldown-days=3'], {});
    assert.equal(forceArgs.force, true);
    assert.equal(forceArgs.venueCooldownMs, 3 * 24 * 60 * 60 * 1000);

    const zeroCooldownArgs = parseCliArgs(['--refresh', '--cooldown-days', '0'], {});
    assert.equal(zeroCooldownArgs.refresh, true);
    assert.equal(zeroCooldownArgs.venueCooldownMs, 0);

    const baseMs = Date.parse('2026-11-27T10:00:00+08:00');
    const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
    const checkpoint = { lastSyncedAt: new Date(baseMs).toISOString() };

    assert.equal(
      isVenueWithinCooldown(checkpoint, { now: new Date(baseMs + 24 * 60 * 60 * 1000), cooldownMs: twoDaysMs }),
      true
    );
    assert.equal(
      isVenueWithinCooldown(checkpoint, { now: new Date(baseMs + twoDaysMs), cooldownMs: twoDaysMs }),
      false
    );
    assert.equal(
      isVenueWithinCooldown(checkpoint, { now: new Date(baseMs + twoDaysMs + 1000), cooldownMs: twoDaysMs }),
      false
    );
    assert.equal(
      isVenueWithinCooldown(checkpoint, { now: new Date(baseMs + 1000), cooldownMs: twoDaysMs, force: true }),
      false
    );
    assert.equal(
      isVenueWithinCooldown(checkpoint, { now: new Date(baseMs + 1000), cooldownMs: twoDaysMs, refresh: true }),
      false
    );
    assert.equal(
      isVenueWithinCooldown(checkpoint, { now: new Date(baseMs + 1000), cooldownMs: 0 }),
      false
    );
    assert.equal(
      isVenueWithinCooldown(null, { now: new Date(baseMs), cooldownMs: twoDaysMs }),
      false
    );
    assert.equal(
      isVenueWithinCooldown({ lastSyncedAt: 'invalid-date' }, { now: new Date(baseMs), cooldownMs: twoDaysMs }),
      false
    );
  });

  it('Seam 4: runVenueWebsiteSync skips recently synced Venues within cooldown, honors --force/--refresh, refreshes expired index, and skips checkpointing on failure or dry-run', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-venue-cooldown-'));
    const cachePath = path.join(tempDir, 'venue-sync-cache.json');
    const logger = createSilentLogger();
    const t0 = new Date('2026-11-27T10:00:00+08:00');
    const racSeed = findMajorVenueSeed('rac-arena');
    const detailUrl = 'https://www.racarena.com.au/whats-on/perth-symphony';

    try {
      const scrapeCalls = [];
      let failIndex = false;
      const fakeFirecrawl = {
        async scrape(url, opts = {}) {
          scrapeCalls.push({ url, refresh: Boolean(opts.refresh) });
          if (failIndex && url === racSeed.whatsOnUrl) {
            throw new Error('Upstream 503');
          }
          if (url === racSeed.whatsOnUrl) {
            return {
              url,
              html: `<script type="application/ld+json">${JSON.stringify({
                '@type': 'MusicEvent',
                name: 'Perth Symphony',
                startDate: '2027-01-15',
                url: detailUrl
              })}</script>`,
              markdown: '',
              links: []
            };
          }
          return {
            url,
            html: `<script type="application/ld+json">${JSON.stringify({
              '@type': 'MusicEvent',
              name: 'Perth Symphony',
              startDate: '2027-01-15T19:30:00+08:00',
              offers: { url: 'https://premier.ticketek.com.au/shows/show.aspx?sh=SYMPHONY27' }
            })}</script>`,
            markdown: '',
            links: []
          };
        },
        async flushCache() {}
      };

      // 7. Failed index scrape does NOT write a cooldown checkpoint
      failIndex = true;
      const cacheStoreFail = createFileCacheStore(cachePath, { flushEvery: 5 });
      const failSummary = await runVenueWebsiteSync({
        adapter: createMemoryAdapter(),
        firecrawlClient: fakeFirecrawl,
        cacheStore: cacheStoreFail,
        options: { venue: 'rac-arena', dryRun: false, now: t0 },
        logger
      });
      assert.equal(failSummary.failedVenues, 1);
      assert.equal(await cacheStoreFail.read(`${VENUE_COOLDOWN_KEY_PREFIX}rac-arena`), null);
      failIndex = false;

      // 6. dryRun: true does NOT write a cooldown checkpoint
      const dryCachePath = path.join(tempDir, 'dry-venue-sync-cache.json');
      const cacheStoreDry = createFileCacheStore(dryCachePath, { flushEvery: 5 });
      const drySummary0 = await runVenueWebsiteSync({
        adapter: createMemoryAdapter(),
        firecrawlClient: fakeFirecrawl,
        cacheStore: cacheStoreDry,
        options: { venue: 'rac-arena', dryRun: true, now: t0 },
        logger
      });
      assert.equal(drySummary0.processedVenues, 1);
      assert.equal(await cacheStoreDry.read(`${VENUE_COOLDOWN_KEY_PREFIX}rac-arena`), null);

      // 1. Apply run writes venue_sync|<slug> checkpoint with lastSyncedAt
      scrapeCalls.length = 0;
      const cacheStore1 = createFileCacheStore(cachePath, { flushEvery: 5 });
      const applySummary = await runVenueWebsiteSync({
        adapter: createMemoryAdapter(),
        firecrawlClient: fakeFirecrawl,
        cacheStore: cacheStore1,
        options: { venue: 'rac-arena', dryRun: false, now: t0 },
        logger
      });
      assert.equal(applySummary.processedVenues, 1);
      assert.equal(applySummary.skippedCooldownVenues, 0);
      assert.equal(scrapeCalls.length, 2);
      const savedCheckpoint = await cacheStore1.read(`${VENUE_COOLDOWN_KEY_PREFIX}rac-arena`);
      assert.equal(savedCheckpoint?.lastSyncedAt, t0.toISOString());

      // 2. Second run +24h later skips venue (both apply and dry-run respect cooldown)
      const t24h = new Date(t0.getTime() + 24 * 60 * 60 * 1000);
      scrapeCalls.length = 0;
      const cacheStore2 = createFileCacheStore(cachePath, { flushEvery: 5 });
      const skippedApply = await runVenueWebsiteSync({
        adapter: createMemoryAdapter(),
        firecrawlClient: fakeFirecrawl,
        cacheStore: cacheStore2,
        options: { venue: 'rac-arena', dryRun: false, now: t24h },
        logger
      });
      assert.equal(skippedApply.skippedCooldownVenues, 1);
      assert.equal(skippedApply.processedVenues, 0);
      assert.equal(scrapeCalls.length, 0);

      const skippedDry = await runVenueWebsiteSync({
        adapter: createMemoryAdapter(),
        firecrawlClient: fakeFirecrawl,
        cacheStore: cacheStore2,
        options: { venue: 'rac-arena', dryRun: true, now: t24h },
        logger
      });
      assert.equal(skippedDry.skippedCooldownVenues, 1);
      assert.equal(skippedDry.processedVenues, 0);
      assert.equal(scrapeCalls.length, 0);

      // 3. Run +24h later with force: true overrides cooldown and passes refresh: true to index scrape
      scrapeCalls.length = 0;
      const cacheStore3 = createFileCacheStore(cachePath, { flushEvery: 5 });
      const forceSummary = await runVenueWebsiteSync({
        adapter: createMemoryAdapter(),
        firecrawlClient: fakeFirecrawl,
        cacheStore: cacheStore3,
        options: { venue: 'rac-arena', dryRun: false, force: true, now: t24h },
        logger
      });
      assert.equal(forceSummary.skippedCooldownVenues, 0);
      assert.equal(forceSummary.processedVenues, 1);
      assert.equal(scrapeCalls.length, 1); // detail page hits cache!
      assert.deepEqual(scrapeCalls[0], { url: racSeed.whatsOnUrl, refresh: true });

      // 4. Run +24h later with refresh: true overrides cooldown and passes refresh: true to index and detail fan-out
      scrapeCalls.length = 0;
      const cacheStore4 = createFileCacheStore(cachePath, { flushEvery: 5 });
      const refreshSummary = await runVenueWebsiteSync({
        adapter: createMemoryAdapter(),
        firecrawlClient: fakeFirecrawl,
        cacheStore: cacheStore4,
        options: { venue: 'rac-arena', dryRun: false, refresh: true, now: t24h },
        logger
      });
      assert.equal(refreshSummary.skippedCooldownVenues, 0);
      assert.equal(refreshSummary.processedVenues, 1);
      assert.equal(scrapeCalls.length, 2);
      assert.deepEqual(scrapeCalls[0], { url: racSeed.whatsOnUrl, refresh: true });
      assert.deepEqual(scrapeCalls[1], { url: detailUrl, refresh: true });

      // 5. Run +49h later (cooldown expired) scrapes index with refresh: true while preserving detail cache
      const t73h = new Date(t24h.getTime() + 49 * 60 * 60 * 1000);
      scrapeCalls.length = 0;
      const cacheStore5 = createFileCacheStore(cachePath, { flushEvery: 5 });
      const expiredSummary = await runVenueWebsiteSync({
        adapter: createMemoryAdapter(),
        firecrawlClient: fakeFirecrawl,
        cacheStore: cacheStore5,
        options: { venue: 'rac-arena', dryRun: false, now: t73h },
        logger
      });
      assert.equal(expiredSummary.skippedCooldownVenues, 0);
      assert.equal(expiredSummary.processedVenues, 1);
      assert.equal(expiredSummary.detailCacheHits, 1);
      assert.equal(scrapeCalls.length, 1);
      assert.deepEqual(scrapeCalls[0], { url: racSeed.whatsOnUrl, refresh: true });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
