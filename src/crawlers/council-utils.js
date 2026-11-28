/**
 * Shared Council Crawler Utilities
 * Provides adapter-level noise filtering (civic/admin notices, online-only items, Expired Activities),
 * 90-day horizon cutoff, 9-category taxonomy mapping, and polite capped pagination.
 */

import {
  computeActivityExpireAt,
  normalizeCategory,
  normalizeSport,
  parseSchedule,
  resolveActivitySubcategory,
  slugify
} from '../sanitizer.js';

export const DEFAULT_MAX_PAGES = 20;
export const DEFAULT_MAX_ACTIVITIES = 200;
export const DEFAULT_HORIZON_DAYS = 90;
export const DEFAULT_PAGE_DELAY_MS = 1200;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_BASE_DELAY_MS = 2000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 150000;
export const DEFAULT_RETRY_JITTER_MS = 1000;
export const RETRYABLE_HTTP_STATUS_CODES = new Set([429, 502, 503, 504]);

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const CIVIC_ADMIN_PATTERNS = [
  /\b(?:ordinary|special|annual|committee|council|electors(?:'|’)?)\s+(?:(?:and|&)\s+(?:committee|council)\s+)?(?:council\s+)?meetings?\b/i,
  /\bagenda\s+(?:and|&)\s+minutes\b/i,
  /\bpublic\s+consultation\b/i,
  /\bhave\s+your\s+say\b/i,
  /\bpublic\s+comment\s+period\b/i,
  /\broadworks?\b/i,
  /\broad\s+closure\b/i,
  /\btraffic\s+(?:management|disruption|detour)\b/i,
  /\b(?:verge|kerbside|bin|rubbish|green\s+waste)\s+(?:collection|pickup|schedule)\b/i,
  /\brates\s+(?:notice|instalment|due)\b/i
];

const ONLINE_ONLY_TITLE_PATTERNS = [
  /\bonline[\s-]+only\b/i,
  /\bvirtual\s+(?:event|session|talk|workshop|meeting)\b/i,
  /\bwebinar\b/i
];

const ONLINE_VENUE_PATTERNS = [
  /^\s*(?:online|virtual|zoom|microsoft\s+teams|teams|webinar|livestream)\s*$/i,
  /\b(?:via\s+zoom|zoom\s+meeting|online\s+via|microsoft\s+teams)\b/i
];

const COUNCIL_CATEGORY_RULES = [
  { category: 'sports', patterns: [/\bmartial\s+arts?\b/i, /\bsports?\b/i, /\brecreation\b/i, /\bfitness\b/i, /\bswimming\b/i, /\bvolleyball\b/i, /\btriathlon\b/i, /\bsurf\b/i, /\btennis\b/i, /\bsoccer\b/i, /\bbasketball\b/i, /\bcricket\b/i, /\bgym\b/i, /\brunning\b/i, /\bcycling\b/i] },
  { category: 'health', patterns: [/\bhealth\b/i, /\bwellbeing\b/i, /\bwellness\b/i, /\byoga\b/i, /\bpilates\b/i, /\bmindfulness\b/i, /\bmeditation\b/i, /\bmental\s+health\b/i, /\bblood\s+donor\b/i] },
  { category: 'arts', patterns: [/\barts?\b/i, /\bcultur(?:e|al)\b/i, /\bexhibitions?\b/i, /\bgallery\b/i, /\btheatre\b/i, /\btheater\b/i, /\bdance\b/i, /\bperforming\b/i, /\bfilm\b/i, /\bcinema\b/i, /\bcomedy\b/i, /\bsculpture\b/i, /\bpoetry\b/i, /\bliterature\b/i] },
  { category: 'music', patterns: [/\bmusic\b/i, /\bconcerts?\b/i, /\bband\b/i, /\bchoir\b/i, /\bjazz\b/i, /\bsymphony\b/i, /\borchestra\b/i, /\bacoustic\b/i] },
  { category: 'family', patterns: [/\bfamil(?:y|ies)\b/i, /\bkids?\b/i, /\bchildren(?:'?s)?\b/i, /\bschool\s+holiday/i, /\btoddler\b/i, /\bstory\s*time\b/i, /\brhyme\s*time\b/i, /\bplaygroup\b/i, /\byouth\b/i, /\bparenting\b/i] },
  { category: 'food', patterns: [/\bfood\b/i, /\bdrink\b/i, /\bmarkets?\b/i, /\bcooking\b/i, /\bculinary\b/i, /\btasting\b/i, /\bpicnic\b/i, /\bfarmers\b/i, /\bcoffee\b/i] },
  { category: 'hobbies', patterns: [/\bhobb(?:y|ies)\b/i, /\bcrafts?\b/i, /\bgardening\b/i, /\bcompost/i, /\bsewing\b/i, /\bknitting\b/i, /\bphotography\b/i, /\bwoodwork\b/i, /\bpainting\b/i, /\bpottery\b/i, /\bspecial\s+interest\b/i, /\bworkshops?\b/i] },
  { category: 'travel', patterns: [/\btravel\b/i, /\boutdoors?\b/i, /\bnature\b/i, /\bguided\s+walk\b/i, /\btours?\b/i, /\bhiking\b/i, /\bbushwalk/i, /\btrail\b/i, /\bwildlife\b/i, /\bbirdwatch/i] },
  { category: 'community', patterns: [/\bcommunity\b/i, /\bseniors?\b/i, /\bvolunteer/i, /\blibrary\b/i, /\bmulticultural\b/i, /\bcharity\b/i, /\bclub\b/i, /\bsocial\b/i, /\bneighbour/i, /\bcivic\b/i, /\bfestivals?\b/i] }
];

function resolveNowDate(now) {
  if (typeof now === 'function') return new Date(now());
  if (now instanceof Date) return now;
  if (typeof now === 'string' || typeof now === 'number') return new Date(now);
  return new Date();
}

/**
 * Detects civic/administrative notices (council meetings, consultations, roadworks, bin/waste notices).
 *
 * @param {object} item
 * @returns {boolean}
 */
export function isCivicAdminNotice(item = {}) {
  const title = String(item.title || item.ArticleTitle || '');
  const category = String(item.category || item.ArticleCategories || '');
  const haystacks = [title, category].filter(Boolean);

  return haystacks.some(text => CIVIC_ADMIN_PATTERNS.some(pattern => pattern.test(text)));
}

/**
 * Detects online-only / virtual items that lack a physical in-person Venue.
 *
 * @param {object} item
 * @returns {boolean}
 */
export function isOnlineOnlyItem(item = {}) {
  const title = String(item.title || item.ArticleTitle || '');
  const venueName = String(item.venueName || item.venue_name || item.venue?.name || item.ArticleAddressTitle || '').trim();
  const address = String(item.address || item.venue?.address || '').trim();

  if (item.isOnline === true && !venueName && !address) {
    return true;
  }

  if (ONLINE_ONLY_TITLE_PATTERNS.some(pattern => pattern.test(title))) {
    return true;
  }

  const locationFields = [venueName, address].filter(Boolean);
  if (locationFields.length > 0 && locationFields.every(loc => ONLINE_VENUE_PATTERNS.some(p => p.test(loc)))) {
    return true;
  }

  return false;
}

/**
 * Checks whether a council item is already expired in AWST (past its 24h retention grace window).
 *
 * @param {object} item
 * @param {object} [options]
 * @param {Date | string | number | (() => Date)} [options.now]
 * @returns {boolean}
 */
export function isExpiredCouncilItem(item = {}, options = {}) {
  const nowDate = resolveNowDate(options.now);
  const schedule = parseSchedule(item, nowDate.toISOString());
  const expireAt = computeActivityExpireAt(schedule);
  if (!expireAt) {
    return false;
  }
  return nowDate.getTime() >= expireAt.getTime();
}

/**
 * Checks whether a council item starts within the configured future horizon (default 90 days).
 * Items without a parseable start date are kept so undated listings aren't dropped silently.
 *
 * @param {object} item
 * @param {object} [options]
 * @param {Date | string | number | (() => Date)} [options.now]
 * @param {number} [options.horizonDays=90]
 * @returns {boolean}
 */
export function isWithinHorizon(item = {}, options = {}) {
  const nowDate = resolveNowDate(options.now);
  const horizonDays = typeof options.horizonDays === 'number' ? options.horizonDays : DEFAULT_HORIZON_DAYS;
  const schedule = parseSchedule(item, nowDate.toISOString());
  if (!schedule.start_date) {
    return true;
  }

  const startMs = Date.parse(`${schedule.start_date}T00:00:00+08:00`);
  if (Number.isNaN(startMs)) {
    return true;
  }

  const cutoffMs = nowDate.getTime() + horizonDays * ONE_DAY_MS;
  return startMs <= cutoffMs;
}

/**
 * Combined adapter-level filter for council items before sanitization.
 *
 * @param {object} item
 * @param {object} [options]
 * @returns {boolean} True if the item should be kept
 */
export function filterCouncilItem(item = {}, options = {}) {
  if (isCivicAdminNotice(item)) return false;
  if (isOnlineOnlyItem(item)) return false;
  if (isExpiredCouncilItem(item, options)) return false;
  if (!isWithinHorizon(item, options)) return false;
  return true;
}

/**
 * Maps council category tags (and optional title fallback) into one of the 9 canonical categories.
 * Defaults to `'community'` for unrecognized council tags rather than `'sports'`.
 *
 * @param {string | Array<string>} [rawTags='']
 * @param {string} [title='']
 * @returns {string}
 */
export function mapCouncilCategory(rawTags = '', title = '') {
  const tagsList = Array.isArray(rawTags)
    ? rawTags
    : String(rawTags || '').split(/[,;|/]+/).map(s => s.trim()).filter(Boolean);

  for (const candidate of [...tagsList, String(title || '').trim()].filter(Boolean)) {
    for (const rule of COUNCIL_CATEGORY_RULES) {
      if (rule.patterns.some(pattern => pattern.test(candidate))) {
        return rule.category;
      }
    }
    const sanitized = normalizeCategory(candidate, { defaultCategory: null });
    if (sanitized) {
      return sanitized;
    }
  }

  return 'community';
}

/**
 * Resolves canonical category and subcategory from council tags and title.
 *
 * @param {string | Array<string>} [rawTags='']
 * @param {string} [title='']
 * @returns {{ category: string, subcategory: string }}
 */
export function resolveCouncilCategoryAndSubcategory(rawTags = '', title = '') {
  const category = mapCouncilCategory(rawTags, title);
  const rawSubcategoryInput = Array.isArray(rawTags) ? rawTags.join(' ') : String(rawTags || '');
  const matchedSport = normalizeSport(rawSubcategoryInput || title);
  const subcategory = resolveActivitySubcategory(matchedSport !== 'other' ? matchedSport : rawSubcategoryInput, category);
  return { category, subcategory };
}

/**
 * Default async sleep helper.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleepMs(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getHeaderCaseInsensitive(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return null;
}

/**
 * Parses an HTTP Retry-After header (numeric seconds or HTTP-date) into milliseconds.
 *
 * @param {string | null | undefined} headerValue
 * @param {number} [nowMs=Date.now()]
 * @returns {number | null}
 */
export function parseRetryAfterMs(headerValue, nowMs = Date.now()) {
  if (typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
  }

  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) return null;
  return Math.max(0, parsedMs - nowMs);
}

/**
 * Computes bounded retry delay in ms, honoring Retry-After when present or exponential backoff.
 *
 * @param {object} params
 * @returns {number}
 */
export function computeRetryDelayMs({ response, attempt, policy, nowMs }) {
  const retryAfterHeader = getHeaderCaseInsensitive(response?.headers, 'retry-after');
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader, nowMs);
  const baseMs = retryAfterMs !== null ? retryAfterMs : policy.baseDelayMs * (2 ** attempt);
  const jitterMs = policy.jitterMs > 0 ? Math.round(policy.randomFn() * policy.jitterMs) : 0;
  return Math.max(0, Math.min(policy.maxDelayMs, baseMs + jitterMs));
}

/**
 * Executes a fetch call with bounded retries on transient HTTP statuses (429/502/503/504)
 * and network/timeout errors, respecting Retry-After headers.
 *
 * @param {object} params
 * @param {() => Promise<Response>} params.requestFn
 * @param {number} [params.maxRetries=2]
 * @param {number} [params.retryBaseDelayMs=2000]
 * @param {number} [params.maxRetryDelayMs=150000]
 * @param {number} [params.retryJitterMs=1000]
 * @param {(ms: number) => Promise<void>} [params.delayFn=sleepMs]
 * @param {() => number} [params.randomFn=Math.random]
 * @param {Date | string | number | (() => Date)} [params.now]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry({
  requestFn,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
  retryJitterMs = DEFAULT_RETRY_JITTER_MS,
  delayFn = sleepMs,
  randomFn = Math.random,
  now,
  signal
}) {
  const policy = {
    baseDelayMs: retryBaseDelayMs,
    maxDelayMs: maxRetryDelayMs,
    jitterMs: retryJitterMs,
    randomFn
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response = null;
    try {
      response = await requestFn();
      if (response.ok || !RETRYABLE_HTTP_STATUS_CODES.has(response.status) || attempt >= maxRetries) {
        return response;
      }
    } catch (err) {
      if (signal?.aborted || attempt >= maxRetries) {
        throw err;
      }
    }

    const retryDelayMs = computeRetryDelayMs({
      response,
      attempt,
      policy,
      nowMs: resolveNowDate(now).getTime()
    });
    await delayFn(retryDelayMs);
  }
}

/**
 * Paginates a council feed with polite inter-page delay and safety caps (20 pages / 200 items).
 *
 * @param {object} params
 * @param {(page: number) => Promise<{ items: Array<any>, hasMore?: boolean }>} params.fetchPage
 * @param {number} [params.maxPages=20]
 * @param {number} [params.maxActivities=200]
 * @param {number} [params.pageDelayMs=1200]
 * @param {number} [params.pageDelayJitterMs=0]
 * @param {(ms: number) => Promise<void>} [params.delayFn=sleepMs]
 * @param {() => number} [params.randomFn=Math.random]
 * @returns {Promise<Array<any>>}
 */
export async function paginateCouncilPages({
  fetchPage,
  maxPages = DEFAULT_MAX_PAGES,
  maxActivities = DEFAULT_MAX_ACTIVITIES,
  pageDelayMs = DEFAULT_PAGE_DELAY_MS,
  pageDelayJitterMs = 0,
  delayFn = sleepMs,
  randomFn = Math.random
}) {
  const collected = [];

  for (let page = 1; page <= maxPages; page++) {
    if (page > 1 && pageDelayMs > 0) {
      const delayMs = pageDelayJitterMs > 0
        ? Math.max(0, Math.round(pageDelayMs + (randomFn() * 2 - 1) * pageDelayJitterMs))
        : pageDelayMs;
      await delayFn(delayMs);
    }

    const { items = [], hasMore = false } = await fetchPage(page);
    if (Array.isArray(items) && items.length > 0) {
      collected.push(...items);
    }

    if (collected.length >= maxActivities) {
      return collected.slice(0, maxActivities);
    }

    if (!hasMore) {
      break;
    }
  }

  return collected;
}

/**
 * Derives a deterministic source_id for a council CMS item, preferring a native CMS ID
 * and falling back to the canonical Listing URL path or normalized title + start date.
 *
 * @param {object} params
 * @param {string | number} [params.nativeId]
 * @param {string} [params.url]
 * @param {string} [params.title]
 * @param {string} [params.startTime]
 * @returns {string}
 */
export function deriveDeterministicCouncilSourceId({ nativeId, url, title, startTime } = {}) {
  if (nativeId !== undefined && nativeId !== null && String(nativeId).trim() !== '') {
    return String(nativeId).trim();
  }

  if (url && typeof url === 'string') {
    try {
      const pathname = /^https?:\/\//i.test(url) ? new URL(url).pathname : url.split(/[?#]/)[0];
      const urlSlug = slugify(pathname);
      if (urlSlug) {
        return urlSlug;
      }
    } catch {
      // Fall through to title + start date
    }
  }

  const titleSlug = slugify(title || '');
  const schedule = startTime ? parseSchedule({ start_time: startTime }) : null;
  const dateSlug = schedule?.start_date ? slugify(schedule.start_date) : '';
  return [titleSlug, dateSlug].filter(Boolean).join('_') || 'activity';
}
