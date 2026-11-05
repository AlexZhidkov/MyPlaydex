import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDistanceKm,
  filterActivities,
  filterAndRankActivities,
  createDiscoveryStore
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

test('Integration: MOCK_PERTH_ACTIVITIES integrates with discovery store and filters properly', async () => {
  const { MOCK_PERTH_ACTIVITIES } = await import('../src/mock-perth-activities.js');
  const store = createDiscoveryStore(MOCK_PERTH_ACTIVITIES, {
    center: { lat: -31.9505, lng: 115.8605 },
    radiusKm: 10
  });

  const state = store.getState();
  assert.ok(state.filteredActivities.length > 0);
  assert.ok(state.filteredActivities.every((a) => a.distanceKm <= 10));

  // Filter for volleyball
  store.setFilter('sport', 'volleyball');
  const vbState = store.getState();
  assert.ok(vbState.filteredActivities.every((a) => a.sport === 'volleyball'));
});
