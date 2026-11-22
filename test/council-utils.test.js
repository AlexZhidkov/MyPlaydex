import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCivicAdminNotice,
  isOnlineOnlyItem,
  isExpiredCouncilItem,
  isWithinHorizon,
  filterCouncilItem,
  mapCouncilCategory,
  paginateCouncilPages,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_ACTIVITIES,
  DEFAULT_HORIZON_DAYS
} from '../src/crawlers/council-utils.js';

test('isCivicAdminNotice filters council meetings, consultations, roadworks, and bin/waste notices', () => {
  assert.equal(isCivicAdminNotice({ title: 'Ordinary Council Meeting - November 2026' }), true);
  assert.equal(isCivicAdminNotice({ title: 'Special Electors Meeting & Agenda' }), true);
  assert.equal(isCivicAdminNotice({ title: 'Public Consultation: Draft Local Planning Strategy' }), true);
  assert.equal(isCivicAdminNotice({ title: 'Have Your Say: Scarborough Masterplan' }), true);
  assert.equal(isCivicAdminNotice({ title: 'Roadworks Notice: Karrinyup Road Closure' }), true);
  assert.equal(isCivicAdminNotice({ title: 'Verge Collection & Green Waste Bin Schedule' }), true);
  assert.equal(isCivicAdminNotice({ title: 'Community Workshop', category: 'Council Meeting' }), true);

  // Legitimate community activities must pass through
  assert.equal(isCivicAdminNotice({ title: 'Scarborough Community Beach Volleyball', category: 'Sports' }), false);
  assert.equal(isCivicAdminNotice({ title: 'Meet the Mayor Community Morning Tea', category: 'Community' }), false);
  assert.equal(isCivicAdminNotice({ title: 'Zero Waste Composting Workshop', category: 'Hobbies' }), false);
  assert.equal(isCivicAdminNotice({ title: 'Twilight Markets & Food Trucks', category: 'Food' }), false);
});

test('isOnlineOnlyItem filters online-only and virtual items without physical venues', () => {
  assert.equal(isOnlineOnlyItem({ title: 'Small Business Grant Webinar (Online Only)' }), true);
  assert.equal(isOnlineOnlyItem({ title: 'Youth Coding Club', venueName: 'Online via Zoom' }), true);
  assert.equal(isOnlineOnlyItem({ title: 'Virtual Author Talk', address: 'Microsoft Teams' }), true);
  assert.equal(isOnlineOnlyItem({ title: 'Digital Literacy Session', isOnline: true, venueName: '' }), true);

  // In-person or hybrid items with physical venues must pass through
  assert.equal(isOnlineOnlyItem({ title: 'Community Yoga', venueName: 'Stirling Leisure Centre', address: '123 Main St' }), false);
  assert.equal(isOnlineOnlyItem({ title: 'Council Town Hall (Livestream Available)', venueName: 'Stirling Civic Centre' }), false);
});

test('isExpiredCouncilItem and isWithinHorizon enforce AWST expiry and 90-day cutoff', () => {
  const now = new Date('2026-11-10T10:00:00+08:00');

  // Expired: ended more than 24h grace ago (2026-11-07 expired at 2026-11-09T00:00:00+08:00)
  assert.equal(isExpiredCouncilItem({ start_time: '2026-11-07T09:00:00+08:00' }, { now }), true);
  // Still within 24h grace window: 2026-11-09 expires at 2026-11-11T00:00:00+08:00
  assert.equal(isExpiredCouncilItem({ start_time: '2026-11-09T09:00:00+08:00' }, { now }), false);
  // Future item
  assert.equal(isExpiredCouncilItem({ start_time: '2026-11-20T09:00:00+08:00' }, { now }), false);
  // Missing date is not treated as expired here (let sanitizer decide or preserve undated)
  assert.equal(isExpiredCouncilItem({ start_time: null }, { now }), false);

  // 90-day horizon cutoff
  assert.equal(DEFAULT_HORIZON_DAYS, 90);
  assert.equal(isWithinHorizon({ start_time: '2026-12-01T09:00:00+08:00' }, { now }), true);
  assert.equal(isWithinHorizon({ start_time: '2027-02-07T09:00:00+08:00' }, { now }), true);
  assert.equal(isWithinHorizon({ start_time: '2027-03-15T09:00:00+08:00' }, { now }), false);
  assert.equal(isWithinHorizon({ start_time: null }, { now }), true);

  // Combined filterCouncilItem
  assert.equal(filterCouncilItem({ title: 'Roadworks on Main St', start_time: '2026-11-20T09:00:00+08:00' }, { now }), false);
  assert.equal(filterCouncilItem({ title: 'Online Webinar', venueName: 'Zoom', start_time: '2026-11-20T09:00:00+08:00' }, { now }), false);
  assert.equal(filterCouncilItem({ title: 'Past Yoga', start_time: '2026-11-01T09:00:00+08:00' }, { now }), false);
  assert.equal(filterCouncilItem({ title: 'Far Future Gala', start_time: '2027-04-01T09:00:00+08:00' }, { now }), false);
  assert.equal(filterCouncilItem({ title: 'Beach Volleyball', venueName: 'Scarborough Beach', start_time: '2026-11-20T09:00:00+08:00' }, { now }), true);
});

test('mapCouncilCategory maps council tags across all 9 canonical categories', () => {
  assert.equal(mapCouncilCategory('Volleyball'), 'sports');
  assert.equal(mapCouncilCategory('Martial Arts'), 'sports');
  assert.equal(mapCouncilCategory('Sport & Recreation'), 'sports');
  assert.equal(mapCouncilCategory('Health & Wellbeing'), 'health');
  assert.equal(mapCouncilCategory('Yoga & Mindfulness'), 'health');
  assert.equal(mapCouncilCategory('Arts & Culture'), 'arts');
  assert.equal(mapCouncilCategory('Exhibition'), 'arts');
  assert.equal(mapCouncilCategory('Music & Concerts'), 'music');
  assert.equal(mapCouncilCategory('Live Music'), 'music');
  assert.equal(mapCouncilCategory('Community'), 'community');
  assert.equal(mapCouncilCategory('Seniors'), 'community');
  assert.equal(mapCouncilCategory('Kids & Family'), 'family');
  assert.equal(mapCouncilCategory('School Holidays'), 'family');
  assert.equal(mapCouncilCategory('Childrens Program'), 'family');
  assert.equal(mapCouncilCategory('Food & Markets'), 'food');
  assert.equal(mapCouncilCategory('Cooking Class'), 'food');
  assert.equal(mapCouncilCategory('Craft & Hobbies'), 'hobbies');
  assert.equal(mapCouncilCategory('Gardening Workshop'), 'hobbies');
  assert.equal(mapCouncilCategory('Nature & Outdoors'), 'travel');
  assert.equal(mapCouncilCategory('Guided Walk & Tour'), 'travel');
  // Unrecognized generic council tag defaults to community rather than sports
  assert.equal(mapCouncilCategory('General'), 'community');
  assert.equal(mapCouncilCategory(''), 'community');
});

test('paginateCouncilPages enforces 20-page / 200-Activity caps and injectable inter-page delay', async () => {
  assert.equal(DEFAULT_MAX_PAGES, 20);
  assert.equal(DEFAULT_MAX_ACTIVITIES, 200);

  const delays = [];
  const pagesFetched = [];
  const result = await paginateCouncilPages({
    maxPages: 20,
    maxActivities: 200,
    pageDelayMs: 1200,
    delayFn: async (ms) => { delays.push(ms); },
    fetchPage: async (page) => {
      pagesFetched.push(page);
      // Return 15 items per page; 200 cap should stop after page 14 (14 * 15 = 210 -> sliced to 200)
      return {
        items: Array.from({ length: 15 }, (_, i) => ({ id: `p${page}_${i}` })),
        hasMore: true
      };
    }
  });

  assert.equal(result.length, 200);
  assert.equal(pagesFetched.length, 14);
  assert.equal(delays.length, 13);
  assert.ok(delays.every(d => d === 1200));

  // Verify 20-page cap when items per page are fewer
  const pages20 = [];
  const result20 = await paginateCouncilPages({
    delayFn: async () => {},
    fetchPage: async (page) => {
      pages20.push(page);
      return {
        items: [{ id: `p${page}` }],
        hasMore: true
      };
    }
  });
  assert.equal(pages20.length, 20);
  assert.equal(result20.length, 20);

  // Continues past an all-filtered page when hasMore is true
  const resultEmptyFirst = await paginateCouncilPages({
    delayFn: async () => {},
    fetchPage: async (page) => page === 1
      ? { items: [], hasMore: true }
      : { items: [{ id: 'p2_1' }], hasMore: false }
  });
  assert.deepEqual(resultEmptyFirst, [{ id: 'p2_1' }]);
});
