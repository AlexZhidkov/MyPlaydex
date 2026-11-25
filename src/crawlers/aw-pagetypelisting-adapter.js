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
const DEFAULT_TIMEOUT_MS = 20000;

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

    const nativeId = extractAttr(attrs, 'data-id') || extractAttr(attrs, 'data-event-id') || '';
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
    const venueName = extractTextByClassOrder(innerHtml, ['aw-card-venue', 'card-venue', 'venue', 'location']);
    const address = extractTextByClassOrder(innerHtml, ['aw-card-address', 'card-address', 'address']);
    const dateText = extractTextByClassOrder(innerHtml, ['aw-card-date', 'card-date', 'event-date', 'date']);
    const timeText = extractTextByClassOrder(innerHtml, ['aw-card-time', 'card-time', 'event-time', 'time']);
    const costText = extractTextByClassOrder(innerHtml, ['aw-cost-badge', 'cost-badge', 'cost', 'price']);
    const tagText = extractTextByClassOrder(innerHtml, ['aw-card-category', 'event-categories', 'categories', 'tags']);

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
  const candidate = record.ID ?? record.id ?? record.post_id ?? record.event_id ?? record.nativeId;
  return candidate !== undefined && candidate !== null && String(candidate).trim() !== ''
    ? String(candidate).trim()
    : '';
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
      let hour = Number.parseInt(startMatch[1], 10);
      const min = startMatch[2] || '00';
      const meridiem = startMatch[3].toLowerCase();
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      return `${trimmed}T${String(hour).padStart(2, '0')}:${min}:00+08:00`;
    }
    return `${trimmed}T00:00:00+08:00`;
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
  const rawStartDate = sortedItem.next_date || dataItem.next_date || dataItem.start_date || dataItem.start_time || htmlCard.dateText || '';
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
    startTime,
    endTime,
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
          for (const item of unseenItems) {
            if (totalKept >= maxActivities) break;

            const filterCandidate = {
              title: item.title,
              category: item.rawTags.join(', '),
              venueName: item.venueName,
              address: item.address,
              start_time: item.startTime,
              ...(item.endTime ? { end_time: item.endTime } : {})
            };

            if (!filterCouncilItem(filterCandidate, filterOptions)) {
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
