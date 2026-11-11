/**
 * Volleyball WA (VWA) Club & Venue Crawler Adapter.
 * Ingests volleyball clubs, social volley centers, and venues across Greater Perth
 * from the public WordPress store locator AJAX endpoint.
 */

import { slugify } from '../sanitizer.js';

export const VOLLEYBALL_WA_ENDPOINT = 'https://volleyballwa.com.au/wp-admin/admin-ajax.php';

/**
 * Formats address components from store locator record.
 *
 * @param {object} item
 * @returns {string} Formatted address string
 */
function formatAddress(item) {
  const street = [item.address, item.address2].filter(Boolean).join(', ');
  const stateZip = [item.state, item.zip].filter(Boolean).join(' ');
  const locality = [item.city, stateZip].filter(Boolean).join(', ');
  const full = [street, locality].filter(Boolean).join(', ');
  return full || 'Greater Perth, WA';
}

/**
 * Creates a Volleyball WA crawler instance.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn=globalThis.fetch]
 * @param {number} [options.lat=-31.95]
 * @param {number} [options.lng=115.86]
 * @param {number} [options.maxResults=100]
 * @param {number} [options.searchRadius=100]
 * @param {number} [options.timeoutMs=15000]
 * @returns {object} Crawler instance with name and fetchListings method
 */
export function createVolleyballWaCrawler(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const lat = options.lat !== undefined ? options.lat : -31.95;
  const lng = options.lng !== undefined ? options.lng : 115.86;
  const maxResults = options.maxResults || 100;
  const searchRadius = options.searchRadius || 100;
  const timeoutMs = options.timeoutMs || 15000;

  return {
    name: 'volleyball_wa',
    ...(typeof options.minExpectedListings === 'number' ? { minExpectedListings: options.minExpectedListings } : {}),

    async fetchListings() {
      const url = `${VOLLEYBALL_WA_ENDPOINT}?action=store_search&lat=${lat}&lng=${lng}&max_results=${maxResults}&search_radius=${searchRadius}`;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot; Linux x86_64)',
        'Accept': 'application/json'
      };

      const signal = options.signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);

      const response = await fetchFn(url, {
        method: 'GET',
        headers,
        ...(signal ? { signal } : {})
      });

      if (!response.ok) {
        throw new Error(`Volleyball WA API responded with HTTP ${response.status}: ${response.statusText}`);
      }

      const json = await response.json();
      const records = Array.isArray(json) ? json : (json?.data || []);

      const listings = [];

      for (let i = 0; i < records.length; i++) {
        const item = records[i];

        const itemLat = parseFloat(item.lat);
        const itemLng = parseFloat(item.lng);

        if (Number.isNaN(itemLat) || Number.isNaN(itemLng)) {
          continue;
        }

        const storeName = (item.store || 'Volleyball Club').trim();
        const address = formatAddress(item);
        const urlLink = item.url && item.url.startsWith('http') ? item.url : 'https://volleyballwa.com.au/places/find-a-club/';
        const costDescription = 'Casual volleyball fees apply';

        listings.push({
          source: 'volleyball_wa',
          source_id: String(item.id || i + 1),
          source_url: urlLink,
          external_url: urlLink,
          region_id: 'perth',
          title: storeName,
          description: `${storeName} - Volleyball sessions and court facilities in Greater Perth.`,
          category: 'sports',
          subcategory: 'volleyball',
          sport: 'volleyball',
          organizer: {
            id: `org_${slugify(storeName)}`,
            name: storeName,
            website: item.url || null,
            contact: {
              phone: item.phone || null,
              email: item.email || null
            }
          },
          venue: {
            name: storeName,
            address,
            coordinates: { lat: itemLat, lng: itemLng }
          },
          venue_name: storeName,
          address,
          coordinates: { lat: itemLat, lng: itemLng },
          cost_description: costDescription,
          display_price: costDescription,
          is_free: false,
          schedule: {
            recurrence: 'weekly'
          },
          demographics: {
            gender: 'all',
            age: 'all'
          }
        });
      }

      return listings;
    }
  };
}
