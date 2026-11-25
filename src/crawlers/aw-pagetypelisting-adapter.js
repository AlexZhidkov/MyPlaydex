/**
 * Config-Driven AgencyWeb `aw_pagetypelisting` Council Crawler Adapter
 * Zero-dependency adapter for councils serving AgencyWeb `pageTypeListing` widgets
 * via POST JSON+HTML endpoints (`{ post_type, SI, OB, Q, PS, FS, PG, PR, IncludeFirst }`).
 */

import { determineIsFree } from '../sanitizer.js';
import {
  DEFAULT_HORIZON_DAYS,
  DEFAULT_MAX_ACTIVITIES,
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_DELAY_MS,
  deriveDeterministicCouncilSourceId,
  filterCouncilItem,
  paginateCouncilPages,
  resolveCouncilCategoryAndSubcategory,
  sleepMs
} from './council-utils.js';
import {
  decodeHtmlEntities,
  extractAttr,
  extractTextByClassOrder,
  findBalancedTagEnd,
  normalizeTimeRangeText,
  resolveUrl,
  stripHtmlTags,
  stripNonContentHtml
} from './html-utils.js';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot)';
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_DETAIL_DELAY_MS = 300;
const DEFAULT_TIMEOUT_MS = 20000;
const DAY_NAME_TO_INT = {
  sunday: 0, sundays: 0,
  monday: 1, mondays: 1,
  tuesday: 2, tuesdays: 2,
  wednesday: 3, wednesdays: 3,
  thursday: 4, thursdays: 4,
  friday: 5, fridays: 5,
  saturday: 6, saturdays: 6
};

function createTimeoutSignal(parentSignal, timeoutMs) {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
    return parentSignal;
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (parentSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([parentSignal, timeoutSignal]);
  }
  return parentSignal || timeoutSignal;
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function isCanonicalHostUrl(candidateUrl, baseUrl) {
  if (!candidateUrl || !baseUrl) return false;
  const candidateHost = getHostname(candidateUrl);
  const baseHost = getHostname(baseUrl);
  return Boolean(candidateHost && baseHost && candidateHost === baseHost);
}

function selectCanonicalUrl(candidates, baseUrl, fallbackUrl) {
  const resolved = candidates
    .map(href => resolveUrl(baseUrl, href))
    .filter(Boolean);

  const canonical = resolved.find(url => isCanonicalHostUrl(url, baseUrl));
  return canonical || fallbackUrl;
}

function extractArticleCards(html = '', baseUrl = '') {
  const cleanHtml = stripNonContentHtml(html);
  const cards = [];
  const openArticleRegex = /<article\b([^>]*)>/gi;
  let match;

  while ((match = openArticleRegex.exec(cleanHtml)) !== null) {
    const attrs = match[1] || '';
    const contentStart = match.index + match[0].length;
    const { innerEnd, outerEnd } = findBalancedTagEnd(cleanHtml, 'article', contentStart);
    const innerHtml = cleanHtml.slice(contentStart, innerEnd);
    openArticleRegex.lastIndex = outerEnd;

    const nativeId = extractAttr(attrs, 'data-id')
      || extractAttr(attrs, 'data-post-id')
      || extractAttr(attrs, 'data-event-id')
      || '';
    const anchorHrefs = [...innerHtml.matchAll(/<a\b([^>]*)>/gi)]
      .map(m => extractAttr(m[1], 'href'))
      .filter(Boolean);

    const url = selectCanonicalUrl(anchorHrefs, baseUrl, null);
    const title = extractTextByClassOrder(innerHtml, ['aw-card-title', 'card-title', 'event-title', 'title'])
      || (() => {
        const h = innerHtml.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
        return h ? stripHtmlTags(h[1]) : '';
      })();

    const description = extractTextByClassOrder(innerHtml, ['aw-card-excerpt', 'card-excerpt', 'excerpt', 'summary', 'description']);
    let venueName = extractTextByClassOrder(innerHtml, ['aw-card-venue', 'card-venue', 'venue', 'location']);
    const address = extractTextByClassOrder(innerHtml, ['aw-card-address', 'card-address', 'address']);
    let dateText = extractTextByClassOrder(innerHtml, ['aw-card-date', 'card-date', 'event-date', 'date']);
    const timeText = extractTextByClassOrder(innerHtml, ['aw-card-time', 'card-time', 'event-time', 'time']);
    const costText = extractTextByClassOrder(innerHtml, ['aw-cost-badge', 'cost-badge', 'cost', 'price', 'tags']);
    const tagText = extractTextByClassOrder(innerHtml, ['aw-card-category', 'event-categories', 'categories']);

    if (!dateText || !venueName) {
      for (const liMatch of innerHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
        const liHtml = liMatch[1];
        const liText = stripHtmlTags(liHtml);
        if (!liText) continue;
        if (!dateText && /fa-calendar/i.test(liHtml)) {
          dateText = liText;
        } else if (!venueName && /fa-location/i.test(liHtml)) {
          venueName = liText;
        }
      }
    }

    const classAttr = extractAttr(attrs, 'class') || '';
    const classTags = [...classAttr.matchAll(/\bevent-type-([a-z0-9-]+)\b/gi)]
      .map(m => m[1].replace(/-/g, ' '));

    cards.push({
      nativeId,
      url,
      title,
      description,
      venueName,
      address,
      dateText,
      timeText,
      costText,
      tags: [
        ...(tagText ? tagText.split(/[,;|]+/).map(t => t.trim()).filter(Boolean) : []),
        ...classTags
      ]
    });
  }

  return cards;
}

function getRecordId(record) {
  if (!record || typeof record !== 'object') return '';
  const candidate = record.ID
    ?? record.id
    ?? record.post_id
    ?? record.event_id
    ?? record.nativeId
    ?? record.post?.ID
    ?? record.post?.id;
  return candidate !== undefined && candidate !== null && String(candidate).trim() !== ''
    ? String(candidate).trim()
    : '';
}

function to24HourClock(hourRaw, minRaw, meridiemRaw) {
  let hour = Number.parseInt(hourRaw, 10);
  const min = minRaw || '00';
  const meridiem = meridiemRaw.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${min}:00`;
}

function formatAwstIso(date, clock = '00:00:00') {
  return `${date}T${clock}+08:00`;
}

function normalizeAwTimestamp(rawDate, timeText = '') {
  if (typeof rawDate !== 'string') return '';
  const trimmed = rawDate.trim();
  if (!trimmed) return '';

  // Space-separated ISO date/time (e.g. "2026-12-05 18:30:00") -> AWST (+08:00)
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/.test(trimmed)) {
    return `${trimmed.replace(/\s+/, 'T')}+08:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(trimmed)) {
    return `${trimmed}+08:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const normalizedTime = normalizeTimeRangeText(timeText);
    const startMatch = normalizedTime.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
    if (startMatch) {
      return formatAwstIso(trimmed, to24HourClock(startMatch[1], startMatch[2], startMatch[3]));
    }
    return formatAwstIso(trimmed);
  }
  return trimmed;
}

function normalizeVenueName(rawVenueName, config) {
  const trimmed = String(rawVenueName || '').trim();
  if (!trimmed) return '';

  const placeholders = Array.isArray(config.venuePlaceholders) ? config.venuePlaceholders : [];
  const isPlaceholder = placeholders.some(p =>
    p instanceof RegExp ? p.test(trimmed) : String(p).trim().toLowerCase() === trimmed.toLowerCase()
  );
  if (isPlaceholder) {
    return '';
  }

  const aliases = config.venueAliases && typeof config.venueAliases === 'object' ? config.venueAliases : {};
  for (const [aliasKey, aliasValue] of Object.entries(aliases)) {
    if (aliasKey.trim().toLowerCase() === trimmed.toLowerCase()) {
      return aliasValue;
    }
  }

  return trimmed;
}

function resolveCostFields(rawCost, explicitIsFree, defaultCost = 'See website') {
  const trimmed = typeof rawCost === 'string' ? rawCost.trim() : '';
  if (explicitIsFree === true || /^free$/i.test(trimmed)) {
    return {
      cost_description: 'Free',
      display_price: 'Free',
      is_free: true
    };
  }
  if (trimmed) {
    return {
      cost_description: trimmed,
      display_price: trimmed,
      is_free: determineIsFree(trimmed, explicitIsFree)
    };
  }
  return {
    cost_description: defaultCost,
    display_price: defaultCost,
    is_free: determineIsFree(defaultCost, false)
  };
}

function resolveOrganizer(item, defaultOrganizer) {
  const explicitName = [item.organizer_name, item.organizer?.name, item.organiser, item.organizer]
    .find(val => typeof val === 'string' && val.trim().length > 0);
  if (explicitName) {
    return { name: explicitName.trim() };
  }
  if (defaultOrganizer && typeof defaultOrganizer === 'object') {
    return { ...defaultOrganizer };
  }
  return undefined;
}

function mergeSingleItem(dataItem, htmlCard, sortedItem, config) {
  const id = getRecordId(dataItem) || htmlCard.nativeId || '';
  const urlCandidates = [
    dataItem.permalink,
    dataItem.url,
    dataItem.link,
    htmlCard.url
  ].filter(Boolean);
  const url = selectCanonicalUrl(urlCandidates, config.baseUrl, config.baseUrl || null);

  const title = String(dataItem.post_title || dataItem.title || htmlCard.title || '').trim();
  if (!title) return null;

  const description = String(
    dataItem.post_excerpt || dataItem.excerpt || dataItem.description || htmlCard.description || ''
  ).trim();

  const rawVenue = dataItem.venue_name || dataItem.venue?.name || dataItem.venue || htmlCard.venueName || '';
  const venueName = normalizeVenueName(rawVenue, config);
  const address = String(dataItem.address || dataItem.venue?.address || htmlCard.address || '').trim();

  const rawTags = [
    ...(Array.isArray(dataItem.categories) ? dataItem.categories : (dataItem.categories ? [dataItem.categories] : [])),
    ...(Array.isArray(dataItem.tags) ? dataItem.tags : []),
    ...(Array.isArray(htmlCard.tags) ? htmlCard.tags : [])
  ];

  const timeText = String(dataItem.time || htmlCard.timeText || '').trim();
  const nextDateRaw = sortedItem.next_date || dataItem.next_date || '';
  const nextDate = typeof nextDateRaw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(nextDateRaw.trim())
    ? nextDateRaw.trim().slice(0, 10)
    : '';
  const rawStartDate = nextDateRaw || dataItem.start_date || dataItem.start_time || htmlCard.dateText || '';
  const startTime = normalizeAwTimestamp(rawStartDate, timeText) || normalizeTimeRangeText([htmlCard.dateText, timeText].filter(Boolean).join(' '));
  const endTime = normalizeAwTimestamp(dataItem.end_date || dataItem.end_time || '', timeText);

  const rawCost = dataItem.cost ?? dataItem.price ?? dataItem.cost_badge ?? htmlCard.costText ?? '';
  const costFields = resolveCostFields(rawCost, dataItem.is_free, config.defaultCost ?? 'See website');
  const organizer = resolveOrganizer(dataItem, config.defaultOrganizer);

  const lat = Number(dataItem.latitude ?? dataItem.lat);
  const lng = Number(dataItem.longitude ?? dataItem.lng);
  const coordinates = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;

  const sourceId = deriveDeterministicCouncilSourceId({
    nativeId: id,
    url,
    title,
    startTime
  });

  return {
    sourceId,
    title,
    description,
    url,
    venueName,
    address,
    coordinates,
    rawTags,
    dateText: htmlCard.dateText || '',
    timeText,
    nextDate,
    startTime,
    endTime,
    recurrence: 'none',
    dayOfWeek: null,
    costFields,
    organizer
  };
}

function mergeResponseItems(payload, config) {
  const dataItems = Array.isArray(payload?.data) ? payload.data : [];
  const sortedEvents = Array.isArray(payload?.sorted_events) ? payload.sorted_events : [];
  const htmlCards = extractArticleCards(payload?.htmlResult || payload?.html || '', config.baseUrl);

  const sortedById = new Map();
  for (const ev of sortedEvents) {
    const id = getRecordId(ev);
    if (id) sortedById.set(id, ev);
  }

  const htmlById = new Map();
  for (const card of htmlCards) {
    if (card.nativeId) htmlById.set(card.nativeId, card);
  }

  const count = Math.max(dataItems.length, htmlCards.length);
  const merged = [];

  for (let i = 0; i < count; i++) {
    const dataItem = dataItems[i] || {};
    const dataId = getRecordId(dataItem);
    const htmlCard = dataId ? (htmlById.get(dataId) || {}) : (htmlCards[i] || {});
    const id = dataId || htmlCard.nativeId || '';
    const sortedItem = id ? (sortedById.get(id) || {}) : (sortedEvents[i] || {});

    const item = mergeSingleItem(dataItem, htmlCard, sortedItem, config);
    if (item) merged.push(item);
  }

  return merged;
}

function parseGoogleCalendarTimestamp(raw) {
  if (!raw || typeof raw !== 'string') return { date: '', time: '', iso: '' };
  const trimmed = raw.trim();
  const dtMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (dtMatch) {
    if (dtMatch[7] === 'Z') {
      const utcMs = Date.UTC(
        Number.parseInt(dtMatch[1], 10),
        Number.parseInt(dtMatch[2], 10) - 1,
        Number.parseInt(dtMatch[3], 10),
        Number.parseInt(dtMatch[4], 10),
        Number.parseInt(dtMatch[5], 10),
        Number.parseInt(dtMatch[6], 10)
      );
      const awst = new Date(utcMs + 8 * 60 * 60 * 1000);
      const date = awst.toISOString().slice(0, 10);
      const time = awst.toISOString().slice(11, 19);
      return { date, time, iso: formatAwstIso(date, time) };
    }
    const date = `${dtMatch[1]}-${dtMatch[2]}-${dtMatch[3]}`;
    const time = `${dtMatch[4]}:${dtMatch[5]}:${dtMatch[6]}`;
    return { date, time, iso: formatAwstIso(date, time) };
  }
  const dMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dMatch) {
    const date = `${dMatch[1]}-${dMatch[2]}-${dMatch[3]}`;
    return { date, time: '', iso: formatAwstIso(date) };
  }
  return { date: '', time: '', iso: '' };
}

function extractGoogleCalendarData(html) {
  const modalIdx = html.search(/id\s*=\s*["']addToCalendarModal["']/i);
  const scope = modalIdx >= 0 ? html.slice(modalIdx, modalIdx + 4000) : html;
  const hrefMatch = scope.match(/href\s*=\s*["'](https:\/\/www\.google\.com\/calendar\/render\?[^"']+)["']/i);
  if (!hrefMatch) {
    return { calendarStart: null, calendarEnd: null, calendarLocation: '' };
  }

  try {
    const decodedHref = decodeHtmlEntities(hrefMatch[1]);
    const parsedUrl = new URL(decodedHref);
    const datesParam = parsedUrl.searchParams.get('dates') || '';
    const [rawStart = '', rawEnd = ''] = datesParam.split('/');
    const calendarStart = parseGoogleCalendarTimestamp(rawStart);
    const calendarEnd = parseGoogleCalendarTimestamp(rawEnd);
    const calendarLocation = (parsedUrl.searchParams.get('location') || '').replace(/[\s\u00a0]+/g, ' ').trim();
    return {
      calendarStart: calendarStart.date ? calendarStart : null,
      calendarEnd: calendarEnd.date ? calendarEnd : null,
      calendarLocation
    };
  } catch {
    return { calendarStart: null, calendarEnd: null, calendarLocation: '' };
  }
}

export function parseAwDetailPage(html = '') {
  const cleanHtml = stripNonContentHtml(html);

  const categoryTagSet = new Set();
  for (const m of cleanHtml.matchAll(/\bevent-type-([a-z0-9-]+)\b/gi)) {
    const normalized = m[1].replace(/-/g, ' ').trim();
    if (normalized) categoryTagSet.add(normalized);
  }

  let dateFrequencyText = '';
  let timeText = '';
  let locationText = '';
  let costText = '';

  const labelRegex = /<div\b[^>]*class\s*=\s*["'][^"']*\btext-label\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*>([\s\S]*?)<\/div>/gi;
  let match;
  while ((match = labelRegex.exec(cleanHtml)) !== null) {
    const label = stripHtmlTags(match[1]).toLowerCase();
    const value = stripHtmlTags(match[2]);
    if (!value) continue;

    if (!dateFrequencyText && /date|frequency/i.test(label)) {
      dateFrequencyText = value;
    } else if (!timeText && /^time$/i.test(label)) {
      timeText = value;
    } else if (!locationText && /^location|venue|where$/i.test(label)) {
      locationText = value;
    } else if (!costText && /^cost|price|fee$/i.test(label)) {
      costText = value;
    }
  }

  const { calendarStart, calendarEnd, calendarLocation } = extractGoogleCalendarData(cleanHtml);

  return {
    categoryTags: [...categoryTagSet],
    dateFrequencyText,
    timeText,
    locationText,
    costText,
    calendarStart,
    calendarEnd,
    calendarLocation
  };
}

function isMissingRequiredField(item, field) {
  if (field === 'address') return !item.address;
  if (field === 'time') return !item.timeText && !/T(?!00:00:00)/.test(item.startTime || '');
  if (field === 'tags') return !Array.isArray(item.rawTags) || item.rawTags.length === 0;
  return !item[field];
}

function shouldHydrateDetail(item, hydrateDetail, requiredListingFields, baseUrl) {
  if (!item.url || item.url === baseUrl || hydrateDetail === 'never') {
    return false;
  }
  if (hydrateDetail === 'always') {
    return true;
  }
  return requiredListingFields.some(field => isMissingRequiredField(item, field));
}

function mergeLocationDetails(item, detail, config) {
  const rawLocation = (
    (detail.locationText && detail.locationText.includes(',') ? detail.locationText : '')
    || detail.calendarLocation
    || detail.locationText
    || ''
  ).trim();
  if (!rawLocation) {
    return { venueName: item.venueName, address: item.address };
  }

  let venueName = item.venueName;
  let address = item.address;

  const commaIdx = rawLocation.indexOf(',');
  if (commaIdx > 0) {
    const firstPart = rawLocation.slice(0, commaIdx).trim();
    const restPart = rawLocation.slice(commaIdx + 1).trim();
    const startsWithStreetNumber = /^\d+[a-z]?\s+/i.test(firstPart);

    if (startsWithStreetNumber) {
      if (!address || rawLocation.length > address.length) {
        address = rawLocation;
      }
    } else {
      if (!venueName) {
        venueName = normalizeVenueName(firstPart, config);
      }
      if (restPart && (!address || restPart.length > address.length)) {
        address = restPart;
      }
    }
  } else if (!address) {
    address = rawLocation;
  }

  return { venueName, address };
}

function extractTimePair(timeText) {
  if (!timeText) return { startTime: '', endTime: '' };
  const normalized = normalizeTimeRangeText(timeText);
  const matches = [...normalized.matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/gi)];
  return {
    startTime: matches[0] ? to24HourClock(matches[0][1], matches[0][2], matches[0][3]) : '',
    endTime: matches[1] ? to24HourClock(matches[1][1], matches[1][2], matches[1][3]) : ''
  };
}

function resolveHydratedSchedule(item, detail) {
  const dateFreq = detail.dateFrequencyText || item.dateText || '';
  const timeText = detail.timeText || item.timeText || '';
  const parsedTimes = extractTimePair(timeText);

  const isWeekly = /\b(every|weekly|sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?)\b/i.test(dateFreq);
  const dayMatch = dateFreq.match(/\b(sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?)\b/i);
  const dayOfWeek = dayMatch ? DAY_NAME_TO_INT[dayMatch[1].toLowerCase()] : null;

  const nextDate = item.nextDate || '';
  const calStart = detail.calendarStart;
  const calEnd = detail.calendarEnd;

  const startClock = calStart?.time || parsedTimes.startTime || '00:00:00';
  const endClock = calEnd?.time || parsedTimes.endTime || '';

  if (isWeekly) {
    const baseDate = (calStart?.date && (!nextDate || calStart.date >= nextDate))
      ? calStart.date
      : (nextDate || calStart?.date || '');

    const startTime = baseDate
      ? formatAwstIso(baseDate, startClock)
      : item.startTime;
    const endTime = baseDate && endClock
      ? formatAwstIso(baseDate, endClock)
      : (endClock ? endClock.slice(0, 5) : item.endTime);

    return {
      startTime,
      endTime,
      recurrence: 'weekly',
      dayOfWeek
    };
  }

  if (calStart?.date) {
    const clampedStartDate = (nextDate && calStart.date < nextDate) ? nextDate : calStart.date;
    const startTime = formatAwstIso(clampedStartDate, startClock);
    const endTime = calEnd?.iso || (endClock ? formatAwstIso(clampedStartDate, endClock) : '');
    return {
      startTime,
      endTime,
      recurrence: 'none',
      dayOfWeek: null
    };
  }

  if (nextDate) {
    const startTime = formatAwstIso(nextDate, startClock);
    const endTime = endClock ? formatAwstIso(nextDate, endClock) : '';
    return {
      startTime,
      endTime,
      recurrence: 'none',
      dayOfWeek: null
    };
  }

  return {
    startTime: item.startTime,
    endTime: item.endTime,
    recurrence: item.recurrence || 'none',
    dayOfWeek: item.dayOfWeek ?? null
  };
}

function mergeDetailIntoItem(item, detail, config) {
  const { venueName, address } = mergeLocationDetails(item, detail, config);
  const schedule = resolveHydratedSchedule(item, detail);
  const rawTags = [...new Set([...(item.rawTags || []), ...(detail.categoryTags || [])])];

  const costFields = (!item.costFields || item.costFields.cost_description === (config.defaultCost ?? 'See website')) && detail.costText
    ? resolveCostFields(detail.costText, undefined, config.defaultCost ?? 'See website')
    : item.costFields;

  return {
    ...item,
    venueName,
    address,
    rawTags,
    ...schedule,
    costFields
  };
}

function buildFilterCandidate(item) {
  return {
    title: item.title,
    category: item.rawTags.join(', '),
    venueName: item.venueName,
    address: item.address,
    start_time: item.startTime,
    ...(item.endTime ? { end_time: item.endTime } : {}),
    ...(item.recurrence === 'weekly' ? { recurrence: 'weekly', end_date: null } : {})
  };
}

function mapToRawActivity(item, config) {
  const { category, subcategory } = resolveCouncilCategoryAndSubcategory(item.rawTags, item.title);
  return {
    source: config.source,
    source_id: item.sourceId,
    source_url: item.url,
    external_url: item.url,
    region_id: config.regionId || 'perth',
    title: item.title,
    description: item.description,
    category,
    subcategory,
    ...(item.organizer ? { organizer: item.organizer } : {}),
    venue: {
      ...(item.venueName ? { name: item.venueName } : {}),
      ...(item.address ? { address: item.address } : {}),
      ...(item.coordinates ? { coordinates: item.coordinates } : {})
    },
    ...(item.venueName ? { venue_name: item.venueName } : {}),
    ...(item.address ? { address: item.address } : {}),
    ...(item.coordinates ? { coordinates: item.coordinates } : {}),
    start_time: item.startTime,
    ...(item.endTime ? { end_time: item.endTime } : {}),
    ...(item.recurrence === 'weekly' ? { recurrence: 'weekly', end_date: null } : {}),
    ...(item.dayOfWeek !== undefined && item.dayOfWeek !== null ? { day_of_week: item.dayOfWeek } : {}),
    ...item.costFields,
    demographics: {
      gender: 'all',
      age: 'all'
    }
  };
}

/**
 * Creates a config-driven AgencyWeb `aw_pagetypelisting` council crawler.
 *
 * @param {object} config
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createAwPageTypeListingCrawler(config, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const delayFn = options.delayFn || sleepMs;
  const pageSize = typeof options.pageSize === 'number' ? options.pageSize : (config.pageSize || DEFAULT_PAGE_SIZE);
  const maxPages = typeof options.maxPages === 'number' ? options.maxPages : (config.maxPages || DEFAULT_MAX_PAGES);
  const maxActivities = typeof options.maxActivities === 'number' ? options.maxActivities : (config.maxActivities || DEFAULT_MAX_ACTIVITIES);
  const pageDelayMs = typeof options.pageDelayMs === 'number' ? options.pageDelayMs : (config.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS);
  const detailDelayMs = typeof options.detailDelayMs === 'number' ? options.detailDelayMs : (config.detailDelayMs ?? DEFAULT_DETAIL_DELAY_MS);
  const hydrateDetail = options.hydrateDetail ?? config.hydrateDetail ?? 'when_missing';
  const requiredListingFields = config.requiredListingFields || ['address', 'time', 'tags'];
  const horizonDays = typeof options.horizonDays === 'number' ? options.horizonDays : (config.horizonDays || DEFAULT_HORIZON_DAYS);
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const filterOptions = {
    now: options.now,
    horizonDays
  };

  return {
    name: config.source,
    label: config.label,
    group: config.group || 'councils',
    minExpectedListings: config.minExpectedListings ?? 1,
    fallbackCentroid: config.fallbackCentroid,
    ...(config.localOnly ? { localOnly: true } : {}),

    async fetchListings() {
      if (typeof fetchFn !== 'function') {
        throw new Error(`${config.label || config.source}: fetchFn is required`);
      }

      const seenSourceIds = new Set();
      let totalKept = 0;

      return paginateCouncilPages({
        maxPages,
        maxActivities,
        pageDelayMs,
        delayFn,
        fetchPage: async (page) => {
          const payloadBody = {
            post_type: config.postType || 'event',
            SI: config.searchIndex ?? '',
            OB: config.orderBy ?? '',
            Q: config.query ?? '',
            PS: pageSize,
            FS: config.filterString ?? '',
            PG: page,
            PR: config.pageRange ?? '',
            IncludeFirst: page === 1 ? (config.includeFirst ?? true) : false
          };

          const signal = createTimeoutSignal(options.signal, timeoutMs);
          const response = await fetchFn(config.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'User-Agent': DEFAULT_USER_AGENT,
              ...(config.headers || {})
            },
            body: JSON.stringify(payloadBody),
            ...(signal ? { signal } : {})
          });

          if (!response.ok) {
            throw new Error(`${config.label || config.source} responded with HTTP ${response.status}: ${response.statusText || ''}`.trim());
          }

          const json = await response.json();
          const parsedItems = mergeResponseItems(json, config);
          const unseenItems = [];

          for (const item of parsedItems) {
            if (seenSourceIds.has(item.sourceId)) continue;
            seenSourceIds.add(item.sourceId);
            unseenItems.push(item);
          }

          const mappedItems = [];
          for (const rawItem of unseenItems) {
            if (totalKept >= maxActivities) break;

            if (!filterCouncilItem(buildFilterCandidate(rawItem), filterOptions)) {
              continue;
            }

            let item = rawItem;
            if (shouldHydrateDetail(item, hydrateDetail, requiredListingFields, config.baseUrl)) {
              if (detailDelayMs > 0) {
                await delayFn(detailDelayMs);
              }
              try {
                const detailSignal = createTimeoutSignal(options.signal, timeoutMs);
                const detailRes = await fetchFn(item.url, {
                  method: 'GET',
                  headers: {
                    Accept: 'text/html,application/xhtml+xml',
                    'User-Agent': DEFAULT_USER_AGENT,
                    ...(config.headers || {})
                  },
                  ...(detailSignal ? { signal: detailSignal } : {})
                });
                if (detailRes.ok && typeof detailRes.text === 'function') {
                  const detailHtml = await detailRes.text();
                  const detail = parseAwDetailPage(detailHtml);
                  item = mergeDetailIntoItem(item, detail, config);
                }
              } catch {
                // Keep listing-card data if detail hydration fails
              }
            }

            if (!filterCouncilItem(buildFilterCandidate(item), filterOptions)) {
              continue;
            }

            mappedItems.push(mapToRawActivity(item, config));
            totalKept += 1;
          }

          const totalPages = Number(json?.total_pages ?? json?.max_num_pages);
          const totalCount = Number(json?.total);
          const hasMoreByMeta = Number.isFinite(totalPages)
            ? page < totalPages
            : (Number.isFinite(totalCount) ? page * pageSize < totalCount : parsedItems.length >= pageSize);

          return {
            items: mappedItems,
            hasMore: Boolean(parsedItems.length > 0 && hasMoreByMeta)
          };
        }
      });
    }
  };
}
