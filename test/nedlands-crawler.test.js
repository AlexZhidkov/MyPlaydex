import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNedlandsCrawler,
  NEDLANDS_CONFIG,
  NEDLANDS_ENDPOINT,
  NEDLANDS_LGA_CENTROID
} from '../src/crawlers/nedlands-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';
import { applyVenueResolution, resolveActivityVenueAndCoordinates } from '../src/venue-resolver.js';
import { getDefaultCrawlers } from '../src/crawler-runner.js';

const TEST_NOW = new Date('2026-11-20T08:00:00+08:00');

const NEDLANDS_LISTING_HTML = `<!DOCTYPE html><html><body>
  <form method="post" action="/events/" id="aspnetForm">
    <input type="hidden" name="__VIEWSTATE" value="NED_VS_1" />
    <a href="/events/nedlands-community-tennis/863" style="overflow: hidden; position: relative;">
      <article id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewGrid_ctrl0_eventArticle">
        <strong class="date text-uppercase">WED 25 NOV 2026 1:00 PM - 3:00 PM</strong>
        <span class="title h4">Nedlands Community Tennis</span>
        <div class="event-content">
          Join our social community tennis afternoon at Nedlands Tennis Club.
          <p>Read More &nbsp;<span class="spark-icon far fa-angle-right"></span></p>
        </div>
      </article>
    </a>
    <a href="/events/ordinary-council-meeting/864">
      <article id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewGrid_ctrl1_eventArticle">
        <strong class="date text-uppercase">TUE 24 NOV 2026 7:00 PM</strong>
        <span class="title h4">Ordinary Council Meeting</span>
        <div class="event-content">Monthly council meeting.</div>
      </article>
    </a>
  </form>
</body></html>`;

const NEDLANDS_DETAIL_HTML = `<!DOCTYPE html><html><body>
  <div class="event-content">
    <h1>Nedlands Community Tennis</h1>
    <p class="events-detail-location"><span class="default-label">Location:</span> Nedlands Tennis Club, Bruce Street, Nedlands</p>
    <p class="events-detail-type"><span class="default-label">Type: </span>Sport</p>
    <p class="event-description">Social community tennis afternoon open to all skill levels.</p>
  </div>
</body></html>`;

test('Nedlands crawler parses RadListViewGrid cards, hydrates detail location, filters civic noise, and resolves coords', async () => {
  const fetchedUrls = [];
  const mockFetch = async (url) => {
    fetchedUrls.push(url);
    return {
      ok: true,
      async text() {
        if (url === NEDLANDS_ENDPOINT) {
          return NEDLANDS_LISTING_HTML;
        }
        return NEDLANDS_DETAIL_HTML;
      }
    };
  };

  const crawler = createNedlandsCrawler({ fetchFn: mockFetch, pageDelayMs: 0, detailDelayMs: 0, now: TEST_NOW });
  assert.equal(crawler.name, 'nedlands');
  assert.equal(crawler.group, 'councils');
  assert.deepEqual(crawler.fallbackCentroid, NEDLANDS_LGA_CENTROID);

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 1);
  assert.ok(
    fetchedUrls.includes('https://www.nedlands.wa.gov.au/events/nedlands-community-tennis/863'),
    'should hydrate detail page when listing card omits location'
  );

  const [tennis] = listings;
  assert.equal(tennis.source, 'nedlands');
  assert.equal(tennis.source_id, '863');
  assert.equal(tennis.title, 'Nedlands Community Tennis');
  assert.equal(tennis.category, 'sports');
  assert.equal(tennis.subcategory, 'other');
  assert.equal(tennis.venue_name, 'Nedlands Tennis Club, Bruce Street, Nedlands');
  assert.equal(tennis.organizer.name, 'City of Nedlands');

  const resolution = resolveActivityVenueAndCoordinates(tennis, {
    fallbackCentroid: NEDLANDS_LGA_CENTROID
  });
  const sanitized = sanitizeActivity(
    applyVenueResolution(
      { ...tennis, venue: { ...tennis.venue, coordinates: resolution.coordinates } },
      resolution
    )
  );
  assert.equal(sanitized.id, 'nedlands_863');
  assert.equal(sanitized.schedule.start_date, '2026-11-25');
  assert.equal(sanitized.organizer.id, 'org_city_of_nedlands');
  assert.deepEqual(sanitized.venue.coordinates, NEDLANDS_LGA_CENTROID);
});

test('getDefaultCrawlers registers nedlands under councils group', () => {
  const defaults = getDefaultCrawlers();
  const nedlands = defaults.find(c => c.name === 'nedlands');
  assert.ok(nedlands, 'nedlands should be registered in getDefaultCrawlers()');
  assert.equal(nedlands.group, 'councils');
  assert.deepEqual(nedlands.fallbackCentroid, NEDLANDS_LGA_CENTROID);
  assert.equal(NEDLANDS_CONFIG.minExpectedListings, 1);
});
