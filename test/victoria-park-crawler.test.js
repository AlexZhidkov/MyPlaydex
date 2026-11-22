import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVictoriaParkCrawler,
  VICTORIA_PARK_CONFIG,
  VICTORIA_PARK_LGA_CENTROID
} from '../src/crawlers/victoria-park-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';
import { applyVenueResolution, resolveActivityVenueAndCoordinates } from '../src/venue-resolver.js';
import { getDefaultCrawlers } from '../src/crawler-runner.js';

const TEST_NOW = new Date('2026-11-20T08:00:00+08:00');

const VICTORIA_PARK_FIXTURE_HTML = `<!DOCTYPE html><html><body>
  <form method="post" action="/events/" id="aspnetForm">
    <input type="hidden" name="__VIEWSTATE" value="VP_VS_1" />
    <a href="/events/purple-road-community-artwork-display/101">
      <div id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewList_ctrl0_divItem" class="ab-offset">
        <article class="list-text">
          <h2 id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewList_ctrl0_eventTitle" class="h4">Purple Road Community Artwork Display</h2>
          <p><span class="far fa-calendar-alt" aria-hidden="true"></span> <strong>SUN 01 NOV 2026 - MON 30 NOV 2026 12:00 AM</strong></p>
          <hr class="hr-primary" />
          <p class="events-detail-location"><span class="default-label">Location:</span> Town of Victoria Park Library</p>
          <p class="events-detail-type"><span class="default-label">Type: </span>Arts</p>
          <p class="events-detail-audience"><span class="default-label">Audience: </span>All Ages</p>
          <p>Visit the Vic Park Library this November and discover the Purple Road.</p>
        </article>
      </div>
    </a>
    <a href="/events/ordinary-council-meeting/102">
      <div id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewList_ctrl1_divItem" class="ab-offset">
        <article class="list-text">
          <h2 id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewList_ctrl1_eventTitle" class="h4">Ordinary Council Meeting</h2>
          <p><span class="far fa-calendar-alt" aria-hidden="true"></span> <strong>TUE 24 NOV 2026 6:30 PM</strong></p>
          <p class="events-detail-location"><span class="default-label">Location:</span> Council Chambers, Victoria Park</p>
          <p class="events-detail-type"><span class="default-label">Type: </span>Council</p>
        </article>
      </div>
    </a>
  </form>
</body></html>`;

test('Victoria Park crawler parses RadListView list-text cards, maps Type tags, filters civic noise, and resolves coords', async () => {
  const mockFetch = async () => ({
    ok: true,
    async text() {
      return VICTORIA_PARK_FIXTURE_HTML;
    }
  });

  const crawler = createVictoriaParkCrawler({ fetchFn: mockFetch, pageDelayMs: 0, detailDelayMs: 0, now: TEST_NOW });
  assert.equal(crawler.name, 'victoria_park');
  assert.equal(crawler.group, 'councils');
  assert.deepEqual(crawler.fallbackCentroid, VICTORIA_PARK_LGA_CENTROID);

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 1);

  const [artwork] = listings;
  assert.equal(artwork.source, 'victoria_park');
  assert.equal(artwork.source_id, '101');
  assert.equal(artwork.title, 'Purple Road Community Artwork Display');
  assert.equal(artwork.category, 'arts');
  assert.equal(artwork.venue_name, 'Town of Victoria Park Library');
  assert.equal(artwork.organizer.name, 'Town of Victoria Park');

  const resolution = resolveActivityVenueAndCoordinates(artwork, {
    fallbackCentroid: VICTORIA_PARK_LGA_CENTROID
  });
  const sanitized = sanitizeActivity(
    applyVenueResolution(
      { ...artwork, venue: { ...artwork.venue, coordinates: resolution.coordinates } },
      resolution
    )
  );
  assert.equal(sanitized.id, 'victoria_park_101');
  assert.equal(sanitized.organizer.id, 'org_town_of_victoria_park');
});

test('getDefaultCrawlers registers victoria_park under councils group', () => {
  const defaults = getDefaultCrawlers();
  const vp = defaults.find(c => c.name === 'victoria_park');
  assert.ok(vp, 'victoria_park should be registered in getDefaultCrawlers()');
  assert.equal(vp.group, 'councils');
  assert.deepEqual(vp.fallbackCentroid, VICTORIA_PARK_LGA_CENTROID);
  assert.equal(VICTORIA_PARK_CONFIG.minExpectedListings, 1);
});
