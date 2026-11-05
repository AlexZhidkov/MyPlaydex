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
  }
];

test('Seam 1: calculates accurate Haversine distance between Perth coordinates', () => {
  // Perth CBD coordinates: -31.9505, 115.8605
  const perthCbd = { lat: -31.9505, lng: 115.8605 };
  // Fremantle Oval coordinates: -32.0569, 115.7439
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
  assert.equal(all.length, 4);

  // Filter by sport
  const volleyball = filterActivities(mockActivities, { sport: 'volleyball' });
  assert.equal(volleyball.length, 1);
  assert.equal(volleyball[0].id, 'act_2');

  // Filter by freeOnly
  const freeOnly = filterActivities(mockActivities, { freeOnly: true });
  assert.equal(freeOnly.length, 3);
  assert.ok(freeOnly.every((a) => a.is_free));

  // Filter by gender
  const womenOnly = filterActivities(mockActivities, { gender: 'women' });
  assert.equal(womenOnly.length, 1);
  assert.equal(womenOnly[0].id, 'act_3');

  // Filter by age group
  const masters = filterActivities(mockActivities, { age: 'masters' });
  assert.equal(masters.length, 1);
  assert.equal(masters[0].id, 'act_4');

  // Combined facets (freeOnly + tennis)
  const freeTennis = filterActivities(mockActivities, { sport: 'tennis', freeOnly: true });
  assert.equal(freeTennis.length, 1);
  assert.equal(freeTennis[0].id, 'act_3');
});

test('Seam 3: ranks activities by proximity and excludes items outside radius', () => {
  const perthCbd = { lat: -31.9505, lng: 115.8605 };

  // Center: Perth CBD.
  // act_1 (North Perth ~2.2 km)
  // act_4 (Kings Park ~2.8 km)
  // act_3 (South Perth/Como ~4.7 km)
  // act_2 (Scarborough ~11.5 km)

  // 1. Within 5 km radius: should return act_1, act_4, act_3, but NOT act_2
  const within5km = filterAndRankActivities(mockActivities, {
    center: perthCbd,
    radiusKm: 5,
    sortBy: 'distance'
  });

  assert.equal(within5km.length, 3);
  assert.equal(within5km[0].id, 'act_1'); // Closest
  assert.ok(within5km[0].distanceKm < within5km[1].distanceKm);
  assert.ok(within5km.every((a) => a.distanceKm <= 5));

  // 2. Within 15 km radius: includes act_2
  const within15km = filterAndRankActivities(mockActivities, {
    center: perthCbd,
    radiusKm: 15,
    sortBy: 'distance'
  });
  assert.equal(within15km.length, 4);
  assert.equal(within15km[3].id, 'act_2'); // Furthest

  // 3. Combined facet filtering and radius slicing
  const freeWithin5km = filterAndRankActivities(mockActivities, {
    center: perthCbd,
    radiusKm: 5,
    sortBy: 'distance',
    filters: { freeOnly: true }
  });
  assert.equal(freeWithin5km.length, 2); // act_4 and act_3 (act_1 is not free)
});

test('Seam 4: reactive discovery store notifies listeners on state updates and tracks hover/selection', () => {
  const store = createDiscoveryStore(mockActivities, {
    center: { lat: -31.9505, lng: 115.8605 },
    radiusKm: 5
  });

  const state0 = store.getState();
  assert.equal(state0.filteredActivities.length, 3);
  assert.equal(state0.radiusKm, 5);
  assert.equal(state0.hoveredActivityId, null);

  const events = [];
  const unsubscribe = store.subscribe((state, changeType) => {
    events.push({ changeType, count: state.filteredActivities.length });
  });

  // Change radius to 15km
  store.setRadius(15);
  assert.equal(store.getState().filteredActivities.length, 4);
  assert.equal(events.length, 1);
  assert.equal(events[0].changeType, 'radius');
  assert.equal(events[0].count, 4);

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
