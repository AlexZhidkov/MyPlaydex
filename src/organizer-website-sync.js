/**
 * Firecrawl Organizer Website Drip Sync CLI
 * Selects prioritized Tier-1 Organizer websites, maps candidate activity/timetable URLs
 * via `/v2/map` (cached 14 days, capped at 3–5 URLs), scrapes via `firecrawl-local`,
 * extracts deterministic Schema.org Event JSON-LD Activity listings, and ingests them
 * through sanitization, entity matching, and deduplication with 7d/30d backoff (ADR 0013).
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  deduplicateActivities,
  reconcileStaleWeeklyActivities
} from './activity-deduplicator.js';
export { reconcileStaleWeeklyActivities };
import { resolveCliLogger } from './crawler-reporter.js';
import {
  anchorAwstTimestamp,
  extractJsonLdActivities,
  formatSchemaAddress,
  parseActivityCost,
  resolvePerthCoordinates
} from './crawlers/eventbrite-parser.js';
import {
  collectKnownOrganizerHosts,
  DEFAULT_DIRECTORY_SOURCES,
  harvestDirectoryDomains,
  normalizeDomainHost
} from './directory-harvester.js';
import { matchVenueByNameOnly, reconcileListingWithCatalog } from './entity-matcher.js';
import { createFileCacheStore } from './file-cache.js';
import { createFirecrawlClientFromEnv } from './firecrawl-client.js';
import { createFirestoreAdapter, initFirestoreFromEnv } from './firestore-adapter.js';
import { createGeminiFlashClientFromEnv } from './gemini-flash-client.js';
import {
  MAX_HORIZON_MS,
  buildDeterministicSourceId,
  buildOrganizerWebsiteSourceRef,
  extractMarkdownActivities
} from './markdown-activity-extractor.js';
import { loadDotEnv } from './places-sync.js';
import {
  DEFAULT_PDF_SCRAPE_TIMEOUT_MS,
  DEFAULT_PDF_TIMETABLE_SEEDS,
  isPdfUrl,
  scorePdfCandidateUrl
} from './pdf-timetable-seeds.js';
import {
  normalizeSport,
  parseSchedule,
  sanitizeActivity
} from './sanitizer.js';
import { applyVenueResolution, resolveActivityVenueAndCoordinates } from './venue-resolver.js';

export const DEFAULT_ORGANIZER_WEBSITE_CACHE_PATH = path.resolve(
  process.cwd(),
  '.scratch/organizer-website-sync-cache.json'
);
export const DEFAULT_MAX_DOMAINS = 10;
export const DEFAULT_MAX_URLS_PER_DOMAIN = 5;
export const DEFAULT_MAP_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_ZERO_YIELD_BACKOFF_MS = 30 * 24 * 60 * 60 * 1000;

const HIGH_SIGNAL_KEYWORDS = [
  '/events',
  '/calendar',
  '/whats-on',
  '/whatson',
  '/timetable',
  '/schedule',
  '/classes',
  '/sessions',
  '/fixtures'
];

const EXTERNAL_PLATFORM_SOURCES = new Set(['eventbrite', 'meetup', 'facebook']);
const EXTERNAL_PLATFORM_URL_REGEX = /\b(?:eventbrite\.|meetup\.|facebook\.com|fb\.com)\b/i;

function getArgValue(argv, flag) {
  const prefix = `--${flag}=`;
  const eqMatch = argv.find(a => a.startsWith(prefix));
  if (eqMatch) {
    return eqMatch.slice(prefix.length);
  }
  const exactFlag = `--${flag}`;
  const idx = argv.indexOf(exactFlag);
  if (idx !== -1 && idx + 1 < argv.length && !argv[idx + 1].startsWith('--')) {
    return argv[idx + 1];
  }
  return undefined;
}

function parseIntArg(rawValue, fallback, min = 0) {
  if (rawValue === undefined) return fallback;
  const parsed = parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/**
 * Parses CLI arguments for the Organizer website drip sync CLI.
 * Defaults to dry-run unless `--apply` is passed without `--dry-run`.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @returns {object}
 */
export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  const apply = argv.includes('--apply') && !argv.includes('--dry-run');
  const noFirecrawl = argv.includes('--no-firecrawl');
  const firecrawlUrl = noFirecrawl
    ? null
    : (getArgValue(argv, 'firecrawl-url') || env.FIRECRAWL_LOCAL_URL || null);

  const rawMaxDomains = getArgValue(argv, 'max-domains') ?? getArgValue(argv, 'limit');
  const maxDomains = parseIntArg(rawMaxDomains, DEFAULT_MAX_DOMAINS, 1);
  const maxUrlsPerDomain = parseIntArg(
    getArgValue(argv, 'max-urls-per-domain'),
    DEFAULT_MAX_URLS_PER_DOMAIN,
    1
  );

  return {
    dryRun: !apply,
    refresh: argv.includes('--refresh'),
    force: argv.includes('--force'),
    harvestDirectories: !argv.includes('--no-directories') && !getArgValue(argv, 'organizer'),
    includePdfSeeds: !argv.includes('--no-pdf-seeds') && !getArgValue(argv, 'organizer'),
    organizer: getArgValue(argv, 'organizer'),
    maxDomains,
    maxUrlsPerDomain,
    useAdc: argv.includes('--use-adc') || Boolean(env.FIREBASE_USE_ADC),
    project: getArgValue(argv, 'project') || env.FIREBASE_PROJECT_ID || 'myplaydex',
    firecrawlUrl
  };
}

/**
 * Normalizes an Organizer website URL to a canonical http(s) URL, or returns null.
 *
 * @param {unknown} rawUrl
 * @returns {string|null}
 */
export function normalizeWebsiteUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

function normalizeHost(hostname = '') {
  return String(hostname).toLowerCase().replace(/^www\./, '');
}

function scoreCandidateUrl(parsedUrl) {
  if (parsedUrl.pathname.toLowerCase().endsWith('.pdf')) {
    return scorePdfCandidateUrl(parsedUrl);
  }
  const lowerPath = `${parsedUrl.pathname}${parsedUrl.search}`.toLowerCase();
  let keywordMatchIndex = -1;
  for (let i = 0; i < HIGH_SIGNAL_KEYWORDS.length; i++) {
    if (lowerPath.includes(HIGH_SIGNAL_KEYWORDS[i])) {
      keywordMatchIndex = i;
      break;
    }
  }
  if (keywordMatchIndex === -1) {
    return null;
  }

  let score = 100 - keywordMatchIndex * 2;
  const segments = parsedUrl.pathname.split('/').filter(Boolean).length;
  score -= segments * 3;
  if (parsedUrl.search) {
    score -= 5;
  }
  return score;
}

/**
 * Filters `/v2/map` links to same-site high-signal activity/timetable/PDF URLs,
 * capped at `maxUrls` (default 5), falling back to `[baseUrl]` when none match.
 *
 * @param {Array<string>} [links=[]]
 * @param {string} baseUrl
 * @param {object} [options={}]
 * @returns {Array<string>}
 */
export function filterCandidateUrls(links = [], baseUrl, { maxUrls = DEFAULT_MAX_URLS_PER_DOMAIN } = {}) {
  const normalizedBase = normalizeWebsiteUrl(baseUrl);
  if (!normalizedBase) return [];

  const baseHost = normalizeHost(new URL(normalizedBase).hostname);
  const cap = Number.isFinite(maxUrls) && maxUrls > 0 ? Math.floor(maxUrls) : DEFAULT_MAX_URLS_PER_DOMAIN;

  const scoredByUrl = new Map();
  for (const rawLink of Array.isArray(links) ? links : []) {
    const normalized = normalizeWebsiteUrl(rawLink);
    if (!normalized) continue;
    let parsed;
    try {
      parsed = new URL(normalized);
    } catch {
      continue;
    }
    if (normalizeHost(parsed.hostname) !== baseHost) {
      continue;
    }
    const score = scoreCandidateUrl(parsed);
    if (score === null) continue;
    if (!scoredByUrl.has(normalized) || scoredByUrl.get(normalized) < score) {
      scoredByUrl.set(normalized, score);
    }
  }

  if (scoredByUrl.size === 0) {
    return [normalizedBase];
  }

  return Array.from(scoredByUrl.entries())
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([url]) => url);
}

function hasExternalPlatformSource(organizer, orgActivities = []) {
  if (typeof organizer?.contact?.facebook === 'string' && organizer.contact.facebook.trim()) {
    return true;
  }
  const orgUrls = [organizer?.source_url, organizer?.raw_source_url];
  for (const url of orgUrls) {
    if (typeof url === 'string' && EXTERNAL_PLATFORM_URL_REGEX.test(url)) {
      return true;
    }
  }
  for (const ref of Array.isArray(organizer?.sources) ? organizer.sources : []) {
    const src = typeof ref?.source === 'string' ? ref.source.toLowerCase().trim() : '';
    if (EXTERNAL_PLATFORM_SOURCES.has(src)) return true;
    if (typeof ref?.source_url === 'string' && EXTERNAL_PLATFORM_URL_REGEX.test(ref.source_url)) {
      return true;
    }
  }
  for (const act of orgActivities) {
    const actSource = typeof act?.source === 'string' ? act.source.toLowerCase().trim() : '';
    if (EXTERNAL_PLATFORM_SOURCES.has(actSource)) return true;
    for (const ref of Array.isArray(act?.sources) ? act.sources : []) {
      const refSrc = typeof ref?.source === 'string' ? ref.source.toLowerCase().trim() : '';
      if (EXTERNAL_PLATFORM_SOURCES.has(refSrc)) return true;
    }
  }
  return false;
}

function isActivityActive(activity, nowMs) {
  if (!activity?.expire_at) return true;
  const expireMs = typeof activity.expire_at?.toMillis === 'function'
    ? activity.expire_at.toMillis()
    : Date.parse(activity.expire_at);
  return !Number.isFinite(expireMs) || expireMs > nowMs;
}

function checkpointKeyForWebsite(websiteUrl) {
  return `drip_checkpoint|${websiteUrl}`;
}

async function readDripTargetBackoffState({
  cacheStore,
  websiteUrl,
  nowMs,
  force,
  refresh,
  productiveCooldownMs,
  zeroYieldBackoffMs
}) {
  const checkpoint = cacheStore ? await cacheStore.read(checkpointKeyForWebsite(websiteUrl)) : null;
  const lastCrawledAtMs = checkpoint?.lastCrawledAt ? Date.parse(checkpoint.lastCrawledAt) : -Infinity;
  const lastYieldCount = Number.isFinite(checkpoint?.lastYieldCount) ? checkpoint.lastYieldCount : null;

  if (!force && !refresh && Number.isFinite(lastCrawledAtMs)) {
    const cooldownMs = (lastYieldCount !== null && lastYieldCount > 0)
      ? productiveCooldownMs
      : zeroYieldBackoffMs;
    if ((nowMs - lastCrawledAtMs) < cooldownMs) {
      return { skip: true, lastCrawledAtMs, lastYieldCount };
    }
  }

  return { skip: false, lastCrawledAtMs, lastYieldCount };
}

/**
 * Selects and prioritizes eligible Organizer website targets for the drip run,
 * putting Tier-1 Organizers (0 active Activities, no Eventbrite/Meetup/Facebook Source Reference)
 * first, followed by Tier-2 harvested directory domains and existing Tier-2 Organizers,
 * and enforcing 7-day productive / 30-day zero-yield backoff.
 *
 * @param {object} [params={}]
 * @returns {Promise<Array<object>>}
 */
export async function selectDripOrganizerTargets({
  organizersCatalog = [],
  activitiesCatalog = [],
  harvestedDomains = [],
  pdfTimetableSeeds = [],
  cacheStore = null,
  now = new Date(),
  force = false,
  refresh = false,
  organizerId = undefined,
  maxDomains = DEFAULT_MAX_DOMAINS,
  productiveCooldownMs = DEFAULT_PRODUCTIVE_COOLDOWN_MS,
  zeroYieldBackoffMs = DEFAULT_ZERO_YIELD_BACKOFF_MS
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const activitiesByOrgId = new Map();
  for (const act of activitiesCatalog) {
    const orgId = act?.organizer?.id;
    if (!orgId) continue;
    if (!activitiesByOrgId.has(orgId)) {
      activitiesByOrgId.set(orgId, []);
    }
    activitiesByOrgId.get(orgId).push(act);
  }

  const eligible = [];
  const seenHosts = new Set();
  const seenUrls = new Set();
  const knownOrganizerHosts = collectKnownOrganizerHosts(organizersCatalog);

  for (const org of organizersCatalog) {
    if (!org || typeof org !== 'object') continue;
    if (organizerId && org.id !== organizerId) continue;

    const websiteUrl = normalizeWebsiteUrl(org.website);
    if (!websiteUrl) continue;

    const backoff = await readDripTargetBackoffState({
      cacheStore,
      websiteUrl,
      nowMs,
      force,
      refresh,
      productiveCooldownMs,
      zeroYieldBackoffMs
    });
    if (backoff.skip) continue;

    const host = normalizeDomainHost(websiteUrl);
    if (host) seenHosts.add(host);
    seenUrls.add(websiteUrl);

    const orgActivities = org.id ? (activitiesByOrgId.get(org.id) || []) : [];
    const activeActivityCount = orgActivities.filter(a => isActivityActive(a, nowMs)).length;
    const hasExternal = hasExternalPlatformSource(org, orgActivities);
    const tier = (activeActivityCount === 0 && !hasExternal) ? 1 : 2;

    eligible.push({
      organizer: org,
      websiteUrl,
      tier,
      isHarvestedDomain: false,
      activeActivityCount,
      hasExternalSource: hasExternal,
      lastCrawledAtMs: backoff.lastCrawledAtMs,
      lastYieldCount: backoff.lastYieldCount
    });
  }

  if (!organizerId) {
    for (const seed of Array.isArray(pdfTimetableSeeds) ? pdfTimetableSeeds : []) {
      const seedUrl = normalizeWebsiteUrl(seed?.url);
      if (!seedUrl || seenUrls.has(seedUrl)) continue;

      const backoff = await readDripTargetBackoffState({
        cacheStore,
        websiteUrl: seedUrl,
        nowMs,
        force,
        refresh,
        productiveCooldownMs,
        zeroYieldBackoffMs
      });
      if (backoff.skip) continue;

      seenUrls.add(seedUrl);

      const host = normalizeDomainHost(seedUrl);
      eligible.push({
        organizer: {
          id: seed.organizerId || null,
          name: seed.organizerName || seed.venueName || host || seedUrl,
          website: seedUrl
        },
        websiteUrl: seedUrl,
        tier: 1,
        isHarvestedDomain: false,
        isPdfSeed: true,
        venueName: seed.venueName || null,
        suburb: seed.suburb || null,
        activeActivityCount: 0,
        hasExternalSource: false,
        lastCrawledAtMs: backoff.lastCrawledAtMs,
        lastYieldCount: backoff.lastYieldCount
      });
    }

    for (const harvested of Array.isArray(harvestedDomains) ? harvestedDomains : []) {
      const websiteUrl = normalizeWebsiteUrl(harvested?.websiteUrl);
      const host = normalizeDomainHost(websiteUrl);
      if (!websiteUrl || !host) continue;
      if (knownOrganizerHosts.has(host) || seenHosts.has(host)) continue;

      const backoff = await readDripTargetBackoffState({
        cacheStore,
        websiteUrl,
        nowMs,
        force,
        refresh,
        productiveCooldownMs,
        zeroYieldBackoffMs
      });
      if (backoff.skip) continue;

      seenHosts.add(host);
      eligible.push({
        organizer: {
          id: null,
          name: harvested.organizerName || host,
          website: websiteUrl
        },
        websiteUrl,
        tier: 2,
        isHarvestedDomain: true,
        sourceDirectoryUrl: harvested.sourceDirectoryUrl || null,
        activeActivityCount: 0,
        hasExternalSource: false,
        lastCrawledAtMs: backoff.lastCrawledAtMs,
        lastYieldCount: backoff.lastYieldCount
      });
    }
  }

  eligible.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.lastCrawledAtMs !== b.lastCrawledAtMs) return a.lastCrawledAtMs - b.lastCrawledAtMs;
    if (Boolean(a.isPdfSeed) !== Boolean(b.isPdfSeed)) return a.isPdfSeed ? 1 : -1;
    const idCmp = String(a.organizer.id || '').localeCompare(String(b.organizer.id || ''));
    return idCmp !== 0 ? idCmp : a.websiteUrl.localeCompare(b.websiteUrl);
  });

  const cap = Number.isFinite(maxDomains) && maxDomains > 0 ? Math.floor(maxDomains) : DEFAULT_MAX_DOMAINS;
  return eligible.slice(0, cap);
}

function isOnlineOnlyJsonLd(ev) {
  const mode = String(ev?.eventAttendanceMode || '');
  if (/OnlineEventAttendanceMode/i.test(mode) && !/MixedEventAttendanceMode/i.test(mode)) {
    return true;
  }
  const locations = Array.isArray(ev?.location) ? ev.location : (ev?.location ? [ev.location] : []);
  if (locations.length > 0 && locations.every(loc => String(loc?.['@type'] || '').toLowerCase() === 'virtuallocation')) {
    return true;
  }
  return false;
}

function pickPhysicalLocation(rawLocation) {
  const locations = Array.isArray(rawLocation) ? rawLocation : (rawLocation ? [rawLocation] : []);
  for (const loc of locations) {
    if (!loc || typeof loc !== 'object') continue;
    if (String(loc['@type'] || '').toLowerCase() === 'virtuallocation') continue;
    return loc;
  }
  return null;
}

function parseAwstTimestampMs(rawTimestamp) {
  if (!rawTimestamp) return NaN;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(rawTimestamp);
  return Date.parse(isDateOnly ? `${rawTimestamp}T23:59:59+08:00` : rawTimestamp);
}

/**
 * Extracts valid, grounded Schema.org Event JSON-LD Activity candidates from scraped HTML,
 * applying ADR 0013 hard-drop guardrails (missing title/date, cancelled, online-only, past, >6 months).
 *
 * @param {string} [html='']
 * @param {object} [params={}]
 * @returns {Array<object>}
 */
export function extractOrganizerWebsiteActivities(html = '', { scrapedUrl, organizer = null, now = new Date() } = {}) {
  if (!html || typeof html !== 'string' || !scrapedUrl) {
    return [];
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const maxFutureMs = nowMs + MAX_HORIZON_MS;
  const jsonLdActivities = extractJsonLdActivities(html);
  const results = [];

  for (const item of jsonLdActivities) {
    if (!item || typeof item !== 'object') continue;

    const title = typeof item.name === 'string' ? item.name.trim() : '';
    if (!title) continue;
    if (/EventCancelled/i.test(String(item.eventStatus || ''))) continue;
    if (isOnlineOnlyJsonLd(item)) continue;

    const startDate = anchorAwstTimestamp(item.startDate);
    if (!startDate) continue;

    const startMs = parseAwstTimestampMs(startDate);
    if (!Number.isFinite(startMs) || startMs > maxFutureMs) continue;

    const endDate = anchorAwstTimestamp(item.endDate);
    const effectiveEndMs = endDate ? parseAwstTimestampMs(endDate) : startMs;
    if ((Number.isFinite(effectiveEndMs) ? effectiveEndMs : startMs) < nowMs) continue;

    const schedule = parseSchedule({ start_date: startDate, end_date: endDate }, new Date(nowMs).toISOString());

    const location = pickPhysicalLocation(item.location);
    const venueName = typeof location?.name === 'string' ? location.name.trim() : '';
    const venueAddress = formatSchemaAddress(location?.address);
    const coordinates = resolvePerthCoordinates(location, null);
    const pricing = parseActivityCost({ jsonLd: item });
    const description = typeof item.description === 'string' ? item.description.trim() : '';
    const sourceId = buildDeterministicSourceId(scrapedUrl, title, startDate);
    const hasStartTime = /T\d{2}:\d{2}/.test(startDate);

    results.push({
      ...buildOrganizerWebsiteSourceRef(sourceId, scrapedUrl),
      title,
      description,
      subcategory: normalizeSport(`${title} ${description}`),
      start_date: startDate,
      ...(endDate ? { end_date: endDate } : {}),
      schedule,
      venue_name: venueName || undefined,
      venue_address: venueAddress || undefined,
      ...(coordinates ? { coordinates } : {}),
      is_free: pricing.isFree,
      cost_description: pricing.displayPrice,
      ...(organizer ? { organizer: { id: organizer.id, name: organizer.name } } : {}),
      _missingStartTime: !hasStartTime
    });
  }

  return results;
}

function resolveOrganizerHomeVenue(organizer) {
  if (!organizer || typeof organizer !== 'object') return null;
  const venue = organizer.venue && typeof organizer.venue === 'object' ? organizer.venue : null;
  const id = (typeof venue?.id === 'string' && venue.id.trim())
    || (typeof organizer.venue_id === 'string' && organizer.venue_id.trim())
    || null;
  const name = (typeof venue?.name === 'string' && venue.name.trim())
    || (typeof organizer.venue_name === 'string' && organizer.venue_name.trim())
    || '';
  const coords = venue?.coordinates || organizer.coordinates || null;
  if (!id || !name || !coords || typeof coords.lat !== 'number' || typeof coords.lng !== 'number') {
    return null;
  }
  return {
    id,
    name,
    coordinates: coords,
    ...(venue?.geohash ? { geohash: venue.geohash } : {})
  };
}

const SUB_SPACE_VENUE_REGEX = /\b(studio|room|pool|lane|court|hall|gym|arena|turf|deck|level|floor|poolside|foyer)\b/i;

function ingestWebsiteActivity(rawActivity, {
  venuesCatalog,
  organizersCatalog,
  target
}) {
  const organizer = target?.organizer;
  const homeVenue = resolveOrganizerHomeVenue(organizer);
  const fallbackVenueName = (typeof target?.venueName === 'string' && target.venueName.trim())
    || homeVenue?.name
    || null;
  const rawVenueName = typeof rawActivity.venue_name === 'string' ? rawActivity.venue_name.trim() : '';

  const isPdfSource = Boolean(target?.isPdfSeed) || isPdfUrl(rawActivity.source_url);
  const shouldUseFallbackVenue = Boolean(
    fallbackVenueName && (
      !rawVenueName
      || rawVenueName.toLowerCase() === fallbackVenueName.toLowerCase()
      || (isPdfSource
        && (Boolean(target?.isPdfSeed) || SUB_SPACE_VENUE_REGEX.test(rawVenueName))
        && !matchVenueByNameOnly(rawVenueName, venuesCatalog).candidate)
    )
  );

  const shouldUseHomeVenue = Boolean(
    homeVenue && shouldUseFallbackVenue && fallbackVenueName === homeVenue.name
  );

  const effectiveVenuesCatalog = shouldUseHomeVenue && !venuesCatalog.some(v => v.id === homeVenue.id)
    ? [...venuesCatalog, homeVenue]
    : venuesCatalog;
  const effectiveRawActivity = {
    ...rawActivity,
    ...(shouldUseFallbackVenue ? { venue_name: fallbackVenueName } : {}),
    ...(!rawActivity.suburb && target?.suburb ? { suburb: target.suburb } : {})
  };

  const resolved = resolveActivityVenueAndCoordinates(effectiveRawActivity, {
    venuesCatalog: effectiveVenuesCatalog,
    organizersCatalog,
    parentOrganizer: organizer
  });
  if (resolved.outOfArea) {
    return null;
  }

  const sanitized = sanitizeActivity({
    ...effectiveRawActivity,
    coordinates: resolved.coordinates,
    geohash: resolved.geohash,
    venue_name: resolved.venueOverride?.name || effectiveRawActivity.venue_name || effectiveRawActivity.title,
    organizer: organizer ? { id: organizer.id, name: organizer.name } : effectiveRawActivity.organizer
  });

  const reconciled = reconcileListingWithCatalog(
    sanitized,
    { venuesCatalog: effectiveVenuesCatalog, organizersCatalog },
    'activity'
  );
  applyVenueResolution(reconciled, resolved, sanitized.venue);

  if (rawActivity._missingStartTime && !reconciled.needs_review) {
    reconciled.needs_review = true;
    reconciled.review_reason = 'missing_start_time';
  } else if (rawActivity._lowConfidence && !reconciled.needs_review) {
    reconciled.needs_review = true;
    reconciled.review_reason = 'low_confidence';
  }

  const sourceRef = buildOrganizerWebsiteSourceRef(reconciled.source_id, rawActivity.source_url);
  reconciled.source = sourceRef.source;
  reconciled.source_key = sourceRef.source_key;
  reconciled.source_url = sourceRef.source_url;
  reconciled.raw_source_url = sourceRef.raw_source_url;
  reconciled.verified = true;
  reconciled.sources = [sourceRef];

  return reconciled;
}

/**
 * Executes the Organizer website Firecrawl drip sync pipeline.
 *
 * @param {object} [params={}]
 * @returns {Promise<object>}
 */
export async function runOrganizerWebsiteSync({
  adapter,
  firecrawlClient = null,
  geminiClient = null,
  cacheStore = null,
  options = {},
  logger = console
} = {}) {
  const dryRun = Boolean(options.dryRun);
  const refresh = Boolean(options.refresh);
  const force = Boolean(options.force);
  const maxDomains = options.maxDomains ?? DEFAULT_MAX_DOMAINS;
  const maxUrlsPerDomain = options.maxUrlsPerDomain ?? DEFAULT_MAX_URLS_PER_DOMAIN;
  const now = options.now instanceof Date ? options.now : (options.now ? new Date(options.now) : new Date());

  if (!firecrawlClient) {
    logger?.warn?.('[Organizer Website Sync] FIRECRAWL_LOCAL_URL is unset or Firecrawl client is disabled; skipping run cleanly.');
    return {
      firecrawlAvailable: false,
      skippedReason: 'firecrawl_unconfigured',
      dryRun,
      eligibleDomains: 0,
      processedDomains: 0,
      mappedUrls: 0,
      scrapedUrls: 0,
      failedDomains: 0,
      llmFallbackCalls: 0,
      extractedCount: 0,
      validCount: 0,
      upsertedCount: 0,
      deletedCount: 0,
      prunedCount: 0,
      wouldDeleteIds: [],
      wouldPruneIds: []
    };
  }

  const [organizersCatalog, venuesCatalog, initialActivities] = await Promise.all([
    adapter?.scanOrganizers ? adapter.scanOrganizers() : [],
    adapter?.scanVenues ? adapter.scanVenues() : [],
    Array.isArray(options.existingActivities)
      ? options.existingActivities
      : (adapter?.scanActivities ? adapter.scanActivities() : [])
  ]);

  let activitiesCatalog = initialActivities.map(a => ({ ...a }));

  const directorySources = Array.isArray(options.directorySources)
    ? options.directorySources
    : (options.harvestDirectories && !options.organizer ? DEFAULT_DIRECTORY_SOURCES : []);

  let harvestedDomains = [];
  if (directorySources.length > 0) {
    const harvestResult = await harvestDirectoryDomains({
      directorySources,
      firecrawlClient,
      cacheStore,
      organizersCatalog,
      now,
      dryRun,
      refresh,
      force,
      logger
    });
    harvestedDomains = harvestResult.harvestedDomains;
  }

  const pdfTimetableSeeds = Array.isArray(options.pdfTimetableSeeds)
    ? options.pdfTimetableSeeds
    : (options.includePdfSeeds && !options.organizer ? DEFAULT_PDF_TIMETABLE_SEEDS : []);

  const targets = await selectDripOrganizerTargets({
    organizersCatalog,
    activitiesCatalog,
    harvestedDomains,
    pdfTimetableSeeds,
    cacheStore,
    now,
    force,
    refresh,
    organizerId: options.organizer,
    maxDomains
  });

  let processedDomains = 0;
  let mappedUrls = 0;
  let scrapedUrls = 0;
  let failedDomains = 0;
  let llmFallbackCalls = 0;
  let extractedCount = 0;
  const validActivities = [];
  const cleanUrlSourceKeys = new Map();

  try {
    for (const target of targets) {
      processedDomains += 1;
      let candidateUrls = [target.websiteUrl];

      if (!target.isPdfSeed && !isPdfUrl(target.websiteUrl)) {
        try {
          const mapResult = await firecrawlClient.map(target.websiteUrl, {
            refresh,
            cacheTtlMs: DEFAULT_MAP_CACHE_TTL_MS
          });
          candidateUrls = filterCandidateUrls(mapResult?.links || [], target.websiteUrl, {
            maxUrls: maxUrlsPerDomain
          });
        } catch (err) {
          logger?.warn?.(`[Organizer Website Sync] /v2/map failed for ${target.websiteUrl}, falling back to homepage: ${err.message}`);
        }
      }

      mappedUrls += candidateUrls.length;
      let domainYield = 0;
      let domainHadScrapeSuccess = false;

      for (const candidateUrl of candidateUrls) {
        try {
          const scrapeOptions = isPdfUrl(candidateUrl)
            ? {
                formats: ['markdown'],
                onlyMainContent: false,
                refresh,
                timeoutMs: options.pdfScrapeTimeoutMs ?? DEFAULT_PDF_SCRAPE_TIMEOUT_MS
              }
            : {
                formats: ['html', 'markdown'],
                onlyMainContent: false,
                refresh
              };
          const scraped = await firecrawlClient.scrape(candidateUrl, scrapeOptions);
          scrapedUrls += 1;
          domainHadScrapeSuccess = true;

          let llmFailed = false;
          let rawActivities = extractOrganizerWebsiteActivities(scraped?.html || '', {
            scrapedUrl: candidateUrl,
            organizer: target.organizer,
            now
          });
          if (rawActivities.length === 0 && geminiClient && typeof scraped?.markdown === 'string' && scraped.markdown.trim()) {
            llmFallbackCalls += 1;
            try {
              rawActivities = await extractMarkdownActivities({
                markdown: scraped.markdown,
                scrapedUrl: candidateUrl,
                organizer: target.organizer,
                geminiClient,
                now,
                logger,
                throwOnError: true
              });
            } catch {
              llmFailed = true;
              rawActivities = [];
            }
          }
          extractedCount += rawActivities.length;

          const urlSourceKeys = new Set();
          for (const rawActivity of rawActivities) {
            const ingested = ingestWebsiteActivity(rawActivity, {
              venuesCatalog,
              organizersCatalog,
              target
            });
            if (ingested) {
              validActivities.push(ingested);
              domainYield += 1;
              const sourceKey = ingested.source_key || ingested.sources?.[0]?.source_key || rawActivity.source_key;
              if (sourceKey) {
                urlSourceKeys.add(sourceKey);
              }
            }
          }

          if (!llmFailed && urlSourceKeys.size > 0) {
            const existingKeys = cleanUrlSourceKeys.get(candidateUrl) || new Set();
            for (const key of urlSourceKeys) {
              existingKeys.add(key);
            }
            cleanUrlSourceKeys.set(candidateUrl, existingKeys);
          }
        } catch (err) {
          logger?.warn?.(`[Organizer Website Sync] Scrape failed for ${candidateUrl}: ${err.message}`);
        }
      }

      if (!domainHadScrapeSuccess) {
        failedDomains += 1;
      } else if (!dryRun && cacheStore) {
        await cacheStore.write(checkpointKeyForWebsite(target.websiteUrl), {
          organizerId: target.organizer.id,
          organizerName: target.organizer.name,
          isHarvestedDomain: Boolean(target.isHarvestedDomain),
          websiteUrl: target.websiteUrl,
          lastCrawledAt: now.toISOString(),
          lastYieldCount: domainYield,
          mappedUrls: candidateUrls
        });
      }
    }
  } finally {
    await cacheStore?.flush?.();
    await firecrawlClient?.flushCache?.();
  }

  const dedupedActivities = validActivities.length > 0
    ? deduplicateActivities(validActivities, activitiesCatalog).activitiesToUpsert
    : [];
  const dedupedIds = new Set(dedupedActivities.filter(a => a?.id).map(a => a.id));

  const staleReconciliation = reconcileStaleWeeklyActivities({
    existingActivities: activitiesCatalog,
    cleanUrlSourceKeys
  });
  const prunedToApply = staleReconciliation.prunedActivities.filter(a => a?.id && !dedupedIds.has(a.id));
  const deleteIds = staleReconciliation.deleteIds.filter(id => id && !dedupedIds.has(id));
  const allUpdates = [...dedupedActivities, ...prunedToApply];

  let upsertedCount = 0;
  let deletedCount = 0;
  let prunedCount = 0;

  if (!dryRun) {
    if (deleteIds.length > 0 && adapter?.batchApplyActivityDeduplication) {
      const writeRes = await adapter.batchApplyActivityDeduplication({
        updates: allUpdates,
        deleteIds
      });
      upsertedCount = writeRes?.updated ?? allUpdates.length;
      deletedCount = writeRes?.deleted ?? deleteIds.length;
      prunedCount = prunedToApply.length;
    } else {
      if (deleteIds.length > 0) {
        logger?.warn?.(`[Organizer Website Sync] Adapter lacks batchApplyActivityDeduplication; skipping ${deleteIds.length} stale weekly deletion(s).`);
      }
      if (allUpdates.length > 0 && adapter?.batchUpsertActivities) {
        const writeRes = await adapter.batchUpsertActivities(allUpdates);
        upsertedCount = writeRes?.upserted ?? allUpdates.length;
        prunedCount = prunedToApply.length;
      }
    }
  }

  const staleLogSummary = dryRun
    ? `WouldDelete: ${deleteIds.length}, WouldPrune: ${prunedToApply.length}`
    : `Deleted: ${deletedCount}, Pruned: ${prunedCount}`;
  logger?.log?.(
    `[Organizer Website Sync] Domains: ${processedDomains}/${targets.length}, Mapped: ${mappedUrls}, Scraped: ${scrapedUrls}, Extracted: ${extractedCount}, Valid: ${validActivities.length}, Upserted: ${upsertedCount}, ${staleLogSummary} (dryRun=${dryRun})`
  );

  return {
    firecrawlAvailable: true,
    skippedReason: null,
    dryRun,
    harvestedDomainsCount: harvestedDomains.length,
    eligibleDomains: targets.length,
    processedDomains,
    mappedUrls,
    scrapedUrls,
    failedDomains,
    llmFallbackCalls,
    extractedCount,
    validCount: validActivities.length,
    upsertedCount,
    deletedCount,
    prunedCount,
    wouldDeleteIds: dryRun ? deleteIds : [],
    wouldPruneIds: dryRun ? prunedToApply.map(a => a.id) : []
  };
}

/**
 * Main CLI entry point for Organizer website drip sync.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @param {object} [options={}]
 * @returns {Promise<object>}
 */
export async function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  if (env === process.env || options.envFilePath) {
    await loadDotEnv(options.envFilePath, env);
  }

  const parsedArgs = parseCliArgs(argv, env);
  const logger = resolveCliLogger('organizer-website-sync.log', argv, options, env);

  const firecrawlClient = options.firecrawlClient !== undefined
    ? options.firecrawlClient
    : (parsedArgs.firecrawlUrl
        ? createFirecrawlClientFromEnv(env, {
            baseUrl: parsedArgs.firecrawlUrl,
            fetchFn: options.fetchFn,
            logger
          })
        : null);

  if (!firecrawlClient) {
    return runOrganizerWebsiteSync({
      adapter: options.adapter || null,
      firecrawlClient: null,
      options: parsedArgs,
      logger
    });
  }

  let adapter = options.adapter;
  let effectiveDryRun = parsedArgs.dryRun;

  if (!adapter) {
    const firestoreEnv = options.firestoreEnv || await initFirestoreFromEnv(env, {
      requireCredentials: !parsedArgs.dryRun && !parsedArgs.useAdc,
      useAdc: parsedArgs.useAdc,
      projectId: parsedArgs.project
    });
    effectiveDryRun = parsedArgs.dryRun || firestoreEnv.dryRun;
    adapter = createFirestoreAdapter({
      db: firestoreEnv.db,
      dryRun: effectiveDryRun
    });
  }

  const cacheStore = options.cacheStore || createFileCacheStore(DEFAULT_ORGANIZER_WEBSITE_CACHE_PATH, { flushEvery: 10 });
  const geminiClient = options.geminiClient !== undefined
    ? options.geminiClient
    : createGeminiFlashClientFromEnv(env, {
        fetchFn: options.fetchFn,
        logger
      });

  return runOrganizerWebsiteSync({
    adapter,
    firecrawlClient,
    geminiClient,
    cacheStore,
    options: {
      ...parsedArgs,
      dryRun: effectiveDryRun
    },
    logger
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[Organizer Website Sync] Fatal error:', err);
    process.exitCode = 1;
  });
}
