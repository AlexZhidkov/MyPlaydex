/**
 * Organizer Website Facebook Link Enricher CLI
 * Crawls websites of canonical Organizers missing `contact.facebook`,
 * extracts and normalizes outbound Facebook Page/Group URLs from HTML anchors
 * and Schema.org `sameAs` JSON-LD, and batch-updates Firestore.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCliLogger } from './crawler-reporter.js';
import { DEFAULT_FACEBOOK_CACHE_PATH, isCachedFacebookNonEntity } from './facebook-sync.js';
import { createFileCacheStore } from './file-cache.js';
import { createFirecrawlClientFromEnv } from './firecrawl-client.js';
import { createFirestoreAdapter, initFirestoreFromEnv } from './firestore-adapter.js';
import { loadDotEnv } from './places-sync.js';
import {
  isFacebookUrl,
  isGenericDirectoryFallbackUrl,
  parseNormalizedUrl,
  resolveOrganizerFacebookUrl
} from './url-utils.js';

export const DEFAULT_ORGANIZER_ENRICH_CACHE_PATH = path.resolve(
  process.cwd(),
  '.scratch/organizer-enrich-cache.json'
);
const DEFAULT_FETCH_TIMEOUT_MS = 15000;
export const DEFAULT_NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const RETRYABLE_FIRECRAWL_HTTP_STATUSES = new Set([
  401,
  403,
  406,
  429,
  503,
  520,
  521,
  522,
  523,
  524,
  525,
  526
]);

const RETRYABLE_FIRECRAWL_ERROR_CODES = new Set([
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'EPIPE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID'
]);

const NON_RETRYABLE_FIRECRAWL_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'EAI_FAIL',
  'ESERVFAIL',
  'EREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'ERR_INVALID_URL'
]);

const JSON_LD_SCRIPT_REGEX = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const ANCHOR_HREF_REGEX = /<a\b[^>]*?\s+href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function decodeBasicHtmlEntities(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&');
}

function collectSameAsUrls(node, results) {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectSameAsUrls(item, results);
    }
    return;
  }

  if (typeof node.sameAs === 'string') {
    results.push(node.sameAs);
  } else if (Array.isArray(node.sameAs)) {
    for (const entry of node.sameAs) {
      if (typeof entry === 'string') {
        results.push(entry);
      }
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key !== 'sameAs' && value && typeof value === 'object') {
      collectSameAsUrls(value, results);
    }
  }
}

function extractSameAsCandidates(html) {
  const candidates = [];
  JSON_LD_SCRIPT_REGEX.lastIndex = 0;
  let match;
  while ((match = JSON_LD_SCRIPT_REGEX.exec(html)) !== null) {
    const rawJson = match[1]?.trim();
    if (!rawJson) continue;
    try {
      const parsed = JSON.parse(rawJson);
      collectSameAsUrls(parsed, candidates);
    } catch {
      // Ignore malformed JSON-LD blocks
    }
  }
  return candidates;
}

function extractAnchorCandidates(html) {
  const candidates = [];
  ANCHOR_HREF_REGEX.lastIndex = 0;
  let match;
  while ((match = ANCHOR_HREF_REGEX.exec(html)) !== null) {
    const rawHref = match[1] ?? match[2] ?? match[3] ?? '';
    const decoded = decodeBasicHtmlEntities(rawHref).trim();
    if (decoded) {
      candidates.push(decoded);
    }
  }
  return candidates;
}

/**
 * Extracts and resolves the primary Organizer Facebook Page or Public Group URL
 * from an HTML document, prioritizing Schema.org `sameAs` JSON-LD over `<a>` anchors.
 *
 * @param {string} html
 * @returns {string | null}
 */
export function extractFacebookUrlFromHtml(html) {
  if (typeof html !== 'string' || !html.trim()) {
    return null;
  }

  const orderedCandidates = [
    ...extractSameAsCandidates(html),
    ...extractAnchorCandidates(html)
  ];

  for (const candidate of orderedCandidates) {
    const resolved = resolveOrganizerFacebookUrl(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

/**
 * Extracts and resolves the primary Organizer Facebook Page or Public Group URL
 * from a Firecrawl scrape result (`rawHtml` / `html` first, then `links`).
 *
 * @param {object|null} result
 * @returns {string | null}
 */
export function extractFacebookUrlFromFirecrawlResult(result) {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const fromRawHtml = extractFacebookUrlFromHtml(result.rawHtml);
  if (fromRawHtml) return fromRawHtml;

  const fromHtml = extractFacebookUrlFromHtml(result.html);
  if (fromHtml) return fromHtml;

  if (Array.isArray(result.links)) {
    for (const link of result.links) {
      const resolved = resolveOrganizerFacebookUrl(link);
      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

export function normalizeEligibleWebsiteUrl(rawWebsite) {
  const trimmed = typeof rawWebsite === 'string' ? rawWebsite.trim() : '';
  if (!trimmed || /^mailto:/i.test(trimmed)) {
    return null;
  }

  const normalizedCheck = parseNormalizedUrl(trimmed);
  if (
    !normalizedCheck ||
    normalizedCheck.username ||
    normalizedCheck.password ||
    isFacebookUrl(normalizedCheck) ||
    isGenericDirectoryFallbackUrl(normalizedCheck)
  ) {
    return null;
  }

  // Preserve explicit http:// scheme for HTTP-only sites instead of forcing https://
  if (/^http:\/\//i.test(trimmed)) {
    try {
      const parsedHttp = new URL(trimmed);
      if (parsedHttp.username || parsedHttp.password) {
        return null;
      }
      return parsedHttp.href;
    } catch {
      return null;
    }
  }
  return normalizedCheck.href;
}

function extractErrorCode(err) {
  if (!err || typeof err !== 'object') return null;
  if (typeof err.errorCode === 'string' && err.errorCode) return err.errorCode;
  if (typeof err.cause?.code === 'string' && err.cause.code) return err.cause.code;
  if (typeof err.code === 'string' && err.code) return err.code;
  return null;
}

function extractHttpStatus(err) {
  if (!err || typeof err !== 'object') return null;
  if (Number.isInteger(err.httpStatus)) return err.httpStatus;
  if (typeof err.message === 'string') {
    const match = err.message.match(/^HTTP (\d{3})\b/);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Formats a fetch error with its underlying `cause.code` / `cause.message`
 * so logs distinguish DNS failures, timeouts, and WAF socket resets.
 *
 * @param {Error} err
 * @returns {string}
 */
export function formatFetchError(err) {
  if (!err) return 'unknown error';
  const baseMessage = typeof err.message === 'string' && err.message ? err.message : String(err);
  const causeCode = extractErrorCode(err);
  const causeMessage = typeof err.cause?.message === 'string' ? err.cause.message.trim() : '';

  if (causeCode && !baseMessage.includes(causeCode)) {
    if (causeMessage && causeMessage !== baseMessage && !causeMessage.includes(causeCode)) {
      return `${baseMessage} (${causeCode}: ${causeMessage})`;
    }
    return `${baseMessage} (${causeCode})`;
  }
  if (causeMessage && causeMessage !== baseMessage && !baseMessage.includes(causeMessage)) {
    return `${baseMessage} (${causeMessage})`;
  }
  return baseMessage;
}

/**
 * Determines whether a raw `fetch` outcome warrants falling back to Firecrawl's
 * headless browser (true for 200 OK SPAs without a Facebook link, WAF/bot HTTP
 * blocks, and socket/TLS drops; false for dead DNS, timeouts, and 404/410s).
 *
 * @param {Error|null} rawFetchError
 * @returns {boolean}
 */
export function shouldFallbackToFirecrawl(rawFetchError) {
  if (!rawFetchError) {
    return true;
  }

  const httpStatus = extractHttpStatus(rawFetchError);
  if (httpStatus !== null) {
    return RETRYABLE_FIRECRAWL_HTTP_STATUSES.has(httpStatus);
  }

  const errorName = typeof rawFetchError.name === 'string' ? rawFetchError.name : '';
  if (errorName === 'TimeoutError' || errorName === 'AbortError') {
    return false;
  }

  const errorCode = extractErrorCode(rawFetchError);
  if (errorCode) {
    if (NON_RETRYABLE_FIRECRAWL_ERROR_CODES.has(errorCode)) {
      return false;
    }
    if (
      RETRYABLE_FIRECRAWL_ERROR_CODES.has(errorCode) ||
      errorCode.startsWith('ERR_SSL_') ||
      errorCode.startsWith('HPE_')
    ) {
      return true;
    }
  }

  const message = typeof rawFetchError.message === 'string' ? rawFetchError.message : '';
  if (/credentials/i.test(message)) {
    return false;
  }

  return false;
}

function isFreshNegativeCacheEntry(entry, nowMs, ttlMs) {
  if (!entry || typeof entry !== 'object' || entry.status !== 'error') {
    return false;
  }
  const fetchedAtMs = entry.fetchedAt ? Date.parse(entry.fetchedAt) : NaN;
  if (!Number.isFinite(fetchedAtMs)) {
    return false;
  }
  return (nowMs - fetchedAtMs) <= ttlMs;
}

function shouldPromoteSourceUrl(org) {
  return org.verified === false || isGenericDirectoryFallbackUrl(org.source_url);
}

async function resolveEnrichmentTarget(org, { force = false, facebookCacheStore } = {}) {
  if (!org || typeof org !== 'object') {
    return null;
  }

  const websiteUrl = normalizeEligibleWebsiteUrl(org.website);
  if (!websiteUrl) {
    return null;
  }

  const existingFacebook = typeof org.contact?.facebook === 'string'
    ? org.contact.facebook.trim()
    : '';

  if (
    !existingFacebook ||
    force ||
    resolveOrganizerFacebookUrl(existingFacebook) === null ||
    await isCachedFacebookNonEntity(existingFacebook, facebookCacheStore)
  ) {
    return { org, websiteUrl, existingFacebook };
  }

  return null;
}

async function fetchWebsiteHtml({
  url,
  fetchFn,
  cacheStore,
  refresh,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  negativeCacheTtlMs = DEFAULT_NEGATIVE_CACHE_TTL_MS,
  nowFn = () => Date.now(),
  logger
}) {
  if (!refresh && cacheStore) {
    const cached = await cacheStore.read(url);
    if (cached && typeof cached.body === 'string') {
      return { body: cached.body, fromCache: true };
    }
    if (isFreshNegativeCacheEntry(cached, nowFn(), negativeCacheTtlMs)) {
      const cachedErr = new Error(cached.error || 'cached fetch error');
      cachedErr.fromCache = true;
      if (Number.isInteger(cached.httpStatus)) {
        cachedErr.httpStatus = cached.httpStatus;
      }
      if (typeof cached.errorCode === 'string' && cached.errorCode) {
        cachedErr.errorCode = cached.errorCode;
      }
      throw cachedErr;
    }
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8'
  };

  const fetchOptions = { headers };
  if (typeof AbortSignal?.timeout === 'function' && timeoutMs > 0) {
    fetchOptions.signal = AbortSignal.timeout(timeoutMs);
  }

  let response;
  try {
    response = await fetchFn(url, fetchOptions);
    if (!response.ok) {
      const httpErr = new Error(`HTTP ${response.status}`);
      httpErr.httpStatus = response.status;
      throw httpErr;
    }
  } catch (err) {
    if (cacheStore && !shouldFallbackToFirecrawl(err)) {
      try {
        await cacheStore.write(url, {
          url,
          fetchedAt: new Date(nowFn()).toISOString(),
          status: 'error',
          httpStatus: extractHttpStatus(err),
          errorCode: extractErrorCode(err),
          error: formatFetchError(err)
        });
      } catch (cacheErr) {
        logger?.warn?.(`[Organizer Enricher] Negative cache write failed for ${url}: ${cacheErr.message}`);
      }
    }
    throw err;
  }

  const body = await response.text();

  if (cacheStore) {
    try {
      await cacheStore.write(url, {
        url,
        fetchedAt: new Date(nowFn()).toISOString(),
        status: response.status,
        body
      });
    } catch (err) {
      logger?.warn?.(`[Organizer Enricher] Cache write failed for ${url}: ${err.message}`);
    }
  }

  return { body, fromCache: false };
}

/**
 * Runs the Organizer website crawling and Facebook link enrichment pipeline.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function runOrganizerEnricher({
  adapter,
  fetchFn = globalThis.fetch,
  cacheStore,
  facebookCacheStore,
  firecrawlClient = null,
  options = {},
  logger = console
} = {}) {
  const dryRun = Boolean(options.dryRun);
  const refresh = Boolean(options.refresh);
  const force = Boolean(options.force);
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : undefined;
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_FETCH_TIMEOUT_MS;
  const negativeCacheTtlMs = typeof options.negativeCacheTtlMs === 'number' && options.negativeCacheTtlMs >= 0
    ? options.negativeCacheTtlMs
    : DEFAULT_NEGATIVE_CACHE_TTL_MS;
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => Date.now();

  const organizers = adapter?.scanOrganizers ? await adapter.scanOrganizers() : [];

  let targets = [];
  for (const org of organizers) {
    if (options.organizer && org.id !== options.organizer) {
      continue;
    }
    const target = await resolveEnrichmentTarget(org, { force, facebookCacheStore });
    if (!target) {
      continue;
    }
    targets.push(target);
  }

  if (limit !== undefined) {
    targets = targets.slice(0, limit);
  }

  let scanned = 0;
  let failedTargets = 0;
  let cacheHits = 0;
  let firecrawlFallbacks = 0;
  let firecrawlMatched = 0;
  const updates = [];

  try {
    for (const { org, websiteUrl, existingFacebook } of targets) {
      scanned += 1;
      let discoveredFacebook = null;
      let rawFetchError = null;

      try {
        const fetched = await fetchWebsiteHtml({
          url: websiteUrl,
          fetchFn,
          cacheStore,
          refresh,
          timeoutMs,
          negativeCacheTtlMs,
          nowFn,
          logger
        });
        if (fetched.fromCache) {
          cacheHits += 1;
        }
        discoveredFacebook = extractFacebookUrlFromHtml(fetched.body);
      } catch (err) {
        if (err?.fromCache) {
          cacheHits += 1;
        }
        rawFetchError = err;
      }

      if (!discoveredFacebook && firecrawlClient && shouldFallbackToFirecrawl(rawFetchError)) {
        firecrawlFallbacks += 1;
        try {
          const rendered = await firecrawlClient.scrape(websiteUrl, {
            formats: ['rawHtml', 'html', 'links'],
            onlyMainContent: false,
            refresh
          });
          discoveredFacebook = extractFacebookUrlFromFirecrawlResult(rendered);
          if (discoveredFacebook) {
            firecrawlMatched += 1;
          }
          rawFetchError = null;
        } catch (fcErr) {
          logger?.warn?.(
            `[Organizer Enricher] Firecrawl fallback failed for ${websiteUrl} (organizer ${org.id}): ${fcErr.message}`
          );
        }
      }

      if (rawFetchError) {
        failedTargets += 1;
        const formattedError = formatFetchError(rawFetchError);
        const cacheTag = rawFetchError.fromCache ? ' [cached]' : '';
        logger?.warn?.(`[Organizer Enricher] Failed to fetch ${websiteUrl} for organizer ${org.id}: ${formattedError}${cacheTag}`);
        continue;
      }

      if (!discoveredFacebook) {
        continue;
      }

      const normalizedExisting = existingFacebook
        ? (resolveOrganizerFacebookUrl(existingFacebook) || existingFacebook)
        : '';
      const facebookChanged =
        !existingFacebook ||
        (discoveredFacebook !== existingFacebook && discoveredFacebook !== normalizedExisting);

      if (!facebookChanged || await isCachedFacebookNonEntity(discoveredFacebook, facebookCacheStore)) {
        continue;
      }

      const promoteSource = shouldPromoteSourceUrl(org);
      const { updated_at: _staleUpdatedAt, ...orgWithoutUpdatedAt } = org;
      const nextOrg = {
        ...orgWithoutUpdatedAt,
        contact: {
          ...(org.contact && typeof org.contact === 'object' ? org.contact : {}),
          email: org.contact?.email ?? null,
          phone: org.contact?.phone ?? null,
          facebook: discoveredFacebook
        }
      };
      if (promoteSource) {
        nextOrg.source_url = discoveredFacebook;
        nextOrg.verified = true;
      }
      updates.push(nextOrg);
    }
  } finally {
    await cacheStore?.flush?.();
    await firecrawlClient?.flushCache?.();
  }

  let updated = 0;
  if (!dryRun && updates.length > 0 && adapter?.batchUpsertOrganizers) {
    const res = await adapter.batchUpsertOrganizers(updates);
    updated = res?.upserted ?? updates.length;
  }

  logger?.log?.(
    `[Organizer Enricher] Eligible: ${targets.length}, Scanned: ${scanned}, CacheHits: ${cacheHits}, FirecrawlFallbacks: ${firecrawlFallbacks}, FirecrawlMatched: ${firecrawlMatched}, Failed: ${failedTargets}, Matched: ${updates.length}, Updated: ${updated} (dryRun=${dryRun})`
  );

  return {
    eligible: targets.length,
    scanned,
    cacheHits,
    firecrawlFallbacks,
    firecrawlMatched,
    failedTargets,
    matched: updates.length,
    updated,
    dryRun,
    updates
  };
}

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

/**
 * Parses CLI arguments for the Organizer website enricher CLI.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @returns {object}
 */
export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  const organizer = getArgValue(argv, 'organizer');
  const dryRun = argv.includes('--dry-run');
  const refresh = argv.includes('--refresh');
  const force = argv.includes('--force');

  const rawLimit = getArgValue(argv, 'limit');
  const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;

  const useAdc = argv.includes('--use-adc') || Boolean(env.FIREBASE_USE_ADC);
  const project = getArgValue(argv, 'project') || env.FIREBASE_PROJECT_ID || 'myplaydex';
  const noFirecrawl = argv.includes('--no-firecrawl');
  const firecrawlUrl = noFirecrawl
    ? null
    : (getArgValue(argv, 'firecrawl-url') || env.FIRECRAWL_LOCAL_URL || null);

  return {
    organizer,
    limit: Number.isNaN(limit) ? undefined : limit,
    dryRun,
    refresh,
    force,
    useAdc,
    project,
    firecrawlUrl
  };
}

/**
 * Main entry point for the Organizer website enricher CLI.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @param {object} [options={}]
 * @returns {Promise<object>} Enrichment summary report
 */
export async function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  if (env === process.env || options.envFilePath) {
    await loadDotEnv(options.envFilePath, env);
  }

  const parsedArgs = parseCliArgs(argv, env);
  const logger = resolveCliLogger('organizer-enricher.log', argv, options, env);

  logger.log?.(
    `[Organizer Enricher] Initializing run (project: ${parsedArgs.project}, dry-run: ${parsedArgs.dryRun}, refresh: ${parsedArgs.refresh}, force: ${parsedArgs.force}, firecrawl: ${parsedArgs.firecrawlUrl ? 'enabled' : 'disabled'})`
  );

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

  const cacheStore = options.cacheStore || createFileCacheStore(DEFAULT_ORGANIZER_ENRICH_CACHE_PATH, { flushEvery: 25 });
  const facebookCacheStore = options.facebookCacheStore || createFileCacheStore(DEFAULT_FACEBOOK_CACHE_PATH);
  const firecrawlClient = options.firecrawlClient !== undefined
    ? options.firecrawlClient
    : (parsedArgs.firecrawlUrl
        ? createFirecrawlClientFromEnv(env, {
            baseUrl: parsedArgs.firecrawlUrl,
            fetchFn: options.fetchFn,
            logger
          })
        : null);

  return runOrganizerEnricher({
    adapter,
    fetchFn: options.fetchFn,
    cacheStore,
    facebookCacheStore,
    firecrawlClient,
    options: {
      organizer: parsedArgs.organizer,
      limit: parsedArgs.limit,
      dryRun: effectiveDryRun,
      refresh: parsedArgs.refresh,
      force: parsedArgs.force
    },
    logger
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cliLogger = resolveCliLogger('organizer-enricher.log', process.argv.slice(2), {}, process.env);
  main(process.argv.slice(2), process.env, { logger: cliLogger }).catch(err => {
    cliLogger.error('[Organizer Enricher Fatal Error]', err);
    process.exit(1);
  });
}
