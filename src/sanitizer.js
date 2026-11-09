/**
 * Activity Data Sanitizer and Normalizer
 * Enforces canonical domain schema (GLOSSARY.md and ADR 0001),
 * derives precision-9 Base32 geohashes, normalizes sports taxonomy,
 * structures AWST schedules, and extracts multi-collection entities.
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
 * Creates a clean snake_case slug from a string.
 *
 * @param {string} str
 * @returns {string}
 */
export function slugify(str = '') {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
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

const DAY_NAME_TO_INT = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6
};

/**
 * Formats a Date object or timestamp into AWST (UTC+08:00) date and time strings.
 *
 * @param {Date} date
 * @returns {{ date: string, time: string }}
 */
function formatAwstDateTime(date) {
  // AWST is UTC+8 with no daylight saving time
  const awstDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);

  const awstTimeStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Australia/Perth',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);

  return { date: awstDateStr, time: awstTimeStr };
}

/**
 * Parses raw date/time information into structured schedule fields in AWST.
 *
 * @param {object} raw
 * @param {string} nowIso
 * @returns {object} Canonical schedule object
 */
export function parseSchedule(raw, nowIso) {
  const scheduleInput = raw.schedule || {};

  // Check recurrence
  let recurrence = 'none';
  const rawRecurrence = scheduleInput.recurrence || raw.recurrence;
  if (
    rawRecurrence === 'weekly' ||
    (typeof rawRecurrence === 'object' && rawRecurrence?.pattern === 'weekly')
  ) {
    recurrence = 'weekly';
  }

  let startDate = scheduleInput.start_date || raw.start_date;
  let startTime = scheduleInput.start_time || raw.start_time;
  let endDate = scheduleInput.end_date || raw.end_date || null;
  let endTime = scheduleInput.end_time || raw.end_time || null;

  // Process start time if it contains an ISO timestamp
  if (startTime && typeof startTime === 'string' && (startTime.includes('T') || (startTime.includes('-') && startTime.includes(':')))) {
    const parsedStart = new Date(startTime);
    if (!Number.isNaN(parsedStart.getTime())) {
      const awst = formatAwstDateTime(parsedStart);
      if (!startDate) {
        startDate = awst.date;
      }
      startTime = awst.time;
    }
  }

  // Process end time if it contains an ISO timestamp
  if (endTime && typeof endTime === 'string' && (endTime.includes('T') || (endTime.includes('-') && endTime.includes(':')))) {
    const parsedEnd = new Date(endTime);
    if (!Number.isNaN(parsedEnd.getTime())) {
      const awst = formatAwstDateTime(parsedEnd);
      if (!endDate && recurrence === 'none') {
        endDate = awst.date;
      }
      endTime = awst.time;
    }
  }

  // Ensure start_date defaults to today in AWST if missing
  if (!startDate) {
    startDate = formatAwstDateTime(new Date(nowIso)).date;
  }

  // Weekly recurring activities have null end_date by canonical specification
  if (recurrence === 'weekly') {
    endDate = null;
  }

  // Validate format of HH:mm
  const timeRegex = /^\d{2}:\d{2}$/;
  if (startTime && !timeRegex.test(startTime)) {
    startTime = null;
  }
  if (endTime && !timeRegex.test(endTime)) {
    endTime = null;
  }

  // Determine day_of_week
  let dayOfWeek = null;
  const rawDayOfWeek = scheduleInput.day_of_week ?? raw.day_of_week ?? scheduleInput.recurrence?.day_of_week ?? raw.recurrence?.day_of_week;
  if (typeof rawDayOfWeek === 'number' && rawDayOfWeek >= 0 && rawDayOfWeek <= 6) {
    dayOfWeek = rawDayOfWeek;
  } else if (typeof rawDayOfWeek === 'string') {
    const lower = rawDayOfWeek.toLowerCase().trim();
    if (lower in DAY_NAME_TO_INT) {
      dayOfWeek = DAY_NAME_TO_INT[lower];
    }
  }

  if (dayOfWeek === null && startDate) {
    const dateObj = new Date(`${startDate}T12:00:00Z`);
    if (!Number.isNaN(dateObj.getTime())) {
      dayOfWeek = dateObj.getUTCDay();
    }
  }

  return {
    start_date: startDate,
    end_date: endDate,
    start_time: startTime || null,
    end_time: endTime || null,
    recurrence,
    day_of_week: dayOfWeek
  };
}

/**
 * Normalizes gender to "all" | "women_only" | "men_only".
 *
 * @param {string} rawGender
 * @returns {"all" | "women_only" | "men_only"}
 */
export function normalizeGender(rawGender = '') {
  const g = String(rawGender).toLowerCase().trim();
  if (g === 'women' || g === 'women_only' || g === 'female') return 'women_only';
  if (g === 'men' || g === 'men_only' || g === 'male') return 'men_only';
  return 'all';
}

/**
 * Normalizes age to "all" | "adults" | "juniors" | "masters".
 *
 * @param {string} rawAge
 * @returns {"all" | "adults" | "juniors" | "masters"}
 */
export function normalizeAge(rawAge = '') {
  const a = String(rawAge).toLowerCase().trim();
  if (['adults', 'juniors', 'masters'].includes(a)) return a;
  return 'all';
}

/**
 * Standard region definitions.
 */
export const CANONICAL_REGIONS = {
  perth: {
    id: 'perth',
    name: 'Greater Perth',
    coordinates: { lat: -31.9505, lng: 115.8605 },
    default_radius_km: 25
  }
};

/**
 * Gets canonical region document.
 *
 * @param {string} regionId
 * @param {string} updatedAt
 * @returns {object}
 */
export function getCanonicalRegion(regionId = 'perth', updatedAt = new Date().toISOString()) {
  const base = CANONICAL_REGIONS[regionId] || {
    id: regionId,
    name: regionId.charAt(0).toUpperCase() + regionId.slice(1),
    coordinates: { lat: 0, lng: 0 },
    default_radius_km: 25
  };

  return {
    ...base,
    updated_at: updatedAt
  };
}

/**
 * Extracts canonical multi-collection entity documents (/activities, /venues, /organizers, /regions).
 *
 * @param {object} activity - Canonical ActivityDocument
 * @param {object} [raw={}] - Raw un-sanitized listing input
 * @returns {{ activity: object, venue: object, organizer: object, region: object }}
 */
export function extractCanonicalEntities(activity, raw = {}) {
  const venueAddress = raw.address || raw.venue?.address || activity.venue?.address || activity.venue?.name;
  const organizerWebsite = raw.website || raw.organizer?.website || raw.club_website || raw.external_url || activity.source_url || null;
  const organizerContact = raw.contact || raw.organizer?.contact || {
    email: raw.email || raw.organizer?.email || null,
    phone: raw.phone || raw.organizer?.phone || null
  };

  const venue = {
    id: activity.venue.id,
    name: activity.venue.name,
    address: venueAddress,
    coordinates: {
      lat: activity.venue.coordinates.lat,
      lng: activity.venue.coordinates.lng
    },
    geohash: activity.venue.geohash,
    region_id: activity.region_id,
    updated_at: activity.updated_at
  };

  const organizer = {
    id: activity.organizer.id,
    name: activity.organizer.name,
    website: organizerWebsite,
    contact: organizerContact,
    updated_at: activity.updated_at
  };

  const region = getCanonicalRegion(activity.region_id, activity.updated_at);

  return {
    activity,
    venue,
    organizer,
    region
  };
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

  const coords = raw.coordinates || raw.venue?.coordinates || (raw.lat !== undefined && raw.lng !== undefined ? { lat: raw.lat, lng: raw.lng } : null);
  if (!coords || typeof coords.lat !== 'number' || typeof coords.lng !== 'number' || Number.isNaN(coords.lat) || Number.isNaN(coords.lng)) {
    throw new SanitizationError('Missing valid coordinates: venue coordinates { lat, lng } are required', { raw });
  }

  const cleanSource = String(raw.source).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const cleanSourceId = String(raw.source_id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const id = `${cleanSource}_${cleanSourceId}`;

  const regionId = raw.region_id || options.regionId || 'perth';
  const sourceUrl = raw.source_url || raw.external_url || raw.url || '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';

  const category = 'sports';
  const subcategory = normalizeSport(raw.subcategory || raw.sport || raw.category || '');

  // Venue extraction
  const venueName = raw.venue_name || raw.venue?.name || title;
  const geohash = raw.geohash || raw.venue?.geohash || encodeGeohash(coords.lat, coords.lng, 9);
  const geohash6 = geohash.slice(0, 6);
  const venueSlug = slugify(venueName) || 'venue';
  const venueId = raw.venue?.id || `venue_${venueSlug}_${geohash6}`;

  // Organizer extraction
  const organizerName = raw.organizer?.name || raw.organizer_name || raw.club_name || raw.club?.name || raw.club || title;
  const organizerSlug = slugify(organizerName) || 'unknown';
  const organizerId = raw.organizer?.id || `org_${organizerSlug}`;

  // Cost extraction
  const costDescription = raw.cost_description || raw.display_price || raw.cost?.display_price || (raw.is_free ? 'Free' : '');
  const isFree = determineIsFree(costDescription, raw.is_free ?? raw.cost?.is_free);
  const displayPrice = costDescription || (isFree ? 'Free' : '');

  // Demographics extraction
  const rawGender = raw.demographics?.gender || raw.gender || 'all';
  const rawAge = raw.demographics?.age || raw.age || 'all';
  const gender = normalizeGender(rawGender);
  const age = normalizeAge(rawAge);

  const nowIso = new Date().toISOString();
  const schedule = parseSchedule(raw, nowIso);

  const verified = raw.verified !== undefined ? Boolean(raw.verified) : true;
  const createdAt = raw.created_at || nowIso;
  const updatedAt = raw.updated_at || nowIso;

  return {
    id,
    region_id: regionId,
    source: cleanSource,
    source_id: cleanSourceId,
    source_url: sourceUrl,
    title,
    description,
    category,
    subcategory,
    organizer: {
      id: organizerId,
      name: organizerName
    },
    venue: {
      id: venueId,
      name: venueName,
      coordinates: {
        lat: coords.lat,
        lng: coords.lng
      },
      geohash
    },
    schedule,
    cost: {
      is_free: isFree,
      display_price: displayPrice
    },
    demographics: {
      gender,
      age
    },
    verified,
    created_at: createdAt,
    updated_at: updatedAt
  };
}
