/**
 * Main Web Application Controller for MyPlaydex
 * Pure Vanilla JavaScript ES2022 module.
 * Implements Cold-Start Location Gate, Proximity Radius Controls,
 * Outbound Google Maps Navigation, and 1-tap empty state recovery.
 */

import { createDiscoveryStore } from './discovery-engine.js';
import { MOCK_PERTH_ACTIVITIES } from './mock-perth-activities.js';
import { searchSuburbs, getSuburbByPostcodeOrName } from './perth-centroids.js';
import { renderActivityCard, renderEmptyState, renderFilterView } from './discovery-ui.js';

const STORAGE_KEY_LOCATION = 'myplaydex_location';
const STORAGE_KEY_SPORTS = 'myplaydex_sports_filters';

/**
 * Reads persisted sport filters from localStorage.
 *
 * @returns {string[]} Array of selected sport subcategory slugs
 */
export function getSavedSportsFilters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SPORTS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item) => typeof item === 'string' && item.length > 0);
    }
  } catch (err) {
    console.warn('Failed to parse saved sports filters from localStorage:', err);
  }
  return [];
}

/**
 * Persists selected sport filters to localStorage.
 *
 * @param {string[]} sports Array of sport slugs
 */
export function saveSportsFilters(sports) {
  try {
    const sanitized = Array.isArray(sports)
      ? sports.filter((item) => typeof item === 'string' && item.length > 0)
      : [];
    localStorage.setItem(STORAGE_KEY_SPORTS, JSON.stringify(sanitized));
  } catch (err) {
    console.warn('Failed to save sports filters to localStorage:', err);
  }
}

/**
 * Clears saved sport filters from localStorage.
 */
export function clearSavedSportsFilters() {
  try {
    localStorage.removeItem(STORAGE_KEY_SPORTS);
  } catch (err) {
    console.warn('Failed to clear sports filters from localStorage:', err);
  }
}

/**
 * Reads the persisted location from localStorage.
 *
 * @returns {{ name: string, postcode?: string, lat: number, lng: number } | null}
 */
export function getSavedLocation() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_LOCATION);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.lat === 'number' && typeof parsed.lng === 'number') {
      return parsed;
    }
  } catch (err) {
    console.warn('Failed to parse saved location from localStorage:', err);
  }
  return null;
}

/**
 * Persists the selected location to localStorage.
 *
 * @param {{ name: string, postcode?: string, lat: number, lng: number }} location
 */
export function saveLocation(location) {
  try {
    localStorage.setItem(STORAGE_KEY_LOCATION, JSON.stringify(location));
  } catch (err) {
    console.warn('Failed to save location to localStorage:', err);
  }
}

/**
 * Initializes the discovery application.
 *
 * @param {object} [options={}]
 * @returns {object} Application context and store
 */
export function initApp(options = {}) {
  const initialActivities = options.activities || MOCK_PERTH_ACTIVITIES;
  const savedLocation = options.location !== undefined ? options.location : getSavedLocation();
  const savedSports = options.sports !== undefined ? options.sports : getSavedSportsFilters();

  const store = createDiscoveryStore({
    activities: initialActivities,
    location: savedLocation,
    radiusKm: options.radiusKm || 10,
    filters: {
      sports: savedSports
    },
    maxResults: 50
  });

  // DOM Elements
  const gateOverlay = document.getElementById('location-gate-overlay');
  const gateCloseBtn = document.getElementById('gate-close-btn');
  const locationSwitcherBtn = document.getElementById('location-switcher-btn');
  const currentLocationLabel = document.getElementById('current-location-label');
  const suburbInput = document.getElementById('suburb-search-input');
  const suggestionsList = document.getElementById('suburb-suggestions-list');
  const gpsBtn = document.querySelector('[data-action="use-gps"]');
  const radiusPills = document.querySelectorAll('.radius-pill');
  const feedContainer = document.getElementById('feed-container');
  const resultCountLabel = document.getElementById('result-count-label');
  const filterHeaderBtn = document.getElementById('filter-header-btn');
  const filterCountBadge = document.getElementById('filter-count-badge');
  const filterOverlay = document.getElementById('filter-view-overlay');

  let stagedSports = new Set(store.getState().filters.sports);

  function updateFilterHeaderUI(filters) {
    const sports = filters?.sports || [];
    const count = sports.length;
    if (filterHeaderBtn) {
      filterHeaderBtn.classList.toggle('active', count > 0);
      filterHeaderBtn.setAttribute('aria-pressed', count > 0 ? 'true' : 'false');
    }
    if (filterCountBadge) {
      filterCountBadge.textContent = String(count);
      filterCountBadge.classList.toggle('hidden', count === 0);
    }
  }

  function openFilterView() {
    if (!filterOverlay) return;
    stagedSports = new Set(store.getState().filters.sports);
    filterOverlay.innerHTML = renderFilterView(Array.from(stagedSports));
    filterOverlay.classList.remove('hidden');
    if (typeof window !== 'undefined' && window.location && window.location.hash !== '#filters') {
      if (window.history && typeof window.history.pushState === 'function') {
        window.history.pushState(null, '', '#filters');
      } else {
        window.location.hash = '#filters';
      }
    }
  }

  function closeFilterView() {
    if (!filterOverlay) return;
    filterOverlay.classList.add('hidden');
  }

  function returnToFeed() {
    closeFilterView();
    if (typeof window !== 'undefined' && window.location && window.location.hash === '#filters') {
      if (window.history && typeof window.history.back === 'function' && window.history.length > 1) {
        window.history.back();
      } else if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } else {
        window.location.hash = '';
      }
    }
  }

  function applySportsFilters(sportsList) {
    const sports = Array.isArray(sportsList) ? sportsList : Array.from(stagedSports);
    saveSportsFilters(sports);
    store.setSportsFilter(sports);
    returnToFeed();
  }

  function openLocationGate(canClose = false) {
    if (!gateOverlay) return;
    gateOverlay.classList.remove('hidden');
    if (gateCloseBtn) {
      gateCloseBtn.style.display = canClose ? 'flex' : 'none';
    }
    if (suburbInput) {
      suburbInput.value = '';
      renderSuggestions('');
    }
  }

  function closeLocationGate() {
    if (!gateOverlay) return;
    gateOverlay.classList.add('hidden');
  }

  function handleLocationSelected(location) {
    saveLocation(location);
    store.setLocation(location);
    closeLocationGate();
  }

  function renderSuggestions(query = '') {
    if (!suggestionsList) return;
    const matches = searchSuburbs(query, 6);
    if (matches.length === 0) {
      suggestionsList.classList.remove('visible');
      suggestionsList.innerHTML = '';
      return;
    }

    suggestionsList.innerHTML = matches.map((sub) => `
      <div class="suggestion-item" data-suburb="${sub.name}" role="option">
        <span class="suggestion-name">${sub.name}</span>
        <span class="suggestion-postcode">${sub.postcode}</span>
      </div>
    `).join('');
    suggestionsList.classList.add('visible');
  }

  // Bind Location Gate Event Handlers
  if (gpsBtn) {
    gpsBtn.addEventListener('click', () => {
      if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser. Please search for your suburb instead.');
        return;
      }
      gpsBtn.disabled = true;
      gpsBtn.textContent = '📍 Locating...';

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          gpsBtn.disabled = false;
          gpsBtn.textContent = '📍 Use My Current Location';
          handleLocationSelected({
            name: 'Near Me',
            lat: pos.coords.latitude,
            lng: pos.coords.longitude
          });
        },
        (err) => {
          gpsBtn.disabled = false;
          gpsBtn.textContent = '📍 Use My Current Location';
          console.warn('Geolocation error:', err);
          alert('Could not retrieve your location. Please select your suburb from the list.');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  if (suburbInput) {
    suburbInput.addEventListener('input', (e) => {
      renderSuggestions(e.target.value);
    });

    suburbInput.addEventListener('focus', () => {
      renderSuggestions(suburbInput.value);
    });
  }

  function selectSuburbByName(suburbName) {
    const found = getSuburbByPostcodeOrName(suburbName);
    if (found) {
      handleLocationSelected(found);
    }
  }

  // Click handler for autocomplete suggestions
  if (suggestionsList) {
    suggestionsList.addEventListener('click', (e) => {
      const item = e.target.closest('[data-suburb]');
      if (!item) return;
      selectSuburbByName(item.getAttribute('data-suburb'));
    });
  }

  // Quick preset chips in location gate
  document.addEventListener('click', (e) => {
    const presetBtn = e.target.closest('.chip-preset');
    if (presetBtn) {
      selectSuburbByName(presetBtn.getAttribute('data-suburb'));
    }
  });

  // Top header location switcher
  if (locationSwitcherBtn) {
    locationSwitcherBtn.addEventListener('click', () => {
      openLocationGate(Boolean(store.getState().location));
    });
  }

  if (gateCloseBtn) {
    gateCloseBtn.addEventListener('click', () => {
      if (store.getState().location) {
        closeLocationGate();
      }
    });
  }

  // Proximity Radius Pill Bar
  if (radiusPills && radiusPills.length > 0) {
    radiusPills.forEach((pill) => {
      pill.addEventListener('click', () => {
        const radiusVal = pill.getAttribute('data-radius');
        store.setRadius(radiusVal);
      });
    });
  }

  function updateRadiusPillsUI(activeRadius) {
    if (!radiusPills) return;
    radiusPills.forEach((pill) => {
      const val = pill.getAttribute('data-radius');
      const isMatch = val === 'all' ? activeRadius === 'all' : Number(val) === Number(activeRadius);
      pill.classList.toggle('active', isMatch);
    });
  }

  // Render Feed on Store Updates
  function renderFeed(state) {
    const { location, radiusKm, filteredActivities, filters } = state;

    // Header location text
    if (currentLocationLabel) {
      currentLocationLabel.textContent = location ? location.name : 'Set Location';
    }

    updateRadiusPillsUI(radiusKm);
    updateFilterHeaderUI(filters);

    if (!feedContainer) return;

    // If cold start without location
    if (!location) {
      openLocationGate(false);
      feedContainer.innerHTML = '';
      if (resultCountLabel) resultCountLabel.textContent = 'Set your location to find nearby sports';
      return;
    }

    closeLocationGate();

    const count = filteredActivities.length;
    const radiusLabel = radiusKm === 'all' ? 'All Greater Perth' : `${radiusKm} km`;
    if (resultCountLabel) {
      resultCountLabel.textContent = `Showing ${count} ${count === 1 ? 'activity' : 'activities'} within ${radiusLabel}`;
    }

    if (count === 0) {
      const hasSportFilters = Array.isArray(filters.sports) && filters.sports.length > 0;
      feedContainer.innerHTML = renderEmptyState({
        radiusKm,
        hasFilters: hasSportFilters
      });
      return;
    }

    feedContainer.innerHTML = filteredActivities.map(renderActivityCard).join('\n');
  }

  // Filter Header Button Handler
  if (filterHeaderBtn) {
    filterHeaderBtn.addEventListener('click', () => {
      openFilterView();
    });
  }

  // Filter View Modal Interaction Delegation
  if (filterOverlay) {
    filterOverlay.addEventListener('click', (e) => {
      // Sport chip toggle
      const chip = e.target.closest('[data-sport]');
      if (chip) {
        const sportSlug = chip.getAttribute('data-sport');
        if (stagedSports.has(sportSlug)) {
          stagedSports.delete(sportSlug);
          chip.classList.remove('active');
          chip.setAttribute('aria-checked', 'false');
        } else {
          stagedSports.add(sportSlug);
          chip.classList.add('active');
          chip.setAttribute('aria-checked', 'true');
        }
        return;
      }

      // Apply Filters
      const applyBtn = e.target.closest('[data-action="apply-filters"]');
      if (applyBtn) {
        applySportsFilters(Array.from(stagedSports));
        return;
      }

      // Clear All
      const clearBtn = e.target.closest('[data-action="clear-filters"]') || e.target.closest('[data-action="clear-all"]');
      if (clearBtn) {
        stagedSports.clear();
        clearSavedSportsFilters();
        store.setSportsFilter([]);
        const allChips = filterOverlay.querySelectorAll('[data-sport]');
        if (allChips && allChips.length > 0) {
          allChips.forEach((c) => {
            c.classList.remove('active');
            c.setAttribute('aria-checked', 'false');
          });
        }
        return;
      }

      // Close Button
      const closeBtn = e.target.closest('[data-action="close-filters"]');
      if (closeBtn) {
        returnToFeed();
        return;
      }
    });
  }

  // Browser Popstate / Hash Navigation Discipline
  function handleHashRouting() {
    if (typeof window !== 'undefined' && window.location) {
      if (window.location.hash === '#filters') {
        openFilterView();
      } else {
        closeFilterView(false);
      }
    }
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('popstate', handleHashRouting);
    window.addEventListener('hashchange', handleHashRouting);
  }

  // Empty state 1-tap recovery click handlers
  if (feedContainer) {
    feedContainer.addEventListener('click', (e) => {
      const expandBtn = e.target.closest('[data-action="expand-radius"]');
      if (expandBtn) {
        store.setRadius(25);
        return;
      }

      const clearFiltersBtn = e.target.closest('[data-action="clear-filters"]');
      if (clearFiltersBtn) {
        clearSavedSportsFilters();
        store.setSportsFilter([]);
        return;
      }
    });
  }

  // Close suggestions when clicking outside
  document.addEventListener('click', (e) => {
    if (suggestionsList && !suggestionsList.contains(e.target) && suburbInput && !suburbInput.contains(e.target)) {
      suggestionsList.classList.remove('visible');
    }
  });

  // Subscribe to store updates
  store.subscribe((state) => {
    renderFeed(state);
  });

  // Initial render & state hydration
  const initialState = store.getState();
  updateFilterHeaderUI(initialState.filters);
  if (!initialState.location) {
    openLocationGate(false);
  } else {
    renderFeed(initialState);
  }

  if (typeof window !== 'undefined' && window.location && window.location.hash === '#filters') {
    openFilterView();
  }

  return { store, openLocationGate, closeLocationGate, openFilterView, closeFilterView, applySportsFilters };
}

// Auto-bootstrap when loaded in browser environment
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initApp());
  } else {
    initApp();
  }
}
