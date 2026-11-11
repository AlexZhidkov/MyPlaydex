import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getSavedLocation,
  saveLocation,
  getSavedSportsFilters,
  saveSportsFilters,
  clearSavedSportsFilters,
  initApp
} from '../src/app.js';

test('App Storage: saveLocation and getSavedLocation persist and retrieve valid coordinates', () => {
  // Mock localStorage in Node
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, val) => storage.set(key, String(val)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  };

  assert.equal(getSavedLocation(), null);

  const loc = { name: 'Scarborough', postcode: '6019', lat: -31.8942, lng: 115.7571 };
  saveLocation(loc);

  const retrieved = getSavedLocation();
  assert.ok(retrieved);
  assert.equal(retrieved.name, 'Scarborough');
  assert.equal(retrieved.lat, -31.8942);
  assert.equal(retrieved.lng, 115.7571);

  // Clean up
  storage.clear();
});

test('Seam B: saveSportsFilters, getSavedSportsFilters, and clearSavedSportsFilters handle persistence and corruption', () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, val) => storage.set(key, String(val)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  };

  // Initially empty array
  assert.deepEqual(getSavedSportsFilters(), []);

  // Persist sports filters
  saveSportsFilters(['volleyball', 'pickleball']);
  assert.deepEqual(getSavedSportsFilters(), ['volleyball', 'pickleball']);

  // Clear filters
  clearSavedSportsFilters();
  assert.deepEqual(getSavedSportsFilters(), []);

  // Corrupted / invalid storage values return safe empty array
  storage.set('myplaydex_sports_filters', 'not-json');
  assert.deepEqual(getSavedSportsFilters(), []);

  storage.set('myplaydex_sports_filters', JSON.stringify({ invalid: 'object' }));
  assert.deepEqual(getSavedSportsFilters(), []);

  storage.set('myplaydex_sports_filters', JSON.stringify([123, null, 'soccer']));
  assert.deepEqual(getSavedSportsFilters(), ['soccer']);

  // Clean up
  storage.clear();
});

test('Seam C: Hash Router & Application Controller Integration (/#filters, persistence, header active state)', () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, val) => storage.set(key, String(val)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  };

  // Seed localStorage with 'volleyball'
  saveSportsFilters(['volleyball']);

  // Minimal window/document DOM mock
  const domListeners = new Map();
  const elements = new Map();

  function createMockEl(id, tag = 'div', classes = []) {
    const classSet = new Set(classes);
    const listeners = new Map();
    let innerHTML = '';
    let textContent = '';

    const el = {
      id,
      tagName: tag.toUpperCase(),
      style: {},
      get innerHTML() { return innerHTML; },
      set innerHTML(val) { innerHTML = val; },
      get textContent() { return textContent; },
      set textContent(val) { textContent = val; },
      classList: {
        add: (...c) => c.forEach(name => classSet.add(name)),
        remove: (...c) => c.forEach(name => classSet.delete(name)),
        toggle: (name, force) => {
          if (force === undefined) {
            classSet.has(name) ? classSet.delete(name) : classSet.add(name);
          } else if (force) {
            classSet.add(name);
          } else {
            classSet.delete(name);
          }
        },
        contains: (name) => classSet.has(name)
      },
      getAttribute: (name) => null,
      setAttribute: (name, val) => {},
      addEventListener: (type, cb) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(cb);
      },
      dispatchEvent: (e) => {
        const cbs = listeners.get(e.type) || [];
        cbs.forEach(cb => cb(e));
      }
    };
    elements.set(id, el);
    return el;
  }

  const filterHeaderBtn = createMockEl('filter-header-btn', 'button');
  const filterCountBadge = createMockEl('filter-count-badge', 'span', ['hidden']);
  const filterOverlay = createMockEl('filter-view-overlay', 'div', ['hidden']);
  const locationGateOverlay = createMockEl('location-gate-overlay', 'div', ['hidden']);
  const feedContainer = createMockEl('feed-container', 'section');
  const resultCountLabel = createMockEl('result-count-label', 'span');
  const currentLocationLabel = createMockEl('current-location-label', 'span');

  let currentHash = '';
  const historyEntries = [];

  globalThis.window = {
    location: {
      get hash() { return currentHash; },
      set hash(val) {
        currentHash = val;
        const listeners = domListeners.get('hashchange') || [];
        listeners.forEach(cb => cb({ type: 'hashchange' }));
      },
      pathname: '/',
      search: ''
    },
    history: {
      get length() { return historyEntries.length + 1; },
      pushState: (state, title, url) => {
        historyEntries.push(url);
        if (url.includes('#')) {
          currentHash = '#' + url.split('#')[1];
        } else {
          currentHash = '';
        }
      },
      replaceState: (state, title, url) => {
        if (url.includes('#')) {
          currentHash = '#' + url.split('#')[1];
        } else {
          currentHash = '';
        }
      },
      back: () => {
        currentHash = '';
        const listeners = domListeners.get('popstate') || [];
        listeners.forEach(cb => cb({ type: 'popstate' }));
      }
    },
    addEventListener: (evt, cb) => {
      if (!domListeners.has(evt)) domListeners.set(evt, []);
      domListeners.get(evt).push(cb);
    },
    dispatchEvent: (e) => {
      const cbs = domListeners.get(e.type) || [];
      cbs.forEach(cb => cb(e));
    }
  };

  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    querySelector: (sel) => {
      if (sel === '#filter-header-btn') return filterHeaderBtn;
      return null;
    },
    querySelectorAll: (sel) => [],
    addEventListener: (evt, cb) => {
      if (!domListeners.has(evt)) domListeners.set(evt, []);
      domListeners.get(evt).push(cb);
    }
  };

  const mockActivities = [
    {
      id: 'vb_1',
      title: 'Beach Volleyball',
      subcategory: 'volleyball',
      venue: { coordinates: { lat: -31.95, lng: 115.86 } },
      cost: { is_free: true }
    },
    {
      id: 'soc_1',
      title: 'Social Soccer',
      subcategory: 'soccer',
      venue: { coordinates: { lat: -31.95, lng: 115.86 } },
      cost: { is_free: true }
    }
  ];

  // Initialize app with saved volleyball filter and mock location
  const app = initApp({
    activities: mockActivities,
    location: { name: 'Perth CBD', lat: -31.95, lng: 115.86 }
  });

  // 1. Initial State: volleyball filter hydrated, header button is active, count is 1
  assert.equal(filterHeaderBtn.classList.contains('active'), true, 'Filter header button should be active');
  assert.equal(filterCountBadge.classList.contains('hidden'), false, 'Filter count badge should be visible');
  assert.equal(filterCountBadge.textContent, '1', 'Badge count should show 1');

  // Only volleyball activity matches
  const state1 = app.store.getState();
  assert.deepEqual(state1.filters.sports, ['volleyball']);
  assert.equal(state1.filteredActivities.length, 1);
  assert.equal(state1.filteredActivities[0].subcategory, 'volleyball');

  // 2. Tapping header filter button opens filter view and navigates to /#filters
  assert.equal(typeof app.openFilterView, 'function', 'app should expose openFilterView');
  app.openFilterView();
  assert.equal(filterOverlay.classList.contains('hidden'), false, 'Filter overlay should be visible');
  assert.equal(globalThis.window.location.hash, '#filters', 'Hash should be #filters');

  // 3. Native Back button smoothly closes filter view
  globalThis.window.history.back();
  assert.equal(filterOverlay.classList.contains('hidden'), true, 'Filter overlay should close on back navigation');
  assert.equal(globalThis.window.location.hash, '', 'Hash should be reset on back');

  // 4. Apply Filters updates store and persists to localStorage
  app.openFilterView();
  // Simulate applying soccer + volleyball
  app.applySportsFilters(['soccer', 'volleyball']);
  assert.deepEqual(getSavedSportsFilters(), ['soccer', 'volleyball'], 'LocalStorage should persist updated filters');
  assert.equal(filterHeaderBtn.classList.contains('active'), true);
  assert.equal(filterCountBadge.textContent, '2');

  // 5. Empty-state "clear-filters" resets filters and localStorage
  const clearTarget = {
    closest: (sel) => sel.includes('clear-filters') ? clearTarget : null
  };
  feedContainer.dispatchEvent({ type: 'click', target: clearTarget });
  assert.deepEqual(getSavedSportsFilters(), [], 'LocalStorage sports filters should be cleared');
  assert.deepEqual(app.store.getState().filters.sports, [], 'Store sports filters should be empty');
  assert.equal(filterHeaderBtn.classList.contains('active'), false, 'Header button active class should be removed');
  assert.equal(filterCountBadge.classList.contains('hidden'), true, 'Badge should be hidden');

  // Clean up
  storage.clear();
});

