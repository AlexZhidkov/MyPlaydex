/**
 * Humanitix Perth Activities Crawler Adapter (HTTP Transport)
 * Fetches Humanitix Greater Perth category search SSR pages and optional
 * `/api/search` pagination (zero detail-page HTTP requests), delegating
 * extraction, filtering, and mapping to humanitix-parser.js.
 */

import {
  extractHumanitixNextData,
  buildHumanitixEventUrl,
  resolveHumanitixSchedule,
  resolveHumanitixLocation,
  parseHumanitixCost,
  inferCategoryForOtherFeed,
  shouldDropHumanitixActivity,
  mapHumanitixEventToListing,
  parseHumanitixApiEvents,
  parseHumanitixSearchPage
} from './humanitix-parser.js';

export const HUMANITIX_PERTH_SEARCH_URL = 'https://humanitix.com/au/search/au--wa--perth';
export const HUMANITIX_API_SEARCH_URL = 'https://humanitix.com/api/search';
export const DEFAULT_HUMANITIX_MAX_PAGES = 3;

export const HUMANITIX_PERTH_FEEDS = Object.freeze([
  { slug: 'sportsAndFitness', humanitixCategory: 'sportsAndFitness', category: 'sports', priority: 1 },
  { slug: 'healthAndWellness', humanitixCategory: 'healthAndWellness', category: 'health', priority: 1 },
  { slug: 'performingAndVisualArts', humanitixCategory: 'performingAndVisualArts', category: 'arts', priority: 1 },
  { slug: 'music', humanitixCategory: 'music', category: 'music', priority: 1 },
  { slug: 'communityAndCulture', humanitixCategory: 'communityAndCulture', category: 'community', priority: 1 },
  { slug: 'charityAndCauses', humanitixCategory: 'charityAndCauses', category: 'community', priority: 1 },
  { slug: 'familyAndEducation', humanitixCategory: 'familyAndEducation', category: 'family', priority: 1 },
  { slug: 'foodAndDrink', humanitixCategory: 'foodAndDrink', category: 'food', priority: 1 },
  { slug: 'hobbiesAndSpecialInterest', humanitixCategory: 'hobbiesAndSpecialInterest', category: 'hobbies', priority: 1 },
  { slug: 'travelAndOutdoor', humanitixCategory: 'travelAndOutdoor', category: 'travel', priority: 1 },
  { slug: 'other', humanitixCategory: 'other', category: undefined, priority: 0 }
]);

export const HUMANITIX_REQUEST_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8'
});

export {
  extractHumanitixNextData,
  buildHumanitixEventUrl,
  resolveHumanitixSchedule,
  resolveHumanitixLocation,
  parseHumanitixCost,
  inferCategoryForOtherFeed,
  shouldDropHumanitixActivity,
  mapHumanitixEventToListing,
  parseHumanitixApiEvents,
  parseHumanitixSearchPage
};

/**
 * Builds the SSR search URL for a Humanitix Perth category feed.
 *
 * @param {object} feed
 * @param {string} [baseUrl=HUMANITIX_PERTH_SEARCH_URL]
 * @returns {string}
 */
export function buildHumanitixFeedUrl(feed, baseUrl = HUMANITIX_PERTH_SEARCH_URL) {
  const parsed = new URL(baseUrl);
  const cat = feed?.humanitixCategory || feed?.slug;
  if (cat) {
    parsed.searchParams.set('categories', cat);
  }
  return parsed.toString();
}

/**
 * Builds the `POST /api/search` JSON request body for 0-indexed page >= 1.
 *
 * @param {object} params
 * @returns {object|null}
 */
export function buildHumanitixSearchApiBody({ feed, page, stateKey, geobox, locale = 'AU' } = {}) {
  if (!geobox || !stateKey || !Number.isFinite(page) || page < 1) {
    return null;
  }

  const cat = feed?.humanitixCategory || feed?.slug;
  return {
    page,
    categories: cat ? [cat] : [],
    stateKey,
    geocode: {
      name: geobox.name,
      countryCode: geobox.countryCode,
      latLng: geobox.latLng,
      northeast: geobox.northeast,
      southwest: geobox.southwest,
      area: geobox.area
    },
    query: '',
    locationQuery: geobox.address || 'Perth WA, Australia',
    locationType: 'inPerson',
    types: [],
    subcategories: [],
    interests: [],
    accessibility: [],
    locale: locale || 'AU'
  };
}

/**
 * Deduplicates Humanitix listings by `source_id`, letting priority-1 category feeds
 * override priority-0 `other` feed entries.
 *
 * @param {Array<{ listing: object, priority?: number }>} prioritizedListings
 * @returns {Array<object>}
 */
export function deduplicateHumanitixListings(prioritizedListings = []) {
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
 * Collects parsed Humanitix events into `collected` and returns pagination status.
 *
 * @param {object} parsed - Output of `parseHumanitixSearchPage` or `parseHumanitixApiEvents`
 * @param {{ feed: object, priority: number, seenIds: Set<string>, stateKey?: string|null, geobox?: object|null, locale?: string|null }} feedState
 * @param {Array<{ listing: object, priority: number }>} collected
 * @param {number} page - 0-indexed page number
 * @param {number} maxPages
 * @returns {{ exhausted: boolean, newIdsOnPage: number }}
 */
export function collectHumanitixPage(parsed, feedState, collected, page, maxPages) {
  if (parsed.stateKey) feedState.stateKey = parsed.stateKey;
  if (parsed.geobox) feedState.geobox = parsed.geobox;
  if (parsed.locale) feedState.locale = parsed.locale;

  let newIdsOnPage = 0;
  for (const rawId of parsed.rawIds || []) {
    if (!feedState.seenIds.has(rawId)) {
      feedState.seenIds.add(rawId);
      newIdsOnPage += 1;
    }
  }

  for (const listing of parsed.listings || []) {
    collected.push({ listing, priority: feedState.priority });
  }

  const nextPage = page + 1;
  const hasApiContext = Boolean(feedState.stateKey && feedState.geobox);
  const exhausted = nextPage >= maxPages || newIdsOnPage === 0 || !hasApiContext;
  return { exhausted, newIdsOnPage };
}

async function fetchHumanitixSsrHtml(fetchFn, url, { timeoutMs = 15000, signal } = {}) {
  const effectiveSignal = signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
  const response = await fetchFn(url, {
    method: 'GET',
    headers: HUMANITIX_REQUEST_HEADERS,
    ...(effectiveSignal ? { signal: effectiveSignal } : {})
  });

  if (!response.ok) {
    const err = new Error(`Humanitix responded with HTTP ${response.status}: ${response.statusText}`);
    err.status = response.status;
    throw err;
  }

  return response.text();
}

async function fetchHumanitixApiPage(fetchFn, apiUrl, body, { timeoutMs = 15000, signal } = {}) {
  const effectiveSignal = signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
  const response = await fetchFn(apiUrl, {
    method: 'POST',
    headers: {
      ...HUMANITIX_REQUEST_HEADERS,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body),
    ...(effectiveSignal ? { signal: effectiveSignal } : {})
  });

  if (!response.ok) {
    const err = new Error(`Humanitix /api/search responded with HTTP ${response.status}: ${response.statusText}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

/**
 * Creates a Humanitix Perth Crawler instance.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn=globalThis.fetch]
 * @param {string} [options.baseUrl=HUMANITIX_PERTH_SEARCH_URL]
 * @param {string} [options.apiUrl=HUMANITIX_API_SEARCH_URL]
 * @param {Array<object>} [options.feeds=HUMANITIX_PERTH_FEEDS]
 * @param {number} [options.maxPages=DEFAULT_HUMANITIX_MAX_PAGES]
 * @param {number} [options.timeoutMs=15000]
 * @param {number} [options.minExpectedListings]
 * @param {Date|string} [options.now]
 * @returns {object} Crawler instance
 */
export function createHumanitixCrawler(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const baseUrl = options.baseUrl || HUMANITIX_PERTH_SEARCH_URL;
  const apiUrl = options.apiUrl || HUMANITIX_API_SEARCH_URL;
  const timeoutMs = options.timeoutMs || 15000;
  const feeds = Array.isArray(options.feeds) ? options.feeds : HUMANITIX_PERTH_FEEDS;
  const maxPages = Number.isFinite(options.maxPages) && options.maxPages > 0
    ? Math.floor(options.maxPages)
    : DEFAULT_HUMANITIX_MAX_PAGES;

  return {
    name: 'humanitix',
    localOnly: true,
    ...(typeof options.minExpectedListings === 'number' ? { minExpectedListings: options.minExpectedListings } : {}),

    async fetchListings() {
      const collected = [];

      for (const feed of feeds) {
        const feedState = {
          feed,
          priority: typeof feed.priority === 'number' ? feed.priority : (feed.slug === 'other' ? 0 : 1),
          seenIds: new Set(),
          stateKey: null,
          geobox: null,
          locale: 'AU'
        };

        const ssrUrl = buildHumanitixFeedUrl(feed, baseUrl);
        const html = await fetchHumanitixSsrHtml(fetchFn, ssrUrl, { timeoutMs, signal: options.signal });
        const ssrParsed = parseHumanitixSearchPage(html, {
          defaultCategory: feed.category,
          now: options.now
        });

        const { exhausted } = collectHumanitixPage(ssrParsed, feedState, collected, 0, maxPages);
        if (exhausted) {
          continue;
        }

        for (let page = 1; page < maxPages; page++) {
          const body = buildHumanitixSearchApiBody({
            feed,
            page,
            stateKey: feedState.stateKey,
            geobox: feedState.geobox,
            locale: feedState.locale
          });
          if (!body) break;

          try {
            const apiEvents = await fetchHumanitixApiPage(fetchFn, apiUrl, body, { timeoutMs, signal: options.signal });
            if (!Array.isArray(apiEvents)) break;

            const apiParsed = parseHumanitixApiEvents(apiEvents, {
              defaultCategory: feed.category,
              now: options.now
            });
            const pageResult = collectHumanitixPage(apiParsed, feedState, collected, page, maxPages);
            if (pageResult.exhausted) {
              break;
            }
          } catch {
            // Graceful fallback to SSR page 0 results if /api/search changes or errors
            break;
          }
        }
      }

      return deduplicateHumanitixListings(collected);
    }
  };
}
