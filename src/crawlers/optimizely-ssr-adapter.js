/**
 * Config-Driven Optimizely SSR JSON Council Crawler Adapter
 * Zero-dependency adapter for councils/sites publishing Activities via
 * Optimizely SSR JSON (<script type="application/json" id="site-search-app-state">).
 */

import { determineIsFree } from '../sanitizer.js';
import {
  DEFAULT_HORIZON_DAYS,
  DEFAULT_MAX_ACTIVITIES,
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_DELAY_MS,
  filterCouncilItem,
  paginateCouncilPages,
  resolveCouncilCategoryAndSubcategory
} from './council-utils.js';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot)';
const DEFAULT_SCRIPT_ID = 'site-search-app-state';

function resolveUrl(baseUrl, pageUrl) {
  if (!pageUrl) return baseUrl;
  if (/^https?:\/\//i.test(pageUrl)) return pageUrl;
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = pageUrl.startsWith('/') ? pageUrl : `/${pageUrl}`;
  return `${normalizedBase}${normalizedPath}`;
}

function buildPageUrl(endpoint, page) {
  const url = new URL(endpoint);
  url.searchParams.set('page', String(page));
  return url.toString();
}

function extractCategoryNames(categories) {
  if (!Array.isArray(categories)) return [];
  return categories
    .map(c => (typeof c === 'string' ? c : c?.name || ''))
    .map(s => s.trim())
    .filter(Boolean);
}

function extractScheduleTimes(props) {
  const listing = props.EventListing || {};
  const dateParts = Array.isArray(listing.dateParts) ? listing.dateParts : [];
  const timeParts = Array.isArray(listing.timeParts) ? listing.timeParts : [];

  const startTime = timeParts[0]?.isoDateTime || dateParts[0]?.isoDateTime || props.StartDate || props.Date || null;
  const endTime = dateParts[1]?.isoDateTime || timeParts[1]?.isoDateTime || props.EndDate || null;

  return { startTime, endTime };
}

function resolveOrganizer(item, props, defaultOrganizer) {
  const explicitName = [
    props.OrganizerName,
    props.Organizer,
    props.Organiser,
    props.Host,
    item.organizer?.name,
    typeof item.organizer === 'string' ? item.organizer : null
  ].find(val => typeof val === 'string' && val.trim().length > 0);

  if (explicitName) {
    const website = props.OrganizerWebsite || item.organizer?.website;
    return {
      name: explicitName.trim(),
      ...(typeof website === 'string' && website.trim() ? { website: website.trim() } : {})
    };
  }

  if (defaultOrganizer && typeof defaultOrganizer === 'object') {
    return { ...defaultOrganizer };
  }

  return undefined;
}

function resolveCostString(props, categoryNames) {
  if (typeof props.Cost === 'string' && props.Cost.trim()) {
    return props.Cost.trim();
  }
  const hasFreeTag = categoryNames.some(tag => /^free$/i.test(tag));
  if (hasFreeTag) return 'Free';
  const hasTicketedTag = categoryNames.some(tag => /^ticketed$/i.test(tag));
  if (hasTicketedTag) return 'Ticketed';
  return 'Free';
}

/**
 * Extracts and parses the Optimizely SSR JSON payload from an HTML document.
 *
 * @param {string} html
 * @param {string} [scriptId='site-search-app-state']
 * @returns {object}
 */
export function extractOptimizelyAppState(html, scriptId = DEFAULT_SCRIPT_ID) {
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error(`Optimizely SSR HTML is empty (expected #${scriptId})`);
  }

  const escapedId = scriptId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scriptRegex = new RegExp(
    `<script\\b[^>]*\\bid=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/script>`,
    'i'
  );
  const match = html.match(scriptRegex);
  if (!match) {
    throw new Error(`Missing Optimizely SSR state script #${scriptId}`);
  }

  try {
    return JSON.parse(match[1].trim());
  } catch (err) {
    throw new Error(`Invalid JSON in Optimizely SSR state script #${scriptId}: ${err.message}`);
  }
}

function mapOptimizelyRecord(item, index, config, extracted = null) {
  const props = extracted?.props || item.properties || item;
  const title = (props.Name || props.Title || item.title || '').trim() || 'Community Activity';
  const categoryNames = extracted?.categoryNames || extractCategoryNames(props.Categories || item.categories);
  const { category, subcategory } = resolveCouncilCategoryAndSubcategory(categoryNames, title);

  const hasCoords =
    typeof props.Latitude === 'number' &&
    !Number.isNaN(props.Latitude) &&
    typeof props.Longitude === 'number' &&
    !Number.isNaN(props.Longitude);

  const coordinates = hasCoords
    ? { lat: props.Latitude, lng: props.Longitude }
    : undefined;

  const venueName = (props.Location || props.VenueName || '').trim();
  const address = (props.Address || venueName || '').trim();
  const url = resolveUrl(config.baseUrl, props.Url || item.url);
  const costStr = resolveCostString(props, categoryNames);
  const startTime = extracted ? extracted.startTime : extractScheduleTimes(props).startTime;
  const endTime = extracted ? extracted.endTime : extractScheduleTimes(props).endTime;
  const organizer = resolveOrganizer(item, props, config.defaultOrganizer);

  return {
    source: config.source,
    source_id: String(item.contentGuid || props.Id || item.id || index + 1),
    source_url: url,
    external_url: url,
    region_id: config.regionId || 'perth',
    title,
    description: props.Summary || props.Description || '',
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
    start_time: startTime,
    ...(endTime ? { end_time: endTime } : {}),
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
 * Creates a config-driven Optimizely SSR JSON crawler instance.
 *
 * @param {object} config
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createOptimizelySsrCrawler(config, options = {}) {
  if (!config?.source || !config?.endpoint || !config?.baseUrl) {
    throw new Error('Optimizely SSR adapter requires source, endpoint, and baseUrl in config');
  }

  const fetchFn = options.fetchFn || globalThis.fetch;
  const scriptId = config.scriptId || DEFAULT_SCRIPT_ID;
  const timeoutMs = options.timeoutMs || config.timeoutMs || 15000;
  const maxPages = options.maxPages ?? config.maxPages ?? DEFAULT_MAX_PAGES;
  const maxItems = options.maxItems ?? config.maxItems ?? DEFAULT_MAX_ACTIVITIES;
  const pageDelayMs = options.pageDelayMs ?? config.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
  const horizonDays = options.horizonDays ?? config.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const minExpectedListings = typeof options.minExpectedListings === 'number'
    ? options.minExpectedListings
    : config.minExpectedListings;

  return {
    name: config.source,
    group: config.group || 'councils',
    ...(typeof minExpectedListings === 'number' ? { minExpectedListings } : {}),
    ...(config.fallbackCentroid ? { fallbackCentroid: config.fallbackCentroid } : {}),

    async fetchListings() {
      const headers = {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': config.userAgent || DEFAULT_USER_AGENT
      };

      const filterOptions = {
        now: options.now,
        horizonDays
      };

      return paginateCouncilPages({
        maxPages,
        maxActivities: maxItems,
        pageDelayMs,
        delayFn: options.delayFn,
        fetchPage: async (page) => {
          const pageUrl = buildPageUrl(config.endpoint, page);
          const signal = options.signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);

          const response = await fetchFn(pageUrl, {
            method: 'GET',
            headers,
            ...(signal ? { signal } : {})
          });

          if (!response.ok) {
            throw new Error(`${config.label || config.source} responded with HTTP ${response.status}: ${response.statusText}`);
          }

          const html = await response.text();
          const appState = extractOptimizelyAppState(html, scriptId);
          const resultsContainer = appState.results || {};
          const records = Array.isArray(resultsContainer.results) ? resultsContainer.results : [];
          const totalRecords = typeof resultsContainer.totalRecords === 'number'
            ? resultsContainer.totalRecords
            : null;
          const pageSize = typeof resultsContainer.pageSize === 'number' && resultsContainer.pageSize > 0
            ? resultsContainer.pageSize
            : (typeof appState.pageSize === 'number' && appState.pageSize > 0 ? appState.pageSize : records.length || 24);

          const hasMore = records.length > 0 && (
            totalRecords !== null ? (page * pageSize < totalRecords) : (records.length >= pageSize)
          );

          const mappedAndFiltered = [];
          for (let i = 0; i < records.length; i++) {
            const record = records[i];
            const props = record.properties || record;
            const categoryNames = extractCategoryNames(props.Categories || record.categories);
            const { startTime, endTime } = extractScheduleTimes(props);
            const filterCandidate = {
              title: props.Name || props.Title || record.title || '',
              category: categoryNames.join(', '),
              venueName: props.Location || props.VenueName || '',
              address: props.Address || props.Location || '',
              start_time: startTime,
              ...(endTime ? { end_time: endTime } : {})
            };

            if (filterCouncilItem(filterCandidate, filterOptions)) {
              mappedAndFiltered.push(
                mapOptimizelyRecord(record, (page - 1) * pageSize + i, config, {
                  props,
                  categoryNames,
                  startTime,
                  endTime
                })
              );
            }
          }

          return {
            items: mappedAndFiltered,
            hasMore
          };
        }
      });
    }
  };
}
