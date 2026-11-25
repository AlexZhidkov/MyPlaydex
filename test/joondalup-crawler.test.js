import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createJoondalupCrawler,
  JOONDALUP_BASE_URL,
  JOONDALUP_CONFIG,
  JOONDALUP_ENDPOINT,
  JOONDALUP_LGA_CENTROID
} from '../src/crawlers/joondalup-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';
import { applyVenueResolution, resolveActivityVenueAndCoordinates } from '../src/venue-resolver.js';
import { getDefaultCrawlers } from '../src/crawler-runner.js';

const TEST_NOW = new Date('2026-11-25T09:00:00+08:00');

test('Slice 5: City of Joondalup crawler attributes Organizer, recovers titles, resolves Venues/centroids, and registers in defaults', async () => {
  const requests = [];
  const mockFetch = async (url, init) => {
    requests.push({ url, method: init.method, body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        return {
          htmlResult: `
            <div class="hotboxes-wrapper">
              <article class="card">
                <a href="/whats-on/events-calendar/mobile-youth-truck-shepherds-bush" class="hotbox"
                   aria-label="Event Title: Mobile Youth Truck – Shepherds Bush Pump &amp; Jump Track Kingsley. Category: Youth. Event Date: Every Friday (except public holidays). Event Venue: Shepherd's Bush. Read more.">
                  <div class="card-body">
                    <div class="tags"><span>Youth</span></div>
                    <h4 class="card-title">Mobile Youth Truck – Shepherds Bush Pump &amp; Jump...</h4>
                    <ul class="fa-ul">
                      <li><span class="fa-li"><i class="fa-regular fa-calendar"></i></span>Every Friday (except public holidays)</li>
                      <li><span class="fa-li"><i class="fa-regular fa-location-smile"></i></span>Shepherd's Bush</li>
                    </ul>
                  </div>
                </a>
              </article>
              <article class="card">
                <a href="/whats-on/events-calendar/minecraft-engineers-woodvale" class="hotbox"
                   aria-label="Event Title: Minecraft Engineers - Woodvale. Category: Library, Technology. Event Date: Tuesday, 4-5pm. Event Venue: Woodvale Library. Read more.">
                  <div class="card-body">
                    <div class="tags"><span>Library</span> <span>Technology</span></div>
                    <h4 class="card-title">Minecraft Engineers - Woodvale</h4>
                    <ul class="fa-ul">
                      <li><span class="fa-li"><i class="fa-regular fa-calendar"></i></span>Tuesday, 4-5pm</li>
                      <li><span class="fa-li"><i class="fa-regular fa-location-smile"></i></span>Woodvale Library</li>
                    </ul>
                  </div>
                </a>
              </article>
            </div>
            <input id="recordCountValue" value="2" type="hidden"/>
            <input id="hasnextpage" value="false" type="hidden"/>
          `
        };
      }
    };
  };

  const crawler = createJoondalupCrawler({
    fetchFn: mockFetch,
    pageDelayMs: 0,
    now: TEST_NOW
  });

  assert.equal(crawler.name, 'joondalup');
  assert.equal(crawler.group, 'councils');
  assert.equal(crawler.minExpectedListings, 1);
  assert.deepEqual(crawler.fallbackCentroid, JOONDALUP_LGA_CENTROID);
  assert.equal(JOONDALUP_CONFIG.endpoint, JOONDALUP_ENDPOINT);
  assert.equal(JOONDALUP_CONFIG.baseUrl, JOONDALUP_BASE_URL);

  const listings = await crawler.fetchListings();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://www.joondalup.wa.gov.au/search/htmlresult');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].body.SI, 'Events');
  assert.ok(Array.isArray(requests[0].body.PR));
  assert.ok(requests[0].body.PR.some(p => p.key === 'classname' && p.values?.[0]?.value === 'AWPT.Event'));

  assert.equal(listings.length, 2);

  const [truck, minecraft] = listings;
  assert.equal(truck.source, 'joondalup');
  assert.equal(truck.title, 'Mobile Youth Truck – Shepherds Bush Pump & Jump Track Kingsley');
  assert.equal(truck.organizer.id, 'org_city_of_joondalup');
  assert.equal(truck.organizer.name, 'City of Joondalup');
  assert.equal(truck.cost_description, '');
  assert.equal(truck.display_price, '');
  assert.equal(truck.is_free, false);

  // Venue fallback & sanitization
  const resolution = resolveActivityVenueAndCoordinates(minecraft, {
    fallbackCentroid: JOONDALUP_LGA_CENTROID
  });
  const sanitized = sanitizeActivity(
    applyVenueResolution(
      { ...minecraft, venue: { ...minecraft.venue, coordinates: resolution.coordinates } },
      resolution
    ),
    TEST_NOW.toISOString()
  );
  assert.equal(sanitized.id, 'joondalup_whats_on_events_calendar_minecraft_engineers_woodvale');
  assert.equal(sanitized.schedule.recurrence, 'weekly');
  assert.equal(sanitized.schedule.day_of_week, 2);
  assert.equal(sanitized.schedule.start_time, '16:00');
  assert.equal(sanitized.schedule.end_time, '17:00');
  assert.deepEqual(sanitized.cost, { is_free: false, display_price: '' });
  assert.equal(typeof sanitized.venue.coordinates.lat, 'number');
  assert.equal(typeof sanitized.venue.coordinates.lng, 'number');

  // Default harness registration
  const defaults = getDefaultCrawlers();
  const joondalup = defaults.find(c => c.name === 'joondalup');
  assert.ok(joondalup, 'joondalup should be registered in getDefaultCrawlers()');
  assert.equal(joondalup.group, 'councils');
  assert.equal(joondalup.minExpectedListings, 1);
  assert.deepEqual(joondalup.fallbackCentroid, JOONDALUP_LGA_CENTROID);
});
