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
 * Normalizes an array or delimited string of sport values into deduplicated canonical sport slugs.
 * Drops fallback `'other'` entries when concrete sports are present.
 *
 * @param {object | Array<string> | string} [rawOrInput={}]
 * @param {string} [fallbackSubcategory='']
 * @returns {string[]}
 */
export function normalizeSubcategories(rawOrInput = {}, fallbackSubcategory = '') {
  const candidates = [];
  const pushValues = (val) => {
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string' && item.trim()) {
          candidates.push(item.trim());
        }
      }
    } else if (typeof val === 'string' && val.trim()) {
      for (const part of val.split(/[,;|/]+/)) {
        if (part.trim()) {
          candidates.push(part.trim());
        }
      }
    }
  };

  if (Array.isArray(rawOrInput) || typeof rawOrInput === 'string') {
    pushValues(rawOrInput);
  } else if (rawOrInput && typeof rawOrInput === 'object') {
    pushValues(rawOrInput.subcategories);
    pushValues(rawOrInput.sports);
    pushValues(rawOrInput.subcategory);
    pushValues(rawOrInput.sport);
  }

  const normalized = [];
  for (const candidate of candidates) {
    const slug = normalizeSport(candidate);
    if (!normalized.includes(slug)) {
      normalized.push(slug);
    }
  }

  const concrete = normalized.filter(s => s !== 'other');
  if (concrete.length > 0) {
    return concrete;
  }

  if (normalized.length > 0) {
    return normalized;
  }

  return [normalizeSport(fallbackSubcategory)];
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
 * Validates and extracts numeric `{ lat, lng }` coordinates from a raw record.
 *
 * @param {object} raw
 * @param {string} [errorMessage]
 * @returns {{ lat: number, lng: number }}
 */
function extractValidCoordinates(raw, errorMessage = 'Missing valid coordinates: { lat, lng } are required') {
  const coords = raw.coordinates || raw.venue?.coordinates || (raw.lat !== undefined && raw.lng !== undefined ? { lat: raw.lat, lng: raw.lng } : null);
  if (!coords || typeof coords.lat !== 'number' || typeof coords.lng !== 'number' || Number.isNaN(coords.lat) || Number.isNaN(coords.lng)) {
    throw new SanitizationError(errorMessage, { raw });
  }
  return { lat: coords.lat, lng: coords.lng };
}

/**
 * Resolves verification status, canonical `source_url`, and preserved `raw_source_url`.
 *
 * @param {object} raw
 * @param {string} [fallbackUrl='']
 * @returns {{ source_url: string | null, raw_source_url: string | null, verified: boolean }}
 */
function resolveVerificationFields(raw, fallbackUrl = '') {
  const candidateUrl = raw.source_url || raw.external_url || raw.url || fallbackUrl || '';
  const trimmedUrl = typeof candidateUrl === 'string' ? candidateUrl.trim() : '';
  const rawSourceUrl = typeof raw.raw_source_url === 'string' && raw.raw_source_url.trim()
    ? raw.raw_source_url.trim()
    : (trimmedUrl || null);
  const hasValidUrl = Boolean(trimmedUrl);
  const verified = raw.verified !== undefined ? (Boolean(raw.verified) && hasValidUrl) : hasValidUrl;
  const sourceUrl = verified ? trimmedUrl : null;
  return {
    source_url: sourceUrl,
    raw_source_url: rawSourceUrl,
    verified
  };
}

/**
 * Extracts normalized demographics `{ gender, age }` from a raw record.
 *
 * @param {object} raw
 * @returns {{ gender: "all" | "women_only" | "men_only", age: "all" | "adults" | "juniors" | "masters" }}
 */
function extractDemographics(raw) {
  const rawGender = raw.demographics?.gender || raw.gender || 'all';
  const rawAge = raw.demographics?.age || raw.age || 'all';
  return {
    gender: normalizeGender(rawGender),
    age: normalizeAge(rawAge)
  };
}

/**
 * Resolves verification fields for an extracted Organizer or Venue entity,
 * avoiding marking unprobed website links as verified unless explicitly verified
 * or matching the already-verified Activity referral URL.
 *
 * @param {object} entityInput
 * @param {string | null} verifiedReferralUrl
 * @param {string | null} rawReferralUrl
 * @param {boolean} activityVerified
 * @param {string | null} [fallbackRawUrl=null]
 * @returns {{ source_url: string | null, raw_source_url: string | null, verified: boolean }}
 */
function resolveExtractedEntityVerification(entityInput = {}, verifiedReferralUrl, rawReferralUrl, activityVerified, fallbackRawUrl = null) {
  const entitySourceUrl = typeof entityInput.source_url === 'string' && entityInput.source_url.trim()
    ? entityInput.source_url.trim()
    : null;
  const entityRawUrl = typeof entityInput.raw_source_url === 'string' && entityInput.raw_source_url.trim()
    ? entityInput.raw_source_url.trim()
    : null;

  if (entityInput.verified === false) {
    return {
      source_url: null,
      raw_source_url: entityRawUrl || entitySourceUrl || fallbackRawUrl || rawReferralUrl || null,
      verified: false
    };
  }

  if (entityInput.verified === true) {
    const resolvedUrl = entitySourceUrl || (activityVerified ? verifiedReferralUrl : null);
    return {
      source_url: resolvedUrl,
      raw_source_url: entityRawUrl || resolvedUrl || fallbackRawUrl || rawReferralUrl || null,
      verified: Boolean(resolvedUrl)
    };
  }

  // Inherit verification strictly from the Activity's verified referral URL (never mark an unprobed website verified)
  const resolvedUrl = activityVerified ? (entitySourceUrl || verifiedReferralUrl || null) : null;
  return {
    source_url: resolvedUrl,
    raw_source_url: entityRawUrl || entitySourceUrl || rawReferralUrl || fallbackRawUrl || null,
    verified: Boolean(resolvedUrl)
  };
}

/**
 * Merges two canonical Organizer or Venue documents referencing the same deterministic ID,
 * combining `subcategories` arrays and preserving populated metadata.
 *
 * @param {object} prevDoc
 * @param {object} nextDoc
 * @returns {object}
 */
export function mergeEntityDocuments(prevDoc, nextDoc) {
  const rawSports = [
    ...(Array.isArray(prevDoc.subcategories) ? prevDoc.subcategories : []),
    ...(prevDoc.subcategory ? [prevDoc.subcategory] : []),
    ...(Array.isArray(nextDoc.subcategories) ? nextDoc.subcategories : []),
    ...(nextDoc.subcategory ? [nextDoc.subcategory] : [])
  ];
  const mergedSubcategories = normalizeSubcategories(rawSports);
  const primarySubcategory = mergedSubcategories[0] || nextDoc.subcategory || prevDoc.subcategory || 'other';

  const sourceUrl = nextDoc.source_url || prevDoc.source_url || null;
  const rawSourceUrl = nextDoc.raw_source_url || prevDoc.raw_source_url || null;
  const verified = Boolean(sourceUrl) && Boolean(nextDoc.verified || prevDoc.verified);

  const merged = {
    ...prevDoc,
    ...nextDoc,
    description: nextDoc.description || prevDoc.description || '',
    address: nextDoc.address || prevDoc.address || '',
    subcategory: primarySubcategory,
    subcategories: mergedSubcategories,
    source_url: sourceUrl,
    raw_source_url: rawSourceUrl,
    verified
  };

  if ('website' in prevDoc || 'website' in nextDoc) {
    merged.website = nextDoc.website || prevDoc.website || null;
  }
  if ('cost_description' in prevDoc || 'cost_description' in nextDoc) {
    merged.cost_description = nextDoc.cost_description || prevDoc.cost_description || '';
  }
  if (prevDoc.contact || nextDoc.contact) {
    merged.contact = {
      email: nextDoc.contact?.email || prevDoc.contact?.email || null,
      phone: nextDoc.contact?.phone || prevDoc.contact?.phone || null
    };
  }

  return merged;
}

/**
 * Extracts canonical multi-collection entity documents (/activities, /venues, /organizers, /regions).
 *
 * @param {object} activity - Canonical ActivityDocument
 * @param {object} [raw={}] - Raw un-sanitized listing input
 * @returns {{ activity: object, venue: object, organizer: object, region: object }}
 */
export function extractCanonicalEntities(activity, raw = {}) {
  const regionId = activity.region_id || raw.region_id || 'perth';
  const updatedAt = activity.updated_at || new Date().toISOString();
  const venueCoords = activity.venue?.coordinates || raw.coordinates || raw.venue?.coordinates || { lat: 0, lng: 0 };
  const venueGeohash = activity.venue?.geohash || raw.venue?.geohash || encodeGeohash(venueCoords.lat, venueCoords.lng, 9);
  const venueAddress = raw.address || raw.venue?.address || activity.venue?.address || activity.venue?.name || '';

  const activitySubcategory = activity.subcategory || normalizeSport(raw.subcategory || raw.sport || raw.category || '');
  const subcategories = normalizeSubcategories(
    {
      subcategories: raw.subcategories || activity.subcategories,
      sports: raw.sports,
      subcategory: activitySubcategory
    },
    activitySubcategory
  );
  const primarySubcategory = subcategories[0] || activitySubcategory || 'other';
  const category = activity.category || (typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim().toLowerCase() : 'sports');

  const activityVerified = activity.verified !== false;
  const verifiedReferralUrl = activityVerified ? (activity.source_url || raw.external_url || null) : null;
  const rawReferralUrl = activity.raw_source_url ?? raw.raw_source_url ?? activity.source_url ?? raw.source_url ?? raw.external_url ?? null;

  const explicitWebsite = raw.website || raw.organizer?.website || raw.club_website || null;
  const organizerWebsite = explicitWebsite || verifiedReferralUrl || null;
  const organizerVerification = resolveExtractedEntityVerification(
    raw.organizer,
    verifiedReferralUrl,
    rawReferralUrl,
    activityVerified,
    explicitWebsite
  );

  const venueVerification = resolveExtractedEntityVerification(
    raw.venue,
    verifiedReferralUrl,
    rawReferralUrl,
    activityVerified
  );

  const organizerContact = raw.contact || raw.organizer?.contact || {
    email: raw.email || raw.organizer?.email || null,
    phone: raw.phone || raw.organizer?.phone || null
  };

  const venue = {
    id: activity.venue?.id,
    region_id: regionId,
    name: activity.venue?.name || raw.venue_name || '',
    description: typeof raw.venue?.description === 'string' ? raw.venue.description.trim() : '',
    address: venueAddress,
    coordinates: {
      lat: venueCoords.lat,
      lng: venueCoords.lng
    },
    geohash: venueGeohash,
    category,
    subcategory: primarySubcategory,
    subcategories,
    source_url: venueVerification.source_url,
    raw_source_url: venueVerification.raw_source_url,
    verified: venueVerification.verified,
    updated_at: updatedAt
  };

  const organizer = {
    id: activity.organizer?.id,
    region_id: regionId,
    name: activity.organizer?.name || '',
    description: typeof (raw.organizer?.description ?? raw.description ?? activity.description) === 'string'
      ? String(raw.organizer?.description ?? raw.description ?? activity.description).trim()
      : '',
    address: raw.organizer?.address || venueAddress || '',
    coordinates: {
      lat: venueCoords.lat,
      lng: venueCoords.lng
    },
    geohash: venueGeohash,
    category,
    subcategory: primarySubcategory,
    subcategories,
    website: organizerWebsite,
    contact: organizerContact,
    cost_description: raw.organizer?.cost_description || raw.cost_description || activity.cost?.display_price || '',
    demographics: raw.organizer?.demographics || activity.demographics || extractDemographics(raw),
    source_url: organizerVerification.source_url,
    raw_source_url: organizerVerification.raw_source_url,
    verified: organizerVerification.verified,
    updated_at: updatedAt
  };

  const region = getCanonicalRegion(regionId, updatedAt);

  return {
    activity,
    venue,
    organizer,
    region
  };
}

/**
 * Shared validation and normalization for standalone Organizer and Venue Listings.
 *
 * @param {object} raw
 * @param {object} options
 * @param {'organizer' | 'venue'} kind
 * @returns {object}
 */
function sanitizeEntityListingBase(raw = {}, options = {}, kind) {
  const hasSourceIdentity = Boolean(raw.source && raw.source_id);
  const explicitId = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!hasSourceIdentity && !explicitId) {
    throw new SanitizationError('Missing required source identity (source and source_id, or id required)', { raw });
  }

  const rawName = typeof raw.name === 'string' ? raw.name.trim() : (typeof raw.title === 'string' ? raw.title.trim() : '');
  if (!rawName) {
    throw new SanitizationError('Missing required field: name', { raw });
  }

  const coords = extractValidCoordinates(raw, `Missing valid coordinates: ${kind} coordinates { lat, lng } are required`);
  const geohash = encodeGeohash(coords.lat, coords.lng, 9);
  const geohash6 = geohash.slice(0, 6);
  const slug = slugify(rawName) || (kind === 'organizer' ? 'unknown' : 'venue');
  const prefix = kind === 'organizer' ? 'org_' : 'venue_';
  let id;
  if (explicitId) {
    id = explicitId.startsWith(prefix)
      ? explicitId
      : (kind === 'organizer' ? `org_${slugify(explicitId) || slug}` : `venue_${slugify(explicitId) || slug}_${geohash6}`);
  } else {
    id = kind === 'organizer' ? `org_${slug}` : `venue_${slug}_${geohash6}`;
  }

  const regionId = raw.region_id || options.regionId || 'perth';
  const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim().toLowerCase() : 'sports';
  const subcategories = normalizeSubcategories(raw);
  const subcategory = subcategories[0] || 'other';
  const updatedAt = raw.updated_at || new Date().toISOString();

  return {
    id,
    region_id: regionId,
    name: rawName,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    coordinates: coords,
    geohash,
    category,
    subcategory,
    subcategories,
    updated_at: updatedAt
  };
}

/**
 * Sanitizes a raw crawled record into a canonical Organizer Listing document.
 *
 * @param {object} [raw={}]
 * @param {object} [options={}]
 * @returns {object} Canonical Organizer Listing
 */
export function sanitizeOrganizer(raw = {}, options = {}) {
  const base = sanitizeEntityListingBase(raw, options, 'organizer');
  const website = typeof raw.website === 'string' && raw.website.trim() ? raw.website.trim() : null;
  const verification = resolveVerificationFields(raw, website || '');

  const contactInput = raw.contact || {};
  const contact = {
    email: contactInput.email || raw.email || null,
    phone: contactInput.phone || raw.phone || null
  };

  return {
    ...base,
    address: typeof raw.address === 'string' ? raw.address.trim() : '',
    website: verification.verified ? (website || verification.source_url) : website,
    contact,
    cost_description: typeof raw.cost_description === 'string' ? raw.cost_description.trim() : '',
    demographics: extractDemographics(raw),
    source_url: verification.source_url,
    raw_source_url: verification.raw_source_url,
    verified: verification.verified
  };
}

/**
 * Sanitizes a raw crawled record into a canonical Venue Listing document.
 *
 * @param {object} [raw={}]
 * @param {object} [options={}]
 * @returns {object} Canonical Venue Listing
 */
export function sanitizeVenue(raw = {}, options = {}) {
  const base = sanitizeEntityListingBase(raw, options, 'venue');
  const verification = resolveVerificationFields(raw);
  const address = typeof raw.address === 'string' && raw.address.trim() ? raw.address.trim() : base.name;

  return {
    ...base,
    address,
    source_url: verification.source_url,
    raw_source_url: verification.raw_source_url,
    verified: verification.verified
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

  const coords = extractValidCoordinates(raw, 'Missing valid coordinates: venue coordinates { lat, lng } are required');

  const cleanSource = String(raw.source).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const cleanSourceId = String(raw.source_id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const id = `${cleanSource}_${cleanSourceId}`;

  const regionId = raw.region_id || options.regionId || 'perth';
  const { source_url: sourceUrl, raw_source_url: rawSourceUrl, verified } = resolveVerificationFields(raw);
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
  const demographics = extractDemographics(raw);

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
    demographics,
    verified,
    created_at: createdAt,
    updated_at: updatedAt
  };
}

/**
 * Resolves the canonical listing type ('organizer' | 'venue' | 'activity') for a raw record.
 *
 * @param {object} [raw={}]
 * @returns {'organizer' | 'venue' | 'activity'}
 */
export function resolveListingType(raw = {}) {
  if (!raw || typeof raw !== 'object') {
    return 'activity';
  }
  const explicit = raw.entity_type || raw.listing_type || raw.type || raw.kind;
  if (typeof explicit === 'string') {
    const normalized = explicit.trim().toLowerCase();
    if (normalized === 'organizer' || normalized === 'venue' || normalized === 'activity') {
      return normalized;
    }
  }
  if (typeof raw.id === 'string') {
    if (raw.id.startsWith('org_') && !raw.venue && !raw.schedule) {
      return 'organizer';
    }
    if (raw.id.startsWith('venue_') && !raw.organizer && !raw.schedule) {
      return 'venue';
    }
  }
  return 'activity';
}

/**
 * Sanitizes a raw crawled record according to its resolved listing type.
 *
 * @param {object} [raw={}]
 * @param {object} [options={}]
 * @returns {object} Canonical Organizer, Venue, or Activity document
 */
export function sanitizeListing(raw = {}, options = {}) {
  const type = resolveListingType(raw);
  if (type === 'organizer') {
    return sanitizeOrganizer(raw, options);
  }
  if (type === 'venue') {
    return sanitizeVenue(raw, options);
  }
  return sanitizeActivity(raw, options);
}
