/**
 * Shared Zero-Dependency Crawler HTML & Time Parsing Utilities
 * Reusable helpers for semantic HTML council adapters (OpenCities, AgencyWeb, etc.).
 */

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

/**
 * Decodes numeric (decimal/hex) and common named HTML entities.
 *
 * @param {string} [str='']
 * @returns {string}
 */
export function decodeHtmlEntities(str = '') {
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

/**
 * Strips HTML comments, `<script>`, and `<style>` blocks prior to parsing.
 *
 * @param {string} [html='']
 * @returns {string}
 */
export function stripNonContentHtml(html = '') {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
}

/**
 * Strips HTML tags, preserves spacing across block/break boundaries, and decodes entities.
 *
 * @param {string} [html='']
 * @returns {string}
 */
export function stripHtmlTags(html = '') {
  if (!html || typeof html !== 'string') return '';
  const withSpaces = html
    .replace(/<(?:br|hr)\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|article|section|header|footer|span|strong|em)>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(withSpaces)
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

/**
 * Extracts and decodes an attribute value from an HTML tag attribute string.
 *
 * @param {string} [attrString='']
 * @param {string} [attrName='']
 * @returns {string | null}
 */
export function extractAttr(attrString = '', attrName = '') {
  if (!attrString || !attrName) return null;
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\\`]+))`, 'i');
  const match = attrString.match(regex);
  if (!match) return null;
  return decodeHtmlEntities((match[1] ?? match[2] ?? match[3] ?? '').trim());
}

/**
 * Finds the balanced closing tag offsets for an element starting at `contentStart`.
 *
 * @param {string} html
 * @param {string} tagName
 * @param {number} contentStart
 * @returns {{ innerEnd: number, outerEnd: number }}
 */
export function findBalancedTagEnd(html, tagName, contentStart) {
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

/**
 * Checks whether a space-delimited `class` attribute contains any target class token.
 *
 * @param {string} [classAttr='']
 * @param {string | Array<string> | Set<string>} targets
 * @returns {boolean}
 */
export function hasClassToken(classAttr = '', targets) {
  if (!classAttr) return false;
  const targetSet = targets instanceof Set
    ? targets
    : new Set((Array.isArray(targets) ? targets : [targets]).map(t => String(t).toLowerCase()));
  return classAttr
    .toLowerCase()
    .split(/\s+/)
    .some(token => token && targetSet.has(token));
}

/**
 * Finds the first non-void HTML element matching any of `classNames` with balanced inner HTML.
 *
 * @param {string} html
 * @param {string | Array<string>} classNames
 * @returns {{ tagName: string, attrs: string, innerHtml: string } | null}
 */
export function extractFirstElementByClass(html, classNames) {
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

/**
 * Extracts plain text from the first non-empty element matching `classOrder` in priority order.
 *
 * @param {string} html
 * @param {Array<string>} classOrder
 * @returns {string}
 */
export function extractTextByClassOrder(html, classOrder) {
  for (const className of classOrder) {
    const found = extractFirstElementByClass(html, className);
    if (found) {
      const text = stripHtmlTags(found.innerHtml);
      if (text) return text;
    }
  }
  return '';
}

/**
 * Resolves a relative or absolute href against `currentUrl` or `baseUrl`, rejecting non-navigable links.
 *
 * @param {string} baseUrl
 * @param {string} href
 * @param {string | null} [currentUrl=null]
 * @returns {string | null}
 */
export function resolveUrl(baseUrl, href, currentUrl = null) {
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
