import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUMANITIX_PERTH_FEEDS,
  buildHumanitixFeedUrl,
  buildHumanitixSearchApiBody,
  createHumanitixCrawler,
  deduplicateHumanitixListings,
  extractHumanitixNextData,
  inferCategoryForOtherFeed,
  mapHumanitixEventToListing,
  parseHumanitixCost,
  parseHumanitixSearchPage,
  resolveHumanitixLocation,
  resolveHumanitixSchedule
} from '../src/crawlers/humanitix-crawler.js';

function makeHumanitixEvent(overrides = {}) {
  return {
    _id: '611b00bf4bd7a21a8060cc1a',
    hostname: 'https://events.humanitix.com/',
    slug: 'perth-social-volleyball',
    name: 'Perth Social Volleyball Night',
    timezone: 'Australia/Perth',
    isRecurring: false,
    suspendSales: false,
    offSaleDateIds: [],
    date: {
      _id: 'd1',
      startDate: '2026-12-03T10:00:00.000Z',
      endDate: '2026-12-03T12:00:00.000Z'
    },
    dates: [
      {
        _id: 'd1',
        startDate: '2026-12-03T10:00:00.000Z',
        endDate: '2026-12-03T12:00:00.000Z'
      }
    ],
    eventLocation: {
      type: 'address',
      venueName: 'Loftus Recreation Centre',
      address: '99 Loftus St, Leederville WA 6007, Australia',
      addressComponents: [
        { long_name: 'Leederville', short_name: 'Leederville', types: ['locality', 'political'] },
        { long_name: 'Western Australia', short_name: 'WA', types: ['administrative_area_level_1', 'political'] },
        { long_name: 'Australia', short_name: 'AU', types: ['country', 'political'] },
        { long_name: '6007', short_name: '6007', types: ['postal_code'] }
      ]
    },
    pricing: {
      minimumPrice: 15,
      maximumPrice: 25
    },
    ...overrides
  };
}

function buildHumanitixHtml(initialEvents, extra = {}) {
  const payload = {
    props: {
      pageProps: {
        initialEvents,
        initialStateKey: extra.stateKey ?? 'state-abc-123',
        locale: extra.locale ?? 'AU',
        geobox: extra.geobox ?? {
          name: 'Perth',
          countryCode: 'AU',
          address: 'Perth WA, Australia',
          latLng: { lat: -31.9505, lng: 115.8605 },
          northeast: { lat: -31.4, lng: 116.4 },
          southwest: { lat: -32.5, lng: 115.5 },
          area: 1234
        }
      }
    }
  };
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></body></html>`;
}

test('Humanitix Parser: extracts __NEXT_DATA__ and handles malformed/missing HTML safely', () => {
  const empty = extractHumanitixNextData('<html><body>No data</body></html>');
  assert.deepEqual(empty, { initialEvents: [], geobox: null, stateKey: null, locale: null });

  const broken = extractHumanitixNextData('<script id="__NEXT_DATA__">{invalid json</script>');
  assert.deepEqual(broken, { initialEvents: [], geobox: null, stateKey: null, locale: null });

  const html = buildHumanitixHtml([makeHumanitixEvent()]);
  const parsed = extractHumanitixNextData(html);
  assert.equal(parsed.initialEvents.length, 1);
  assert.equal(parsed.stateKey, 'state-abc-123');
  assert.equal(parsed.geobox.name, 'Perth');
});

test('Humanitix Parser: maps all 11 feeds, charityAndCauses -> community, and other title inference', () => {
  assert.equal(HUMANITIX_PERTH_FEEDS.length, 11);
  const charityFeed = HUMANITIX_PERTH_FEEDS.find(f => f.slug === 'charityAndCauses');
  assert.equal(charityFeed.category, 'community');
  assert.equal(charityFeed.priority, 1);
  assert.equal(HUMANITIX_PERTH_FEEDS.some(f => f.slug === 'businessAndProfessional'), false);
  assert.equal(HUMANITIX_PERTH_FEEDS.some(f => f.slug === 'all'), false);

  assert.equal(inferCategoryForOtherFeed('Chair Yoga 2026'), 'health');
  assert.equal(inferCategoryForOtherFeed('Board Games Club - Monthly'), 'hobbies');
  assert.equal(inferCategoryForOtherFeed('LEGO Challenge Free Play'), 'family');
  assert.equal(inferCategoryForOtherFeed('Perth Social Tennis Hit'), 'sports');
  assert.equal(inferCategoryForOtherFeed('English Conversation Circle'), 'community');

  // Priority-1 category feed overrides priority-0 'other' feed
  const fromOther = mapHumanitixEventToListing(makeHumanitixEvent({ name: 'Community Choir Rehearsal' }), {
    now: '2026-11-27T00:00:00Z'
  });
  const fromMusic = mapHumanitixEventToListing(makeHumanitixEvent({ name: 'Community Choir Rehearsal' }), {
    defaultCategory: 'music',
    now: '2026-11-27T00:00:00Z'
  });
  assert.equal(fromOther.category, 'music');
  const deduped = deduplicateHumanitixListings([
    { listing: fromOther, priority: 0 },
    { listing: fromMusic, priority: 1 }
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].category, 'music');
  assert.equal('organizer' in deduped[0], false);
  assert.equal('organizer_name' in deduped[0], false);
});

test('Humanitix Parser: converts UTC timestamps to AWST and distinguishes finite vs indefinite weekly recurrence', () => {
  const now = new Date('2026-11-27T00:00:00Z');

  // 23:00 UTC on Nov 30 is 07:00 AWST on Dec 1 (Tuesday, day_of_week = 2)
  const finiteWeeklyDates = Array.from({ length: 4 }, (_, i) => {
    const start = new Date(Date.UTC(2026, 10, 30 + i * 7, 23, 0, 0));
    const end = new Date(start.getTime() + 90 * 60 * 1000);
    return { _id: `fw-${i}`, startDate: start.toISOString(), endDate: end.toISOString() };
  });
  const finiteSchedule = resolveHumanitixSchedule(
    makeHumanitixEvent({ isRecurring: true, dates: finiteWeeklyDates }),
    now
  );
  assert.equal(finiteSchedule.recurrence, 'weekly');
  assert.equal(finiteSchedule.start_date, '2026-12-01');
  assert.equal(finiteSchedule.start_time, '07:00');
  assert.equal(finiteSchedule.end_time, '08:30');
  assert.equal(finiteSchedule.day_of_week, 2);
  assert.equal(finiteSchedule.end_date, '2026-12-22');

  // Long-running > 6 months -> end_date: null (perpetual)
  const longWeeklyDates = Array.from({ length: 40 }, (_, i) => {
    const start = new Date(Date.UTC(2026, 10, 30 + i * 7, 23, 0, 0));
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return { _id: `lw-${i}`, startDate: start.toISOString(), endDate: end.toISOString() };
  });
  const perpetualSchedule = resolveHumanitixSchedule(
    makeHumanitixEvent({ isRecurring: true, dates: longWeeklyDates }),
    now
  );
  assert.equal(perpetualSchedule.recurrence, 'weekly');
  assert.equal(perpetualSchedule.end_date, null);

  // Off-sale first date is skipped in favor of next on-sale date
  const offSaleSchedule = resolveHumanitixSchedule(
    makeHumanitixEvent({
      isRecurring: false,
      offSaleDateIds: ['d1'],
      dates: [
        { _id: 'd1', startDate: '2026-12-01T10:00:00.000Z', endDate: '2026-12-01T12:00:00.000Z' },
        { _id: 'd2', startDate: '2026-12-08T10:00:00.000Z', endDate: '2026-12-08T12:00:00.000Z' }
      ]
    }),
    now
  );
  assert.equal(offSaleSchedule.recurrence, 'none');
  assert.equal(offSaleSchedule.start_date, '2026-12-08');
});

test('Humanitix Parser: hard-drops online, suspended, off-sale, non-WA, and administrative/B2B noise', () => {
  const now = new Date('2026-11-27T00:00:00Z');
  const html = buildHumanitixHtml([
    makeHumanitixEvent({ _id: 'keep-1', name: 'Fremantle Sunset Kayak' }),
    makeHumanitixEvent({ _id: 'drop-online', eventLocation: { type: 'online' } }),
    makeHumanitixEvent({ _id: 'drop-susp', suspendSales: true }),
    makeHumanitixEvent({ _id: 'drop-offsale', offSaleDateIds: ['d1'] }),
    makeHumanitixEvent({
      _id: 'drop-sydney',
      eventLocation: {
        type: 'address',
        venueName: 'Sydney Hall',
        address: '1 George St, Sydney NSW 2000',
        addressComponents: [
          { long_name: 'Sydney', short_name: 'Sydney', types: ['locality'] },
          { long_name: 'New South Wales', short_name: 'NSW', types: ['administrative_area_level_1'] },
          { long_name: 'Australia', short_name: 'AU', types: ['country'] }
        ]
      }
    }),
    makeHumanitixEvent({ _id: 'drop-donate', name: 'VPCC DONATIONS: Donate to your local centre' }),
    makeHumanitixEvent({ _id: 'drop-member', name: 'Player Membership 2026' }),
    makeHumanitixEvent({ _id: 'drop-bni', name: 'BNI Fairway Weekly Meeting' }),
    makeHumanitixEvent({ _id: 'drop-it', name: 'SharePoint Online for Power Users' })
  ]);

  const { listings, rawIds } = parseHumanitixSearchPage(html, { defaultCategory: 'sports', now });
  assert.equal(rawIds.length, 9);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].source_id, 'keep-1');
  assert.equal(listings[0].source_url, 'https://events.humanitix.com/perth-social-volleyball');
});

test('Humanitix Parser: formats pricing and resolves Perth suburb coordinates', () => {
  assert.deepEqual(parseHumanitixCost({ minimumPrice: 0, maximumPrice: 0 }), { isFree: true, displayPrice: 'Free' });
  assert.deepEqual(parseHumanitixCost({ minimumPrice: 24, maximumPrice: 24 }), { isFree: false, displayPrice: '$24' });
  assert.deepEqual(parseHumanitixCost({ minimumPrice: 15, maximumPrice: 40.5 }), { isFree: false, displayPrice: '$15 - $40.50' });

  const loc = resolveHumanitixLocation(makeHumanitixEvent());
  assert.ok(loc);
  assert.equal(loc.venueName, 'Loftus Recreation Centre');
  assert.ok(Math.abs(loc.coordinates.lat - (-31.937)) < 0.05);
});

test('Humanitix Crawler: paginates via POST /api/search and falls back gracefully if /api/search errors', async () => {
  const feeds = [
    { slug: 'sportsAndFitness', humanitixCategory: 'sportsAndFitness', category: 'sports', priority: 1 }
  ];
  const ssrUrl = buildHumanitixFeedUrl(feeds[0]);
  const apiBodies = [];

  const crawler = createHumanitixCrawler({
    feeds,
    maxPages: 3,
    now: '2026-11-27T00:00:00Z',
    fetchFn: async (url, init) => {
      if (url === ssrUrl) {
        return {
          ok: true,
          status: 200,
          text: async () => buildHumanitixHtml([makeHumanitixEvent({ _id: 'p0-1', name: 'Page 0 Run' })])
        };
      }
      if (url.endsWith('/api/search')) {
        const body = JSON.parse(init.body);
        apiBodies.push(body);
        if (body.page === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => [makeHumanitixEvent({ _id: 'p1-1', name: 'Page 1 Yoga' })]
          };
        }
        return { ok: false, status: 500, statusText: 'Server Error' };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  const listings = await crawler.fetchListings();
  assert.equal(crawler.name, 'humanitix');
  assert.equal(crawler.localOnly, true);
  assert.equal(listings.length, 2);
  assert.deepEqual(listings.map(l => l.source_id), ['p0-1', 'p1-1']);
  assert.equal(apiBodies.length, 2);
  assert.equal(apiBodies[0].page, 1);
  assert.deepEqual(apiBodies[0].categories, ['sportsAndFitness']);
  assert.equal(apiBodies[0].stateKey, 'state-abc-123');
  assert.ok(buildHumanitixSearchApiBody({ feed: feeds[0], page: 1, stateKey: 'k', geobox: { name: 'Perth' } }));
});
