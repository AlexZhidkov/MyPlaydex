/**
 * Eventbrite Perth Activities Crawler Adapter (HTTP Transport)
 * Fetches Eventbrite search pages (zero detail-page HTTP requests) and delegates
 * extraction, normalization, and pre-ingestion filtering to eventbrite-parser.js.
 */

import {
  extractEventbriteId,
  formatSchemaAddress,
  collectSchemaActivities,
  extractJsonLdActivities,
  extractServerData,
  extractServerDataActivities,
  extractEventbritePageCount,
  mergeEventbriteActivities,
  anchorAwstTimestamp,
  resolvePerthCoordinates,
  parseActivityCost,
  inferDemographics,
  shouldDropActivity,
  mapEventbriteActivityToListing,
  parseEventbriteHtml,
  parseEventbritePage
} from './eventbrite-parser.js';

export const EVENTBRITE_PERTH_ALL_URL = 'https://www.eventbrite.com.au/d/australia--perth--4807/all-events/';
export const EVENTBRITE_PERTH_SPORTS_URL = 'https://www.eventbrite.com.au/d/australia--perth--4807/sports--events/';

export const EVENTBRITE_PERTH_FEEDS = Object.freeze([
  { slug: 'all-events', url: EVENTBRITE_PERTH_ALL_URL, category: undefined, priority: 0 },
  { slug: 'sports', url: EVENTBRITE_PERTH_SPORTS_URL, category: 'sports', priority: 1 },
  { slug: 'health', url: 'https://www.eventbrite.com.au/d/australia--perth--4807/health--events/', category: 'health', priority: 1 },
  { slug: 'arts', url: 'https://www.eventbrite.com.au/d/australia--perth--4807/arts--events/', category: 'arts', priority: 1 },
  { slug: 'music', url: 'https://www.eventbrite.com.au/d/australia--perth--4807/music--events/', category: 'music', priority: 1 },
  { slug: 'community', url: 'https://www.eventbrite.com.au/d/australia--perth--4807/community--events/', category: 'community', priority: 1 },
  { slug: 'family-and-education', url: 'https://www.eventbrite.com.au/d/australia--perth--4807/family-and-education--events/', category: 'family', priority: 1 },
  { slug: 'food-and-drink', url: 'https://www.eventbrite.com.au/d/australia--perth--4807/food-and-drink--events/', category: 'food', priority: 1 },
  { slug: 'hobbies', url: 'https://www.eventbrite.com.au/d/australia--perth--4807/hobbies--events/', category: 'hobbies', priority: 1 },
  { slug: 'travel-and-outdoor', url: 'https://www.eventbrite.com.au/d/australia--perth--4807/travel-and-outdoor--events/', category: 'travel', priority: 1 }
]);

export {
  extractEventbriteId,
  formatSchemaAddress,
  collectSchemaActivities,
  extractJsonLdActivities,
  extractJsonLdActivities as extractJsonLdEvents,
  extractServerData,
  extractServerDataActivities,
  extractEventbritePageCount,
  mergeEventbriteActivities,
  anchorAwstTimestamp,
  resolvePerthCoordinates,
  parseActivityCost,
  inferDemographics,
  shouldDropActivity,
  mapEventbriteActivityToListing,
  parseEventbriteHtml,
  parseEventbritePage
};

export const DEFAULT_EVENTBRITE_MAX_PAGES = 5;

export const EVENTBRITE_REQUEST_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8'
});

/**
 * Builds a paginated Eventbrite directory URL (`?page=N`).
 *
 * @param {string} baseUrl
 * @param {number} page
 * @returns {string}
 */
export function buildEventbritePageUrl(baseUrl, page = 1) {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set('page', String(page));
  return parsed.toString();
}

/**
 * Deduplicates Eventbrite listings by `source_id`, letting higher-priority
 * category feeds override lower-priority feeds (e.g. `/all-events/`).
 *
 * @param {Array<{ listing: object, priority?: number }>} prioritizedListings
 * @returns {Array<object>}
 */
export function deduplicateEventbriteListings(prioritizedListings = []) {
  const byId = new Map();
  for (const item of prioritizedListings) {
    const listing = item?.listing || item;
    const priority = typeof item?.priority === 'number' ? item.priority : 0;
    const id = listing?.source_id;
    if (!id) continue;

    const existing = byId.get(id);
    if (!existing || priority > existing.priority) {
      byId.set(id, { listing, priority });
    }
  }
  return Array.from(byId.values(), item => item.listing);
}

/**
 * Parses a single Eventbrite search page, updates per-feed seen IDs,
 * appends prioritized listings, and returns whether pagination should stop.
 *
 * @param {string} html
 * @param {{ feed: object, priority: number, seenIds: Set<string> }} feedState
 * @param {Array<{ listing: object, priority: number }>} collected
 * @param {Date|string} [now]
 * @param {number} page
 * @param {number} maxPages
 * @returns {{ exhausted: boolean, pageCount: number|null, newIdsOnPage: number }}
 */
export function collectEventbritePage(html, feedState, collected, now, page, maxPages) {
  const { listings, pageCount, rawIds } = parseEventbritePage(html, {
    defaultCategory: feedState.feed.category,
    now
  });

  let newIdsOnPage = 0;
  for (const rawId of rawIds) {
    if (!feedState.seenIds.has(rawId)) {
      feedState.seenIds.add(rawId);
      newIdsOnPage += 1;
    }
  }

  for (const listing of listings) {
    collected.push({ listing, priority: feedState.priority });
  }

  const exhausted = page >= maxPages || (pageCount !== null && page >= pageCount) || newIdsOnPage === 0;
  return { exhausted, pageCount, newIdsOnPage };
}

async function fetchEventbritePageHtml(fetchFn, url, { timeoutMs = 15000, signal } = {}) {
  const effectiveSignal = signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
  const response = await fetchFn(url, {
    method: 'GET',
    headers: EVENTBRITE_REQUEST_HEADERS,
    ...(effectiveSignal ? { signal: effectiveSignal } : {})
  });

  if (!response.ok) {
    const err = new Error(`Eventbrite responded with HTTP ${response.status}: ${response.statusText}`);
    err.status = response.status;
    throw err;
  }

  return response.text();
}

/**
 * Creates an Eventbrite Perth Crawler instance.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn=globalThis.fetch]
 * @param {string} [options.url=EVENTBRITE_PERTH_SPORTS_URL]
 * @param {boolean} [options.multiFeed=false]
 * @param {Array<object>} [options.feeds]
 * @param {number} [options.maxPages=DEFAULT_EVENTBRITE_MAX_PAGES]
 * @param {string} [options.category]
 * @param {number} [options.timeoutMs=15000]
 * @param {number} [options.minExpectedListings]
 * @param {Date|string} [options.now]
 * @returns {object} Crawler instance
 */
export function createEventbriteCrawler(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const url = options.url || EVENTBRITE_PERTH_SPORTS_URL;
  const timeoutMs = options.timeoutMs || 15000;
  const isMultiFeed = Boolean(options.multiFeed || Array.isArray(options.feeds));
  const feeds = Array.isArray(options.feeds) ? options.feeds : EVENTBRITE_PERTH_FEEDS;
  const maxPages = Number.isFinite(options.maxPages) && options.maxPages > 0
    ? Math.floor(options.maxPages)
    : DEFAULT_EVENTBRITE_MAX_PAGES;

  return {
    name: 'eventbrite',
    localOnly: true,
    ...(typeof options.minExpectedListings === 'number' ? { minExpectedListings: options.minExpectedListings } : {}),

    async fetchListings() {
      if (!isMultiFeed) {
        const html = await fetchEventbritePageHtml(fetchFn, url, { timeoutMs, signal: options.signal });
        return parseEventbriteHtml(html, {
          defaultCategory: options.category,
          now: options.now
        });
      }

      const collected = [];
      for (const feed of feeds) {
        const feedState = {
          feed,
          priority: typeof feed.priority === 'number' ? feed.priority : (feed.slug === 'all-events' ? 0 : 1),
          seenIds: new Set()
        };

        for (let page = 1; page <= maxPages; page++) {
          const pageUrl = buildEventbritePageUrl(feed.url, page);
          const html = await fetchEventbritePageHtml(fetchFn, pageUrl, { timeoutMs, signal: options.signal });
          const { exhausted } = collectEventbritePage(html, feedState, collected, options.now, page, maxPages);
          if (exhausted) {
            break;
          }
        }
      }

      return deduplicateEventbriteListings(collected);
    }
  };
}
