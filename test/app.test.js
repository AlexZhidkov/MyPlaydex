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
  const loadingLabel = createMockEl('loading-label', 'span');
  elements.set('result-count-label', loadingLabel);
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

test('Seam 2: URL query state synchronization (?suburb=...&radius=...) via history.replaceState and initial hydration', () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, val) => storage.set(key, String(val)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  };

  const domListeners = new Map();
  const elements = new Map();

  function createMockEl(id, tag = 'div', classes = []) {
    const classSet = new Set(classes);
    const listeners = new Map();
    let innerHTML = '';
    let textContent = '';
    const attrs = new Map();

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
      getAttribute: (name) => attrs.get(name) || null,
      setAttribute: (name, val) => attrs.set(name, String(val)),
      addEventListener: (type, cb) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(cb);
      },
      dispatchEvent: (e) => {
        const cbs = listeners.get(e.type) || [];
        cbs.forEach(cb => cb(e));
      },
      closest: (sel) => null,
      scrollIntoView: () => {}
    };
    elements.set(id, el);
    return el;
  }

  const gateOverlay = createMockEl('location-gate-overlay', 'div');
  const gateCloseBtn = createMockEl('gate-close-btn', 'button');
  const locationSwitcherBtn = createMockEl('location-switcher-btn', 'button');
  const currentLocationLabel = createMockEl('current-location-label', 'span');
  const suburbInput = createMockEl('suburb-search-input', 'input');
  const suggestionsList = createMockEl('suburb-suggestions-list', 'div');
  const feedContainer = createMockEl('feed-container', 'section');
  const loadingLabel = createMockEl('loading-label', 'span');
  elements.set('result-count-label', loadingLabel);
  const filterHeaderBtn = createMockEl('filter-header-btn', 'button');
  const filterCountBadge = createMockEl('filter-count-badge', 'span', ['hidden']);
  const filterOverlay = createMockEl('filter-view-overlay', 'div', ['hidden']);

  // Create radius pills
  const pill5 = createMockEl('pill-5', 'button');
  pill5.setAttribute('data-radius', '5');
  const pill10 = createMockEl('pill-10', 'button');
  pill10.setAttribute('data-radius', '10');
  const pill25 = createMockEl('pill-25', 'button');
  pill25.setAttribute('data-radius', '25');
  const pillAll = createMockEl('pill-all', 'button');
  pillAll.setAttribute('data-radius', 'all');

  const radiusPills = [pill5, pill10, pill25, pillAll];

  let replaceStateCalls = [];

  globalThis.window = {
    location: {
      hash: '',
      pathname: '/',
      search: '?suburb=cottesloe&radius=25'
    },
    history: {
      replaceState: (state, title, url) => {
        replaceStateCalls.push(url);
        const [pathAndSearch, hash] = url.split('#');
        const [path, search] = pathAndSearch.split('?');
        globalThis.window.location.search = search ? `?${search}` : '';
        globalThis.window.location.hash = hash ? `#${hash}` : '';
      },
      pushState: () => {},
      back: () => {}
    },
    addEventListener: (evt, cb) => {
      if (!domListeners.has(evt)) domListeners.set(evt, []);
      domListeners.get(evt).push(cb);
    }
  };

  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    querySelector: (sel) => null,
    querySelectorAll: (sel) => {
      if (sel === '.radius-pill') return radiusPills;
      return [];
    },
    addEventListener: (evt, cb) => {
      if (!domListeners.has(evt)) domListeners.set(evt, []);
      domListeners.get(evt).push(cb);
    }
  };

  const app = initApp({
    activities: [
      {
        id: 'act_cottesloe',
        title: 'Cottesloe Tennis',
        subcategory: 'tennis',
        venue: { name: 'Cottesloe Tennis Club', coordinates: { lat: -31.9934, lng: 115.7578 } },
        cost: { is_free: true }
      }
    ]
  });

  // Verify store initialized to Cottesloe and radius 25 from query parameters
  const state = app.store.getState();
  assert.ok(state.location, 'Location should be hydrated from ?suburb=cottesloe');
  assert.equal(state.location.name, 'Cottesloe');
  assert.equal(state.radiusKm, 25, 'Radius should be hydrated to 25 from ?radius=25');

  // Verify radius pill UI is updated
  assert.ok(pill25.classList.contains('active'), '25km pill should be active');
  assert.ok(!pill10.classList.contains('active'), '10km pill should not be active');

  // Verify changing radius triggers history.replaceState
  replaceStateCalls = [];
  app.store.setRadius(5);
  assert.ok(replaceStateCalls.length > 0, 'setRadius should invoke history.replaceState');
  const latestUrl = replaceStateCalls[replaceStateCalls.length - 1];
  assert.ok(latestUrl.includes('radius=5'), `URL should contain radius=5, got: ${latestUrl}`);
  assert.ok(latestUrl.includes('suburb=cottesloe'), `URL should preserve suburb=cottesloe, got: ${latestUrl}`);

  // Verify setting location triggers history.replaceState with new suburb slug
  replaceStateCalls = [];
  app.store.setLocation({ name: 'Scarborough', postcode: '6019', lat: -31.8942, lng: 115.7571 });
  assert.ok(replaceStateCalls.length > 0, 'setLocation should invoke history.replaceState');
  const scarbUrl = replaceStateCalls[replaceStateCalls.length - 1];
  assert.ok(scarbUrl.includes('suburb=scarborough'), `URL should contain suburb=scarborough, got: ${scarbUrl}`);
  assert.ok(scarbUrl.includes('radius=5'), `URL should preserve radius=5, got: ${scarbUrl}`);

  storage.clear();
});

test('Seam 3: Activity deep-linking (?activity=...), cold-start gate bypass, feed rendering, and highlight state', () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, val) => storage.set(key, String(val)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  };

  const domListeners = new Map();
  const elements = new Map();
  const scrolledElements = [];

  function createMockEl(id, tag = 'div', classes = []) {
    const classSet = new Set(classes);
    const listeners = new Map();
    let innerHTML = '';
    let textContent = '';
    const attrs = new Map();

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
      getAttribute: (name) => attrs.get(name) || null,
      setAttribute: (name, val) => attrs.set(name, String(val)),
      addEventListener: (type, cb) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(cb);
      },
      dispatchEvent: (e) => {
        const cbs = listeners.get(e.type) || [];
        cbs.forEach(cb => cb(e));
      },
      scrollIntoView: (options) => {
        scrolledElements.push({ el, options });
      }
    };
    elements.set(id, el);
    return el;
  }

  const gateOverlay = createMockEl('location-gate-overlay', 'div');
  const gateCloseBtn = createMockEl('gate-close-btn', 'button');
  const locationSwitcherBtn = createMockEl('location-switcher-btn', 'button');
  const currentLocationLabel = createMockEl('current-location-label', 'span');
  const feedContainer = createMockEl('feed-container', 'section');
  const loadingLabel = createMockEl('loading-label', 'span');
  elements.set('result-count-label', loadingLabel);
  const filterHeaderBtn = createMockEl('filter-header-btn', 'button');
  const filterCountBadge = createMockEl('filter-count-badge', 'span', ['hidden']);
  const filterOverlay = createMockEl('filter-view-overlay', 'div', ['hidden']);

  const targetCard = createMockEl('card-act_deep_target', 'article', ['activity-card']);
  targetCard.setAttribute('data-id', 'act_deep_target');

  globalThis.window = {
    location: {
      hash: '',
      pathname: '/',
      search: '?activity=act_deep_target'
    },
    history: {
      replaceState: () => {},
      pushState: () => {},
      back: () => {}
    },
    addEventListener: (evt, cb) => {
      if (!domListeners.has(evt)) domListeners.set(evt, []);
      domListeners.get(evt).push(cb);
    }
  };

  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    querySelector: (sel) => {
      if (sel && sel.includes('act_deep_target')) return targetCard;
      return null;
    },
    querySelectorAll: (sel) => [],
    addEventListener: (evt, cb) => {
      if (!domListeners.has(evt)) domListeners.set(evt, []);
      domListeners.get(evt).push(cb);
    }
  };

  const activities = [
    {
      id: 'act_deep_target',
      title: 'Target Volleyball Match',
      subcategory: 'volleyball',
      venue: {
        name: 'Wembley Sports Park',
        address: 'Selby St, Jolimont WA 6014',
        coordinates: { lat: -31.9450, lng: 115.8050 }
      },
      cost: { is_free: true }
    },
    {
      id: 'act_other',
      title: 'Other Game',
      subcategory: 'soccer',
      venue: {
        name: 'Perth City Field',
        coordinates: { lat: -31.9500, lng: 115.8600 }
      },
      cost: { is_free: true }
    }
  ];

  // Initialize app without any saved location (pure cold start with deep link)
  const app = initApp({
    activities
  });

  const state = app.store.getState();

  // 1. Location gate should be bypassed and closed
  assert.ok(gateOverlay.classList.contains('hidden'), 'Location gate should be hidden/bypassed on deep link');

  // 2. Store location initialized using target activity's venue coordinates
  assert.ok(state.location, 'Store location should be set from venue coordinates');
  assert.equal(state.location.lat, -31.9450);
  assert.equal(state.location.lng, 115.8050);

  // 3. Target activity is rendered in the feed
  assert.ok(feedContainer.innerHTML.includes('act_deep_target'), 'Feed HTML should contain the target activity');

  // 4. Target activity element received highlight pulse class
  assert.ok(
    targetCard.classList.contains('highlight-pulse'),
    'Target activity card must receive highlight-pulse class'
  );

  // 5. Target activity was scrolled into view
  assert.ok(scrolledElements.length > 0, 'Target card should have scrollIntoView called');
  assert.equal(scrolledElements[0].el, targetCard);

  storage.clear();
});

test('Loading label: displays "Loading activities..." initially, hides after loading finishes, and does not show count', () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, val) => storage.set(key, String(val)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  };

  const domListeners = new Map();
  const elements = new Map();

  function createMockEl(id, tag = 'div', classes = []) {
    const classSet = new Set(classes);
    const listeners = new Map();
    let innerHTML = '';
    let textContent = '';
    const attrs = new Map();

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
      getAttribute: (name) => attrs.get(name) || null,
      setAttribute: (name, val) => attrs.set(name, String(val)),
      addEventListener: (type, cb) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(cb);
      },
      dispatchEvent: (e) => {
        const cbs = listeners.get(e.type) || [];
        cbs.forEach(cb => cb(e));
      },
      closest: () => null,
      scrollIntoView: () => {}
    };
    elements.set(id, el);
    return el;
  }

  const gateOverlay = createMockEl('location-gate-overlay', 'div');
  const gateCloseBtn = createMockEl('gate-close-btn', 'button');
  const locationSwitcherBtn = createMockEl('location-switcher-btn', 'button');
  const currentLocationLabel = createMockEl('current-location-label', 'span');
  const feedContainer = createMockEl('feed-container', 'section');
  const loadingLabel = createMockEl('loading-label', 'span');
  loadingLabel.textContent = 'Loading activities...';
  const filterHeaderBtn = createMockEl('filter-header-btn', 'button');
  const filterCountBadge = createMockEl('filter-count-badge', 'span', ['hidden']);
  const filterOverlay = createMockEl('filter-view-overlay', 'div', ['hidden']);

  globalThis.window = {
    location: {
      hash: '',
      pathname: '/',
      search: ''
    },
    history: {
      replaceState: () => {},
      pushState: () => {},
      back: () => {}
    },
    addEventListener: (evt, cb) => {
      if (!domListeners.has(evt)) domListeners.set(evt, []);
      domListeners.get(evt).push(cb);
    }
  };

  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (evt, cb) => {
      if (!domListeners.has(evt)) domListeners.set(evt, []);
      domListeners.get(evt).push(cb);
    }
  };

  // 1. Initially, before initApp finishes, loading label has loading text and is not hidden
  assert.equal(loadingLabel.textContent, 'Loading activities...');
  assert.ok(!loadingLabel.classList.contains('hidden'), 'Label should not be hidden before initialization');

  // Initialize app
  const app = initApp({
    activities: [
      {
        id: 'act_1',
        title: 'Morning Yoga',
        subcategory: 'yoga',
        venue: {
          name: 'Perth Park',
          coordinates: { lat: -31.95, lng: 115.86 }
        },
        cost: { is_free: true }
      }
    ],
    location: { name: 'Perth', lat: -31.95, lng: 115.86 }
  });

  // 2. After loading is finished, label is hidden
  assert.ok(loadingLabel.classList.contains('hidden'), 'Loading label must have "hidden" class after loading finishes');
  assert.equal(loadingLabel.style.display, 'none', 'Loading label style.display must be "none"');

  // 3. Count is NOT displayed in the label
  assert.ok(!loadingLabel.textContent.includes('Showing'), 'Loading label must not contain result count text');
  assert.ok(!loadingLabel.textContent.includes('activities within'), 'Loading label must not contain count summary');

  // 4. Changing radius or filters should not reveal result count in the label
  app.store.setRadius(25);
  assert.ok(loadingLabel.classList.contains('hidden'), 'Loading label must remain hidden on store update');
  assert.ok(!loadingLabel.textContent.includes('Showing'), 'Loading label must not show count on radius change');

  // 5. Refactored helper controls work properly
  app.showLoading('Refreshing feed...');
  assert.ok(!loadingLabel.classList.contains('hidden'), 'showLoading should remove hidden class');
  assert.equal(loadingLabel.textContent, 'Refreshing feed...');
  assert.equal(loadingLabel.style.display, '');

  app.hideLoading();
  assert.ok(loadingLabel.classList.contains('hidden'), 'hideLoading should add hidden class');
  assert.equal(loadingLabel.style.display, 'none');

  storage.clear();
});

test('Seam 3: Activity card click delegates to source_url in new tab, and card-venue-row opens Google Maps directions', () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, val) => storage.set(key, String(val)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  };

  const domListeners = new Map();
  const elements = new Map();

  function createMockEl(id, tag = 'div', classes = []) {
    const classSet = new Set(classes);
    const listeners = new Map();
    let innerHTML = '';
    let textContent = '';
    const attrs = new Map();

    const el = {
      id,
      tagName: tag.toUpperCase(),
      style: {},
      dataset: {},
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
      getAttribute: (name) => attrs.get(name) || null,
      setAttribute: (name, val) => {
        attrs.set(name, String(val));
        if (name.startsWith('data-')) {
          const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          el.dataset[camel] = String(val);
        }
      },
      addEventListener: (type, cb) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(cb);
      },
      dispatchEvent: (e) => {
        const cbs = listeners.get(e.type) || [];
        cbs.forEach(cb => cb(e));
      },
      closest: () => null,
      scrollIntoView: () => {}
    };
    elements.set(id, el);
    return el;
  }

  const gateOverlay = createMockEl('location-gate-overlay', 'div');
  const gateCloseBtn = createMockEl('gate-close-btn', 'button');
  const locationSwitcherBtn = createMockEl('location-switcher-btn', 'button');
  const currentLocationLabel = createMockEl('current-location-label', 'span');
  const feedContainer = createMockEl('feed-container', 'section');
  const loadingLabel = createMockEl('loading-label', 'span');
  const filterHeaderBtn = createMockEl('filter-header-btn', 'button');
  const filterCountBadge = createMockEl('filter-count-badge', 'span', ['hidden']);
  const filterOverlay = createMockEl('filter-view-overlay', 'div', ['hidden']);

  const openedWindows = [];
  globalThis.window = {
    location: {
      hash: '',
      pathname: '/',
      search: ''
    },
    history: {
      replaceState: () => {},
      pushState: () => {},
      back: () => {}
    },
    open: (url, target, features) => {
      openedWindows.push({ url, target, features });
      return {};
    },
    addEventListener: (evt, cb) => {
      if (!domListeners.has(evt)) domListeners.set(evt, []);
      domListeners.get(evt).push(cb);
    }
  };

  globalThis.document = {
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (evt, cb) => {
      if (!domListeners.has(evt)) domListeners.set(evt, []);
      domListeners.get(evt).push(cb);
    }
  };

  const app = initApp({
    activities: [
      {
        id: 'act_tennis_1',
        title: 'Social Tennis Night',
        subcategory: 'tennis',
        venue: {
          name: 'Robertson Park Tennis Centre',
          address: 'Fitzgerald St, Perth',
          coordinates: { lat: -31.94, lng: 115.85 }
        },
        cost: { is_free: true },
        source_url: 'https://example.com/tennis-perth'
      }
    ],
    location: { name: 'Perth', lat: -31.95, lng: 115.86 }
  });

  const cardEl = createMockEl('card-act_tennis_1', 'article', ['activity-card']);
  cardEl.setAttribute('data-id', 'act_tennis_1');
  cardEl.setAttribute('data-url', 'https://example.com/tennis-perth');

  const venueRowEl = createMockEl('venue-row', 'div', ['card-venue-row']);
  const mapsUrl = 'https://www.google.com/maps/search/?api=1&query=Robertson+Park';
  venueRowEl.setAttribute('data-directions-url', mapsUrl);

  const venueAnchorEl = createMockEl('venue-link', 'a', ['venue-name']);
  venueAnchorEl.setAttribute('href', mapsUrl);
  venueRowEl.querySelector = (sel) => (sel.includes('venue-name') ? venueAnchorEl : null);

  const venueIconEl = createMockEl('venue-icon', 'span', ['venue-icon']);
  const suggestEditEl = createMockEl('edit-link', 'a', ['suggest-edit-link']);

  // Case 1: Clicking anywhere on the activity card opens source_url in a new tab
  openedWindows.length = 0;
  const cardTarget = {
    closest: (sel) => {
      if (sel.includes('card-venue-row')) return null;
      if (sel.includes('a, button')) return null;
      if (sel.includes('activity-card')) return cardEl;
      return null;
    }
  };
  feedContainer.dispatchEvent({ type: 'click', target: cardTarget });

  assert.equal(openedWindows.length, 1, 'Should trigger 1 window.open call for card click');
  assert.equal(openedWindows[0].url, 'https://example.com/tennis-perth');
  assert.equal(openedWindows[0].target, '_blank');
  assert.equal(openedWindows[0].features, 'noopener,noreferrer');

  // Case 2: Clicking on card-venue-row (e.g. pin icon or row padding) opens Google Maps
  openedWindows.length = 0;
  const venueIconTarget = {
    closest: (sel) => {
      if (sel.includes('card-venue-row')) return venueRowEl;
      if (sel === 'a') return null; // not an anchor
      if (sel.includes('activity-card')) return cardEl;
      return null;
    }
  };
  feedContainer.dispatchEvent({ type: 'click', target: venueIconTarget });

  assert.equal(openedWindows.length, 1, 'Should trigger 1 window.open call for venue row click');
  assert.equal(openedWindows[0].url, mapsUrl);
  assert.equal(openedWindows[0].target, '_blank');
  assert.equal(openedWindows[0].features, 'noopener,noreferrer');

  // Case 3: Clicking directly on the anchor inside card-venue-row does NOT trigger card navigation
  openedWindows.length = 0;
  const venueAnchorTarget = {
    closest: (sel) => {
      if (sel.includes('card-venue-row')) return venueRowEl;
      if (sel === 'a' || sel.includes('a, button')) return venueAnchorEl;
      if (sel.includes('activity-card')) return cardEl;
      return null;
    }
  };
  feedContainer.dispatchEvent({ type: 'click', target: venueAnchorTarget });
  assert.equal(openedWindows.length, 0, 'Click on venue anchor allows native anchor navigation without window.open call');

  // Case 4: Clicking on suggest-edit-link does NOT trigger card navigation
  openedWindows.length = 0;
  const editTarget = {
    closest: (sel) => {
      if (sel.includes('card-venue-row')) return null;
      if (sel.includes('a, button')) return suggestEditEl;
      if (sel.includes('activity-card')) return cardEl;
      return null;
    }
  };
  feedContainer.dispatchEvent({ type: 'click', target: editTarget });
  assert.equal(openedWindows.length, 0, 'Click on suggest-edit-link must not trigger card window.open');

  // Case 5: Pressing Enter on focused activity-card triggers source_url in a new tab
  openedWindows.length = 0;
  cardEl.closest = (sel) => (sel.includes('activity-card') ? cardEl : null);
  feedContainer.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    target: cardEl
  });

  assert.equal(openedWindows.length, 1, 'Pressing Enter on focused card should trigger window.open');
  assert.equal(openedWindows[0].url, 'https://example.com/tennis-perth');

  storage.clear();
});

