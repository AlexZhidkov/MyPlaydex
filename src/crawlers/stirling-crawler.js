/**
 * City of Stirling Activities Crawler Adapter
 * Implements scraping of Stirling community sports and leisure activities
 * based on the researched Kendo UI JSON endpoint.
 */

import { determineIsFree } from '../sanitizer.js';

export const STIRLING_ENDPOINT = 'https://www.stirling.wa.gov.au/ksearchevent/ksearchresult';

/**
 * Creates a City of Stirling crawler instance.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn=globalThis.fetch]
 * @param {number} [options.pageSize=50]
 * @returns {object} Crawler instance with name and fetchListings method
 */
export function createStirlingCrawler(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const pageSize = options.pageSize || 50;
  const timeoutMs = options.timeoutMs || 15000;

  return {
    name: 'stirling',
    ...(typeof options.minExpectedListings === 'number' ? { minExpectedListings: options.minExpectedListings } : {}),

    async fetchListings() {
      const searchParam = JSON.stringify([
        { key: 'classname', values: ['AWPT.Event'], or: 'true', operator: 'eq' },
        { key: 'searchindexes', values: ['Events'], or: 'true', operator: 'eq' },
        { key: 'nodealiaspath', values: ['/'], or: 'true', operator: 'eq' },
        { key: 'FilterIsExpired', values: ['false'], or: 'true', operator: 'eq' }
      ]);

      const headers = {
        'Content-Type': 'application/json',
        'SearchParam': searchParam,
        'SearchFilter': '[]',
        'User-Agent': 'Mozilla/5.0 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot)'
      };

      const body = JSON.stringify({
        page: 1,
        pageSize,
        skip: 0,
        take: pageSize
      });

      const signal = options.signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);

      const response = await fetchFn(STIRLING_ENDPOINT, {
        method: 'POST',
        headers,
        body,
        ...(signal ? { signal } : {})
      });

      if (!response.ok) {
        throw new Error(`Stirling API responded with HTTP ${response.status}: ${response.statusText}`);
      }

      const json = await response.json();
      const records = json.Data || json.data || [];

      // Map raw API records to canonical intermediate crawler format
      return records.map((item, index) => {
        // Fallback default coordinates for Scarborough Beach / Stirling area if missing
        const lat = typeof item.Latitude === 'number' ? item.Latitude : -31.8942;
        const lng = typeof item.Longitude === 'number' ? item.Longitude : 115.7571;
        const url = item.PageUrl ? `https://www.stirling.wa.gov.au${item.PageUrl}` : 'https://www.stirling.wa.gov.au';
        const costStr = item.Cost || 'Free';
        const rawStart = item.EventStartDate || item.StartDate || item.EventDate || item.EventDisplayDate || null;
        const rawEnd = item.EventEndDate || item.EndDate || null;

        return {
          source: 'stirling',
          source_id: item.NodeGUID || item.ArticleID || String(index + 1),
          source_url: url,
          external_url: url,
          region_id: 'perth',
          title: item.ArticleTitle || 'Community Activity',
          description: item.ArticleTeaser || item.ArticleDescription || '',
          category: 'sports',
          subcategory: item.ArticleCategories || 'other',
          sport: item.ArticleCategories || 'other',
          organizer: {
            id: 'org_city_of_stirling',
            name: 'City of Stirling',
            website: 'https://www.stirling.wa.gov.au'
          },
          venue: {
            name: item.ArticleAddressTitle || 'City of Stirling Venue',
            address: item.ArticleAddressTitle || 'Scarborough WA',
            coordinates: { lat, lng }
          },
          venue_name: item.ArticleAddressTitle || 'City of Stirling Venue',
          address: item.ArticleAddressTitle || 'Scarborough WA',
          coordinates: { lat, lng },
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
      });
    }
  };
}
