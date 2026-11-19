/**
 * Multi-tier Facebook Public Event payload parser.
 * Supports Schema.org Event JSON-LD, Relay __bbox / ScheduledServerJS JSON
 * (including recurring child_events), OpenGraph <meta> tags, and RFC 5545 iCal (.ics).
 */

import { normalizeFacebookUrl } from './url-utils.js';

const EVENT_SCHEMA_TYPES = new Set([
  'Event',
  'SportsEvent',
  'SocialEvent',
  'Festival',
  'MusicEvent',
  'ChildrensEvent'
]);

function formatDateInAwst(dateInput) {
  if (dateInput === null || dateInput === undefined || dateInput === '') {
    return { date: null, time: null };
  }

  let dateObj;
  if (typeof dateInput === 'number') {
    const ms = dateInput < 1e12 ? dateInput * 1000 : dateInput;
    dateObj = new Date(ms);
  } else if (typeof dateInput === 'string') {
    const trimmed = dateInput.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return { date: trimmed, time: null };
    }
    dateObj = new Date(trimmed);
  } else if (dateInput instanceof Date) {
    dateObj = dateInput;
  }

  if (!dateObj || Number.isNaN(dateObj.getTime())) {
    return { date: null, time: null };
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(dateObj);

  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`
  };
}

function extractFacebookEventIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/\/events\/(?:[^/]+\/)?(\d+)/i);
  return match ? match[1] : null;
}

function flattenJsonLdNodes(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) flattenJsonLdNodes(item, out);
    return out;
  }
  if (typeof node === 'object') {
    if (Array.isArray(node['@graph'])) {
      flattenJsonLdNodes(node['@graph'], out);
    }
    const typeVal = node['@type'];
    const types = Array.isArray(typeVal) ? typeVal : (typeVal ? [typeVal] : []);
    if (types.some(t => EVENT_SCHEMA_TYPES.has(t))) {
      out.push(node);
    }
  }
  return out;
}

function parseAddressText(address) {
  if (!address) return '';
  if (typeof address === 'string') return address.trim();
  if (typeof address === 'object') {
    return [
      address.streetAddress,
      address.addressLocality,
      address.addressRegion,
      address.postalCode,
      address.addressCountry
    ].filter(Boolean).join(', ');
  }
  return '';
}

function parseCoordinates(geo) {
  if (!geo || typeof geo !== 'object') return null;
  const lat = Number(geo.latitude ?? geo.lat);
  const lng = Number(geo.longitude ?? geo.lng ?? geo.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function normalizeExtractedRecord(raw, fallbackUrl = '') {
  const canonicalUrl = normalizeFacebookUrl(raw.source_url || fallbackUrl) || raw.source_url || fallbackUrl || '';
  const eventId = String(raw.eventId || extractFacebookEventIdFromUrl(canonicalUrl) || '').trim();
  if (!eventId) return null;

  const isRecurringOccurrence = Boolean(raw.isRecurringOccurrence && raw.start_date);
  const yyyymmdd = isRecurringOccurrence ? raw.start_date.replace(/-/g, '') : '';
  const sourceId = isRecurringOccurrence ? `${eventId}_${yyyymmdd}` : eventId;

  return {
    eventId,
    source_id: sourceId,
    title: String(raw.title || '').trim(),
    description: String(raw.description || '').trim(),
    source_url: canonicalUrl || `https://www.facebook.com/events/${eventId}/`,
    start_date: raw.start_date || null,
    end_date: raw.end_date || null,
    start_time: raw.start_time || null,
    end_time: raw.end_time || null,
    is_online: Boolean(raw.is_online),
    venue_name: String(raw.venue_name || '').trim(),
    location_text: String(raw.location_text || '').trim(),
    coordinates: raw.coordinates || null,
    organizer_name: String(raw.organizer_name || '').trim(),
    is_free: raw.is_free,
    cost_description: String(raw.cost_description || '').trim()
  };
}

function extractFromJsonLd(html, context = {}) {
  const results = [];
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }

    const eventNodes = flattenJsonLdNodes(parsed);
    for (const node of eventNodes) {
      const start = formatDateInAwst(node.startDate);
      const end = formatDateInAwst(node.endDate);
      const location = node.location || {};
      const locationType = Array.isArray(location['@type']) ? location['@type'] : [location['@type']];
      const attendanceMode = String(node.eventAttendanceMode || '');
      const isOnline =
        attendanceMode.includes('OnlineEventAttendanceMode') ||
        locationType.includes('VirtualLocation') ||
        /\bonline\b/i.test(String(location.name || ''));

      const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const priceStr = offers && offers.price !== undefined ? String(offers.price) : '';
      const isFree = priceStr === '0' ? true : undefined;

      const normalized = normalizeExtractedRecord({
        source_url: node.url || context.sourceUrl,
        title: node.name,
        description: node.description,
        start_date: start.date,
        start_time: start.time,
        end_date: end.date,
        end_time: end.time,
        is_online: isOnline,
        venue_name: location.name || '',
        location_text: [location.name, parseAddressText(location.address)].filter(Boolean).join(', '),
        coordinates: parseCoordinates(location.geo),
        organizer_name: node.organizer?.name || '',
        is_free: isFree,
        cost_description: priceStr && priceStr !== '0' ? `$${priceStr}` : ''
      }, context.sourceUrl);

      if (normalized && normalized.title) {
        results.push(normalized);
      }
    }
  }
  return results;
}

function findRelayEventObjects(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) findRelayEventObjects(item, out, seen);
    return out;
  }

  const hasEventIdentity = Boolean(node.id || node.event_id) && Boolean(node.name || node.title);
  const hasSchedule =
    node.start_timestamp !== undefined ||
    node.start_time !== undefined ||
    node.startDate !== undefined ||
    Boolean(node.child_events);

  if (hasEventIdentity && hasSchedule) {
    const key = String(node.id || node.event_id);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(node);
    }
    return out;
  }

  for (const val of Object.values(node)) {
    if (val && typeof val === 'object') {
      findRelayEventObjects(val, out, seen);
    }
  }
  return out;
}

function buildRelayEventRecord(node, parentNode, context = {}, isRecurringOccurrence = false) {
  const baseEventId = String(parentNode?.id || node.id || node.event_id || '').trim();
  const title = node.name || node.title || parentNode?.name || parentNode?.title || '';
  const descObj = node.description || parentNode?.description;
  const description = typeof descObj === 'string' ? descObj : (descObj?.text || '');

  const start = formatDateInAwst(node.start_timestamp ?? node.start_time ?? node.startDate);
  const end = formatDateInAwst(node.end_timestamp ?? node.end_time ?? node.endDate);

  const place = node.event_place || node.location || parentNode?.event_place || parentNode?.location || {};
  const locationObj = place.location || place.geo || {};
  const coords = parseCoordinates(locationObj);

  const hosts = node.event_hosts || parentNode?.event_hosts || [];
  const firstHost = Array.isArray(hosts) && hosts.length > 0 ? hosts[0] : null;
  const organizerName = firstHost?.name || node.organizer?.name || parentNode?.organizer?.name || '';

  const addressParts = [
    place.name,
    place.address?.street,
    place.address?.city,
    place.address?.state,
    place.address?.zip,
    place.address?.country,
    typeof place.address === 'string' ? place.address : '',
    place.contextual_name
  ].filter(Boolean);

  const isOnline = Boolean(
    node.is_online ||
    parentNode?.is_online ||
    node.online_setup_type ||
    /\bonline\b/i.test(String(place.name || ''))
  );

  return normalizeExtractedRecord({
    eventId: baseEventId,
    isRecurringOccurrence,
    source_url: node.url || parentNode?.url || context.sourceUrl,
    title,
    description,
    start_date: start.date,
    start_time: start.time,
    end_date: end.date,
    end_time: end.time,
    is_online: isOnline,
    venue_name: place.name || '',
    location_text: addressParts.join(', '),
    coordinates: coords,
    organizer_name: organizerName,
    is_free: node.is_free ?? parentNode?.is_free,
    cost_description: node.ticket_price || parentNode?.ticket_price || ''
  }, context.sourceUrl);
}

function extractFromRelayJson(text, context = {}) {
  const candidates = [];

  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      candidates.push(JSON.parse(trimmed));
    } catch {
      // ignore
    }
  }

  const scriptRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(text)) !== null) {
    const body = match[1].trim();
    if (!body) continue;
    if (body.startsWith('{') || body.startsWith('[')) {
      try {
        candidates.push(JSON.parse(body));
      } catch {
        // ignore
      }
    } else if (body.includes('__bbox') || body.includes('ScheduledServerJS')) {
      const jsonStart = body.indexOf('{');
      const jsonEnd = body.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        try {
          candidates.push(JSON.parse(body.slice(jsonStart, jsonEnd + 1)));
        } catch {
          // ignore
        }
      }
    }
  }

  const results = [];
  for (const root of candidates) {
    const eventNodes = findRelayEventObjects(root);
    for (const eventNode of eventNodes) {
      const childNodes = eventNode.child_events?.nodes || eventNode.child_events || [];
      if (Array.isArray(childNodes) && childNodes.length > 0) {
        for (const child of childNodes) {
          const record = buildRelayEventRecord(child, eventNode, context, true);
          if (record && record.title) results.push(record);
        }
      } else {
        const record = buildRelayEventRecord(eventNode, null, context, false);
        if (record && record.title) results.push(record);
      }
    }
  }
  return results;
}

function decodeHtmlEntities(str = '') {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractFromOpenGraph(html, context = {}) {
  const metaMap = new Map();
  const metaRegex = /<meta\s+([^>]*?)>/gi;
  let match;
  while ((match = metaRegex.exec(html)) !== null) {
    const attrs = match[1];
    const propMatch = attrs.match(/(?:property|name)=["']([^"']+)["']/i);
    const contentMatch = attrs.match(/content=["']([^"']*)["']/i);
    if (propMatch && contentMatch) {
      metaMap.set(propMatch[1].toLowerCase(), decodeHtmlEntities(contentMatch[1]));
    }
  }

  const title = metaMap.get('og:title') || '';
  const url = metaMap.get('og:url') || context.sourceUrl || '';
  const eventId = extractFacebookEventIdFromUrl(url);
  if (!title || !eventId) {
    return [];
  }

  const start = formatDateInAwst(metaMap.get('event:start_time') || metaMap.get('og:start_time'));
  const end = formatDateInAwst(metaMap.get('event:end_time') || metaMap.get('og:end_time'));
  const lat = Number(metaMap.get('place:location:latitude'));
  const lng = Number(metaMap.get('place:location:longitude'));
  const coords = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  const description = metaMap.get('og:description') || '';

  const record = normalizeExtractedRecord({
    eventId,
    source_url: url,
    title,
    description,
    start_date: start.date,
    start_time: start.time,
    end_date: end.date,
    end_time: end.time,
    is_online: /\bonline\s+event\b/i.test(description) || /\bonline\b/i.test(metaMap.get('og:type') || ''),
    venue_name: metaMap.get('place:location:name') || '',
    location_text: [metaMap.get('place:location:name'), metaMap.get('og:locality'), metaMap.get('og:postal_code'), description].filter(Boolean).join(', '),
    coordinates: coords,
    organizer_name: metaMap.get('og:site_name') && metaMap.get('og:site_name') !== 'Facebook' ? metaMap.get('og:site_name') : ''
  }, context.sourceUrl);

  return record ? [record] : [];
}

function unescapeIcsText(str = '') {
  return String(str)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function parseIcsDateTime(rawValue = '') {
  const val = String(rawValue).trim();
  if (!val) return { date: null, time: null };

  const utcMatch = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i);
  if (utcMatch) {
    const iso = `${utcMatch[1]}-${utcMatch[2]}-${utcMatch[3]}T${utcMatch[4]}:${utcMatch[5]}:${utcMatch[6]}Z`;
    return formatDateInAwst(iso);
  }

  const localMatch = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (localMatch) {
    const iso = `${localMatch[1]}-${localMatch[2]}-${localMatch[3]}T${localMatch[4]}:${localMatch[5]}:${localMatch[6]}+08:00`;
    return formatDateInAwst(iso);
  }

  const dateOnlyMatch = val.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnlyMatch) {
    return { date: `${dateOnlyMatch[1]}-${dateOnlyMatch[2]}-${dateOnlyMatch[3]}`, time: null };
  }

  return formatDateInAwst(val);
}

function extractFromIcs(icsText, context = {}) {
  const unfolded = String(icsText).replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const results = [];
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) {
        const url = current.URL || context.sourceUrl || '';
        const uidDigits = current.UID ? (current.UID.match(/(\d{5,})/) || [])[1] : null;
        const eventId = extractFacebookEventIdFromUrl(url) || uidDigits || (current.UID ? current.UID.replace(/[^a-zA-Z0-9_-]/g, '_') : '');
        const start = parseIcsDateTime(current.DTSTART);
        const end = parseIcsDateTime(current.DTEND);
        const locationText = unescapeIcsText(current.LOCATION || '');
        const venueName = locationText.split(',')[0]?.trim() || '';

        let coords = null;
        if (current.GEO) {
          const [latStr, lngStr] = current.GEO.split(';');
          const lat = Number(latStr);
          const lng = Number(lngStr);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            coords = { lat, lng };
          }
        }

        const record = normalizeExtractedRecord({
          eventId,
          isRecurringOccurrence: Boolean(current.RRULE),
          source_url: url,
          title: unescapeIcsText(current.SUMMARY || ''),
          description: unescapeIcsText(current.DESCRIPTION || ''),
          start_date: start.date,
          start_time: start.time,
          end_date: end.date,
          end_time: end.time,
          is_online: /\bonline\b/i.test(locationText),
          venue_name: venueName,
          location_text: locationText,
          coordinates: coords,
          organizer_name: current.ORGANIZER_CN || ''
        }, context.sourceUrl);

        if (record && record.title) {
          results.push(record);
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const rawProp = line.slice(0, colonIdx);
    const val = line.slice(colonIdx + 1);
    const [propName, ...params] = rawProp.split(';');
    const upperProp = propName.toUpperCase();

    if (upperProp === 'ORGANIZER') {
      const cnParam = params.find(p => /^CN=/i.test(p));
      if (cnParam) {
        current.ORGANIZER_CN = cnParam.slice(3).replace(/^"|"$/g, '').trim();
      }
    }
    current[upperProp] = val;
  }

  return results;
}

/**
 * Extracts normalized Facebook Event records across JSON-LD, Relay JSON, OpenGraph, and iCal .ics tiers.
 *
 * @param {string | object} payload
 * @param {{ sourceUrl?: string, format?: string }} [context={}]
 * @returns {Array<object>}
 */
export function extractFacebookEvents(payload, context = {}) {
  if (!payload) return [];
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);

  if (context.format === 'ics' || text.includes('BEGIN:VCALENDAR')) {
    return extractFromIcs(text, context);
  }

  const jsonLdEvents = extractFromJsonLd(text, context);
  if (jsonLdEvents.length > 0) {
    return jsonLdEvents;
  }

  const relayEvents = extractFromRelayJson(text, context);
  if (relayEvents.length > 0) {
    return relayEvents;
  }

  return extractFromOpenGraph(text, context);
}
