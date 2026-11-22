import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWannerooCrawler,
  WANNEROO_CONFIG,
  WANNEROO_LGA_CENTROID
} from '../src/crawlers/wanneroo-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';
import { applyVenueResolution, resolveActivityVenueAndCoordinates } from '../src/venue-resolver.js';
import { getDefaultCrawlers } from '../src/crawler-runner.js';

const TEST_NOW = new Date('2026-11-20T08:00:00+08:00');

const WANNEROO_FIXTURE_PAGE_1 = {
  Total: 4,
  Data: [
    {
      ArticleReleaseDate: '2026-11-22T00:00:00',
      ArticleReleaseDateString: 'Sunday, 6am to 11am',
      ArticleTeaser: '/getContentAsset/c2fbd43a-933e-4de2-9964-4de6c09a9144/Wanneroo-swap-meet.webp?language=en',
      Categories: ['Community-led'],
      Venues: ['Wanneroo Showgrounds'],
      index: 0,
      ArticleTitle: 'Wanneroo swap meet',
      ArticleSummary: 'A popular weekly market held every Sunday.',
      PageUrl: '/things-to-do/event-calendar/wanneroo-swap-meet'
    },
    {
      ArticleReleaseDate: '2026-11-28T09:00:00',
      ArticleReleaseDateString: 'Saturday, 9am to 12pm',
      ArticleTeaser: '/getContentAsset/abc/tennis-open-day.webp?language=en',
      Categories: ['Sports & Recreation'],
      Venues: ['Kingsway Regional Sporting Complex'],
      index: 1,
      ArticleTitle: 'Kingsway Community Tennis Open Day',
      ArticleSummary: 'Free social tennis sessions for all ages.',
      PageUrl: '/things-to-do/event-calendar/kingsway-community-tennis-open-day'
    },
    {
      ArticleReleaseDate: '2026-11-25T18:00:00',
      ArticleReleaseDateString: 'Wednesday, 6pm',
      ArticleTeaser: '/getContentAsset/def/council-meeting.webp?language=en',
      Categories: ['Council'],
      Venues: ['Wanneroo Civic Centre'],
      index: 2,
      ArticleTitle: 'Ordinary Council Meeting',
      ArticleSummary: 'Monthly council meeting.',
      PageUrl: '/things-to-do/event-calendar/ordinary-council-meeting'
    },
    {
      ArticleReleaseDate: '2026-11-26T10:00:00',
      ArticleReleaseDateString: 'Thursday, 10am',
      ArticleTeaser: '/getContentAsset/ghi/webinar.webp?language=en',
      Categories: ['Community'],
      Venues: ['Online'],
      index: 3,
      ArticleTitle: 'Small Business Sustainability Webinar',
      ArticleSummary: 'Online workshop.',
      PageUrl: '/things-to-do/event-calendar/small-business-webinar'
    }
  ]
};

test('Wanneroo crawler parses Kentico/Kendo payload, maps categories and venues, and filters civic/online noise', async () => {
  const mockFetch = async () => ({
    ok: true,
    async json() {
      return WANNEROO_FIXTURE_PAGE_1;
    }
  });

  const crawler = createWannerooCrawler({ fetchFn: mockFetch, pageDelayMs: 0, now: TEST_NOW });
  assert.equal(crawler.name, 'wanneroo');
  assert.equal(crawler.group, 'councils');
  assert.deepEqual(crawler.fallbackCentroid, WANNEROO_LGA_CENTROID);

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 2);

  const [market, tennis] = listings;
  assert.equal(market.source, 'wanneroo');
  assert.equal(market.source_id, 'wanneroo_swap_meet');
  assert.equal(market.title, 'Wanneroo swap meet');
  assert.equal(market.description, 'A popular weekly market held every Sunday.');
  assert.equal(market.venue_name, 'Wanneroo Showgrounds');
  assert.equal(market.source_url, 'https://www.wanneroo.wa.gov.au/things-to-do/event-calendar/wanneroo-swap-meet');
  assert.equal(market.organizer.name, 'City of Wanneroo');

  const resolution = resolveActivityVenueAndCoordinates(market, {
    fallbackCentroid: WANNEROO_LGA_CENTROID
  });
  const resolvedMarket = applyVenueResolution(
    { ...market, venue: { ...market.venue, coordinates: resolution.coordinates } },
    resolution
  );
  const sanitizedMarket = sanitizeActivity(resolvedMarket);
  assert.equal(sanitizedMarket.id, 'wanneroo_wanneroo_swap_meet');
  assert.equal(sanitizedMarket.schedule.start_date, '2026-11-22');
  assert.equal(sanitizedMarket.organizer.id, 'org_city_of_wanneroo');
  assert.deepEqual(sanitizedMarket.venue.coordinates, WANNEROO_LGA_CENTROID);

  assert.equal(tennis.category, 'sports');
  assert.equal(tennis.subcategory, 'other');
  assert.equal(tennis.venue_name, 'Kingsway Regional Sporting Complex');
});

test('getDefaultCrawlers registers wanneroo under councils group', () => {
  const defaults = getDefaultCrawlers();
  const wanneroo = defaults.find(c => c.name === 'wanneroo');
  assert.ok(wanneroo, 'wanneroo should be registered in getDefaultCrawlers()');
  assert.equal(wanneroo.group, 'councils');
  assert.deepEqual(wanneroo.fallbackCentroid, WANNEROO_LGA_CENTROID);
  assert.equal(WANNEROO_CONFIG.minExpectedListings, 1);
});
