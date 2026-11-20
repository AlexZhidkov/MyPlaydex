/**
 * Organizer Website Facebook Link Enricher CLI
 * Crawls websites of canonical Organizers missing `contact.facebook`,
 * extracts and normalizes outbound Facebook Page/Group URLs from HTML anchors
 * and Schema.org `sameAs` JSON-LD, and batch-updates Firestore.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCliLogger } from './crawler-reporter.js';
import { createFirestoreAdapter, initFirestoreFromEnv } from './firestore-adapter.js';
import { createFileCacheStore, loadDotEnv } from './places-sync.js';
import {
  isFacebookUrl,
  parseNormalizedUrl,
  resolveOrganizerFacebookUrl
} from './url-utils.js';

export const DEFAULT_ORGANIZER_ENRICH_CACHE_PATH = path.resolve(
  process.cwd(),
  '.scratch/organizer-enrich-cache.json'
);
const DEFAULT_FETCH_TIMEOUT_MS = 15000;

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

function getEligibleWebsiteUrl(org) {
  if (!org || typeof org !== 'object') {
    return null;
  }
  const existingFacebook = typeof org.contact?.facebook === 'string'
    ? org.contact.facebook.trim()
    : '';
  if (existingFacebook) {
    return null;
  }

  const rawWebsite = typeof org.website === 'string' ? org.website.trim() : '';
  if (!rawWebsite) {
    return null;
  }

  const normalizedCheck = parseNormalizedUrl(rawWebsite);
  if (!normalizedCheck || isFacebookUrl(normalizedCheck)) {
    return null;
  }

  // Preserve explicit http:// scheme for HTTP-only sites instead of forcing https://
  if (/^http:\/\//i.test(rawWebsite)) {
    try {
      return new URL(rawWebsite).href;
    } catch {
      return null;
    }
  }
  return normalizedCheck.href;
}

async function fetchWebsiteHtml({ url, fetchFn, cacheStore, refresh, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, logger }) {
  if (!refresh && cacheStore) {
    const cached = await cacheStore.read(url);
    if (cached && typeof cached.body === 'string') {
      return { body: cached.body, fromCache: true };
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

  const response = await fetchFn(url, fetchOptions);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body = await response.text();

  if (cacheStore) {
    try {
      await cacheStore.write(url, {
        url,
        fetchedAt: new Date().toISOString(),
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
  options = {},
  logger = console
} = {}) {
  const dryRun = Boolean(options.dryRun);
  const refresh = Boolean(options.refresh);
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : undefined;
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_FETCH_TIMEOUT_MS;

  const organizers = adapter?.scanOrganizers ? await adapter.scanOrganizers() : [];

  let targets = [];
  for (const org of organizers) {
    if (options.organizer && org.id !== options.organizer) {
      continue;
    }
    const websiteUrl = getEligibleWebsiteUrl(org);
    if (!websiteUrl) {
      continue;
    }
    targets.push({ org, websiteUrl });
  }

  if (limit !== undefined) {
    targets = targets.slice(0, limit);
  }

  let scanned = 0;
  let failedTargets = 0;
  let cacheHits = 0;
  const updates = [];

  for (const { org, websiteUrl } of targets) {
    scanned += 1;
    let fetched;
    try {
      fetched = await fetchWebsiteHtml({
        url: websiteUrl,
        fetchFn,
        cacheStore,
        refresh,
        timeoutMs,
        logger
      });
      if (fetched.fromCache) {
        cacheHits += 1;
      }
    } catch (err) {
      failedTargets += 1;
      logger?.warn?.(`[Organizer Enricher] Failed to fetch ${websiteUrl} for organizer ${org.id}: ${err.message}`);
      continue;
    }

    const discoveredFacebook = extractFacebookUrlFromHtml(fetched.body);
    if (!discoveredFacebook) {
      continue;
    }

    const { updated_at: _staleUpdatedAt, ...orgWithoutUpdatedAt } = org;
    updates.push({
      ...orgWithoutUpdatedAt,
      contact: {
        ...(org.contact && typeof org.contact === 'object' ? org.contact : {}),
        email: org.contact?.email ?? null,
        phone: org.contact?.phone ?? null,
        facebook: discoveredFacebook
      }
    });
  }

  let updated = 0;
  if (!dryRun && updates.length > 0 && adapter?.batchUpsertOrganizers) {
    const res = await adapter.batchUpsertOrganizers(updates);
    updated = res?.upserted ?? updates.length;
  }

  logger?.log?.(
    `[Organizer Enricher] Eligible: ${targets.length}, Scanned: ${scanned}, CacheHits: ${cacheHits}, Failed: ${failedTargets}, Matched: ${updates.length}, Updated: ${updated} (dryRun=${dryRun})`
  );

  return {
    eligible: targets.length,
    scanned,
    cacheHits,
    failedTargets,
    matched: updates.length,
    updated,
    dryRun,
    updates
  };
}

function getArgValue(argv, flag) {
  const prefix = `--${flag}=`;
  const match = argv.find(a => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
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

  const rawLimit = getArgValue(argv, 'limit');
  const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;

  const useAdc = argv.includes('--use-adc') || Boolean(env.FIREBASE_USE_ADC);
  const project = getArgValue(argv, 'project') || env.FIREBASE_PROJECT_ID || 'myplaydex';

  return {
    organizer,
    limit: Number.isNaN(limit) ? undefined : limit,
    dryRun,
    refresh,
    useAdc,
    project
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
    `[Organizer Enricher] Initializing run (project: ${parsedArgs.project}, dry-run: ${parsedArgs.dryRun}, refresh: ${parsedArgs.refresh})`
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

  const cacheStore = options.cacheStore || createFileCacheStore(DEFAULT_ORGANIZER_ENRICH_CACHE_PATH);

  return runOrganizerEnricher({
    adapter,
    fetchFn: options.fetchFn,
    cacheStore,
    options: {
      organizer: parsedArgs.organizer,
      limit: parsedArgs.limit,
      dryRun: effectiveDryRun,
      refresh: parsedArgs.refresh
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
