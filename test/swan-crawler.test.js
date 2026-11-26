import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSwanCrawler,
  SWAN_BASE_URL,
  SWAN_CONFIG,
  SWAN_ENDPOINT,
  SWAN_LGA_CENTROID
} from '../src/crawlers/swan-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';
import { applyVenueResolution, resolveActivityVenueAndCoordinates } from '../src/venue-resolver.js';

const TEST_NOW = new Date('2026-11-25T09:00:00+08:00');

test('City of Swan crawler parses Swan card variations, attributes Organizer, and resolves Multiple locations via LGA centroid', async () => {
  const requests = [];
  const mockFetch = async (url, init) => {
    requests.push({ url, method: init.method, body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        return {
          htmlResult: `
            <div class="hotboxes-wrapper">
              <article class="card" data-docid="99123">
                <a href="/explore-and-do/events/monday-youth-hangout" class="hotbox">
                  <div class="card-body">
                    <div class="tags"><span>Youth</span></div>
                    <h4 class="card-title">Youth Hangout</h4>
                    <p class="card-text">Drop in for table tennis and board games.</p>
                    <span class="feature">Free</span>
                    <ul class="fa-ul">
                      <li><span class="fa-li"><i class="fa-regular fa-calendar"></i></span>Monday, weekly. 3 - 5pm</li>
                      <li><span class="fa-li"><i class="fa-regular fa-location-smile"></i></span>Multiple locations</li>
                    </ul>
                  </div>
                </a>
              </article>
              <article class="card" data-docid="99456">
                <a href="/explore-and-do/events/summer-swim-clinic" class="hotbox">
                  <div class="card-body">
                    <div class="tags"><span>Sport</span></div>
                    <h4 class="card-title">Summer Swim Clinic</h4>
                    <p class="card-text">Stroke correction clinic for juniors.</p>
                    <ul class="fa-ul">
                      <li><span class="fa-li"><i class="fa-regular fa-calendar"></i></span>Saturday, 12 Dec 2026</li>
                      <li><span class="fa-li"><i class="fa-regular fa-location-smile"></i></span>Swan Active Midland</li>
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

  const crawler = createSwanCrawler({
    fetchFn: mockFetch,
    pageDelayMs: 0,
    now: TEST_NOW
  });

  assert.equal(crawler.name, 'swan');
  assert.equal(crawler.group, 'councils');
  assert.equal(crawler.minExpectedListings, 1);
  assert.deepEqual(crawler.fallbackCentroid, SWAN_LGA_CENTROID);
  assert.equal(SWAN_CONFIG.endpoint, SWAN_ENDPOINT);
  assert.equal(SWAN_CONFIG.baseUrl, SWAN_BASE_URL);

  const listings = await crawler.fetchListings();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://www.swan.wa.gov.au/v1/aapi/search/htmlresult');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].body.SI, 'Events');
  assert.equal(requests[0].body.OB, 'PossibleStart ASC');
  assert.ok(Array.isArray(requests[0].body.PR));

  const prByKey = Object.fromEntries(requests[0].body.PR.map(p => [p.key, p.values?.[0]?.value]));
  assert.deepEqual(prByKey, {
    transformationname: 'AWPT.Event.SmartSearchItem',
    headertransformationname: 'AWPT.Event.SmartSearchHeader',
    footertransformationname: 'AWPT.Event.SmartSearchFooter',
    classname: 'AWPT.Event',
    FilterIsExpired: 'False',
    searchindexes: 'Events',
    nodealiaspath: '/explore-and-do'
  });
  assert.equal('widgetclassname' in prByKey, false);
  assert.equal('widgettemplatename' in prByKey, false);
  assert.equal('EventPossibleStart' in prByKey, false);

  assert.equal(listings.length, 2);

  const [hangout, clinic] = listings;
  assert.equal(hangout.source, 'swan');
  assert.equal(hangout.source_id, '99123');
  assert.equal(hangout.title, 'Youth Hangout');
  assert.equal(hangout.description, 'Drop in for table tennis and board games.');
  assert.equal(hangout.organizer.id, 'org_city_of_swan');
  assert.equal(hangout.organizer.name, 'City of Swan');
  assert.equal(hangout.is_free, true);
  assert.equal(hangout.display_price, 'Free');
  assert.equal(hangout.cost_description, 'Free');

  // "Multiple locations" resolves via SWAN_LGA_CENTROID and flags Unreviewed Listing
  const resolution = resolveActivityVenueAndCoordinates(hangout, {
    fallbackCentroid: SWAN_LGA_CENTROID
  });
  assert.equal(resolution.outOfArea, false);
  assert.deepEqual(resolution.coordinates, SWAN_LGA_CENTROID);
  assert.equal(resolution.fallbackReviewReason, 'unmatched_venue');

  const sanitizedHangout = applyVenueResolution(
    sanitizeActivity(
      { ...hangout, venue: { ...hangout.venue, coordinates: resolution.coordinates } },
      TEST_NOW.toISOString()
    ),
    resolution
  );
  assert.equal(sanitizedHangout.id, 'swan_99123');
  assert.equal(sanitizedHangout.needs_review, true);
  assert.equal(sanitizedHangout.review_reason, 'unmatched_venue');
  assert.equal(sanitizedHangout.venue.id, null);
  assert.equal(sanitizedHangout.schedule.recurrence, 'weekly');
  assert.equal(sanitizedHangout.schedule.day_of_week, 1);
  assert.equal(sanitizedHangout.schedule.start_time, '15:00');
  assert.equal(sanitizedHangout.schedule.end_time, '17:00');
  assert.equal(sanitizedHangout.schedule.end_date, null);
  assert.deepEqual(sanitizedHangout.cost, { is_free: true, display_price: 'Free' });

  // Absent cost badge leaves cost empty
  assert.equal(clinic.source_id, '99456');
  assert.equal(clinic.is_free, false);
  assert.equal(clinic.display_price, '');
  assert.equal(clinic.cost_description, '');
});
