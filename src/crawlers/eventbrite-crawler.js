/**
 * Eventbrite Perth Sports & Fitness Activities Crawler Adapter
 * Ingests community sports, pick-up games, run clubs, and fitness events
 * from Eventbrite server-rendered HTML pages by extracting Schema.org Event JSON-LD.
 */

import { slugify, normalizeSport, determineIsFree } from '../sanitizer.js';

export const EVENTBRITE_PERTH_SPORTS_URL = 'https://www.eventbrite.com.au/d/australia--perth/sports--events/';

/**
 * Extracts a numeric or alphanumeric Event ID from an Eventbrite URL or identifier.
 *
 * @param {string} [url]
 * @param {string} [fallbackId]
 * @param {string} [title]
 * @returns {string}
 */
export function extractEventbriteId(url = '', fallbackId = '', title = '') {
  if (url) {
    const ticketMatch = url.match(/tickets-(\d+)/i) || url.match(/-(\d{7,})(?:\?|\/|$)/);
    if (ticketMatch) {
      return ticketMatch[1];
    }
  }
  if (fallbackId) {
    const clean = String(fallbackId).replace(/[^a-zA-Z0-9_-]/g, '_');
    if (clean) return clean;
  }
  return slugify(`${title || 'activity'}_${url || 'listing'}`);
}

/**
 * Formats a Schema.org PostalAddress or address string into a single line.
 *
 * @param {string|object} address
 * @returns {string}
 */
export function formatSchemaAddress(address) {
  if (!address) return 'Greater Perth, WA';
  if (typeof address === 'string') return address.trim();

  const resolveVal = val => {
    if (!val) return '';
    if (typeof val === 'string') return val.trim();
    if (typeof val === 'object') return (val.name || val['@value'] || '').trim();
    return String(val).trim();
  };

  const parts = [
    resolveVal(address.streetAddress),
    resolveVal(address.addressLocality),
    resolveVal(address.addressRegion),
    resolveVal(address.postalCode),
    resolveVal(address.addressCountry)
  ].filter(Boolean);

  return parts.join(', ') || 'Greater Perth, WA';
}

/**
 * Recursively extracts all objects with @type === 'Event' from a parsed Schema.org structure.
 *
 * @param {any} node
 * @param {Array<object>} [acc=[]]
 * @returns {Array<object>}
 */
export function collectSchemaEvents(node, acc = []) {
  if (!node || typeof node !== 'object') {
    return acc;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectSchemaEvents(item, acc);
    }
    return acc;
  }

  const type = node['@type'];
  if (type === 'Event') {
    acc.push(node);
  } else if (type === 'ItemList' && Array.isArray(node.itemListElement)) {
    for (const listElem of node.itemListElement) {
      if (listElem?.item) {
        collectSchemaEvents(listElem.item, acc);
      } else {
        collectSchemaEvents(listElem, acc);
      }
    }
  } else if (Array.isArray(node['@graph'])) {
    collectSchemaEvents(node['@graph'], acc);
  }

  return acc;
}

/**
 * Extracts raw JSON-LD blocks from HTML content and parses all Schema.org Event entities.
 *
 * @param {string} html
 * @returns {Array<object>} Extracted Schema.org Event objects
 */
export function extractJsonLdEvents(html = '') {
  if (!html || typeof html !== 'string') return [];

  const scriptRegex = /<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const events = [];

  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    const rawContent = match[1]?.trim();
    if (!rawContent) continue;

    try {
      const parsed = JSON.parse(rawContent);
      collectSchemaEvents(parsed, events);
    } catch {
      // Ignore malformed JSON-LD scripts
    }
  }

  return events;
}

/**
 * Parses pricing and free status from Schema.org Event offers.
 *
 * @param {object} event
 * @returns {{ isFree: boolean, displayPrice: string }}
 */
export function parseEventCost(event) {
  if (event.isAccessibleForFree === true) {
    return { isFree: true, displayPrice: 'Free' };
  }

  const offers = Array.isArray(event.offers)
    ? event.offers
    : (event.offers ? [event.offers] : []);

  for (const offer of offers) {
    if (offer.isAccessibleForFree === true) {
      return { isFree: true, displayPrice: 'Free' };
    }
    const rawPrice = offer.price !== undefined ? String(offer.price).trim() : '';
    if (rawPrice === '0' || rawPrice === '0.00' || rawPrice.toLowerCase() === 'free') {
      return { isFree: true, displayPrice: 'Free' };
    }
    if (rawPrice) {
      const currency = offer.priceCurrency || 'AUD';
      const formatted = rawPrice.startsWith('$') ? rawPrice : `$${rawPrice}`;
      return {
        isFree: false,
        displayPrice: `${formatted} ${currency}`.trim()
      };
    }
  }

  const isFreeFromText = determineIsFree(event.description || '');
  return {
    isFree: isFreeFromText,
    displayPrice: isFreeFromText ? 'Free' : 'See listing details'
  };
}

/**
 * Creates an Eventbrite Perth Sports Crawler instance.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn=globalThis.fetch]
 * @param {string} [options.url=EVENTBRITE_PERTH_SPORTS_URL]
 * @param {number} [options.timeoutMs=15000]
 * @param {number} [options.minExpectedListings]
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
      const rawEvents = extractJsonLdEvents(html);
      const listings = [];
      const seenIds = new Set();

      for (let i = 0; i < rawEvents.length; i++) {
        const item = rawEvents[i];

        // Coordinate extraction (must be a physical event with coordinates)
        const location = item.location;
        const geo = location?.geo;
        const rawLat = geo?.latitude ?? location?.latitude;
        const rawLng = geo?.longitude ?? location?.longitude;

        if (rawLat === undefined || rawLng === undefined || rawLat === null || rawLng === null || rawLat === '') {
          continue;
        }

        const lat = typeof rawLat === 'number' ? rawLat : parseFloat(rawLat);
        const lng = typeof rawLng === 'number' ? rawLng : parseFloat(rawLng);

        if (Number.isNaN(lat) || Number.isNaN(lng)) {
          continue;
        }

        const eventUrl = item.url || url;
        const title = (item.name || 'Community Sports Activity').trim();
        const sourceId = extractEventbriteId(eventUrl, item['@id'] || '', title);

        if (seenIds.has(sourceId)) {
          continue;
        }
        seenIds.add(sourceId);

        const description = (item.description || '').trim();
        const subcategory = normalizeSport(title + ' ' + description);

        // Organizer
        const orgNode = item.organizer;
        const organizerName = typeof orgNode === 'string'
          ? orgNode.trim()
          : (orgNode?.name || 'Eventbrite Community Organizer').trim();
        const organizerUrl = typeof orgNode === 'object' ? orgNode?.url || null : null;

        // Venue
        const venueName = (location?.name || 'Perth Sports Venue').trim();
        const address = formatSchemaAddress(location?.address);

        // Cost
        const { isFree, displayPrice } = parseEventCost(item);

        // Schedule parsing
        const rawStart = item.startDate || null;
        const rawEnd = item.endDate || null;
        const isStartDateOnly = rawStart && !rawStart.includes('T') && !rawStart.includes(':');
        const isEndDateOnly = rawEnd && !rawEnd.includes('T') && !rawEnd.includes(':');

        listings.push({
          source: 'eventbrite',
          source_id: sourceId,
          source_url: eventUrl,
          external_url: eventUrl,
          region_id: 'perth',
          title,
          description,
          category: 'sports',
          subcategory,
          organizer: {
            id: `org_${slugify(organizerName)}`,
            name: organizerName,
            website: organizerUrl
          },
          venue: {
            name: venueName,
            address,
            coordinates: { lat, lng }
          },
          venue_name: venueName,
          address,
          coordinates: { lat, lng },
          start_date: isStartDateOnly ? rawStart : undefined,
          start_time: isStartDateOnly ? null : rawStart,
          end_date: isEndDateOnly ? rawEnd : undefined,
          end_time: isEndDateOnly ? null : rawEnd,
          cost_description: displayPrice,
          display_price: displayPrice,
          is_free: isFree,
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
