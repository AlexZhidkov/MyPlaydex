import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileCacheStore } from '../src/file-cache.js';
import {
  DEFAULT_DETAIL_CACHE_TTL_MS,
  DEFAULT_MAX_DETAIL_SCRAPES_PER_RUN,
  DETAIL_CACHE_KEY_PREFIX,
  DIRECT_TICKETING_HOSTS,
  assessDetailFanOutNeed,
  expandVenueActivitiesWithDetailFanOut,
  extractDirectTicketingUrlFromContent,
  isDirectTicketingUrl,
  isMultiSessionDateRange,
  resolveDetailPageUrl
} from '../src/venue-detail-fanout.js';
import { extractVenueJsonLdActivities } from '../src/venue-website-sync.js';
import { filterAndNormalizeGeminiActivities } from '../src/markdown-activity-extractor.js';
import { ACTIVITY_EXTRACTION_RESPONSE_SCHEMA } from '../src/gemini-flash-client.js';

describe('Venue Detail Fan-Out (Issue #63)', () => {
  const crownSeed = {
    slug: 'crown-perth',
    name: 'Crown Perth',
    whatsOnUrl: 'https://www.crownperth.com.au/entertainment/live-theatre'
  };

  it('Slice 1: isDirectTicketingUrl detects external ticketing hosts and same-site checkout paths', () => {
    assert.ok(Array.isArray(DIRECT_TICKETING_HOSTS));
    assert.ok(DIRECT_TICKETING_HOSTS.includes('ticketek.com.au'));
    assert.equal(DEFAULT_DETAIL_CACHE_TTL_MS, 10 * 24 * 60 * 60 * 1000);
    assert.equal(DEFAULT_MAX_DETAIL_SCRAPES_PER_RUN, 25);
    assert.equal(DETAIL_CACHE_KEY_PREFIX, 'venue_detail|');

    assert.equal(
      isDirectTicketingUrl('https://premier.ticketek.com.au/shows/show.aspx?sh=WICKED27', crownSeed.whatsOnUrl),
      true
    );
    assert.equal(
      isDirectTicketingUrl('https://www.ticketmaster.com.au/event/123', crownSeed.whatsOnUrl),
      true
    );
    assert.equal(
      isDirectTicketingUrl('https://events.humanitix.com/perth-show', crownSeed.whatsOnUrl),
      true
    );
    assert.equal(
      isDirectTicketingUrl('https://www.artsculturetrust.wa.gov.au/tickets/wa-ballet-gala', 'https://www.artsculturetrust.wa.gov.au/venues/his-majestys-theatre/whats-on/'),
      true
    );
    assert.equal(
      isDirectTicketingUrl('https://tickets.crownperth.com.au/checkout/123', crownSeed.whatsOnUrl),
      true
    );
    assert.equal(
      isDirectTicketingUrl('https://www.crownperth.com.au/entertainment/live-theatre/wicked', crownSeed.whatsOnUrl),
      false
    );
    assert.equal(isDirectTicketingUrl(null, crownSeed.whatsOnUrl), false);
    assert.equal(isDirectTicketingUrl('not a url', crownSeed.whatsOnUrl), false);
  });

  it('Slice 1: resolveDetailPageUrl resolves same-host HTML detail URLs and rejects index, assets, and external ticketing hosts', () => {
    assert.equal(
      resolveDetailPageUrl({
        _detailUrl: '/entertainment/live-theatre/wicked#dates',
        source_url: 'https://premier.ticketek.com.au/shows/show.aspx?sh=WICKED27'
      }, crownSeed),
      'https://www.crownperth.com.au/entertainment/live-theatre/wicked'
    );

    assert.equal(
      resolveDetailPageUrl({
        detail_url: 'https://crownperth.com.au/entertainment/live-theatre/hamilton'
      }, crownSeed),
      'https://crownperth.com.au/entertainment/live-theatre/hamilton'
    );

    // Same as index URL (with/without trailing slash) -> rejected
    assert.equal(
      resolveDetailPageUrl({
        source_url: 'https://www.crownperth.com.au/entertainment/live-theatre/'
      }, crownSeed),
      null
    );

    // External ticketing host -> never scraped
    assert.equal(
      resolveDetailPageUrl({
        source_url: 'https://premier.ticketek.com.au/shows/show.aspx?sh=WICKED27'
      }, crownSeed),
      null
    );

    // Non-HTML asset -> rejected
    assert.equal(
      resolveDetailPageUrl({
        _detailUrl: 'https://www.crownperth.com.au/brochure.pdf'
      }, crownSeed),
      null
    );

    // Credentials in URL -> rejected
    assert.equal(
      resolveDetailPageUrl({
        _detailUrl: 'https://user:pass@www.crownperth.com.au/entertainment/show'
      }, crownSeed),
      null
    );
  });

  it('Slice 1: isMultiSessionDateRange distinguishes multi-day runs from overnight single-session performances', () => {
    assert.equal(
      isMultiSessionDateRange({
        schedule: { start_date: '2027-01-15', end_date: '2027-01-24', start_time: '19:30', end_time: '22:00' }
      }),
      true
    );

    // Single day -> not multi-session
    assert.equal(
      isMultiSessionDateRange({
        schedule: { start_date: '2027-01-15', end_date: '2027-01-15', start_time: '19:30', end_time: '22:00' }
      }),
      false
    );

    // Overnight single-session performance (21:00 to 01:00 = 4 hours <= 16 hours) -> not multi-session
    assert.equal(
      isMultiSessionDateRange({
        schedule: { start_date: '2027-01-15', end_date: '2027-01-16', start_time: '21:00', end_time: '01:00' }
      }),
      false
    );

    // Multi-day without times -> multi-session
    assert.equal(
      isMultiSessionDateRange({
        schedule: { start_date: '2027-01-15', end_date: '2027-01-16' }
      }),
      true
    );
  });

  it('Slice 1: assessDetailFanOutNeed skips complete index cards and flags incomplete cards with a valid detail URL', () => {
    // Complete card: start_time present, single day, direct ticketing URL -> no fan-out
    const complete = assessDetailFanOutNeed({
      title: 'Perth Symphony Live',
      source_url: 'https://premier.ticketek.com.au/shows/show.aspx?sh=SYMPHONY26',
      _detailUrl: 'https://www.crownperth.com.au/entertainment/live-theatre/symphony',
      schedule: { start_date: '2027-01-15', end_date: '2027-01-15', start_time: '19:30', end_time: '22:00' },
      _missingStartTime: false
    }, crownSeed);
    assert.equal(complete.needsFanOut, false);
    assert.deepEqual(complete.reasons, []);

    // Missing start time -> fan-out
    const missingTime = assessDetailFanOutNeed({
      title: 'Mystery Show',
      source_url: 'https://www.crownperth.com.au/entertainment/live-theatre/mystery',
      schedule: { start_date: '2027-01-15', end_date: '2027-01-15', start_time: null },
      _missingStartTime: true
    }, crownSeed);
    assert.equal(missingTime.needsFanOut, true);
    assert.ok(missingTime.reasons.includes('missing_start_time'));
    assert.ok(missingTime.reasons.includes('missing_ticket_url'));
    assert.equal(missingTime.detailUrl, 'https://www.crownperth.com.au/entertainment/live-theatre/mystery');

    // Multi-session run even with ticketing URL -> fan-out
    const multiSession = assessDetailFanOutNeed({
      title: 'Wicked The Musical',
      source_url: 'https://premier.ticketek.com.au/shows/show.aspx?sh=WICKED27',
      _detailUrl: 'https://www.crownperth.com.au/entertainment/live-theatre/wicked',
      schedule: { start_date: '2027-01-15', end_date: '2027-02-15', start_time: '19:30', end_time: '22:00' },
      _missingStartTime: false
    }, crownSeed);
    assert.equal(multiSession.needsFanOut, true);
    assert.deepEqual(multiSession.reasons, ['multi_session_range']);

    // Incomplete card but only external ticketing URL (no venue detail URL) -> cannot fan out
    const noDetailUrl = assessDetailFanOutNeed({
      title: 'External Only Show',
      source_url: 'https://premier.ticketek.com.au/shows/show.aspx?sh=EXT27',
      schedule: { start_date: '2027-01-15', end_date: '2027-01-15', start_time: null },
      _missingStartTime: true
    }, crownSeed);
    assert.equal(noDetailUrl.needsFanOut, false);
    assert.equal(noDetailUrl.detailUrl, null);
  });

  it('Slice 2: extractDirectTicketingUrlFromContent prefers external ticketing hosts over same-site ticket links', () => {
    const detailUrl = 'https://www.crownperth.com.au/entertainment/live-theatre/wicked';
    const picked = extractDirectTicketingUrlFromContent({
      html: '<a href="/tickets/wicked-box-office">Box Office</a><a href="http://premier.ticketek.com.au/shows/show.aspx?sh=WICKED27">Buy on Ticketek</a>',
      markdown: '[Box Office](https://www.crownperth.com.au/tickets/wicked-box-office)',
      links: ['https://www.crownperth.com.au/tickets/wicked-box-office'],
      detailUrl,
      venueWhatsOnUrl: crownSeed.whatsOnUrl
    });
    assert.equal(picked, 'https://premier.ticketek.com.au/shows/show.aspx?sh=WICKED27');

    // Falls back to same-site ticket link when no external ticketing host is present
    const sameSite = extractDirectTicketingUrlFromContent({
      html: '<a href="/tickets/wicked-box-office">Buy Tickets</a>',
      markdown: '',
      links: [],
      detailUrl,
      venueWhatsOnUrl: crownSeed.whatsOnUrl
    });
    assert.equal(sameSite, 'https://www.crownperth.com.au/tickets/wicked-box-office');

    // Returns null when no ticketing link exists
    const none = extractDirectTicketingUrlFromContent({
      html: '<a href="/about">About</a>',
      markdown: '[About](/about)',
      links: ['https://www.crownperth.com.au/about'],
      detailUrl,
      venueWhatsOnUrl: crownSeed.whatsOnUrl
    });
    assert.equal(none, null);
  });

  it('Slice 2: expands Schema.org subEvent multi-performance runs within 6 months and attaches direct ticketing URL', async () => {
    const now = new Date('2026-11-27T10:00:00+08:00');
    const detailUrl = 'https://www.crownperth.com.au/entertainment/live-theatre/wicked';
    const indexActivities = extractVenueJsonLdActivities(
      `<script type="application/ld+json">${JSON.stringify({
        '@type': 'TheaterEvent',
        name: 'Wicked The Musical',
        startDate: '2027-01-15',
        endDate: '2027-02-20',
        url: detailUrl
      })}</script>`,
      { scrapedUrl: crownSeed.whatsOnUrl, venueSeed: crownSeed, now }
    );
    assert.equal(indexActivities.length, 1);

    const detailHtml = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'TheaterEvent',
      name: 'Wicked The Musical',
      description: 'The Broadway musical sensation.',
      url: detailUrl,
      offers: {
        '@type': 'Offer',
        price: '129',
        priceCurrency: 'AUD',
        url: 'https://premier.ticketek.com.au/shows/show.aspx?sh=WICKED27'
      },
      subEvent: [
        {
          '@type': 'TheaterEvent',
          startDate: '2027-01-15T19:30:00+08:00',
          endDate: '2027-01-15T22:15:00+08:00'
        },
        {
          '@type': 'TheaterEvent',
          startDate: '2027-01-16T14:00:00+08:00',
          endDate: '2027-01-16T16:45:00+08:00'
        },
        {
          '@type': 'TheaterEvent',
          startDate: '2026-11-01T19:30:00+08:00'
        },
        {
          '@type': 'TheaterEvent',
          startDate: '2027-08-01T19:30:00+08:00'
        }
      ]
    })}</script>`;

    const scraped = [];
    const { activities, stats } = await expandVenueActivitiesWithDetailFanOut({
      rawActivities: indexActivities,
      venueSeed: crownSeed,
      firecrawlClient: {
        async scrape(url) {
          scraped.push(url);
          return { url, html: detailHtml, markdown: '', links: [] };
        }
      },
      extractVenueJsonLdActivities,
      now
    });

    assert.deepEqual(scraped, [detailUrl]);
    assert.equal(stats.detailCandidates, 1);
    assert.equal(stats.detailScrapesAttempted, 1);
    assert.equal(stats.detailExpandedCount, 2);
    assert.equal(activities.length, 2);

    assert.equal(activities[0].title, 'Wicked The Musical');
    assert.equal(activities[0].schedule.start_date, '2027-01-15');
    assert.equal(activities[0].schedule.start_time, '19:30');
    assert.equal(activities[0].source_url, 'https://premier.ticketek.com.au/shows/show.aspx?sh=WICKED27');
    assert.equal(activities[0].sources.length, 1);
    assert.equal(activities[0]._missingStartTime, false);

    assert.equal(activities[1].schedule.start_date, '2027-01-16');
    assert.equal(activities[1].schedule.start_time, '14:00');
    assert.notEqual(activities[0].source_id, activities[1].source_id);
  });

  it('Slice 2: uses Gemini Flash Markdown fallback on detail pages, supports detail_url, and falls back to detailUrl when no ticket link exists', async () => {
    const now = new Date('2026-11-27T10:00:00+08:00');
    assert.deepEqual(
      ACTIVITY_EXTRACTION_RESPONSE_SCHEMA.properties.activities.items.properties.detail_url,
      { type: 'STRING', nullable: true }
    );
    assert.equal(
      ACTIVITY_EXTRACTION_RESPONSE_SCHEMA.properties.activities.items.required.includes('detail_url'),
      false
    );

    const normalizedIndex = filterAndNormalizeGeminiActivities(
      [
        {
          title: 'Comedy Gala',
          category: 'arts',
          start_date: '2027-02-10',
          end_date: '2027-02-12',
          start_time: null,
          detail_url: '/entertainment/live-theatre/comedy-gala',
          ticket_url: null,
          is_noise: false,
          confidence: 'high'
        }
      ],
      { scrapedUrl: crownSeed.whatsOnUrl, source: 'venue_website', now }
    );
    assert.equal(normalizedIndex.length, 1);
    assert.equal(normalizedIndex[0]._detailUrl, 'https://www.crownperth.com.au/entertainment/live-theatre/comedy-gala');

    const { activities, stats } = await expandVenueActivitiesWithDetailFanOut({
      rawActivities: normalizedIndex,
      venueSeed: crownSeed,
      firecrawlClient: {
        async scrape(url) {
          return {
            url,
            html: '<html><body><h1>Comedy Gala</h1></body></html>',
            markdown: '# Comedy Gala\nWed 10 Feb 7:30pm\nThu 11 Feb 7:30pm',
            links: []
          };
        }
      },
      geminiClient: {
        async extractActivitiesFromMarkdown() {
          return {
            activities: [
              {
                title: 'Comedy Gala',
                category: 'arts',
                start_date: '2027-02-10',
                start_time: '19:30',
                end_time: '21:30',
                ticket_url: null,
                is_noise: false,
                confidence: 'high'
              },
              {
                title: 'Comedy Gala',
                category: 'arts',
                start_date: '2027-02-11',
                start_time: '19:30',
                end_time: '21:30',
                ticket_url: null,
                is_noise: false,
                confidence: 'high'
              }
            ]
          };
        }
      },
      extractVenueJsonLdActivities,
      now
    });

    assert.equal(stats.llmFallbackCalls, 1);
    assert.equal(activities.length, 2);
    assert.equal(activities[0].schedule.start_date, '2027-02-10');
    assert.equal(activities[0].schedule.start_time, '19:30');
    assert.equal(activities[0].source_url, 'https://www.crownperth.com.au/entertainment/live-theatre/comedy-gala');
    assert.equal(activities[1].schedule.start_date, '2027-02-11');
  });

  it('Slice 3: persists detail cache to disk, hits within TTL while filtering expired performances, and re-scrapes on TTL expiry or refresh', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-detail-cache-'));
    const cachePath = path.join(tempDir, 'venue-detail-cache.json');
    const detailUrl = 'https://www.crownperth.com.au/entertainment/live-theatre/seasonal-show';

    try {
      const indexCard = [
        {
          title: 'Seasonal Show',
          category: 'arts',
          source_url: detailUrl,
          _detailUrl: detailUrl,
          schedule: { recurrence: 'none', start_date: '2026-11-30', end_date: '2026-12-12', start_time: null },
          _missingStartTime: true
        }
      ];

      let scrapeCount = 0;
      let geminiCount = 0;
      const firecrawlClient = {
        async scrape(url) {
          scrapeCount += 1;
          return {
            url,
            html: '<html><body><h1>Seasonal Show</h1></body></html>',
            markdown: '# Seasonal Show\nNov 30 7:30pm\nDec 12 7:30pm',
            links: ['https://premier.ticketek.com.au/shows/show.aspx?sh=SEASON26']
          };
        }
      };
      const geminiClient = {
        async extractActivitiesFromMarkdown() {
          geminiCount += 1;
          return {
            activities: [
              {
                title: 'Seasonal Show',
                category: 'arts',
                start_date: '2026-11-30',
                start_time: '19:30',
                is_noise: false,
                confidence: 'high'
              },
              {
                title: 'Seasonal Show',
                category: 'arts',
                start_date: '2026-12-12',
                start_time: '19:30',
                is_noise: false,
                confidence: 'high'
              }
            ]
          };
        }
      };

      // Run 1 (Day 0): scrapes and persists checkpoint
      const store1 = createFileCacheStore(cachePath, { flushEvery: 1 });
      const run1 = await expandVenueActivitiesWithDetailFanOut({
        rawActivities: indexCard,
        venueSeed: crownSeed,
        firecrawlClient,
        geminiClient,
        detailCacheStore: store1,
        extractVenueJsonLdActivities,
        now: new Date('2026-11-27T10:00:00+08:00')
      });
      assert.equal(scrapeCount, 1);
      assert.equal(geminiCount, 1);
      assert.equal(run1.stats.detailCacheHits, 0);
      assert.equal(run1.activities.length, 2);
      assert.equal(run1.activities[0].source_url, 'https://premier.ticketek.com.au/shows/show.aspx?sh=SEASON26');

      const rawDisk = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      assert.ok(rawDisk[`${DETAIL_CACHE_KEY_PREFIX}${detailUrl}`]);

      // Run 2 (Day +5, within 10-day TTL): cache hit, 0 Firecrawl/Gemini calls, Nov 30 filtered out as past
      const store2 = createFileCacheStore(cachePath, { flushEvery: 1 });
      const run2 = await expandVenueActivitiesWithDetailFanOut({
        rawActivities: indexCard,
        venueSeed: crownSeed,
        firecrawlClient,
        geminiClient,
        detailCacheStore: store2,
        extractVenueJsonLdActivities,
        now: new Date('2026-12-02T10:00:00+08:00')
      });
      assert.equal(scrapeCount, 1);
      assert.equal(geminiCount, 1);
      assert.equal(run2.stats.detailCacheHits, 1);
      assert.equal(run2.stats.detailScrapesAttempted, 0);
      assert.equal(run2.activities.length, 1);
      assert.equal(run2.activities[0].schedule.start_date, '2026-12-12');

      // Run 3 (Day +11, past 10-day TTL): re-scrapes
      const run3 = await expandVenueActivitiesWithDetailFanOut({
        rawActivities: indexCard,
        venueSeed: crownSeed,
        firecrawlClient,
        geminiClient,
        detailCacheStore: store2,
        extractVenueJsonLdActivities,
        now: new Date('2026-12-08T10:00:00+08:00')
      });
      assert.equal(scrapeCount, 2);
      assert.equal(geminiCount, 2);
      assert.equal(run3.stats.detailCacheHits, 0);
      assert.equal(run3.stats.detailScrapesAttempted, 1);

      // Run 4 (refresh: true within TTL): forces re-scrape
      const run4 = await expandVenueActivitiesWithDetailFanOut({
        rawActivities: indexCard,
        venueSeed: crownSeed,
        firecrawlClient,
        geminiClient,
        detailCacheStore: store2,
        extractVenueJsonLdActivities,
        now: new Date('2026-12-09T10:00:00+08:00'),
        refresh: true
      });
      assert.equal(scrapeCount, 3);
      assert.equal(run4.stats.detailScrapesAttempted, 1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
