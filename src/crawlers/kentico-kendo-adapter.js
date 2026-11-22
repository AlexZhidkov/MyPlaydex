/**
 * Config-Driven Kentico / Kendo UI Council Crawler Adapter
 * Zero-dependency adapter for Greater Perth councils publishing Activities via
 * Kentico Kendo UI JSON search endpoints.
 */

import { determineIsFree, slugify } from '../sanitizer.js';
import {
  DEFAULT_HORIZON_DAYS,
  DEFAULT_MAX_ACTIVITIES,
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_DELAY_MS,
  deriveDeterministicCouncilSourceId,
  filterCouncilItem,
  paginateCouncilPages,
  resolveCouncilCategoryAndSubcategory
} from './council-utils.js';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot)';

function resolveUrl(baseUrl, pageUrl) {
  if (!pageUrl) return baseUrl;
  if (/^https?:\/\//i.test(pageUrl)) return pageUrl;
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = pageUrl.startsWith('/') ? pageUrl : `/${pageUrl}`;
  return `${normalizedBase}${normalizedPath}`;
}

function resolveOrganizer(item, defaultOrganizer) {
  const explicitName = [
    item.OrganizerName,
    item.Organizer,
    item.Organiser,
    item.Host
  ].find(val => typeof val === 'string' && val.trim().length > 0);

  if (explicitName) {
    return {
      name: explicitName.trim(),
      ...(typeof item.OrganizerWebsite === 'string' && item.OrganizerWebsite.trim()
        ? { website: item.OrganizerWebsite.trim() }
        : {})
    };
  }

  if (defaultOrganizer && typeof defaultOrganizer === 'object') {
    return { ...defaultOrganizer };
  }

  return undefined;
}

function normalizeKenticoTimestamp(rawDate) {
  if (typeof rawDate !== 'string') return rawDate || null;
  const trimmed = rawDate.trim();
  if (!trimmed) return null;
  // Naive ISO datetimes from Kentico (e.g. "2026-11-22T00:00:00") are in AWST (+08:00).
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(trimmed)) {
    return `${trimmed}+08:00`;
  }
  return trimmed;
}

function extractKenticoStartDate(item) {
  const raw = item.EventStartDate || item.StartDate || item.EventDate || item.EventDisplayDate || item.ArticleReleaseDate || null;
  return normalizeKenticoTimestamp(raw);
}

function extractKenticoVenueName(item) {
  const rawVenues = Array.isArray(item.Venues)
    ? item.Venues.find(v => typeof v === 'string' && v.trim().length > 0)
    : item.Venues;
  return (item.ArticleAddressTitle || item.VenueName || item.Location || rawVenues || '').trim();
}

function extractKenticoDescription(item) {
  const teaser = typeof item.ArticleTeaser === 'string' && !/^\/getContentAsset\//i.test(item.ArticleTeaser.trim())
    ? item.ArticleTeaser
    : '';
  return (item.ArticleSummary || teaser || item.ArticleDescription || '').trim();
}

function deriveSlugFromPageUrl(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return '';
  try {
    const pathname = /^https?:\/\//i.test(pageUrl) ? new URL(pageUrl).pathname : pageUrl.split(/[?#]/)[0];
    const lastSegment = pathname.split('/').filter(Boolean).pop() || '';
    return slugify(lastSegment);
  } catch {
    return '';
  }
}

function mapKenticoRecord(item, index, config) {
  const title = (item.ArticleTitle || item.Title || '').trim() || 'Community Activity';
  const rawTags = item.ArticleCategories || item.Categories || item.Category || '';
  const { category, subcategory } = resolveCouncilCategoryAndSubcategory(rawTags, title);

  const hasCoords =
    typeof item.Latitude === 'number' &&
    !Number.isNaN(item.Latitude) &&
    typeof item.Longitude === 'number' &&
    !Number.isNaN(item.Longitude);

  const coordinates = hasCoords
    ? { lat: item.Latitude, lng: item.Longitude }
    : undefined;

  const venueName = extractKenticoVenueName(item);
  const address = (item.ArticleAddress || item.Address || venueName || '').trim();
  const url = resolveUrl(config.baseUrl, item.PageUrl);
  const costStr = item.Cost || 'Free';
  const rawStart = extractKenticoStartDate(item);
  const rawEnd = item.EventEndDate || item.EndDate || null;
  const organizer = resolveOrganizer(item, config.defaultOrganizer);
  const sourceId = deriveDeterministicCouncilSourceId({
    nativeId: item.NodeGUID || item.ArticleID || item.id || deriveSlugFromPageUrl(item.PageUrl),
    url: item.PageUrl ? url : '',
    title,
    startTime: rawStart
  });

  return {
    source: config.source,
    source_id: sourceId,
    source_url: url,
    external_url: url,
    region_id: config.regionId || 'perth',
    title,
    description: extractKenticoDescription(item),
    category,
    subcategory,
    ...(organizer ? { organizer } : {}),
    venue: {
      ...(venueName ? { name: venueName } : {}),
      ...(address ? { address } : {}),
      ...(coordinates ? { coordinates } : {})
    },
    ...(venueName ? { venue_name: venueName } : {}),
    ...(address ? { address } : {}),
    ...(coordinates ? { coordinates } : {}),
    start_time: rawStart,
    ...(rawEnd ? { end_time: rawEnd } : {}),
    cost_description: costStr,
    display_price: costStr,
    is_free: determineIsFree(costStr),
    demographics: {
      gender: 'all',
      age: 'all'
    }
  };
}

/**
 * Creates a config-driven Kentico/Kendo crawler instance.
 *
 * @param {object} config
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createKenticoKendoCrawler(config, options = {}) {
  if (!config?.source || !config?.endpoint || !config?.baseUrl) {
    throw new Error('Kentico/Kendo adapter requires source, endpoint, and baseUrl in config');
  }

  const fetchFn = options.fetchFn || globalThis.fetch;
  const pageSize = options.pageSize || config.pageSize || 50;
  const timeoutMs = options.timeoutMs || config.timeoutMs || 15000;
  const maxPages = options.maxPages ?? config.maxPages ?? DEFAULT_MAX_PAGES;
  const maxItems = options.maxItems ?? config.maxItems ?? DEFAULT_MAX_ACTIVITIES;
  const pageDelayMs = options.pageDelayMs ?? config.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
  const horizonDays = options.horizonDays ?? config.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const minExpectedListings = typeof options.minExpectedListings === 'number'
    ? options.minExpectedListings
    : config.minExpectedListings;

  const searchParamHeader = typeof config.searchParam === 'string'
    ? config.searchParam
    : JSON.stringify(config.searchParam || []);
  const searchFilterHeader = typeof config.searchFilter === 'string'
    ? config.searchFilter
    : JSON.stringify(config.searchFilter || []);

  return {
    name: config.source,
    group: config.group || 'councils',
    ...(typeof minExpectedListings === 'number' ? { minExpectedListings } : {}),
    ...(config.fallbackCentroid ? { fallbackCentroid: config.fallbackCentroid } : {}),

    async fetchListings() {
      const headers = {
        'Content-Type': 'application/json',
        'SearchParam': searchParamHeader,
        'SearchFilter': searchFilterHeader,
        'User-Agent': config.userAgent || DEFAULT_USER_AGENT
      };

      const filterOptions = {
        now: options.now,
        horizonDays
      };

      const collected = await paginateCouncilPages({
        maxPages,
        maxActivities: maxItems,
        pageDelayMs,
        delayFn: options.delayFn,
        fetchPage: async (page) => {
          const skip = (page - 1) * pageSize;
          const body = JSON.stringify({
            page,
            pageSize,
            skip,
            take: pageSize
          });

          const signal = options.signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);

          const response = await fetchFn(config.endpoint, {
            method: 'POST',
            headers,
            body,
            ...(signal ? { signal } : {})
          });

          if (!response.ok) {
            throw new Error(`${config.label || config.source} API responded with HTTP ${response.status}: ${response.statusText}`);
          }

          const json = await response.json();
          const records = json.Data || json.data || [];
          const total = typeof json.Total === 'number' ? json.Total : (typeof json.total === 'number' ? json.total : null);
          const hasMore = records.length > 0 && (total !== null ? (page * pageSize < total) : (records.length >= pageSize));

          const mappedAndFiltered = [];
          for (let i = 0; i < records.length; i++) {
            const record = records[i];
            const rawStart = extractKenticoStartDate(record);
            const rawEnd = record.EventEndDate || record.EndDate || null;
            const venueName = extractKenticoVenueName(record);
            const rawCategory = Array.isArray(record.ArticleCategories || record.Categories)
              ? (record.ArticleCategories || record.Categories).join(', ')
              : (record.ArticleCategories || record.Categories || record.Category || '');
            if (filterCouncilItem({
              ...record,
              venueName,
              category: rawCategory,
              start_time: rawStart,
              ...(rawEnd ? { end_time: rawEnd } : {})
            }, filterOptions)) {
              mappedAndFiltered.push(mapKenticoRecord(record, skip + i, config));
            }
          }

          return {
            items: mappedAndFiltered,
            hasMore
          };
        }
      });

      return collected;
    }
  };
}
