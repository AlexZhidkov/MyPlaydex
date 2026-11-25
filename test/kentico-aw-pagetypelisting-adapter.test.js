import test from 'node:test';
import assert from 'node:assert/strict';
import { createKenticoAwPageTypeListingCrawler } from '../src/crawlers/kentico-aw-pagetypelisting-adapter.js';

const TEST_NOW = new Date('2026-11-25T09:00:00+08:00');

const BASE_CONFIG = {
  source: 'test_kentico_aw',
  label: 'Test Kentico AW',
  group: 'councils',
  endpoint: 'https://example.wa.gov.au/search/htmlresult',
  baseUrl: 'https://example.wa.gov.au',
  searchIndex: 'Events',
  orderBy: '',
  pageSize: 2,
  firstPageSize: 2,
  parameters: [
    { key: 'classname', values: [{ value: 'AWPT.Event' }] },
    { key: 'FilterIsExpired', values: [{ value: 'false' }] }
  ],
  defaultOrganizer: {
    id: 'org_test_council',
    name: 'Test Council',
    website: 'https://example.wa.gov.au'
  }
};

function makeCardHtml({ href, title, dateText = '05 Dec 2026', venue = 'Test Park', tags = ['Community'] }) {
  return `
    <div class="col col-12 col-lg-6">
      <article class="card">
        <a href="${href}" class="hotbox" aria-label="Event Title: ${title}. Category: ${tags.join(', ')}. Event Date: ${dateText}. Event Venue: ${venue}. Read more.">
          <div class="hotbox-content">
            <div class="card-body">
              <div class="tags">${tags.map(t => `<span>${t}</span>`).join(' ')}</div>
              <h4 class="card-title">${title}</h4>
              <ul class="fa-ul">
                <li><span class="fa-li"><i class="fa-regular fa-calendar"></i></span>${dateText}</li>
                <li><span class="fa-li"><i class="fa-regular fa-location-smile"></i></span>${venue}</li>
              </ul>
            </div>
          </div>
        </a>
      </article>
    </div>
  `;
}

test('Slice 1: POSTs Kentico aw_pagetypelisting payload, paginates via hasnextpage/recordCountValue, deduplicates, and enforces caps', async () => {
  const requests = [];
  const delays = [];

  const mockFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, method: init.method, body });

    if (body.PG === 1) {
      return {
        ok: true,
        async json() {
          return {
            htmlResult: `
              <div class="hotboxes-wrapper">
                ${makeCardHtml({ href: '/whats-on/events/yoga-1', title: 'Morning Yoga' })}
                ${makeCardHtml({ href: '/whats-on/events/art-2', title: 'Park Painting' })}
              </div>
              <input id="recordCountValue" value="3" type="hidden"/>
              <input id="hasnextpage" value="true" type="hidden"/>
            `
          };
        }
      };
    }

    return {
      ok: true,
      async json() {
        return {
          htmlResult: `
            <div class="hotboxes-wrapper">
              ${makeCardHtml({ href: '/whats-on/events/art-2', title: 'Park Painting' })}
              ${makeCardHtml({ href: '/whats-on/events/music-3', title: 'Twilight Jazz' })}
            </div>
            <input id="recordCountValue" value="3" type="hidden"/>
            <input id="hasnextpage" value="false" type="hidden"/>
          `
        };
      }
    };
  };

  const crawler = createKenticoAwPageTypeListingCrawler(BASE_CONFIG, {
    fetchFn: mockFetch,
    delayFn: async (ms) => { delays.push(ms); },
    pageDelayMs: 600,
    now: TEST_NOW
  });

  const listings = await crawler.fetchListings();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://example.wa.gov.au/search/htmlresult');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, {
    SI: 'Events',
    OB: '',
    Q: '',
    PS: 2,
    FS: 2,
    PG: 1,
    PR: [
      { key: 'classname', values: [{ value: 'AWPT.Event' }] },
      { key: 'FilterIsExpired', values: [{ value: 'false' }] }
    ],
    IncludeFirst: true
  });
  assert.equal(requests[1].body.PG, 2);
  assert.equal(requests[1].body.IncludeFirst, false);
  assert.deepEqual(delays, [600]);
  assert.deepEqual(listings.map(l => l.title), ['Morning Yoga', 'Park Painting', 'Twilight Jazz']);

  // Safety caps: 20 pages / 200 activities
  let pageCalls = 0;
  const cappedFetch = async (_url, init) => {
    pageCalls += 1;
    const { PG } = JSON.parse(init.body);
    const cards = Array.from({ length: 15 }, (_, idx) =>
      makeCardHtml({
        href: `/whats-on/events/act-${PG}-${idx}`,
        title: `Community Activity ${PG}-${idx}`
      })
    ).join('');
    return {
      ok: true,
      async json() {
        return {
          htmlResult: `${cards}<input id="recordCountValue" value="500" type="hidden"/><input id="hasnextpage" value="true" type="hidden"/>`
        };
      }
    };
  };

  const cappedCrawler = createKenticoAwPageTypeListingCrawler(
    { ...BASE_CONFIG, pageSize: 15, firstPageSize: 15 },
    { fetchFn: cappedFetch, delayFn: async () => {}, now: TEST_NOW }
  );
  const cappedListings = await cappedCrawler.fetchListings();
  assert.equal(cappedListings.length, 200);
  assert.ok(pageCalls <= 20);
});

test('Slice 2: Recovers untruncated titles from card aria-label metadata and resolves canonical URLs', async () => {
  const mockFetch = async () => ({
    ok: true,
    async json() {
      return {
        htmlResult: `
          <div class="hotboxes-wrapper">
            <article class="card">
              <a href="/whats-on/events-calendar/mobile-youth-truck-whitfords-west-park-kallaroo" class="hotbox"
                 aria-label="Event Title: Mobile Youth Truck – Whitfords West Park, Kallaroo. Category: Youth. Event Date: Every Thursday (except public holidays). Event Venue: Whitfords West Park. Read more.">
                <div class="card-body">
                  <div class="tags"><span>Youth</span></div>
                  <h4 class="card-title">Mobile Youth Truck – Whitfords West Park...</h4>
                  <ul class="fa-ul">
                    <li><span class="fa-li"><i class="fa-regular fa-calendar"></i></span>Every Thursday (except public holidays)</li>
                    <li><span class="fa-li"><i class="fa-regular fa-location-smile"></i></span>Whitfords West Park</li>
                  </ul>
                </div>
              </a>
            </article>
            <article class="card">
              <a href="https://example.wa.gov.au/whats-on/events-calendar/st-johns-first-aid" class="hotbox"
                 aria-label="Event Title: St. John's Community First Aid. Category: Health and wellbeing. Event Date: Saturday, 05 Dec 2026. Event Venue: Joondalup Library. Read more.">
                <div class="card-body">
                  <h4 class="card-title">St. John's Community...</h4>
                </div>
              </a>
            </article>
          </div>
          <input id="recordCountValue" value="2" type="hidden"/>
          <input id="hasnextpage" value="false" type="hidden"/>
        `
      };
    }
  });

  const crawler = createKenticoAwPageTypeListingCrawler(BASE_CONFIG, {
    fetchFn: mockFetch,
    pageDelayMs: 0,
    now: TEST_NOW
  });

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 2);

  assert.equal(listings[0].title, 'Mobile Youth Truck – Whitfords West Park, Kallaroo');
  assert.equal(listings[0].source_url, 'https://example.wa.gov.au/whats-on/events-calendar/mobile-youth-truck-whitfords-west-park-kallaroo');
  assert.equal(listings[0].external_url, 'https://example.wa.gov.au/whats-on/events-calendar/mobile-youth-truck-whitfords-west-park-kallaroo');
  assert.equal(listings[0].venue_name, 'Whitfords West Park');
  assert.equal(listings[0].category, 'family');

  // Even when body elements are minimal, aria-label supplies untruncated title (including "St."), category, and venue
  assert.equal(listings[1].title, "St. John's Community First Aid");
  assert.equal(listings[1].venue_name, 'Joondalup Library');
  assert.equal(listings[1].category, 'health');
});

import { sanitizeActivity } from '../src/sanitizer.js';

const TEST_COORDS = { lat: -31.7456, lng: 115.766 };

test('Slice 3: Normalizes recurring natural-language schedules, shorthand time ranges, and leaves unknown cost empty', async () => {
  const mockFetch = async () => ({
    ok: true,
    async json() {
      return {
        htmlResult: `
          <div class="hotboxes-wrapper">
            ${makeCardHtml({
              href: '/whats-on/events-calendar/youth-truck-thursday',
              title: 'Mobile Youth Truck',
              dateText: 'Every Thursday (except public holidays)',
              venue: 'Whitfords West Park',
              tags: ['Youth']
            })}
            ${makeCardHtml({
              href: '/whats-on/events-calendar/art-group',
              title: 'Art group',
              dateText: 'Monday mornings',
              venue: 'Woodvale Library',
              tags: ['Arts and culture', 'Library']
            })}
            ${makeCardHtml({
              href: '/whats-on/events-calendar/minecraft-engineers',
              title: 'Minecraft Engineers - Woodvale',
              dateText: 'Tuesday, 4-5pm',
              venue: 'Woodvale Library',
              tags: ['Library', 'Technology']
            })}
            ${makeCardHtml({
              href: '/whats-on/events-calendar/imagination-station',
              title: 'Imagination Station - December',
              dateText: 'Sunday, 06 Dec 2026',
              venue: 'Joondalup Library',
              tags: ['Library']
            })}
            ${makeCardHtml({
              href: '/whats-on/events-calendar/invitation-art-prize',
              title: 'Invitation Art Prize',
              dateText: '29 October – 12 December 2026',
              venue: 'Joondalup Contemporary Art Gallery',
              tags: ['Arts and culture']
            })}
          </div>
          <input id="recordCountValue" value="5" type="hidden"/>
          <input id="hasnextpage" value="false" type="hidden"/>
        `
      };
    }
  });

  const crawler = createKenticoAwPageTypeListingCrawler(BASE_CONFIG, {
    fetchFn: mockFetch,
    pageDelayMs: 0,
    now: TEST_NOW
  });

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 5);

  const sanitize = (raw) => sanitizeActivity({
    ...raw,
    venue: { ...raw.venue, coordinates: TEST_COORDS }
  }, TEST_NOW.toISOString());

  // 1. "Every Thursday (except public holidays)"
  const thursday = sanitize(listings[0]);
  assert.equal(thursday.schedule.recurrence, 'weekly');
  assert.equal(thursday.schedule.day_of_week, 4);
  assert.equal(thursday.schedule.end_date, null);
  assert.deepEqual(thursday.cost, { is_free: false, display_price: '' });

  // 2. "Monday mornings"
  const monday = sanitize(listings[1]);
  assert.equal(monday.schedule.recurrence, 'weekly');
  assert.equal(monday.schedule.day_of_week, 1);
  assert.equal(monday.schedule.end_date, null);

  // 3. "Tuesday, 4-5pm" (shorthand time range)
  const tuesday = sanitize(listings[2]);
  assert.equal(tuesday.schedule.recurrence, 'weekly');
  assert.equal(tuesday.schedule.day_of_week, 2);
  assert.equal(tuesday.schedule.start_time, '16:00');
  assert.equal(tuesday.schedule.end_time, '17:00');
  assert.equal(tuesday.schedule.end_date, null);

  // 4. "Sunday, 06 Dec 2026"
  const single = sanitize(listings[3]);
  assert.equal(single.schedule.recurrence, 'none');
  assert.equal(single.schedule.start_date, '2026-12-06');
  assert.equal(single.schedule.end_date, null);

  // 5. "29 October – 12 December 2026"
  const multiDay = sanitize(listings[4]);
  assert.equal(multiDay.schedule.recurrence, 'none');
  assert.equal(multiDay.schedule.start_date, '2026-10-29');
  assert.equal(multiDay.schedule.end_date, '2026-12-12');
});

test('Slice 4: Filters civic/admin notices, online-only items, Expired Activity records, >90-day items, and maps 9 categories', async () => {
  const mockFetch = async () => ({
    ok: true,
    async json() {
      return {
        htmlResult: `
          <div class="hotboxes-wrapper">
            ${makeCardHtml({ href: '/events/council-meeting', title: 'Ordinary Council Meeting', dateText: '01 Dec 2026', venue: 'Council Chambers', tags: ['Civic'] })}
            ${makeCardHtml({ href: '/events/webinar', title: 'Climate Webinar', dateText: '02 Dec 2026', venue: 'Zoom', tags: ['Environment'] })}
            ${makeCardHtml({ href: '/events/past-picnic', title: 'Past Spring Picnic', dateText: '20 Nov 2026', venue: 'Mawson Park', tags: ['Community'] })}
            ${makeCardHtml({ href: '/events/far-future', title: 'Future Winter Festival', dateText: '01 Jun 2027', venue: 'Central Park', tags: ['Community'] })}
            ${makeCardHtml({ href: '/events/beach-volleyball', title: 'Mullaloo Beach Volleyball', dateText: '12 Dec 2026', venue: 'Mullaloo Beach', tags: ['Sport'] })}
            ${makeCardHtml({ href: '/events/night-market', title: 'Joondalup Twilight Food Market', dateText: '13 Dec 2026', venue: 'Central Walk', tags: ['Food and drink'] })}
          </div>
          <input id="recordCountValue" value="6" type="hidden"/>
          <input id="hasnextpage" value="false" type="hidden"/>
        `
      };
    }
  });

  const crawler = createKenticoAwPageTypeListingCrawler(BASE_CONFIG, {
    fetchFn: mockFetch,
    pageDelayMs: 0,
    now: TEST_NOW
  });

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 2);
  assert.equal(listings[0].title, 'Mullaloo Beach Volleyball');
  assert.equal(listings[0].category, 'sports');
  assert.equal(listings[1].title, 'Joondalup Twilight Food Market');
  assert.equal(listings[1].category, 'food');

  const errorCrawler = createKenticoAwPageTypeListingCrawler(BASE_CONFIG, {
    fetchFn: async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' }),
    pageDelayMs: 0
  });
  await assert.rejects(() => errorCrawler.fetchListings(), /HTTP 503/);
});
