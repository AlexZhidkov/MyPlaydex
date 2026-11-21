/**
 * Pure Eventbrite HTML extraction, normalization, pre-ingestion filtering,
 * and canonical Listing mapping helpers (no network or side effects).
 */

import {
  slugify,
  normalizeCategory,
  normalizeSport,
  resolveActivitySubcategory,
  determineIsFree,
  parseSchedule
} from '../sanitizer.js';
import { PERTH_SUBURB_CENTROIDS, getSuburbByPostcodeOrName } from '../perth-centroids.js';
import { calculateDistanceKm, isActivityExpired } from '../discovery-engine.js';

export const PERTH_CENTER = { lat: -31.9505, lng: 115.8605 };
export const MAX_PERTH_RADIUS_KM = 85;

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

const SCHEMA_TYPE_TO_CATEGORY = {
  sportsevent: 'sports',
  musicevent: 'music',
  foodevent: 'food',
  theaterevent: 'arts',
  danceevent: 'arts',
  comedyevent: 'arts',
  visualartsevent: 'arts',
  exhibitionevent: 'arts',
  literaryevent: 'arts',
  screeningevent: 'arts',
  childrensevent: 'family',
  educationevent: 'family',
  socialevent: 'community',
  festival: 'community'
};

/**
 * Extracts a numeric or alphanumeric Eventbrite Activity ID from a URL or fallback identifier.
 *
 * @param {string} [url='']
 * @param {string} [fallbackId='']
 * @param {string} [title='']
 * @returns {string}
 */
export function extractEventbriteId(url = '', fallbackId = '', title = '') {
  if (url) {
    const ticketMatch = url.match(/tickets-(\d+)/i) || url.match(/-(\d{7,})(?:\?|\/|$)/);
    if (ticketMatch) {
      return ticketMatch[1];
    }
  }
  if (fallbackId !== undefined && fallbackId !== null && String(fallbackId).trim() !== '') {
    const clean = String(fallbackId).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (clean) return clean;
  }
  return slugify(`${title || 'activity'}_${url || 'listing'}`);
}

/**
 * Formats a Schema.org PostalAddress, Eventbrite venue address object, or string into a single line.
 * Returns an empty string when no address components are available.
 *
 * @param {string|object|null|undefined} address
 * @returns {string}
 */
export function formatSchemaAddress(address) {
  if (!address) return '';
  if (typeof address === 'string') return address.trim();

  if (typeof address.localized_address_display === 'string' && address.localized_address_display.trim()) {
    return address.localized_address_display.trim();
  }
  if (Array.isArray(address.localized_multi_line_address_display) && address.localized_multi_line_address_display.length > 0) {
    const joined = address.localized_multi_line_address_display.map(s => String(s || '').trim()).filter(Boolean).join(', ');
    if (joined) return joined;
  }

  const resolveVal = val => {
    if (!val) return '';
    if (typeof val === 'string') return val.trim();
    if (typeof val === 'object') return String(val.name || val['@value'] || '').trim();
    return String(val).trim();
  };

  const parts = [
    resolveVal(address.streetAddress || address.address_1),
    resolveVal(address.addressLocality || address.city),
    resolveVal(address.addressRegion || address.region),
    resolveVal(address.postalCode || address.postal_code),
    resolveVal(address.addressCountry || address.country)
  ].filter(Boolean);

  return parts.join(', ');
}

function getSchemaTypeList(type) {
  if (Array.isArray(type)) {
    return type.filter(t => typeof t === 'string').map(t => t.trim());
  }
  if (typeof type === 'string' && type.trim()) {
    return [type.trim()];
  }
  return [];
}

function isSchemaActivityType(type) {
  return getSchemaTypeList(type).some(t => /Event$/i.test(t));
}

function hasSchemaType(type, target) {
  return getSchemaTypeList(type).some(t => t.toLowerCase() === target.toLowerCase());
}

/**
 * Recursively extracts all Schema.org *Event entities (including @type arrays)
 * from a parsed JSON-LD structure.
 *
 * @param {any} node
 * @param {Array<object>} [acc=[]]
 * @returns {Array<object>}
 */
export function collectSchemaActivities(node, acc = []) {
  if (!node || typeof node !== 'object') {
    return acc;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectSchemaActivities(item, acc);
    }
    return acc;
  }

  const type = node['@type'];
  if (isSchemaActivityType(type)) {
    acc.push(node);
  } else if (hasSchemaType(type, 'ItemList') && Array.isArray(node.itemListElement)) {
    for (const listElem of node.itemListElement) {
      if (listElem?.item) {
        collectSchemaActivities(listElem.item, acc);
      } else {
        collectSchemaActivities(listElem, acc);
      }
    }
  } else if (Array.isArray(node['@graph'])) {
    collectSchemaActivities(node['@graph'], acc);
  }

  return acc;
}

/**
 * Extracts raw JSON-LD blocks from HTML content and parses all Schema.org *Event entities.
 *
 * @param {string} [html='']
 * @returns {Array<object>}
 */
export function extractJsonLdActivities(html = '') {
  if (!html || typeof html !== 'string') return [];

  const scriptRegex = /<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const activities = [];

  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    const rawContent = match[1]?.trim();
    if (!rawContent) continue;

    try {
      const parsed = JSON.parse(rawContent);
      collectSchemaActivities(parsed, activities);
    } catch {
      // Ignore malformed JSON-LD scripts
    }
  }

  return activities;
}

/**
 * Extracts and parses `window.__SERVER_DATA__` JSON from Eventbrite search HTML.
 *
 * @param {string} [html='']
 * @returns {object|null}
 */
export function extractServerData(html = '') {
  if (!html || typeof html !== 'string') return null;

  const markerMatch = /window\.__SERVER_DATA__\s*=\s*/.exec(html);
  if (!markerMatch) return null;

  const startSearch = markerMatch.index + markerMatch[0].length;
  const openBraceIdx = html.indexOf('{', startSearch);
  if (openBraceIdx === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openBraceIdx; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const jsonText = html.slice(openBraceIdx, i + 1);
        try {
          return JSON.parse(jsonText);
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/**
 * Extracts `page_count` pagination metadata from parsed `window.__SERVER_DATA__`.
 *
 * @param {object|null} serverData
 * @returns {number|null}
 */
export function extractEventbritePageCount(serverData) {
  if (!serverData || typeof serverData !== 'object') return null;

  const raw =
    serverData.search_data?.events?.pagination?.page_count ??
    serverData.events?.pagination?.page_count ??
    serverData.pagination?.page_count ??
    null;

  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/**
 * Extracts raw Activity entries from parsed `window.__SERVER_DATA__`.
 *
 * @param {object|null} serverData
 * @returns {Array<object>}
 */
export function extractServerDataActivities(serverData) {
  if (!serverData || typeof serverData !== 'object') return [];

  const candidates = [
    serverData.search_data?.events?.results,
    serverData.search_data?.events,
    serverData.events?.results,
    serverData.events,
    serverData.results
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(item => item && typeof item === 'object');
    }
  }

  return [];
}

/**
 * Merges `window.__SERVER_DATA__` and Schema.org JSON-LD records by `source_id`.
 *
 * @param {Array<object>} [serverActivities=[]]
 * @param {Array<object>} [jsonLdActivities=[]]
 * @returns {Array<{ sourceId: string, server: object|null, jsonLd: object|null }>}
 */
export function mergeEventbriteActivities(serverActivities = [], jsonLdActivities = []) {
  const mergedById = new Map();

  for (const server of serverActivities) {
    if (!server || typeof server !== 'object') continue;
    const sourceId = extractEventbriteId(server.url || '', server.id ?? server.event_id ?? server.eid ?? '', server.name || '');
    const existing = mergedById.get(sourceId);
    if (existing) {
      existing.server = existing.server || server;
    } else {
      mergedById.set(sourceId, { sourceId, server, jsonLd: null });
    }
  }

  for (const jsonLd of jsonLdActivities) {
    if (!jsonLd || typeof jsonLd !== 'object') continue;
    const sourceId = extractEventbriteId(jsonLd.url || '', jsonLd['@id'] || '', jsonLd.name || '');
    const existing = mergedById.get(sourceId);
    if (existing) {
      existing.jsonLd = existing.jsonLd || jsonLd;
    } else {
      mergedById.set(sourceId, { sourceId, server: null, jsonLd });
    }
  }

  return Array.from(mergedById.values());
}

/**
 * Anchors timezone-naive ISO timestamps (e.g. `2026-11-25T18:00:00`) to `+08:00` (AWST).
 * Preserves already-zoned timestamps (`Z`, `±HH:MM`, `±HHMM`) and date-only strings (`YYYY-MM-DD`).
 *
 * @param {string|null|undefined} rawTimestamp
 * @returns {string|null}
 */
export function anchorAwstTimestamp(rawTimestamp) {
  if (typeof rawTimestamp !== 'string') return null;
  const trimmed = rawTimestamp.trim();
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const normalized = trimmed.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)/, '$1T$2');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)) {
    return `${normalized}+08:00`;
  }

  return trimmed;
}

function parseNumericCoord(val) {
  if (val === undefined || val === null || val === '') return null;
  const num = typeof val === 'number' ? val : parseFloat(val);
  return Number.isFinite(num) ? num : null;
}

function isNonWaOrNonAuLocation(address, serverVenue) {
  const region = String(
    address?.addressRegion?.name || address?.addressRegion || serverVenue?.address?.region || ''
  ).trim().toLowerCase();

  if (region && NON_WA_STATES.has(region)) {
    return true;
  }

  const country = String(
    address?.addressCountry?.name || address?.addressCountry || serverVenue?.address?.country || ''
  ).trim().toLowerCase();

  if (country && country !== 'au' && country !== 'australia') {
    return true;
  }

  return false;
}

/**
 * Resolves Perth geo-coordinates from JSON-LD location or server venue,
 * falling back to Greater Perth suburb/postcode centroid lookup when `geo` is missing.
 *
 * @param {object|null|undefined} location
 * @param {object|null|undefined} serverVenue
 * @returns {{ lat: number, lng: number } | null}
 */
export function resolvePerthCoordinates(location, serverVenue) {
  const geo = location?.geo;
  const rawLat = geo?.latitude ?? location?.latitude ?? serverVenue?.latitude ?? serverVenue?.address?.latitude;
  const rawLng = geo?.longitude ?? location?.longitude ?? serverVenue?.longitude ?? serverVenue?.address?.longitude;

  const lat = parseNumericCoord(rawLat);
  const lng = parseNumericCoord(rawLng);
  if (lat !== null && lng !== null && !(lat === 0 && lng === 0)) {
    return { lat, lng };
  }

  const address = location?.address;
  if (isNonWaOrNonAuLocation(address, serverVenue)) {
    return null;
  }

  const locality = String(
    address?.addressLocality?.name || address?.addressLocality || serverVenue?.address?.city || ''
  ).trim();
  if (locality) {
    const localityMatch = getSuburbByPostcodeOrName(locality);
    if (localityMatch) {
      return { lat: localityMatch.lat, lng: localityMatch.lng };
    }
  }

  const postalCode = String(
    address?.postalCode || serverVenue?.address?.postal_code || ''
  ).trim();
  if (postalCode) {
    const postcodeMatch = getSuburbByPostcodeOrName(postalCode);
    if (postcodeMatch) {
      return { lat: postcodeMatch.lat, lng: postcodeMatch.lng };
    }
  }

  const combinedText = [
    formatSchemaAddress(address),
    formatSchemaAddress(serverVenue?.address),
    location?.name,
    serverVenue?.name
  ].filter(Boolean).join(' ');

  if (!combinedText.trim()) {
    return null;
  }

  const textPostcodeMatch = combinedText.match(/\b(6\d{3})\b/);
  if (textPostcodeMatch) {
    const found = getSuburbByPostcodeOrName(textPostcodeMatch[1]);
    if (found) {
      return { lat: found.lat, lng: found.lng };
    }
  }

  const lower = combinedText.toLowerCase();
  for (const suburb of SUBURBS_BY_LENGTH) {
    const escaped = suburb.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(lower)) {
      return { lat: suburb.lat, lng: suburb.lng };
    }
  }

  return null;
}

function normalizePriceValue(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? String(val) : null;
  }
  const trimmed = String(val).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'null' || lower === 'undefined' || lower === 'nan') return null;
  return trimmed;
}

function isZeroOrFreePrice(val) {
  const lower = String(val).trim().toLowerCase();
  return lower === '0' || lower === '0.0' || lower === '0.00' || lower === '$0' || lower === '$0.00' || lower === 'free';
}

function formatCurrencyAmount(val) {
  const str = String(val).trim();
  return str.startsWith('$') ? str : `$${str}`;
}

function formatPriceRange(low, high, currency = 'AUD') {
  if (low === null && high === null) return null;

  if (low !== null && (high === null || low === high || parseFloat(low) === parseFloat(high))) {
    if (isZeroOrFreePrice(low)) {
      return { isFree: true, displayPrice: 'Free' };
    }
    return { isFree: false, displayPrice: `${formatCurrencyAmount(low)} ${currency}`.trim() };
  }

  if (low !== null && high !== null) {
    const lowLabel = isZeroOrFreePrice(low) ? 'Free' : formatCurrencyAmount(low);
    return {
      isFree: isZeroOrFreePrice(low),
      displayPrice: `${lowLabel} - ${formatCurrencyAmount(high)} ${currency}`.trim()
    };
  }

  if (isZeroOrFreePrice(high)) {
    return { isFree: true, displayPrice: 'Free' };
  }
  return { isFree: false, displayPrice: `${formatCurrencyAmount(high)} ${currency}`.trim() };
}

/**
 * Parses pricing and free status from Schema.org Offer / AggregateOffer
 * and Eventbrite `__SERVER_DATA__` ticket availability, safely handling `price: null`.
 *
 * @param {object} merged
 * @returns {{ isFree: boolean, displayPrice: string }}
 */
export function parseActivityCost(merged) {
  const jsonLd = merged?.jsonLd || {};
  const server = merged?.server || {};

  if (jsonLd.isAccessibleForFree === true || server.is_free === true) {
    return { isFree: true, displayPrice: 'Free' };
  }

  const offers = Array.isArray(jsonLd.offers)
    ? jsonLd.offers
    : (jsonLd.offers ? [jsonLd.offers] : []);

  for (const offer of offers) {
    if (!offer || typeof offer !== 'object') continue;
    if (offer.isAccessibleForFree === true) {
      return { isFree: true, displayPrice: 'Free' };
    }

    const currency = offer.priceCurrency || 'AUD';
    const low = normalizePriceValue(offer.lowPrice);
    const high = normalizePriceValue(offer.highPrice);
    const rangeResult = formatPriceRange(low, high, currency);
    if (rangeResult) return rangeResult;

    const rawPrice = normalizePriceValue(offer.price);
    const singleResult = formatPriceRange(rawPrice, null, currency);
    if (singleResult) return singleResult;
  }

  const ticketAvail = server.ticket_availability;
  if (ticketAvail && typeof ticketAvail === 'object') {
    if (ticketAvail.is_free === true) {
      return { isFree: true, displayPrice: 'Free' };
    }
    const minPrice = normalizePriceValue(ticketAvail.minimum_ticket_price?.major_value);
    const maxPrice = normalizePriceValue(ticketAvail.maximum_ticket_price?.major_value);
    const currency = ticketAvail.minimum_ticket_price?.currency || ticketAvail.maximum_ticket_price?.currency || 'AUD';
    const serverRangeResult = formatPriceRange(minPrice, maxPrice, currency);
    if (serverRangeResult) return serverRangeResult;
  }

  const description = jsonLd.description || server.summary || server.description || '';
  const isFreeFromText = determineIsFree(description);
  return {
    isFree: isFreeFromText,
    displayPrice: isFreeFromText ? 'Free' : 'See listing details'
  };
}

/**
 * Infers normalized `demographics` (`gender` and `age`) from Activity title and description keywords.
 *
 * @param {string} [title='']
 * @param {string} [description='']
 * @returns {{ gender: 'all' | 'women_only' | 'men_only', age: 'all' | 'adults' | 'juniors' | 'masters' }}
 */
export function inferDemographics(title = '', description = '') {
  const text = `${title || ''} ${description || ''}`.trim();
  if (!text) {
    return { gender: 'all', age: 'all' };
  }

  const hasWomen = /\b(women(?:'s|s)?|ladies|female(?:\s+only)?|girls(?:\s+only)?|mums?|mothers?)\b/i.test(text);
  const hasMen = /\b(men(?:'s|s)?|male(?:\s+only)?|boys(?:\s+only)?|dads?|fathers?|blokes?)\b/i.test(text);

  let gender = 'all';
  if (hasWomen && !hasMen) {
    gender = 'women_only';
  } else if (hasMen && !hasWomen) {
    gender = 'men_only';
  }

  let age = 'all';
  if (!/\ball\s+ages\b/i.test(text)) {
    const hasJuniors = /\b(juniors?|kids?|children|child|youth|teens?|teenagers?|toddlers?|under[-\s]?\d{1,2}|u\d{1,2}|school\s+holidays?)\b/i.test(text);
    const hasMasters = /\b(masters?|seniors?|over[-\s]?(?:40|45|50|55|60|65)s?|veterans?|retirees?|50\+|55\+|60\+)\b/i.test(text);
    const hasAdults = /\b(adults?(?:\s+only)?|18\+|21\+|over[-\s]?18s?|grown[-\s]?ups?)\b/i.test(text);

    const matchedCount = [hasJuniors, hasMasters, hasAdults].filter(Boolean).length;
    if (matchedCount === 1) {
      if (hasJuniors) age = 'juniors';
      else if (hasMasters) age = 'masters';
      else if (hasAdults) age = 'adults';
    }
  }

  return { gender, age };
}

function buildRawTimestamp(explicitIso, dateStr, timeStr) {
  if (explicitIso) {
    return anchorAwstTimestamp(explicitIso);
  }
  if (dateStr && timeStr) {
    return anchorAwstTimestamp(`${dateStr}T${timeStr}`);
  }
  if (dateStr) {
    return anchorAwstTimestamp(dateStr);
  }
  return null;
}

function getServerVenue(server) {
  return server?.primary_venue || server?.venue || null;
}

function extractRawScheduleInputs(merged) {
  const jsonLd = merged?.jsonLd || {};
  const server = merged?.server || {};

  const rawStart = buildRawTimestamp(
    jsonLd.startDate || server.start?.local || server.start?.utc || server.startDate,
    server.start_date,
    server.start_time
  );
  const rawEnd = buildRawTimestamp(
    jsonLd.endDate || server.end?.local || server.end?.utc || server.endDate,
    server.end_date,
    server.end_time
  );

  const isStartDateOnly = Boolean(rawStart && !rawStart.includes('T') && !rawStart.includes(':'));
  const isEndDateOnly = Boolean(rawEnd && !rawEnd.includes('T') && !rawEnd.includes(':'));

  return {
    rawStart,
    rawEnd,
    start_date: isStartDateOnly ? rawStart : undefined,
    start_time: isStartDateOnly ? null : rawStart,
    end_date: isEndDateOnly ? rawEnd : undefined,
    end_time: isEndDateOnly ? null : rawEnd
  };
}

function isOnlineOrVirtual(merged) {
  const jsonLd = merged?.jsonLd || {};
  const server = merged?.server || {};

  if (server.is_online_event === true || jsonLd.isOnline === true) {
    return true;
  }

  const attendanceMode = String(jsonLd.eventAttendanceMode || '');
  if (/OnlineEventAttendanceMode/i.test(attendanceMode)) {
    return true;
  }

  const locationTypes = getSchemaTypeList(jsonLd.location?.['@type']);
  if (locationTypes.some(t => t.toLowerCase() === 'virtuallocation')) {
    return true;
  }

  const serverVenue = getServerVenue(server);
  const venueName = String(jsonLd.location?.name || serverVenue?.name || '').trim().toLowerCase();
  return venueName === 'online' || venueName === 'online event' || venueName === 'virtual event';
}

function isCancelledOrPostponed(merged) {
  const jsonLd = merged?.jsonLd || {};
  const server = merged?.server || {};

  const eventStatus = String(jsonLd.eventStatus || '');
  if (/EventCancelled|EventPostponed/i.test(eventStatus)) {
    return true;
  }

  if (server.is_cancelled === true || server.cancelled === true) {
    return true;
  }

  const status = String(server.status || '').trim().toLowerCase();
  return status === 'canceled' || status === 'cancelled' || status === 'postponed' || status === 'deleted' || status === 'draft';
}

function resolveRawCategory(merged, defaultCategory) {
  const jsonLd = merged?.jsonLd || {};
  const server = merged?.server || {};

  if (server.category) {
    if (typeof server.category === 'string' && server.category.trim()) return server.category.trim();
    if (typeof server.category?.name === 'string' && server.category.name.trim()) return server.category.name.trim();
  }
  if (server.parent_category) {
    if (typeof server.parent_category === 'string' && server.parent_category.trim()) return server.parent_category.trim();
    if (typeof server.parent_category?.name === 'string' && server.parent_category.name.trim()) return server.parent_category.name.trim();
  }
  if (typeof jsonLd.category === 'string' && jsonLd.category.trim()) {
    return jsonLd.category.trim();
  }

  for (const t of getSchemaTypeList(jsonLd['@type'])) {
    const mapped = SCHEMA_TYPE_TO_CATEGORY[t.toLowerCase()];
    if (mapped) return mapped;
  }

  return defaultCategory || 'sports';
}

/**
 * Evaluates whether a merged Eventbrite Activity should be dropped prior to persistence.
 * Drops only: online/virtual, cancelled/postponed, undated, already-Expired, and >85 km from Perth.
 *
 * @param {object} merged
 * @param {{ lat: number, lng: number } | null} coords
 * @param {Date|string} [now=new Date()]
 * @returns {boolean}
 */
export function shouldDropActivity(merged, coords, now = new Date()) {
  if (isOnlineOrVirtual(merged)) {
    return true;
  }

  if (isCancelledOrPostponed(merged)) {
    return true;
  }

  if (!coords || calculateDistanceKm(coords, PERTH_CENTER) > MAX_PERTH_RADIUS_KM) {
    return true;
  }

  const scheduleInputs = extractRawScheduleInputs(merged);
  if (!scheduleInputs.rawStart || Number.isNaN(Date.parse(scheduleInputs.rawStart))) {
    return true;
  }

  const parsedSchedule = parseSchedule(scheduleInputs);
  if (isActivityExpired(parsedSchedule, now)) {
    return true;
  }

  return false;
}

/**
 * Maps a merged Eventbrite Activity into a canonical Listing input object
 * without synthetic placeholder fallbacks.
 *
 * @param {object} merged
 * @param {{ lat: number, lng: number }} coords
 * @param {object} [options={}]
 * @returns {object|null}
 */
export function mapEventbriteActivityToListing(merged, coords, options = {}) {
  const jsonLd = merged?.jsonLd || {};
  const server = merged?.server || {};

  const title = String(jsonLd.name || server.name || '').trim();
  if (!title) {
    return null;
  }

  const rawUrl = jsonLd.url || server.url || null;
  const activityUrl = typeof rawUrl === 'string' && rawUrl.trim() ? rawUrl.trim() : null;

  const description = String(jsonLd.description || server.summary || server.description || '').trim();

  const rawCategory = resolveRawCategory(merged, options.defaultCategory);
  const category = normalizeCategory(rawCategory);
  const matchedSport = normalizeSport(`${title} ${description}`);
  const subcategory = resolveActivitySubcategory(matchedSport, category);

  // Organizer (no synthetic fallback when missing)
  const jsonOrg = jsonLd.organizer;
  const serverOrg = server.primary_organizer || server.organizer;
  const rawOrgName = typeof jsonOrg === 'string'
    ? jsonOrg.trim()
    : String(jsonOrg?.name || serverOrg?.name || '').trim();
  const orgUrl = (typeof jsonOrg === 'object' ? jsonOrg?.url : null) || serverOrg?.url || serverOrg?.website || null;

  const organizer = rawOrgName
    ? {
        id: `org_${slugify(rawOrgName)}`,
        name: rawOrgName,
        website: orgUrl
      }
    : null;

  // Venue (fall back missing Venue name to formatted address; no synthetic fallback)
  const location = jsonLd.location;
  const serverVenue = getServerVenue(server);
  const address = formatSchemaAddress(location?.address) || formatSchemaAddress(serverVenue?.address);
  const rawVenueName = String(location?.name || serverVenue?.name || '').trim();
  const venueName = rawVenueName || address || null;

  const { isFree, displayPrice } = parseActivityCost(merged);
  const demographics = inferDemographics(title, description);

  const scheduleInputs = extractRawScheduleInputs(merged);

  return {
    source: 'eventbrite',
    source_id: merged.sourceId,
    source_url: activityUrl,
    external_url: activityUrl,
    region_id: 'perth',
    title,
    description,
    category,
    subcategory,
    ...(organizer ? { organizer } : {}),
    venue: {
      ...(venueName ? { name: venueName } : {}),
      ...(address ? { address } : {}),
      coordinates: { lat: coords.lat, lng: coords.lng }
    },
    ...(venueName ? { venue_name: venueName } : {}),
    ...(address ? { address } : {}),
    coordinates: { lat: coords.lat, lng: coords.lng },
    start_date: scheduleInputs.start_date,
    start_time: scheduleInputs.start_time,
    end_date: scheduleInputs.end_date,
    end_time: scheduleInputs.end_time,
    cost_description: displayPrice,
    display_price: displayPrice,
    is_free: isFree,
    demographics
  };
}

/**
 * Parses an Eventbrite search page HTML string into filtered, normalized canonical Activity Listings
 * along with pagination metadata and raw extracted source IDs.
 *
 * @param {string} [html='']
 * @param {object} [options={}]
 * @param {string} [options.defaultCategory]
 * @param {Date|string} [options.now]
 * @returns {{ listings: Array<object>, pageCount: number|null, rawIds: Array<string> }}
 */
export function parseEventbritePage(html = '', options = {}) {
  const serverData = extractServerData(html);
  const pageCount = extractEventbritePageCount(serverData);
  const serverActivities = extractServerDataActivities(serverData);
  const jsonLdActivities = extractJsonLdActivities(html);

  const mergedActivities = mergeEventbriteActivities(serverActivities, jsonLdActivities);
  const rawIds = mergedActivities.map(item => item.sourceId).filter(Boolean);
  const now = options.now instanceof Date ? options.now : (options.now ? new Date(options.now) : new Date());

  const listings = [];
  for (const merged of mergedActivities) {
    const location = merged.jsonLd?.location;
    const serverVenue = getServerVenue(merged.server);
    const coords = resolvePerthCoordinates(location, serverVenue);

    if (shouldDropActivity(merged, coords, now)) {
      continue;
    }

    const listing = mapEventbriteActivityToListing(merged, coords, options);
    if (listing) {
      listings.push(listing);
    }
  }

  return { listings, pageCount, rawIds };
}

/**
 * Parses an Eventbrite search page HTML string into filtered, normalized canonical Activity Listings.
 *
 * @param {string} [html='']
 * @param {object} [options={}]
 * @param {string} [options.defaultCategory]
 * @param {Date|string} [options.now]
 * @returns {Array<object>}
 */
export function parseEventbriteHtml(html = '', options = {}) {
  return parseEventbritePage(html, options).listings;
}
