/**
 * WA Department of Local Government, Sport and Cultural Industries (DLGSC)
 * Sports Club Directory Crawler Adapter.
 * Ingests sports clubs across Greater Perth from the public KidSport REST API.
 */

import { slugify, normalizeSubcategories } from '../sanitizer.js';
import { encodeGeohash } from '../geohash.js';
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
 * @param {number} [options.pageSize=100]
 * @param {number} [options.timeoutMs=15000]
 * @param {{ lat: number, lng: number }} [options.center=PERTH_CENTROID]
 * @param {number} [options.maxDistanceKm=DEFAULT_MAX_DISTANCE_KM]
 * @param {string} [options.keyword='']
 * @param {string} [options.suburb]
 * @param {number} [options.maxPages=3]
 * @returns {object} Crawler instance with name and fetchListings method
 */
export function createDlgscCrawler(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const pageSize = options.pageSize || 100;
  const timeoutMs = options.timeoutMs || 15000;
  const center = options.center || PERTH_CENTROID;
  const maxDistanceKm = options.maxDistanceKm || DEFAULT_MAX_DISTANCE_KM;
  const keyword = options.keyword !== undefined ? options.keyword : '';
  const suburb = options.suburb;
  const singlePage = options.page !== undefined ? options.page : null;
  const maxPages = singlePage ? 1 : (options.maxPages || 3);

  return {
    name: 'dlgsc',
    ...(typeof options.minExpectedListings === 'number' ? { minExpectedListings: options.minExpectedListings } : {}),

    async fetchListings() {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot; Linux x86_64)',
        'Accept': 'application/json'
      };

      const signal = options.signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
      const filteredListings = [];
      const seenIds = new Set();

      const startPage = singlePage || 1;
      const endPage = singlePage ? singlePage : (startPage + maxPages - 1);

      for (let currentPage = startPage; currentPage <= endPage; currentPage++) {
        let url = `${DLGSC_ENDPOINT}?basic=true&keyword=${encodeURIComponent(keyword)}&page=${currentPage}&count=${pageSize}`;
        if (suburb) {
          url += `&suburb=${encodeURIComponent(suburb)}`;
        }

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

        for (let i = 0; i < rawClubs.length; i++) {
          const item = rawClubs[i];
          const clubId = item.Id || `${currentPage}_${i + 1}`;

          if (seenIds.has(clubId)) {
            continue;
          }

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

          seenIds.add(clubId);

          const rawOrganizerName = item.Name || item.RegisteredName || 'Sports Organizer';
          const organizerName = cleanText(rawOrganizerName);
          const sportRaw = cleanText(item.Sports || item.Sports1 || 'other');
          const subcategories = normalizeSubcategories(
            {
              sports: [cleanText(item.Sports), cleanText(item.Sports1)].filter(Boolean),
              sport: sportRaw
            },
            sportRaw
          );
          const subcategory = subcategories[0] || 'other';
          const website = item.Website && item.Website.startsWith('http') ? item.Website : (item.Website ? `https://${item.Website}` : null);
          const fallbackUrl = `https://kidsport.dlgsc.wa.gov.au/find-a-club/?club=${clubId}`;
          const referralUrl = website || fallbackUrl;
          const streetAddr = cleanText(item.StreetAddress);
          const suburbName = cleanText(item.Suburb);
          const address = [streetAddr, suburbName].filter(Boolean).join(', ') || cleanText(item.PostalAddress) || 'Greater Perth, WA';
          const costDescription = item.KidSport === 'Valid' ? 'KidSport eligible' : 'Contact organizer for fees';
          const age = deriveAgeGroup(item.ageGroups);
          const geohash = encodeGeohash(lat, lng, 9);
          const id = `org_${slugify(organizerName) || 'unknown'}`;

          filteredListings.push({
            id,
            entity_type: 'organizer',
            source: 'dlgsc',
            source_id: String(clubId),
            source_url: referralUrl,
            raw_source_url: referralUrl,
            region_id: 'perth',
            name: organizerName,
            description: `${organizerName} community organizer listing via WA DLGSC directory.`,
            address,
            coordinates: { lat, lng },
            geohash,
            category: 'sports',
            subcategory,
            subcategories,
            website,
            contact: {
              email: item.Email || null,
              phone: item.Phone || item.Mobile || null
            },
            cost_description: costDescription,
            demographics: {
              gender: 'all',
              age
            }
          });
        }

        // If upstream has no more records, stop paginating
        if (json.clubs?.morerecords === false || rawClubs.length === 0) {
          break;
        }
      }

      return filteredListings;
    }
  };
}
