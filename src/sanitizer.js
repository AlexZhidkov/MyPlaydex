/**
 * Activity Data Sanitizer and Normalizer
 * Enforces canonical domain schema (GLOSSARY.md, Ticket 02 & 03),
 * derives precision-9 geohash, normalizes sports taxonomy, and cleans attributes.
 */

import { encodeGeohash } from './geohash.js';

export class SanitizationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SanitizationError';
    this.details = details;
  }
}

/**
 * Normalizes input sport names/aliases to canonical MVP taxonomy.
 *
 * @param {string} rawSport
 * @returns {string} Normalized sport slug
 */
export function normalizeSport(rawSport = '') {
  const sport = String(rawSport).toLowerCase().trim();

  if (!sport) return 'other';

  if (sport.includes('afl') || sport.includes('aussie rules') || sport.includes('footy')) {
    return 'afl';
  }

  if (sport.includes('soccer') || sport.includes('football') || sport.includes('futsal')) {
    return 'soccer';
  }

  if (sport.includes('volley')) return 'volleyball';
  if (sport.includes('basket') || sport.includes('hoop')) return 'basketball';
  if (sport.includes('tennis')) return 'tennis';
  if (sport.includes('pickleball')) return 'pickleball';
  if (sport.includes('run')) return 'running';
  if (sport.includes('fitness') || sport.includes('bootcamp') || sport.includes('crossfit') || sport.includes('hiit')) {
    return 'social-fitness';
  }
  if (sport.includes('walk') || sport.includes('hiking')) return 'walking';
  if (sport.includes('cricket')) return 'cricket';

  return 'other';
}

/**
 * Determines whether an activity is free based on explicit flag or cost description text.
 *
 * @param {string} costDescription
 * @param {boolean} [explicitIsFree]
 * @returns {boolean}
 */
export function determineIsFree(costDescription = '', explicitIsFree = undefined) {
  if (typeof explicitIsFree === 'boolean') {
    return explicitIsFree;
  }
  const cost = String(costDescription).toLowerCase().trim();
  if (!cost) return false;
  if (cost.includes('free') || cost === '$0' || cost === '0' || cost.includes('no cost') || cost.includes('no charge')) {
    return true;
  }
  return false;
}

/**
 * Parses and validates an ISO date string, falling back to current time if unparseable.
 *
 * @param {string|Date} val
 * @param {string} fallback
 * @returns {string} ISO-8601 timestamp string
 */
function toIsoDate(val, fallback) {
  if (!val) return fallback;
  const parsed = new Date(val);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

/**
 * Sanitizes a raw crawled record into a canonical ActivityDocument.
 *
 * @param {object} raw
 * @param {object} [options]
 * @returns {object} Canonical ActivityDocument
 */
export function sanitizeActivity(raw = {}, options = {}) {
  if (!raw.source || !raw.source_id) {
    throw new SanitizationError('Missing required source identity (source and source_id required)', { raw });
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) {
    throw new SanitizationError('Missing required field: title', { raw });
  }

  const coords = raw.coordinates || raw.venue?.coordinates;
  if (!coords || typeof coords.lat !== 'number' || typeof coords.lng !== 'number' || Number.isNaN(coords.lat) || Number.isNaN(coords.lng)) {
    throw new SanitizationError('Missing valid coordinates: venue coordinates { lat, lng } are required', { raw });
  }

  const cleanSource = String(raw.source).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const cleanSourceId = String(raw.source_id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const id = `${cleanSource}_${cleanSourceId}`;

  const sport = normalizeSport(raw.sport || raw.category || '');
  const type = ['social', 'training', 'game', 'club'].includes(raw.type) ? raw.type : 'social';

  const venueName = raw.venue_name || raw.venue?.name || title;
  const address = raw.address || raw.venue?.address || venueName;
  const geohash = raw.geohash || raw.venue?.geohash || encodeGeohash(coords.lat, coords.lng, 9);

  const costDescription = raw.cost_description || (raw.is_free ? 'Free' : '');
  const isFree = determineIsFree(costDescription, raw.is_free);

  const rawGender = raw.demographics?.gender || raw.gender || 'all';
  const rawAge = raw.demographics?.age || raw.age || 'all';

  const gender = ['all', 'mixed', 'women', 'men'].includes(rawGender) ? rawGender : 'all';
  const age = ['all', 'adults', 'juniors', 'masters'].includes(rawAge) ? rawAge : 'all';

  const nowIso = new Date().toISOString();
  const startTime = toIsoDate(raw.start_time || raw.schedule?.start_time, nowIso);
  const endTime = toIsoDate(raw.end_time || raw.schedule?.end_time, startTime);

  const clubName = raw.club_name || raw.club || title;
  const clubRef = raw.club_ref || `clubs/${cleanSource}_${cleanSourceId}`;

  return {
    id,
    title,
    sport,
    type,
    venue: {
      name: venueName,
      address,
      coordinates: {
        lat: coords.lat,
        lng: coords.lng
      },
      geohash
    },
    schedule: {
      start_time: startTime,
      end_time: endTime,
      recurrence: raw.schedule?.recurrence || raw.recurrence || null
    },
    club_ref: clubRef,
    club_name: clubName,
    cost_description: costDescription,
    is_free: isFree,
    demographics: {
      gender,
      age
    },
    external_url: raw.external_url || raw.url || '',
    is_active: raw.is_active !== undefined ? Boolean(raw.is_active) : true,
    updated_at: toIsoDate(raw.updated_at, nowIso),
    created_at: toIsoDate(raw.created_at, nowIso)
  };
}
