/**
 * Canonical Entity Matcher
 * Reconciles crawled Venue and Organizer references against pre-loaded Firestore
 * catalogs using normalized name/slug similarity and coordinate proximity.
 */

import { slugify } from './sanitizer.js';
import { calculateDistanceKm } from './discovery-engine.js';

const LEGAL_SUFFIX_TOKENS = new Set(['inc', 'incorporated', 'ltd', 'pty', 'llc', 'co', 'wa', 'au']);
const ORGANIZER_STOP_TOKENS = new Set(['of', 'the', 'and', 'for']);
const VENUE_CONFIDENT_EXACT_KM = 1.0;
const VENUE_CONFIDENT_CONTAINED_KM = 0.5;
const VENUE_UNCERTAIN_EXACT_KM = 5.0;
const VENUE_UNCERTAIN_PARTIAL_KM = 2.5;
const VENUE_UNCERTAIN_CLOSE_KM = 0.15;

function tokenizeNormalized(name = '') {
  const slug = slugify(name);
  if (!slug) return [];
  return slug.split('_').filter(Boolean);
}

function stripOrganizerNoise(tokens = []) {
  const filtered = tokens.filter(token => !LEGAL_SUFFIX_TOKENS.has(token) && !ORGANIZER_STOP_TOKENS.has(token));
  return filtered.length > 0 ? filtered : tokens;
}

function computeTokenSimilarity(tokensA = [], tokensB = []) {
  if (tokensA.length === 0 || tokensB.length === 0) {
    return { jaccard: 0, sharedCount: 0, allSmallerContained: false };
  }
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let sharedCount = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      sharedCount += 1;
    }
  }
  const unionSize = new Set([...tokensA, ...tokensB]).size;
  const jaccard = unionSize > 0 ? sharedCount / unionSize : 0;
  const smallerSize = Math.min(setA.size, setB.size);
  const allSmallerContained = smallerSize >= 2 && sharedCount === smallerSize;
  return { jaccard, sharedCount, allSmallerContained };
}

function hasValidCoords(coords) {
  return Boolean(
    coords &&
    typeof coords.lat === 'number' &&
    !Number.isNaN(coords.lat) &&
    typeof coords.lng === 'number' &&
    !Number.isNaN(coords.lng)
  );
}

/**
 * Matches a scraped Venue reference against the pre-loaded `/venues` catalog.
 *
 * @param {{ name?: string, coordinates?: { lat: number, lng: number } }} rawVenue
 * @param {Array<object>} [venuesCatalog=[]]
 * @returns {{ status: 'matched' | 'uncertain' | 'unmatched', candidate: object | null }}
 */
export function matchVenueCandidate(rawVenue = {}, venuesCatalog = []) {
  const rawName = String(rawVenue?.name || '').trim();
  const rawSlug = slugify(rawName);
  const rawTokens = tokenizeNormalized(rawName);
  const rawCoords = rawVenue?.coordinates;

  if (!rawSlug || !Array.isArray(venuesCatalog) || venuesCatalog.length === 0) {
    return { status: 'unmatched', candidate: null };
  }

  let best = null;

  for (const candidate of venuesCatalog) {
    if (!candidate || !candidate.id || !candidate.name) continue;
    const candSlug = slugify(candidate.name);
    if (!candSlug) continue;

    const candTokens = tokenizeNormalized(candidate.name);
    const distanceKm = hasValidCoords(rawCoords) && hasValidCoords(candidate.coordinates)
      ? calculateDistanceKm(rawCoords, candidate.coordinates)
      : Infinity;

    const exactSlug = rawSlug === candSlug;
    const { jaccard, sharedCount, allSmallerContained } = computeTokenSimilarity(rawTokens, candTokens);
    const substringMatch = candSlug.includes(rawSlug) || rawSlug.includes(candSlug);

    let status = 'unmatched';
    let score = 0;

    if (exactSlug && distanceKm <= VENUE_CONFIDENT_EXACT_KM) {
      status = 'matched';
      score = 100 - distanceKm;
    } else if (((allSmallerContained && rawTokens.length >= 3 && candTokens.length >= 3) || jaccard >= 0.75) && distanceKm <= VENUE_CONFIDENT_CONTAINED_KM) {
      status = 'matched';
      score = 90 + jaccard * 5 - distanceKm;
    } else if (exactSlug && distanceKm <= VENUE_UNCERTAIN_EXACT_KM) {
      status = 'uncertain';
      score = 70 - distanceKm;
    } else if ((substringMatch || allSmallerContained || jaccard >= 0.4) && distanceKm <= VENUE_UNCERTAIN_PARTIAL_KM) {
      status = 'uncertain';
      score = 50 + jaccard * 10 - distanceKm;
    } else if (distanceKm <= VENUE_UNCERTAIN_CLOSE_KM && sharedCount >= 1) {
      status = 'uncertain';
      score = 40 + jaccard * 10 - distanceKm;
    }

    if (status !== 'unmatched' && (!best || score > best.score)) {
      best = { status, candidate, score };
    }
  }

  return best
    ? { status: best.status, candidate: best.candidate }
    : { status: 'unmatched', candidate: null };
}

/**
 * Matches a scraped Organizer reference against the pre-loaded `/organizers` catalog.
 *
 * @param {{ id?: string, name?: string, coordinates?: { lat: number, lng: number } }} rawOrganizer
 * @param {Array<object>} [organizersCatalog=[]]
 * @returns {{ status: 'matched' | 'uncertain' | 'unmatched', candidate: object | null }}
 */
export function matchOrganizerCandidate(rawOrganizer = {}, organizersCatalog = []) {
  const rawName = String(rawOrganizer?.name || '').trim();
  const rawSlug = slugify(rawName);
  const rawStrippedTokens = stripOrganizerNoise(tokenizeNormalized(rawName));
  const rawStrippedSlug = rawStrippedTokens.join('_');

  if ((!rawSlug && !rawOrganizer?.id) || !Array.isArray(organizersCatalog) || organizersCatalog.length === 0) {
    return { status: 'unmatched', candidate: null };
  }

  let best = null;

  for (const candidate of organizersCatalog) {
    if (!candidate || !candidate.id || !candidate.name) continue;
    const candSlug = slugify(candidate.name);
    const candStrippedTokens = stripOrganizerNoise(tokenizeNormalized(candidate.name));
    const candStrippedSlug = candStrippedTokens.join('_');

    const exactIdOrSlug = (rawOrganizer.id && rawOrganizer.id === candidate.id) ||
      (rawSlug && candSlug && rawSlug === candSlug) ||
      (rawStrippedSlug && candStrippedSlug && rawStrippedSlug === candStrippedSlug);

    const { jaccard, allSmallerContained } = computeTokenSimilarity(rawStrippedTokens, candStrippedTokens);

    let status = 'unmatched';
    let score = 0;

    if (exactIdOrSlug) {
      status = 'matched';
      score = 100;
    } else if (allSmallerContained || jaccard >= 0.5) {
      status = 'uncertain';
      score = 50 + jaccard * 20;
    }

    if (status !== 'unmatched' && (!best || score > best.score)) {
      best = { status, candidate, score };
    }
  }

  return best
    ? { status: best.status, candidate: best.candidate }
    : { status: 'unmatched', candidate: null };
}

/**
 * Reconciles a sanitized Activity or Organizer listing against pre-loaded Firestore catalogs
 * and attaches `needs_review` and `review_reason` metadata.
 *
 * @param {object} listing
 * @param {{ venuesCatalog?: Array<object>, organizersCatalog?: Array<object> }} [catalog={}]
 * @param {'activity' | 'organizer'} [listingType='activity']
 * @returns {object}
 */
export function reconcileListingWithCatalog(listing, catalog = {}, listingType = 'activity') {
  const venuesCatalog = catalog.venuesCatalog || [];
  const organizersCatalog = catalog.organizersCatalog || [];

  if (listingType === 'organizer') {
    const orgMatch = matchOrganizerCandidate(listing, organizersCatalog);
    if (orgMatch.status === 'matched' && orgMatch.candidate) {
      return {
        ...listing,
        id: orgMatch.candidate.id
      };
    }
    return {
      ...listing,
      needs_review: true,
      review_reason: 'crawler_created'
    };
  }

  const venueMatch = matchVenueCandidate(listing.venue, venuesCatalog);
  const organizerMatch = matchOrganizerCandidate(listing.organizer, organizersCatalog);

  let nextVenue;
  if ((venueMatch.status === 'matched' || venueMatch.status === 'uncertain') && venueMatch.candidate) {
    nextVenue = {
      id: venueMatch.candidate.id,
      name: venueMatch.candidate.name,
      coordinates: venueMatch.candidate.coordinates,
      geohash: venueMatch.candidate.geohash,
      google_place_id: venueMatch.candidate.google_place_id || null
    };
  } else {
    nextVenue = {
      ...listing.venue,
      id: null
    };
  }

  let nextOrganizer;
  if ((organizerMatch.status === 'matched' || organizerMatch.status === 'uncertain') && organizerMatch.candidate) {
    nextOrganizer = {
      id: organizerMatch.candidate.id,
      name: organizerMatch.candidate.name
    };
  } else {
    nextOrganizer = { ...listing.organizer };
  }

  let needsReview = false;
  let reviewReason = null;

  if (venueMatch.status === 'unmatched') {
    needsReview = true;
    reviewReason = 'unmatched_venue';
  } else if (venueMatch.status === 'uncertain') {
    needsReview = true;
    reviewReason = 'uncertain_venue_match';
  } else if (organizerMatch.status === 'unmatched') {
    needsReview = true;
    reviewReason = 'unmatched_organizer';
  } else if (organizerMatch.status === 'uncertain') {
    needsReview = true;
    reviewReason = 'uncertain_organizer_match';
  }

  return {
    ...listing,
    venue: nextVenue,
    organizer: nextOrganizer,
    needs_review: needsReview,
    review_reason: reviewReason
  };
}
