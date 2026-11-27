/**
 * Local Humanitix Perth 24-Hour Rolling Drip Sync CLI
 * Polls the 11 Greater Perth Humanitix category search SSR feeds and optional
 * `/api/search` pagination with local gzip-backed caching (24h TTL),
 * oldest-first feed/page rotation, fetch budgeting, jittered pacing,
 * and an HTTP 429/403 circuit breaker.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_HUMANITIX_MAX_PAGES,
  HUMANITIX_API_SEARCH_URL,
  HUMANITIX_PERTH_FEEDS,
  HUMANITIX_PERTH_SEARCH_URL,
  HUMANITIX_REQUEST_HEADERS,
  buildHumanitixFeedUrl,
  buildHumanitixSearchApiBody,
  collectHumanitixPage,
  deduplicateHumanitixListings,
  parseHumanitixApiEvents,
  parseHumanitixSearchPage
} from './crawlers/humanitix-crawler.js';
import { resolveCliLogger } from './crawler-reporter.js';
import { runCrawlerHarness } from './crawler-runner.js';
import { createFileCacheStore } from './file-cache.js';
import { createFirestoreAdapter, initFirestoreFromEnv } from './firestore-adapter.js';
import { loadDotEnv } from './places-sync.js';

export const DEFAULT_HUMANITIX_CACHE_PATH = path.resolve(process.cwd(), '.scratch/humanitix-sync-cache.json');
export const HUMANITIX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_FETCHES = 8;
export const DEFAULT_MAX_PAGES = DEFAULT_HUMANITIX_MAX_PAGES;
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
 * Parses CLI arguments for the local Humanitix sync CLI.
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
  return (nowMs - fetchedAtMs) <= HUMANITIX_CACHE_TTL_MS;
}

function buildCacheKey(feedUrl, page) {
  return page === 0 ? feedUrl : `${feedUrl}#api-page=${page}`;
}

async function advanceFeedToNextStalePage(feedState, ctx) {
  const { baseUrl, cacheStore, maxPages, runNow, refresh, collected, stats } = ctx;
  const nowMs = runNow.getTime();
  const feedUrl = buildHumanitixFeedUrl(feedState.feed, baseUrl);

  while (feedState.nextPage < maxPages && !feedState.exhausted) {
    const page = feedState.nextPage;
    if (page > 0 && (!feedState.stateKey || !feedState.geobox)) {
      feedState.exhausted = true;
      return null;
    }

    const cacheKey = buildCacheKey(feedUrl, page);
    const cached = cacheStore ? await cacheStore.read(cacheKey) : null;

    if (!isFreshCacheEntry(cached, nowMs, refresh)) {
      return {
        feedState,
        page,
        cacheKey,
        isApiPage: page > 0,
        fetchedAtMs: parseFetchedAtMs(cached)
      };
    }

    let parsed;
    if (page === 0) {
      parsed = parseHumanitixSearchPage(cached.body, {
        defaultCategory: feedState.feed.category,
        now: runNow
      });
    } else {
      try {
        const apiEvents = JSON.parse(cached.body);
        parsed = parseHumanitixApiEvents(Array.isArray(apiEvents) ? apiEvents : [], {
          defaultCategory: feedState.feed.category,
          now: runNow
        });
      } catch {
        return {
          feedState,
          page,
          cacheKey,
          isApiPage: true,
          fetchedAtMs: -Infinity
        };
      }
    }

    stats.cacheHits += 1;
    const { exhausted } = collectHumanitixPage(parsed, feedState, collected, page, maxPages);
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
 * Executes the 24-hour rolling Humanitix Perth drip sync and persists
 * deduplicated listings via the crawler harness.
 *
 * @param {object} [params={}]
 * @returns {Promise<object>}
 */
export async function runHumanitixSync({
  adapter,
  fetchFn = globalThis.fetch,
  cacheStore,
  sleepFn = defaultSleep,
  randomFn = Math.random,
  options = {},
  logger = console
} = {}) {
  const feeds = Array.isArray(options.feeds) ? options.feeds : HUMANITIX_PERTH_FEEDS;
  const baseUrl = options.baseUrl || HUMANITIX_PERTH_SEARCH_URL;
  const apiUrl = options.apiUrl || HUMANITIX_API_SEARCH_URL;
  const maxPages = Number.isFinite(options.maxPages) && options.maxPages > 0 ? Math.floor(options.maxPages) : DEFAULT_MAX_PAGES;
  const maxFetches = Number.isFinite(options.maxFetches) && options.maxFetches >= 0 ? Math.floor(options.maxFetches) : DEFAULT_MAX_FETCHES;
  const delayMs = Number.isFinite(options.delayMs) && options.delayMs >= 0 ? options.delayMs : DEFAULT_DELAY_MS;
  const refresh = Boolean(options.refresh);
  const dryRun = Boolean(options.dryRun);
  const parsedNow = options.now instanceof Date ? options.now : (options.now ? new Date(options.now) : new Date());
  const runNow = Number.isFinite(parsedNow.getTime()) ? parsedNow : new Date();

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
    priority: typeof feed.priority === 'number' ? feed.priority : (feed.slug === 'other' ? 0 : 1),
    nextPage: 0,
    seenIds: new Set(),
    stateKey: null,
    geobox: null,
    locale: 'AU',
    exhausted: false
  }));

  const syncCtx = { baseUrl, cacheStore, maxPages, runNow, refresh, collected, stats };

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
      let apiBody = null;
      if (candidate.isApiPage) {
        apiBody = buildHumanitixSearchApiBody({
          feed: candidate.feedState.feed,
          page: candidate.page,
          stateKey: candidate.feedState.stateKey,
          geobox: candidate.feedState.geobox,
          locale: candidate.feedState.locale
        });
        if (!apiBody) {
          candidate.feedState.exhausted = true;
          continue;
        }
      }

      if (stats.liveFetches > 0 && delayMs > 0) {
        const waitMs = computeJitteredDelayMs(delayMs, randomFn);
        if (waitMs > 0) {
          await sleepFn(waitMs);
        }
      }

      stats.liveFetches += 1;
      const targetUrl = candidate.isApiPage ? apiUrl : candidate.cacheKey;
      let response;
      try {
        response = candidate.isApiPage
          ? await fetchFn(apiUrl, {
              method: 'POST',
              headers: {
                ...HUMANITIX_REQUEST_HEADERS,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
              },
              body: JSON.stringify(apiBody)
            })
          : await fetchFn(targetUrl, {
              method: 'GET',
              headers: HUMANITIX_REQUEST_HEADERS
            });
      } catch (err) {
        stats.failedFetches += 1;
        logger?.warn?.(`[Humanitix Sync] Network error fetching ${targetUrl}: ${err.message}`);
        candidate.feedState.exhausted = true;
        continue;
      }

      if (response.status === 429 || response.status === 403) {
        stats.rateLimitedResponses += 1;
        stats.circuitBreakerTripped = true;
        stats.stoppedReason = 'circuit_breaker';
        logger?.warn?.(`[Humanitix Sync] Circuit breaker tripped on HTTP ${response.status} for ${targetUrl}; halting network requests without caching response.`);
        break;
      }

      if (!response.ok) {
        stats.failedFetches += 1;
        logger?.warn?.(`[Humanitix Sync] HTTP ${response.status} fetching ${targetUrl}; skipping remaining pages for ${candidate.feedState.feed.slug}.`);
        candidate.feedState.exhausted = true;
        continue;
      }

      let parsed;
      let cacheBody;
      if (candidate.isApiPage) {
        let apiEvents;
        try {
          apiEvents = await response.json();
        } catch (err) {
          stats.failedFetches += 1;
          logger?.warn?.(`[Humanitix Sync] Invalid JSON from ${apiUrl}: ${err.message}`);
          candidate.feedState.exhausted = true;
          continue;
        }
        if (!Array.isArray(apiEvents)) {
          stats.failedFetches += 1;
          logger?.warn?.(`[Humanitix Sync] Unexpected non-array response from ${apiUrl}; skipping remaining pages for ${candidate.feedState.feed.slug}.`);
          candidate.feedState.exhausted = true;
          continue;
        }
        cacheBody = JSON.stringify(apiEvents);
        parsed = parseHumanitixApiEvents(apiEvents, {
          defaultCategory: candidate.feedState.feed.category,
          now: runNow
        });
      } else {
        cacheBody = await response.text();
        parsed = parseHumanitixSearchPage(cacheBody, {
          defaultCategory: candidate.feedState.feed.category,
          now: runNow
        });
      }

      if (cacheStore) {
        await cacheStore.write(candidate.cacheKey, {
          url: candidate.cacheKey,
          fetchedAt: runNow.toISOString(),
          body: cacheBody
        });
      }

      const { exhausted } = collectHumanitixPage(parsed, candidate.feedState, collected, candidate.page, maxPages);
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

  const deduplicatedListings = deduplicateHumanitixListings(collected);
  const harnessSummary = await runCrawlerHarness({
    crawlers: [{
      name: 'humanitix',
      minExpectedListings: 0,
      async fetchListings() {
        return deduplicatedListings;
      }
    }],
    adapter,
    options: {
      crawler: 'humanitix',
      minExpectedListings: 0,
      skipUrlVerification: options.skipUrlVerification ?? true,
      logger
    }
  });

  logger?.log?.(
    `[Humanitix Sync] CacheHits=${stats.cacheHits}, LiveFetches=${stats.liveFetches}, Deduplicated=${deduplicatedListings.length}, Valid=${harnessSummary.totalValid}, Upserted=${harnessSummary.totalUpserted}, RateLimited=${stats.rateLimitedResponses}, CircuitBreaker=${stats.circuitBreakerTripped} (dryRun=${dryRun}${stats.stoppedReason ? `, stoppedReason=${stats.stoppedReason}` : ''})`
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
 * Main entry point for the local Humanitix Perth sync CLI.
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
  const logger = resolveCliLogger('humanitix-sync.log', argv, options, env);

  logger.log?.(`[Humanitix Sync] Initializing run (project: ${parsedArgs.project}, dry-run: ${parsedArgs.dryRun}, refresh: ${parsedArgs.refresh}, max-fetches: ${parsedArgs.maxFetches}, max-pages: ${parsedArgs.maxPages}, delay-ms: ${parsedArgs.delayMs})`);

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

  const cacheStore = options.cacheStore || createFileCacheStore(DEFAULT_HUMANITIX_CACHE_PATH, { flushEvery: 10 });

  try {
    return await runHumanitixSync({
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
  const cliLogger = resolveCliLogger('humanitix-sync.log', process.argv.slice(2), {}, process.env);
  main(process.argv.slice(2), process.env, { logger: cliLogger }).catch(err => {
    cliLogger.error('[Humanitix Sync Fatal Error]', err);
    process.exit(1);
  });
}
