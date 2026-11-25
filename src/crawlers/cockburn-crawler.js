/**
 * City of Cockburn Activities Crawler
 * Bespoke zero-dependency Kentico (#eventslistingResultsFB) HTML crawler with
 * detail-page hydration, schedule/TTL normalization, and Cockburn Central venue fallback.
 */

import { determineIsFree, slugify } from '../sanitizer.js';
import {
  DEFAULT_HORIZON_DAYS,
  DEFAULT_MAX_ACTIVITIES,
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_DELAY_MS,
  deriveDeterministicCouncilSourceId,
  filterCouncilItem,
  isCivicAdminNotice,
  isOnlineOnlyItem,
  paginateCouncilPages,
  resolveCouncilCategoryAndSubcategory,
  sleepMs
} from './council-utils.js';
import { normalizeTimeRangeText } from './opencities-html-adapter.js';

export const COCKBURN_ENDPOINT = 'https://www.cockburn.wa.gov.au/City-and-Council/Events-and-News/Events-and-Workshops';
export const COCKBURN_BASE_URL = 'https://www.cockburn.wa.gov.au';
export const COCKBURN_LGA_CENTROID = Object.freeze({ lat: -32.1278, lng: 115.8569 });
export const DEFAULT_COCKBURN_PAGE_SIZE = 9;
export const DEFAULT_DETAIL_DELAY_MS = 300;

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot)';
const DIAGNOSTIC_HEADERS = ['server', 'cf-ray', 'retry-after'];

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

const DEPARTMENT_TAG_MAP = {
  arc: 'sports recreation fitness',
  health: 'health wellbeing',
  family: 'family kids',
  'cockburn-parenting': 'family parenting',
  environment: 'nature environment sustainability',
  culture: 'arts culture',
  art: 'arts culture music',
  youth: 'youth community',
  business: 'community',
  'cockburn-support-services': 'community',
  seniors: 'seniors community',
  libraries: 'community library',
  library: 'community library'
};

const MONTH_PREFIX_REGEX = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})$/i;
const SAME_MONTH_RANGE_REGEX = /\b(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b/gi;
const RECURRING_WEEKDAY_REGEX = /\b(every|weekly|fortnightly|sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?)\b/i;

export const COCKBURN_CONFIG = {
  source: 'cockburn',
  label: 'City of Cockburn',
  group: 'councils',
  localOnly: true,
  endpoint: COCKBURN_ENDPOINT,
  baseUrl: COCKBURN_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: COCKBURN_LGA_CENTROID,
  minExpectedListings: 1,
  pageSize: DEFAULT_COCKBURN_PAGE_SIZE,
  hydrateDetail: true,
  detailDelayMs: DEFAULT_DETAIL_DELAY_MS,
  defaultOrganizer: {
    id: 'org_city_of_cockburn',
    name: 'City of Cockburn',
    website: COCKBURN_BASE_URL
  }
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

function stripHtmlTags(html = '', { preserveBreaks = false } = {}) {
  if (!html || typeof html !== 'string') return '';
  const withSeparators = preserveBreaks
    ? html
        .replace(/<br\s*\/?>/gi, ', ')
        .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|article|section|header|footer)>/gi, ' ')
    : html
        .replace(/<(?:br|hr)\s*\/?>/gi, ' ')
        .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|article|section|header|footer|span|strong|em)>/gi, ' ');
  return decodeHtmlEntities(withSeparators.replace(/<[^>]+>/g, ''))
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/\s*,\s*,+/g, ', ')
    .replace(/^,\s*|,\s*$/g, '')
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

function formatDiagnosticHeaders(headers) {
  if (!headers) return '';
  const pairs = [];
  for (const name of DIAGNOSTIC_HEADERS) {
    const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
    if (typeof value === 'string' && value.trim()) {
      pairs.push(`${name}=${value.trim()}`);
    }
  }
  return pairs.join(', ');
}

function findBalancedTagEnd(html, tagName, contentStart) {
  const lowerTag = tagName.toLowerCase();
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

function extractElementById(html, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openRegex = new RegExp(`<([a-z0-9]+)\\b([^>]*\\bid\\s*=\\s*["']${escapedId}["'][^>]*)>`, 'i');
  const match = openRegex.exec(html);
  if (!match) return null;
  const tagName = match[1];
  const attrs = match[2];
  const contentStart = match.index + match[0].length;
  if (/\/\s*$/.test(attrs)) {
    return { tagName, attrs, innerHtml: '' };
  }
  const { innerEnd } = findBalancedTagEnd(html, tagName, contentStart);
  return { tagName, attrs, innerHtml: html.slice(contentStart, innerEnd) };
}

function extractElementsByClass(html, className) {
  const results = [];
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openRegex = new RegExp(`<([a-z0-9]+)\\b([^>]*\\bclass\\s*=\\s*["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*)>`, 'gi');
  let m;
  while ((m = openRegex.exec(html)) !== null) {
    const tagName = m[1];
    const attrs = m[2];
    const contentStart = m.index + m[0].length;
    if (/\/\s*$/.test(attrs)) continue;
    const { innerEnd } = findBalancedTagEnd(html, tagName, contentStart);
    results.push({
      tagName: tagName.toLowerCase(),
      attrs,
      innerHtml: html.slice(contentStart, innerEnd)
    });
  }
  return results;
}

function extractIconRowText(cardHtml, iconClass) {
  const escaped = iconClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `<i\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>\\s*<\\/i>\\s*<\\/span>\\s*<span\\b[^>]*>([\\s\\S]*?)<\\/span>`,
    'i'
  );
  const match = cardHtml.match(regex);
  return match ? stripHtmlTags(match[1]) : '';
}

function extractInfoRowText(cardHtml) {
  const infoBlock = extractElementsByClass(cardHtml, 'eventlandingreText')[0];
  if (!infoBlock) return '';
  const spans = [...infoBlock.innerHtml.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)];
  const lastSpan = spans[spans.length - 1];
  return lastSpan ? stripHtmlTags(lastSpan[1]) : '';
}

function extractDepartmentTagFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const { pathname } = new URL(url);
    const match = pathname.match(/\/Events-and-Workshops\/([^/]+)\//i);
    if (!match) return '';
    const rawSegment = decodeURIComponent(match[1]).trim().toLowerCase();
    return DEPARTMENT_TAG_MAP[rawSegment] || rawSegment.replace(/[-_]+/g, ' ');
  } catch {
    return '';
  }
}

function deriveCockburnSourceId(url, title, dateText) {
  if (url && typeof url === 'string') {
    try {
      const { pathname } = new URL(url);
      const stripped = pathname
        .replace(/^\/(?:City-and-Council\/Events-and-News|About-Cockburn)\/Events-and-Workshops\/?/i, '')
        .replace(/^\/+|\/+$/g, '');
      const slug = slugify(stripped);
      if (slug) return slug;
    } catch {
      // Fall through to shared council helper
    }
  }
  return deriveDeterministicCouncilSourceId({ url, title, startTime: dateText });
}

function parseCardBadge(cardHtml) {
  const bottomMatch = cardHtml.match(/bottom\s*:\s*0px[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i) ||
    cardHtml.match(/white-space\s*:\s*nowrap[^>]*>([\s\S]*?)<\/span>/i);
  if (!bottomMatch) return '';
  return stripHtmlTags(bottomMatch[1]);
}

function parsePaginationHasMore(resultsHtml, cardsLength, totalRecords, config) {
  const paginationEl = extractElementById(resultsHtml, 'pagination');
  if (paginationEl) {
    const nextMatch = paginationEl.innerHtml.match(/<li\b([^>]*)>\s*<a\b[^>]*\bclass\s*=\s*["'][^"']*\bnext\b[^"']*["']/i);
    if (nextMatch) {
      const liAttrs = nextMatch[1] || '';
      const isDisabled = /\buk-disabled\b/i.test(liAttrs);
      if (!isDisabled) {
        return true;
      }
      return false;
    }
  }

  const page = Number(config.page || 1);
  const pageSize = Number(config.pageSize || DEFAULT_COCKBURN_PAGE_SIZE);
  if (typeof totalRecords === 'number' && cardsLength > 0) {
    return page * pageSize < totalRecords;
  }
  return false;
}

/**
 * Parses Cockburn's `#eventslistingResultsFB` listing page HTML into normalized card records.
 *
 * @param {string} html
 * @param {object} [config={}]
 * @returns {{ cards: Array<object>, totalRecords: number | null, hasMore: boolean }}
 */
export function parseCockburnListingPage(html = '', config = {}) {
  const cleanHtml = stripNonContentHtml(html);
  const container = extractElementById(cleanHtml, 'eventslistingResultsFB');
  const scopeHtml = container ? container.innerHtml : cleanHtml;

  const recordCountInput = scopeHtml.match(/<input\b[^>]*\bid\s*=\s*["']recordCountValue["'][^>]*>/i);
  const rawRecordCount = recordCountInput ? extractAttr(recordCountInput[0], 'value') : null;
  const parsedCount = rawRecordCount !== null && rawRecordCount !== '' ? Number.parseInt(rawRecordCount, 10) : NaN;
  const totalRecords = Number.isFinite(parsedCount) ? parsedCount : null;

  const cardBlocks = extractElementsByClass(scopeHtml, 'landingpage-item');
  const byId = new Map();

  for (const block of cardBlocks) {
    const anchorMatch = block.innerHtml.match(/<a\b([^>]*)>/i);
    const rawHref = anchorMatch ? extractAttr(anchorMatch[1], 'href') : null;
    const url = resolveUrl(config.baseUrl || COCKBURN_BASE_URL, rawHref, config.currentUrl);
    if (!url) continue;

    const titleMatch = block.innerHtml.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? stripHtmlTags(titleMatch[1]) : '';
    if (!title) continue;

    const venueName = extractIconRowText(block.innerHtml, 'uk-icon-map-marker');
    const timeText = extractIconRowText(block.innerHtml, 'uk-icon-clock-o');
    const dateText = extractIconRowText(block.innerHtml, 'uk-icon-calendar');
    const infoText = extractInfoRowText(block.innerHtml);
    const badgeText = parseCardBadge(block.innerHtml);
    const departmentTag = extractDepartmentTagFromUrl(url);
    const sourceId = deriveCockburnSourceId(url, title, dateText);

    if (!byId.has(sourceId)) {
      byId.set(sourceId, {
        sourceId,
        title,
        url,
        venueName,
        timeText,
        dateText,
        infoText,
        badgeText,
        departmentTag
      });
    }
  }

  const cards = [...byId.values()];
  return {
    cards,
    totalRecords,
    hasMore: parsePaginationHasMore(scopeHtml, cards.length, totalRecords, config)
  };
}

function extractAboutDescription(cleanHtml) {
  const aboutMatch = cleanHtml.match(
    /<h2\b[^>]*>\s*About the event\s*<\/h2>([\s\S]*?)(?=<div\b[^>]*data-uk-accordion|<div\b[^>]*\bclass\s*=\s*["'][^"']*\beventsdetail\s+information\b|<h2\b|$)/i
  );
  if (!aboutMatch) return '';
  return stripHtmlTags(aboutMatch[1]);
}

function extractPriceAccordion(cleanHtml) {
  const accordions = extractElementsByClass(cleanHtml, 'uk-accordion');
  for (const acc of accordions) {
    const titleEl = extractElementsByClass(acc.innerHtml, 'uk-accordion-title')[0];
    if (!titleEl) continue;
    const headingText = stripHtmlTags(titleEl.innerHtml).replace(/\s*(?:Expand|Collapse)\s*$/i, '').trim();
    if (!/^price$/i.test(headingText)) continue;
    const contentEl = extractElementsByClass(acc.innerHtml, 'uk-accordion-content')[0];
    if (!contentEl) continue;
    return stripHtmlTags(contentEl.innerHtml);
  }
  return '';
}

function extractDetailLocation(cleanHtml, addToCalAddress = '') {
  const locationEl = extractElementsByClass(cleanHtml, 'location')[0];
  let venueName = '';
  let address = '';

  if (locationEl) {
    const h2Match = locationEl.innerHtml.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    if (h2Match) {
      venueName = stripHtmlTags(h2Match[1]);
    }
    for (const pMatch of locationEl.innerHtml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
      const pAttrs = pMatch[1] || '';
      const cls = extractAttr(pAttrs, 'class') || '';
      if (/\bmapdetail\b/i.test(cls)) continue;
      const candidate = stripHtmlTags(pMatch[2], { preserveBreaks: true });
      if (candidate) {
        address = candidate;
        break;
      }
    }
  }

  if (!address && addToCalAddress) {
    address = addToCalAddress;
  }
  if (!venueName && addToCalAddress) {
    venueName = addToCalAddress.split(',')[0].trim();
  }

  return { venueName, address };
}

function extractCockburnOrganizer(cleanHtml, config) {
  const contactEl = extractElementsByClass(cleanHtml, 'eventsdetail-contact')[0];
  if (!contactEl) return null;

  let contactTitle = '';
  let email = '';
  let website = '';

  for (const pMatch of contactEl.innerHtml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    const pAttrs = pMatch[1] || '';
    const pInner = pMatch[2] || '';
    const cls = extractAttr(pAttrs, 'class') || '';

    if (/\bicon-email\b/i.test(cls)) {
      const mailtoMatch = pInner.match(/href\s*=\s*["']mailto:([^"']+)["']/i);
      if (mailtoMatch) {
        email = decodeHtmlEntities(mailtoMatch[1]).trim();
      }
      continue;
    }

    if (/\bicon-phone\b/i.test(cls)) {
      continue;
    }

    const linkMatch = pInner.match(/<a\b[^>]*href\s*=\s*["'](https?:\/\/[^"']+)["']/i);
    if (linkMatch) {
      website = decodeHtmlEntities(linkMatch[1]).trim();
    }

    if (!contactTitle) {
      const cleaned = stripHtmlTags(pInner.replace(/<span\b[^>]*\bsr-only\b[^>]*>[\s\S]*?<\/span>/gi, ''));
      if (cleaned && !/^(?:email|phone|tel|website)\s*:/i.test(cleaned)) {
        contactTitle = cleaned;
      }
    }
  }

  if (!contactTitle || /cockburn/i.test(contactTitle)) {
    return null;
  }
  if (email && /@cockburn\.wa\.gov\.au$/i.test(email)) {
    return null;
  }
  if (website && /(?:^|\.)cockburn\.wa\.gov\.au$/i.test(new URL(website).hostname)) {
    return null;
  }
  if (!email && !website) {
    return null;
  }

  return {
    name: contactTitle,
    ...(website ? { website } : {})
  };
}

/**
 * Parses a Cockburn event detail page into supplemental Activity fields.
 * Intentionally ignores `#addtocalendar` `data-starttime`/`data-endtime` because
 * Cockburn's CMS emits 12-hour strings for PM end times (e.g. `06:45` for `6-6:45pm`).
 *
 * @param {string} html
 * @param {object} [config={}]
 * @returns {object}
 */
export function parseCockburnDetailPage(html = '', config = {}) {
  if (typeof html !== 'string' || !html.trim()) return {};
  const cleanHtml = stripNonContentHtml(html);

  const addToCalMatch = cleanHtml.match(/<div\b([^>]*\bid\s*=\s*["']addtocalendar["'][^>]*)>/i);
  const addToCalAttrs = addToCalMatch ? addToCalMatch[1] : '';
  const addToCalStartDate = addToCalAttrs ? (extractAttr(addToCalAttrs, 'data-startdate') || '') : '';
  const addToCalEndDate = addToCalAttrs ? (extractAttr(addToCalAttrs, 'data-enddate') || '') : '';
  const addToCalAddress = addToCalAttrs ? (extractAttr(addToCalAttrs, 'data-add') || '') : '';

  const summaryEl = extractElementsByClass(cleanHtml, 'eventsummarydetail')[0];
  const summaryHtml = summaryEl ? summaryEl.innerHtml : '';
  const timeMatch = summaryHtml.match(/<span\b[^>]*\bclock\b[^>]*>([\s\S]*?)<\/span>/i);
  const dateMatch = summaryHtml.match(/<span\b[^>]*\bcalendar\b[^>]*>([\s\S]*?)<\/span>/i);
  const infoMatch = summaryHtml.match(/<span\b[^>]*\binformation\b[^>]*>([\s\S]*?)<\/span>/i);

  const timeText = timeMatch ? stripHtmlTags(timeMatch[1]) : '';
  const dateText = dateMatch ? stripHtmlTags(dateMatch[1]) : '';
  const infoText = infoMatch ? stripHtmlTags(infoMatch[1]) : '';

  const description = extractAboutDescription(cleanHtml);
  const cost = extractPriceAccordion(cleanHtml);
  const { venueName, address } = extractDetailLocation(cleanHtml, addToCalAddress);
  const organizer = extractCockburnOrganizer(cleanHtml, config);

  return {
    ...(description ? { description } : {}),
    ...(cost ? { cost } : {}),
    ...(venueName ? { venueName } : {}),
    ...(address ? { address } : {}),
    ...(timeText ? { timeText } : {}),
    ...(dateText ? { dateText } : {}),
    ...(infoText ? { infoText } : {}),
    ...(addToCalStartDate ? { addToCalStartDate } : {}),
    ...(addToCalEndDate ? { addToCalEndDate } : {}),
    ...(organizer ? { organizer } : {})
  };
}

function normalizeMonthFirstDate(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(MONTH_PREFIX_REGEX);
  if (match) {
    return `${match[2]} ${match[1]} ${match[3]}`;
  }
  return trimmed;
}

function normalizeCockburnDateText(raw = '') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(
    SAME_MONTH_RANGE_REGEX,
    (_, startDay, endDay, month, year) => `${startDay} ${month} ${year} - ${endDay} ${month} ${year}`
  );
}

/**
 * Normalizes Cockburn clock expressions (`6-6:45pm`, `10am-Midday`, `Midday-2pm`, `5.30pm- 7.30pm`).
 *
 * @param {string} [rawTime='']
 * @returns {string}
 */
export function normalizeCockburnTimeText(rawTime = '') {
  if (!rawTime || typeof rawTime !== 'string') return '';
  const trimmed = rawTime.trim();
  if (!trimmed || /^(?:various(?:\s+times)?|morning\s*&\s*evening\s+sessions|tba)$/i.test(trimmed)) {
    return '';
  }
  const withMeridiemWords = trimmed
    .replace(/\b(?:midday|noon)\b/gi, '12pm')
    .replace(/\bmidnight\b/gi, '12am');
  return normalizeTimeRangeText(withMeridiemWords);
}

/**
 * Builds `start_time`, optional `end_date`, and `recurrence` aligned with `parseSchedule()`
 * and `computeActivityExpireAt()` so finite date-ranged series expire cleanly while
 * undated weekly programs persist with `recurrence: 'weekly'`.
 *
 * @param {object} card
 * @returns {{ startTime: string | null, endDate: string | null, recurrence: 'none' | 'weekly' }}
 */
export function buildCockburnSchedule(card = {}) {
  const normalizedClock = normalizeCockburnTimeText(card.timeText);
  const startCal = normalizeMonthFirstDate(card.addToCalStartDate);
  const endCal = normalizeMonthFirstDate(card.addToCalEndDate);
  const normalizedDateText = normalizeCockburnDateText(card.dateText);

  const hasExplicitDate = Boolean(startCal || normalizedDateText);
  if (hasExplicitDate) {
    let dateExpr = normalizedDateText;
    if (startCal) {
      dateExpr = endCal && endCal !== startCal ? `${startCal} - ${endCal}` : startCal;
    }
    const startTime = [dateExpr, normalizedClock].filter(Boolean).join(', ') || null;
    return {
      startTime,
      endDate: null,
      recurrence: 'none'
    };
  }

  const infoText = String(card.infoText || '').trim();
  if (infoText && RECURRING_WEEKDAY_REGEX.test(infoText)) {
    return {
      startTime: [infoText, normalizedClock].filter(Boolean).join(', ') || null,
      endDate: null,
      recurrence: 'weekly'
    };
  }

  return {
    startTime: normalizedClock || null,
    endDate: null,
    recurrence: 'none'
  };
}

function buildCockburnDescription(card) {
  const baseDesc = String(card.description || '').trim();
  const infoText = String(card.infoText || '').trim();
  if (!infoText) return baseDesc;
  if (!baseDesc) return infoText;
  if (baseDesc.toLowerCase().includes(infoText.toLowerCase())) {
    return baseDesc;
  }
  return `${infoText}\n\n${baseDesc}`;
}

function resolveCockburnCost(card) {
  if (typeof card.cost === 'string' && card.cost.trim()) {
    return card.cost.trim();
  }
  if (typeof card.badgeText === 'string' && /^free$/i.test(card.badgeText.trim())) {
    return 'Free';
  }
  return '';
}

function mergeCockburnCardWithDetail(card, detail) {
  if (!detail || typeof detail !== 'object') return card;

  const isGenericCardVenue = /^(?:locations?|various(?:\s+locations?)?|tbc|tba)$/i.test(String(card.venueName || '').trim());
  const resolvedVenueName = (!isGenericCardVenue && card.venueName) || detail.venueName || card.venueName || '';

  return {
    ...card,
    description: detail.description || card.description || '',
    cost: detail.cost || card.cost || '',
    venueName: resolvedVenueName,
    address: detail.address || card.address || resolvedVenueName || '',
    timeText: detail.timeText || card.timeText || '',
    dateText: card.dateText || detail.dateText || '',
    infoText: card.infoText || detail.infoText || '',
    addToCalStartDate: detail.addToCalStartDate || '',
    addToCalEndDate: detail.addToCalEndDate || '',
    organizer: detail.organizer || card.organizer || null
  };
}

function mapCockburnCardToRawActivity(card, config) {
  const tags = [card.departmentTag].filter(Boolean);
  const { category, subcategory } = resolveCouncilCategoryAndSubcategory(tags, card.title);
  const { startTime, endDate, recurrence } = buildCockburnSchedule(card);
  const organizer = card.organizer?.name
    ? card.organizer
    : (config.defaultOrganizer ? { ...config.defaultOrganizer } : undefined);
  const costStr = resolveCockburnCost(card);
  const venueName = (card.venueName || '').trim();
  const address = (card.address || venueName || '').trim();

  return {
    source: config.source,
    source_id: card.sourceId,
    source_url: card.url,
    external_url: card.url,
    region_id: config.regionId || 'perth',
    title: card.title,
    description: buildCockburnDescription(card),
    category,
    subcategory,
    ...(organizer ? { organizer } : {}),
    venue: {
      ...(venueName ? { name: venueName } : {}),
      ...(address ? { address } : {})
    },
    ...(venueName ? { venue_name: venueName } : {}),
    ...(address ? { address } : {}),
    start_time: startTime,
    ...(endDate ? { end_date: endDate } : {}),
    recurrence,
    cost_description: costStr,
    display_price: costStr,
    is_free: costStr ? determineIsFree(costStr) : false,
    demographics: {
      gender: 'all',
      age: 'all'
    }
  };
}

function buildCockburnPageUrl(endpoint, page) {
  if (page <= 1) return endpoint;
  const url = new URL(endpoint);
  url.searchParams.set('page', String(page));
  return url.toString();
}

function createTimeoutSignal(explicitSignal, timeoutMs) {
  if (explicitSignal) return explicitSignal;
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
}

/**
 * Creates a City of Cockburn Kentico crawler instance.
 *
 * @param {object} [options={}]
 * @returns {object} Crawler instance
 */
export function createCockburnCrawler(options = {}) {
  const config = COCKBURN_CONFIG;
  const fetchFn = options.fetchFn || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 15000;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ACTIVITIES;
  const pageDelayMs = options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
  const detailDelayMs = options.detailDelayMs ?? config.detailDelayMs ?? DEFAULT_DETAIL_DELAY_MS;
  const delayFn = options.delayFn || sleepMs;
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const hydrateDetail = options.hydrateDetail ?? config.hydrateDetail ?? true;
  const minExpectedListings = typeof options.minExpectedListings === 'number'
    ? options.minExpectedListings
    : config.minExpectedListings;

  return {
    name: config.source,
    group: config.group,
    localOnly: Boolean(config.localOnly),
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

      const seenIds = new Set();
      let totalKept = 0;

      return paginateCouncilPages({
        maxPages,
        maxActivities: maxItems,
        pageDelayMs,
        delayFn,
        fetchPage: async (page) => {
          const pageUrl = buildCockburnPageUrl(config.endpoint, page);
          const signal = createTimeoutSignal(options.signal, timeoutMs);

          const response = await fetchFn(pageUrl, {
            method: 'GET',
            headers,
            ...(signal ? { signal } : {})
          });

          if (!response.ok) {
            const diagHeaders = formatDiagnosticHeaders(response.headers);
            const detail = [pageUrl, diagHeaders].filter(Boolean).join(', ');
            throw new Error(
              `${config.label} responded with HTTP ${response.status}: ${response.statusText} (${detail})`
            );
          }

          const html = await response.text();
          const parsed = parseCockburnListingPage(html, {
            ...config,
            currentUrl: pageUrl,
            page
          });

          const unseenCards = parsed.cards.filter(card => !seenIds.has(card.sourceId));
          for (const card of unseenCards) {
            seenIds.add(card.sourceId);
          }

          const mappedAndFiltered = [];
          for (const rawCard of unseenCards) {
            if (totalKept >= maxItems) break;

            const preSchedule = buildCockburnSchedule(rawCard);
            const preFilterCandidate = {
              title: rawCard.title,
              category: rawCard.departmentTag || '',
              venueName: rawCard.venueName || '',
              address: rawCard.venueName || '',
              start_time: preSchedule.startTime,
              recurrence: preSchedule.recurrence
            };

            if (isCivicAdminNotice(preFilterCandidate) || isOnlineOnlyItem(preFilterCandidate)) {
              continue;
            }
            if (rawCard.dateText && !filterCouncilItem(preFilterCandidate, filterOptions)) {
              continue;
            }

            let card = rawCard;
            if (hydrateDetail && card.url) {
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
                  const detail = parseCockburnDetailPage(detailHtml, {
                    ...config,
                    currentUrl: card.url
                  });
                  card = mergeCockburnCardWithDetail(card, detail);
                }
              } catch {
                // Keep listing card fields if detail hydration fails
              }
            }

            const finalSchedule = buildCockburnSchedule(card);
            const filterCandidate = {
              title: card.title,
              category: card.departmentTag || '',
              venueName: card.venueName || '',
              address: card.address || card.venueName || '',
              start_time: finalSchedule.startTime,
              recurrence: finalSchedule.recurrence
            };

            if (filterCouncilItem(filterCandidate, filterOptions)) {
              mappedAndFiltered.push(mapCockburnCardToRawActivity(card, config));
              totalKept += 1;
            }
          }

          return {
            items: mappedAndFiltered,
            hasMore: Boolean(parsed.hasMore && unseenCards.length > 0)
          };
        }
      });
    }
  };
}
