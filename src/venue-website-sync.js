/**
 * Firecrawl Major-Venue Calendar Sync CLI (ADR 0015)
 * Scrapes official "What's On" index pages for curated Greater Perth major Venues
 * via the local Firecrawl sidecar using deterministic Schema.org Event JSON-LD first
 * and Gemini Flash Markdown extraction as fallback, emitting discrete dated Activities
 * anchored to canonical Venues with `source: 'venue_website'` and `verified: true`.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateDistanceKm } from '../public/shared/discovery-engine.js';
import { deduplicateActivities } from './activity-deduplicator.js';
import { resolveCliLogger } from './crawler-reporter.js';
import {
  anchorAwstTimestamp,
  extractJsonLdActivities,
  parseActivityCost
} from './crawlers/eventbrite-parser.js';
import { matchVenueByNameOnly, matchVenueCandidate } from './entity-matcher.js';
import { createFileCacheStore } from './file-cache.js';
import { createFirecrawlClientFromEnv } from './firecrawl-client.js';
import { createFirestoreAdapter, initFirestoreFromEnv } from './firestore-adapter.js';
import { createGeminiFlashClientFromEnv } from './gemini-flash-client.js';
import { encodeGeohash } from './geohash.js';
import { MAJOR_VENUE_SEEDS, findMajorVenueSeed } from './major-venue-seeds.js';
import {
  MAX_HORIZON_MS,
  buildDeterministicSourceId,
  buildWebsiteSourceRef,
  extractMarkdownActivities,
  resolvePreferredActivityUrl
} from './markdown-activity-extractor.js';
import {
  DEFAULT_DETAIL_CACHE_TTL_MS,
  DEFAULT_MAX_DETAIL_SCRAPES_PER_RUN,
  expandVenueActivitiesWithDetailFanOut,
  isDirectTicketingUrl
} from './venue-detail-fanout.js';
import { loadDotEnv } from './places-sync.js';
import {
  CANONICAL_CATEGORIES,
  extractCanonicalEntities,
  normalizeCategory,
  normalizeSport,
  parseSchedule,
  sanitizeActivity,
  slugify
} from './sanitizer.js';

export const VENUE_WEBSITE_SOURCE = 'venue_website';
export const DEFAULT_VENUE_WEBSITE_CACHE_PATH = path.resolve(
  process.cwd(),
  '.scratch/venue-website-sync-cache.json'
);
export const DEFAULT_VENUE_COOLDOWN_DAYS = 2;
export const DEFAULT_VENUE_COOLDOWN_MS = DEFAULT_VENUE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
export const VENUE_COOLDOWN_KEY_PREFIX = 'venue_sync|';

const SCHEMA_TYPE_TO_CATEGORY = Object.freeze({
  sportsevent: 'sports',
  musicevent: 'music',
  foodevent: 'food',
  theaterevent: 'arts',
  danceevent: 'arts',
  comedyevent: 'arts',
  visualartsevent: 'arts',
  exhibitionevent: 'arts',
  literaryevent: 'arts',
  screeningevent: 'arts',
  childrensevent: 'family',
  educationevent: 'family',
  socialevent: 'community',
  festival: 'community'
});

const TEXT_CATEGORY_RULES = [
  { category: 'health', pattern: /\b(yoga|pilates|meditation|breathwork|wellness|mindfulness|tai chi|wellbeing)\b/i },
  { category: 'music', pattern: /\b(music|concert|choir|band|symphony|orchestra|jazz|acoustic|dj|concert\s+tour|live in concert)\b/i },
  { category: 'arts', pattern: /\b(art|arts|theatre|theater|comedy|ballet|opera|musical|cabaret|circus|gallery|exhibition|play)\b/i },
  { category: 'family', pattern: /\b(kids|children|family|toddler|pantomime|disney|wiggles|school holiday)\b/i },
  { category: 'food', pattern: /\b(wine|food|dinner|tasting|brunch|cooking|supper|feast|beer|gin|whisky|culinary)\b/i },
  { category: 'hobbies', pattern: /\b(board\s*games?|chess|expo|comic\s*con|craft|pottery|book\s*club|photography)\b/i },
  { category: 'travel', pattern: /\b(hike|hiking|trail|tour|expedition|outdoor\s+adventure)\b/i },
  { category: 'community', pattern: /\b(community|festival|market|charity|gala|civic|forum|conference)\b/i }
];

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
 * Parses CLI arguments for the major-venue calendar sync CLI.
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

  const maxDetailScrapes = parseIntArg(
    getArgValue(argv, 'max-detail-scrapes'),
    DEFAULT_MAX_DETAIL_SCRAPES_PER_RUN,
    0
  );
  const detailCacheTtlDays = parseIntArg(
    getArgValue(argv, 'detail-cache-ttl-days'),
    Math.round(DEFAULT_DETAIL_CACHE_TTL_MS / (24 * 60 * 60 * 1000)),
    1
  );
  const cooldownDays = parseIntArg(
    getArgValue(argv, 'cooldown-days'),
    DEFAULT_VENUE_COOLDOWN_DAYS,
    0
  );

  return {
    dryRun: !apply,
    refresh: argv.includes('--refresh'),
    force: argv.includes('--force'),
    venue: getArgValue(argv, 'venue'),
    maxDetailScrapes,
    detailCacheTtlMs: detailCacheTtlDays * 24 * 60 * 60 * 1000,
    venueCooldownMs: cooldownDays * 24 * 60 * 60 * 1000,
    useAdc: argv.includes('--use-adc') || Boolean(env.FIREBASE_USE_ADC),
    project: getArgValue(argv, 'project') || env.FIREBASE_PROJECT_ID || 'myplaydex',
    firecrawlUrl
  };
}

/**
 * Selects all seeded Venues or filters to a single matching Venue seed.
 *
 * @param {Array<object>} [seeds=MAJOR_VENUE_SEEDS]
 * @param {string} [venueFilter]
 * @returns {Array<object>}
 */
export function selectVenueSeeds(seeds = MAJOR_VENUE_SEEDS, venueFilter = undefined) {
  if (!venueFilter || typeof venueFilter !== 'string' || !venueFilter.trim()) {
    return Array.isArray(seeds) ? [...seeds] : [];
  }
  const matched = findMajorVenueSeed(venueFilter, seeds);
  return matched ? [matched] : [];
}

function getSchemaTypeList(type) {
  if (Array.isArray(type)) {
    return type.filter(t => typeof t === 'string').map(t => t.trim());
  }
  if (typeof type === 'string' && type.trim()) {
    return [type.trim()];
  }
  return [];
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

function parseAwstTimestampMs(rawTimestamp) {
  if (!rawTimestamp) return NaN;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(rawTimestamp);
  return Date.parse(isDateOnly ? `${rawTimestamp}T23:59:59+08:00` : rawTimestamp);
}

function resolveVenueActivityCategory({ rawCategory, schemaTypes = [], title = '', description = '', defaultCategory = 'community' }) {
  if (typeof rawCategory === 'string' && rawCategory.trim()) {
    const explicit = normalizeCategory(rawCategory, { defaultCategory: null });
    if (explicit && CANONICAL_CATEGORIES.includes(explicit)) {
      return explicit;
    }
  }

  for (const typeName of schemaTypes) {
    const mapped = SCHEMA_TYPE_TO_CATEGORY[typeName.toLowerCase()];
    if (mapped) {
      return mapped;
    }
  }

  const combined = `${title} ${description}`.trim();
  if (normalizeSport(combined) !== 'other') {
    return 'sports';
  }
  for (const rule of TEXT_CATEGORY_RULES) {
    if (rule.pattern.test(combined)) {
      return rule.category;
    }
  }

  return normalizeCategory(defaultCategory, { defaultCategory: 'community' });
}

function pickVenueOutboundUrl(item = {}, scrapedUrl) {
  const candidates = [];
  const offers = Array.isArray(item.offers) ? item.offers : (item.offers ? [item.offers] : []);
  for (const offer of offers) {
    if (typeof offer?.url === 'string' && offer.url.trim()) {
      candidates.push(offer.url);
    }
  }
  if (typeof item.url === 'string' && item.url.trim()) {
    candidates.push(item.url);
  }

  const resolvedCandidates = [];
  for (const candidate of candidates) {
    const resolved = resolvePreferredActivityUrl(candidate, scrapedUrl);
    if (resolved && resolved !== scrapedUrl) {
      resolvedCandidates.push(resolved);
    }
  }

  const directTicket = resolvedCandidates.find(url => isDirectTicketingUrl(url, scrapedUrl));
  if (directTicket) {
    return directTicket;
  }

  return resolvedCandidates[0] || scrapedUrl;
}

function flattenVenueJsonLdItems(jsonLdActivities = []) {
  const flattened = [];
  for (const item of jsonLdActivities) {
    if (!item || typeof item !== 'object') continue;
    const subEvents = Array.isArray(item.subEvent)
      ? item.subEvent
      : (item.subEvent && typeof item.subEvent === 'object' ? [item.subEvent] : []);

    if (subEvents.length > 0) {
      for (const sub of subEvents) {
        if (!sub || typeof sub !== 'object') continue;
        flattened.push({
          ...sub,
          '@type': sub['@type'] || item['@type'],
          name: sub.name || item.name,
          description: sub.description ?? item.description,
          category: sub.category ?? item.category,
          url: sub.url || item.url,
          offers: sub.offers || item.offers,
          eventAttendanceMode: sub.eventAttendanceMode || item.eventAttendanceMode,
          location: sub.location || item.location
        });
      }
    } else {
      flattened.push(item);
    }
  }
  return flattened;
}

/**
 * Extracts discrete dated Schema.org Event JSON-LD Activity candidates from a
 * major Venue "What's On" HTML page, enforcing the 6-month horizon and past/cancelled/online drops.
 *
 * @param {string} [html='']
 * @param {object} [params={}]
 * @returns {Array<object>}
 */
export function extractVenueJsonLdActivities(html = '', { scrapedUrl, venueSeed = null, now = new Date() } = {}) {
  if (!html || typeof html !== 'string' || !scrapedUrl) {
    return [];
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const nowIso = new Date(nowMs).toISOString();
  const maxFutureMs = nowMs + MAX_HORIZON_MS;
  const jsonLdActivities = flattenVenueJsonLdItems(extractJsonLdActivities(html));
  const results = [];

  for (const item of jsonLdActivities) {
    if (!item || typeof item !== 'object') continue;

    const title = typeof item.name === 'string' ? item.name.trim() : '';
    if (!title) continue;
    if (/Event(?:Cancelled|Postponed)/i.test(String(item.eventStatus || ''))) continue;
    if (isOnlineOnlyJsonLd(item)) continue;

    const startDate = anchorAwstTimestamp(item.startDate);
    if (!startDate) continue;

    const startMs = parseAwstTimestampMs(startDate);
    if (!Number.isFinite(startMs) || startMs > maxFutureMs) continue;

    const endDate = anchorAwstTimestamp(item.endDate);
    const effectiveEndMs = endDate ? parseAwstTimestampMs(endDate) : startMs;
    if ((Number.isFinite(effectiveEndMs) ? effectiveEndMs : startMs) < nowMs) continue;

    const startDateOnly = startDate.slice(0, 10);
    const endDateOnly = endDate ? endDate.slice(0, 10) : startDateOnly;
    const startTimeMatch = startDate.match(/T(\d{2}:\d{2})/);
    const endTimeMatch = endDate ? endDate.match(/T(\d{2}:\d{2})/) : null;
    const schedule = parseSchedule({
      recurrence: 'none',
      start_date: startDateOnly,
      end_date: endDateOnly,
      ...(startTimeMatch ? { start_time: startTimeMatch[1] } : {}),
      ...(endTimeMatch ? { end_time: endTimeMatch[1] } : {})
    }, nowIso);
    const description = typeof item.description === 'string' ? item.description.trim() : '';
    const category = resolveVenueActivityCategory({
      rawCategory: item.category,
      schemaTypes: getSchemaTypeList(item['@type']),
      title,
      description,
      defaultCategory: venueSeed?.defaultCategory || 'community'
    });
    const pricing = parseActivityCost({ jsonLd: item });
    const sourceId = buildDeterministicSourceId(scrapedUrl, title, startDate);
    const outboundUrl = pickVenueOutboundUrl(item, scrapedUrl);
    const resolvedItemUrl = typeof item.url === 'string'
      ? resolvePreferredActivityUrl(item.url, scrapedUrl)
      : null;
    const detailUrl = resolvedItemUrl && resolvedItemUrl !== scrapedUrl
      ? resolvedItemUrl
      : undefined;
    const sourceRef = buildWebsiteSourceRef(sourceId, outboundUrl, VENUE_WEBSITE_SOURCE);
    const hasStartTime = /T\d{2}:\d{2}/.test(startDate);

    results.push({
      ...sourceRef,
      sources: [sourceRef],
      source_keys: [sourceRef.source_key],
      title,
      description,
      category,
      subcategory: normalizeSport(`${title} ${description}`),
      start_date: startDate,
      ...(endDate ? { end_date: endDate } : {}),
      schedule,
      venue_name: venueSeed?.name || undefined,
      venue_address: venueSeed?.address || undefined,
      is_free: pricing.isFree,
      cost_description: pricing.displayPrice,
      ...(detailUrl ? { _detailUrl: detailUrl } : {}),
      _missingStartTime: !hasStartTime
    });
  }

  return results;
}

function toCanonicalVenue(matched) {
  return {
    id: matched.id,
    name: matched.name,
    coordinates: matched.coordinates,
    geohash: matched.geohash || encodeGeohash(matched.coordinates.lat, matched.coordinates.lng, 9),
    google_place_id: matched.google_place_id || null
  };
}

const MAX_SEED_NAME_FALLBACK_KM = 2.0;

/**
 * Resolves a seeded major Venue to its canonical `/venues` catalog record,
 * rejecting uncertain neighbor matches and falling back to the seed's verified coordinates.
 *
 * @param {object} venueSeed
 * @param {Array<object>} [venuesCatalog=[]]
 * @returns {object}
 */
export function resolveCanonicalVenueForSeed(venueSeed, venuesCatalog = []) {
  const namesToTry = [venueSeed.name, ...(Array.isArray(venueSeed.aliases) ? venueSeed.aliases : [])];

  for (const candidateName of namesToTry) {
    const coordMatch = matchVenueCandidate(
      { name: candidateName, coordinates: venueSeed.coordinates },
      venuesCatalog
    );
    if (coordMatch.status === 'matched' && coordMatch.candidate?.coordinates) {
      return toCanonicalVenue(coordMatch.candidate);
    }
  }

  for (const candidateName of namesToTry) {
    const nameMatch = matchVenueByNameOnly(candidateName, venuesCatalog);
    if (
      nameMatch.status === 'matched' &&
      nameMatch.candidate?.coordinates &&
      calculateDistanceKm(venueSeed.coordinates, nameMatch.candidate.coordinates) <= MAX_SEED_NAME_FALLBACK_KM
    ) {
      return toCanonicalVenue(nameMatch.candidate);
    }
  }

  const geohash = encodeGeohash(venueSeed.coordinates.lat, venueSeed.coordinates.lng, 9);
  const slug = slugify(venueSeed.slug || venueSeed.name) || 'venue';
  return {
    id: `venue_${slug}_${geohash.slice(0, 6)}`,
    name: venueSeed.name,
    coordinates: { lat: venueSeed.coordinates.lat, lng: venueSeed.coordinates.lng },
    geohash,
    google_place_id: null
  };
}

/**
 * Anchors a raw extracted Venue Activity to its canonical Venue without creating
 * Organizer documents or setting `unmatched_organizer` review flags.
 *
 * @param {object} rawActivity
 * @param {object} [params={}]
 * @returns {object|null}
 */
export function ingestVenueActivity(rawActivity, { venueSeed, venuesCatalog = [] } = {}) {
  if (!rawActivity || !venueSeed) {
    return null;
  }

  const canonicalVenue = resolveCanonicalVenueForSeed(venueSeed, venuesCatalog);
  const category = normalizeCategory(
    rawActivity.category || venueSeed.defaultCategory,
    { defaultCategory: venueSeed.defaultCategory || 'community' }
  );

  const sanitized = sanitizeActivity({
    ...rawActivity,
    region_id: venueSeed.regionId || 'perth',
    source: VENUE_WEBSITE_SOURCE,
    category,
    coordinates: canonicalVenue.coordinates,
    geohash: canonicalVenue.geohash,
    venue: canonicalVenue,
    venue_name: canonicalVenue.name,
    address: rawActivity.venue_address || venueSeed.address,
    verified: true
  });

  // Venue-anchored Activities do not synthesize or link local Organizer records.
  sanitized.organizer = null;
  if (canonicalVenue.google_place_id) {
    sanitized.venue.google_place_id = canonicalVenue.google_place_id;
  }

  if (rawActivity._missingStartTime) {
    sanitized.needs_review = true;
    sanitized.review_reason = 'missing_start_time';
  } else if (rawActivity._lowConfidence) {
    sanitized.needs_review = true;
    sanitized.review_reason = 'low_confidence';
  } else {
    sanitized.needs_review = false;
    sanitized.review_reason = null;
  }

  const sourceRef = buildWebsiteSourceRef(
    sanitized.source_id,
    rawActivity.source_url || venueSeed.whatsOnUrl,
    VENUE_WEBSITE_SOURCE
  );
  sanitized.source = sourceRef.source;
  sanitized.source_key = sourceRef.source_key;
  sanitized.source_url = sourceRef.source_url;
  sanitized.raw_source_url = sourceRef.raw_source_url;
  sanitized.verified = true;
  sanitized.sources = [sourceRef];
  sanitized.source_keys = [sourceRef.source_key];

  const entities = extractCanonicalEntities(sanitized, {
    ...rawActivity,
    address: venueSeed.address,
    venue: canonicalVenue
  });
  entities.organizer = null;

  Object.defineProperty(sanitized, '_canonicalEntities', {
    value: entities,
    enumerable: false,
    configurable: true,
    writable: true
  });

  return sanitized;
}

/**
 * Returns true if a Venue's last sync checkpoint is still within the configured cooldown window.
 *
 * @param {object | null | undefined} checkpoint
 * @param {object} [params={}]
 * @returns {boolean}
 */
export function isVenueWithinCooldown(checkpoint, {
  now = new Date(),
  cooldownMs = DEFAULT_VENUE_COOLDOWN_MS,
  force = false,
  refresh = false
} = {}) {
  if (force || refresh || !Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    return false;
  }
  const lastSyncedAt = checkpoint?.lastSyncedAt;
  if (typeof lastSyncedAt !== 'string' || !lastSyncedAt.trim()) {
    return false;
  }
  const lastSyncedMs = Date.parse(lastSyncedAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(lastSyncedMs) || !Number.isFinite(nowMs)) {
    return false;
  }
  return (nowMs - lastSyncedMs) < cooldownMs;
}

function buildSyncSummary(overrides = {}) {
  return {
    firecrawlAvailable: true,
    skippedReason: null,
    dryRun: true,
    selectedVenues: 0,
    skippedCooldownVenues: 0,
    processedVenues: 0,
    failedVenues: 0,
    llmFallbackCalls: 0,
    detailCandidates: 0,
    detailCacheHits: 0,
    detailScrapesAttempted: 0,
    detailScrapesFailed: 0,
    detailScrapesCapped: 0,
    detailExpandedCount: 0,
    extractedCount: 0,
    validCount: 0,
    upsertedCount: 0,
    ...overrides
  };
}

/**
 * Executes the major-venue calendar sync pipeline across selected Venue seeds.
 *
 * @param {object} [params={}]
 * @returns {Promise<object>}
 */
export async function runVenueWebsiteSync({
  adapter,
  firecrawlClient = null,
  geminiClient = null,
  cacheStore = null,
  detailCacheStore = null,
  seeds = MAJOR_VENUE_SEEDS,
  options = {},
  logger = console
} = {}) {
  const dryRun = Boolean(options.dryRun);
  const refresh = Boolean(options.refresh);
  const force = Boolean(options.force);
  const maxDetailScrapes = Number.isFinite(options.maxDetailScrapes) && options.maxDetailScrapes >= 0
    ? options.maxDetailScrapes
    : DEFAULT_MAX_DETAIL_SCRAPES_PER_RUN;
  const detailCacheTtlMs = Number.isFinite(options.detailCacheTtlMs) && options.detailCacheTtlMs >= 0
    ? options.detailCacheTtlMs
    : DEFAULT_DETAIL_CACHE_TTL_MS;
  const venueCooldownMs = Number.isFinite(options.venueCooldownMs) && options.venueCooldownMs >= 0
    ? options.venueCooldownMs
    : DEFAULT_VENUE_COOLDOWN_MS;
  const effectiveCacheStore = cacheStore ?? options.cacheStore ?? detailCacheStore ?? options.detailCacheStore ?? null;
  const effectiveDetailCacheStore = detailCacheStore ?? options.detailCacheStore ?? effectiveCacheStore;
  const now = options.now instanceof Date ? options.now : (options.now ? new Date(options.now) : new Date());

  if (!firecrawlClient) {
    logger?.warn?.('[Venue Website Sync] FIRECRAWL_LOCAL_URL is unset or Firecrawl client is disabled; skipping run cleanly.');
    return buildSyncSummary({
      firecrawlAvailable: false,
      skippedReason: 'firecrawl_unconfigured',
      dryRun
    });
  }

  const selectedSeeds = selectVenueSeeds(seeds, options.venue);
  if (options.venue && selectedSeeds.length === 0) {
    logger?.warn?.(`[Venue Website Sync] No seeded major Venue matched filter "${options.venue}".`);
    return buildSyncSummary({
      skippedReason: 'venue_not_found',
      dryRun
    });
  }

  const [venuesCatalog, existingActivities] = await Promise.all([
    adapter?.scanVenues ? adapter.scanVenues() : [],
    Array.isArray(options.existingActivities)
      ? options.existingActivities
      : (adapter?.scanActivities ? adapter.scanActivities() : [])
  ]);

  let skippedCooldownVenues = 0;
  let processedVenues = 0;
  let failedVenues = 0;
  let llmFallbackCalls = 0;
  const detailStats = {
    detailCandidates: 0,
    detailCacheHits: 0,
    detailScrapesAttempted: 0,
    detailScrapesFailed: 0,
    detailScrapesCapped: 0,
    detailExpandedCount: 0
  };
  let extractedCount = 0;
  const validActivities = [];
  const fanOutState = { scrapesUsed: 0, inRunCache: new Map() };

  try {
    for (const venueSeed of selectedSeeds) {
      const cooldownKey = `${VENUE_COOLDOWN_KEY_PREFIX}${venueSeed.slug}`;
      const checkpoint = effectiveCacheStore ? await effectiveCacheStore.read(cooldownKey) : null;
      if (isVenueWithinCooldown(checkpoint, { now, cooldownMs: venueCooldownMs, force, refresh })) {
        skippedCooldownVenues += 1;
        logger?.log?.(`[Venue Website Sync] Skipping ${venueSeed.name} (within refresh cooldown; last synced ${checkpoint.lastSyncedAt}).`);
        continue;
      }

      processedVenues += 1;
      const shouldRefreshIndex = refresh || force || Boolean(checkpoint?.lastSyncedAt);
      try {
        const scraped = await firecrawlClient.scrape(venueSeed.whatsOnUrl, {
          formats: ['html', 'markdown'],
          onlyMainContent: false,
          refresh: shouldRefreshIndex
        });

        let rawActivities = extractVenueJsonLdActivities(scraped?.html || '', {
          scrapedUrl: venueSeed.whatsOnUrl,
          venueSeed,
          now
        });

        if (
          rawActivities.length === 0
          && geminiClient
          && typeof scraped?.markdown === 'string'
          && scraped.markdown.trim()
        ) {
          llmFallbackCalls += 1;
          const markdownActivities = await extractMarkdownActivities({
            markdown: scraped.markdown,
            scrapedUrl: venueSeed.whatsOnUrl,
            organizer: null,
            venueName: venueSeed.name,
            source: VENUE_WEBSITE_SOURCE,
            geminiClient,
            now,
            logger
          });
          rawActivities = markdownActivities
            .filter(item => item?.schedule?.recurrence === 'none' && Boolean(item?.schedule?.start_date))
            .map(item => ({
              ...item,
              category: item.category || venueSeed.defaultCategory
            }));
        }

        const fanOutResult = await expandVenueActivitiesWithDetailFanOut({
          rawActivities,
          venueSeed,
          firecrawlClient,
          geminiClient,
          detailCacheStore: effectiveDetailCacheStore,
          extractVenueJsonLdActivities,
          now,
          refresh,
          maxDetailScrapes,
          detailCacheTtlMs,
          state: fanOutState,
          logger
        });

        rawActivities = fanOutResult.activities;
        llmFallbackCalls += fanOutResult.stats.llmFallbackCalls;
        for (const key of Object.keys(detailStats)) {
          detailStats[key] += fanOutResult.stats[key] || 0;
        }

        extractedCount += rawActivities.length;

        for (const rawActivity of rawActivities) {
          const ingested = ingestVenueActivity(rawActivity, { venueSeed, venuesCatalog });
          if (ingested) {
            validActivities.push(ingested);
          }
        }

        if (!dryRun && effectiveCacheStore) {
          await effectiveCacheStore.write(cooldownKey, {
            slug: venueSeed.slug,
            name: venueSeed.name,
            whatsOnUrl: venueSeed.whatsOnUrl,
            lastSyncedAt: now.toISOString(),
            extractedCount: rawActivities.length
          });
        }
      } catch (err) {
        failedVenues += 1;
        logger?.warn?.(`[Venue Website Sync] Scrape failed for ${venueSeed.name} (${venueSeed.whatsOnUrl}): ${err.message}`);
      }
    }
  } finally {
    await firecrawlClient?.flushCache?.();
    await effectiveDetailCacheStore?.flush?.();
    if (effectiveCacheStore && effectiveCacheStore !== effectiveDetailCacheStore) {
      await effectiveCacheStore.flush?.();
    }
  }

  const dedupedActivities = validActivities.length > 0
    ? deduplicateActivities(validActivities, existingActivities).activitiesToUpsert
    : [];

  let upsertedCount = 0;
  if (!dryRun && dedupedActivities.length > 0 && adapter?.batchUpsertActivities) {
    const writeRes = await adapter.batchUpsertActivities(dedupedActivities);
    upsertedCount = writeRes?.upserted ?? dedupedActivities.length;
  }

  logger?.log?.(
    `[Venue Website Sync] Venues: ${processedVenues}/${selectedSeeds.length} (cooldownSkipped=${skippedCooldownVenues}), Failed: ${failedVenues}, LLM Fallbacks: ${llmFallbackCalls}, Detail Scrapes: ${detailStats.detailScrapesAttempted} (hits=${detailStats.detailCacheHits}, capped=${detailStats.detailScrapesCapped}, failed=${detailStats.detailScrapesFailed}), Extracted: ${extractedCount}, Valid: ${validActivities.length}, Upserted: ${upsertedCount} (dryRun=${dryRun})`
  );

  return buildSyncSummary({
    dryRun,
    selectedVenues: selectedSeeds.length,
    skippedCooldownVenues,
    processedVenues,
    failedVenues,
    llmFallbackCalls,
    ...detailStats,
    extractedCount,
    validCount: validActivities.length,
    upsertedCount
  });
}

/**
 * Main CLI entry point for major-venue calendar sync.
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
  const logger = resolveCliLogger('venue-website-sync.log', argv, options, env);

  const sharedCacheStore = options.cacheStore || createFileCacheStore(DEFAULT_VENUE_WEBSITE_CACHE_PATH, { flushEvery: 5 });
  const detailCacheStore = options.detailCacheStore !== undefined ? options.detailCacheStore : sharedCacheStore;

  const firecrawlClient = options.firecrawlClient !== undefined
    ? options.firecrawlClient
    : (parsedArgs.firecrawlUrl
        ? createFirecrawlClientFromEnv(env, {
            baseUrl: parsedArgs.firecrawlUrl,
            cacheStore: sharedCacheStore,
            cacheTtlMs: parsedArgs.venueCooldownMs,
            fetchFn: options.fetchFn,
            logger
          })
        : null);

  if (!firecrawlClient) {
    return runVenueWebsiteSync({
      adapter: options.adapter || null,
      firecrawlClient: null,
      cacheStore: sharedCacheStore,
      detailCacheStore,
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

  const geminiClient = options.geminiClient !== undefined
    ? options.geminiClient
    : createGeminiFlashClientFromEnv(env, {
        fetchFn: options.fetchFn,
        logger
      });

  return runVenueWebsiteSync({
    adapter,
    firecrawlClient,
    geminiClient,
    cacheStore: sharedCacheStore,
    detailCacheStore,
    options: {
      ...parsedArgs,
      dryRun: effectiveDryRun
    },
    logger
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[Venue Website Sync] Fatal error:', err);
    process.exitCode = 1;
  });
}
