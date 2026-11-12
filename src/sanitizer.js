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
  sundays: 0,
  sun: 0,
  monday: 1,
  mondays: 1,
  mon: 1,
  tuesday: 2,
  tuesdays: 2,
  tue: 2,
  wednesday: 3,
  wednesdays: 3,
  wed: 3,
  thursday: 4,
  thursdays: 4,
  thu: 4,
  friday: 5,
  fridays: 5,
  fri: 5,
  saturday: 6,
  saturdays: 6,
  sat: 6
};

const MONTH_NAME_TO_NUM = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
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
 * Extracts YYYY-MM-DD dates from ISO date strings, Australian DD/MM/YYYY strings,
 * or human-readable date strings (e.g. "08 Nov 2026 - 20 Dec 2026").
 *
 * @param {string} text
 * @returns {string[]} Array of YYYY-MM-DD strings
 */
function extractDatesFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  // 1. Exact YYYY-MM-DD date(s) without time
  const isoDates = [];
  for (const m of trimmed.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    isoDates.push(`${m[1]}-${m[2]}-${m[3]}`);
  }
  if (isoDates.length > 0) return isoDates;

  // 2. Australian slash date(s) DD/MM/YYYY
  const slashDates = [];
  for (const m of trimmed.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      slashDates.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }
  if (slashDates.length > 0) return slashDates;

  // 3. Human-readable day + month name + year (e.g. "8 November 2026", "08 Nov - 20 Dec 2026")
  const fallbackYearMatch = trimmed.match(/\b(20\d{2})\b/);
  const fallbackYear = fallbackYearMatch ? Number(fallbackYearMatch[1]) : null;
  const namedMatches = [];
  const namedRegex = /\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:[,\s]+(\d{4}))?\b/gi;
  for (const m of trimmed.matchAll(namedRegex)) {
    const day = Number(m[1]);
    const month = MONTH_NAME_TO_NUM[m[2].toLowerCase()];
    const year = m[3] ? Number(m[3]) : fallbackYear;
    if (month && day >= 1 && day <= 31 && year) {
      namedMatches.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }
  return namedMatches;
}

/**
 * Extracts 24-hour HH:mm time strings from 12-hour am/pm or 24-hour time expressions.
 *
 * @param {string} text
 * @returns {string[]} Array of HH:mm strings
 */
function extractTimesFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (/^\d{2}:\d{2}$/.test(trimmed)) {
    return [trimmed];
  }

  const amPmTimes = [];
  for (const m of trimmed.matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/gi)) {
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const meridiem = m[3].toLowerCase();
    if (hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59) {
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      amPmTimes.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    }
  }
  return amPmTimes;
}

/**
 * Parses raw date/time information into structured schedule fields in AWST.
 *
 * @param {object} raw
 * @param {string} [nowIso]
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

  let startDate = scheduleInput.start_date || raw.start_date || null;
  let startTime = scheduleInput.start_time || raw.start_time || null;
  let endDate = scheduleInput.end_date || raw.end_date || null;
  let endTime = scheduleInput.end_time || raw.end_time || null;
  let inferredDayOfWeek = null;

  // Check if startTime or startDate contains human-readable weekly recurrence or weekday names
  const scheduleTextCandidates = [startTime, startDate, endTime, endDate].filter((v) => typeof v === 'string');
  for (const text of scheduleTextCandidates) {
    if (/\b(every|weekly|sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)\b/i.test(text)) {
      recurrence = 'weekly';
    }
    const dayMatch = text.match(/\b(sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?)\b/i);
    if (dayMatch && inferredDayOfWeek === null) {
      inferredDayOfWeek = DAY_NAME_TO_INT[dayMatch[1].toLowerCase()];
    }
  }

  // Process start time if it contains an ISO timestamp (e.g. "2026-11-20T17:00:00+08:00")
  if (startTime && typeof startTime === 'string' && (startTime.includes('T') || /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(startTime))) {
    const parsedStart = new Date(startTime);
    if (!Number.isNaN(parsedStart.getTime())) {
      const awst = formatAwstDateTime(parsedStart);
      if (!startDate) {
        startDate = awst.date;
      }
      startTime = awst.time;
    }
  } else if (startTime && typeof startTime === 'string' && !/^\d{2}:\d{2}$/.test(startTime.trim())) {
    // Extract human-readable dates and times (e.g. from EventDisplayDate)
    const extractedDates = extractDatesFromText(startTime);
    const extractedTimes = extractTimesFromText(startTime);
    if (!startDate && extractedDates.length >= 1) {
      startDate = extractedDates[0];
    }
    if (!endDate && extractedDates.length >= 2) {
      endDate = extractedDates[1];
    }
    startTime = extractedTimes[0] || null;
    if (!endTime && extractedTimes.length >= 2) {
      endTime = extractedTimes[1];
    }
  }

  // Normalize startDate if it is a human-readable date string rather than YYYY-MM-DD
  if (startDate && typeof startDate === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(startDate.trim())) {
    const extractedDates = extractDatesFromText(startDate);
    startDate = extractedDates[0] || null;
    if (!endDate && extractedDates.length >= 2) {
      endDate = extractedDates[1];
    }
  }

  // Process end time if it contains an ISO timestamp
  if (endTime && typeof endTime === 'string' && (endTime.includes('T') || /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(endTime))) {
    const parsedEnd = new Date(endTime);
    if (!Number.isNaN(parsedEnd.getTime())) {
      const awst = formatAwstDateTime(parsedEnd);
      if (!endDate && recurrence === 'none') {
        endDate = awst.date;
      }
      endTime = awst.time;
    }
  } else if (endTime && typeof endTime === 'string' && !/^\d{2}:\d{2}$/.test(endTime.trim())) {
    const extractedDates = extractDatesFromText(endTime);
    const extractedTimes = extractTimesFromText(endTime);
    if (!endDate && extractedDates.length >= 1 && recurrence === 'none') {
      endDate = extractedDates[extractedDates.length - 1];
    }
    endTime = extractedTimes[0] || null;
  }

  // Normalize endDate if it is a human-readable date string rather than YYYY-MM-DD
  if (endDate && typeof endDate === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(endDate.trim())) {
    const extractedDates = extractDatesFromText(endDate);
    endDate = extractedDates[extractedDates.length - 1] || null;
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
  } else if (inferredDayOfWeek !== null) {
    dayOfWeek = inferredDayOfWeek;
  }

  if (dayOfWeek === null && startDate) {
    const dateObj = new Date(`${startDate}T12:00:00Z`);
    if (!Number.isNaN(dateObj.getTime())) {
      dayOfWeek = dateObj.getUTCDay();
    }
  }

  return {
    start_date: startDate || null,
    end_date: endDate || null,
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
  const verifiedReferralUrl = activity.verified !== false ? (activity.source_url || raw.external_url || null) : null;
  const organizerWebsite = raw.website || raw.organizer?.website || raw.club_website || verifiedReferralUrl || null;
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
  const candidateUrl = raw.source_url || raw.external_url || raw.url || '';
  const trimmedUrl = typeof candidateUrl === 'string' ? candidateUrl.trim() : '';
  const rawSourceUrl = typeof raw.raw_source_url === 'string' && raw.raw_source_url.trim()
    ? raw.raw_source_url.trim()
    : (trimmedUrl || null);
  const hasValidUrl = Boolean(trimmedUrl);
  const verified = raw.verified !== undefined ? (Boolean(raw.verified) && hasValidUrl) : hasValidUrl;
  const sourceUrl = verified ? trimmedUrl : null;
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

  const createdAt = raw.created_at || nowIso;
  const updatedAt = raw.updated_at || nowIso;

  return {
    id,
    region_id: regionId,
    source: cleanSource,
    source_id: cleanSourceId,
    source_url: sourceUrl,
    raw_source_url: rawSourceUrl,
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
