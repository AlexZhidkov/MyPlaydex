/**
 * Main Web Application Controller for MyPlaydex
 * Pure Vanilla JavaScript ES2022 module.
 * Implements Cold-Start Location Gate, Proximity Radius Controls,
 * Outbound Google Maps Navigation, and 1-tap empty state recovery.
 */

import { createDiscoveryStore, extractListingCoordinates, normalizeDiscoveryTab } from './discovery-engine.js';
import { searchSuburbs, getSuburbByPostcodeOrName, getSuburbBySlugOrName, suburbNameToSlug, findNearestSuburb } from './perth-centroids.js';
import {
  renderActivityCard,
  renderOrganizerCard,
  renderVenueCard,
  renderEmptyState,
  renderFilterView,
  createSuggestActivityMailtoUrl
} from './discovery-ui.js';

const STORAGE_KEY_LOCATION = 'myplaydex_location';
const STORAGE_KEY_SPORTS = 'myplaydex_sports_filters';

export const DEFAULT_FIREBASE_PROJECT_ID = 'myplaydex';
export const DEFAULT_FIRESTORE_COLLECTION = 'activities';
export const DEFAULT_ORGANIZERS_COLLECTION = 'organizers';
export const DEFAULT_VENUES_COLLECTION = 'venues';
export const DEFAULT_FIRESTORE_PAGE_SIZE = 50;

/**
 * Unwraps a single Cloud Firestore REST API typed value into a plain JavaScript primitive/object.
 *
 * @param {object} valObj
 * @returns {*}
 */
export function unwrapFirestoreValue(valObj) {
  if (!valObj || typeof valObj !== 'object') {
    return valObj;
  }
  if ('nullValue' in valObj) return null;
  if ('booleanValue' in valObj) return Boolean(valObj.booleanValue);
  if ('stringValue' in valObj) return String(valObj.stringValue);
  if ('integerValue' in valObj) return Number(valObj.integerValue);
  if ('doubleValue' in valObj) return Number(valObj.doubleValue);
  if ('timestampValue' in valObj) return String(valObj.timestampValue);
  if ('referenceValue' in valObj) return String(valObj.referenceValue);
  if ('geoPointValue' in valObj) {
    const geo = valObj.geoPointValue || {};
    return {
      lat: Number(geo.latitude ?? geo.lat ?? 0),
      lng: Number(geo.longitude ?? geo.lng ?? 0)
    };
  }
  if ('arrayValue' in valObj) {
    const values = valObj.arrayValue?.values;
    return Array.isArray(values) ? values.map(unwrapFirestoreValue) : [];
  }
  if ('mapValue' in valObj) {
    const fields = valObj.mapValue?.fields || {};
    const result = {};
    for (const [k, v] of Object.entries(fields)) {
      result[k] = unwrapFirestoreValue(v);
    }
    return result;
  }
  return valObj;
}

/**
 * Parses a Firestore REST document object into a canonical Activity object.
 *
 * @param {object} doc
 * @returns {object | null}
 */
export function parseFirestoreDocument(doc) {
  if (!doc || typeof doc !== 'object') return null;

  // If already a plain listing object (e.g., from SDK or pre-parsed JSON)
  if (!doc.fields && (doc.id || doc.title || (doc.name && !String(doc.name).startsWith('projects/')))) {
    return { ...doc };
  }

  const fields = doc.fields || {};
  const parsed = {};
  for (const [key, valObj] of Object.entries(fields)) {
    parsed[key] = unwrapFirestoreValue(valObj);
  }

  if (!parsed.id && typeof doc.name === 'string') {
    const segments = doc.name.split('/');
    parsed.id = segments[segments.length - 1];
  }

  return parsed;
}

/**
 * Fetches up to 50 documents from a public Cloud Firestore collection in a single request.
 * Supports injected `db` instance (SDK `.limit(50).get()`) or public Firestore REST v1 endpoint (`pageSize=50` without pagination loops).
 *
 * @param {object} [options={}]
 * @param {object} [options.db] - Optional Firestore instance with collection(name)
 * @param {Function} [options.fetchImpl] - Fetch implementation (defaults to globalThis.fetch)
 * @param {string} [options.projectId=DEFAULT_FIREBASE_PROJECT_ID] - Firebase project ID
 * @param {string} [options.collectionName=DEFAULT_FIRESTORE_COLLECTION] - Collection name
 * @param {number} [options.pageSize=DEFAULT_FIRESTORE_PAGE_SIZE] - Page size capped at 50
 * @returns {Promise<Array<object>>}
 */
export async function fetchCollectionFromFirestore(options = {}) {
  const {
    db = null,
    fetchImpl = typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
      ? globalThis.fetch.bind(globalThis)
      : null,
    projectId = DEFAULT_FIREBASE_PROJECT_ID,
    collectionName = DEFAULT_FIRESTORE_COLLECTION,
    pageSize = DEFAULT_FIRESTORE_PAGE_SIZE
  } = options;

  const limit = Math.min(Math.max(1, Number(pageSize) || DEFAULT_FIRESTORE_PAGE_SIZE), DEFAULT_FIRESTORE_PAGE_SIZE);

  // 1. If a Firestore DB instance is provided (e.g. Firebase SDK or test double)
  if (db && typeof db.collection === 'function') {
    const colRef = db.collection(collectionName);
    const query = typeof colRef.limit === 'function' ? colRef.limit(limit) : colRef;
    const snapshot = await query.get();
    const docs = snapshot?.docs || [];
    return docs.slice(0, limit).map((doc) => {
      const data = typeof doc.data === 'function' ? doc.data() : doc;
      return { id: doc.id, ...data };
    });
  }

  // 2. Otherwise query the Cloud Firestore v1 REST API in a single capped request
  if (typeof fetchImpl !== 'function') {
    return [];
  }

  const baseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodeURIComponent(collectionName)}`;
  const url = new URL(baseUrl);
  url.searchParams.set('pageSize', String(limit));

  const response = await fetchImpl(url.toString());
  if (!response || !response.ok) {
    const status = response ? response.status : 'unknown';
    throw new Error(`Failed to fetch /${collectionName} from Firestore (HTTP ${status})`);
  }

  const payload = await response.json();
  const documents = Array.isArray(payload?.documents) ? payload.documents : [];
  const records = [];
  for (const doc of documents) {
    const parsed = parseFirestoreDocument(doc);
    if (parsed) {
      records.push(parsed);
      if (records.length >= limit) {
        break;
      }
    }
  }

  return records;
}

/**
 * Fetches up to 50 activity documents from `/activities`.
 *
 * @param {object} [options={}]
 * @returns {Promise<Array<object>>}
 */
export function fetchActivitiesFromFirestore(options = {}) {
  return fetchCollectionFromFirestore({
    ...options,
    collectionName: options.collectionName || DEFAULT_FIRESTORE_COLLECTION
  });
}

/**
 * Fetches up to 50 organizer documents from `/organizers`.
 *
 * @param {object} [options={}]
 * @returns {Promise<Array<object>>}
 */
export function fetchOrganizersFromFirestore(options = {}) {
  return fetchCollectionFromFirestore({
    ...options,
    collectionName: options.organizersCollectionName || options.collectionName || DEFAULT_ORGANIZERS_COLLECTION
  });
}

/**
 * Fetches up to 50 venue documents from `/venues`.
 *
 * @param {object} [options={}]
 * @returns {Promise<Array<object>>}
 */
export function fetchVenuesFromFirestore(options = {}) {
  return fetchCollectionFromFirestore({
    ...options,
    collectionName: options.venuesCollectionName || options.collectionName || DEFAULT_VENUES_COLLECTION
  });
}

/**
 * Parses query parameters from window.location.search or given search string.
 *
 * @param {string} [search]
 * @returns {{ tab: string | null, suburb: string | null, radius: number | 'all' | null, activity: string | null, organizer: string | null, venue: string | null }}
 */
export function parseDiscoveryUrlParams(search) {
  const searchStr = search !== undefined
    ? search
    : (typeof window !== 'undefined' && window.location ? window.location.search : '');

  if (!searchStr) {
    return { tab: null, suburb: null, radius: null, activity: null, organizer: null, venue: null };
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
  const organizer = params.get('organizer') || null;
  const venue = params.get('venue') || null;

  const rawTab = params.get('tab');
  let tab = null;
  if (rawTab === 'activities' || rawTab === 'organizers' || rawTab === 'venues') {
    tab = rawTab;
  } else if (venue) {
    tab = 'venues';
  } else if (organizer) {
    tab = 'organizers';
  } else if (activity) {
    tab = 'activities';
  }

  return { tab, suburb, radius, activity, organizer, venue };
}

/**
 * Updates URL search parameters using history.replaceState without adding history entries.
 *
 * @param {{ tab?: string | null, suburb?: string | null, radius?: number | string | null, activity?: string | null, organizer?: string | null, venue?: string | null }} newParams
 */
export function syncUrlState(newParams = {}) {
  if (typeof window === 'undefined' || !window.location || !window.history || typeof window.history.replaceState !== 'function') {
    return;
  }

  const params = new URLSearchParams(window.location.search);

  if (newParams.tab !== undefined) {
    if (newParams.tab) {
      params.set('tab', normalizeDiscoveryTab(newParams.tab));
    } else {
      params.delete('tab');
    }
  }

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

  for (const key of ['activity', 'organizer', 'venue']) {
    if (newParams[key] !== undefined) {
      if (newParams[key]) {
        params.set(key, newParams[key]);
      } else {
        params.delete(key);
      }
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
  const hasExplicitActivities = Array.isArray(options.activities);
  const hasExplicitOrganizers = Array.isArray(options.organizers);
  const hasExplicitVenues = Array.isArray(options.venues);
  const initialActivities = hasExplicitActivities ? options.activities : [];
  const initialOrganizers = hasExplicitOrganizers ? options.organizers : [];
  const initialVenues = hasExplicitVenues ? options.venues : [];

  const targetActivityId = options.activityId || urlParams.activity || null;
  const targetOrganizerId = options.organizerId || urlParams.organizer || null;
  const targetVenueId = options.venueId || urlParams.venue || null;

  let initialTab;
  if (urlParams.tab) {
    initialTab = normalizeDiscoveryTab(urlParams.tab);
  } else if (targetVenueId) {
    initialTab = 'venues';
  } else if (targetOrganizerId) {
    initialTab = 'organizers';
  } else if (targetActivityId) {
    initialTab = 'activities';
  } else {
    initialTab = normalizeDiscoveryTab(options.tab || 'activities');
  }

  let initialLocation = options.location !== undefined ? options.location : null;
  if (!initialLocation && urlParams.suburb) {
    initialLocation = getSuburbBySlugOrName(urlParams.suburb);
  }
  if (!initialLocation && options.location === undefined) {
    initialLocation = getSavedLocation();
  }

  function getTabTargetId(tab) {
    if (tab === 'organizers') return targetOrganizerId;
    if (tab === 'venues') return targetVenueId;
    return targetActivityId;
  }

  function resolveDeepLinkLocation(recordsList, targetId = targetActivityId) {
    if (!targetId || !Array.isArray(recordsList)) return null;
    const targetRecord = recordsList.find((item) => item.id === targetId) || null;
    if (!targetRecord) return null;
    const coords = extractListingCoordinates(targetRecord);
    if (coords) {
      const nearestSuburb = findNearestSuburb(coords);
      const fallbackName = targetRecord.venue?.name || targetRecord.name || 'Perth';
      return {
        name: nearestSuburb ? nearestSuburb.name : fallbackName,
        postcode: nearestSuburb ? nearestSuburb.postcode : undefined,
        lat: coords.lat,
        lng: coords.lng
      };
    }
    return null;
  }

  const initialTabRecords = initialTab === 'organizers'
    ? initialOrganizers
    : (initialTab === 'venues' ? initialVenues : initialActivities);
  const initialTargetId = getTabTargetId(initialTab);
  if (initialTargetId && !initialLocation) {
    initialLocation = resolveDeepLinkLocation(initialTabRecords, initialTargetId);
  }

  let initialRadius = options.radiusKm !== undefined ? options.radiusKm : 10;
  if (options.radiusKm === undefined && urlParams.radius !== null) {
    initialRadius = urlParams.radius;
  }

  const savedSports = options.sports !== undefined ? options.sports : getSavedSportsFilters();

  const store = createDiscoveryStore({
    activities: initialActivities,
    organizers: initialOrganizers,
    venues: initialVenues,
    activeTab: initialTab,
    location: initialLocation,
    radiusKm: initialRadius,
    selectedActivityId: targetActivityId,
    selectedOrganizerId: targetOrganizerId,
    selectedVenueId: targetVenueId,
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
  const tabsContainer = document.getElementById('discovery-tabs');
  const tabButtonsFromQuery = document.querySelectorAll ? Array.from(document.querySelectorAll('.discovery-tab')) : [];
  const tabButtons = tabButtonsFromQuery.length > 0
    ? tabButtonsFromQuery
    : ['activities', 'organizers', 'venues'].map((t) => document.getElementById(`tab-${t}`)).filter(Boolean);
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

  const loadedTabs = new Set();
  if (hasExplicitActivities) loadedTabs.add('activities');
  if (hasExplicitOrganizers) loadedTabs.add('organizers');
  if (hasExplicitVenues) loadedTabs.add('venues');
  const inFlightLoads = new Map();

  const TAB_CONFIG = {
    activities: {
      loadingText: 'Loading activities...',
      fetch: (fetchOpts) => fetchActivitiesFromFirestore(fetchOpts),
      setRecords: (records) => store.setActivities(records),
      getRecords: (state) => state.activities,
      getFiltered: (state) => state.filteredActivities,
      renderCard: renderActivityCard
    },
    organizers: {
      loadingText: 'Loading organizers...',
      fetch: (fetchOpts) => fetchOrganizersFromFirestore(fetchOpts),
      setRecords: (records) => store.setOrganizers(records),
      getRecords: (state) => state.organizers,
      getFiltered: (state) => state.filteredOrganizers,
      renderCard: renderOrganizerCard
    },
    venues: {
      loadingText: 'Loading venues...',
      fetch: (fetchOpts) => fetchVenuesFromFirestore(fetchOpts),
      setRecords: (records) => store.setVenues(records),
      getRecords: (state) => state.venues,
      getFiltered: (state) => state.filteredVenues,
      renderCard: renderVenueCard
    }
  };

  let stagedSports = new Set(store.getState().filters.sports);
  const handledDeepLinks = new Set();

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

  function updateTabsUI(activeTab) {
    for (const btn of tabButtons) {
      const tabSlug = btn.getAttribute('data-tab') || (btn.id ? btn.id.replace(/^tab-/, '') : '');
      const isActive = tabSlug === activeTab;
      btn.classList.toggle('active', isActive);
      if (typeof btn.setAttribute === 'function') {
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        if (isActive) {
          btn.setAttribute('focusgroupstart', '');
        } else if (typeof btn.removeAttribute === 'function') {
          btn.removeAttribute('focusgroupstart');
        }
      }
    }
    if (feedContainer && typeof feedContainer.setAttribute === 'function') {
      feedContainer.setAttribute('aria-labelledby', `tab-${activeTab}`);
    }
  }

  function loadTabCollection(tab) {
    const normalized = normalizeDiscoveryTab(tab);
    const tabMeta = TAB_CONFIG[normalized];
    if (loadedTabs.has(normalized)) {
      return Promise.resolve(tabMeta.getRecords(store.getState()));
    }
    if (inFlightLoads.has(normalized)) {
      return inFlightLoads.get(normalized);
    }

    if (store.getState().activeTab === normalized && (store.getState().location || getTabTargetId(normalized))) {
      showLoading(tabMeta.loadingText);
    }

    const fetchPromise = tabMeta.fetch({
      db: options.db,
      fetchImpl: options.fetchImpl,
      projectId: options.projectId,
      collectionName: normalized === 'activities' ? options.collectionName : undefined,
      organizersCollectionName: options.organizersCollectionName,
      venuesCollectionName: options.venuesCollectionName
    })
      .then((records) => {
        inFlightLoads.delete(normalized);
        loadedTabs.add(normalized);

        const targetId = getTabTargetId(normalized);
        if (!store.getState().location && targetId) {
          const deepLinkLoc = resolveDeepLinkLocation(records, targetId);
          if (deepLinkLoc) {
            store.setLocation(deepLinkLoc);
          }
        }
        tabMeta.setRecords(records);
        return records;
      })
      .catch((err) => {
        inFlightLoads.delete(normalized);
        console.warn(`Failed to load ${normalized} from Firestore:`, err);
        tabMeta.setRecords([]);
        return [];
      });

    inFlightLoads.set(normalized, fetchPromise);
    return fetchPromise;
  }

  function selectTab(nextTab) {
    const normalized = normalizeDiscoveryTab(nextTab);
    updateTabsUI(normalized);
    const loadPromise = loadTabCollection(normalized);
    if (store.getState().activeTab !== normalized) {
      store.setTab(normalized);
    }
    return loadPromise;
  }

  if (tabButtons.length > 0) {
    for (const btn of tabButtons) {
      btn.addEventListener('click', () => {
        const tabSlug = btn.getAttribute('data-tab') || (btn.id ? btn.id.replace(/^tab-/, '') : 'activities');
        selectTab(tabSlug);
      });
    }
  }

  if (tabsContainer) {
    if (tabButtons.length === 0) {
      tabsContainer.addEventListener('click', (e) => {
        const btn = e.target?.closest && e.target.closest('[data-tab]');
        if (btn) {
          selectTab(btn.getAttribute('data-tab'));
        }
      });
    }

    const supportsFocusGroup = typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'focusGroup');
    if (!supportsFocusGroup) {
      tabsContainer.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || tabButtons.length === 0) {
          return;
        }
        const currentIndex = tabButtons.indexOf(e.target);
        if (currentIndex === -1) return;
        e.preventDefault();
        let nextIndex = currentIndex;
        if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabButtons.length;
        else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
        else if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = tabButtons.length - 1;
        const targetBtn = tabButtons[nextIndex];
        if (targetBtn && typeof targetBtn.focus === 'function') {
          targetBtn.focus();
        }
      });
    }
  }

  // Render Feed on Store Updates
  function renderFeed(state) {
    const activeTab = normalizeDiscoveryTab(state.activeTab);
    const tabMeta = TAB_CONFIG[activeTab];
    const filteredList = tabMeta.getFiltered(state);
    const { location, radiusKm, filters } = state;

    // Header location text
    if (currentLocationLabel) {
      currentLocationLabel.textContent = location ? location.name : 'Set Location';
    }

    updateTabsUI(activeTab);
    updateRadiusPillsUI(radiusKm);
    updateFilterHeaderUI(filters);

    if (!feedContainer) return;

    const activeDeepLinkId = getTabTargetId(activeTab);

    // If currently fetching this tab's collection, show loading state instead of flashing empty state
    if (inFlightLoads.has(activeTab)) {
      if (location || activeDeepLinkId) {
        showLoading(tabMeta.loadingText);
      }
      return;
    }

    // If cold start without location
    if (!location) {
      openLocationGate(false);
      feedContainer.innerHTML = '';
      hideLoading();
      return;
    }

    closeLocationGate();
    hideLoading();

    const count = filteredList.length;

    if (count === 0) {
      const hasSportFilters = Array.isArray(filters.sports) && filters.sports.length > 0;
      feedContainer.innerHTML = renderEmptyState({
        radiusKm,
        hasFilters: hasSportFilters,
        tab: activeTab
      });
      return;
    }

    feedContainer.innerHTML = filteredList.map(tabMeta.renderCard).join('\n');

    if (activeDeepLinkId && !handledDeepLinks.has(activeDeepLinkId)) {
      handledDeepLinks.add(activeDeepLinkId);
      highlightAndScrollToListing(activeDeepLinkId);
    }
  }

  function highlightAndScrollToListing(listingId) {
    if (!listingId || typeof document === 'undefined') return;
    const card = document.querySelector(`.activity-card[data-id="${listingId}"]`)
      || document.querySelector(`[data-id="${listingId}"]`);
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

      // 4. Listing card: whole-card click opens verified source_url (or Venue directions) in a new tab
      const card = e.target.closest && e.target.closest('.activity-card, .organizer-card, .venue-card');
      if (card) {
        openVerifiedCardUrl(card);
        return;
      }
    });

    // Support keyboard accessibility (Enter key on focused listing card)
    feedContainer.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const card = e.target.closest && e.target.closest('.activity-card, .organizer-card, .venue-card');
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
  let lastSyncedTab = store.getState().activeTab;

  // Subscribe to store updates
  store.subscribe((state) => {
    renderFeed(state);

    const currentLocationName = state.location ? state.location.name : null;
    const currentRadius = state.radiusKm;
    const currentTab = normalizeDiscoveryTab(state.activeTab);

    if (
      currentLocationName !== lastSyncedLocationName ||
      currentRadius !== lastSyncedRadius ||
      currentTab !== lastSyncedTab
    ) {
      const updates = {};
      if (currentLocationName !== lastSyncedLocationName) {
        lastSyncedLocationName = currentLocationName;
        updates.suburb = currentLocationName && currentLocationName !== 'Near Me'
          ? suburbNameToSlug(currentLocationName)
          : null;
      }
      if (currentRadius !== lastSyncedRadius) {
        lastSyncedRadius = currentRadius;
        updates.radius = currentRadius;
      }
      if (currentTab !== lastSyncedTab) {
        lastSyncedTab = currentTab;
        updates.tab = currentTab;
        updates.activity = null;
        updates.organizer = null;
        updates.venue = null;
      }
      syncUrlState(updates);
    }
  });

  // Initial render & state hydration (only active tab's collection is fetched initially)
  const initialState = store.getState();
  updateFilterHeaderUI(initialState.filters);
  updateTabsUI(initialState.activeTab);

  let ready;

  if (loadedTabs.has(initialTab)) {
    if (!initialState.location) {
      openLocationGate(false);
    } else {
      renderFeed(initialState);
    }
    hideLoading();
    ready = Promise.resolve(TAB_CONFIG[initialTab].getRecords(initialState));
  } else {
    if (!initialState.location && !getTabTargetId(initialTab)) {
      openLocationGate(false);
    } else {
      closeLocationGate();
      showLoading(TAB_CONFIG[initialTab].loadingText);
    }

    ready = loadTabCollection(initialTab);
  }

  if (typeof window !== 'undefined' && window.location && window.location.hash === '#filters') {
    openFilterView();
  }

  return {
    store,
    ready,
    selectTab,
    switchTab: selectTab,
    loadTabCollection,
    openLocationGate,
    closeLocationGate,
    openFilterView,
    closeFilterView,
    applySportsFilters,
    highlightAndScrollToListing,
    highlightAndScrollToActivity: highlightAndScrollToListing,
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
