import test from 'node:test';
import assert from 'node:assert/strict';
import { createStirlingCrawler } from '../src/crawlers/stirling-crawler.js';

test('Stirling Crawler: parses Kendo UI event response and formats listings', async () => {
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
  assert.equal(listings[0].source, 'stirling');
  assert.equal(listings[0].source_id, 'guid-123');
  assert.equal(listings[0].title, 'Scarborough Community Beach Volleyball');
  assert.equal(listings[0].sport, 'Volleyball');
  assert.equal(listings[0].venue_name, 'Scarborough Beach, WA');
  assert.equal(listings[0].coordinates.lat, -31.8942);
  assert.equal(listings[0].coordinates.lng, 115.7571);
  assert.equal(listings[0].cost_description, 'Free');
  assert.equal(listings[0].external_url, 'https://www.stirling.wa.gov.au/events/beach-volleyball');
});

test('Stirling Crawler: throws descriptive error on HTTP failure', async () => {
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
