/**
 * Shared Venue & Coordinate Fallback Resolver
 * Implements the 4-step Greater Perth Venue and coordinate resolution chain
 * shared between Facebook local sync and the crawler harness.
 */

import { calculateDistanceKm } from './discovery-engine.js';
import { matchOrganizerCandidate, matchVenueByNameOnly } from './entity-matcher.js';
import { encodeGeohash } from './geohash.js';
import { PERTH_SUBURB_CENTROIDS } from './perth-centroids.js';

export const PERTH_CENTROID = { lat: -31.9505, lng: 115.8605 };
export const MAX_PERTH_RADIUS_KM = 85;

const NON_WA_LOCATION_REGEX = /\b(NSW|VIC|QLD|SA|TAS|ACT|NT|New South Wales|Victoria|Queensland|South Australia|Tasmania|Northern Territory|Sydney|Melbourne|Brisbane|Adelaide|Hobart|Canberra|Darwin)\b/i;
const WA_LOCATION_REGEX = /\b(WA|Western Australia|Perth)\b/i;

/**
 * Checks whether location text explicitly refers to an interstate (non-WA) location.
 *
 * @param {string} [locationText='']
 * @returns {boolean}
 */
export function isNonWaText(locationText = '') {
  if (!locationText) return false;
  return NON_WA_LOCATION_REGEX.test(locationText) && !WA_LOCATION_REGEX.test(locationText);
}

/**
 * Checks whether a coordinate pair has finite numeric `lat` and `lng`.
 *
 * @param {{ lat?: unknown, lng?: unknown } | null | undefined} coords
 * @returns {boolean}
 */
function isValidCoords(coords) {
  return Boolean(
    coords &&
    typeof coords.lat === 'number' &&
    !Number.isNaN(coords.lat) &&
    typeof coords.lng === 'number' &&
    !Number.isNaN(coords.lng)
  );
}

/**
 * Checks whether a coordinate pair is valid and within Greater Perth bounds.
 *
 * @param {{ lat?: number, lng?: number } | null | undefined} coords
 * @returns {boolean}
 */
export function isWithinPerthRadius(coords) {
  if (!isValidCoords(coords)) {
    return false;
  }
  return calculateDistanceKm(coords, PERTH_CENTROID) <= MAX_PERTH_RADIUS_KM;
}

function extractRawCoordinates(raw) {
  if (!raw || typeof raw !== 'object') return { hasExplicit: false, coords: null };
  const candidate = raw.coordinates ||
    raw.venue?.coordinates ||
    (raw.lat !== undefined && raw.lng !== undefined ? { lat: raw.lat, lng: raw.lng } : null) ||
    (raw.venue?.lat !== undefined && raw.venue?.lng !== undefined ? { lat: raw.venue.lat, lng: raw.venue.lng } : null);
  if (!candidate) {
    return { hasExplicit: false, coords: null };
  }
  return {
    hasExplicit: true,
    coords: isValidCoords(candidate) ? { lat: candidate.lat, lng: candidate.lng } : null
  };
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

function matchPerthCentroidFromText(text = '') {
  const normalizedText = String(text || '');
  if (!normalizedText.trim()) return null;

  const postcodeMatches = normalizedText.match(/\b6\d{3}\b/g) || [];
  for (const code of postcodeMatches) {
    const found = PERTH_SUBURB_CENTROIDS.find(s => s.postcode === code);
    if (found) return found;
  }

  const lower = normalizedText.toLowerCase();
  const sorted = [...PERTH_SUBURB_CENTROIDS].sort((a, b) => b.name.length - a.name.length);
  for (const suburb of sorted) {
    const escaped = suburb.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) {
      return suburb;
    }
  }

  return null;
}

/**
 * Resolves an Activity's Venue metadata and Greater Perth coordinates via the 4-step chain:
 * 1. Explicit coordinates within Greater Perth
 * 2. Normalized Venue name/slug lookup against `/venues` catalog
 * 3. Greater Perth suburb/postcode centroid lookup
 * 4. Supplied fallback centroid (e.g. LGA centroid) or Organizer centroid
 *
 * @param {object} raw
 * @param {object} [options]
 * @returns {object}
 */
export function resolveActivityVenueAndCoordinates(raw = {}, options = {}) {
  const {
    venuesCatalog = [],
    organizersCatalog = [],
    parentOrganizer = null,
    fallbackCentroid = null
  } = options;

  // Step 1: Explicit coordinates within Greater Perth
  const { hasExplicit, coords: explicitCoords } = extractRawCoordinates(raw);
  if (hasExplicit) {
    return explicitCoords && isWithinPerthRadius(explicitCoords)
      ? resolvedVenueResult(explicitCoords)
      : { outOfArea: true, outOfRegionReason: 'explicit_out_of_region' };
  }

  const locationText = raw.location_text || raw.address || raw.venue?.address || '';
  if (isNonWaText(locationText)) {
    return { outOfArea: true, outOfRegionReason: 'explicit_out_of_region' };
  }

  // Step 2: Normalized Venue name/slug lookup against /venues catalog
  const venueName = raw.venue_name || raw.venue?.name || '';
  const nameMatch = matchVenueByNameOnly(venueName, venuesCatalog);
  if (nameMatch.candidate && nameMatch.candidate.coordinates) {
    if (!isWithinPerthRadius(nameMatch.candidate.coordinates)) {
      return { outOfArea: true, outOfRegionReason: 'explicit_out_of_region' };
    }
    const resolvedGeohash = nameMatch.candidate.geohash ||
      encodeGeohash(nameMatch.candidate.coordinates.lat, nameMatch.candidate.coordinates.lng, 9);
    return resolvedVenueResult(nameMatch.candidate.coordinates, {
      geohash: resolvedGeohash,
      venueOverride: {
        id: nameMatch.candidate.id,
        name: nameMatch.candidate.name,
        coordinates: nameMatch.candidate.coordinates,
        geohash: resolvedGeohash,
        google_place_id: nameMatch.candidate.google_place_id || null
      },
      fallbackReviewReason: nameMatch.status === 'uncertain' ? 'uncertain_venue_match' : null
    });
  }

  // Step 3: Greater Perth suburb/postcode centroid lookup
  const combinedText = [
    raw.location_text,
    raw.address,
    raw.suburb,
    raw.venue?.address,
    raw.venue_name,
    raw.venue?.name,
    raw.description,
    raw.title
  ].filter(Boolean).join(' ');
  const centroid = matchPerthCentroidFromText(combinedText);
  if (centroid) {
    return resolvedVenueResult(
      { lat: centroid.lat, lng: centroid.lng },
      { fallbackReviewReason: 'unmatched_venue' }
    );
  }

  // Step 4: Supplied fallback centroid (e.g. LGA centroid) or Organizer centroid
  const suppliedFallback = raw.fallbackCentroid || raw.fallback_centroid || fallbackCentroid;
  if (suppliedFallback && isWithinPerthRadius(suppliedFallback)) {
    return resolvedVenueResult(
      { lat: suppliedFallback.lat, lng: suppliedFallback.lng },
      { fallbackReviewReason: 'unmatched_venue' }
    );
  }

  const organizerName = raw.organizer?.name || raw.organizer_name || '';
  const matchedOrg = parentOrganizer || (organizerName
    ? matchOrganizerCandidate({ name: organizerName }, organizersCatalog).candidate
    : null);
  const orgCoords = matchedOrg?.coordinates || matchedOrg?.venue?.coordinates || null;
  if (orgCoords && isWithinPerthRadius(orgCoords)) {
    return resolvedVenueResult(orgCoords, { fallbackReviewReason: 'unmatched_venue' });
  }

  return { outOfArea: true, outOfRegionReason: 'unresolved' };
}

/**
 * Applies resolved Venue overrides and fallback review flags to a reconciled Activity listing.
 *
 * @param {object} reconciled - Activity after reconcileListingWithCatalog
 * @param {object} resolved - Result from resolveActivityVenueAndCoordinates
 * @param {object} [sanitizedVenue] - Original sanitized venue before catalog reconciliation
 * @returns {object}
 */
export function applyVenueResolution(reconciled, resolved, sanitizedVenue = null) {
  if (!reconciled || !resolved || resolved.outOfArea) {
    return reconciled;
  }
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
        ...(sanitizedVenue || reconciled.venue),
        id: null
      };
    }
  }
  return reconciled;
}
