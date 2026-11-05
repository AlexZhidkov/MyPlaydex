/**
 * City of Stirling Activities Crawler Adapter
 * Implements scraping of Stirling community sports and leisure activities
 * based on the researched Kendo UI JSON endpoint.
 */

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

  return {
    name: 'stirling',

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

      const response = await fetchFn(STIRLING_ENDPOINT, {
        method: 'POST',
        headers,
        body
      });

      if (!response.ok) {
        throw new Error(`Stirling API responded with HTTP ${response.status}: ${response.statusText}`);
      }

      const json = await response.json();
      const records = json.Data || json.data || [];

      // Map raw API records to intermediate crawler format
      return records.map((item, index) => {
        // Fallback default coordinates for Scarborough Beach / Stirling area if missing
        const lat = typeof item.Latitude === 'number' ? item.Latitude : -31.8942;
        const lng = typeof item.Longitude === 'number' ? item.Longitude : 115.7571;

        return {
          source: 'stirling',
          source_id: item.NodeGUID || item.ArticleID || String(index + 1),
          title: item.ArticleTitle || 'Community Activity',
          sport: item.ArticleCategories || 'other',
          venue_name: item.ArticleAddressTitle || 'City of Stirling Venue',
          address: item.ArticleAddressTitle || 'Scarborough WA',
          coordinates: { lat, lng },
          start_time: item.EventDisplayDate || new Date().toISOString(),
          cost_description: item.Cost || 'Free',
          external_url: item.PageUrl ? `https://www.stirling.wa.gov.au${item.PageUrl}` : 'https://www.stirling.wa.gov.au'
        };
      });
    }
  };
}
