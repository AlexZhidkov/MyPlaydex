import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreAdapter } from '../src/firestore-adapter.js';
import { CANONICAL_CATEGORIES } from '../src/sanitizer.js';
import { isWithinPerthRadius } from '../src/venue-resolver.js';
import {
  MAJOR_VENUE_SEEDS,
  findMajorVenueSeed
} from '../src/major-venue-seeds.js';
import {
  VENUE_WEBSITE_SOURCE,
  extractVenueJsonLdActivities,
  ingestVenueActivity,
  main,
  parseCliArgs,
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
});
