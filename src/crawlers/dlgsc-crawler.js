/**
 * WA Department of Local Government, Sport and Cultural Industries (DLGSC)
 * Sports Club Directory Crawler Adapter.
 * Ingests sports clubs across Greater Perth from the public KidSport REST API.
 */

import { slugify, normalizeSport } from '../sanitizer.js';
import { calculateDistanceKm } from '../discovery-engine.js';

export const DLGSC_ENDPOINT = 'https://kidsport.dlgsc.wa.gov.au/api/find-a-club-search/';
export const PERTH_CENTROID = { lat: -31.9505, lng: 115.8605 };
export const DEFAULT_MAX_DISTANCE_KM = 85;

/**
 * Derives demographics age group from DLGSC ageGroups flags.
 *
 * @param {object} [ageGroups]
 * @returns {'all' | 'juniors' | 'adults' | 'masters'}
 */
function deriveAgeGroup(ageGroups) {
  if (!ageGroups || typeof ageGroups !== 'object') {
    return 'all';
  }

  const isJunior = Boolean(ageGroups.at0to12 || ageGroups.at13to18);
  const isAdult = Boolean(ageGroups.at19to30 || ageGroups.at31to50);
  const isMaster = Boolean(ageGroups.at51to99);

  if (isJunior && !isAdult && !isMaster) return 'juniors';
  if (isAdult && !isJunior && !isMaster) return 'adults';
  if (isMaster && !isJunior && !isAdult) return 'masters';

  return 'all';
}

/**
 * Safely decodes URI-encoded text (e.g. %27 -> ', %2C -> ,) and trims whitespace.
 *
 * @param {string} str
 * @returns {string}
 */
function cleanText(str) {
  if (!str || typeof str !== 'string') return '';
  try {
    return decodeURIComponent(str).trim();
  } catch {
    return str.trim();
  }
}

/**
 * Creates a WA DLGSC Sports Club Directory crawler instance.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn=globalThis.fetch]
 * @param {number} [options.pageSize=50]
 * @param {number} [options.timeoutMs=15000]
 * @param {{ lat: number, lng: number }} [options.center=PERTH_CENTROID]
 * @param {number} [options.maxDistanceKm=DEFAULT_MAX_DISTANCE_KM]
 * @param {string} [options.keyword='']
 * @param {string} [options.suburb='Perth']
 * @returns {object} Crawler instance with name and fetchListings method
 */
export function createDlgscCrawler(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const pageSize = options.pageSize || 50;
  const timeoutMs = options.timeoutMs || 15000;
  const center = options.center || PERTH_CENTROID;
  const maxDistanceKm = options.maxDistanceKm || DEFAULT_MAX_DISTANCE_KM;
  const keyword = options.keyword !== undefined ? options.keyword : '';
  const suburb = options.suburb !== undefined ? options.suburb : (keyword ? '' : 'Perth');

  return {
    name: 'dlgsc',
    ...(typeof options.minExpectedListings === 'number' ? { minExpectedListings: options.minExpectedListings } : {}),

    async fetchListings() {
      let url = `${DLGSC_ENDPOINT}?basic=true&keyword=${encodeURIComponent(keyword)}&page=1&count=${pageSize}`;
      if (suburb) {
        url += `&suburb=${encodeURIComponent(suburb)}`;
      }
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
        throw new Error(`DLGSC API responded with HTTP ${response.status}: ${response.statusText}`);
      }

      const json = await response.json();
      const rawClubs = json.clubs?.data || json.data || [];

      const filteredListings = [];

      for (let i = 0; i < rawClubs.length; i++) {
        const item = rawClubs[i];

        // Parse coordinates
        const lat = parseFloat(item.Latitude || item.LLat);
        const lng = parseFloat(item.Longitude || item.LLong);

        if (Number.isNaN(lat) || Number.isNaN(lng)) {
          continue;
        }

        // Filter for Greater Perth metropolitan area
        const distance = calculateDistanceKm(center, { lat, lng });
        if (distance > maxDistanceKm) {
          continue;
        }

        const rawClubName = item.Name || item.RegisteredName || 'Sports Club';
        const clubName = cleanText(rawClubName);
        const sportRaw = cleanText(item.Sports || item.Sports1 || 'other');
        const subcategory = normalizeSport(sportRaw);
        const website = item.Website && item.Website.startsWith('http') ? item.Website : (item.Website ? `https://${item.Website}` : null);
        const fallbackUrl = `https://kidsport.dlgsc.wa.gov.au/find-a-club/?club=${item.Id || i + 1}`;
        const referralUrl = website || fallbackUrl;
        const streetAddr = cleanText(item.StreetAddress);
        const suburbName = cleanText(item.Suburb);
        const address = [streetAddr, suburbName].filter(Boolean).join(', ') || cleanText(item.PostalAddress) || 'Greater Perth, WA';
        const venueName = streetAddr || `${clubName} Ground`;
        const costDescription = item.KidSport === 'Valid' ? 'KidSport eligible' : 'Contact club for fees';
        const age = deriveAgeGroup(item.ageGroups);

        filteredListings.push({
          source: 'dlgsc',
          source_id: item.Id || String(i + 1),
          source_url: referralUrl,
          external_url: referralUrl,
          region_id: 'perth',
          title: clubName,
          description: `${clubName} community club listing via WA DLGSC Sports Club Directory.`,
          category: 'sports',
          subcategory,
          sport: sportRaw,
          organizer: {
            id: `org_${slugify(clubName)}`,
            name: clubName,
            website,
            contact: {
              email: item.Email || null,
              phone: item.Phone || item.Mobile || null
            }
          },
          venue: {
            name: venueName,
            address,
            coordinates: { lat, lng }
          },
          venue_name: venueName,
          address,
          coordinates: { lat, lng },
          cost_description: costDescription,
          display_price: costDescription,
          is_free: false,
          demographics: {
            gender: 'all',
            age
          }
        });
      }

      return filteredListings;
    }
  };
}
