/**
 * Local Google Places API (New) Sync CLI
 * Populates canonical /venues and /organizers collections across Greater Perth
 * using cost-controlled Pro-tier fields, spatial de-overlapping, and local caching.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateDistanceKm } from './discovery-engine.js';
import { createFirestoreAdapter, initFirestoreFromEnv } from './firestore-adapter.js';
import { PERTH_SUBURB_CENTROIDS } from './perth-centroids.js';
import { normalizeSubcategories, sanitizeOrganizer, sanitizeVenue } from './sanitizer.js';

export const PLACES_NEARBY_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchNearby';
export const PRO_TIER_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.businessStatus'
].join(',');

export const SEARCH_RADIUS_METERS = 3500;
export const DEOVERLAP_DISTANCE_KM = 2.0;

export const VENUE_QUERY_GROUPS = [
  {
    name: 'sports_recreation',
    defaultCategory: 'sports',
    includedTypes: [
      'sports_complex',
      'fitness_center',
      'stadium',
      'athletic_field',
      'swimming_pool',
      'golf_course',
      'tennis_court',
      'bowling_alley',
      'ice_skating_rink'
    ]
  },
  {
    name: 'community_culture_campuses',
    defaultCategory: 'community',
    includedTypes: [
      'community_center',
      'cultural_center',
      'performing_arts_theater',
      'event_venue',
      'library',
      'university',
      'school'
    ]
  },
  {
    name: 'parks_outdoors',
    defaultCategory: 'outdoors',
    includedTypes: [
      'park',
      'national_park',
      'hiking_area',
      'playground',
      'campground',
      'marina',
      'beach'
    ]
  }
];

export const ORGANIZER_QUERY_GROUP = {
  name: 'organizers',
  includedTypes: ['sports_club']
};

const VENUE_PRIMARY_TYPES = new Set(VENUE_QUERY_GROUPS.flatMap(g => g.includedTypes));

const SPORTS_TYPES = new Set(VENUE_QUERY_GROUPS[0].includedTypes.filter(t => t !== 'bowling_alley' && t !== 'ice_skating_rink'));
const OUTDOORS_TYPES = new Set(['park', 'national_park', 'hiking_area', 'campground', 'marina', 'beach']);
const CULTURE_TYPES = new Set(['cultural_center', 'performing_arts_theater', 'library', 'museum', 'art_gallery']);
const COMMUNITY_TYPES = new Set(['community_center', 'event_venue', 'university', 'school']);
const RECREATION_TYPES = new Set(['playground', 'bowling_alley', 'ice_skating_rink']);

/**
 * Classifies a Google Place as either 'organizer' or 'venue'.
 *
 * @param {object} place
 * @param {string} [sourceGroupName]
 * @returns {'organizer' | 'venue'}
 */
function classifyPlaceEntity(place, sourceGroupName) {
  const primaryType = place.primaryType || '';
  const types = Array.isArray(place.types) ? place.types : [];

  if (primaryType === 'sports_club') {
    return 'organizer';
  }
  if (VENUE_PRIMARY_TYPES.has(primaryType)) {
    return 'venue';
  }
  if (sourceGroupName === 'organizers' || types.includes('sports_club')) {
    return 'organizer';
  }
  return 'venue';
}

/**
 * Maps Google Place types to MyPlaydex Venue categories:
 * 'sports' | 'recreation' | 'culture' | 'community' | 'outdoors'.
 *
 * @param {object} place
 * @param {string} [defaultCategory='sports']
 * @returns {'sports' | 'recreation' | 'culture' | 'community' | 'outdoors'}
 */
function resolveVenueCategory(place, defaultCategory = 'sports') {
  const primaryType = place.primaryType || '';
  const types = Array.isArray(place.types) ? place.types : [];
  const orderedTypes = primaryType ? [primaryType, ...types.filter(t => t !== primaryType)] : types;

  for (const t of orderedTypes) {
    if (SPORTS_TYPES.has(t)) return 'sports';
    if (RECREATION_TYPES.has(t)) return 'recreation';
    if (CULTURE_TYPES.has(t)) return 'culture';
    if (COMMUNITY_TYPES.has(t)) return 'community';
    if (OUTDOORS_TYPES.has(t)) return 'outdoors';
  }

  return defaultCategory;
}

/**
 * Fetches a single Google Places Nearby Search query.
 *
 * @param {object} params
 * @returns {Promise<Array<object>>}
 */
async function fetchNearbyPlaces({ fetchFn, apiKey, centroid, includedTypes }) {
  const response = await fetchFn(PLACES_NEARBY_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': PRO_TIER_FIELD_MASK
    },
    body: JSON.stringify({
      includedTypes,
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: {
            latitude: centroid.lat,
            longitude: centroid.lng
          },
          radius: SEARCH_RADIUS_METERS
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Google Places API error (${response.status})`);
  }

  const data = await response.json();
  return Array.isArray(data?.places) ? data.places : [];
}

/**
 * Selects target suburb centroids, applying 2.0 km spatial de-overlapping on full sweeps.
 *
 * @param {object} options
 * @returns {Array<{ name: string, postcode: string, lat: number, lng: number }>}
 */
function selectTargetCentroids(options = {}) {
  let targetCentroids;
  if (options.suburb) {
    const queryLower = String(options.suburb).trim().toLowerCase();
    targetCentroids = PERTH_SUBURB_CENTROIDS.filter(c => c.name.toLowerCase() === queryLower);
  } else {
    targetCentroids = [];
    for (const candidate of PERTH_SUBURB_CENTROIDS) {
      const tooClose = targetCentroids.some(
        prev => calculateDistanceKm({ lat: prev.lat, lng: prev.lng }, { lat: candidate.lat, lng: candidate.lng }) < DEOVERLAP_DISTANCE_KM
      );
      if (!tooClose) {
        targetCentroids.push(candidate);
      }
    }
  }

  if (typeof options.limit === 'number' && options.limit > 0) {
    return targetCentroids.slice(0, options.limit);
  }
  return targetCentroids;
}

/**
 * Classifies and sanitizes raw Google Place records into canonical Venues and Organizers.
 *
 * @param {Map<string, { place: object, group: object }>} rawPlacesById
 * @param {'all' | 'venues' | 'organizers'} entityFilter
 * @returns {{ venues: Array<object>, organizers: Array<object> }}
 */
function classifyAndSanitizePlaces(rawPlacesById, entityFilter) {
  const venues = [];
  const organizers = [];

  for (const { place, group } of rawPlacesById.values()) {
    const name = place.displayName?.text || '';
    const lat = place.location?.latitude;
    const lng = place.location?.longitude;
    if (!name || typeof lat !== 'number' || typeof lng !== 'number') {
      continue;
    }

    const kind = classifyPlaceEntity(place, group.name);
    const subcategories = normalizeSubcategories([name, place.primaryType || '']);
    const sharedFields = {
      source: 'google_places',
      source_id: place.id,
      google_place_id: place.id,
      primary_type: place.primaryType || null,
      google_types: Array.isArray(place.types) ? place.types : [],
      name,
      address: place.formattedAddress || '',
      coordinates: { lat, lng },
      region_id: 'perth',
      subcategories,
      verified: false,
      source_url: null,
      raw_source_url: null,
      needs_review: false,
      review_reason: null
    };

    if (kind === 'organizer') {
      if (entityFilter === 'all' || entityFilter === 'organizers') {
        organizers.push(sanitizeOrganizer(sharedFields));
      }
    } else if (entityFilter === 'all' || entityFilter === 'venues') {
      const category = resolveVenueCategory(place, group.defaultCategory || 'sports');
      venues.push(sanitizeVenue({ ...sharedFields, category }));
    }
  }

  return { venues, organizers };
}

/**
 * Runs the Google Places sync pipeline across Greater Perth suburb centroids.
 *
 * @param {object} params
 * @returns {Promise<object>} Sync summary report
 */
export async function runPlacesSync({
  adapter,
  fetchFn = globalThis.fetch,
  apiKey = process.env.GOOGLE_PLACES_API_KEY || '',
  options = {},
  cacheStore = { read: async () => null, write: async () => {} },
  logger = console
} = {}) {
  const isDryRun = Boolean(options.dryRun || adapter?.isDryRun?.());
  const entityFilter = options.entity || 'all';
  const refresh = Boolean(options.refresh);

  const targetCentroids = selectTargetCentroids(options);

  const queryGroups = [];
  if (entityFilter === 'all' || entityFilter === 'venues') {
    queryGroups.push(...VENUE_QUERY_GROUPS);
  }
  if (entityFilter === 'all' || entityFilter === 'organizers') {
    queryGroups.push(ORGANIZER_QUERY_GROUP);
  }

  const rawPlacesById = new Map();
  let cacheHits = 0;

  for (const centroid of targetCentroids) {
    const cacheKey = centroid.name;
    const cached = (await cacheStore.read(cacheKey)) || {};
    const missingGroups = refresh
      ? queryGroups
      : queryGroups.filter(g => !Array.isArray(cached[g.name]));

    let suburbData = cached;
    if (missingGroups.length === 0) {
      cacheHits++;
    } else {
      const updatedData = { ...cached };
      for (const group of missingGroups) {
        const places = await fetchNearbyPlaces({
          fetchFn,
          apiKey,
          centroid,
          includedTypes: group.includedTypes
        });
        updatedData[group.name] = places;
      }
      suburbData = updatedData;
      await cacheStore.write(cacheKey, suburbData);
    }

    for (const group of queryGroups) {
      const places = Array.isArray(suburbData[group.name]) ? suburbData[group.name] : [];
      for (const place of places) {
        if (!place?.id || place.businessStatus === 'CLOSED_PERMANENTLY') {
          continue;
        }
        if (!rawPlacesById.has(place.id)) {
          rawPlacesById.set(place.id, { place, group });
        }
      }
    }
  }

  const { venues, organizers } = classifyAndSanitizePlaces(rawPlacesById, entityFilter);

  let venuesUpserted = 0;
  let organizersUpserted = 0;

  if (!isDryRun) {
    if (venues.length > 0 && typeof adapter?.batchUpsertVenues === 'function') {
      const res = await adapter.batchUpsertVenues(venues);
      venuesUpserted = res.upserted || 0;
    }
    if (organizers.length > 0 && typeof adapter?.batchUpsertOrganizers === 'function') {
      const res = await adapter.batchUpsertOrganizers(organizers);
      organizersUpserted = res.upserted || 0;
    }
  }

  logger.log?.(`[Places Sync] Suburbs: ${targetCentroids.length} (cache hits: ${cacheHits}), Venues: ${venues.length}, Organizers: ${organizers.length}, Dry-Run: ${isDryRun}`);

  return {
    suburbsQueried: targetCentroids.length,
    cacheHits,
    venuesCount: venues.length,
    organizersCount: organizers.length,
    venuesUpserted,
    organizersUpserted,
    dryRun: isDryRun
  };
}

/**
 * Creates a JSON file-backed checkpoint cache store keyed by suburb name.
 *
 * @param {string} [cachePath='.scratch/places-sync-cache.json']
 * @returns {{ read: (key: string) => Promise<object|null>, write: (key: string, val: object) => Promise<void> }}
 */
export function createFileCacheStore(cachePath = path.resolve(process.cwd(), '.scratch/places-sync-cache.json')) {
  let memoryCache = null;

  async function loadAll() {
    if (memoryCache) return memoryCache;
    try {
      const raw = await fs.readFile(cachePath, 'utf8');
      memoryCache = JSON.parse(raw);
    } catch {
      memoryCache = {};
    }
    return memoryCache;
  }

  return {
    async read(key) {
      const data = await loadAll();
      return data[key] || null;
    },
    async write(key, val) {
      const data = await loadAll();
      data[key] = val;
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(data, null, 2), 'utf8');
    }
  };
}

/**
 * Extracts a `--key=value` CLI argument value.
 *
 * @param {Array<string>} argv
 * @param {string} flag
 * @returns {string | undefined}
 */
function getArgValue(argv, flag) {
  const prefix = `--${flag}=`;
  const match = argv.find(a => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

/**
 * Parses CLI arguments for the Google Places sync CLI.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @returns {object}
 */
export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  const suburb = getArgValue(argv, 'suburb');
  const rawEntity = getArgValue(argv, 'entity') || 'all';
  const entity = ['all', 'venues', 'organizers'].includes(rawEntity) ? rawEntity : 'all';

  const dryRun = argv.includes('--dry-run');
  const refresh = argv.includes('--refresh');

  const rawLimit = getArgValue(argv, 'limit');
  const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;

  const useAdc = argv.includes('--use-adc') || Boolean(env.FIREBASE_USE_ADC);
  const project = getArgValue(argv, 'project') || env.FIREBASE_PROJECT_ID || 'myplaydex';

  return {
    suburb,
    entity,
    dryRun,
    refresh,
    limit: Number.isNaN(limit) ? undefined : limit,
    useAdc,
    project
  };
}

/**
 * Main entry point for the local Google Places sync CLI.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @param {object} [options={}]
 * @returns {Promise<object>} Sync summary report
 */
export async function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  const parsedArgs = parseCliArgs(argv, env);
  const logger = options.logger || console;
  const apiKey = options.apiKey || env.GOOGLE_PLACES_API_KEY || '';

  if (!apiKey && !options.fetchFn) {
    throw new Error('Missing required environment variable: GOOGLE_PLACES_API_KEY');
  }

  const firestoreEnv = options.firestoreEnv || (parsedArgs.dryRun
    ? { db: null, dryRun: true, projectId: parsedArgs.project }
    : await initFirestoreFromEnv(env, {
        requireCredentials: !parsedArgs.dryRun && !parsedArgs.useAdc,
        useAdc: parsedArgs.useAdc,
        projectId: parsedArgs.project
      }));

  const effectiveDryRun = parsedArgs.dryRun || firestoreEnv.dryRun;
  const adapter = options.adapter || createFirestoreAdapter({
    db: firestoreEnv.db,
    dryRun: effectiveDryRun
  });

  const cacheStore = options.cacheStore || createFileCacheStore();

  return runPlacesSync({
    adapter,
    fetchFn: options.fetchFn,
    apiKey,
    cacheStore,
    options: {
      suburb: parsedArgs.suburb,
      entity: parsedArgs.entity,
      dryRun: effectiveDryRun,
      refresh: parsedArgs.refresh,
      limit: parsedArgs.limit
    },
    logger
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[Places Sync Fatal Error]', err);
    process.exit(1);
  });
}
