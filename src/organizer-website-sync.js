/**
 * Firecrawl Organizer Website Drip Sync CLI
 * Selects prioritized Tier-1 Organizer websites, maps candidate activity/timetable URLs
 * via `/v2/map` (cached 14 days, capped at 3–5 URLs), scrapes via `firecrawl-local`,
 * extracts deterministic Schema.org Event JSON-LD Activity listings, and ingests them
 * through sanitization, entity matching, and deduplication with 7d/30d backoff (ADR 0013).
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deduplicateActivities } from './activity-deduplicator.js';
import { resolveCliLogger } from './crawler-reporter.js';
import {
  anchorAwstTimestamp,
  extractJsonLdActivities,
  formatSchemaAddress,
  parseActivityCost,
  resolvePerthCoordinates
} from './crawlers/eventbrite-parser.js';
import { reconcileListingWithCatalog } from './entity-matcher.js';
import { createFileCacheStore } from './file-cache.js';
import { createFirecrawlClientFromEnv } from './firecrawl-client.js';
import { createFirestoreAdapter, initFirestoreFromEnv } from './firestore-adapter.js';
import { loadDotEnv } from './places-sync.js';
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
const MAX_HORIZON_MS = 183 * 24 * 60 * 60 * 1000;

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
  const lowerPath = `${parsedUrl.pathname}${parsedUrl.search}`.toLowerCase();
  const isPdf = parsedUrl.pathname.toLowerCase().endsWith('.pdf');
  let keywordMatchIndex = -1;
  for (let i = 0; i < HIGH_SIGNAL_KEYWORDS.length; i++) {
    if (lowerPath.includes(HIGH_SIGNAL_KEYWORDS[i])) {
      keywordMatchIndex = i;
      break;
    }
  }
  if (keywordMatchIndex === -1 && !isPdf) {
    return null;
  }

  let score = isPdf ? 40 : 100 - keywordMatchIndex * 2;
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

/**
 * Selects and prioritizes eligible Organizer website targets for the drip run,
 * putting Tier-1 Organizers (0 active Activities, no Eventbrite/Meetup/Facebook Source Reference)
 * first and enforcing 7-day productive / 30-day zero-yield backoff.
 *
 * @param {object} [params={}]
 * @returns {Promise<Array<object>>}
 */
export async function selectDripOrganizerTargets({
  organizersCatalog = [],
  activitiesCatalog = [],
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
  for (const org of organizersCatalog) {
    if (!org || typeof org !== 'object') continue;
    if (organizerId && org.id !== organizerId) continue;

    const websiteUrl = normalizeWebsiteUrl(org.website);
    if (!websiteUrl) continue;

    const checkpoint = cacheStore ? await cacheStore.read(checkpointKeyForWebsite(websiteUrl)) : null;
    const lastCrawledAtMs = checkpoint?.lastCrawledAt ? Date.parse(checkpoint.lastCrawledAt) : -Infinity;
    const lastYieldCount = Number.isFinite(checkpoint?.lastYieldCount) ? checkpoint.lastYieldCount : null;

    if (!force && !refresh && Number.isFinite(lastCrawledAtMs)) {
      const cooldownMs = (lastYieldCount !== null && lastYieldCount > 0)
        ? productiveCooldownMs
        : zeroYieldBackoffMs;
      if ((nowMs - lastCrawledAtMs) < cooldownMs) {
        continue;
      }
    }

    const orgActivities = org.id ? (activitiesByOrgId.get(org.id) || []) : [];
    const activeActivityCount = orgActivities.filter(a => isActivityActive(a, nowMs)).length;
    const hasExternal = hasExternalPlatformSource(org, orgActivities);
    const tier = (activeActivityCount === 0 && !hasExternal) ? 1 : 2;

    eligible.push({
      organizer: org,
      websiteUrl,
      tier,
      activeActivityCount,
      hasExternalSource: hasExternal,
      lastCrawledAtMs,
      lastYieldCount
    });
  }

  eligible.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.lastCrawledAtMs !== b.lastCrawledAtMs) return a.lastCrawledAtMs - b.lastCrawledAtMs;
    return String(a.organizer.id || '').localeCompare(String(b.organizer.id || ''));
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

function buildDeterministicSourceId(scrapedUrl, title, startDate) {
  return createHash('sha256')
    .update(`${scrapedUrl}|${title}|${startDate}`)
    .digest('hex')
    .slice(0, 16);
}

function parseAwstTimestampMs(rawTimestamp) {
  if (!rawTimestamp) return NaN;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(rawTimestamp);
  return Date.parse(isDateOnly ? `${rawTimestamp}T23:59:59+08:00` : rawTimestamp);
}

function buildOrganizerWebsiteSourceRef(sourceId, scrapedUrl) {
  return {
    source: 'organizer_website',
    source_id: sourceId,
    source_key: `organizer_website_${sourceId}`,
    source_url: scrapedUrl,
    raw_source_url: scrapedUrl,
    verified: true
  };
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

function ingestWebsiteActivity(rawActivity, { venuesCatalog, organizersCatalog, organizer }) {
  const resolved = resolveActivityVenueAndCoordinates(rawActivity, {
    venuesCatalog,
    organizersCatalog,
    parentOrganizer: organizer
  });
  if (resolved.outOfArea) {
    return null;
  }

  const sanitized = sanitizeActivity({
    ...rawActivity,
    coordinates: resolved.coordinates,
    geohash: resolved.geohash,
    venue_name: resolved.venueOverride?.name || rawActivity.venue_name || rawActivity.title,
    organizer: organizer ? { id: organizer.id, name: organizer.name } : rawActivity.organizer
  });

  const reconciled = reconcileListingWithCatalog(
    sanitized,
    { venuesCatalog, organizersCatalog },
    'activity'
  );
  applyVenueResolution(reconciled, resolved, sanitized.venue);

  if (rawActivity._missingStartTime && !reconciled.needs_review) {
    reconciled.needs_review = true;
    reconciled.review_reason = 'missing_start_time';
  }

  const sourceRef = buildOrganizerWebsiteSourceRef(reconciled.source_id, rawActivity.source_url);
  reconciled.source = sourceRef.source;
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
      extractedCount: 0,
      validCount: 0,
      upsertedCount: 0
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

  const targets = await selectDripOrganizerTargets({
    organizersCatalog,
    activitiesCatalog,
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
  let extractedCount = 0;
  const validActivities = [];

  try {
    for (const target of targets) {
      processedDomains += 1;
      let candidateUrls = [target.websiteUrl];

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

      mappedUrls += candidateUrls.length;
      let domainYield = 0;
      let domainHadScrapeSuccess = false;

      for (const candidateUrl of candidateUrls) {
        try {
          const scraped = await firecrawlClient.scrape(candidateUrl, {
            formats: ['html'],
            onlyMainContent: false,
            refresh
          });
          scrapedUrls += 1;
          domainHadScrapeSuccess = true;

          const rawActivities = extractOrganizerWebsiteActivities(scraped?.html || '', {
            scrapedUrl: candidateUrl,
            organizer: target.organizer,
            now
          });
          extractedCount += rawActivities.length;

          for (const rawActivity of rawActivities) {
            const ingested = ingestWebsiteActivity(rawActivity, {
              venuesCatalog,
              organizersCatalog,
              organizer: target.organizer
            });
            if (ingested) {
              validActivities.push(ingested);
              domainYield += 1;
            }
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

  let upsertedCount = 0;
  if (!dryRun && dedupedActivities.length > 0 && adapter?.batchUpsertActivities) {
    const writeRes = await adapter.batchUpsertActivities(dedupedActivities);
    upsertedCount = writeRes?.upserted ?? dedupedActivities.length;
  }

  logger?.log?.(
    `[Organizer Website Sync] Domains: ${processedDomains}/${targets.length}, Mapped: ${mappedUrls}, Scraped: ${scrapedUrls}, Extracted: ${extractedCount}, Valid: ${validActivities.length}, Upserted: ${upsertedCount} (dryRun=${dryRun})`
  );

  return {
    firecrawlAvailable: true,
    skippedReason: null,
    dryRun,
    eligibleDomains: targets.length,
    processedDomains,
    mappedUrls,
    scrapedUrls,
    failedDomains,
    extractedCount,
    validCount: validActivities.length,
    upsertedCount
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

  return runOrganizerWebsiteSync({
    adapter,
    firecrawlClient,
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
