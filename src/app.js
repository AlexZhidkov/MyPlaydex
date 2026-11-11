/**
 * Main Web Application Controller for MyPlaydex
 * Pure Vanilla JavaScript ES2022 module.
 * Implements Cold-Start Location Gate, Proximity Radius Controls,
 * Outbound Google Maps Navigation, and 1-tap empty state recovery.
 */

import { createDiscoveryStore } from './discovery-engine.js';
import { MOCK_PERTH_ACTIVITIES } from './mock-perth-activities.js';
import { searchSuburbs, getSuburbByPostcodeOrName } from './perth-centroids.js';
import { renderActivityCard, renderEmptyState } from './discovery-ui.js';

const STORAGE_KEY_LOCATION = 'myplaydex_location';

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

  const store = createDiscoveryStore({
    activities: initialActivities,
    location: savedLocation,
    radiusKm: options.radiusKm || 10,
    filters: {
      sports: []
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
        store.clearFilters();
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

  // Initial render
  const initialState = store.getState();
  if (!initialState.location) {
    openLocationGate(false);
  } else {
    renderFeed(initialState);
  }

  return { store, openLocationGate, closeLocationGate };
}

// Auto-bootstrap when loaded in browser environment
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initApp());
  } else {
    initApp();
  }
}
