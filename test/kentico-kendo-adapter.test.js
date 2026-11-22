import test from 'node:test';
import assert from 'node:assert/strict';
import { createKenticoKendoCrawler } from '../src/crawlers/kentico-kendo-adapter.js';
import { sanitizeActivity } from '../src/sanitizer.js';

const BASE_CONFIG = {
  source: 'test_council',
  label: 'Test Council',
  endpoint: 'https://example.wa.gov.au/ksearchevent/ksearchresult',
  baseUrl: 'https://example.wa.gov.au',
  searchParam: [{ key: 'classname', values: ['AWPT.Event'], or: 'true', operator: 'eq' }],
  defaultOrganizer: {
    id: 'org_test_council',
    name: 'Test Council',
    website: 'https://example.wa.gov.au'
  },
  fallbackCentroid: { lat: -31.8847, lng: 115.8079 },
  minExpectedListings: 1
};

test('Kentico/Kendo adapter paginates with injectable delay, filters noise/expired/horizon items, and preserves deterministic keys', async () => {
  const now = new Date('2026-11-01T08:00:00+08:00');
  const requests = [];
  const delays = [];

  const mockFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body, headers: init.headers });

    if (body.page === 1) {
      return {
        ok: true,
        async json() {
          return {
            Total: 6,
            Data: [
              {
                NodeGUID: 'guid-valid-1',
                ArticleTitle: 'Pottery for Beginners',
                ArticleCategories: 'Craft & Hobbies',
                ArticleAddressTitle: 'Community Arts Hub',
                ArticleTeaser: 'Hands-on pottery class.',
                Cost: '$15',
                EventDisplayDate: '2026-11-15T10:00:00+08:00',
                PageUrl: '/events/pottery'
              },
              {
                NodeGUID: 'guid-civic-notice',
                ArticleTitle: 'Ordinary Council Meeting',
                ArticleCategories: 'Council',
                EventDisplayDate: '2026-11-18T18:00:00+08:00',
                PageUrl: '/events/council-meeting'
              },
              {
                NodeGUID: 'guid-online-only',
                ArticleTitle: 'Small Business Webinar (Online Only)',
                ArticleCategories: 'Community',
                ArticleAddressTitle: 'Zoom',
                EventDisplayDate: '2026-11-20T12:00:00+08:00',
                PageUrl: '/events/webinar'
              }
            ]
          };
        }
      };
    }

    return {
      ok: true,
      async json() {
        return {
          Total: 6,
          Data: [
            {
              NodeGUID: 'guid-expired',
              ArticleTitle: 'Past Tennis Clinic',
              ArticleCategories: 'Sports',
              ArticleAddressTitle: 'Local Courts',
              EventDisplayDate: '2026-10-20T09:00:00+08:00',
              PageUrl: '/events/past-tennis'
            },
            {
              NodeGUID: 'guid-far-future',
              ArticleTitle: 'Next Year Festival',
              ArticleCategories: 'Music',
              ArticleAddressTitle: 'Civic Park',
              EventDisplayDate: '2027-03-15T10:00:00+08:00',
              PageUrl: '/events/future-fest'
            },
            {
              NodeGUID: 'guid-explicit-org',
              ArticleTitle: 'Jazz in the Park',
              ArticleCategories: 'Music & Concerts',
              ArticleAddressTitle: 'Civic Park',
              OrganizerName: 'Perth Jazz Society',
              Latitude: -31.89,
              Longitude: 115.81,
              Cost: 'Free',
              EventDisplayDate: '2026-11-25T17:00:00+08:00',
              PageUrl: '/events/jazz'
            }
          ]
        };
      }
    };
  };

  const crawler = createKenticoKendoCrawler(BASE_CONFIG, {
    fetchFn: mockFetch,
    pageSize: 3,
    pageDelayMs: 1200,
    delayFn: async (ms) => { delays.push(ms); },
    now
  });

  assert.equal(crawler.name, 'test_council');
  assert.equal(crawler.group, 'councils');
  assert.deepEqual(crawler.fallbackCentroid, { lat: -31.8847, lng: 115.8079 });

  const listings = await crawler.fetchListings();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.skip, 0);
  assert.equal(requests[1].body.skip, 3);
  assert.deepEqual(delays, [1200]);

  // Only the 2 valid in-person, in-window activities survive adapter-level filtering
  assert.equal(listings.length, 2);

  // First item: no coords provided -> coordinates omitted (not hardcoded), fallback organizer used
  const first = listings[0];
  assert.equal(first.source, 'test_council');
  assert.equal(first.source_id, 'guid-valid-1');
  assert.equal(first.category, 'hobbies');
  assert.equal(first.coordinates, undefined);
  assert.equal(first.organizer.name, 'Test Council');

  const sanitizedFirst = sanitizeActivity({
    ...first,
    coordinates: BASE_CONFIG.fallbackCentroid
  });
  assert.equal(sanitizedFirst.id, 'test_council_guid-valid-1');
  assert.equal(sanitizedFirst.category, 'hobbies');

  // Second item: explicit organizer overrides defaultOrganizer, explicit coords preserved
  const second = listings[1];
  assert.equal(second.category, 'music');
  assert.equal(second.organizer.name, 'Perth Jazz Society');
  assert.deepEqual(second.coordinates, { lat: -31.89, lng: 115.81 });
});

test('Kentico/Kendo adapter enforces 20-page and 200-Activity safety caps', async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls += 1;
    return {
      ok: true,
      async json() {
        return {
          Total: 1000,
          Data: Array.from({ length: 15 }, (_, i) => ({
            NodeGUID: `guid-${calls}-${i}`,
            ArticleTitle: `Community Sport ${calls}-${i}`,
            ArticleCategories: 'Sports',
            ArticleAddressTitle: 'Local Oval',
            EventDisplayDate: '2026-11-20T10:00:00+08:00',
            PageUrl: `/events/${calls}-${i}`
          }))
        };
      }
    };
  };

  const crawler = createKenticoKendoCrawler(BASE_CONFIG, {
    fetchFn: mockFetch,
    pageSize: 15,
    pageDelayMs: 0,
    now: new Date('2026-11-01T08:00:00+08:00')
  });

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 200);
  assert.equal(calls, 14);
});

test('Kentico/Kendo adapter supports per-council minExpectedListings=0 and continues past all-filtered pages', async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls += 1;
    return {
      ok: true,
      async json() {
        return {
          Total: 2,
          Data: calls === 1
            ? [{ NodeGUID: 'g1', ArticleTitle: 'Community Workshop', ArticleCategories: 'Council Meeting', EventDisplayDate: '2026-11-15T10:00:00+08:00', PageUrl: '/e/1' }]
            : [{ NodeGUID: 'g2', ArticleTitle: 'Morning Yoga', ArticleCategories: 'Health', ArticleAddressTitle: 'Civic Park', EventDisplayDate: '2026-11-16T08:00:00+08:00', PageUrl: '/e/2' }]
        };
      }
    };
  };

  const crawler = createKenticoKendoCrawler(
    { ...BASE_CONFIG, minExpectedListings: 0 },
    { fetchFn: mockFetch, pageSize: 1, pageDelayMs: 0, now: new Date('2026-11-01T08:00:00+08:00') }
  );
  assert.equal(crawler.minExpectedListings, 0);

  const listings = await crawler.fetchListings();
  assert.equal(calls, 2);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].source_id, 'g2');
  assert.equal(listings[0].category, 'health');
});

test('Kentico/Kendo adapter derives deterministic source_id from canonical URL or normalized title + start date when CMS IDs are absent', async () => {
  const now = new Date('2026-11-01T08:00:00+08:00');
  const itemA = {
    ArticleTitle: 'Archery Come & Try',
    ArticleCategories: 'Sports',
    ArticleAddressTitle: 'Civic Reserve',
    EventDisplayDate: '2026-11-18T09:00:00+08:00',
    PageUrl: '/events/archery-come-try?utm_source=feed'
  };
  const itemB = {
    ArticleTitle: 'Twilight Bowls',
    ArticleCategories: 'Sports',
    ArticleAddressTitle: 'Bowls Club',
    EventDisplayDate: '2026-11-22T17:00:00+08:00'
  };
  const itemC = {
    ArticleTitle: 'Inserted Community Walk',
    ArticleCategories: 'Community',
    ArticleAddressTitle: 'Lake Monger',
    EventDisplayDate: '2026-11-15T08:00:00+08:00'
  };

  const makeCrawler = (dataList) => createKenticoKendoCrawler(
    BASE_CONFIG,
    {
      now,
      pageDelayMs: 0,
      fetchFn: async () => ({
        ok: true,
        async json() {
          return { Total: dataList.length, Data: dataList };
        }
      })
    }
  );

  const crawl1 = await makeCrawler([itemA, itemB]).fetchListings();
  const crawl2 = await makeCrawler([itemC, itemB, itemA]).fetchListings();

  const a1 = crawl1.find(i => i.title === 'Archery Come & Try');
  const b1 = crawl1.find(i => i.title === 'Twilight Bowls');
  const a2 = crawl2.find(i => i.title === 'Archery Come & Try');
  const b2 = crawl2.find(i => i.title === 'Twilight Bowls');

  assert.equal(a1.source_id, a2.source_id);
  assert.equal(b1.source_id, b2.source_id);
  assert.notEqual(a1.source_id, b1.source_id);
  assert.ok(!/^\d+$/.test(a1.source_id));
  assert.ok(!/^\d+$/.test(b1.source_id));
});
