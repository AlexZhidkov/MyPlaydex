/**
 * Firecrawl Local HTTP Sidecar Client
 * Talks to `firecrawl-local serve` over localhost HTTP (`fetch` only, zero npm deps),
 * enforcing serial execution (`concurrency = 1`), jittered request pacing, and
 * gzip-backed checkpoint caching via `src/file-cache.js` (ADR 0011).
 */

import path from 'node:path';
import { createFileCacheStore } from './file-cache.js';

export const DEFAULT_FIRECRAWL_CACHE_PATH = path.resolve(
  process.cwd(),
  '.scratch/firecrawl-cache.json'
);
export const DEFAULT_FIRECRAWL_TIMEOUT_MS = 30000;
export const DEFAULT_FIRECRAWL_DELAY_MS = 1500;
export const DEFAULT_FIRECRAWL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function normalizeBaseUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function computeJitteredDelayMs(delayMs, randomFn = Math.random) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
  const factor = 0.7 + randomFn() * 0.6;
  return Math.round(delayMs * factor);
}

function isFreshCacheEntry(entry, nowMs, ttlMs, refresh) {
  if (refresh || !entry || typeof entry !== 'object') {
    return false;
  }
  const fetchedAtMs = entry.fetchedAt ? Date.parse(entry.fetchedAt) : NaN;
  if (!Number.isFinite(fetchedAtMs)) {
    return false;
  }
  return (nowMs - fetchedAtMs) <= ttlMs;
}

function normalizeMapLinks(rawLinks) {
  if (!Array.isArray(rawLinks)) return [];
  const urls = [];
  for (const item of rawLinks) {
    if (typeof item === 'string' && item.trim()) {
      urls.push(item.trim());
    } else if (item && typeof item === 'object' && typeof item.url === 'string' && item.url.trim()) {
      urls.push(item.url.trim());
    }
  }
  return urls;
}

/**
 * Creates a serial, jitter-paced, cache-backed client for `firecrawl-local serve`.
 * Returns `null` if `baseUrl` is missing or invalid so callers degrade gracefully.
 *
 * @param {object} [options={}]
 * @returns {object|null}
 */
export function createFirecrawlClient({
  baseUrl,
  token = null,
  fetchFn = globalThis.fetch,
  sleepFn = defaultSleep,
  randomFn = Math.random,
  nowFn = () => Date.now(),
  cacheStore = null,
  cacheTtlMs = DEFAULT_FIRECRAWL_CACHE_TTL_MS,
  delayMs = DEFAULT_FIRECRAWL_DELAY_MS,
  timeoutMs = DEFAULT_FIRECRAWL_TIMEOUT_MS,
  logger = console
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return null;
  }

  let serialTail = Promise.resolve();
  let liveRequestsSent = 0;

  function enqueueSerial(task) {
    const run = serialTail.then(task, task);
    serialTail = run.then(() => {}, () => {});
    return run;
  }

  function buildHeaders(includeJson = true) {
    const headers = {};
    if (includeJson) {
      headers['Content-Type'] = 'application/json';
    }
    if (typeof token === 'string' && token.trim()) {
      headers.Authorization = `Bearer ${token.trim()}`;
    }
    return headers;
  }

  async function paceLiveRequest() {
    if (liveRequestsSent > 0 && delayMs > 0) {
      const waitMs = computeJitteredDelayMs(delayMs, randomFn);
      if (waitMs > 0) {
        await sleepFn(waitMs);
      }
    }
    liveRequestsSent += 1;
  }

  async function postJson(endpoint, payload, requestTimeoutMs) {
    const effectiveTimeout = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? requestTimeoutMs
      : timeoutMs;
    const fetchOptions = {
      method: 'POST',
      headers: buildHeaders(true),
      body: JSON.stringify(payload)
    };
    if (typeof AbortSignal?.timeout === 'function' && effectiveTimeout > 0) {
      fetchOptions.signal = AbortSignal.timeout(effectiveTimeout);
    }

    const response = await fetchFn(`${normalizedBaseUrl}${endpoint}`, fetchOptions);
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Firecrawl ${endpoint} HTTP ${response.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`);
    }

    const parsed = await response.json();
    if (parsed && parsed.success === false) {
      throw new Error(`Firecrawl ${endpoint} failed: ${parsed.error || parsed.code || 'unknown error'}`);
    }
    return parsed;
  }

  return {
    baseUrl: normalizedBaseUrl,

    async health(requestTimeoutMs = 5000) {
      const fetchOptions = {
        method: 'GET',
        headers: buildHeaders(false)
      };
      if (typeof AbortSignal?.timeout === 'function' && requestTimeoutMs > 0) {
        fetchOptions.signal = AbortSignal.timeout(requestTimeoutMs);
      }
      const response = await fetchFn(`${normalizedBaseUrl}/health`, fetchOptions);
      if (!response.ok) {
        throw new Error(`Firecrawl /health HTTP ${response.status}`);
      }
      return response.json();
    },

    async scrape(url, {
      formats = ['html', 'links'],
      onlyMainContent = false,
      refresh = false,
      timeoutMs: perCallTimeoutMs
    } = {}) {
      const normalizedFormats = Array.isArray(formats) && formats.length > 0 ? formats : ['html', 'links'];
      const cacheKey = `scrape|${normalizedFormats.join(',')}|${onlyMainContent ? 'main' : 'full'}|${url}`;

      return enqueueSerial(async () => {
        if (cacheStore) {
          const cached = await cacheStore.read(cacheKey);
          if (isFreshCacheEntry(cached, nowFn(), cacheTtlMs, refresh)) {
            return {
              url,
              html: typeof cached.body === 'string' ? cached.body : (cached.html ?? null),
              rawHtml: cached.rawHtml ?? null,
              markdown: cached.markdown ?? null,
              links: Array.isArray(cached.links) ? cached.links : [],
              metadata: cached.metadata ?? null,
              fromCache: true
            };
          }
        }

        await paceLiveRequest();

        const effectiveTimeout = Number.isFinite(perCallTimeoutMs) && perCallTimeoutMs > 0
          ? perCallTimeoutMs
          : timeoutMs;
        const json = await postJson(
          '/v2/scrape',
          {
            url,
            formats: normalizedFormats,
            onlyMainContent: Boolean(onlyMainContent),
            timeout: effectiveTimeout
          },
          effectiveTimeout + 5000
        );

        const data = json?.data && typeof json.data === 'object' ? json.data : {};
        const html = typeof data.html === 'string' ? data.html : null;
        const rawHtml = typeof data.rawHtml === 'string' ? data.rawHtml : null;
        const markdown = typeof data.markdown === 'string' ? data.markdown : null;
        const links = Array.isArray(data.links) ? data.links.filter(l => typeof l === 'string') : [];
        const metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : null;

        if (cacheStore) {
          try {
            // Store largest HTML payload in `body` so file-cache.js gzip-compresses > 64 KB payloads
            const primaryHtml = rawHtml || html || '';
            await cacheStore.write(cacheKey, {
              url,
              fetchedAt: new Date(nowFn()).toISOString(),
              body: primaryHtml,
              ...(rawHtml && html && rawHtml !== html ? { html } : {}),
              markdown,
              links,
              metadata
            });
          } catch (err) {
            logger?.warn?.(`[Firecrawl Client] Cache write failed for ${url}: ${err.message}`);
          }
        }

        return {
          url,
          html: html ?? rawHtml,
          rawHtml,
          markdown,
          links,
          metadata,
          fromCache: false
        };
      });
    },

    async map(url, { refresh = false, timeoutMs: perCallTimeoutMs } = {}) {
      const cacheKey = `map|${url}`;

      return enqueueSerial(async () => {
        if (cacheStore) {
          const cached = await cacheStore.read(cacheKey);
          if (isFreshCacheEntry(cached, nowFn(), cacheTtlMs, refresh)) {
            return {
              url,
              links: Array.isArray(cached.links) ? cached.links : [],
              fromCache: true
            };
          }
        }

        await paceLiveRequest();

        const json = await postJson('/v2/map', { url }, perCallTimeoutMs);
        const links = normalizeMapLinks(json?.links ?? json?.data?.links);

        if (cacheStore) {
          try {
            await cacheStore.write(cacheKey, {
              url,
              fetchedAt: new Date(nowFn()).toISOString(),
              links
            });
          } catch (err) {
            logger?.warn?.(`[Firecrawl Client] Cache write failed for map ${url}: ${err.message}`);
          }
        }

        return {
          url,
          links,
          fromCache: false
        };
      });
    },

    async flushCache() {
      await cacheStore?.flush?.();
    }
  };
}

/**
 * Convenience factory that resolves `FIRECRAWL_LOCAL_URL` from environment variables
 * and attaches the default gzip-backed file cache store.
 *
 * @param {object} [env=process.env]
 * @param {object} [overrides={}]
 * @returns {object|null}
 */
export function createFirecrawlClientFromEnv(env = process.env, overrides = {}) {
  const baseUrl = overrides.baseUrl ?? env.FIRECRAWL_LOCAL_URL;
  if (!normalizeBaseUrl(baseUrl)) {
    return null;
  }

  const cacheStore = overrides.cacheStore !== undefined
    ? overrides.cacheStore
    : createFileCacheStore(DEFAULT_FIRECRAWL_CACHE_PATH, { flushEvery: 10 });

  return createFirecrawlClient({
    baseUrl,
    token: overrides.token ?? env.FIRECRAWL_LOCAL_TOKEN ?? null,
    cacheStore,
    ...overrides
  });
}
