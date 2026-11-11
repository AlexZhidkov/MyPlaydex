/**
 * Volleyball WA (VWA) Club & Venue Crawler Adapter.
 * Ingests volleyball clubs, social volley centers, and venues across Greater Perth
 * from the public WordPress store locator AJAX endpoint.
 */

import { slugify } from '../sanitizer.js';

export const VOLLEYBALL_WA_ENDPOINT = 'https://volleyballwa.com.au/wp-admin/admin-ajax.php';
export const DEFAULT_VWA_CENTER = { lat: -31.95, lng: 115.86 };

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
 * Strips HTML tags from opening hours table to provide readable schedule summary.
 *
 * @param {string} hoursHtml
 * @returns {string}
 */
function summarizeHours(hoursHtml = '') {
  if (!hoursHtml || typeof hoursHtml !== 'string') return '';
  return hoursHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Creates a Volleyball WA crawler instance.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn=globalThis.fetch]
 * @param {{ lat: number, lng: number }} [options.center=DEFAULT_VWA_CENTER]
 * @param {number} [options.maxResults=100]
 * @param {number} [options.searchRadius=100]
 * @param {number} [options.timeoutMs=15000]
 * @returns {object} Crawler instance with name and fetchListings method
 */
export function createVolleyballWaCrawler(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const center = options.center || {
    lat: options.lat !== undefined ? options.lat : DEFAULT_VWA_CENTER.lat,
    lng: options.lng !== undefined ? options.lng : DEFAULT_VWA_CENTER.lng
  };
  const maxResults = options.maxResults || 100;
  const searchRadius = options.searchRadius || 100;
  const timeoutMs = options.timeoutMs || 15000;

  return {
    name: 'volleyball_wa',
    ...(typeof options.minExpectedListings === 'number' ? { minExpectedListings: options.minExpectedListings } : {}),

    async fetchListings() {
      const url = `${VOLLEYBALL_WA_ENDPOINT}?action=store_search&lat=${center.lat}&lng=${center.lng}&max_results=${maxResults}&search_radius=${searchRadius}`;
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

        const clubName = (item.store || 'Volleyball Club').trim();
        const address = formatAddress(item);
        const urlLink = item.url && item.url.startsWith('http') ? item.url : 'https://volleyballwa.com.au/places/find-a-club/';
        const costDescription = 'Casual volleyball fees apply';

        const terms = (item.terms || '').trim();
        const isBeach = clubName.toLowerCase().includes('beach') ||
          (item.address && item.address.toLowerCase().includes('beach')) ||
          terms.toLowerCase().includes('beach');
        const disciplineLabel = isBeach ? 'Beach volleyball' : 'Indoor and social volleyball';

        const hoursSummary = summarizeHours(item.hours);
        const hoursSuffix = hoursSummary ? ` Weekly schedule: ${hoursSummary.slice(0, 100)}...` : '';

        // Follow GLOSSARY.md avoiding 'facilities', 'places', or 'grounds'
        const description = `${clubName} (${terms || 'Volleyball Venue'}) - ${disciplineLabel} sessions and social competitions in Greater Perth.${hoursSuffix}`;

        listings.push({
          source: 'volleyball_wa',
          source_id: String(item.id || i + 1),
          source_url: urlLink,
          external_url: urlLink,
          region_id: 'perth',
          title: clubName,
          description,
          category: 'sports',
          subcategory: 'volleyball',
          sport: 'volleyball',
          organizer: {
            id: `org_${slugify(clubName)}`,
            name: clubName,
            website: item.url || null,
            contact: {
              phone: item.phone || null,
              email: item.email || null
            }
          },
          venue: {
            name: clubName,
            address,
            coordinates: { lat: itemLat, lng: itemLng }
          },
          venue_name: clubName,
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
