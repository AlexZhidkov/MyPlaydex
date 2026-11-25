import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFremantleCrawler,
  FREMANTLE_CONFIG,
  FREMANTLE_ENDPOINT,
  FREMANTLE_LGA_CENTROID
} from '../src/crawlers/fremantle-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';
import { applyVenueResolution, resolveActivityVenueAndCoordinates } from '../src/venue-resolver.js';
import { getDefaultCrawlers } from '../src/crawler-runner.js';

const TEST_NOW = new Date('2026-11-25T09:00:00+08:00');

function makeJsonFetch(payload) {
  return async () => ({
    ok: true,
    async json() {
      return payload;
    }
  });
}

test('Slice 1: Fremantle crawler posts AgencyWeb payload and parses data + htmlResult + sorted_events', async () => {
  const requests = [];
  const mockFetch = async (url, init) => {
    requests.push({ url, method: init.method, body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        return {
          total: 1,
          total_pages: 1,
          data: [
            {
              ID: 4012,
              post_title: 'Fremantle Twilight Lantern Walk',
              permalink: 'https://www.fremantle.wa.gov.au/whats-on/fremantle-twilight-lantern-walk',
              venue: 'Esplanade Reserve',
              address: 'Marine Terrace, Fremantle WA 6160',
              categories: ['Family', 'Arts & Culture'],
              cost: 'Free'
            }
          ],
          sorted_events: [
            {
              id: 4012,
              next_date: '2026-12-05 18:30:00'
            }
          ],
          htmlResult: `
            <article class="aw-event-card event-type-family" data-id="4012">
              <a class="aw-card-link" href="https://www.fremantle.wa.gov.au/whats-on/fremantle-twilight-lantern-walk">
                <h3 class="aw-card-title">Fremantle Twilight Lantern Walk</h3>
                <div class="aw-card-excerpt">Evening lantern walk along the foreshore.</div>
                <div class="aw-card-time">6:30pm - 8:30pm</div>
                <div class="aw-card-venue">Esplanade Reserve</div>
                <span class="aw-cost-badge">Free</span>
              </a>
            </article>
          `
        };
      }
    };
  };

  const crawler = createFremantleCrawler({
    fetchFn: mockFetch,
    pageDelayMs: 0,
    now: TEST_NOW
  });

  assert.equal(crawler.name, 'fremantle');
  assert.equal(crawler.group, 'councils');
  assert.equal(crawler.minExpectedListings, 1);
  assert.deepEqual(crawler.fallbackCentroid, FREMANTLE_LGA_CENTROID);
  assert.equal(FREMANTLE_CONFIG.endpoint, FREMANTLE_ENDPOINT);

  const listings = await crawler.fetchListings();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://www.fremantle.wa.gov.au/wp-json/aw/v1/event');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, {
    post_type: 'event',
    SI: '',
    OB: '',
    Q: '',
    PS: 50,
    FS: '',
    PG: 1,
    PR: '',
    IncludeFirst: true
  });

  assert.equal(listings.length, 1);
  const [item] = listings;
  assert.equal(item.source, 'fremantle');
  assert.equal(item.source_id, '4012');
  assert.equal(item.title, 'Fremantle Twilight Lantern Walk');
  assert.equal(item.source_url, 'https://www.fremantle.wa.gov.au/whats-on/fremantle-twilight-lantern-walk');
  assert.equal(item.external_url, 'https://www.fremantle.wa.gov.au/whats-on/fremantle-twilight-lantern-walk');
  assert.equal(item.venue_name, 'Esplanade Reserve');
  assert.equal(item.address, 'Marine Terrace, Fremantle WA 6160');
  assert.equal(item.organizer.id, 'org_city_of_fremantle');
  assert.equal(item.organizer.name, 'City of Fremantle');
  assert.equal(item.is_free, true);
  assert.equal(item.cost_description, 'Free');
  assert.match(item.start_time, /^2026-12-05/);
});

test('Slice 2: Adapter paginates PG/PS with injectable delay, deduplicates source_id across pages, and enforces 20-page / 200-Activity caps', async () => {
  const delays = [];
  const requestedPages = [];

  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requestedPages.push({ PG: body.PG, PS: body.PS, IncludeFirst: body.IncludeFirst });

    if (body.PG === 1) {
      return {
        ok: true,
        async json() {
          return {
            total: 3,
            total_pages: 2,
            data: [
              { ID: 101, post_title: 'Yoga at South Beach', permalink: 'https://www.fremantle.wa.gov.au/whats-on/yoga-south-beach', next_date: '2026-12-01' },
              { ID: 102, post_title: 'Freo Acoustic Session', permalink: 'https://www.fremantle.wa.gov.au/whats-on/freo-acoustic', next_date: '2026-12-02' }
            ]
          };
        }
      };
    }

    return {
      ok: true,
      async json() {
        return {
          total: 3,
          total_pages: 2,
          data: [
            // Duplicate ID 102 from page 1 should be deduplicated
            { ID: 102, post_title: 'Freo Acoustic Session', permalink: 'https://www.fremantle.wa.gov.au/whats-on/freo-acoustic', next_date: '2026-12-02' },
            { ID: 103, post_title: 'Port Beach Run Club', permalink: 'https://www.fremantle.wa.gov.au/whats-on/port-beach-run', next_date: '2026-12-03' }
          ]
        };
      }
    };
  };

  const crawler = createFremantleCrawler({
    fetchFn: mockFetch,
    delayFn: async (ms) => { delays.push(ms); },
    pageDelayMs: 750,
    pageSize: 2,
    now: TEST_NOW
  });

  const listings = await crawler.fetchListings();
  assert.deepEqual(requestedPages, [
    { PG: 1, PS: 2, IncludeFirst: true },
    { PG: 2, PS: 2, IncludeFirst: false }
  ]);
  assert.deepEqual(delays, [750]);
  assert.deepEqual(listings.map(l => l.source_id), ['101', '102', '103']);

  // Verify 20-page / 200-Activity safety caps
  let pageCalls = 0;
  const cappedFetch = async (_url, init) => {
    pageCalls += 1;
    const { PG } = JSON.parse(init.body);
    const data = Array.from({ length: 15 }, (_, idx) => ({
      ID: (PG - 1) * 15 + idx + 1,
      post_title: `Community Activity ${(PG - 1) * 15 + idx + 1}`,
      permalink: `https://www.fremantle.wa.gov.au/whats-on/activity-${(PG - 1) * 15 + idx + 1}`,
      next_date: '2026-12-10'
    }));
    return {
      ok: true,
      async json() {
        return { total: 500, total_pages: 30, data };
      }
    };
  };

  const cappedCrawler = createFremantleCrawler({
    fetchFn: cappedFetch,
    delayFn: async () => {},
    pageSize: 15,
    now: TEST_NOW
  });
  const cappedListings = await cappedCrawler.fetchListings();
  assert.equal(cappedListings.length, 200);
  assert.ok(pageCalls <= 20);
});

test('Slice 3: Venue aliasing ("Library" -> "Fremantle Library") and placeholder stripping ("Other" dropped) resolve cleanly through sanitizer', async () => {
  const crawler = createFremantleCrawler({
    fetchFn: makeJsonFetch({
      total: 2,
      total_pages: 1,
      data: [
        {
          ID: 201,
          post_title: 'Rhyme Time at the Library',
          permalink: 'https://www.fremantle.wa.gov.au/whats-on/rhyme-time',
          venue: 'Library',
          address: '151 High Street, Fremantle WA 6160',
          next_date: '2026-12-04'
        },
        {
          ID: 202,
          post_title: 'Hilton Park Neighbourhood Picnic',
          permalink: 'https://www.fremantle.wa.gov.au/whats-on/hilton-picnic',
          venue: 'Other',
          address: 'Carrington Street, Hilton WA 6163',
          next_date: '2026-12-06'
        }
      ]
    }),
    pageDelayMs: 0,
    now: TEST_NOW
  });
  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 2);

  const [libraryItem, otherItem] = listings;
  assert.equal(libraryItem.venue_name, 'Fremantle Library');
  assert.equal(libraryItem.venue.name, 'Fremantle Library');

  // "Other" should be stripped so venue_name/venue.name are omitted
  assert.equal(otherItem.venue_name, undefined);
  assert.equal(otherItem.venue.name, undefined);
  assert.equal(otherItem.address, 'Carrington Street, Hilton WA 6163');

  // End-to-end Venue resolution + sanitization
  const resolution = resolveActivityVenueAndCoordinates(otherItem, {
    fallbackCentroid: FREMANTLE_LGA_CENTROID
  });
  const sanitized = sanitizeActivity(
    applyVenueResolution(
      { ...otherItem, venue: { ...otherItem.venue, coordinates: resolution.coordinates } },
      resolution
    )
  );
  assert.equal(sanitized.id, 'fremantle_202');
  assert.notEqual(sanitized.venue.name, 'Other');
  assert.equal(typeof sanitized.venue.coordinates.lat, 'number');
  assert.equal(typeof sanitized.venue.coordinates.lng, 'number');
});

test('Slice 4: Cost badges map Free/Paid/See website and canonical fremantle.wa.gov.au URLs ignore third-party booking links', async () => {
  const mockFetch = async () => ({
    ok: true,
    async json() {
      return {
        total: 3,
        total_pages: 1,
        data: [
          {
            ID: 301,
            post_title: 'Free Community Tai Chi',
            permalink: 'https://events.humanitix.com/free-tai-chi',
            next_date: '2026-12-07',
            cost: 'Free'
          },
          {
            ID: 302,
            post_title: 'Pottery Wheel Workshop',
            permalink: 'https://www.fremantle.wa.gov.au/whats-on/pottery-wheel-workshop',
            next_date: '2026-12-08',
            cost: 'Paid'
          },
          {
            ID: 303,
            post_title: 'Fremantle Markets Brass Band',
            permalink: 'https://www.fremantle.wa.gov.au/whats-on/brass-band',
            next_date: '2026-12-09'
          }
        ],
        htmlResult: `
          <article class="aw-event-card" data-id="301">
            <a href="https://events.humanitix.com/free-tai-chi">Book Tickets</a>
            <a href="/whats-on/free-community-tai-chi">View Details</a>
            <h3 class="aw-card-title">Free Community Tai Chi</h3>
            <span class="aw-cost-badge">Free</span>
          </article>
          <article class="aw-event-card" data-id="302">
            <a href="https://www.trybooking.com/ABCDE">Book Now</a>
            <a href="https://www.fremantle.wa.gov.au/whats-on/pottery-wheel-workshop">Details</a>
            <h3 class="aw-card-title">Pottery Wheel Workshop</h3>
            <span class="aw-cost-badge">Paid</span>
          </article>
          <article class="aw-event-card" data-id="303">
            <a href="https://www.fremantle.wa.gov.au/whats-on/brass-band">Details</a>
            <h3 class="aw-card-title">Fremantle Markets Brass Band</h3>
          </article>
        `
      };
    }
  });

  const crawler = createFremantleCrawler({ fetchFn: mockFetch, pageDelayMs: 0, now: TEST_NOW });
  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 3);

  const [freeItem, paidItem, untaggedItem] = listings;
  assert.equal(freeItem.is_free, true);
  assert.equal(freeItem.cost_description, 'Free');
  assert.equal(freeItem.source_url, 'https://www.fremantle.wa.gov.au/whats-on/free-community-tai-chi');
  assert.equal(freeItem.external_url, 'https://www.fremantle.wa.gov.au/whats-on/free-community-tai-chi');

  assert.equal(paidItem.is_free, false);
  assert.equal(paidItem.cost_description, 'Paid');
  assert.equal(paidItem.source_url, 'https://www.fremantle.wa.gov.au/whats-on/pottery-wheel-workshop');
  assert.equal(paidItem.external_url, 'https://www.fremantle.wa.gov.au/whats-on/pottery-wheel-workshop');

  assert.equal(untaggedItem.is_free, false);
  assert.equal(untaggedItem.cost_description, 'See website');
  assert.equal(untaggedItem.source_url, 'https://www.fremantle.wa.gov.au/whats-on/brass-band');
  assert.equal(untaggedItem.external_url, 'https://www.fremantle.wa.gov.au/whats-on/brass-band');
});

test('Slice 5: Pre-filters civic/admin notices, online-only items, Expired Activity records, and items beyond 90-day horizon', async () => {
  const mockFetch = async () => ({
    ok: true,
    async json() {
      return {
        total: 5,
        total_pages: 1,
        data: [
          {
            ID: 401,
            post_title: 'Ordinary Council Meeting',
            permalink: 'https://www.fremantle.wa.gov.au/whats-on/ordinary-council-meeting',
            venue: 'Council Chambers'
          },
          {
            ID: 402,
            post_title: 'Sustainability Webinar (Online Only)',
            permalink: 'https://www.fremantle.wa.gov.au/whats-on/sustainability-webinar',
            venue: 'Zoom'
          },
          {
            ID: 403,
            post_title: 'Past Spring Picnic',
            permalink: 'https://www.fremantle.wa.gov.au/whats-on/past-spring-picnic',
            venue: 'Booyeembara Park'
          },
          {
            ID: 404,
            post_title: 'Future Winter Festival',
            permalink: 'https://www.fremantle.wa.gov.au/whats-on/future-winter-festival',
            venue: 'Esplanade Reserve'
          },
          {
            ID: 405,
            post_title: 'Upcoming Fremantle Beach Volleyball',
            permalink: 'https://www.fremantle.wa.gov.au/whats-on/beach-volleyball',
            venue: 'South Beach',
            categories: ['Sport']
          }
        ],
        sorted_events: [
          { id: 401, next_date: '2026-12-01' },
          { id: 402, next_date: '2026-12-02' },
          { id: 403, next_date: '2026-11-20' }, // Expired relative to TEST_NOW (2026-11-25)
          { id: 404, next_date: '2027-06-01' }, // Beyond 90-day horizon
          { id: 405, next_date: '2026-12-12' }  // Valid upcoming
        ]
      };
    }
  });

  const crawler = createFremantleCrawler({ fetchFn: mockFetch, pageDelayMs: 0, now: TEST_NOW });
  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 1);
  assert.equal(listings[0].source_id, '405');
  assert.equal(listings[0].title, 'Upcoming Fremantle Beach Volleyball');
  assert.equal(listings[0].category, 'sports');
});

test('Slice 6: getDefaultCrawlers registers fremantle under councils group', () => {
  const defaults = getDefaultCrawlers();
  const fremantle = defaults.find(c => c.name === 'fremantle');
  assert.ok(fremantle, 'fremantle should be registered in getDefaultCrawlers()');
  assert.equal(fremantle.group, 'councils');
  assert.equal(fremantle.minExpectedListings, 1);
  assert.deepEqual(fremantle.fallbackCentroid, FREMANTLE_LGA_CENTROID);
});
