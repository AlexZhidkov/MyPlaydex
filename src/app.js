/**
 * Main Web Application Controller for MyPlaydex
 * Pure Vanilla JavaScript ES2022 module.
 * Implements Cold-Start Location Gate, Proximity Radius Controls,
 * Outbound Google Maps Navigation, and 1-tap empty state recovery.
 */

import { createDiscoveryStore } from './discovery-engine.js';
import { MOCK_PERTH_ACTIVITIES } from './mock-perth-activities.js';
import { searchSuburbs, getSuburbByPostcodeOrName, getSuburbBySlugOrName, suburbNameToSlug, findNearestSuburb } from './perth-centroids.js';
import { renderActivityCard, renderEmptyState, renderFilterView, createSuggestActivityMailtoUrl } from './discovery-ui.js';

const STORAGE_KEY_LOCATION = 'myplaydex_location';
const STORAGE_KEY_SPORTS = 'myplaydex_sports_filters';

/**
 * Parses query parameters from window.location.search or given search string.
 *
 * @param {string} [search]
 * @returns {{ suburb: string | null, radius: number | 'all' | null, activity: string | null }}
 */
export function parseDiscoveryUrlParams(search) {
  const searchStr = search !== undefined
    ? search
    : (typeof window !== 'undefined' && window.location ? window.location.search : '');

  if (!searchStr) {
    return { suburb: null, radius: null, activity: null };
  }

  const params = new URLSearchParams(searchStr);
  const suburb = params.get('suburb') || null;
  const radiusRaw = params.get('radius');
  let radius = null;
  if (radiusRaw === 'all') {
    radius = 'all';
  } else if (radiusRaw !== null && radiusRaw !== '') {
    const num = Number(radiusRaw);
    if (!Number.isNaN(num) && num > 0) {
      radius = num;
    }
  }
  const activity = params.get('activity') || null;

  return { suburb, radius, activity };
}

/**
 * Updates URL search parameters using history.replaceState without adding history entries.
 *
 * @param {{ suburb?: string | null, radius?: number | string | null, activity?: string | null }} newParams
 */
export function syncUrlState(newParams = {}) {
  if (typeof window === 'undefined' || !window.location || !window.history || typeof window.history.replaceState !== 'function') {
    return;
  }

  const params = new URLSearchParams(window.location.search);

  if (newParams.suburb !== undefined) {
    if (newParams.suburb) {
      const resolved = getSuburbBySlugOrName(newParams.suburb);
      if (resolved) {
        params.set('suburb', suburbNameToSlug(resolved.name));
      } else {
        params.delete('suburb');
      }
    } else {
      params.delete('suburb');
    }
  }

  if (newParams.radius !== undefined) {
    if (newParams.radius) {
      params.set('radius', String(newParams.radius));
    } else {
      params.delete('radius');
    }
  }

  if (newParams.activity !== undefined) {
    if (newParams.activity) {
      params.set('activity', newParams.activity);
    } else {
      params.delete('activity');
    }
  }

  const qs = params.toString();
  const hash = window.location.hash || '';
  const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${hash}`;
  window.history.replaceState(null, '', newUrl);
}

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
  const urlParams = parseDiscoveryUrlParams();
  const initialActivities = options.activities || MOCK_PERTH_ACTIVITIES;

  let initialLocation = options.location !== undefined ? options.location : null;
  if (!initialLocation && urlParams.suburb) {
    initialLocation = getSuburbBySlugOrName(urlParams.suburb);
  }
  if (!initialLocation && options.location === undefined) {
    initialLocation = getSavedLocation();
  }

  const targetActivityId = options.activityId || urlParams.activity;
  let deepLinkedActivity = null;
  if (targetActivityId) {
    deepLinkedActivity = initialActivities.find((a) => a.id === targetActivityId) || null;
    if (!initialLocation && deepLinkedActivity) {
      const venue = deepLinkedActivity.venue || {};
      const coords = venue.coordinates || (venue.lat !== undefined && venue.lng !== undefined ? venue : null);
      if (coords && typeof coords.lat === 'number' && typeof coords.lng === 'number') {
        const nearestSuburb = findNearestSuburb(coords);
        initialLocation = {
          name: nearestSuburb ? nearestSuburb.name : (venue.name || 'Perth'),
          postcode: nearestSuburb ? nearestSuburb.postcode : undefined,
          lat: coords.lat,
          lng: coords.lng
        };
      }
    }
  }

  let initialRadius = options.radiusKm !== undefined ? options.radiusKm : 10;
  if (options.radiusKm === undefined && urlParams.radius !== null) {
    initialRadius = urlParams.radius;
  }

  const savedSports = options.sports !== undefined ? options.sports : getSavedSportsFilters();

  const store = createDiscoveryStore({
    activities: initialActivities,
    location: initialLocation,
    radiusKm: initialRadius,
    selectedActivityId: targetActivityId,
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
  const loadingLabel = document.getElementById('loading-label') || document.getElementById('result-count-label');
  const filterHeaderBtn = document.getElementById('filter-header-btn');
  const filterCountBadge = document.getElementById('filter-count-badge');
  const filterOverlay = document.getElementById('filter-view-overlay');
  const suggestHeaderBtn = document.getElementById('suggest-header-btn');

  if (suggestHeaderBtn) {
    suggestHeaderBtn.href = createSuggestActivityMailtoUrl();
  }

  function hideLoading() {
    if (loadingLabel) {
      loadingLabel.classList.add('hidden');
      loadingLabel.style.display = 'none';
    }
    const metaRow = typeof document !== 'undefined' && document.querySelector ? document.querySelector('.feed-meta-row') : null;
    if (metaRow) {
      metaRow.style.display = 'none';
    }
  }

  function showLoading(text = 'Loading activities...') {
    const metaRow = typeof document !== 'undefined' && document.querySelector ? document.querySelector('.feed-meta-row') : null;
    if (metaRow) {
      metaRow.style.display = '';
    }
    if (loadingLabel) {
      loadingLabel.textContent = text;
      loadingLabel.classList.remove('hidden');
      loadingLabel.style.display = '';
    }
  }

  let stagedSports = new Set(store.getState().filters.sports);
  let hasHandledDeepLink = false;

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
      hideLoading();
      return;
    }

    closeLocationGate();
    hideLoading();

    const count = filteredActivities.length;
    const radiusLabel = radiusKm === 'all' ? 'All Greater Perth' : `${radiusKm} km`;

    if (count === 0) {
      const hasSportFilters = Array.isArray(filters.sports) && filters.sports.length > 0;
      feedContainer.innerHTML = renderEmptyState({
        radiusKm,
        hasFilters: hasSportFilters
      });
      return;
    }

    feedContainer.innerHTML = filteredActivities.map(renderActivityCard).join('\n');

    if (targetActivityId && !hasHandledDeepLink) {
      hasHandledDeepLink = true;
      highlightAndScrollToActivity(targetActivityId);
    }
  }

  function highlightAndScrollToActivity(activityId) {
    if (!activityId || typeof document === 'undefined') return;
    const card = document.querySelector(`.activity-card[data-id="${activityId}"]`);
    if (card) {
      card.classList.add('highlight-pulse');
      if (typeof card.scrollIntoView === 'function') {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
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

  function openVerifiedCardUrl(card) {
    if (!card || card.classList?.contains('activity-card-unverified')) {
      return;
    }
    const url = card.dataset?.url || (card.getAttribute && card.getAttribute('data-url'));
    if (url && url !== '#' && typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  // Activity Feed Interaction Delegation (Empty State Recovery, Venue Map Directions, Card Navigation)
  if (feedContainer) {
    feedContainer.addEventListener('click', (e) => {
      // 1. Empty state 1-tap recovery click handlers
      const expandBtn = e.target.closest && e.target.closest('[data-action="expand-radius"]');
      if (expandBtn) {
        store.setRadius(25);
        return;
      }

      const clearFiltersBtn = e.target.closest && e.target.closest('[data-action="clear-filters"]');
      if (clearFiltersBtn) {
        clearSavedSportsFilters();
        store.setSportsFilter([]);
        return;
      }

      // 2. Venue row: Outbound Google Maps directions
      const venueRow = e.target.closest && e.target.closest('.card-venue-row');
      if (venueRow) {
        // If clicked outside the <a> tag (e.g. on 📍 icon or row padding), open directions in a new tab.
        // If clicked on the <a> link itself, native browser link behavior handles it.
        const isAnchor = Boolean(e.target.closest && e.target.closest('a'));
        if (!isAnchor) {
          const venueLink = venueRow.querySelector ? venueRow.querySelector('a.venue-name') : null;
          const directionsUrl = venueRow.dataset?.directionsUrl
            || (venueRow.getAttribute && venueRow.getAttribute('data-directions-url'))
            || (venueLink && (venueLink.getAttribute ? venueLink.getAttribute('href') : venueLink.href));
          if (directionsUrl && typeof window !== 'undefined' && typeof window.open === 'function') {
            window.open(directionsUrl, '_blank', 'noopener,noreferrer');
          }
        }
        return;
      }

      // 3. Other interactive links (e.g. Suggest an edit mailto link)
      if (e.target.closest && e.target.closest('a, button')) {
        return;
      }

      // 4. Activity card: whole-card click opens club/activity source_url in a new tab
      const card = e.target.closest && e.target.closest('.activity-card');
      if (card) {
        openVerifiedCardUrl(card);
        return;
      }
    });

    // Support keyboard accessibility (Enter key on focused activity card)
    feedContainer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const card = e.target.closest && e.target.closest('.activity-card');
        if (card && e.target === card) {
          openVerifiedCardUrl(card);
        }
      }
    });
  }

  // Close suggestions when clicking outside
  document.addEventListener('click', (e) => {
    if (suggestionsList && !suggestionsList.contains(e.target) && suburbInput && !suburbInput.contains(e.target)) {
      suggestionsList.classList.remove('visible');
    }
  });

  let lastSyncedLocationName = initialLocation ? initialLocation.name : null;
  let lastSyncedRadius = store.getState().radiusKm;

  // Subscribe to store updates
  store.subscribe((state) => {
    renderFeed(state);

    const currentLocationName = state.location ? state.location.name : null;
    const currentRadius = state.radiusKm;

    if (currentLocationName !== lastSyncedLocationName || currentRadius !== lastSyncedRadius) {
      lastSyncedLocationName = currentLocationName;
      lastSyncedRadius = currentRadius;
      const suburbSlug = currentLocationName && currentLocationName !== 'Near Me'
        ? suburbNameToSlug(currentLocationName)
        : null;
      syncUrlState({
        suburb: suburbSlug,
        radius: currentRadius
      });
    }
  });

  // Initial render & state hydration
  const initialState = store.getState();
  updateFilterHeaderUI(initialState.filters);
  if (!initialState.location) {
    openLocationGate(false);
  } else {
    renderFeed(initialState);
  }
  hideLoading();

  if (typeof window !== 'undefined' && window.location && window.location.hash === '#filters') {
    openFilterView();
  }

  return {
    store,
    openLocationGate,
    closeLocationGate,
    openFilterView,
    closeFilterView,
    applySportsFilters,
    highlightAndScrollToActivity,
    loadingLabel,
    hideLoading,
    showLoading
  };
}

// Auto-bootstrap when loaded in browser environment
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initApp());
  } else {
    initApp();
  }
}
