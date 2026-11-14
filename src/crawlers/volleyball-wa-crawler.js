/**
 * Volleyball WA (VWA) Club & Venue Crawler Adapter.
 * Ingests volleyball clubs, social volley centers, and venues across Greater Perth
 * from the public WordPress store locator AJAX endpoint.
 */

import { slugify, normalizeSubcategories } from '../sanitizer.js';
import { encodeGeohash } from '../geohash.js';

export const VOLLEYBALL_WA_ENDPOINT = 'https://volleyballwa.com.au/wp-admin/admin-ajax.php';
export const DEFAULT_VWA_CENTER = { lat: -31.95, lng: 115.86 };

const POSTAL_OR_PLACEHOLDER_REGEX = /^(?:p\.?\s*o\.?\s*box|g\.?\s*p\.?\s*o\.?\s*box|locked\s+bag|post\s+office|c\/o\b|tba\b|tbc\b)/i;
const STREET_NUMBER_PREFIX_REGEX = /^(?:\d+[a-z]?(?:\/\d+[a-z]?)?\s+|unit\s+\d+|lot\s+\d+|level\s+\d+|suite\s+\d+)/i;
const BARE_STREET_SUFFIX_REGEX = /\b(?:st|street|rd|road|ave|avenue|dr|drive|pde|parade|cres|crescent|ct|court|cl|close|way|ln|lane|hwy|highway|tce|terrace|blvd|boulevard|pl|place|sq|square|esp|esplanade|rise|cir|circuit)$/i;
const VENUE_KEYWORD_REGEX = /\b(?:school|college|university|uni|centre|center|stadium|arena|hall|park|reserve|oval|beach|club|gym|gymnasium|recreation|rec|sports|pavilion|academy|campus|complex|domain|grounds|courts)\b/i;

/**
 * Extracts a distinct physical venue name from a Volleyball WA directory record
 * when the address includes a named school, centre, or park rather than a bare street or PO Box.
 *
 * @param {object} [item={}]
 * @param {string} [organizerName='']
 * @returns {string | null}
 */
export function extractDistinctVenueName(item = {}, organizerName = '') {
  const rawCandidate = typeof item.venue_name === 'string' && item.venue_name.trim()
    ? item.venue_name.trim()
    : (typeof item.address === 'string' ? item.address.split(',')[0].trim() : '');

  if (!rawCandidate) {
    return null;
  }

  const lowerCandidate = rawCandidate.toLowerCase();
  const lowerOrganizer = String(organizerName || '').trim().toLowerCase();
  const lowerCity = String(item.city || '').trim().toLowerCase();

  if (
    lowerCandidate === lowerOrganizer ||
    (lowerCity && lowerCandidate === lowerCity) ||
    lowerCandidate === 'greater perth' ||
    lowerCandidate === 'perth' ||
    lowerCandidate === 'wa'
  ) {
    return null;
  }

  if (POSTAL_OR_PLACEHOLDER_REGEX.test(rawCandidate)) {
    return null;
  }

  if (STREET_NUMBER_PREFIX_REGEX.test(rawCandidate)) {
    return null;
  }

  const hasAddress2 = typeof item.address2 === 'string' && item.address2.trim() !== '';
  if (!hasAddress2 && BARE_STREET_SUFFIX_REGEX.test(rawCandidate) && !VENUE_KEYWORD_REGEX.test(rawCandidate)) {
    return null;
  }

  return rawCandidate;
}

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
 * Appends a deduplicated canonical Venue Listing to `listings` if its deterministic ID
 * has not been emitted yet in this crawl.
 */
function appendUniqueVenue(listings, seenVenueIds, {
  name,
  geohash,
  sourceId,
  urlLink,
  description,
  address,
  lat,
  lng,
  subcategories
}) {
  const geohash6 = geohash.slice(0, 6);
  const venueId = `venue_${slugify(name) || 'venue'}_${geohash6}`;
  if (seenVenueIds.has(venueId)) {
    return;
  }
  seenVenueIds.add(venueId);
  listings.push({
    id: venueId,
    entity_type: 'venue',
    source: 'volleyball_wa',
    source_id: sourceId,
    source_url: urlLink,
    raw_source_url: urlLink,
    region_id: 'perth',
    name,
    description,
    address,
    coordinates: { lat, lng },
    geohash,
    category: 'sports',
    subcategory: 'volleyball',
    subcategories
  });
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
      const seenVenueIds = new Set();
      const seenOrgIds = new Set();
      const subcategories = normalizeSubcategories({ subcategory: 'volleyball' }, 'volleyball');

      for (let i = 0; i < records.length; i++) {
        const item = records[i];

        const itemLat = parseFloat(item.lat);
        const itemLng = parseFloat(item.lng);

        if (Number.isNaN(itemLat) || Number.isNaN(itemLng)) {
          continue;
        }

        const directoryName = (item.store || 'Volleyball Organizer').trim();
        const sourceId = String(item.id || i + 1);
        const address = formatAddress(item);
        const urlLink = item.url && item.url.startsWith('http') ? item.url : 'https://volleyballwa.com.au/places/find-a-club/';
        const website = item.url && item.url.startsWith('http') ? item.url : null;
        const costDescription = 'Casual volleyball fees apply';
        const geohash = encodeGeohash(itemLat, itemLng, 9);

        const terms = (item.terms || '').trim();
        const isClub = /\bclubs?\b/i.test(terms) || /\bclubs?\b/i.test(directoryName);
        const isBeach = directoryName.toLowerCase().includes('beach') ||
          (item.address && item.address.toLowerCase().includes('beach')) ||
          terms.toLowerCase().includes('beach');
        const disciplineLabel = isBeach ? 'Beach volleyball' : 'Indoor and social volleyball';

        const hoursSummary = summarizeHours(item.hours);
        const hoursSuffix = hoursSummary ? ` Hours: ${hoursSummary.slice(0, 100)}.` : '';

        // Follow GLOSSARY.md avoiding 'facilities', 'places', or 'grounds'
        const description = `${directoryName} (${terms || 'Volleyball Venue'}) - ${disciplineLabel} sessions and social competitions in Greater Perth.${hoursSuffix}`;

        if (isClub) {
          const orgId = `org_${slugify(directoryName) || 'volleyball_organizer'}`;
          if (!seenOrgIds.has(orgId)) {
            seenOrgIds.add(orgId);
            listings.push({
              id: orgId,
              entity_type: 'organizer',
              source: 'volleyball_wa',
              source_id: sourceId,
              source_url: urlLink,
              raw_source_url: urlLink,
              region_id: 'perth',
              name: directoryName,
              description,
              address,
              coordinates: { lat: itemLat, lng: itemLng },
              geohash,
              category: 'sports',
              subcategory: 'volleyball',
              subcategories,
              website,
              contact: {
                phone: item.phone || null,
                email: item.email || null
              },
              cost_description: costDescription,
              demographics: {
                gender: 'all',
                age: 'all'
              }
            });
          }

          const distinctVenueName = extractDistinctVenueName(item, directoryName);
          if (distinctVenueName) {
            appendUniqueVenue(listings, seenVenueIds, {
              name: distinctVenueName,
              geohash,
              sourceId: `${sourceId}_venue`,
              urlLink,
              description: `${distinctVenueName} (${terms || 'Volleyball Venue'}) - ${disciplineLabel} venue in Greater Perth.${hoursSuffix}`,
              address,
              lat: itemLat,
              lng: itemLng,
              subcategories
            });
          }
        } else {
          appendUniqueVenue(listings, seenVenueIds, {
            name: directoryName,
            geohash,
            sourceId,
            urlLink,
            description,
            address,
            lat: itemLat,
            lng: itemLng,
            subcategories
          });
        }
      }

      return listings;
    }
  };
}
