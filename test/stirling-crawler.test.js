import test from 'node:test';
import assert from 'node:assert/strict';
import { createStirlingCrawler } from '../src/crawlers/stirling-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';

test('Seam 3: Stirling Crawler parses Kendo UI event response and formats listings conforming to canonical schema', async () => {
  const mockFetch = async () => ({
    ok: true,
    async json() {
      return {
        Data: [
          {
            NodeGUID: 'guid-123',
            ArticleTitle: 'Scarborough Community Beach Volleyball',
            ArticleCategories: 'Volleyball',
            ArticleAddressTitle: 'Scarborough Beach, WA',
            ArticleTeaser: 'Weekly community beach volleyball at Scarborough Beach amphitheatre.',
            Latitude: -31.8942,
            Longitude: 115.7571,
            Cost: 'Free',
            EventDisplayDate: '2026-11-20T17:00:00+08:00',
            PageUrl: '/events/beach-volleyball'
          }
        ]
      };
    }
  });

  const crawler = createStirlingCrawler({ fetchFn: mockFetch });
  const listings = await crawler.fetchListings();

  assert.equal(listings.length, 1);
  const raw = listings[0];
  assert.equal(raw.source, 'stirling');
  assert.equal(raw.source_id, 'guid-123');
  assert.equal(raw.title, 'Scarborough Community Beach Volleyball');
  assert.equal(raw.region_id, 'perth');
  assert.equal(raw.sport, 'Volleyball');
  assert.equal(raw.venue_name, 'Scarborough Beach, WA');
  assert.equal(raw.coordinates.lat, -31.8942);
  assert.equal(raw.coordinates.lng, 115.7571);
  assert.equal(raw.cost_description, 'Free');
  assert.equal(raw.source_url, 'https://www.stirling.wa.gov.au/events/beach-volleyball');
  assert.equal(raw.organizer.name, 'City of Stirling');

  // Verify that the emitted listing sanitizes cleanly into canonical ActivityDocument
  const sanitized = sanitizeActivity(raw);
  assert.equal(sanitized.id, 'stirling_guid-123');
  assert.equal(sanitized.region_id, 'perth');
  assert.equal(sanitized.category, 'sports');
  assert.equal(sanitized.subcategory, 'volleyball');
  assert.equal(sanitized.organizer.id, 'org_city_of_stirling');
  assert.equal(sanitized.organizer.name, 'City of Stirling');
  assert.ok(sanitized.venue.id.startsWith('venue_'));
  assert.equal(sanitized.venue.coordinates.lat, -31.8942);
  assert.equal(sanitized.venue.coordinates.lng, 115.7571);
  assert.equal(sanitized.schedule.start_date, '2026-11-20');
  assert.equal(sanitized.schedule.start_time, '17:00');
  assert.equal(sanitized.cost.is_free, true);
  assert.equal(sanitized.cost.display_price, 'Free');
});

test('Seam 3: Stirling Crawler throws descriptive error on HTTP failure', async () => {
  const mockFailingFetch = async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error'
  });

  const crawler = createStirlingCrawler({ fetchFn: mockFailingFetch });
  await assert.rejects(
    () => crawler.fetchListings(),
    /Stirling API responded with HTTP 500: Internal Server Error/
  );
});
