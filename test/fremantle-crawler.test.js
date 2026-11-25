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
    hydrateDetail: 'never',
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
    SI: 'event',
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
    hydrateDetail: 'never',
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
    hydrateDetail: 'never',
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
    hydrateDetail: 'never',
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

  const crawler = createFremantleCrawler({ fetchFn: mockFetch, pageDelayMs: 0, hydrateDetail: 'never', now: TEST_NOW });
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

  const crawler = createFremantleCrawler({ fetchFn: mockFetch, pageDelayMs: 0, hydrateDetail: 'never', now: TEST_NOW });
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

test('Slice 7: Adapter hydrates detail pages only after pre-filtering, respects hydrateDetail modes and detailDelayMs, and falls back on fetch failure', async () => {
  const requestedUrls = [];
  const delays = [];

  const listingPayload = {
    data: [
      {
        id: 501,
        title: 'Ordinary Council Meeting',
        permalink: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/ordinary-council-meeting/'
      },
      {
        id: 502,
        title: 'Online Sustainability Webinar',
        permalink: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/online-webinar/'
      },
      {
        id: 503,
        title: 'Far Future Festival',
        permalink: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/far-future-festival/'
      },
      {
        id: 504,
        title: 'South Beach Sunset Yoga',
        permalink: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/south-beach-sunset-yoga/'
      },
      {
        id: 505,
        title: 'Freo Acoustic Night',
        permalink: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/freo-acoustic-night/'
      }
    ],
    sorted_events: [
      { post: { ID: 501 }, next_date: '2026-12-01' },
      { post: { ID: 502 }, next_date: '2026-12-02' },
      { post: { ID: 503 }, next_date: '2027-06-01' },
      { post: { ID: 504 }, next_date: '2026-12-05' },
      { post: { ID: 505 }, next_date: '2026-12-06' }
    ],
    htmlResult: `
      <article class="card" data-post-id="501"><h4 class="card-title">Ordinary Council Meeting</h4></article>
      <article class="card" data-post-id="502"><h4 class="card-title">Online Sustainability Webinar</h4><ul class="fa-ul"><li><span class="fa-li"><i class="fa-regular fa-location-smile"></i></span>Zoom</li></ul></article>
      <article class="card" data-post-id="503"><h4 class="card-title">Far Future Festival</h4></article>
      <article class="card" data-post-id="504">
        <div class="tags"><span>Free</span></div>
        <h4 class="card-title">South Beach Sunset Yoga</h4>
        <ul class="fa-ul">
          <li><span class="fa-li"><i class="fa-regular fa-calendar-week"></i></span>5 Dec 2026</li>
          <li><span class="fa-li"><i class="fa-regular fa-location-smile"></i></span>South Beach</li>
        </ul>
      </article>
      <article class="card" data-post-id="505">
        <div class="tags"><span>Paid</span></div>
        <h4 class="card-title">Freo Acoustic Night</h4>
        <ul class="fa-ul">
          <li><span class="fa-li"><i class="fa-regular fa-calendar-week"></i></span>6 Dec 2026</li>
          <li><span class="fa-li"><i class="fa-regular fa-location-smile"></i></span>Fremantle Arts Centre</li>
        </ul>
      </article>
    `
  };

  const mockFetch = async (url, init = {}) => {
    requestedUrls.push({ method: init.method || 'GET', url });
    if (url === FREMANTLE_ENDPOINT) {
      return { ok: true, async json() { return listingPayload; } };
    }
    if (url.includes('south-beach-sunset-yoga')) {
      return {
        ok: true,
        async text() {
          return `
            <div class="post-504 event-type-health-and-wellbeing">
              <div class="eventdetail-icontext-wrapper">
                <div class="eventdetail-icontext"><div class="text"><div class="text-label">Date / Frequency</div><div>5 Dec 2026</div></div></div>
                <div class="eventdetail-icontext"><div class="text"><div class="text-label">Time</div><div>6:00 pm - 7:00 pm</div></div></div>
                <div class="eventdetail-icontext"><div class="text"><div class="text-label">Location</div><div>South Beach, Ocean Dr, South Fremantle WA 6162</div></div></div>
              </div>
              <div id="addToCalendarModal">
                <a class="icon-google" href="https://www.google.com/calendar/render?action=TEMPLATE&dates=20261205T180000/20261205T190000&location=South%20Beach%2C%20Ocean%20Dr%2C%20South%20Fremantle%20WA%206162">Google Calendar</a>
              </div>
            </div>
          `;
        }
      };
    }
    // Simulate HTTP 500 failure for 505
    return { ok: false, status: 500, statusText: 'Server Error' };
  };

  const crawler = createFremantleCrawler({
    fetchFn: mockFetch,
    delayFn: async (ms) => { delays.push(ms); },
    pageDelayMs: 0,
    detailDelayMs: 250,
    hydrateDetail: 'always',
    now: TEST_NOW
  });

  const listings = await crawler.fetchListings();

  // Only 504 and 505 survived pre-filtering; 501 (civic), 502 (online), 503 (horizon) were NOT hydrated
  assert.deepEqual(requestedUrls, [
    { method: 'POST', url: FREMANTLE_ENDPOINT },
    { method: 'GET', url: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/south-beach-sunset-yoga/' },
    { method: 'GET', url: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/freo-acoustic-night/' }
  ]);
  assert.deepEqual(delays, [250, 250]);
  assert.equal(listings.length, 2);

  const [yoga, acoustic] = listings;
  assert.equal(yoga.category, 'health');
  assert.equal(yoga.address, 'Ocean Dr, South Fremantle WA 6162');
  assert.equal(yoga.venue_name, 'South Beach');
  assert.equal(yoga.start_time, '2026-12-05T18:00:00+08:00');
  assert.equal(yoga.end_time, '2026-12-05T19:00:00+08:00');
  assert.equal(yoga.is_free, true);

  // 505 gracefully fell back to listing-card data
  assert.equal(acoustic.source_id, '505');
  assert.equal(acoustic.venue_name, 'Fremantle Arts Centre');
  assert.equal(acoustic.is_free, false);
  assert.equal(acoustic.cost_description, 'Paid');

  // hydrateDetail: 'never' skips all detail fetches
  requestedUrls.length = 0;
  const neverCrawler = createFremantleCrawler({
    fetchFn: mockFetch,
    pageDelayMs: 0,
    detailDelayMs: 250,
    hydrateDetail: 'never',
    now: TEST_NOW
  });
  await neverCrawler.fetchListings();
  assert.equal(requestedUrls.length, 1);
});

test('Slice 8: Schedule resolution handles single-day, compact multi-day, in-progress recurring series, open-ended weekly, and umbrella festival hub', async () => {
  const listingPayload = {
    data: [
      { id: 601, title: 'Twilight Lantern Walk', permalink: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/lantern-walk/' },
      { id: 602, title: 'Active Bystander Training', permalink: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/bystander-training/' },
      { id: 603, title: 'Teen Sewing Club', permalink: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/teen-sewing-club/' },
      { id: 604, title: 'Silent Writing Group', permalink: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/silent-writing-group/' },
      { id: 605, title: 'Celebrate PrideFEST in Fremantle', permalink: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/pridefest-in-freo/' }
    ],
    sorted_events: [
      { post: { ID: 601 }, next_date: '2026-12-05' },
      { post: { ID: 602 }, next_date: '2026-11-25' },
      { post: { ID: 603 }, next_date: '2026-11-25' },
      { post: { ID: 604 }, next_date: '2026-11-27' },
      { post: { ID: 605 }, next_date: '2026-11-25' }
    ],
    htmlResult: `
      <article class="card" data-post-id="601"><h4 class="card-title">Twilight Lantern Walk</h4></article>
      <article class="card" data-post-id="602"><h4 class="card-title">Active Bystander Training</h4></article>
      <article class="card" data-post-id="603"><h4 class="card-title">Teen Sewing Club</h4></article>
      <article class="card" data-post-id="604"><h4 class="card-title">Silent Writing Group</h4></article>
      <article class="card" data-post-id="605"><h4 class="card-title">Celebrate PrideFEST in Fremantle</h4></article>
    `
  };

  const detailPages = {
    'lantern-walk': `
      <div class="event-type-family">
        <div class="eventdetail-icontext"><div class="text"><div class="text-label">Date / Frequency</div><div>5 Dec 2026</div></div></div>
        <div class="eventdetail-icontext"><div class="text"><div class="text-label">Time</div><div>6:30 pm - 8:30 pm</div></div></div>
        <div id="addToCalendarModal"><a class="icon-google" href="https://www.google.com/calendar/render?action=TEMPLATE&dates=20261205T183000/20261205T203000">Google Calendar</a></div>
      </div>
    `,
    'bystander-training': `
      <div class="event-type-access-and-inclusion">
        <div class="eventdetail-icontext"><div class="text"><div class="text-label">Date / Frequency</div><div>25-30 Nov 2026</div></div></div>
        <div class="eventdetail-icontext"><div class="text"><div class="text-label">Time</div><div>9:00 am - 5:00 pm</div></div></div>
        <div id="addToCalendarModal"><a class="icon-google" href="https://www.google.com/calendar/render?action=TEMPLATE&dates=20261125T090000/20261130T170000">Google Calendar</a></div>
      </div>
    `,
    'teen-sewing-club': `
      <div class="event-type-arts-culture-and-languages event-type-young-people">
        <div class="eventdetail-icontext"><div class="text"><div class="text-label">Date / Frequency</div><div>Wednesdays | 28 Oct-2 Dec</div></div></div>
        <div class="eventdetail-icontext"><div class="text"><div class="text-label">Time</div><div>4:00 pm - 5:45 pm</div></div></div>
        <div class="eventdetail-icontext"><div class="text"><div class="text-label">Location</div><div>Library, 151 High St, Fremantle WA 6160</div></div></div>
        <div id="addToCalendarModal"><a class="icon-google" href="https://www.google.com/calendar/render?action=TEMPLATE&dates=20261028T160000/20261202T174500&location=Library%2C%20151%20High%20St%2C%20Fremantle%20WA%206160">Google Calendar</a></div>
      </div>
    `,
    'silent-writing-group': `
      <div class="event-type-library">
        <div class="eventdetail-icontext"><div class="text"><div class="text-label">Date / Frequency</div><div>Every Friday</div></div></div>
        <div class="eventdetail-icontext"><div class="text"><div class="text-label">Time</div><div>10:00 am - 11:30 am</div></div></div>
        <div class="eventdetail-icontext"><div class="text"><div class="text-label">Location</div><div>Fremantle Library, 151 High St, Fremantle WA 6160</div></div></div>
      </div>
    `,
    'pridefest-in-freo': `
      <div class="event-type-arts-culture-and-languages event-type-access-and-inclusion">
        <div class="eventdetail-icontext"><div class="text"><div class="text-label">Date / Frequency</div><div>Nov 2026</div></div></div>
        <div class="eventdetail-icontext"><div class="text"><div class="text-label">Location</div><div>Walyalup Civic Centre, 151 High St, Fremantle WA 6160</div></div></div>
      </div>
    `
  };

  const mockFetch = async (url) => {
    if (url === FREMANTLE_ENDPOINT) {
      return { ok: true, async json() { return listingPayload; } };
    }
    const key = Object.keys(detailPages).find(k => url.includes(k));
    return { ok: true, async text() { return detailPages[key] || ''; } };
  };

  const crawler = createFremantleCrawler({
    fetchFn: mockFetch,
    pageDelayMs: 0,
    detailDelayMs: 0,
    now: TEST_NOW
  });

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 5);

  const sanitize = (raw) => sanitizeActivity({
    ...raw,
    venue: { ...raw.venue, coordinates: FREMANTLE_LGA_CENTROID }
  }, TEST_NOW.toISOString());

  // 1. Single-day
  const single = sanitize(listings[0]);
  assert.equal(single.schedule.start_date, '2026-12-05');
  assert.equal(single.schedule.end_date, '2026-12-05');
  assert.equal(single.schedule.start_time, '18:30');
  assert.equal(single.schedule.end_time, '20:30');
  assert.equal(single.schedule.recurrence, 'none');

  // 2. Compact multi-day
  const multiDay = sanitize(listings[1]);
  assert.equal(multiDay.schedule.start_date, '2026-11-25');
  assert.equal(multiDay.schedule.end_date, '2026-11-30');
  assert.equal(multiDay.schedule.start_time, '09:00');
  assert.equal(multiDay.schedule.end_time, '17:00');
  assert.equal(multiDay.schedule.recurrence, 'none');

  // 3. In-progress recurring series (clamped from 2026-10-28 to next_date 2026-11-25)
  const series = sanitize(listings[2]);
  assert.equal(series.schedule.start_date, '2026-11-25');
  assert.equal(series.schedule.end_date, null);
  assert.equal(series.schedule.start_time, '16:00');
  assert.equal(series.schedule.end_time, '17:45');
  assert.equal(series.schedule.recurrence, 'weekly');
  assert.equal(series.schedule.day_of_week, 3);
  assert.equal(series.venue.name, 'Fremantle Library');
  assert.equal(listings[2].address, '151 High St, Fremantle WA 6160');
  assert.equal(listings[2].venue.address, '151 High St, Fremantle WA 6160');

  // 4. Open-ended weekly
  const openWeekly = sanitize(listings[3]);
  assert.equal(openWeekly.schedule.start_date, '2026-11-27');
  assert.equal(openWeekly.schedule.end_date, null);
  assert.equal(openWeekly.schedule.start_time, '10:00');
  assert.equal(openWeekly.schedule.end_time, '11:30');
  assert.equal(openWeekly.schedule.recurrence, 'weekly');
  assert.equal(openWeekly.schedule.day_of_week, 5);

  // 5. Umbrella festival hub (month-only falls back to next_date, ingested as normal Activity)
  const hub = sanitize(listings[4]);
  assert.equal(hub.schedule.start_date, '2026-11-25');
  assert.equal(hub.schedule.recurrence, 'none');
  assert.equal(hub.category, 'arts');
});

test('Slice 9: Detail taxonomy filters civic event-type-council-and-committee-meetings, and when_missing skips complete cards', async () => {
  const requestedUrls = [];
  const listingPayload = {
    data: [
      {
        id: 701,
        title: 'Planning Briefing Session',
        permalink: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/planning-briefing/'
      },
      {
        id: 702,
        title: 'Complete Card Activity',
        permalink: 'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/complete-card/',
        address: '151 High St, Fremantle WA 6160',
        time: '10:00am - 11:00am',
        categories: ['Music']
      }
    ],
    sorted_events: [
      { post: { ID: 701 }, next_date: '2026-12-03' },
      { post: { ID: 702 }, next_date: '2026-12-04' }
    ]
  };

  const mockFetch = async (url) => {
    requestedUrls.push(url);
    if (url === FREMANTLE_ENDPOINT) {
      return { ok: true, async json() { return listingPayload; } };
    }
    if (url.includes('planning-briefing')) {
      return {
        ok: true,
        async text() {
          return '<div class="event-type-council-and-committee-meetings"></div>';
        }
      };
    }
    return { ok: true, async text() { return ''; } };
  };

  const crawler = createFremantleCrawler({
    fetchFn: mockFetch,
    pageDelayMs: 0,
    detailDelayMs: 0,
    hydrateDetail: 'when_missing',
    now: TEST_NOW
  });

  const listings = await crawler.fetchListings();
  // 701 hydrated (missing fields) and then filtered out due to event-type-council-and-committee-meetings;
  // 702 skipped hydration because address, time, and tags were already present.
  assert.deepEqual(requestedUrls, [
    FREMANTLE_ENDPOINT,
    'https://www.fremantle.wa.gov.au/arts-and-culture/whats-on/planning-briefing/'
  ]);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].source_id, '702');
  assert.equal(listings[0].category, 'music');
});
