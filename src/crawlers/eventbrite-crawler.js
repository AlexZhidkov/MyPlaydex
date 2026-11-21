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
  mergeEventbriteActivities,
  anchorAwstTimestamp,
  resolvePerthCoordinates,
  parseActivityCost,
  inferDemographics,
  shouldDropActivity,
  mapEventbriteActivityToListing,
  parseEventbriteHtml
} from './eventbrite-parser.js';

export const EVENTBRITE_PERTH_SPORTS_URL = 'https://www.eventbrite.com.au/d/australia--perth/sports--events/';

export {
  extractEventbriteId,
  formatSchemaAddress,
  collectSchemaActivities,
  extractJsonLdActivities,
  extractJsonLdActivities as extractJsonLdEvents,
  extractServerData,
  extractServerDataActivities,
  mergeEventbriteActivities,
  anchorAwstTimestamp,
  resolvePerthCoordinates,
  parseActivityCost,
  inferDemographics,
  shouldDropActivity,
  mapEventbriteActivityToListing,
  parseEventbriteHtml
};

/**
 * Creates an Eventbrite Perth Crawler instance.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn=globalThis.fetch]
 * @param {string} [options.url=EVENTBRITE_PERTH_SPORTS_URL]
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

  return {
    name: 'eventbrite',
    ...(typeof options.minExpectedListings === 'number' ? { minExpectedListings: options.minExpectedListings } : {}),

    async fetchListings() {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8'
      };

      const signal = options.signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);

      const response = await fetchFn(url, {
        method: 'GET',
        headers,
        ...(signal ? { signal } : {})
      });

      if (!response.ok) {
        throw new Error(`Eventbrite responded with HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      return parseEventbriteHtml(html, {
        defaultCategory: options.category,
        now: options.now
      });
    }
  };
}
