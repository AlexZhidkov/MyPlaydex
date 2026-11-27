/**
 * Pure Humanitix search SSR & API extraction, normalization, pre-ingestion filtering,
 * and canonical Listing mapping helpers (no network or side effects).
 */

import {
  normalizeCategory,
  normalizeSport,
  resolveActivitySubcategory
} from '../sanitizer.js';
import { PERTH_SUBURB_CENTROIDS, getSuburbByPostcodeOrName } from '../../public/shared/perth-centroids.js';
import { calculateDistanceKm } from '../../public/shared/discovery-engine.js';
import {
  inferDemographics,
  PERTH_CENTER,
  MAX_PERTH_RADIUS_KM
} from './eventbrite-parser.js';

const AWST_OFFSET_MS = 8 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FINITE_WEEKLY_HORIZON_MS = 183 * ONE_DAY_MS;
const SUBURBS_BY_LENGTH = [...PERTH_SUBURB_CENTROIDS].sort((a, b) => b.name.length - a.name.length);

const NON_WA_STATES = new Set([
  'nsw', 'new south wales',
  'vic', 'victoria',
  'qld', 'queensland',
  'sa', 'south australia',
  'tas', 'tasmania',
  'nt', 'northern territory',
  'act', 'australian capital territory'
]);

const NOISE_TITLE_PATTERNS = [
  /\bdonation(s)?\b/i,
  /\bdonate\b/i,
  /\b(player|club|season|annual)\s+membership\b/i,
  /\b(sharepoint|microsoft\s*365|power\s*bi|excel\s+training|bni\b|expression\s+of\s+interest|\beoi\b|\bagm\b|annual\s+general\s+meeting|grant\s+writing)\b/i
];

/**
 * Extracts Humanitix search SSR state (`initialEvents`, `geobox`, `stateKey`, `locale`)
 * from `<script id="__NEXT_DATA__">` in a search page HTML document.
 *
 * @param {string} [html='']
 * @returns {{ initialEvents: Array<object>, geobox: object|null, stateKey: string|null, locale: string|null }}
 */
export function extractHumanitixNextData(html = '') {
  if (!html || typeof html !== 'string') {
    return { initialEvents: [], geobox: null, stateKey: null, locale: null };
  }

  const match = /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match?.[1]) {
    return { initialEvents: [], geobox: null, stateKey: null, locale: null };
  }

  try {
    const parsed = JSON.parse(match[1]);
    const pp = parsed?.props?.pageProps || {};
    return {
      initialEvents: Array.isArray(pp.initialEvents) ? pp.initialEvents : [],
      geobox: pp.geobox && typeof pp.geobox === 'object' ? pp.geobox : null,
      stateKey: typeof pp.initialStateKey === 'string' ? pp.initialStateKey : null,
      locale: typeof pp.locale === 'string' ? pp.locale : null
    };
  } catch {
    return { initialEvents: [], geobox: null, stateKey: null, locale: null };
  }
}

/**
 * Builds the canonical Humanitix event URL from `hostname` and `slug`.
 *
 * @param {object} [item={}]
 * @returns {string}
 */
export function buildHumanitixEventUrl(item = {}) {
  const slug = typeof item.slug === 'string' ? item.slug.trim().replace(/^\/+/, '') : '';
  if (!slug) return '';
  const rawHost = typeof item.hostname === 'string' && item.hostname.trim()
    ? item.hostname.trim()
    : 'https://events.humanitix.com/';
  const baseHost = rawHost.endsWith('/') ? rawHost : `${rawHost}/`;
  try {
    return new URL(slug, baseHost).toString();
  } catch {
    return `https://events.humanitix.com/${slug}`;
  }
}

function toAwstParts(ms) {
  const awst = new Date(ms + AWST_OFFSET_MS);
  const iso = awst.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
    dayOfWeek: awst.getUTCDay()
  };
}

function parseOccurrence(entry) {
  if (!entry || typeof entry !== 'object' || !entry.startDate) return null;
  const startMs = Date.parse(entry.startDate);
  if (!Number.isFinite(startMs)) return null;
  const rawEndMs = entry.endDate ? Date.parse(entry.endDate) : NaN;
  const endMs = Number.isFinite(rawEndMs) && rawEndMs >= startMs ? rawEndMs : null;

  const startParts = toAwstParts(startMs);
  const endParts = endMs !== null ? toAwstParts(endMs) : null;

  return {
    id: entry._id !== undefined && entry._id !== null ? String(entry._id) : '',
    startMs,
    endMs,
    startDateAwst: startParts.date,
    startTimeAwst: startParts.time,
    endDateAwst: endParts ? endParts.date : startParts.date,
    endTimeAwst: endParts ? endParts.time : null,
    dayOfWeek: startParts.dayOfWeek
  };
}

/**
 * Resolves the canonical schedule for a Humanitix event in AWST,
 * detecting regular weekly recurring series and distinguishing finite term series
 * (<= 6 months) from indefinite recurring series (> 6 months).
 *
 * @param {object} [item={}]
 * @param {Date|string|number} [now=new Date()]
 * @returns {object|null}
 */
export function resolveHumanitixSchedule(item = {}, now = new Date()) {
  const parsedNow = now instanceof Date ? now : new Date(now);
  const nowMs = Number.isFinite(parsedNow.getTime()) ? parsedNow.getTime() : Date.now();

  const offSaleSet = new Set(
    Array.isArray(item.offSaleDateIds) ? item.offSaleDateIds.map(id => String(id)) : []
  );

  const rawDates = Array.isArray(item.dates) && item.dates.length > 0
    ? item.dates
    : (item.date ? [item.date] : []);

  const upcoming = rawDates
    .map(parseOccurrence)
    .filter(occ => occ !== null)
    .filter(occ => !occ.id || !offSaleSet.has(occ.id))
    .filter(occ => (occ.endMs ?? occ.startMs) > nowMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (upcoming.length === 0) {
    return null;
  }

  const first = upcoming[0];

  if (item.isRecurring === true && upcoming.length >= 3) {
    const firstMidnightAwst = Date.parse(`${first.startDateAwst}T00:00:00+08:00`);
    const weeklyAligned = upcoming.filter(occ => {
      if (occ.dayOfWeek !== first.dayOfWeek || occ.startTimeAwst !== first.startTimeAwst) {
        return false;
      }
      const occMidnightAwst = Date.parse(`${occ.startDateAwst}T00:00:00+08:00`);
      const diffDays = Math.round((occMidnightAwst - firstMidnightAwst) / ONE_DAY_MS);
      return diffDays >= 0 && diffDays % 7 === 0;
    });

    if (weeklyAligned.length >= 3) {
      const last = weeklyAligned[weeklyAligned.length - 1];
      const isFiniteTerm = (last.startMs - nowMs) <= FINITE_WEEKLY_HORIZON_MS;
      return {
        recurrence: 'weekly',
        start_date: first.startDateAwst,
        end_date: isFiniteTerm ? last.endDateAwst : null,
        start_time: first.startTimeAwst,
        end_time: first.endTimeAwst,
        day_of_week: first.dayOfWeek
      };
    }
  }

  return {
    recurrence: 'none',
    start_date: first.startDateAwst,
    end_date: first.endDateAwst || first.startDateAwst,
    start_time: first.startTimeAwst,
    end_time: first.endTimeAwst,
    day_of_week: first.dayOfWeek
  };
}

function getAddressComponent(components, targetType) {
  if (!Array.isArray(components)) return { long: '', short: '' };
  const match = components.find(c => Array.isArray(c?.types) && c.types.includes(targetType));
  return {
    long: typeof match?.long_name === 'string' ? match.long_name.trim() : '',
    short: typeof match?.short_name === 'string' ? match.short_name.trim() : ''
  };
}

/**
 * Resolves and validates a Greater Perth physical location from Humanitix `eventLocation`.
 * Returns `null` for online/non-address events, non-WA locations, or venues >85 km from Perth CBD.
 *
 * @param {object} [item={}]
 * @returns {{ venueName: string, address: string, coordinates: { lat: number, lng: number } } | null}
 */
export function resolveHumanitixLocation(item = {}) {
  const loc = item?.eventLocation;
  if (!loc || loc.type !== 'address') {
    return null;
  }

  const components = loc.addressComponents;
  const locality = getAddressComponent(components, 'locality');
  const state = getAddressComponent(components, 'administrative_area_level_1');
  const country = getAddressComponent(components, 'country');
  const postalCode = getAddressComponent(components, 'postal_code');

  const countryNorm = (country.short || country.long).toLowerCase();
  if (countryNorm && countryNorm !== 'au' && countryNorm !== 'australia') {
    return null;
  }

  const stateShort = state.short.toLowerCase();
  const stateLong = state.long.toLowerCase();
  if ((stateShort && NON_WA_STATES.has(stateShort)) || (stateLong && NON_WA_STATES.has(stateLong))) {
    return null;
  }

  const rawAddress = typeof loc.address === 'string' ? loc.address.trim() : '';
  const rawVenueName = typeof loc.venueName === 'string' ? loc.venueName.trim() : '';

  let coords = null;
  if (locality.long) {
    const match = getSuburbByPostcodeOrName(locality.long);
    if (match) coords = { lat: match.lat, lng: match.lng };
  }
  if (!coords && postalCode.short) {
    const match = getSuburbByPostcodeOrName(postalCode.short);
    if (match) coords = { lat: match.lat, lng: match.lng };
  }
  if (!coords) {
    const combinedLower = `${rawAddress} ${rawVenueName}`.toLowerCase();
    for (const suburb of SUBURBS_BY_LENGTH) {
      if (combinedLower.includes(suburb.name.toLowerCase())) {
        coords = { lat: suburb.lat, lng: suburb.lng };
        break;
      }
    }
  }
  if (!coords) {
    const isExplicitWa = stateShort === 'wa' || stateLong === 'western australia' || /\bwa\b/i.test(rawAddress);
    if (!isExplicitWa) {
      return null;
    }
    coords = { ...PERTH_CENTER };
  }

  const distKm = calculateDistanceKm(PERTH_CENTER.lat, PERTH_CENTER.lng, coords.lat, coords.lng);
  if (distKm > MAX_PERTH_RADIUS_KM) {
    return null;
  }

  return {
    venueName: rawVenueName || locality.long || rawAddress || 'Perth Venue',
    address: rawAddress || rawVenueName,
    coordinates: coords
  };
}

function formatAudAmount(amount) {
  if (!Number.isFinite(amount)) return '';
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/**
 * Formats Humanitix `pricing` into `{ isFree, displayPrice }`.
 *
 * @param {object|null|undefined} pricing
 * @returns {{ isFree: boolean, displayPrice: string }}
 */
export function parseHumanitixCost(pricing) {
  if (!pricing || typeof pricing !== 'object') {
    return { isFree: false, displayPrice: '' };
  }
  const min = typeof pricing.minimumPrice === 'number' && Number.isFinite(pricing.minimumPrice)
    ? pricing.minimumPrice
    : null;
  const max = typeof pricing.maximumPrice === 'number' && Number.isFinite(pricing.maximumPrice)
    ? pricing.maximumPrice
    : null;

  if (min === 0 && (max === null || max === 0)) {
    return { isFree: true, displayPrice: 'Free' };
  }
  if (min !== null && max !== null && min !== max) {
    return { isFree: false, displayPrice: `${formatAudAmount(min)} - ${formatAudAmount(max)}` };
  }
  const single = min ?? max;
  if (single !== null) {
    if (single === 0) return { isFree: true, displayPrice: 'Free' };
    return { isFree: false, displayPrice: formatAudAmount(single) };
  }
  return { isFree: false, displayPrice: '' };
}

/**
 * Infers a canonical category for Humanitix `other` feed items using title keywords,
 * falling back to `'community'`.
 *
 * @param {string} [title='']
 * @returns {string}
 */
export function inferCategoryForOtherFeed(title = '') {
  const cleanTitle = String(title || '').trim();
  if (normalizeSport(cleanTitle) !== 'other') {
    return 'sports';
  }
  const lower = cleanTitle.toLowerCase();
  if (/\b(yoga|pilates|meditation|breathwork|wellness|mindfulness|tai chi)\b/.test(lower)) return 'health';
  if (/\b(music|concert|choir|band|symphony|jazz|acoustic|dj)\b/.test(lower)) return 'music';
  if (/\b(art|arts|theatre|comedy|craft|paint|pottery|ceramics|gallery|film)\b/.test(lower)) return 'arts';
  if (/\b(kids|children|storytime|story\s*time|rhyme\s*time|lego|school|family|toddler)\b/.test(lower)) return 'family';
  if (/\b(wine|food|dinner|tasting|brunch|cooking|supper|feast)\b/.test(lower)) return 'food';
  if (/\b(board\s*games?|chess|dungeons|knit|knitting|crochet|book\s*club|sewing|mahjong)\b/.test(lower)) return 'hobbies';
  if (/\b(hike|hiking|trail|tour|kayak|paddle)\b/.test(lower)) return 'travel';
  return 'community';
}

/**
 * Returns `true` when a Humanitix event should be hard-dropped before ingestion.
 *
 * @param {object} [item={}]
 * @param {object|null} location
 * @param {object|null} schedule
 * @returns {boolean}
 */
export function shouldDropHumanitixActivity(item = {}, location = null, schedule = null) {
  if (!item || typeof item !== 'object') return true;
  if (!item._id || !item.name || !item.slug) return true;
  if (item.suspendSales === true) return true;
  if (!location || !schedule) return true;

  const title = String(item.name || '').trim();
  if (!title) return true;

  return NOISE_TITLE_PATTERNS.some(pattern => pattern.test(title));
}

/**
 * Maps a single Humanitix search event object into a raw MyPlaydex Activity listing.
 * Deliberately omits `organizer` so `crawler-runner.js` suppresses synthetic `/organizers`
 * creation per ADR 0008.
 *
 * @param {object} item
 * @param {object} [options={}]
 * @param {string} [options.defaultCategory]
 * @param {Date|string|number} [options.now=new Date()]
 * @returns {object|null}
 */
export function mapHumanitixEventToListing(item, options = {}) {
  const location = resolveHumanitixLocation(item);
  const schedule = resolveHumanitixSchedule(item, options.now);

  if (shouldDropHumanitixActivity(item, location, schedule)) {
    return null;
  }

  const title = String(item.name).trim();
  const category = options.defaultCategory
    ? normalizeCategory(options.defaultCategory)
    : inferCategoryForOtherFeed(title);
  const subcategory = resolveActivitySubcategory(title, category);
  const cost = parseHumanitixCost(item.pricing);
  const demographics = inferDemographics(title, '');
  const sourceUrl = buildHumanitixEventUrl(item);

  return {
    source: 'humanitix',
    source_id: String(item._id),
    source_url: sourceUrl,
    raw_source_url: sourceUrl,
    title,
    description: '',
    category,
    subcategory,
    venue_name: location.venueName,
    address: location.address,
    coordinates: location.coordinates,
    recurrence: schedule.recurrence,
    start_date: schedule.start_date,
    end_date: schedule.end_date,
    start_time: schedule.start_time,
    end_time: schedule.end_time,
    day_of_week: schedule.day_of_week,
    is_free: cost.isFree,
    cost_description: cost.displayPrice,
    demographics
  };
}

/**
 * Parses a Humanitix `/api/search` JSON array into mapped listings and raw `_id`s.
 *
 * @param {Array<object>} [events=[]]
 * @param {object} [options={}]
 * @returns {{ listings: Array<object>, rawIds: Array<string> }}
 */
export function parseHumanitixApiEvents(events = [], options = {}) {
  if (!Array.isArray(events)) {
    return { listings: [], rawIds: [] };
  }

  const rawIds = [];
  const listings = [];

  for (const item of events) {
    if (item?._id) {
      rawIds.push(String(item._id));
    }
    const mapped = mapHumanitixEventToListing(item, options);
    if (mapped) {
      listings.push(mapped);
    }
  }

  return { listings, rawIds };
}

/**
 * Parses a Humanitix search SSR HTML page into mapped listings, raw `_id`s,
 * and pagination metadata (`geobox`, `stateKey`, `locale`).
 *
 * @param {string} [html='']
 * @param {object} [options={}]
 * @returns {{ listings: Array<object>, rawIds: Array<string>, geobox: object|null, stateKey: string|null, locale: string|null }}
 */
export function parseHumanitixSearchPage(html = '', options = {}) {
  const { initialEvents, geobox, stateKey, locale } = extractHumanitixNextData(html);
  const { listings, rawIds } = parseHumanitixApiEvents(initialEvents, options);
  return { listings, rawIds, geobox, stateKey, locale };
}
