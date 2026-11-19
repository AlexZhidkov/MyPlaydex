/**
 * Local Facebook Public Events Sync CLI
 * Ingests public Facebook Events from explicit URLs, local files (.ics/.json/.html),
 * or /organizers `contact.facebook` seeds into canonical /activities listings.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateDistanceKm } from './discovery-engine.js';
import {
  matchOrganizerCandidate,
  matchVenueByNameOnly,
  reconcileListingWithCatalog
} from './entity-matcher.js';
import { extractFacebookEventLinks, extractFacebookEvents } from './facebook-parser.js';
import { createFirestoreAdapter, initFirestoreFromEnv } from './firestore-adapter.js';
import { encodeGeohash } from './geohash.js';
import { PERTH_SUBURB_CENTROIDS } from './perth-centroids.js';
import { createFileCacheStore, loadDotEnv } from './places-sync.js';
import {
  computeActivityExpireAt,
  normalizeSport,
  parseSchedule,
  sanitizeActivity,
  slugify
} from './sanitizer.js';
import { normalizeFacebookUrl } from './url-utils.js';

export { extractFacebookEvents };

export const PERTH_CENTROID = { lat: -31.9505, lng: 115.8605 };
export const MAX_PERTH_RADIUS_KM = 85;
export const DEFAULT_FACEBOOK_CACHE_PATH = path.resolve(process.cwd(), '.scratch/facebook-sync-cache.json');

const NON_WA_LOCATION_REGEX = /\b(NSW|VIC|QLD|SA|TAS|ACT|NT|New South Wales|Victoria|Queensland|South Australia|Tasmania|Northern Territory|Sydney|Melbourne|Brisbane|Adelaide|Hobart|Canberra|Darwin)\b/i;
const WA_LOCATION_REGEX = /\b(WA|Western Australia|Perth)\b/i;

function getArgValue(argv, flag) {
  const prefix = `--${flag}=`;
  const match = argv.find(a => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

/**
 * Parses CLI arguments for the Facebook Public Events sync CLI.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @returns {object}
 */
export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  const url = getArgValue(argv, 'url');
  const input = getArgValue(argv, 'input');
  const organizer = getArgValue(argv, 'organizer');
  const dryRun = argv.includes('--dry-run');
  const refresh = argv.includes('--refresh');

  const rawLimit = getArgValue(argv, 'limit');
  const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;

  const useAdc = argv.includes('--use-adc') || Boolean(env.FIREBASE_USE_ADC);
  const project = getArgValue(argv, 'project') || env.FIREBASE_PROJECT_ID || 'myplaydex';

  return {
    url,
    input,
    organizer,
    dryRun,
    refresh,
    limit: Number.isNaN(limit) ? undefined : limit,
    useAdc,
    project
  };
}

function isWithinPerthRadius(coords) {
  if (!coords || typeof coords.lat !== 'number' || typeof coords.lng !== 'number') {
    return false;
  }
  return calculateDistanceKm(coords, PERTH_CENTROID) <= MAX_PERTH_RADIUS_KM;
}

function isNonWaText(locationText = '') {
  if (!locationText) return false;
  return NON_WA_LOCATION_REGEX.test(locationText) && !WA_LOCATION_REGEX.test(locationText);
}

function matchPerthCentroidFromText(text = '') {
  const source = String(text || '');
  if (!source.trim()) return null;

  const postcodeMatches = source.match(/\b6\d{3}\b/g) || [];
  for (const code of postcodeMatches) {
    const found = PERTH_SUBURB_CENTROIDS.find(s => s.postcode === code);
    if (found) return found;
  }

  const lower = source.toLowerCase();
  const sorted = [...PERTH_SUBURB_CENTROIDS].sort((a, b) => b.name.length - a.name.length);
  for (const suburb of sorted) {
    const escaped = suburb.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) {
      return suburb;
    }
  }

  return null;
}

function resolveOrganizerSubcategory(org) {
  if (!org) return null;
  if (typeof org.subcategory === 'string' && org.subcategory && org.subcategory !== 'other') {
    return org.subcategory;
  }
  if (Array.isArray(org.subcategories)) {
    const firstSpecific = org.subcategories.find(s => typeof s === 'string' && s && s !== 'other');
    if (firstSpecific) return firstSpecific;
  }
  return null;
}

function resolvedVenueResult(coordinates, { geohash, venueOverride = null, fallbackReviewReason = null } = {}) {
  return {
    outOfArea: false,
    coordinates,
    geohash: geohash || encodeGeohash(coordinates.lat, coordinates.lng, 9),
    venueOverride,
    fallbackReviewReason
  };
}

function resolveActivityVenueAndCoordinates(ev, { venuesCatalog = [], organizersCatalog = [], parentOrganizer = null }) {
  // Step 1: Explicit coordinates from Facebook payload
  if (ev.coordinates) {
    return isWithinPerthRadius(ev.coordinates)
      ? resolvedVenueResult(ev.coordinates)
      : { outOfArea: true };
  }

  if (isNonWaText(ev.location_text)) {
    return { outOfArea: true };
  }

  // Step 2: Normalized name/slug lookup against /venues catalog
  const nameMatch = matchVenueByNameOnly(ev.venue_name, venuesCatalog);
  if (nameMatch.candidate && nameMatch.candidate.coordinates) {
    if (!isWithinPerthRadius(nameMatch.candidate.coordinates)) {
      return { outOfArea: true };
    }
    return resolvedVenueResult(nameMatch.candidate.coordinates, {
      geohash: nameMatch.candidate.geohash,
      venueOverride: {
        id: nameMatch.candidate.id,
        name: nameMatch.candidate.name,
        coordinates: nameMatch.candidate.coordinates,
        geohash: nameMatch.candidate.geohash,
        google_place_id: nameMatch.candidate.google_place_id || null
      },
      fallbackReviewReason: nameMatch.status === 'uncertain' ? 'uncertain_venue_match' : null
    });
  }

  // Step 3: Greater Perth suburb/postcode centroid lookup
  const combinedText = [ev.location_text, ev.venue_name, ev.description, ev.title].filter(Boolean).join(' ');
  const centroid = matchPerthCentroidFromText(combinedText);
  if (centroid) {
    return resolvedVenueResult(
      { lat: centroid.lat, lng: centroid.lng },
      { fallbackReviewReason: 'unmatched_venue' }
    );
  }

  // Step 4: Parent Organizer coordinates
  const matchedOrg = parentOrganizer || (ev.organizer_name
    ? matchOrganizerCandidate({ name: ev.organizer_name }, organizersCatalog).candidate
    : null);
  const orgCoords = matchedOrg?.coordinates || matchedOrg?.venue?.coordinates || null;
  if (orgCoords && isWithinPerthRadius(orgCoords)) {
    return resolvedVenueResult(orgCoords, { fallbackReviewReason: 'unmatched_venue' });
  }

  return { outOfArea: true };
}

async function fetchTargetPayload({ url, fetchFn, cacheStore, refresh, facebookCookie }) {
  const canonicalUrl = normalizeFacebookUrl(url) || url;
  if (!refresh && cacheStore) {
    const cached = await cacheStore.read(canonicalUrl);
    if (cached && cached.body) {
      return { body: cached.body, fromCache: true, sourceUrl: canonicalUrl };
    }
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  };
  if (facebookCookie) {
    headers.Cookie = facebookCookie;
  }

  const response = await fetchFn(canonicalUrl, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch Facebook URL ${canonicalUrl}: HTTP ${response.status}`);
  }
  const body = await response.text();

  if (cacheStore) {
    await cacheStore.write(canonicalUrl, {
      url: canonicalUrl,
      fetchedAt: new Date().toISOString(),
      body
    });
  }

  return { body, fromCache: false, sourceUrl: canonicalUrl };
}

async function hydrateDiscoveredEventLinks(target, rawEvents, { fetchFn, cacheStore, refresh, facebookCookie, remainingLimit, logger }) {
  if (target.format === 'ics' || typeof target.body !== 'string') {
    return { events: rawEvents, failedFetches: 0 };
  }

  const completeIds = new Set(rawEvents.filter(ev => ev.start_date).map(ev => ev.eventId));
  const discoveredLinks = extractFacebookEventLinks(target.body).filter(l => !completeIds.has(l.eventId));
  if (discoveredLinks.length === 0) {
    return { events: rawEvents, failedFetches: 0 };
  }

  const hydratedEvents = [];
  let failedFetches = 0;
  for (const link of discoveredLinks) {
    if (remainingLimit !== undefined && (rawEvents.length + hydratedEvents.length) >= remainingLimit) {
      break;
    }
    try {
      const detail = await fetchTargetPayload({
        url: link.url,
        fetchFn,
        cacheStore,
        refresh,
        facebookCookie
      });
      hydratedEvents.push(...extractFacebookEvents(detail.body, { sourceUrl: detail.sourceUrl }));
    } catch (err) {
      failedFetches += 1;
      logger?.warn?.(`[Facebook Sync] Skipping discovered event ${link.url}: ${err.message}`);
    }
  }

  const hydratedIds = new Set(hydratedEvents.map(ev => ev.eventId));
  return {
    events: [
      ...rawEvents.filter(ev => ev.start_date || !hydratedIds.has(ev.eventId)),
      ...hydratedEvents
    ],
    failedFetches
  };
}

/**
 * Executes the local Facebook Public Events sync pipeline.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function runFacebookSync({
  adapter,
  fetchFn = globalThis.fetch,
  cacheStore,
  options = {},
  env = process.env,
  logger = console
} = {}) {
  const dryRun = Boolean(options.dryRun);
  const refresh = Boolean(options.refresh);
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : undefined;
  const now = options.now instanceof Date ? options.now : (options.now ? new Date(options.now) : new Date());
  const nowIso = now.toISOString();
  const facebookCookie = options.facebookCookie || env.FACEBOOK_COOKIE || '';

  const [venuesCatalog, organizersCatalog] = await Promise.all([
    adapter?.scanVenues ? adapter.scanVenues() : [],
    adapter?.scanOrganizers ? adapter.scanOrganizers() : []
  ]);

  const explicitOrganizer = options.organizer
    ? organizersCatalog.find(o => o.id === options.organizer) || { id: options.organizer, name: options.organizer }
    : null;

  const targets = [];
  let failedTargets = 0;
  if (options.input) {
    const ext = path.extname(options.input).toLowerCase().replace(/^\./, '');
    const body = await fs.readFile(options.input, 'utf8');
    targets.push({ body, format: ext, sourceUrl: options.url || '', organizer: explicitOrganizer });
  } else if (options.url) {
    try {
      const fetched = await fetchTargetPayload({
        url: options.url,
        fetchFn,
        cacheStore,
        refresh,
        facebookCookie
      });
      targets.push({ body: fetched.body, sourceUrl: fetched.sourceUrl, organizer: explicitOrganizer });
    } catch (err) {
      failedTargets += 1;
      logger.warn?.(`[Facebook Sync] Skipping target ${options.url}: ${err.message}`);
    }
  } else {
    let seededOrgs = organizersCatalog.filter(o => Boolean(normalizeFacebookUrl(o?.contact?.facebook)));
    if (options.organizer) {
      seededOrgs = seededOrgs.filter(o => o.id === options.organizer);
    }
    if (limit !== undefined) {
      seededOrgs = seededOrgs.slice(0, limit);
    }
    for (const org of seededOrgs) {
      try {
        const fetched = await fetchTargetPayload({
          url: org.contact.facebook,
          fetchFn,
          cacheStore,
          refresh,
          facebookCookie
        });
        targets.push({ body: fetched.body, sourceUrl: fetched.sourceUrl, organizer: org });
      } catch (err) {
        failedTargets += 1;
        logger.warn?.(`[Facebook Sync] Skipping organizer ${org.id} (${org.contact.facebook}): ${err.message}`);
      }
    }
  }

  let extractedCount = 0;
  let filteredOnline = 0;
  let filteredOutOfArea = 0;
  let filteredExpired = 0;
  const activities = [];
  const seenIds = new Set();

  for (const target of targets) {
    if (limit !== undefined && activities.length >= limit) {
      break;
    }

    let rawEvents = extractFacebookEvents(target.body, {
      sourceUrl: target.sourceUrl,
      format: target.format
    });

    const hydrated = await hydrateDiscoveredEventLinks(target, rawEvents, {
      fetchFn,
      cacheStore,
      refresh,
      facebookCookie,
      remainingLimit: limit !== undefined ? Math.max(0, limit - activities.length) : undefined,
      logger
    });
    rawEvents = hydrated.events;
    failedTargets += hydrated.failedFetches;

    extractedCount += rawEvents.length;

    for (const ev of rawEvents) {
      if (limit !== undefined && activities.length >= limit) {
        break;
      }
      if (ev.is_online) {
        filteredOnline += 1;
        continue;
      }

      const schedule = parseSchedule(ev, nowIso);
      const expireAt = computeActivityExpireAt(schedule);
      if (expireAt && expireAt.getTime() <= now.getTime()) {
        filteredExpired += 1;
        continue;
      }

      const resolved = resolveActivityVenueAndCoordinates(ev, {
        venuesCatalog,
        organizersCatalog,
        parentOrganizer: target.organizer
      });
      if (resolved.outOfArea) {
        filteredOutOfArea += 1;
        continue;
      }

      const organizerInput = ev.organizer_name
        ? { name: ev.organizer_name }
        : (target.organizer ? { id: target.organizer.id, name: target.organizer.name } : undefined);

      const eventSubcategory = ev.subcategory || ev.sport || normalizeSport(`${ev.title || ''} ${ev.description || ''}`);

      const sanitized = sanitizeActivity({
        ...ev,
        source: 'facebook',
        source_id: ev.source_id,
        source_url: ev.source_url,
        verified: true,
        subcategory: eventSubcategory,
        coordinates: resolved.coordinates,
        geohash: resolved.geohash,
        venue_name: resolved.venueOverride?.name || ev.venue_name || ev.title,
        organizer: organizerInput,
        schedule
      });

      const reconciled = reconcileListingWithCatalog(
        sanitized,
        { venuesCatalog, organizersCatalog },
        'activity'
      );

      if (resolved.venueOverride) {
        reconciled.venue = {
          ...reconciled.venue,
          ...resolved.venueOverride
        };
      }
      if (resolved.fallbackReviewReason) {
        reconciled.needs_review = true;
        reconciled.review_reason = resolved.fallbackReviewReason;
        if (resolved.fallbackReviewReason === 'unmatched_venue') {
          reconciled.venue = {
            ...reconciled.venue,
            id: null
          };
        }
      }

      if (reconciled.subcategory === 'other') {
        const matchedOrg = (reconciled.organizer?.id
          ? organizersCatalog.find(o => o.id === reconciled.organizer.id)
          : null) || target.organizer;
        const inheritedSport = resolveOrganizerSubcategory(matchedOrg);
        if (inheritedSport) {
          reconciled.subcategory = inheritedSport;
        }
      }

      reconciled.verified = true;
      reconciled.source_url = normalizeFacebookUrl(ev.source_url) || ev.source_url;

      if (!seenIds.has(reconciled.id)) {
        seenIds.add(reconciled.id);
        activities.push(reconciled);
      }
    }
  }

  let upserted = 0;
  if (!dryRun && activities.length > 0 && adapter?.batchUpsertActivities) {
    const res = await adapter.batchUpsertActivities(activities);
    upserted = res?.upserted ?? activities.length;
  }

  logger.log?.(`[Facebook Sync] Targets: ${targets.length}, Failed: ${failedTargets}, Extracted: ${extractedCount}, Valid: ${activities.length}, Upserted: ${upserted} (dryRun=${dryRun})`);

  return {
    targets: targets.length,
    failedTargets,
    extracted: extractedCount,
    filteredOnline,
    filteredOutOfArea,
    filteredExpired,
    valid: activities.length,
    upserted,
    dryRun,
    activities
  };
}

/**
 * Main entry point for the local Facebook Public Events sync CLI.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @param {object} [options={}]
 * @returns {Promise<object>} Sync summary report
 */
export async function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  if (env === process.env || options.envFilePath) {
    await loadDotEnv(options.envFilePath, env);
  }

  const parsedArgs = parseCliArgs(argv, env);
  const logger = options.logger || console;

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

  const cacheStore = options.cacheStore || createFileCacheStore(DEFAULT_FACEBOOK_CACHE_PATH);

  return runFacebookSync({
    adapter,
    fetchFn: options.fetchFn,
    cacheStore,
    env,
    options: {
      url: parsedArgs.url,
      input: parsedArgs.input,
      organizer: parsedArgs.organizer,
      dryRun: effectiveDryRun,
      refresh: parsedArgs.refresh,
      limit: parsedArgs.limit,
      now: options.now
    },
    logger
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[Facebook Sync Fatal Error]', err);
    process.exit(1);
  });
}
