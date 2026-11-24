import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVisitPerthCrawler,
  VISIT_PERTH_CONFIG,
  VISIT_PERTH_LGA_CENTROID
} from '../src/crawlers/visit-perth-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';
import { runCrawlerHarness, getDefaultCrawlers } from '../src/crawler-runner.js';

const TEST_NOW = new Date('2026-11-01T08:00:00+08:00');

function wrapAppStateHtml(results, totalRecords = results.length) {
  return `<!DOCTYPE html><html><body>
    <script type="application/json" id="site-search-app-state">${JSON.stringify({
      schemaVersion: 1,
      pageSize: 24,
      results: {
        totalRecords,
        page: 1,
        pageSize: 24,
        results
      }
    })}</script>
  </body></html>`;
}

test('Visit Perth Crawler maps 9 canonical categories, deterministic visit_perth_<id> keys, and explicit vs unset Organizer', async () => {
  const html = wrapAppStateHtml([
    {
      contentGuid: 'guid-arts-1',
      properties: {
        Name: 'Noongar Six Seasons Exhibition',
        Url: '/events/noongar-six-seasons/',
        Summary: 'Visual arts exhibition.',
        Categories: [{ name: 'Art and exhibitions' }, { name: 'Free' }],
        Location: '142 Lake Street, Northbridge, 6003',
        EventListing: { dateParts: [{ isoDateTime: '2026-11-15' }] },
        Latitude: -31.9477195,
        Longitude: 115.8572507
      }
    },
    {
      contentGuid: 'guid-music-1',
      properties: {
        Name: 'Twilight Symphony in the Park',
        Url: '/events/twilight-symphony/',
        Categories: [{ name: 'Concerts' }, { name: 'Ticketed' }],
        Location: 'Supreme Court Gardens, Perth',
        OrganizerName: 'Perth Symphony Orchestra',
        EventListing: { dateParts: [{ isoDateTime: '2026-11-20' }] },
        Latitude: -31.956,
        Longitude: 115.860
      }
    },
    {
      contentGuid: 'guid-family-1',
      properties: {
        Name: 'School Holiday Puppet Show',
        Url: '/events/puppet-show/',
        Categories: [{ name: 'Families' }],
        Location: 'Perth Town Hall',
        EventListing: { dateParts: [{ isoDateTime: '2026-11-22' }] },
        Latitude: -31.954,
        Longitude: 115.861
      }
    },
    {
      contentGuid: 'guid-hobbies-1',
      properties: {
        Name: 'Botanical Sketching',
        Url: '/events/sketching/',
        Categories: [{ name: 'Workshops' }],
        Location: 'Kings Park',
        EventListing: { dateParts: [{ isoDateTime: '2026-11-23' }] },
        Latitude: -31.9608,
        Longitude: 115.8322
      }
    },
    {
      contentGuid: 'guid-travel-1',
      properties: {
        Name: 'Heritage Walking Trail',
        Url: '/events/heritage-trail/',
        Categories: [{ name: 'Tours' }],
        Location: 'Barrack Square',
        EventListing: { dateParts: [{ isoDateTime: '2026-11-24' }] },
        Latitude: -31.959,
        Longitude: 115.858
      }
    },
    {
      contentGuid: 'guid-sports-1',
      properties: {
        Name: 'Langley Park Social Touch Rugby',
        Url: '/events/touch-rugby/',
        Categories: [{ name: 'Sport' }],
        Location: 'Langley Park',
        EventListing: { dateParts: [{ isoDateTime: '2026-11-25' }] },
        Latitude: -31.961,
        Longitude: 115.867
      }
    },
    {
      contentGuid: 'guid-community-1',
      properties: {
        Name: 'Perth Seniors Morning Tea',
        Url: '/events/seniors-tea/',
        Categories: [{ name: 'Seniors' }],
        Location: 'City of Perth Library',
        EventListing: { dateParts: [{ isoDateTime: '2026-11-26' }] },
        Latitude: -31.955,
        Longitude: 115.861
      }
    }
  ]);

  const crawler = createVisitPerthCrawler({
    now: TEST_NOW,
    pageDelayMs: 0,
    fetchFn: async () => ({ ok: true, async text() { return html; } })
  });

  assert.equal(crawler.name, 'visit_perth');
  assert.equal(crawler.group, 'councils');
  assert.deepEqual(crawler.fallbackCentroid, VISIT_PERTH_LGA_CENTROID);
  assert.equal(VISIT_PERTH_CONFIG.defaultOrganizer, null);

  const items = await crawler.fetchListings();
  assert.equal(items.length, 7);

  const arts = sanitizeActivity(items[0]);
  assert.equal(arts.id, 'visit_perth_guid-arts-1');
  assert.equal(arts.category, 'arts');
  assert.equal(items[0].organizer, undefined);

  const music = sanitizeActivity(items[1]);
  assert.equal(music.id, 'visit_perth_guid-music-1');
  assert.equal(music.category, 'music');
  assert.equal(music.organizer.name, 'Perth Symphony Orchestra');

  assert.equal(sanitizeActivity(items[2]).category, 'family');
  assert.equal(sanitizeActivity(items[3]).category, 'hobbies');
  assert.equal(sanitizeActivity(items[4]).category, 'travel');
  assert.equal(sanitizeActivity(items[5]).category, 'sports');
  assert.equal(sanitizeActivity(items[6]).category, 'community');
});

test('Visit Perth Crawler in runCrawlerHarness suppresses /organizers when unattributed, flags Unreviewed Listing, and falls back to LGA centroid', async () => {
  const html = wrapAppStateHtml([
    {
      contentGuid: 'unattributed-1',
      properties: {
        Name: 'Laneway Food Pop-Up',
        Url: '/events/laneway-food/',
        Categories: [{ name: 'Food & drink' }],
        Location: 'Mystery Laneway Precinct',
        EventListing: { dateParts: [{ isoDateTime: '2026-11-26' }] }
      }
    },
    {
      contentGuid: 'attributed-1',
      properties: {
        Name: 'Riverside Yoga Session',
        Url: '/events/riverside-yoga/',
        Categories: [{ name: 'Health & wellness' }],
        Location: 'Elizabeth Quay, Perth',
        OrganizerName: 'Perth Wellness Collective',
        EventListing: { dateParts: [{ isoDateTime: '2026-11-27' }] },
        Latitude: -31.958,
        Longitude: 115.857
      }
    }
  ]);

  const requestedUrls = [];
  const crawler = createVisitPerthCrawler({
    now: TEST_NOW,
    pageDelayMs: 0,
    fetchFn: async (url) => {
      requestedUrls.push(url);
      return { ok: true, async text() { return html; } };
    }
  });

  let writtenItems = [];
  const mockAdapter = {
    async scanVenues() { return []; },
    async scanOrganizers() { return []; },
    async batchUpsertListings(items) {
      writtenItems = items;
      return { upserted: items.length };
    }
  };

  const summary = await runCrawlerHarness({
    crawlers: [crawler],
    adapter: mockAdapter,
    options: {
      skipUrlVerification: true,
      logger: { log() {}, error() {} }
    }
  });

  assert.equal(summary.successfulCrawlers, 1);
  assert.deepEqual(requestedUrls, ['https://www.visitperth.com/events/?page=1']);
  assert.equal(writtenItems.length, 2);

  const unattributed = writtenItems.find(i => i.id === 'visit_perth_unattributed-1');
  assert.ok(unattributed);
  assert.equal(unattributed.needs_review, true);
  assert.equal(unattributed.review_reason, 'unmatched_organizer');
  assert.equal(unattributed._canonicalEntities.organizer, null);
  assert.deepEqual(unattributed.venue.coordinates, VISIT_PERTH_LGA_CENTROID);

  const attributed = writtenItems.find(i => i.id === 'visit_perth_attributed-1');
  assert.ok(attributed);
  assert.equal(attributed.organizer.name, 'Perth Wellness Collective');
  assert.equal(attributed._canonicalEntities.organizer.name, 'Perth Wellness Collective');
});

test('getDefaultCrawlers excludes visit_perth by default and registers it under councils group when opted in', () => {
  const defaults = getDefaultCrawlers();
  assert.equal(defaults.find(c => c.name === 'visit_perth'), undefined);

  const optedIn = getDefaultCrawlers({ includeVisitPerth: true });
  const visitPerth = optedIn.find(c => c.name === 'visit_perth');
  assert.ok(visitPerth, 'visit_perth should be registered when includeVisitPerth is true');
  assert.equal(visitPerth.group, 'councils');
  assert.equal(VISIT_PERTH_CONFIG.pageDelayMs, 5000);
});
