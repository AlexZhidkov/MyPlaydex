import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOptimizelyAppState,
  createOptimizelySsrCrawler
} from '../src/crawlers/optimizely-ssr-adapter.js';

const TEST_NOW = new Date('2026-11-01T08:00:00+08:00');

function wrapAppStateHtml(stateObj, scriptId = 'site-search-app-state') {
  return `<!DOCTYPE html><html><head><title>Events</title></head><body>
    <div id="root"></div>
    <script type="application/json" id="${scriptId}">${JSON.stringify(stateObj)}</script>
  </body></html>`;
}

test('Optimizely SSR Adapter extracts #site-search-app-state JSON and maps basic activity fields', async () => {
  const payload = {
    schemaVersion: 1,
    results: {
      totalRecords: 1,
      page: 1,
      pageSize: 24,
      results: [
        {
          contentGuid: 'c767be15-bf1d-448b-8029-30ca137dc831',
          savedItemType: 'event',
          properties: {
            Name: 'Contemporary Photography Exhibition',
            Url: '/events/contemporary-photography/',
            Summary: 'An exhibition of contemporary photography and video.',
            Categories: [
              { name: 'Art and exhibitions' },
              { name: 'Free' },
              { name: 'Northbridge' }
            ],
            Location: 'Perth Cultural Centre, Perth, 6000',
            EventListing: {
              dateDisplay: '20 Nov - 30 Nov',
              dateParts: [
                { text: '20 Nov', isoDateTime: '2026-11-20' },
                { text: '30 Nov', isoDateTime: '2026-11-30' }
              ],
              timeParts: [
                { text: '10:00am', isoDateTime: '2026-11-20T10:00:00' },
                { text: '5:00pm', isoDateTime: '2026-11-20T17:00:00' }
              ]
            },
            Latitude: -31.9497603,
            Longitude: 115.860723
          }
        }
      ]
    }
  };

  const html = wrapAppStateHtml(payload);
  const extracted = extractOptimizelyAppState(html);
  assert.equal(extracted.results.totalRecords, 1);

  const requestedUrls = [];
  const crawler = createOptimizelySsrCrawler(
    {
      source: 'visit_perth',
      label: 'Visit Perth',
      endpoint: 'https://www.visitperth.com/events',
      baseUrl: 'https://www.visitperth.com'
    },
    {
      now: TEST_NOW,
      pageDelayMs: 0,
      fetchFn: async (url) => {
        requestedUrls.push(url);
        return {
          ok: true,
          async text() {
            return html;
          }
        };
      }
    }
  );

  const items = await crawler.fetchListings();
  assert.deepEqual(requestedUrls, ['https://www.visitperth.com/events?page=1']);
  assert.equal(items.length, 1);

  const item = items[0];
  assert.equal(item.source, 'visit_perth');
  assert.equal(item.source_id, 'c767be15-bf1d-448b-8029-30ca137dc831');
  assert.equal(item.title, 'Contemporary Photography Exhibition');
  assert.equal(item.description, 'An exhibition of contemporary photography and video.');
  assert.equal(item.source_url, 'https://www.visitperth.com/events/contemporary-photography/');
  assert.equal(item.region_id, 'perth');
  assert.equal(item.category, 'arts');
  assert.equal(item.venue_name, 'Perth Cultural Centre, Perth, 6000');
  assert.deepEqual(item.coordinates, { lat: -31.9497603, lng: 115.860723 });
  assert.equal(item.start_time, '2026-11-20T10:00:00');
  assert.equal(item.end_time, '2026-11-30');
  assert.equal(item.is_free, true);
  assert.equal(item.cost_description, 'Free');
});

test('Optimizely SSR Adapter paginates ?page=N with polite delay and enforces 20-page / 200-Activity caps', async () => {
  const delays = [];
  const requestedPages = [];

  const makeRecord = (id) => ({
    contentGuid: `guid-${id}`,
    properties: {
      Name: `Community Jazz Night ${id}`,
      Url: `/events/jazz-${id}`,
      Categories: [{ name: 'Music' }],
      Location: 'Perth Town Hall',
      EventListing: {
        dateParts: [{ isoDateTime: '2026-11-22' }]
      },
      Latitude: -31.954,
      Longitude: 115.861
    }
  });

  // 25 pages * 12 items = 300 items, should stop at 200 items / <= 20 pages
  const crawler = createOptimizelySsrCrawler(
    {
      source: 'visit_perth',
      label: 'Visit Perth',
      endpoint: 'https://www.visitperth.com/events',
      baseUrl: 'https://www.visitperth.com'
    },
    {
      now: TEST_NOW,
      pageDelayMs: 1200,
      delayFn: async (ms) => { delays.push(ms); },
      fetchFn: async (url) => {
        const page = Number(new URL(url).searchParams.get('page'));
        requestedPages.push(page);
        const start = (page - 1) * 12 + 1;
        const records = Array.from({ length: 12 }, (_, idx) => makeRecord(start + idx));
        const html = wrapAppStateHtml({
          results: {
            totalRecords: 300,
            page,
            pageSize: 12,
            results: records
          }
        });
        return { ok: true, async text() { return html; } };
      }
    }
  );

  const items = await crawler.fetchListings();
  assert.equal(items.length, 200);
  // 17 pages * 12 = 204 >= 200, so stops at page 17 with 16 delays
  assert.equal(requestedPages.length, 17);
  assert.equal(requestedPages[0], 1);
  assert.equal(requestedPages[16], 17);
  assert.equal(delays.length, 16);
  assert.ok(delays.every(d => d === 1200));

  // Also verify 20-page cap when total items stay below 200 (25 pages * 5 items = 125 -> stops at 20 pages = 100 items)
  const pageCapPages = [];
  const pageCapCrawler = createOptimizelySsrCrawler(
    {
      source: 'visit_perth',
      label: 'Visit Perth',
      endpoint: 'https://www.visitperth.com/events',
      baseUrl: 'https://www.visitperth.com'
    },
    {
      now: TEST_NOW,
      pageDelayMs: 0,
      fetchFn: async (url) => {
        const page = Number(new URL(url).searchParams.get('page'));
        pageCapPages.push(page);
        const start = (page - 1) * 5 + 1;
        const records = Array.from({ length: 5 }, (_, idx) => makeRecord(start + idx));
        return {
          ok: true,
          async text() {
            return wrapAppStateHtml({
              results: { totalRecords: 125, page, pageSize: 5, results: records }
            });
          }
        };
      }
    }
  );
  const pageCapItems = await pageCapCrawler.fetchListings();
  assert.equal(pageCapPages.length, 20);
  assert.equal(pageCapItems.length, 100);
});

test('Optimizely SSR Adapter throws descriptive errors on HTTP failure or missing state script', async () => {
  const httpFailCrawler = createOptimizelySsrCrawler(
    {
      source: 'visit_perth',
      label: 'Visit Perth',
      endpoint: 'https://www.visitperth.com/events/',
      baseUrl: 'https://www.visitperth.com'
    },
    {
      pageDelayMs: 0,
      fetchFn: async () => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: new Headers({
          server: 'cloudflare',
          'cf-ray': 'abc123-PER',
          'retry-after': '30'
        })
      })
    }
  );
  await assert.rejects(
    () => httpFailCrawler.fetchListings(),
    (err) => {
      assert.match(err.message, /Visit Perth responded with HTTP 503: Service Unavailable/);
      assert.match(err.message, /https:\/\/www\.visitperth\.com\/events\/\?page=1/);
      assert.match(err.message, /server=cloudflare/);
      assert.match(err.message, /cf-ray=abc123-PER/);
      assert.match(err.message, /retry-after=30/);
      return true;
    }
  );

  const missingScriptCrawler = createOptimizelySsrCrawler(
    {
      source: 'visit_perth',
      label: 'Visit Perth',
      endpoint: 'https://www.visitperth.com/events',
      baseUrl: 'https://www.visitperth.com'
    },
    {
      pageDelayMs: 0,
      fetchFn: async () => ({ ok: true, async text() { return '<html><body>No state</body></html>'; } })
    }
  );
  await assert.rejects(() => missingScriptCrawler.fetchListings(), /Missing Optimizely SSR state script #site-search-app-state/);
});

test('Optimizely SSR Adapter filters civic/admin notices, online-only items, Expired Activities, and >90-day horizon', async () => {
  const html = wrapAppStateHtml({
    results: {
      totalRecords: 5,
      page: 1,
      pageSize: 24,
      results: [
        {
          contentGuid: 'keep-1',
          properties: {
            Name: 'Elizabeth Quay Twilight Market',
            Url: '/events/twilight-market',
            Categories: [{ name: 'Food & drink' }],
            Location: 'Elizabeth Quay, Perth',
            EventListing: { dateParts: [{ isoDateTime: '2026-11-25' }] }
          }
        },
        {
          contentGuid: 'drop-civic',
          properties: {
            Name: 'Ordinary Council Meeting',
            Url: '/events/council-meeting',
            Categories: [{ name: 'Community' }],
            Location: 'Council House, Perth',
            EventListing: { dateParts: [{ isoDateTime: '2026-11-25' }] }
          }
        },
        {
          contentGuid: 'drop-online',
          properties: {
            Name: 'Virtual Event: Perth History Talk',
            Url: '/events/virtual-talk',
            Categories: [{ name: 'Talks & seminars' }],
            Location: 'Zoom',
            EventListing: { dateParts: [{ isoDateTime: '2026-11-25' }] }
          }
        },
        {
          contentGuid: 'drop-expired',
          properties: {
            Name: 'October Fringe Preview',
            Url: '/events/expired-show',
            Categories: [{ name: 'Arts' }],
            Location: 'Northbridge Piazza',
            EventListing: { dateParts: [{ isoDateTime: '2026-10-15' }] }
          }
        },
        {
          contentGuid: 'drop-horizon',
          properties: {
            Name: 'Autumn 2027 Festival',
            Url: '/events/far-future',
            Categories: [{ name: 'Festivals' }],
            Location: 'Langley Park',
            EventListing: { dateParts: [{ isoDateTime: '2027-04-15' }] }
          }
        }
      ]
    }
  });

  const crawler = createOptimizelySsrCrawler(
    {
      source: 'visit_perth',
      label: 'Visit Perth',
      endpoint: 'https://www.visitperth.com/events',
      baseUrl: 'https://www.visitperth.com'
    },
    {
      now: TEST_NOW,
      pageDelayMs: 0,
      fetchFn: async () => ({ ok: true, async text() { return html; } })
    }
  );

  const items = await crawler.fetchListings();
  assert.equal(items.length, 1);
  assert.equal(items[0].source_id, 'keep-1');
});

test('Optimizely SSR Adapter derives deterministic source_id from canonical URL or normalized title + start date when CMS IDs are absent', async () => {
  const itemA = {
    properties: {
      Name: 'Morning Yoga in the Park',
      Url: 'https://www.visitperth.com/events/morning-yoga/?utm_source=feed',
      Categories: [{ name: 'Health' }],
      Location: 'Kings Park',
      EventListing: { dateParts: [{ isoDateTime: '2026-11-20' }] }
    }
  };
  const itemB = {
    properties: {
      Name: 'Sunset Tai Chi!',
      Categories: [{ name: 'Health' }],
      Location: 'Langley Park',
      EventListing: { dateParts: [{ isoDateTime: '2026-11-22' }] }
    }
  };
  const itemC = {
    properties: {
      Name: 'Inserted Morning Walk',
      Url: '/events/inserted-morning-walk',
      Categories: [{ name: 'Community' }],
      Location: 'Elizabeth Quay',
      EventListing: { dateParts: [{ isoDateTime: '2026-11-19' }] }
    }
  };

  const makeCrawler = (resultsList) => createOptimizelySsrCrawler(
    {
      source: 'visit_perth',
      label: 'Visit Perth',
      endpoint: 'https://www.visitperth.com/events',
      baseUrl: 'https://www.visitperth.com'
    },
    {
      now: TEST_NOW,
      pageDelayMs: 0,
      fetchFn: async () => ({
        ok: true,
        async text() {
          return wrapAppStateHtml({
            schemaVersion: 1,
            results: { totalRecords: resultsList.length, page: 1, pageSize: 24, results: resultsList }
          });
        }
      })
    }
  );

  const crawl1 = await makeCrawler([itemA, itemB]).fetchListings();
  const crawl2 = await makeCrawler([itemC, itemB, itemA]).fetchListings();

  const a1 = crawl1.find(i => i.title === 'Morning Yoga in the Park');
  const b1 = crawl1.find(i => i.title === 'Sunset Tai Chi!');
  const a2 = crawl2.find(i => i.title === 'Morning Yoga in the Park');
  const b2 = crawl2.find(i => i.title === 'Sunset Tai Chi!');

  assert.equal(a1.source_id, a2.source_id);
  assert.equal(b1.source_id, b2.source_id);
  assert.notEqual(a1.source_id, b1.source_id);
  assert.ok(!/^\d+$/.test(a1.source_id));
  assert.ok(!/^\d+$/.test(b1.source_id));
});

test('Optimizely SSR Adapter emits empty cost when Cost and Free/Ticketed tags are absent', async () => {
  const payload = {
    schemaVersion: 1,
    results: {
      totalRecords: 3,
      page: 1,
      pageSize: 24,
      results: [
        {
          contentGuid: 'guid-unknown-cost',
          properties: {
            Name: 'Evening Basketball Scrimmage',
            Url: '/events/basketball-scrimmage',
            Categories: [{ name: 'Sports' }],
            Location: 'Perth Arena',
            EventListing: { dateParts: [{ isoDateTime: '2026-11-22' }] },
            Latitude: -31.95,
            Longitude: 115.85
          }
        },
        {
          contentGuid: 'guid-free-tag',
          properties: {
            Name: 'Free Tai Chi',
            Url: '/events/free-tai-chi',
            Categories: [{ name: 'Health' }, { name: 'Free' }],
            Location: 'Supreme Court Gardens',
            EventListing: { dateParts: [{ isoDateTime: '2026-11-23' }] },
            Latitude: -31.956,
            Longitude: 115.861
          }
        },
        {
          contentGuid: 'guid-explicit-cost',
          properties: {
            Name: 'Pottery Class',
            Url: '/events/pottery-class',
            Cost: '$30',
            Categories: [{ name: 'Arts' }],
            Location: 'Northbridge Studio',
            EventListing: { dateParts: [{ isoDateTime: '2026-11-24' }] },
            Latitude: -31.948,
            Longitude: 115.858
          }
        }
      ]
    }
  };

  const html = wrapAppStateHtml(payload);
  const crawler = createOptimizelySsrCrawler(
    {
      source: 'visit_perth',
      label: 'Visit Perth',
      endpoint: 'https://www.visitperth.com/events',
      baseUrl: 'https://www.visitperth.com'
    },
    {
      now: TEST_NOW,
      pageDelayMs: 0,
      fetchFn: async () => ({ ok: true, async text() { return html; } })
    }
  );

  const items = await crawler.fetchListings();
  assert.equal(items.length, 3);

  const unknown = items.find(i => i.source_id === 'guid-unknown-cost');
  assert.equal(unknown.display_price, '');
  assert.equal(unknown.cost_description, '');
  assert.equal(unknown.is_free, false);

  const free = items.find(i => i.source_id === 'guid-free-tag');
  assert.equal(free.display_price, 'Free');
  assert.equal(free.is_free, true);

  const paid = items.find(i => i.source_id === 'guid-explicit-cost');
  assert.equal(paid.display_price, '$30');
  assert.equal(paid.is_free, false);
});
