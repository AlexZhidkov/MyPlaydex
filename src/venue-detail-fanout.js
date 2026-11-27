/**
 * Two-Stage Cached Detail-Page Fan-Out & Multi-Performance Extraction (ADR 0015, Issue #63)
 *
 * Stage 1 (`src/venue-website-sync.js`) scrapes each major Venue's "What's On" index.
 * Stage 2 (`src/venue-detail-fanout.js`) fans out to individual show detail pages ONLY
 * when an index card omits start times, spans a multi-session date range, or lacks a
 * direct ticketing checkout URL — caching detail scrapes for 7–14 days and capping
 * new detail scrapes per run.
 */

import {
  MAX_HORIZON_MS,
  buildDeterministicSourceId,
  buildWebsiteSourceRef,
  extractMarkdownActivities,
  resolvePreferredActivityUrl
} from './markdown-activity-extractor.js';

export const DEFAULT_DETAIL_CACHE_TTL_MS = 10 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_DETAIL_SCRAPES_PER_RUN = 25;
export const DETAIL_CACHE_KEY_PREFIX = 'venue_detail|';

export const DIRECT_TICKETING_HOSTS = Object.freeze([
  'ticketek.com.au',
  'ticketmaster.com.au',
  'moshtix.com.au',
  'oztix.com.au',
  'eventbrite.com.au',
  'eventbrite.com',
  'humanitix.com',
  'trybooking.com',
  'axs.com',
  'livenation.com.au',
  'frontiertouring.com',
  'megatix.com.au',
  'ticketbooth.com.au',
  'tix.yt',
  'tickets.com',
  'showclix.com',
  'eventfinda.com.au',
  'seatgeek.com'
]);

const NON_HTML_ASSET_REGEX = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|ics|csv|zip|mp[34]|mov|avi)(?:$|\?)/i;
const SAME_SITE_TICKETING_PATH_REGEX = /\/(?:tickets?|buy-tickets?|book(?:ing|ings)?|checkout|box-office)(?:\/|$)/i;
const SAME_SITE_TICKETING_SUBDOMAIN_REGEX = /^(?:tickets?|boxoffice|bookings?)\./i;
const OVERNIGHT_SINGLE_SESSION_MAX_MS = 16 * 60 * 60 * 1000;

function normalizeHost(hostname = '') {
  return String(hostname).toLowerCase().replace(/^www\./, '');
}

function stripTrailingSlash(urlHref) {
  return urlHref.replace(/\/+$/, '');
}

function isExternalTicketingHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  return DIRECT_TICKETING_HOSTS.some(
    ticketHost => host === ticketHost || host.endsWith(`.${ticketHost}`)
  );
}

function tryParseUrl(rawUrl, baseUrl = null) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    parsed.hash = '';
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Returns true if `rawUrl` points to a known external ticketing host or a same-site
 * venue box-office/checkout URL.
 *
 * @param {string | null | undefined} rawUrl
 * @param {string | null} [venueWhatsOnUrl=null]
 * @returns {boolean}
 */
export function isDirectTicketingUrl(rawUrl, venueWhatsOnUrl = null) {
  const parsed = tryParseUrl(rawUrl, venueWhatsOnUrl || undefined);
  if (!parsed) return false;

  if (isExternalTicketingHost(parsed.hostname)) {
    return true;
  }

  const venueParsed = venueWhatsOnUrl ? tryParseUrl(venueWhatsOnUrl) : null;
  if (venueParsed) {
    const rawHost = normalizeHost(parsed.hostname);
    const venueHost = normalizeHost(venueParsed.hostname);
    const isSameOrSubdomain = rawHost === venueHost || rawHost.endsWith(`.${venueHost}`);
    if (!isSameOrSubdomain) {
      return false;
    }
  }

  if (SAME_SITE_TICKETING_SUBDOMAIN_REGEX.test(parsed.hostname)) {
    return true;
  }
  return SAME_SITE_TICKETING_PATH_REGEX.test(parsed.pathname);
}

/**
 * Resolves a scrapeable same-host HTML detail page URL for an incomplete index Activity,
 * returning null when the URL is missing, identical to the venue's index URL, a non-HTML
 * asset, or an external ticketing host (which must never be scraped).
 *
 * @param {object} rawActivity
 * @param {object} venueSeed
 * @returns {string|null}
 */
export function resolveDetailPageUrl(rawActivity, venueSeed) {
  if (!rawActivity || !venueSeed?.whatsOnUrl) return null;

  const indexParsed = tryParseUrl(venueSeed.whatsOnUrl);
  if (!indexParsed) return null;
  const indexHost = normalizeHost(indexParsed.hostname);
  const indexCanonical = stripTrailingSlash(indexParsed.href);

  const candidates = [
    rawActivity._detailUrl,
    rawActivity.detail_url,
    rawActivity.source_url
  ];

  for (const candidate of candidates) {
    const parsed = tryParseUrl(candidate, indexParsed.href);
    if (!parsed) continue;
    if (NON_HTML_ASSET_REGEX.test(parsed.pathname)) continue;
    if (isExternalTicketingHost(parsed.hostname)) continue;
    if (normalizeHost(parsed.hostname) !== indexHost) continue;
    if (stripTrailingSlash(parsed.href) === indexCanonical) continue;
    return parsed.href;
  }

  return null;
}

function parseAwstDateTimeMs(dateStr, timeStr = null, defaultEndOfDay = false) {
  if (!dateStr) return NaN;
  const timePart = timeStr ? `${timeStr}:00` : (defaultEndOfDay ? '23:59:59' : '00:00:00');
  return Date.parse(`${dateStr}T${timePart}+08:00`);
}

/**
 * Determines whether a raw Activity represents a multi-session date range rather than
 * a single-day or overnight single-session performance (duration <= 16 hours).
 *
 * @param {object} rawActivity
 * @returns {boolean}
 */
export function isMultiSessionDateRange(rawActivity) {
  const schedule = rawActivity?.schedule;
  const startDate = schedule?.start_date;
  const endDate = schedule?.end_date;
  if (!startDate || !endDate || endDate <= startDate) {
    return false;
  }

  const startTime = schedule?.start_time;
  const endTime = schedule?.end_time;
  if (startTime && endTime) {
    const startMs = parseAwstDateTimeMs(startDate, startTime);
    const endMs = parseAwstDateTimeMs(endDate, endTime);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      return (endMs - startMs) > OVERNIGHT_SINGLE_SESSION_MAX_MS;
    }
  }

  return true;
}

/**
 * Evaluates whether an index-extracted Activity requires Stage 2 detail-page fan-out.
 *
 * @param {object} rawActivity
 * @param {object} venueSeed
 * @returns {{ needsFanOut: boolean, reasons: Array<string>, detailUrl: string|null }}
 */
export function assessDetailFanOutNeed(rawActivity, venueSeed) {
  const detailUrl = resolveDetailPageUrl(rawActivity, venueSeed);
  const reasons = [];

  if (rawActivity?._missingStartTime || !rawActivity?.schedule?.start_time) {
    reasons.push('missing_start_time');
  }
  if (isMultiSessionDateRange(rawActivity)) {
    reasons.push('multi_session_range');
  }
  if (!isDirectTicketingUrl(rawActivity?.source_url, venueSeed?.whatsOnUrl)) {
    reasons.push('missing_ticket_url');
  }

  return {
    needsFanOut: reasons.length > 0 && Boolean(detailUrl),
    reasons,
    detailUrl
  };
}

function collectCandidateUrlsFromContent({ html = '', markdown = '', links = [] }) {
  const candidates = [];
  if (Array.isArray(links)) {
    for (const link of links) {
      if (typeof link === 'string' && link.trim()) {
        candidates.push(link.trim());
      }
    }
  }

  if (typeof html === 'string' && html) {
    const hrefRegex = /\bhref=["']([^"']+)["']/gi;
    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
      if (match[1]?.trim()) {
        candidates.push(match[1].trim());
      }
    }
  }

  if (typeof markdown === 'string' && markdown) {
    const mdLinkRegex = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match;
    while ((match = mdLinkRegex.exec(markdown)) !== null) {
      if (match[1]?.trim()) {
        candidates.push(match[1].trim());
      }
    }
    const bareUrlRegex = /https?:\/\/[^\s)>"']+/gi;
    while ((match = bareUrlRegex.exec(markdown)) !== null) {
      if (match[0]?.trim()) {
        candidates.push(match[0].trim());
      }
    }
  }

  return candidates;
}

/**
 * Scans scraped detail-page `links`, HTML anchors, and Markdown links for a direct
 * ticketing checkout URL, preferring known external ticketing hosts over same-site links.
 *
 * @param {object} [params={}]
 * @returns {string|null}
 */
export function extractDirectTicketingUrlFromContent({
  html = '',
  markdown = '',
  links = [],
  detailUrl,
  venueWhatsOnUrl = null
} = {}) {
  if (!detailUrl) return null;
  const rawCandidates = collectCandidateUrlsFromContent({ html, markdown, links });
  const resolvedUnique = [];
  const seen = new Set();

  for (const raw of rawCandidates) {
    const resolved = resolvePreferredActivityUrl(raw, detailUrl);
    if (!resolved || resolved === detailUrl || seen.has(resolved)) continue;
    seen.add(resolved);
    if (isDirectTicketingUrl(resolved, venueWhatsOnUrl || detailUrl)) {
      resolvedUnique.push(resolved);
    }
  }

  if (resolvedUnique.length === 0) {
    return null;
  }

  const externalMatch = resolvedUnique.find(url => {
    const parsed = tryParseUrl(url);
    return parsed ? isExternalTicketingHost(parsed.hostname) : false;
  });
  return externalMatch || resolvedUnique[0];
}

function isFreshDetailCacheEntry(entry, nowMs, ttlMs, refresh) {
  if (refresh || !entry || typeof entry !== 'object') {
    return false;
  }
  const fetchedAtMs = entry.fetchedAt ? Date.parse(entry.fetchedAt) : NaN;
  if (!Number.isFinite(fetchedAtMs)) {
    return false;
  }
  return (nowMs - fetchedAtMs) <= ttlMs;
}

function isWithinHorizon(perf, nowMs) {
  const startDate = perf?.schedule?.start_date;
  if (!startDate) return false;
  const startMs = parseAwstDateTimeMs(startDate, perf?.schedule?.start_time || null, true);
  if (!Number.isFinite(startMs) || startMs > nowMs + MAX_HORIZON_MS) {
    return false;
  }
  const endDate = perf?.schedule?.end_date || startDate;
  const endMs = parseAwstDateTimeMs(endDate, perf?.schedule?.end_time || null, true);
  const effectiveEndMs = Number.isFinite(endMs) ? endMs : startMs;
  return effectiveEndMs >= nowMs;
}

function applyVenueSourceRef(activity, sourceId, targetUrl) {
  const sourceRef = buildWebsiteSourceRef(sourceId, targetUrl, 'venue_website');
  return {
    ...activity,
    ...sourceRef,
    sources: [sourceRef],
    source_keys: [sourceRef.source_key]
  };
}

function normalizeExpandedPerformance(perf, parentActivity, detailUrl, pageTicketUrl, venueWhatsOnUrl) {
  const schedule = perf.schedule || {};
  const startDate = schedule.start_date;
  const startTime = schedule.start_time || null;
  const scheduleKey = startTime ? `${startDate}T${startTime}` : startDate;
  const title = (typeof perf.title === 'string' && perf.title.trim()) || parentActivity.title;
  const description = (typeof perf.description === 'string' && perf.description.trim())
    ? perf.description.trim()
    : (parentActivity.description || '');
  const category = perf.category || parentActivity.category;

  let preferredUrl = detailUrl;
  if (isDirectTicketingUrl(perf.source_url, venueWhatsOnUrl)) {
    preferredUrl = perf.source_url;
  } else if (pageTicketUrl) {
    preferredUrl = pageTicketUrl;
  } else if (isDirectTicketingUrl(parentActivity.source_url, venueWhatsOnUrl)) {
    preferredUrl = parentActivity.source_url;
  }

  const sourceId = buildDeterministicSourceId(detailUrl, title, scheduleKey);
  return {
    ...applyVenueSourceRef(perf, sourceId, preferredUrl),
    title,
    description,
    category,
    _missingStartTime: !startTime
  };
}

function deduplicatePerformances(performances) {
  const seen = new Set();
  const unique = [];
  for (const perf of performances) {
    const key = [
      String(perf.title || '').trim().toLowerCase(),
      perf.schedule?.start_date || '',
      perf.schedule?.start_time || ''
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(perf);
  }
  return unique;
}

function buildEnrichedFallback(rawActivity, pageTicketUrl, detailUrl) {
  if (!pageTicketUrl) {
    return [rawActivity];
  }
  const sourceId = rawActivity.source_id || buildDeterministicSourceId(
    detailUrl,
    rawActivity.title,
    rawActivity.schedule?.start_date || ''
  );
  return [applyVenueSourceRef(rawActivity, sourceId, pageTicketUrl)];
}

function countCompletePerformances(items) {
  return items.filter(item => !item._missingStartTime && !isMultiSessionDateRange(item)).length;
}

async function scrapeAndExtractDetailEntry({
  detailUrl,
  rawActivity,
  venueSeed,
  firecrawlClient,
  geminiClient,
  extractVenueJsonLdActivities,
  now,
  nowMs,
  refresh,
  stats,
  logger
}) {
  const scraped = await firecrawlClient.scrape(detailUrl, {
    formats: ['html', 'markdown', 'links'],
    onlyMainContent: false,
    refresh
  });

  const jsonLdItems = typeof extractVenueJsonLdActivities === 'function'
    ? extractVenueJsonLdActivities(scraped?.html || '', {
        scrapedUrl: detailUrl,
        venueSeed,
        now
      })
    : [];

  const jsonLdNeedsFallback = jsonLdItems.length === 0
    || jsonLdItems.some(item => item._missingStartTime || isMultiSessionDateRange(item));

  let selectedItems = jsonLdItems;

  if (
    jsonLdNeedsFallback
    && geminiClient
    && typeof scraped?.markdown === 'string'
    && scraped.markdown.trim()
  ) {
    stats.llmFallbackCalls += 1;
    const markdownItems = (await extractMarkdownActivities({
      markdown: scraped.markdown,
      scrapedUrl: detailUrl,
      organizer: null,
      venueName: venueSeed?.name || '',
      source: 'venue_website',
      geminiClient,
      now,
      logger
    }))
      .filter(item => item?.schedule?.recurrence === 'none' && Boolean(item?.schedule?.start_date))
      .map(item => ({
        ...item,
        category: item.category || venueSeed?.defaultCategory
      }));

    if (
      jsonLdItems.length === 0
      || markdownItems.length > jsonLdItems.length
      || countCompletePerformances(markdownItems) > countCompletePerformances(jsonLdItems)
    ) {
      selectedItems = markdownItems;
    }
  }

  const pageTicketUrl = extractDirectTicketingUrlFromContent({
    html: scraped?.html || '',
    markdown: scraped?.markdown || '',
    links: scraped?.links || [],
    detailUrl,
    venueWhatsOnUrl: venueSeed?.whatsOnUrl
  });

  const normalized = deduplicatePerformances(
    selectedItems.map(perf =>
      normalizeExpandedPerformance(perf, rawActivity, detailUrl, pageTicketUrl, venueSeed?.whatsOnUrl)
    )
  );

  return {
    url: detailUrl,
    fetchedAt: new Date(nowMs).toISOString(),
    activities: normalized,
    pageTicketUrl
  };
}

/**
 * Expands incomplete Venue index Activities by fanning out to show detail pages,
 * extracting discrete dated performances (JSON-LD first, Gemini Flash Markdown fallback)
 * and direct ticketing checkout URLs, with per-URL caching and per-run scrape capping.
 *
 * @param {object} [params={}]
 * @returns {Promise<{ activities: Array<object>, stats: object }>}
 */
export async function expandVenueActivitiesWithDetailFanOut({
  rawActivities = [],
  venueSeed,
  firecrawlClient = null,
  geminiClient = null,
  detailCacheStore = null,
  extractVenueJsonLdActivities,
  now = new Date(),
  refresh = false,
  maxDetailScrapes = DEFAULT_MAX_DETAIL_SCRAPES_PER_RUN,
  detailCacheTtlMs = DEFAULT_DETAIL_CACHE_TTL_MS,
  state = null,
  logger = console
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const runState = state || { scrapesUsed: 0, inRunCache: new Map() };
  if (!(runState.inRunCache instanceof Map)) {
    runState.inRunCache = new Map();
  }
  if (!Number.isFinite(runState.scrapesUsed)) {
    runState.scrapesUsed = 0;
  }

  const stats = {
    detailCandidates: 0,
    detailCacheHits: 0,
    detailScrapesAttempted: 0,
    detailScrapesFailed: 0,
    detailScrapesCapped: 0,
    detailExpandedCount: 0,
    llmFallbackCalls: 0
  };

  const expanded = [];
  const expandedDetailUrls = new Set();

  for (const rawActivity of rawActivities) {
    const assessment = assessDetailFanOutNeed(rawActivity, venueSeed);
    if (!assessment.needsFanOut) {
      expanded.push(rawActivity);
      continue;
    }

    const detailUrl = assessment.detailUrl;
    if (expandedDetailUrls.has(detailUrl)) {
      continue;
    }

    stats.detailCandidates += 1;
    const cacheKey = `${DETAIL_CACHE_KEY_PREFIX}${detailUrl}`;

    let resolvedEntry = runState.inRunCache.get(detailUrl) || null;

    if (!resolvedEntry && detailCacheStore) {
      const cached = await detailCacheStore.read(cacheKey);
      if (isFreshDetailCacheEntry(cached, nowMs, detailCacheTtlMs, refresh)) {
        stats.detailCacheHits += 1;
        resolvedEntry = cached;
        runState.inRunCache.set(detailUrl, resolvedEntry);
      }
    }

    if (!resolvedEntry) {
      if (!firecrawlClient || runState.scrapesUsed >= maxDetailScrapes) {
        stats.detailScrapesCapped += 1;
        expanded.push(rawActivity);
        continue;
      }

      runState.scrapesUsed += 1;
      stats.detailScrapesAttempted += 1;

      try {
        resolvedEntry = await scrapeAndExtractDetailEntry({
          detailUrl,
          rawActivity,
          venueSeed,
          firecrawlClient,
          geminiClient,
          extractVenueJsonLdActivities,
          now,
          nowMs,
          refresh,
          stats,
          logger
        });
      } catch (err) {
        stats.detailScrapesFailed += 1;
        logger?.warn?.(`[Venue Detail Fan-Out] Scrape failed for ${detailUrl}: ${err.message}`);
        expanded.push(rawActivity);
        continue;
      }

      runState.inRunCache.set(detailUrl, resolvedEntry);

      if (detailCacheStore) {
        try {
          await detailCacheStore.write(cacheKey, resolvedEntry);
        } catch (err) {
          logger?.warn?.(`[Venue Detail Fan-Out] Cache write failed for ${detailUrl}: ${err.message}`);
        }
      }
    }

    expandedDetailUrls.add(detailUrl);
    const validCached = (Array.isArray(resolvedEntry.activities) ? resolvedEntry.activities : [])
      .filter(perf => isWithinHorizon(perf, nowMs));

    if (validCached.length > 0) {
      stats.detailExpandedCount += validCached.length;
      expanded.push(...validCached);
    } else {
      expanded.push(...buildEnrichedFallback(rawActivity, resolvedEntry.pageTicketUrl, detailUrl));
    }
  }

  return { activities: expanded, stats };
}
