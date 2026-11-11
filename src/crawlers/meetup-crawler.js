/**
 * Meetup Perth Sports & Active Life Crawler Adapter
 * Ingests casual games, run clubs, pickup sessions, and social sports
 * from Meetup server-rendered HTML pages by extracting embedded Next.js SSR state (__NEXT_DATA__).
 */

import { slugify, normalizeSport, determineIsFree } from '../sanitizer.js';

export const MEETUP_PERTH_SPORTS_URL = 'https://www.meetup.com/find/?location=au--perth&categoryId=652';

/**
 * Dereferences an Apollo Client entity reference ({ __ref: 'TypeName:id' }) against cache state.
 *
 * @param {any} entityOrRef
 * @param {object} [apolloState={}]
 * @returns {any}
 */
export function dereferenceApollo(entityOrRef, apolloState = {}) {
  if (!entityOrRef || typeof entityOrRef !== 'object') {
    return entityOrRef;
  }
  if (typeof entityOrRef.__ref === 'string') {
    return apolloState[entityOrRef.__ref] || null;
  }
  return entityOrRef;
}

/**
 * Parses Next.js __NEXT_DATA__ script block from HTML.
 *
 * @param {string} html
 * @returns {object|null}
 */
export function extractNextData(html = '') {
  if (!html || typeof html !== 'string') return null;

  const scriptMatch = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!scriptMatch || !scriptMatch[1]) {
    return null;
  }

  try {
    return JSON.parse(scriptMatch[1].trim());
  } catch {
    return null;
  }
}

/**
 * Parses Redux / SSR preloaded state script block from HTML (window.__PRELOADED_STATE__ or __INITIAL_STATE__).
 *
 * @param {string} html
 * @returns {object|null}
 */
export function extractReduxState(html = '') {
  if (!html || typeof html !== 'string') return null;

  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    const scriptContent = match[1];
    if (scriptContent.includes('__PRELOADED_STATE__') || scriptContent.includes('__INITIAL_STATE__')) {
      const assignmentMatch = scriptContent.match(/(?:__PRELOADED_STATE__|__INITIAL_STATE__)\s*=\s*(\{[\s\S]*\})/);
      if (assignmentMatch && assignmentMatch[1]) {
        let jsonStr = assignmentMatch[1].trim();
        const lastBraceIndex = jsonStr.lastIndexOf('}');
        if (lastBraceIndex !== -1) {
          jsonStr = jsonStr.slice(0, lastBraceIndex + 1);
        }
        try {
          return JSON.parse(jsonStr);
        } catch {
          // Continue searching other scripts
        }
      }
    }
  }

  return null;
}

/**
 * Extracts and normalizes events from Meetup's __NEXT_DATA__ or Redux state (supporting Apollo state and direct pageProps).
 *
 * @param {object} nextData
 * @param {object} [reduxState]
 * @returns {Array<object>}
 */
export function extractMeetupEventsFromNextData(nextData, reduxState = null) {
  const events = [];
  const seenIds = new Set();

  const addEvent = (item) => {
    if (!item || typeof item !== 'object') return;
    const id = String(item.id || item.eventId || '');
    if (id && seenIds.has(id)) return;
    if (id) seenIds.add(id);
    events.push(item);
  };

  const pageProps = nextData?.props?.pageProps;

  // 1. Apollo Cache State (__APOLLO_STATE__)
  const apolloState = pageProps?.__APOLLO_STATE__;
  if (apolloState && typeof apolloState === 'object') {
    for (const [key, value] of Object.entries(apolloState)) {
      if (!value || typeof value !== 'object') continue;

      const isEventKey = key.startsWith('Event:') || value.__typename === 'Event';
      const hasEventShape = value.dateTime && (value.title || value.name);

      if (isEventKey || hasEventShape) {
        const id = String(value.id || key.replace(/^Event:/, ''));
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const dereferencedVenue = dereferenceApollo(value.venue, apolloState);
        const dereferencedGroup = dereferenceApollo(value.group, apolloState);

        events.push({
          ...value,
          id,
          venue: dereferencedVenue,
          group: dereferencedGroup
        });
      }
    }
  }

  // 2. Direct pageProps events array (e.g. pageProps.events or pageProps.data.results)
  if (pageProps && typeof pageProps === 'object') {
    const candidateArrays = [
      pageProps.events,
      pageProps.results,
      pageProps.data?.results,
      pageProps.data?.events
    ].filter(Array.isArray);

    for (const arr of candidateArrays) {
      for (const item of arr) {
        addEvent(item);
      }
    }
  }

  // 3. Redux SSR preloaded state (e.g. events, search.results, entities.events)
  if (reduxState && typeof reduxState === 'object') {
    const reduxCandidateArrays = [
      reduxState.events,
      reduxState.results,
      reduxState.search?.results,
      reduxState.search?.events,
      reduxState.entities?.events ? Object.values(reduxState.entities.events) : null
    ].filter(Array.isArray);

    for (const arr of reduxCandidateArrays) {
      for (const item of arr) {
        addEvent(item);
      }
    }
  }

  return events;
}

/**
 * Formats pricing and free status for Meetup event.
 *
 * @param {object} event
 * @returns {{ isFree: boolean, displayPrice: string }}
 */
export function parseMeetupCost(event) {
  const fee = event.feeSettings || event.fee;
  if (fee && typeof fee === 'object') {
    const amount = typeof fee.amount === 'number' ? fee.amount : parseFloat(fee.amount);
    if (!Number.isNaN(amount) && amount > 0) {
      const currency = fee.currency || 'AUD';
      return {
        isFree: false,
        displayPrice: `$${amount.toFixed(2)} ${currency}`.trim()
      };
    }
    if (amount === 0) {
      return { isFree: true, displayPrice: 'Free' };
    }
  }

  const isFreeFromText = determineIsFree(event.description || '', event.isFree);
  return {
    isFree: isFreeFromText,
    displayPrice: isFreeFromText ? 'Free' : (event.costDescription || 'Free')
  };
}

/**
 * Formats a Meetup venue address.
 *
 * @param {object} venue
 * @returns {string}
 */
export function formatMeetupAddress(venue) {
  if (!venue) return 'Greater Perth, WA';
  const parts = [
    venue.address,
    venue.address_1,
    venue.city,
    venue.state || 'WA',
    venue.country && venue.country !== 'Australia' ? venue.country : ''
  ].filter(Boolean);

  return parts.join(', ') || 'Greater Perth, WA';
}

/**
 * Creates a Meetup Perth Sports Crawler instance.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn=globalThis.fetch]
 * @param {string} [options.url=MEETUP_PERTH_SPORTS_URL]
 * @param {number} [options.timeoutMs=15000]
 * @param {number} [options.minExpectedListings]
 * @returns {object} Crawler instance
 */
export function createMeetupCrawler(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const url = options.url || MEETUP_PERTH_SPORTS_URL;
  const timeoutMs = options.timeoutMs || 15000;

  return {
    name: 'meetup',
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
        throw new Error(`Meetup responded with HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      const nextData = extractNextData(html);
      const reduxState = extractReduxState(html);
      const rawEvents = extractMeetupEventsFromNextData(nextData, reduxState);

      const listings = [];

      for (let i = 0; i < rawEvents.length; i++) {
        const item = rawEvents[i];

        // Coordinate extraction (must have valid coordinates)
        const venue = item.venue;
        const rawLat = venue?.lat ?? venue?.latitude;
        const rawLng = venue?.lng ?? venue?.longitude;

        if (rawLat === undefined || rawLng === undefined || rawLat === null || rawLng === null || rawLat === '') {
          continue;
        }

        const lat = typeof rawLat === 'number' ? rawLat : parseFloat(rawLat);
        const lng = typeof rawLng === 'number' ? rawLng : parseFloat(rawLng);

        if (Number.isNaN(lat) || Number.isNaN(lng)) {
          continue;
        }

        const title = (item.title || item.name || 'Meetup Sports Activity').trim();
        const description = (item.description || '').trim();
        const subcategory = normalizeSport(title + ' ' + description);

        // Group / Organizer
        const group = item.group;
        const organizerName = (group?.name || 'Meetup Community Group').trim();
        const groupUrl = group?.urlname ? `https://www.meetup.com/${group.urlname}` : (group?.url || null);

        // Outbound event URL
        const sourceId = String(item.id || `meetup_${i + 1}`);
        const eventUrl = item.eventUrl || item.link || (group?.urlname && item.id ? `https://www.meetup.com/${group.urlname}/events/${item.id}/` : `https://www.meetup.com/events/${sourceId}/`);

        // Venue
        const venueName = (venue.name || 'Perth Sports Venue').trim();
        const address = formatMeetupAddress(venue);

        // Cost
        const { isFree, displayPrice } = parseMeetupCost(item);

        // Schedule parsing (supports epoch ms, ISO timestamps, and date-only strings)
        let startTime = null;
        let startDate = null;
        const rawStart = item.dateTime || item.time || item.startDate;
        if (typeof rawStart === 'number') {
          startTime = new Date(rawStart).toISOString();
        } else if (typeof rawStart === 'string') {
          if (rawStart.includes('T') || rawStart.includes(':')) {
            startTime = rawStart;
          } else {
            startDate = rawStart;
          }
        }

        let endTime = null;
        let endDate = null;
        const rawEnd = item.endTime || item.endDate;
        if (typeof rawEnd === 'number') {
          endTime = new Date(rawEnd).toISOString();
        } else if (typeof rawEnd === 'string') {
          if (rawEnd.includes('T') || rawEnd.includes(':')) {
            endTime = rawEnd;
          } else {
            endDate = rawEnd;
          }
        }

        listings.push({
          source: 'meetup',
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
            website: groupUrl
          },
          venue: {
            name: venueName,
            address,
            coordinates: { lat, lng }
          },
          venue_name: venueName,
          address,
          coordinates: { lat, lng },
          start_date: startDate,
          start_time: startTime,
          end_date: endDate,
          end_time: endTime,
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
