/**
 * Config-Driven OpenCities & Semantic HTML Council Crawler Adapter
 * Zero-dependency adapter for councils publishing Activities as semantic HTML
 * <article> Activity cards (OpenCities / Granicus, SparkSearch / RadListView).
 */

import { determineIsFree, slugify } from '../sanitizer.js';
import {
  DEFAULT_HORIZON_DAYS,
  DEFAULT_MAX_ACTIVITIES,
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_DELAY_MS,
  filterCouncilItem,
  isCivicAdminNotice,
  isOnlineOnlyItem,
  paginateCouncilPages,
  resolveCouncilCategoryAndSubcategory,
  sleepMs
} from './council-utils.js';

export const DEFAULT_DETAIL_DELAY_MS = 250;

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot)';

const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

const NAMED_HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  eacute: 'é',
  Eacute: 'É'
};

function decodeHtmlEntities(str = '') {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (full, dec, hex, named) => {
    if (dec) {
      const code = Number.parseInt(dec, 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    if (named && Object.prototype.hasOwnProperty.call(NAMED_HTML_ENTITIES, named)) {
      return NAMED_HTML_ENTITIES[named];
    }
    if (named && Object.prototype.hasOwnProperty.call(NAMED_HTML_ENTITIES, named.toLowerCase())) {
      return NAMED_HTML_ENTITIES[named.toLowerCase()];
    }
    return full;
  });
}

function stripNonContentHtml(html = '') {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

function stripHtmlTags(html = '') {
  if (!html || typeof html !== 'string') return '';
  const withSpaces = html
    .replace(/<(?:br|hr)\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|article|section|header|footer|span|strong|em)>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(withSpaces)
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

function extractAttr(attrString = '', attrName = '') {
  if (!attrString || !attrName) return null;
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\\`]+))`, 'i');
  const match = attrString.match(regex);
  if (!match) return null;
  return decodeHtmlEntities((match[1] ?? match[2] ?? match[3] ?? '').trim());
}

function findBalancedTagEnd(html, tagName, contentStart) {
  const lowerTag = tagName.toLowerCase();
  if (VOID_HTML_TAGS.has(lowerTag)) {
    return { innerEnd: contentStart, outerEnd: contentStart };
  }
  const tagScanner = new RegExp(`<(\\/?)${lowerTag}\\b([^>]*)>`, 'gi');
  tagScanner.lastIndex = contentStart;
  let depth = 1;
  let m;
  while ((m = tagScanner.exec(html)) !== null) {
    const isClosing = m[1] === '/';
    const selfClosing = !isClosing && /\/\s*$/.test(m[2]);
    if (selfClosing) continue;
    if (isClosing) {
      depth -= 1;
      if (depth === 0) {
        return { innerEnd: m.index, outerEnd: m.index + m[0].length };
      }
    } else {
      depth += 1;
    }
  }
  return { innerEnd: html.length, outerEnd: html.length };
}

function hasClassToken(classAttr = '', targets) {
  if (!classAttr) return false;
  const targetSet = targets instanceof Set
    ? targets
    : new Set((Array.isArray(targets) ? targets : [targets]).map(t => String(t).toLowerCase()));
  return classAttr
    .toLowerCase()
    .split(/\s+/)
    .some(token => token && targetSet.has(token));
}

function extractFirstElementByClass(html, classNames) {
  const names = Array.isArray(classNames) ? classNames : [classNames];
  const targetSet = new Set(names.map(n => String(n).toLowerCase()));
  const openRegex = /<([a-z0-9]+)\b([^>]*\bclass\s*=[^>]*)>/gi;
  let m;
  while ((m = openRegex.exec(html)) !== null) {
    const tagName = m[1];
    const attrs = m[2];
    const cls = extractAttr(attrs, 'class');
    if (!hasClassToken(cls, targetSet)) {
      continue;
    }
    const contentStart = m.index + m[0].length;
    if (/\/\s*$/.test(attrs) || VOID_HTML_TAGS.has(tagName.toLowerCase())) {
      continue;
    }
    const { innerEnd } = findBalancedTagEnd(html, tagName, contentStart);
    return {
      tagName: tagName.toLowerCase(),
      attrs,
      innerHtml: html.slice(contentStart, innerEnd)
    };
  }
  return null;
}

function extractTextByClassOrder(html, classOrder) {
  for (const className of classOrder) {
    const found = extractFirstElementByClass(html, className);
    if (found) {
      const text = stripHtmlTags(found.innerHtml);
      if (text) return text;
    }
  }
  return '';
}

function resolveUrl(baseUrl, href, currentUrl = null) {
  if (!href || typeof href !== 'string') return null;
  const trimmed = decodeHtmlEntities(href).trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (/^(?:javascript|mailto|tel):/i.test(trimmed)) return null;
  if (trimmed.includes('/cdn-cgi/l/email-protection')) return null;

  try {
    return new URL(trimmed, currentUrl || baseUrl).toString();
  } catch {
    return null;
  }
}

function findCardHref(html, articleIndex, articleInnerHtml) {
  for (const anchorMatch of articleInnerHtml.matchAll(/<a\b([^>]*)>/gi)) {
    const href = extractAttr(anchorMatch[1], 'href');
    if (href && !href.startsWith('#') && !/^(?:javascript|mailto|tel):/i.test(href)) {
      return href;
    }
  }

  const beforeArticle = html.slice(0, articleIndex);
  const lastOpenAnchorIdx = beforeArticle.toLowerCase().lastIndexOf('<a');
  if (lastOpenAnchorIdx === -1) return null;

  const between = beforeArticle.slice(lastOpenAnchorIdx);
  if (/<\/a\s*>/i.test(between)) return null;

  const openTagMatch = between.match(/^<a\b([^>]*)>/i);
  if (!openTagMatch) return null;
  return extractAttr(openTagMatch[1], 'href');
}

function deriveSourceId(attrs, resolvedUrl, title) {
  const attrId = extractAttr(attrs, 'data-event-id') || extractAttr(attrs, 'data-id');
  if (attrId) return attrId;

  if (resolvedUrl) {
    try {
      const { pathname } = new URL(resolvedUrl);
      const numericTail = pathname.match(/\/(\d+)\/?$/);
      if (numericTail) {
        return numericTail[1];
      }
      const trimmedPath = pathname
        .replace(/^\/(?:events-directory|events|whats-on)\//i, '')
        .replace(/^\/+|\/+$/g, '');
      const pathSlug = slugify(trimmedPath);
      if (pathSlug) return pathSlug;
    } catch {
      // Fall through to title slug
    }
  }

  return slugify(title) || 'activity';
}

function extractNumericCoordAttr(attrs, names) {
  for (const name of names) {
    const raw = extractAttr(attrs, name);
    if (raw !== null && raw !== '') {
      const num = Number(raw);
      if (Number.isFinite(num)) return num;
    }
  }
  return null;
}

function extractDataCoordinates(innerHtml = '', extraAttrs = '') {
  const sources = [extraAttrs, innerHtml].filter(Boolean);
  for (const src of sources) {
    const lat = extractNumericCoordAttr(src, ['data-lat', 'data-latitude']);
    const lng = extractNumericCoordAttr(src, ['data-lng', 'data-lon', 'data-longitude']);
    if (lat !== null && lng !== null) {
      return { lat, lng };
    }
  }
  return undefined;
}

function parseTagList(rawText = '') {
  const cleaned = String(rawText || '')
    .replace(/^(?:tagged\s+as|categories|category)\s*:\s*/i, '')
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/[,;|]+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function stripFieldPrefix(text = '', pattern) {
  return String(text || '').replace(pattern, '').trim();
}

function extractTitleFromHtml(innerHtml) {
  const classed = extractTextByClassOrder(innerHtml, ['list-item-title', 'event-title', 'title']);
  if (classed) return classed;

  const headingMatch = innerHtml.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
  return headingMatch ? stripHtmlTags(headingMatch[1]) : '';
}

function extractClassedOrganizer(innerHtml) {
  const rawName = extractTextByClassOrder(innerHtml, [
    'event-organizer',
    'event-organiser',
    'organizer',
    'organiser',
    'event-host',
    'presented-by'
  ]);
  const cleaned = stripFieldPrefix(rawName, /^(?:organi[sz]ed\s+by|organi[sz]er|presented\s+by|hosted\s+by)\s*:\s*/i);
  return cleaned ? { name: cleaned } : null;
}

function extractTimeDatetimes(innerHtml) {
  const datetimes = [];
  for (const m of innerHtml.matchAll(/<time\b([^>]*)>/gi)) {
    const dt = extractAttr(m[1], 'datetime');
    if (dt) datetimes.push(dt);
  }
  return {
    startDateTime: datetimes[0] || null,
    endDateTime: datetimes[1] || null
  };
}

function parseArticleCard(cleanHtml, match, config) {
  const articleAttrs = match[1] || '';
  const innerHtml = match[2] || '';
  const rawHref = findCardHref(cleanHtml, match.index, innerHtml);
  const url = rawHref ? resolveUrl(config.baseUrl, rawHref, config.currentUrl) : null;

  if (config.cardUrlPattern && (!url || !config.cardUrlPattern.test(url))) {
    return null;
  }

  const title = extractTitleFromHtml(innerHtml);
  if (!title) return null;

  const sourceId = deriveSourceId(articleAttrs, url, title);
  const { startDateTime, endDateTime } = extractTimeDatetimes(innerHtml);
  const dateText = extractTextByClassOrder(innerHtml, [
    'list-item-block-date',
    'event-dates',
    'event-date',
    'date'
  ]) || extractParagraphWithPattern(innerHtml, /fa-calendar/i);
  const timeText = extractTextByClassOrder(innerHtml, ['event-time', 'time']);

  const rawLocation = extractTextByClassOrder(innerHtml, [
    'events-detail-location',
    'list-item-address',
    'event-location',
    'location-info',
    'location',
    'venue'
  ]);
  const location = stripFieldPrefix(rawLocation, /^(?:location|venue)\s*:\s*/i);
  const addressEl = extractFirstElementByClass(innerHtml, ['list-item-address', 'address']);
  const venueEl = extractFirstElementByClass(innerHtml, ['venue']);
  const address = stripFieldPrefix(addressEl ? stripHtmlTags(addressEl.innerHtml) : location, /^(?:location|address)\s*:\s*/i);
  const venueName = stripFieldPrefix(venueEl ? stripHtmlTags(venueEl.innerHtml) : location, /^(?:location|venue)\s*:\s*/i);

  const description = extractTextByClassOrder(innerHtml, [
    'list-item-block-desc',
    'event-description',
    'event-summary',
    'summary',
    'description'
  ]);
  const rawTagText = extractTextByClassOrder(innerHtml, [
    'tagged-as-list',
    'event-categories',
    'events-detail-category',
    'event-tags',
    'tags',
    'category'
  ]);
  const tags = parseTagList(rawTagText);
  const cost = stripFieldPrefix(
    extractTextByClassOrder(innerHtml, ['event-cost', 'cost', 'price']),
    /^cost\s*:\s*/i
  );
  const organizer = extractClassedOrganizer(innerHtml);
  const coordinates = extractDataCoordinates(innerHtml, articleAttrs);

  return {
    sourceId,
    title,
    url,
    startDateTime,
    endDateTime,
    dateText,
    timeText,
    location,
    venueName,
    address,
    description,
    tags,
    cost,
    organizer,
    coordinates
  };
}

function pickPreferredDateText(primaryDate = '', secondaryDate = '') {
  const primaryHasYear = /\b20\d{2}\b/.test(primaryDate || '');
  const secondaryHasYear = /\b20\d{2}\b/.test(secondaryDate || '');
  if (secondaryHasYear && !primaryHasYear) {
    return secondaryDate;
  }
  return primaryDate || secondaryDate || '';
}

function mergeCardData(primary, fallback) {
  if (!fallback || typeof fallback !== 'object') return primary;

  return {
    ...primary,
    title: primary.title || fallback.title,
    url: primary.url || fallback.url,
    startDateTime: primary.startDateTime || fallback.startDateTime || null,
    endDateTime: primary.endDateTime || fallback.endDateTime || null,
    dateText: pickPreferredDateText(primary.dateText, fallback.dateText),
    timeText: primary.timeText || fallback.timeText || '',
    location: primary.location || fallback.location || '',
    venueName: primary.venueName || fallback.venueName || '',
    address: primary.address || fallback.address || '',
    description: primary.description || fallback.description || '',
    tags: primary.tags?.length ? primary.tags : (fallback.tags || []),
    cost: primary.cost || fallback.cost || '',
    organizer: primary.organizer || fallback.organizer || null,
    coordinates: primary.coordinates || fallback.coordinates
  };
}

/**
 * Normalizes shorthand time range text (e.g. "4 - 8pm" -> "4pm - 8pm")
 * so `parseSchedule()` extracts both start_time and end_time.
 *
 * @param {string} [text='']
 * @returns {string}
 */
export function normalizeTimeRangeText(text = '') {
  if (!text || typeof text !== 'string') return '';
  return text.replace(
    /\b(\d{1,2})(?:([:.])(\d{2}))?\s*([-–—]|to)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/gi,
    (full, sHourRaw, sep, sMinRaw, dash, eHourRaw, eMinRaw, endMeridiemRaw) => {
      const sHour = Number.parseInt(sHourRaw, 10);
      const eHour = Number.parseInt(eHourRaw, 10);
      const endMeridiem = endMeridiemRaw.toLowerCase();
      if (sHour < 1 || sHour > 12 || eHour < 1 || eHour > 12) return full;

      const sMin = sMinRaw ? Number.parseInt(sMinRaw, 10) : 0;
      const eMin = eMinRaw ? Number.parseInt(eMinRaw, 10) : 0;
      const endHour24 = (endMeridiem === 'am' && eHour === 12)
        ? 24
        : (endMeridiem === 'pm' ? (eHour === 12 ? 12 : eHour + 12) : eHour);
      const endTotalMin = endHour24 * 60 + eMin;

      const sameMeridiemHour24 = endMeridiem === 'pm'
        ? (sHour === 12 ? 12 : sHour + 12)
        : (sHour === 12 ? 0 : sHour);
      const sameTotalMin = sameMeridiemHour24 * 60 + sMin;

      const startMeridiem = (sameTotalMin < endTotalMin && (endTotalMin - sameTotalMin) <= 12 * 60)
        ? endMeridiem
        : (endMeridiem === 'pm' ? 'am' : 'pm');

      const startTimeStr = sMinRaw ? `${sHourRaw}${sep}${sMinRaw}${startMeridiem}` : `${sHourRaw}${startMeridiem}`;
      const endTimeStr = eMinRaw ? `${eHourRaw}:${eMinRaw}${endMeridiemRaw}` : `${eHourRaw}${endMeridiemRaw}`;
      return `${startTimeStr} ${dash} ${endTimeStr}`;
    }
  );
}

function extractFormActionAndHiddenFields(cleanHtml, config, controlIndex = -1) {
  let targetFormAttrs = null;
  let fieldScopeHtml = cleanHtml;

  if (controlIndex >= 0) {
    for (const formMatch of cleanHtml.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
      const formStart = formMatch.index;
      const formEnd = formStart + formMatch[0].length;
      if (controlIndex >= formStart && controlIndex <= formEnd) {
        targetFormAttrs = formMatch[1];
        fieldScopeHtml = formMatch[2];
        break;
      }
    }
  }

  if (targetFormAttrs === null) {
    const firstFormMatch = cleanHtml.match(/<form\b([^>]*)>/i);
    targetFormAttrs = firstFormMatch ? firstFormMatch[1] : null;
  }

  const formAction = targetFormAttrs ? extractAttr(targetFormAttrs, 'action') : null;
  const actionUrl = resolveUrl(config.baseUrl, formAction || config.currentUrl || config.endpoint, config.currentUrl) ||
    config.currentUrl ||
    config.endpoint;

  const targetFields = ['__SEAMLESSVIEWSTATE', '__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION'];
  const params = new URLSearchParams();

  for (const inputMatch of fieldScopeHtml.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = inputMatch[1];
    const name = extractAttr(attrs, 'name');
    if (name && targetFields.includes(name)) {
      params.set(name, extractAttr(attrs, 'value') || '');
    }
  }

  return { actionUrl, params };
}

function extractAnchorNextRequest(cleanHtml, config) {
  const currentPage = Number(config.page || 1);
  let pageNumberMatch = null;

  for (const anchorMatch of cleanHtml.matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = anchorMatch[1];
    const cls = extractAttr(attrs, 'class') || '';
    const ariaDisabled = extractAttr(attrs, 'aria-disabled');
    if (hasClassToken(cls, 'disabled') || ariaDisabled === 'true') continue;

    const href = extractAttr(attrs, 'href');
    const url = resolveUrl(config.baseUrl, href, config.currentUrl);
    if (!url) continue;

    const rel = extractAttr(attrs, 'rel') || '';
    const ariaLabel = extractAttr(attrs, 'aria-label') || '';
    if (/\bnext\b/i.test(rel) || hasClassToken(cls, ['next', 'next-page', 'pagination-next']) || /^next\b/i.test(ariaLabel)) {
      return { method: 'GET', url };
    }

    if (!pageNumberMatch) {
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.searchParams.get('page') === String(currentPage + 1)) {
          pageNumberMatch = { method: 'GET', url };
        }
      } catch {
        // Ignore malformed URL
      }
    }
  }

  return pageNumberMatch;
}

function extractSeamlessNextRequest(cleanHtml, config) {
  for (const inputMatch of cleanHtml.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = inputMatch[1];
    const type = (extractAttr(attrs, 'type') || '').toLowerCase();
    const value = (extractAttr(attrs, 'value') || '').trim();
    const cls = extractAttr(attrs, 'class') || '';
    if (type !== 'submit' || !/^next$/i.test(value)) continue;
    if (/\bdisabled\b/i.test(attrs) || /(?:^|[\s_-])disabled(?:$|[\s_-])/i.test(cls)) continue;

    const inputName = extractAttr(attrs, 'name');
    if (!inputName) continue;

    const { actionUrl, params } = extractFormActionAndHiddenFields(cleanHtml, config, inputMatch.index);
    params.set('__EVENTTARGET', '');
    params.set('__EVENTARGUMENT', '');
    params.set(inputName, value);
    return { method: 'POST', url: actionUrl, formBody: params };
  }
  return null;
}

function extractTelerikNextRequest(cleanHtml, config) {
  for (const tagMatch of cleanHtml.matchAll(/<(?:button|a)\b([^>]*)>/gi)) {
    const attrs = tagMatch[1];
    const cls = extractAttr(attrs, 'class') || '';
    const name = extractAttr(attrs, 'name') || '';
    const id = extractAttr(attrs, 'id') || '';
    if (!hasClassToken(cls, 'rdpPageNext') && !/NextButton$/i.test(name) && !/NextButton$/i.test(id)) {
      continue;
    }
    if (/\bdisabled\b/i.test(attrs) || hasClassToken(cls, 'disabled')) continue;

    const onclick = extractAttr(attrs, 'onclick') || '';
    if (/^\s*return\s+false\s*;/i.test(onclick)) continue;

    const href = extractAttr(attrs, 'href') || '';
    const postBackMatch = (onclick + ' ' + href).match(/__doPostBack\(\s*['"]([^'"]+)['"]/i);
    if (!postBackMatch) continue;

    const { actionUrl, params } = extractFormActionAndHiddenFields(cleanHtml, config, tagMatch.index);
    params.set('__EVENTTARGET', postBackMatch[1]);
    params.set('__EVENTARGUMENT', '');
    return { method: 'POST', url: actionUrl, formBody: params };
  }
  return null;
}

function extractNextPaginationRequest(cleanHtml, config) {
  return (
    extractAnchorNextRequest(cleanHtml, config) ||
    extractSeamlessNextRequest(cleanHtml, config) ||
    extractTelerikNextRequest(cleanHtml, config) ||
    null
  );
}

/**
 * Parses an OpenCities / semantic HTML listing page into normalized Activity cards
 * and next-page pagination state.
 *
 * @param {string} html
 * @param {object} [config={}]
 * @returns {{ cards: Array<object>, hasMore: boolean, nextRequest: object | null }}
 */
export function parseOpenCitiesListingPage(html = '', config = {}) {
  const cleanHtml = stripNonContentHtml(html);
  const byId = new Map();

  for (const match of cleanHtml.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)) {
    const card = parseArticleCard(cleanHtml, match, config);
    if (!card) continue;
    const prev = byId.get(card.sourceId);
    byId.set(card.sourceId, prev ? mergeCardData(prev, card) : card);
  }

  const nextRequest = extractNextPaginationRequest(cleanHtml, config);
  return {
    cards: [...byId.values()],
    hasMore: Boolean(nextRequest),
    nextRequest
  };
}

function extractParagraphWithPattern(html, pattern) {
  for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    if (pattern.test(m[1])) {
      const text = stripHtmlTags(m[1]);
      if (text) return text;
    }
  }
  return '';
}

function extractJsonLdGeo(html = '') {
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const lat = Number(item?.geo?.latitude ?? item?.location?.geo?.latitude);
        const lng = Number(item?.geo?.longitude ?? item?.location?.geo?.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return { lat, lng };
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  }
  return undefined;
}

function extractContactInfoOrganizer(cleanHtml, config) {
  const contactDiv = extractFirstElementByClass(cleanHtml, ['contact-info']);
  if (!contactDiv) return null;

  let website = null;
  for (const pMatch of contactDiv.innerHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const pText = stripHtmlTags(pMatch[1]);
    if (/^(?:website|web)\s*:/i.test(pText)) {
      const hrefMatch = pMatch[1].match(/<a\b[^>]*\bhref=["']([^"']+)["']/i);
      const candidate = hrefMatch ? resolveUrl(config.baseUrl, hrefMatch[1], config.currentUrl) : null;
      if (candidate && /^https?:\/\//i.test(candidate)) {
        website = candidate;
      }
    }
  }

  for (const pMatch of contactDiv.innerHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = stripHtmlTags(pMatch[1]);
    if (!text) continue;
    if (/^(?:email|e-mail|phone|ph|tel|mobile|fax|website|web|contact)\s*:/i.test(text)) continue;
    if (/\[email\s*protected\]|cf_email|@/i.test(text)) continue;
    if (/^[+\d\s().-]+$/.test(text)) continue;
    return {
      name: text,
      ...(website ? { website } : {})
    };
  }

  return null;
}

/**
 * Parses an OpenCities / council Activity detail page into supplemental fields.
 *
 * @param {string} html
 * @param {object} [config={}]
 * @returns {object}
 */
export function parseOpenCitiesDetailPage(html = '', config = {}) {
  if (typeof html !== 'string' || !html.trim()) return {};

  const jsonLdCoords = extractJsonLdGeo(html);
  const cleanHtml = stripNonContentHtml(html);

  const eventContentEl = extractFirstElementByClass(cleanHtml, ['event-content']);
  const titleScope = eventContentEl ? eventContentEl.innerHtml : cleanHtml;
  const title = extractTitleFromHtml(titleScope);

  const description = extractTextByClassOrder(cleanHtml, [
    'event-description',
    'list-item-block-desc',
    'event-summary',
    'description'
  ]);

  const { startDateTime, endDateTime } = extractTimeDatetimes(cleanHtml);
  const timeText = extractTextByClassOrder(cleanHtml, ['event-time', 'time']) ||
    extractParagraphWithPattern(cleanHtml, /fa-clock/i);
  const dateText = extractParagraphWithPattern(cleanHtml, /fa-calendar/i) ||
    extractTextByClassOrder(cleanHtml, ['event-date', 'date', 'event-dates']);

  const rawLocation = extractParagraphWithPattern(cleanHtml, /fa-location-dot|fa-map-marker/i) ||
    extractTextByClassOrder(cleanHtml, ['events-detail-location', 'list-item-address', 'event-location', 'location']);
  const location = stripFieldPrefix(rawLocation, /^(?:location|address)\s*:\s*/i);

  const rawVenue = extractParagraphWithPattern(cleanHtml, /lblVenue|>\s*Venue\s*:/i);
  const venueName = stripFieldPrefix(rawVenue, /^venue\s*:\s*/i) || location;
  const address = location || venueName;

  const rawCost = extractParagraphWithPattern(cleanHtml, /fa-usd-circle|>\s*Cost\s*:/i) ||
    extractTextByClassOrder(cleanHtml, ['event-cost', 'cost', 'price']);
  const cost = stripFieldPrefix(rawCost, /^cost\s*:\s*/i);

  const rawTagText = extractTextByClassOrder(cleanHtml, [
    'events-detail-category',
    'tagged-as-list',
    'event-categories',
    'event-tags',
    'tags'
  ]);
  const tags = parseTagList(rawTagText);

  const organizer = extractClassedOrganizer(cleanHtml) || extractContactInfoOrganizer(cleanHtml, config);
  const coordinates = jsonLdCoords || extractDataCoordinates(cleanHtml);

  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(startDateTime ? { startDateTime } : {}),
    ...(endDateTime ? { endDateTime } : {}),
    ...(dateText ? { dateText } : {}),
    ...(timeText ? { timeText } : {}),
    ...(location ? { location } : {}),
    ...(venueName ? { venueName } : {}),
    ...(address ? { address } : {}),
    ...(cost ? { cost } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(organizer ? { organizer } : {}),
    ...(coordinates ? { coordinates } : {})
  };
}

function resolveCardOrganizer(card, defaultOrganizer) {
  if (card.organizer?.name) {
    if (defaultOrganizer?.name && card.organizer.name.toLowerCase() === defaultOrganizer.name.toLowerCase()) {
      return { ...defaultOrganizer };
    }
    return {
      name: card.organizer.name,
      ...(card.organizer.website ? { website: card.organizer.website } : {})
    };
  }
  if (defaultOrganizer && typeof defaultOrganizer === 'object') {
    return { ...defaultOrganizer };
  }
  return undefined;
}

function resolveCostString(explicitCost, tags, defaultCost = 'Free') {
  if (typeof explicitCost === 'string' && explicitCost.trim()) {
    return explicitCost.trim();
  }
  if (tags.some(tag => /^free$/i.test(tag))) return 'Free';
  if (tags.some(tag => /^ticketed$/i.test(tag))) return 'Ticketed';
  return defaultCost;
}

function buildScheduleStrings(card) {
  const normalizedTime = normalizeTimeRangeText(card.timeText);
  if (card.startDateTime) {
    const hasTimeInStart = /[T\s]\d{2}:\d{2}/.test(card.startDateTime);
    if (!hasTimeInStart && normalizedTime) {
      return {
        startTime: `${card.startDateTime}, ${normalizedTime}`,
        endTime: card.endDateTime || null
      };
    }

    let endTime = card.endDateTime || null;
    if (!endTime && normalizedTime) {
      const rangeParts = normalizedTime.split(/\s*(?:[-–—]|\bto\b)\s*/i).filter(Boolean);
      if (rangeParts.length >= 2) {
        endTime = rangeParts[rangeParts.length - 1];
      }
    }

    return {
      startTime: card.startDateTime,
      endTime
    };
  }

  const parts = [card.dateText, normalizedTime].filter(Boolean);
  return {
    startTime: parts.length > 0 ? parts.join(', ') : null,
    endTime: null
  };
}

function mapCardToRawActivity(card, config, scheduleTimes = null) {
  const tags = Array.isArray(card.tags) ? card.tags : [];
  const { category, subcategory } = resolveCouncilCategoryAndSubcategory(tags, card.title);
  const { startTime, endTime } = scheduleTimes || buildScheduleStrings(card);
  const organizer = resolveCardOrganizer(card, config.defaultOrganizer);
  const costStr = resolveCostString(card.cost, tags, config.defaultCost ?? 'Free');
  const url = card.url || config.endpoint;

  return {
    source: config.source,
    source_id: card.sourceId,
    source_url: url,
    external_url: url,
    region_id: config.regionId || 'perth',
    title: card.title,
    description: card.description || '',
    category,
    subcategory,
    ...(organizer ? { organizer } : {}),
    venue: {
      ...(card.venueName ? { name: card.venueName } : {}),
      ...(card.address ? { address: card.address } : {}),
      ...(card.coordinates ? { coordinates: card.coordinates } : {})
    },
    ...(card.venueName ? { venue_name: card.venueName } : {}),
    ...(card.address ? { address: card.address } : {}),
    ...(card.coordinates ? { coordinates: card.coordinates } : {}),
    start_time: startTime,
    ...(endTime ? { end_time: endTime } : {}),
    cost_description: costStr,
    display_price: costStr,
    is_free: determineIsFree(costStr),
    demographics: {
      gender: 'all',
      age: 'all'
    }
  };
}

function isMissingRequiredField(card, field) {
  if (field === 'dateWithYear') {
    return !card.startDateTime && !/\b20\d{2}\b/.test(card.dateText || '');
  }
  if (field === 'location') {
    return !card.location && !card.venueName && !card.address;
  }
  return !card[field];
}

function shouldHydrateDetail(card, hydrateDetail, requiredListingFields) {
  if (!card.url || hydrateDetail === 'never' || hydrateDetail === false) {
    return false;
  }
  if (hydrateDetail === 'always') {
    return true;
  }
  return requiredListingFields.some(field => isMissingRequiredField(card, field));
}

function createTimeoutSignal(explicitSignal, timeoutMs) {
  if (explicitSignal) return explicitSignal;
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
}

/**
 * Creates a config-driven OpenCities / semantic HTML crawler instance.
 *
 * @param {object} config
 * @param {object} [options={}]
 * @returns {object} Crawler instance
 */
export function createOpenCitiesHtmlCrawler(config, options = {}) {
  if (!config?.source || !config?.endpoint || !config?.baseUrl) {
    throw new Error('OpenCities HTML adapter requires source, endpoint, and baseUrl in config');
  }

  const fetchFn = options.fetchFn || globalThis.fetch;
  const timeoutMs = options.timeoutMs || config.timeoutMs || 15000;
  const maxPages = options.maxPages ?? config.maxPages ?? DEFAULT_MAX_PAGES;
  const maxItems = options.maxItems ?? config.maxItems ?? DEFAULT_MAX_ACTIVITIES;
  const pageDelayMs = options.pageDelayMs ?? config.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
  const detailDelayMs = options.detailDelayMs ?? config.detailDelayMs ?? DEFAULT_DETAIL_DELAY_MS;
  const delayFn = options.delayFn || sleepMs;
  const horizonDays = options.horizonDays ?? config.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const hydrateDetail = options.hydrateDetail ?? config.hydrateDetail ?? 'when_missing';
  const requiredListingFields = config.requiredListingFields || ['dateWithYear', 'location'];
  const minExpectedListings = typeof options.minExpectedListings === 'number'
    ? options.minExpectedListings
    : config.minExpectedListings;

  return {
    name: config.source,
    group: config.group || 'councils',
    ...(typeof minExpectedListings === 'number' ? { minExpectedListings } : {}),
    ...(config.fallbackCentroid ? { fallbackCentroid: config.fallbackCentroid } : {}),

    async fetchListings() {
      const headers = {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': config.userAgent || DEFAULT_USER_AGENT
      };

      const filterOptions = {
        now: options.now,
        horizonDays
      };

      const seenCardIds = new Set();
      let totalKept = 0;
      let nextRequest = { method: 'GET', url: config.endpoint };

      return paginateCouncilPages({
        maxPages,
        maxActivities: maxItems,
        pageDelayMs,
        delayFn,
        fetchPage: async (page) => {
          if (!nextRequest) {
            return { items: [], hasMore: false };
          }

          const signal = createTimeoutSignal(options.signal, timeoutMs);
          const reqHeaders = nextRequest.method === 'POST'
            ? { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }
            : headers;
          const response = await fetchFn(nextRequest.url, {
            method: nextRequest.method,
            headers: reqHeaders,
            ...(nextRequest.formBody ? { body: nextRequest.formBody.toString() } : {}),
            ...(signal ? { signal } : {})
          });

          if (!response.ok) {
            throw new Error(`${config.label || config.source} responded with HTTP ${response.status}: ${response.statusText}`);
          }

          const html = await response.text();
          const parsed = parseOpenCitiesListingPage(html, {
            ...config,
            currentUrl: nextRequest.url,
            page
          });

          const unseenCards = parsed.cards.filter(card => !seenCardIds.has(card.sourceId));
          for (const card of unseenCards) {
            seenCardIds.add(card.sourceId);
          }

          const mappedAndFiltered = [];
          for (const rawCard of unseenCards) {
            if (totalKept >= maxItems) break;

            const preFilterCandidate = {
              title: rawCard.title,
              category: (rawCard.tags || []).join(', '),
              venueName: rawCard.venueName || '',
              address: rawCard.address || ''
            };
            if (isCivicAdminNotice(preFilterCandidate) || isOnlineOnlyItem(preFilterCandidate)) {
              continue;
            }

            let card = rawCard;
            if (shouldHydrateDetail(card, hydrateDetail, requiredListingFields)) {
              if (detailDelayMs > 0) {
                await delayFn(detailDelayMs);
              }
              try {
                const detailSignal = createTimeoutSignal(options.signal, timeoutMs);
                const detailRes = await fetchFn(card.url, {
                  method: 'GET',
                  headers,
                  ...(detailSignal ? { signal: detailSignal } : {})
                });
                if (detailRes.ok) {
                  const detailHtml = await detailRes.text();
                  const detail = parseOpenCitiesDetailPage(detailHtml, {
                    ...config,
                    currentUrl: card.url
                  });
                  card = mergeCardData(card, detail);
                }
              } catch {
                // Keep listing card fields if detail hydration fails
              }
            }

            const { startTime, endTime } = buildScheduleStrings(card);
            const filterCandidate = {
              title: card.title,
              category: (card.tags || []).join(', '),
              venueName: card.venueName || '',
              address: card.address || '',
              start_time: startTime,
              ...(endTime ? { end_time: endTime } : {})
            };

            if (filterCouncilItem(filterCandidate, filterOptions)) {
              mappedAndFiltered.push(mapCardToRawActivity(card, config, { startTime, endTime }));
              totalKept += 1;
            }
          }

          nextRequest = parsed.nextRequest;
          return {
            items: mappedAndFiltered,
            hasMore: Boolean(parsed.hasMore && nextRequest && unseenCards.length > 0)
          };
        }
      });
    }
  };
}
