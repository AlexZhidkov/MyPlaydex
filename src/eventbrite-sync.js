/**
 * Local Eventbrite Perth 24-Hour Rolling Drip Sync CLI
 * Polls the 10 Greater Perth Eventbrite directory feeds with pagination,
 * local gzip-backed caching (24h TTL), oldest-first feed/page rotation,
 * fetch budgeting, jittered pacing, and an HTTP 429/403 circuit breaker.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_EVENTBRITE_MAX_PAGES,
  EVENTBRITE_PERTH_FEEDS,
  EVENTBRITE_REQUEST_HEADERS,
  buildEventbritePageUrl,
  collectEventbritePage,
  deduplicateEventbriteListings
} from './crawlers/eventbrite-crawler.js';
import { resolveCliLogger } from './crawler-reporter.js';
import { runCrawlerHarness } from './crawler-runner.js';
import { createFileCacheStore } from './file-cache.js';
import { createFirestoreAdapter, initFirestoreFromEnv } from './firestore-adapter.js';
import { loadDotEnv } from './places-sync.js';

export const DEFAULT_EVENTBRITE_CACHE_PATH = path.resolve(process.cwd(), '.scratch/eventbrite-sync-cache.json');
export const EVENTBRITE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_FETCHES = 8;
export const DEFAULT_MAX_PAGES = DEFAULT_EVENTBRITE_MAX_PAGES;
export const DEFAULT_DELAY_MS = 3500;

const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getArgValue(argv, flag) {
  const prefix = `--${flag}=`;
  const match = argv.find(a => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

function parseIntArg(rawValue, fallback, min = 0) {
  if (rawValue === undefined) return fallback;
  const parsed = parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

/**
 * Parses CLI arguments for the local Eventbrite sync CLI.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @returns {object}
 */
export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  return {
    dryRun: argv.includes('--dry-run'),
    refresh: argv.includes('--refresh'),
    maxFetches: parseIntArg(getArgValue(argv, 'max-fetches'), DEFAULT_MAX_FETCHES, 0),
    maxPages: parseIntArg(getArgValue(argv, 'max-pages'), DEFAULT_MAX_PAGES, 1),
    delayMs: parseIntArg(getArgValue(argv, 'delay-ms'), DEFAULT_DELAY_MS, 0),
    useAdc: argv.includes('--use-adc') || Boolean(env.FIREBASE_USE_ADC),
    project: getArgValue(argv, 'project') || env.FIREBASE_PROJECT_ID || 'myplaydex'
  };
}

function computeJitteredDelayMs(delayMs, randomFn = Math.random) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
  const factor = 0.7 + randomFn() * 0.6;
  return Math.round(delayMs * factor);
}

function parseFetchedAtMs(cached) {
  if (!cached?.fetchedAt) return -Infinity;
  const ms = Date.parse(cached.fetchedAt);
  return Number.isFinite(ms) ? ms : -Infinity;
}

function isFreshCacheEntry(cached, nowMs, refresh) {
  if (refresh || !cached || typeof cached.body !== 'string' || !cached.body) {
    return false;
  }
  const fetchedAtMs = parseFetchedAtMs(cached);
  if (!Number.isFinite(fetchedAtMs)) {
    return false;
  }
  return (nowMs - fetchedAtMs) <= EVENTBRITE_CACHE_TTL_MS;
}

async function advanceFeedToNextStalePage(feedState, ctx) {
  const { cacheStore, maxPages, runNow, refresh, collected, stats } = ctx;
  const nowMs = runNow.getTime();

  while (feedState.nextPage <= maxPages && !feedState.exhausted) {
    const pageUrl = buildEventbritePageUrl(feedState.feed.url, feedState.nextPage);
    const cached = cacheStore ? await cacheStore.read(pageUrl) : null;

    if (!isFreshCacheEntry(cached, nowMs, refresh)) {
      return {
        feedState,
        page: feedState.nextPage,
        pageUrl,
        fetchedAtMs: parseFetchedAtMs(cached)
      };
    }

    stats.cacheHits += 1;
    const { exhausted } = collectEventbritePage(cached.body, feedState, collected, runNow, feedState.nextPage, maxPages);
    if (exhausted) {
      feedState.exhausted = true;
      return null;
    }
    feedState.nextPage += 1;
  }

  feedState.exhausted = true;
  return null;
}

function pickStalestCandidate(candidates) {
  let bestIdx = 0;
  for (let i = 1; i < candidates.length; i++) {
    const a = candidates[i];
    const b = candidates[bestIdx];
    if (a.fetchedAtMs !== b.fetchedAtMs) {
      if (a.fetchedAtMs < b.fetchedAtMs) bestIdx = i;
      continue;
    }
    if (a.page !== b.page) {
      if (a.page < b.page) bestIdx = i;
      continue;
    }
    if (a.feedState.index < b.feedState.index) {
      bestIdx = i;
    }
  }
  return candidates.splice(bestIdx, 1)[0];
}

/**
 * Executes the 24-hour rolling Eventbrite Perth drip sync and persists
 * deduplicated listings via the crawler harness.
 *
 * @param {object} [params={}]
 * @returns {Promise<object>}
 */
export async function runEventbriteSync({
  adapter,
  fetchFn = globalThis.fetch,
  cacheStore,
  sleepFn = defaultSleep,
  randomFn = Math.random,
  options = {},
  logger = console
} = {}) {
  const feeds = Array.isArray(options.feeds) ? options.feeds : EVENTBRITE_PERTH_FEEDS;
  const maxPages = Number.isFinite(options.maxPages) && options.maxPages > 0 ? Math.floor(options.maxPages) : DEFAULT_MAX_PAGES;
  const maxFetches = Number.isFinite(options.maxFetches) && options.maxFetches >= 0 ? Math.floor(options.maxFetches) : DEFAULT_MAX_FETCHES;
  const delayMs = Number.isFinite(options.delayMs) && options.delayMs >= 0 ? options.delayMs : DEFAULT_DELAY_MS;
  const refresh = Boolean(options.refresh);
  const dryRun = Boolean(options.dryRun);
  const parsedNow = options.now instanceof Date ? options.now : (options.now ? new Date(options.now) : new Date());
  const runNow = Number.isFinite(parsedNow.getTime()) ? parsedNow : new Date();
  const nowMs = runNow.getTime();

  const stats = {
    cacheHits: 0,
    liveFetches: 0,
    rateLimitedResponses: 0,
    failedFetches: 0,
    circuitBreakerTripped: false,
    stoppedReason: null
  };

  const collected = [];
  const feedStates = feeds.map((feed, index) => ({
    index,
    feed,
    priority: typeof feed.priority === 'number' ? feed.priority : (feed.slug === 'all-events' ? 0 : 1),
    nextPage: 1,
    seenIds: new Set(),
    exhausted: false
  }));

  const syncCtx = { cacheStore, maxPages, runNow, refresh, collected, stats };

  try {
    const pendingCandidates = [];
    for (const feedState of feedStates) {
      const staleCandidate = await advanceFeedToNextStalePage(feedState, syncCtx);
      if (staleCandidate) pendingCandidates.push(staleCandidate);
    }

    while (pendingCandidates.length > 0) {
      if (stats.liveFetches >= maxFetches) {
        stats.stoppedReason = 'max_fetches';
        break;
      }

      const candidate = pickStalestCandidate(pendingCandidates);

      if (stats.liveFetches > 0 && delayMs > 0) {
        const waitMs = computeJitteredDelayMs(delayMs, randomFn);
        if (waitMs > 0) {
          await sleepFn(waitMs);
        }
      }

      stats.liveFetches += 1;
      let response;
      try {
        response = await fetchFn(candidate.pageUrl, {
          method: 'GET',
          headers: EVENTBRITE_REQUEST_HEADERS
        });
      } catch (err) {
        stats.failedFetches += 1;
        logger?.warn?.(`[Eventbrite Sync] Network error fetching ${candidate.pageUrl}: ${err.message}`);
        candidate.feedState.exhausted = true;
        continue;
      }

      if (response.status === 429 || response.status === 403) {
        stats.rateLimitedResponses += 1;
        stats.circuitBreakerTripped = true;
        stats.stoppedReason = 'circuit_breaker';
        logger?.warn?.(`[Eventbrite Sync] Circuit breaker tripped on HTTP ${response.status} for ${candidate.pageUrl}; halting network requests without caching response.`);
        break;
      }

      if (!response.ok) {
        stats.failedFetches += 1;
        logger?.warn?.(`[Eventbrite Sync] HTTP ${response.status} fetching ${candidate.pageUrl}; skipping remaining pages for ${candidate.feedState.feed.slug}.`);
        candidate.feedState.exhausted = true;
        continue;
      }

      const html = await response.text();
      if (cacheStore) {
        await cacheStore.write(candidate.pageUrl, {
          url: candidate.pageUrl,
          fetchedAt: runNow.toISOString(),
          body: html
        });
      }

      const { exhausted } = collectEventbritePage(html, candidate.feedState, collected, runNow, candidate.page, maxPages);
      if (exhausted) {
        candidate.feedState.exhausted = true;
        continue;
      }

      candidate.feedState.nextPage = candidate.page + 1;
      const staleCandidate = await advanceFeedToNextStalePage(candidate.feedState, syncCtx);
      if (staleCandidate) pendingCandidates.push(staleCandidate);
    }
  } finally {
    await cacheStore?.flush?.();
  }

  const deduplicatedListings = deduplicateEventbriteListings(collected);
  const harnessSummary = await runCrawlerHarness({
    crawlers: [{
      name: 'eventbrite',
      minExpectedListings: 0,
      async fetchListings() {
        return deduplicatedListings;
      }
    }],
    adapter,
    options: {
      crawler: 'eventbrite',
      minExpectedListings: 0,
      skipUrlVerification: options.skipUrlVerification ?? true,
      logger
    }
  });

  logger?.log?.(
    `[Eventbrite Sync] CacheHits=${stats.cacheHits}, LiveFetches=${stats.liveFetches}, Deduplicated=${deduplicatedListings.length}, Valid=${harnessSummary.totalValid}, Upserted=${harnessSummary.totalUpserted}, RateLimited=${stats.rateLimitedResponses}, CircuitBreaker=${stats.circuitBreakerTripped} (dryRun=${dryRun}${stats.stoppedReason ? `, stoppedReason=${stats.stoppedReason}` : ''})`
  );

  return {
    ...stats,
    deduplicated: deduplicatedListings.length,
    valid: harnessSummary.totalValid,
    invalid: harnessSummary.totalInvalid,
    upserted: harnessSummary.totalUpserted,
    dryRun
  };
}

/**
 * Main entry point for the local Eventbrite Perth sync CLI.
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
  const logger = resolveCliLogger('eventbrite-sync.log', argv, options, env);

  logger.log?.(`[Eventbrite Sync] Initializing run (project: ${parsedArgs.project}, dry-run: ${parsedArgs.dryRun}, refresh: ${parsedArgs.refresh}, max-fetches: ${parsedArgs.maxFetches}, max-pages: ${parsedArgs.maxPages}, delay-ms: ${parsedArgs.delayMs})`);

  const firestoreEnv = options.firestoreEnv || await initFirestoreFromEnv(env, {
    requireCredentials: !parsedArgs.dryRun && !parsedArgs.useAdc,
    useAdc: parsedArgs.useAdc,
    projectId: parsedArgs.project
  });

  const effectiveDryRun = parsedArgs.dryRun || firestoreEnv.dryRun;
  const adapter = options.adapter || createFirestoreAdapter({
    db: firestoreEnv.db,
    dryRun: effectiveDryRun
  });

  const cacheStore = options.cacheStore || createFileCacheStore(DEFAULT_EVENTBRITE_CACHE_PATH, { flushEvery: 10 });

  try {
    return await runEventbriteSync({
      adapter,
      fetchFn: options.fetchFn,
      cacheStore,
      sleepFn: options.sleepFn,
      randomFn: options.randomFn,
      options: {
        dryRun: effectiveDryRun,
        refresh: parsedArgs.refresh,
        maxFetches: parsedArgs.maxFetches,
        maxPages: parsedArgs.maxPages,
        delayMs: parsedArgs.delayMs,
        now: options.now
      },
      logger
    });
  } finally {
    await firestoreEnv?.db?.terminate?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cliLogger = resolveCliLogger('eventbrite-sync.log', process.argv.slice(2), {}, process.env);
  main(process.argv.slice(2), process.env, { logger: cliLogger }).catch(err => {
    cliLogger.error('[Eventbrite Sync Fatal Error]', err);
    process.exit(1);
  });
}
