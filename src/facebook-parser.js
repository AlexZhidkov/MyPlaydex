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

export function isCometNonEntityRoute(text = '') {
  return (
    text.includes('"canonicalRouteName":"comet.fbweb.CometErrorRoute"') ||
    text.includes('"canonicalRouteName":"comet.fbweb.CometHomeRoute"')
  );
}

const MONTH_NAME_MAP = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
};

const WEEKDAY_MAP = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

const MONTH_PATTERN = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const MONTH_DAY_YEAR_REGEX = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i');
const DAY_MONTH_YEAR_REGEX = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN}),?\\s+(\\d{4})\\b`, 'i');
const MONTH_DAY_REGEX = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i');
const DAY_MONTH_REGEX = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\b`, 'i');
const RELATIVE_WEEKDAY_REGEX = /\b(?:This\s+|Next\s+)?(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/i;

function formatValidCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDaysToYmd(ymd, days) {
  const [year, month, day] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function parseDayTimeSentence(sentence, referenceDate = new Date()) {
  if (!sentence || typeof sentence !== 'string') {
    return { date: null, time: null };
  }

  const cleaned = sentence.replace(/[\u202f\u00a0]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return { date: null, time: null };
  }

  const startSegment = cleaned.split(/\s+(?:–|—|-|to)\s+/i)[0].trim();

  let time = null;
  let datePart = startSegment;

  const amPmMatch = startSegment.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
  if (amPmMatch) {
    const rawHour = parseInt(amPmMatch[1], 10);
    const minute = amPmMatch[2] ? parseInt(amPmMatch[2], 10) : 0;
    const meridiem = amPmMatch[3].toUpperCase();
    if (rawHour >= 1 && rawHour <= 12 && minute >= 0 && minute <= 59) {
      let hour24 = rawHour % 12;
      if (meridiem === 'PM') hour24 += 12;
      time = `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
    datePart = startSegment.replace(amPmMatch[0], ' ').replace(/[\s,]+$/, '').trim();
  } else {
    const h24Match = startSegment.match(/\bat\s+(\d{1,2}):(\d{2})\b/i);
    if (h24Match) {
      const hour24 = parseInt(h24Match[1], 10);
      const minute = parseInt(h24Match[2], 10);
      if (hour24 >= 0 && hour24 <= 23 && minute >= 0 && minute <= 59) {
        time = `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      }
      datePart = startSegment.replace(h24Match[0], ' ').replace(/[\s,]+$/, '').trim();
    }
  }

  const baseDate = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
    ? referenceDate
    : new Date();
  const refAwst = formatDateInAwst(baseDate);
  const refDate = refAwst.date || formatDateInAwst(new Date()).date;
  const refYear = Number(refDate.slice(0, 4));

  let date = null;

  const mdyMatch = datePart.match(MONTH_DAY_YEAR_REGEX);
  const dmyMatch = !mdyMatch ? datePart.match(DAY_MONTH_YEAR_REGEX) : null;
  if (mdyMatch) {
    const month = MONTH_NAME_MAP[mdyMatch[1].toLowerCase()];
    const day = parseInt(mdyMatch[2], 10);
    const year = parseInt(mdyMatch[3], 10);
    date = formatValidCalendarDate(year, month, day);
  } else if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = MONTH_NAME_MAP[dmyMatch[2].toLowerCase()];
    const year = parseInt(dmyMatch[3], 10);
    date = formatValidCalendarDate(year, month, day);
  } else {
    const mdMatch = datePart.match(MONTH_DAY_REGEX);
    const dmMatch = !mdMatch ? datePart.match(DAY_MONTH_REGEX) : null;
    if (mdMatch) {
      const month = MONTH_NAME_MAP[mdMatch[1].toLowerCase()];
      const day = parseInt(mdMatch[2], 10);
      date = formatValidCalendarDate(refYear, month, day);
    } else if (dmMatch) {
      const day = parseInt(dmMatch[1], 10);
      const month = MONTH_NAME_MAP[dmMatch[2].toLowerCase()];
      date = formatValidCalendarDate(refYear, month, day);
    } else if (/\bToday\b/i.test(datePart)) {
      date = refDate;
    } else if (/\bTomorrow\b/i.test(datePart)) {
      date = addDaysToYmd(refDate, 1);
    } else {
      const weekdayMatch = datePart.match(RELATIVE_WEEKDAY_REGEX);
      if (weekdayMatch) {
        const targetDow = WEEKDAY_MAP[weekdayMatch[1].toLowerCase()];
        const [ry, rm, rd] = refDate.split('-').map(Number);
        const currentDow = new Date(Date.UTC(ry, rm - 1, rd)).getUTCDay();
        const offsetDays = (targetDow - currentDow + 7) % 7;
        date = addDaysToYmd(refDate, offsetDays);
      }
    }
  }

  return { date, time };
}

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

function hasRelaySchedule(node) {
  if (!node || typeof node !== 'object') return false;
  return (
    node.start_timestamp !== undefined ||
    node.start_time !== undefined ||
    node.startDate !== undefined ||
    Boolean(node.child_events) ||
    typeof node.day_time_sentence === 'string' ||
    typeof node.capitalized_day_time_sentence === 'string'
  );
}

function mergeRelayFragment(target, source) {
  for (const [key, val] of Object.entries(source)) {
    if (val === undefined || val === null || val === '') continue;
    const cur = target[key];
    if (cur === undefined || cur === null || cur === '') {
      target[key] = val;
    } else if (Array.isArray(cur) && cur.length === 0 && Array.isArray(val) && val.length > 0) {
      target[key] = val;
    } else if (
      typeof cur === 'object' &&
      !Array.isArray(cur) &&
      typeof val === 'object' &&
      !Array.isArray(val)
    ) {
      const nextNested = { ...cur };
      for (const [subKey, subVal] of Object.entries(val)) {
        if (
          (nextNested[subKey] === undefined || nextNested[subKey] === null || nextNested[subKey] === '') &&
          subVal !== undefined &&
          subVal !== null &&
          subVal !== ''
        ) {
          nextNested[subKey] = subVal;
        }
      }
      target[key] = nextNested;
    }
  }
}

function collectRelayEventFragments(node, mergedById = new Map()) {
  if (!node || typeof node !== 'object') return mergedById;
  if (Array.isArray(node)) {
    for (const item of node) collectRelayEventFragments(item, mergedById);
    return mergedById;
  }

  const isTypedEvent = node.__typename === 'Event' && Boolean(node.id || node.event_id);
  const isLegacyEvent = Boolean(node.id || node.event_id) && Boolean(node.name || node.title) && hasRelaySchedule(node);

  if (isTypedEvent || isLegacyEvent) {
    const key = String(node.id || node.event_id);
    if (!mergedById.has(key)) {
      mergedById.set(key, { ...node });
    } else {
      mergeRelayFragment(mergedById.get(key), node);
    }
  }

  for (const [key, val] of Object.entries(node)) {
    if (key === 'child_events') continue;
    if (val && typeof val === 'object') {
      collectRelayEventFragments(val, mergedById);
    }
  }
  return mergedById;
}

function buildRelayEventRecord(node, parentNode, context = {}, isRecurringOccurrence = false) {
  const baseEventId = String(parentNode?.id || node.id || node.event_id || '').trim();
  const title = node.name || node.title || parentNode?.name || parentNode?.title || '';
  const descObj = node.description || node.event_description || parentNode?.description || parentNode?.event_description;
  const description = typeof descObj === 'string' ? descObj : (descObj?.text || '');

  let start = formatDateInAwst(node.start_timestamp ?? node.start_time ?? node.startDate);
  if (!start.date) {
    const sentence =
      node.day_time_sentence ||
      node.capitalized_day_time_sentence ||
      parentNode?.day_time_sentence ||
      parentNode?.capitalized_day_time_sentence;
    if (sentence) {
      start = parseDayTimeSentence(sentence, context.now);
    }
  }
  const end = formatDateInAwst(node.end_timestamp ?? node.end_time ?? node.endDate);

  const place = node.event_place || node.location || parentNode?.event_place || parentNode?.location || {};
  const locationObj = place.location || place.geo || {};
  const coords = parseCoordinates(locationObj);

  const hosts = node.event_hosts || parentNode?.event_hosts || [];
  const firstHost = Array.isArray(hosts) && hosts.length > 0 ? hosts[0] : null;
  const organizerName =
    firstHost?.name ||
    node.organizer?.name ||
    parentNode?.organizer?.name ||
    node.event_creator?.name ||
    parentNode?.event_creator?.name ||
    node.owner?.name ||
    parentNode?.owner?.name ||
    '';

  const rawAddressParts = [
    place.name,
    place.contextual_name,
    place.one_line_address,
    place.address?.street,
    place.address?.city,
    place.address?.state,
    place.address?.zip,
    place.address?.country,
    typeof place.address === 'string' ? place.address : '',
    place.city?.contextual_name
  ].filter(Boolean);
  const addressParts = rawAddressParts.filter((part, idx) => idx === 0 || part !== rawAddressParts[idx - 1]);

  const isOnline = Boolean(
    node.is_online ||
    parentNode?.is_online ||
    node.online_setup_type ||
    /\bonline\b/i.test(String(place.name || place.contextual_name || ''))
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
    venue_name: place.name || place.contextual_name || '',
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

  const mergedById = new Map();
  for (const root of candidates) {
    collectRelayEventFragments(root, mergedById);
  }

  const results = [];
  for (const eventNode of mergedById.values()) {
    if (!Boolean(eventNode.name || eventNode.title) || !hasRelaySchedule(eventNode) || eventNode.is_canceled === true) {
      continue;
    }
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

  if (isCometNonEntityRoute(text)) {
    return [];
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

/**
 * Discovers unique `/events/<id>` detail links from an Organizer Facebook Page HTML payload.
 *
 * @param {string} html
 * @returns {Array<{ eventId: string, url: string }>}
 */
export function extractFacebookEventLinks(html) {
  if (!html || typeof html !== 'string') return [];
  if (html.includes('BEGIN:VCALENDAR')) return [];
  if (isCometNonEntityRoute(html)) return [];

  const normalizedHtml = html.replace(/\\\//g, '/');
  const fbUrlOrRootRelativeRegex = /(?:https?:\/\/(?:[a-z0-9-]+\.)?(?:facebook\.com|fb\.com|fb\.me)|(?:^|["'\s]))\/events\/(?:[^/"'\s<>?]+\/)?(\d{5,})/gi;
  const relayEventForwardRegex = /"__typename"\s*:\s*"Event"[^{}]*?"id"\s*:\s*"(\d{5,})"/g;
  const relayEventReverseRegex = /"id"\s*:\s*"(\d{5,})"[^{}]*?"__typename"\s*:\s*"Event"/g;

  const seen = new Set();
  const links = [];

  const recordId = (eventId) => {
    if (!seen.has(eventId)) {
      seen.add(eventId);
      const url = normalizeFacebookUrl(`https://www.facebook.com/events/${eventId}/`) || `https://www.facebook.com/events/${eventId}`;
      links.push({ eventId, url });
    }
  };

  for (const regex of [fbUrlOrRootRelativeRegex, relayEventForwardRegex, relayEventReverseRegex]) {
    let match;
    while ((match = regex.exec(normalizedHtml)) !== null) {
      recordId(match[1]);
    }
  }

  return links;
}
