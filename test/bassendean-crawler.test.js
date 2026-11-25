import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBassendeanCrawler,
  BASSENDEAN_CONFIG,
  BASSENDEAN_LGA_CENTROID
} from '../src/crawlers/bassendean-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';
import { applyVenueResolution, resolveActivityVenueAndCoordinates } from '../src/venue-resolver.js';
import { getDefaultCrawlers } from '../src/crawler-runner.js';

const TEST_NOW = new Date('2026-11-20T08:00:00+08:00');

const BASSENDEAN_FIXTURE_HTML = `<!DOCTYPE html><html><body>
  <form method="post" action="/events/" id="aspnetForm">
    <input type="hidden" name="__VIEWSTATE" value="BASS_VS_1" />
    <div class="list-event-item">
      <div id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewList_ctrl0_dvListEvent" class="list-event-wrapper">
        <a href="/events/bassendean-christmas-markets/1869" title="Bassendean Christmas Markets">
          <div id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewList_ctrl0_divItem" class="ab-offset">
            <article class="list-text">
              <h2 id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewList_ctrl0_eventTitle" class="h4">Bassendean Christmas Markets</h2>
              <p><span class="far fa-calendar-alt" aria-hidden="true"></span> <strong>SAT 28 NOV 2026 4:30 PM - 8:30 PM</strong></p>
              <hr class="hr-primary" />
              <p class="events-detail-location"><span class="default-label">Location:</span> BIC Reserve, Bassendean</p>
              <p class="events-detail-type"><span class="default-label">Type: </span>Markets</p>
              <p>Twilight community markets at BIC Reserve.</p>
            </article>
          </div>
        </a>
      </div>
    </div>
    <div class="list-event-item">
      <div id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewList_ctrl1_dvListEvent" class="list-event-wrapper">
        <a href="/events/ordinary-council-meeting/1870" title="Ordinary Council Meeting">
          <div id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewList_ctrl1_divItem" class="ab-offset">
            <article class="list-text">
              <h2 id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewList_ctrl1_eventTitle" class="h4">Ordinary Council Meeting</h2>
              <p><span class="far fa-calendar-alt" aria-hidden="true"></span> <strong>TUE 24 NOV 2026 7:00 PM</strong></p>
              <p class="events-detail-location"><span class="default-label">Location:</span> Council Chambers, Bassendean</p>
              <p class="events-detail-type"><span class="default-label">Type: </span>Council</p>
            </article>
          </div>
        </a>
      </div>
    </div>
  </form>
</body></html>`;

test('Bassendean crawler parses RadListViewList cards, filters civic noise, and resolves coords', async () => {
  const mockFetch = async () => ({
    ok: true,
    async text() {
      return BASSENDEAN_FIXTURE_HTML;
    }
  });

  const crawler = createBassendeanCrawler({ fetchFn: mockFetch, pageDelayMs: 0, detailDelayMs: 0, now: TEST_NOW });
  assert.equal(crawler.name, 'bassendean');
  assert.equal(crawler.group, 'councils');
  assert.deepEqual(crawler.fallbackCentroid, BASSENDEAN_LGA_CENTROID);

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 1);

  const [markets] = listings;
  assert.equal(markets.source, 'bassendean');
  assert.equal(markets.source_id, '1869');
  assert.equal(markets.title, 'Bassendean Christmas Markets');
  assert.equal(markets.venue_name, 'BIC Reserve, Bassendean');
  assert.equal(markets.organizer.name, 'Town of Bassendean');
  assert.equal(markets.source_url, 'https://www.bassendean.wa.gov.au/events/bassendean-christmas-markets/1869');

  const resolution = resolveActivityVenueAndCoordinates(markets, {
    fallbackCentroid: BASSENDEAN_LGA_CENTROID
  });
  const sanitized = sanitizeActivity(
    applyVenueResolution(
      { ...markets, venue: { ...markets.venue, coordinates: resolution.coordinates } },
      resolution
    )
  );
  assert.equal(sanitized.id, 'bassendean_1869');
  assert.equal(sanitized.schedule.start_date, '2026-11-28');
  assert.equal(sanitized.organizer.id, 'org_town_of_bassendean');
  assert.deepEqual(sanitized.venue.coordinates, BASSENDEAN_LGA_CENTROID);
});

test('getDefaultCrawlers registers bassendean under councils group', () => {
  const defaults = getDefaultCrawlers();
  const bassendean = defaults.find(c => c.name === 'bassendean');
  assert.ok(bassendean, 'bassendean should be registered in getDefaultCrawlers()');
  assert.equal(bassendean.group, 'councils');
  assert.deepEqual(bassendean.fallbackCentroid, BASSENDEAN_LGA_CENTROID);
  assert.equal(BASSENDEAN_CONFIG.minExpectedListings, 1);
});
