import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDistanceKm,
  filterActivities,
  filterAndRankActivities,
  filterOrganizers,
  filterVenues,
  filterAndRankOrganizers,
  filterAndRankVenues,
  filterAndRankListings,
  normalizeDiscoveryTab,
  createDiscoveryStore,
  resolveActivityDateTime,
  compareActivitiesByDateTime
} from '../src/discovery-engine.js';

const mockActivities = [
  {
    id: 'act_1',
    title: 'North Perth Social Futsal',
    sport: 'soccer',
    cost_description: '$10 per player',
    is_free: false,
    demographics: { gender: 'mixed', age: 'adults' },
    venue: { coordinates: { lat: -31.9366, lng: 115.8431 } }
  },
  {
    id: 'act_2',
    title: 'Scarborough Community Beach Volleyball',
    sport: 'volleyball',
    cost_description: 'Free',
    is_free: true,
    demographics: { gender: 'mixed', age: 'all' },
    venue: { coordinates: { lat: -31.8942, lng: 115.7571 } }
  },
  {
    id: 'act_3',
    title: 'Women Only Social Tennis Morning',
    sport: 'tennis',
    cost_description: 'Free court access',
    is_free: true,
    demographics: { gender: 'women', age: 'adults' },
    venue: { coordinates: { lat: -31.9750, lng: 115.8450 } }
  },
  {
    id: 'act_4',
    title: 'Kings Park Masters Walking Group (35+)',
    sport: 'walking',
    cost_description: 'Free',
    is_free: true,
    demographics: { gender: 'mixed', age: 'masters' },
    venue: { coordinates: { lat: -31.9610, lng: 115.8330 } }
  },
  {
    id: 'act_5',
    title: 'Perth Junior Basketball Clinic (<18)',
    sport: 'basketball',
    cost_description: 'Free',
    is_free: true,
    demographics: { gender: 'mixed', age: 'juniors' },
    venue: { coordinates: { lat: -31.9500, lng: 115.8600 } }
  }
];

test('Seam 1: calculates accurate Haversine distance between Perth coordinates', () => {
  const perthCbd = { lat: -31.9505, lng: 115.8605 };
  const fremantle = { lat: -32.0569, lng: 115.7439 };

  const distance = calculateDistanceKm(perthCbd, fremantle);

  // Exact Haversine distance is 16.15 km
  assert.equal(distance, 16.15);

  // Distance from a point to itself must be 0
  assert.equal(calculateDistanceKm(perthCbd, perthCbd), 0);
});

test('Seam 2: filters activities across sport, cost, gender, and age facets', () => {
  // Unfiltered returns all
  const all = filterActivities(mockActivities, {});
  assert.equal(all.length, 5);

  // Filter by sport
  const volleyball = filterActivities(mockActivities, { sport: 'volleyball' });
  assert.equal(volleyball.length, 1);
  assert.equal(volleyball[0].id, 'act_2');

  // Filter by freeOnly
  const freeOnly = filterActivities(mockActivities, { freeOnly: true });
  assert.equal(freeOnly.length, 4);
  assert.ok(freeOnly.every((a) => a.is_free));

  // Filter by gender: women only
  const womenOnly = filterActivities(mockActivities, { gender: 'women' });
  assert.equal(womenOnly.length, 1);
  assert.equal(womenOnly[0].id, 'act_3');

  // Filter by age group: juniors
  const juniors = filterActivities(mockActivities, { age: 'juniors' });
  // act_5 is juniors, and act_2 is 'all' (open to all including juniors)
  assert.equal(juniors.length, 2);
  assert.ok(juniors.some(a => a.id === 'act_5'));

  // Filter by age group: masters
  const masters = filterActivities(mockActivities, { age: 'masters' });
  // act_4 is masters, and act_2 is 'all'
  assert.equal(masters.length, 2);
  assert.ok(masters.some(a => a.id === 'act_4'));

  // Combined facets (freeOnly + tennis)
  const freeTennis = filterActivities(mockActivities, { sport: 'tennis', freeOnly: true });
  assert.equal(freeTennis.length, 1);
  assert.equal(freeTennis[0].id, 'act_3');
});

test('Seam 3: ranks activities by proximity and excludes items outside radius', () => {
  const perthCbd = { lat: -31.9505, lng: 115.8605 };

  // 1. Within 5 km radius: returns items in CBD, North Perth, Kings Park, South Perth
  const within5km = filterAndRankActivities(mockActivities, {
    center: perthCbd,
    radiusKm: 5
  });

  // act_5 is right at CBD (~0.07 km), act_1 is ~2.2 km, act_4 is ~2.8 km, act_3 is ~3.1 km
  assert.equal(within5km.length, 4);
  assert.equal(within5km[0].id, 'act_5'); // Closest
  assert.ok(within5km[0].distanceKm < within5km[1].distanceKm);
  assert.ok(within5km.every((a) => a.distanceKm <= 5));

  // 2. Within 15 km radius: includes Scarborough act_2 (~11.6 km)
  const within15km = filterAndRankActivities(mockActivities, {
    center: perthCbd,
    radiusKm: 15
  });
  assert.equal(within15km.length, 5);
  assert.equal(within15km[4].id, 'act_2'); // Furthest

  // 3. Combined facet filtering and radius slicing
  const freeTennisWithin5km = filterAndRankActivities(mockActivities, {
    center: perthCbd,
    radiusKm: 5,
    filters: { sport: 'tennis', freeOnly: true }
  });
  assert.equal(freeTennisWithin5km.length, 1);
  assert.equal(freeTennisWithin5km[0].id, 'act_3');
});

test('Seam 4: reactive discovery store notifies listeners on state updates and tracks hover/selection', () => {
  const store = createDiscoveryStore(mockActivities, {
    center: { lat: -31.9505, lng: 115.8605 },
    radiusKm: 5
  });

  const state0 = store.getState();
  assert.equal(state0.filteredActivities.length, 4);
  assert.equal(state0.radiusKm, 5);
  assert.equal(state0.hoveredActivityId, null);

  const events = [];
  const unsubscribe = store.subscribe((state, changeType) => {
    events.push({ changeType, count: state.filteredActivities.length });
  });

  // Change radius to 15km
  store.setRadius(15);
  assert.equal(store.getState().filteredActivities.length, 5);
  assert.equal(events.length, 1);
  assert.equal(events[0].changeType, 'radius');
  assert.equal(events[0].count, 5);

  // Filter by sport: volleyball
  store.setFilter('sport', 'volleyball');
  assert.equal(store.getState().filteredActivities.length, 1);
  assert.equal(events[1].changeType, 'filter');
  assert.equal(events[1].count, 1);

  // Hover sync
  store.setHoveredActivity('act_2');
  assert.equal(store.getState().hoveredActivityId, 'act_2');
  assert.equal(events[2].changeType, 'hover');

  // Selection sync
  store.setSelectedActivity('act_2');
  assert.equal(store.getState().selectedActivityId, 'act_2');
  assert.equal(events[3].changeType, 'select');

  // Unsubscribe stops listener notifications
  unsubscribe();
  store.setHoveredActivity(null);
  assert.equal(events.length, 4); // No new event recorded
});

test('Integration: MOCK_PERTH_ACTIVITIES conforms to canonical schema and integrates with discovery store', async () => {
  const { MOCK_PERTH_ACTIVITIES, PERTH_SPORTS_CATEGORIES } = await import('../src/mock-perth-activities.js');

  const validSubcategories = new Set([
    'soccer', 'volleyball', 'basketball', 'afl', 'tennis',
    'pickleball', 'running', 'social-fitness', 'walking', 'cricket', 'other'
  ]);

  // Check each activity conforms to canonical schema
  for (const item of MOCK_PERTH_ACTIVITIES) {
    assert.ok(item.id.startsWith('mock_'), `Expected id to start with mock_, got: ${item.id}`);
    assert.equal(item.region_id, 'perth');
    assert.equal(item.source, 'mock');
    assert.ok(item.source_id);
    assert.ok(item.source_url);
    assert.ok(item.title);
    assert.equal(item.category, 'sports');
    assert.ok(validSubcategories.has(item.subcategory), `Invalid subcategory: ${item.subcategory}`);
    assert.ok(item.venue.id.startsWith('venue_'));
    assert.equal(item.venue.geohash.length, 9);
    assert.ok(item.organizer.id.startsWith('org_'));
    assert.ok(item.organizer.name);
    assert.ok(item.schedule.start_date);
    assert.ok(['none', 'weekly'].includes(item.schedule.recurrence));
    assert.equal(typeof item.cost.is_free, 'boolean');
    assert.ok(item.cost.display_price);
    assert.ok(['all', 'women_only', 'men_only'].includes(item.demographics.gender));
    assert.ok(['all', 'adults', 'juniors', 'masters'].includes(item.demographics.age));
    assert.equal(item.verified, true);
  }

  const store = createDiscoveryStore(MOCK_PERTH_ACTIVITIES, {
    center: { lat: -31.9505, lng: 115.8605 },
    radiusKm: 10
  });

  const state = store.getState();
  assert.ok(state.filteredActivities.length > 0);
  assert.ok(state.filteredActivities.every((a) => a.distanceKm <= 10));

  // Filter for volleyball within 15 km
  store.setRadius(15);
  store.setFilter('sport', 'volleyball');
  const vbState = store.getState();
  assert.ok(vbState.filteredActivities.length > 0);
  assert.ok(vbState.filteredActivities.every((a) => a.subcategory === 'volleyball' || a.sport === 'volleyball'));
});

test('Seam 1: Discovery store supports cold-start location: null, numeric and "all" radius, and 50-item cap', () => {
  const manyActivities = Array.from({ length: 60 }, (_, i) => ({
    id: `act_${i}`,
    title: `Activity ${i}`,
    sport: 'soccer',
    subcategory: 'soccer',
    cost: { is_free: true, display_price: 'Free' },
    venue: {
      name: `Venue ${i}`,
      coordinates: {
        lat: -31.9505 + (i * 0.01), // spreading outwards north
        lng: 115.8605
      }
    },
    schedule: {
      start_date: '2026-11-01',
      end_date: null,
      recurrence: 'weekly'
    }
  }));

  // Cold start: location is null -> 0 activities
  const store = createDiscoveryStore({
    activities: manyActivities,
    location: null,
    radiusKm: 10,
    filters: { sports: [] },
    maxResults: 50
  });

  const coldState = store.getState();
  assert.equal(coldState.location, null);
  assert.equal(coldState.filteredActivities.length, 0);

  // Set location to Perth CBD
  store.setLocation({ name: 'Perth CBD', lat: -31.9505, lng: 115.8605 });
  const activeState = store.getState();
  assert.ok(activeState.location !== null);
  assert.ok(activeState.filteredActivities.length > 0);
  assert.ok(activeState.filteredActivities.every(a => typeof a.distanceKm === 'number'));
  assert.ok(activeState.filteredActivities.every(a => a.distanceKm <= 10));

  // Switch radius to 'all' -> distance cutoff removed, sorted nearest to furthest, capped at 50
  store.setRadius('all');
  const allState = store.getState();
  assert.equal(allState.radiusKm, 'all');
  assert.equal(allState.filteredActivities.length, 50); // Capped at maxResults: 50
  for (let i = 0; i < allState.filteredActivities.length - 1; i++) {
    assert.ok(allState.filteredActivities[i].distanceKm <= allState.filteredActivities[i + 1].distanceKm);
  }
});

test('Seam 1: Deterministic AWST expiration filters out expired one-off activities and keeps weekly recurring', () => {
  const testActivities = [
    {
      id: 'expired_one_off',
      title: 'Past One-off Workshop',
      subcategory: 'soccer',
      venue: { coordinates: { lat: -31.9505, lng: 115.8605 } },
      schedule: {
        start_date: '2026-11-01',
        end_date: '2026-11-05',
        recurrence: 'none'
      }
    },
    {
      id: 'active_one_off',
      title: 'Upcoming Tournament',
      subcategory: 'soccer',
      venue: { coordinates: { lat: -31.9505, lng: 115.8605 } },
      schedule: {
        start_date: '2026-11-20',
        end_date: '2026-11-22',
        recurrence: 'none'
      }
    },
    {
      id: 'weekly_recurring_past_start',
      title: 'Weekly Social Kickabout',
      subcategory: 'soccer',
      venue: { coordinates: { lat: -31.9505, lng: 115.8605 } },
      schedule: {
        start_date: '2025-01-01',
        end_date: null,
        recurrence: 'weekly'
      }
    }
  ];

  // Simulating today as 2026-11-11 in AWST
  const results = filterAndRankActivities(testActivities, {
    location: { lat: -31.9505, lng: 115.8605 },
    radiusKm: 25,
    todayAwst: '2026-11-11'
  });

  const ids = results.map(r => r.id);
  assert.ok(!ids.includes('expired_one_off'), 'expired_one_off should be excluded');
  assert.ok(ids.includes('active_one_off'), 'active_one_off should be included');
  assert.ok(ids.includes('weekly_recurring_past_start'), 'weekly_recurring_past_start should be included');
});

test('Seam 1: Multi-sport OR filtering matches any selected sport category', () => {
  const testActivities = [
    { id: '1', subcategory: 'soccer', venue: { coordinates: { lat: -31.95, lng: 115.86 } } },
    { id: '2', subcategory: 'volleyball', venue: { coordinates: { lat: -31.95, lng: 115.86 } } },
    { id: '3', subcategory: 'pickleball', venue: { coordinates: { lat: -31.95, lng: 115.86 } } }
  ];

  const store = createDiscoveryStore({
    activities: testActivities,
    location: { lat: -31.95, lng: 115.86 },
    filters: { sports: ['soccer', 'pickleball'] }
  });

  const state = store.getState();
  const ids = state.filteredActivities.map(a => a.id);
  assert.deepEqual(ids.sort(), ['1', '3']);

  // Clear filters
  store.setSportsFilter([]);
  assert.equal(store.getState().filteredActivities.length, 3);
});

test('Seam 1: store.subscribe supports targeted event subscriptions per spec.md §7.2', () => {
  const store = createDiscoveryStore({
    activities: [
      { id: '1', subcategory: 'soccer', venue: { coordinates: { lat: -31.95, lng: 115.86 } } }
    ],
    location: null
  });

  const locationEvents = [];
  store.subscribe('location', (state) => {
    locationEvents.push(state.location?.name);
  });

  const radiusEvents = [];
  store.subscribe('radius', (state) => {
    radiusEvents.push(state.radiusKm);
  });

  store.setLocation({ name: 'Perth', lat: -31.95, lng: 115.86 });
  assert.equal(locationEvents.length, 1);
  assert.equal(locationEvents[0], 'Perth');
  assert.equal(radiusEvents.length, 0);

  store.setRadius(25);
  assert.equal(locationEvents.length, 1);
  assert.equal(radiusEvents.length, 1);
  assert.equal(radiusEvents[0], 25);
});

test('Seam 1 (Issue #13): filterAndRankOrganizers and filterAndRankVenues match subcategories, bypass AWST expiration, rank by Haversine, and cap at 50', () => {
  const perthCbd = { lat: -31.9505, lng: 115.8605 };

  const organizers = [
    {
      id: 'org_multi',
      name: 'Perth Multi-Sport Club',
      subcategories: ['soccer', 'basketball'],
      subcategory: 'soccer',
      coordinates: { lat: -31.9450, lng: 115.8580 }, // ~0.65 km
      schedule: { end_date: '2020-01-01', recurrence: 'none' } // Past date must NOT expire organizers
    },
    {
      id: 'org_vb',
      name: 'Scarborough Volleyball Club',
      subcategories: ['volleyball'],
      coordinates: { lat: -31.8942, lng: 115.7571 } // ~11.6 km
    },
    {
      id: 'org_legacy_sport',
      name: 'South Perth Tennis Club',
      sport: 'tennis',
      coordinates: { lat: -31.9750, lng: 115.8450 } // ~3.1 km
    }
  ];

  // Multi-sport filter matches against subcategories array
  const basketballOrgs = filterAndRankOrganizers(organizers, {
    location: perthCbd,
    radiusKm: 25,
    filters: { sports: ['basketball'] },
    todayAwst: '2026-11-14'
  });
  assert.equal(basketballOrgs.length, 1);
  assert.equal(basketballOrgs[0].id, 'org_multi');
  assert.ok(typeof basketballOrgs[0].distanceKm === 'number');

  // Unfiltered within 5km includes org_multi and org_legacy_sport sorted by proximity, ignoring schedule expiration
  const within5km = filterAndRankOrganizers(organizers, {
    location: perthCbd,
    radiusKm: 5,
    todayAwst: '2026-11-14'
  });
  assert.deepEqual(within5km.map(o => o.id), ['org_multi', 'org_legacy_sport']);

  // Venues also ignore expiration and cap at 50 results
  const manyVenues = Array.from({ length: 65 }, (_, i) => ({
    id: `venue_${i}`,
    name: `Venue ${i}`,
    subcategories: i % 2 === 0 ? ['volleyball', 'pickleball'] : ['tennis'],
    coordinates: { lat: -31.9505 + i * 0.005, lng: 115.8605 },
    end_date: '2020-01-01'
  }));

  const rankedVenues = filterAndRankVenues(manyVenues, {
    location: perthCbd,
    radiusKm: 'all',
    todayAwst: '2026-11-14'
  });
  assert.equal(rankedVenues.length, 50);
  assert.equal(rankedVenues[0].id, 'venue_0');
  assert.ok(rankedVenues[0].distanceKm <= rankedVenues[1].distanceKm);

  const pickleballVenues = filterVenues(manyVenues, { sports: ['pickleball'] });
  assert.equal(pickleballVenues.length, 33);
  assert.equal(filterOrganizers(organizers, { sports: ['tennis'] }).length, 1);
  assert.equal(filterAndRankListings(manyVenues, { location: perthCbd, radiusKm: 'all', applyExpiration: false }).length, 50);
});

test('Seam 1 (Issue #13): Discovery store tracks activeTab, shares location/radius/filters across 3 collections, and pins deep-linked organizer/venue', () => {
  assert.equal(normalizeDiscoveryTab('organizers'), 'organizers');
  assert.equal(normalizeDiscoveryTab('venue'), 'venues');
  assert.equal(normalizeDiscoveryTab('unknown'), 'activities');

  const store = createDiscoveryStore({
    activities: [
      {
        id: 'act_1',
        title: 'Social Soccer',
        subcategory: 'soccer',
        venue: { coordinates: { lat: -31.9505, lng: 115.8605 } }
      }
    ],
    organizers: [
      {
        id: 'org_1',
        name: 'Perth Soccer Club',
        subcategories: ['soccer', 'social-fitness'],
        coordinates: { lat: -31.9510, lng: 115.8610 }
      },
      {
        id: 'org_far',
        name: 'Joondalup Volleyball Club',
        subcategories: ['volleyball'],
        coordinates: { lat: -31.7450, lng: 115.7660 } // ~24.5 km away
      }
    ],
    venues: [
      {
        id: 'venue_1',
        name: 'Langley Park',
        subcategories: ['soccer', 'afl'],
        coordinates: { lat: -31.9590, lng: 115.8690 }
      }
    ],
    activeTab: 'organizers',
    location: { name: 'Perth', lat: -31.9505, lng: 115.8605 },
    radiusKm: 10,
    selectedOrganizerId: 'org_far'
  });

  const initial = store.getState();
  assert.equal(initial.activeTab, 'organizers');
  // org_1 matches within 10km, org_far is pinned because selectedOrganizerId === 'org_far'
  assert.equal(initial.filteredOrganizers.length, 2);
  assert.equal(initial.filteredOrganizers[0].id, 'org_far');
  assert.equal(initial.filteredListings.length, 2);
  assert.equal(initial.filteredActivities.length, 1);
  assert.equal(initial.filteredVenues.length, 1);

  // Shared sports filter applies to active and other tabs alike
  store.setSportsFilter(['afl']);
  assert.equal(store.getState().filteredActivities.length, 0);
  assert.equal(store.getState().filteredVenues.length, 1);

  store.setTab('venues');
  const venueState = store.getState();
  assert.equal(venueState.activeTab, 'venues');
  assert.equal(venueState.filteredListings.length, 1);
  assert.equal(venueState.filteredListings[0].id, 'venue_1');

  // Updating organizers/venues collections via setters
  store.setOrganizers([
    { id: 'org_new', name: 'New Org', subcategories: ['afl'], coordinates: { lat: -31.95, lng: 115.86 } }
  ]);
  assert.equal(store.getState().organizers.length, 1);
  assert.equal(store.getState().filteredOrganizers.length, 1);

  store.setVenues([]);
  assert.equal(store.getState().filteredVenues.length, 0);
  store.setSelectedVenue('venue_new');
  assert.equal(store.getState().selectedVenueId, 'venue_new');
});

test('Seam 1 (Activity Ordering): resolveActivityDateTime accurately resolves one-off and weekly recurring dates and times', () => {
  const refDate = new Date(2026, 10, 14); // Saturday, 14 Nov 2026

  // 1. One-off event in the future
  const oneOff = {
    schedule: { start_date: '2026-11-18', start_time: '18:30', recurrence: 'none' }
  };
  const oneOffRes = resolveActivityDateTime(oneOff, refDate);
  assert.equal(oneOffRes.date, '2026-11-18');
  assert.equal(oneOffRes.time, '18:30');

  // 2. Weekly event on Saturday (today relative to refDate)
  const weeklySat = {
    schedule: { recurrence: 'weekly', day_of_week: 6, start_time: '09:00' }
  };
  const satRes = resolveActivityDateTime(weeklySat, refDate);
  assert.equal(satRes.date, '2026-11-14');
  assert.equal(satRes.time, '09:00');

  // 3. Weekly event on Sunday (tomorrow relative to refDate)
  const weeklySun = {
    schedule: { recurrence: 'weekly', day_of_week: 0, start_time: '08:00' }
  };
  const sunRes = resolveActivityDateTime(weeklySun, refDate);
  assert.equal(sunRes.date, '2026-11-15');
  assert.equal(sunRes.time, '08:00');

  // 4. Weekly event on Monday (in 2 days)
  const weeklyMon = {
    schedule: { recurrence: 'weekly', day_of_week: 1, start_time: '19:30' }
  };
  const monRes = resolveActivityDateTime(weeklyMon, refDate);
  assert.equal(monRes.date, '2026-11-16');
  assert.equal(monRes.time, '19:30');

  // 5. Undated activity
  const undated = { title: 'Pickup game' };
  const undatedRes = resolveActivityDateTime(undated, refDate);
  assert.equal(undatedRes.date, null);
  assert.equal(undatedRes.time, null);
});

test('Seam 2 (Activity Ordering): orders activities chronologically by date and time from earlier to later', () => {
  const perthCbd = { lat: -31.9505, lng: 115.8605 };
  const refDate = new Date(2026, 10, 14); // Saturday, 14 Nov 2026

  const activities = [
    {
      id: 'act_tue_night',
      title: 'Tuesday Futsal League',
      subcategory: 'soccer',
      venue: { coordinates: { lat: -31.9400, lng: 115.8500 } }, // ~1.5 km
      schedule: { recurrence: 'weekly', day_of_week: 2, start_time: '19:30' } // Tue 17 Nov, 19:30
    },
    {
      id: 'act_sun_afternoon',
      title: 'Sunday Afternoon Tennis',
      subcategory: 'tennis',
      venue: { coordinates: { lat: -31.9450, lng: 115.8550 } }, // ~0.8 km
      schedule: { recurrence: 'none', start_date: '2026-11-15', start_time: '14:00' } // Sun 15 Nov, 14:00
    },
    {
      id: 'act_sat_night',
      title: 'Saturday Night Social Volleyball',
      subcategory: 'volleyball',
      venue: { coordinates: { lat: -31.9366, lng: 115.8431 } }, // ~2.2 km
      schedule: { recurrence: 'weekly', day_of_week: 6, start_time: '19:00' } // Sat 14 Nov (today), 19:00
    },
    {
      id: 'act_sun_morn',
      title: 'Sunday Morning Run Club',
      subcategory: 'running',
      venue: { coordinates: { lat: -31.9600, lng: 115.8400 } }, // ~2.1 km
      schedule: { recurrence: 'weekly', day_of_week: 0, start_time: '08:30' } // Sun 15 Nov, 08:30
    },
    {
      id: 'act_mon_night',
      title: 'Monday Basketball Pick-up',
      subcategory: 'basketball',
      venue: { coordinates: { lat: -31.9500, lng: 115.8600 } }, // ~0.07 km (closest)
      schedule: { recurrence: 'weekly', day_of_week: 1, start_time: '18:30' } // Mon 16 Nov, 18:30
    },
    {
      id: 'act_undated',
      title: 'Casual Open Court',
      subcategory: 'pickleball',
      venue: { coordinates: { lat: -31.9505, lng: 115.8605 } } // at CBD, but undated
    }
  ];

  const ordered = filterAndRankActivities(activities, {
    location: perthCbd,
    radiusKm: 25,
    referenceDate: refDate,
    todayAwst: '2026-11-14'
  });

  const orderedIds = ordered.map((a) => a.id);
  // Expected order:
  // 1. act_sat_night: Sat 14 Nov 2026, 19:00 (earliest)
  // 2. act_sun_morn: Sun 15 Nov 2026, 08:30
  // 3. act_sun_afternoon: Sun 15 Nov 2026, 14:00
  // 4. act_mon_night: Mon 16 Nov 2026, 18:30
  // 5. act_tue_night: Tue 17 Nov 2026, 19:30
  // 6. act_undated: undated, placed after dated activities
  assert.deepEqual(orderedIds, [
    'act_sat_night',
    'act_sun_morn',
    'act_sun_afternoon',
    'act_mon_night',
    'act_tue_night',
    'act_undated'
  ]);
});

test('Seam 3 (Activity Ordering): breaks ties by proximity (distanceKm) when activities have identical dates and times', () => {
  const perthCbd = { lat: -31.9505, lng: 115.8605 };
  const refDate = new Date(2026, 10, 14);

  const activities = [
    {
      id: 'act_far',
      title: 'Far Beach Volleyball',
      subcategory: 'volleyball',
      venue: { coordinates: { lat: -31.8942, lng: 115.7571 } }, // ~11.6 km away
      schedule: { start_date: '2026-11-15', start_time: '09:00', recurrence: 'none' }
    },
    {
      id: 'act_near',
      title: 'Near Social Volleyball',
      subcategory: 'volleyball',
      venue: { coordinates: { lat: -31.9450, lng: 115.8580 } }, // ~0.65 km away
      schedule: { start_date: '2026-11-15', start_time: '09:00', recurrence: 'none' }
    }
  ];

  const ordered = filterAndRankActivities(activities, {
    location: perthCbd,
    radiusKm: 25,
    referenceDate: refDate,
    todayAwst: '2026-11-14'
  });

  assert.equal(ordered.length, 2);
  assert.equal(ordered[0].id, 'act_near');
  assert.equal(ordered[1].id, 'act_far');
  assert.ok(ordered[0].distanceKm < ordered[1].distanceKm);
});

test('Seam 4 (Activity Ordering): Discovery store delivers activities in chronological date/time order to subscribers', () => {
  const refDate = new Date(2026, 10, 14); // Sat 14 Nov 2026
  const perthCbd = { lat: -31.9505, lng: 115.8605 };

  const activities = [
    {
      id: 'act_monday',
      title: 'Monday Soccer',
      subcategory: 'soccer',
      venue: { coordinates: { lat: -31.9400, lng: 115.8500 } },
      schedule: { recurrence: 'weekly', day_of_week: 1, start_time: '18:00' } // Mon 16 Nov
    },
    {
      id: 'act_sunday',
      title: 'Sunday Soccer',
      subcategory: 'soccer',
      venue: { coordinates: { lat: -31.9600, lng: 115.8400 } },
      schedule: { recurrence: 'weekly', day_of_week: 0, start_time: '10:00' } // Sun 15 Nov
    }
  ];

  const store = createDiscoveryStore({
    activities,
    location: perthCbd,
    radiusKm: 10,
    referenceDate: refDate,
    todayAwst: '2026-11-14'
  });

  const state = store.getState();
  assert.equal(state.filteredActivities.length, 2);
  assert.equal(state.filteredActivities[0].id, 'act_sunday');
  assert.equal(state.filteredActivities[1].id, 'act_monday');
});



