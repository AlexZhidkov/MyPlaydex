/**
 * URL Verification and Link Recovery Module
 * Implements pre-write ingestion link repair, bounded concurrent probing,
 * deduplication against Firestore /activities, and graceful degradation
 * to Unverified Listings (ADR 0003).
 */

export const DEFAULT_PROBE_TIMEOUT_MS = 6000;
export const DEFAULT_CONCURRENCY = 8;

/**
 * Recovers and normalizes potentially broken or unformatted URLs.
 * - Prepends https:// if missing
 * - Upgrades http:// to https://
 * - Trims whitespace and surrounding wrapper quotes/brackets
 * - Preserves full path and query strings without truncation to root domains
 *
 * @param {string} rawUrl
 * @returns {string | null}
 */
export function recoverUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return null;
  }

  let cleaned = rawUrl.trim();
  if (!cleaned) {
    return null;
  }

  // Strip leading/trailing quotes, angle brackets, parentheses, brackets
  cleaned = cleaned.replace(/^["'<(\[]+|[>"')\]]+$/g, '').trim();
  if (!cleaned) {
    return null;
  }

  // Upgrade http:// to https://
  if (/^http:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/^http:\/\//i, 'https://');
  } else if (/^\/\//.test(cleaned)) {
    cleaned = `https:${cleaned}`;
  } else if (!/^https:\/\//i.test(cleaned)) {
    // If no valid protocol prefix, prepend https://
    cleaned = `https://${cleaned}`;
  }

  try {
    const parsed = new URL(cleaned);
    if (!parsed.hostname || !parsed.hostname.includes('.')) {
      return null;
    }
    // Return reconstructed normalized URL string
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Probes a URL using HTTP HEAD with fallback to header-only GET.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {Function} [options.fetch=globalThis.fetch]
 * @param {number} [options.timeoutMs=DEFAULT_PROBE_TIMEOUT_MS]
 * @returns {Promise<{ reachable: boolean, url: string | null, status: number, error?: string }>}
 */
export async function probeUrl(url, options = {}) {
  const fetchFn = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headRes = await fetchFn(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timer);

    if (headRes.ok) {
      return {
        reachable: true,
        url: headRes.url || url,
        status: headRes.status
      };
    }

    // If server rejected HEAD (400, 403, 405, 501, etc.), fall back to header-only GET
    if ([400, 403, 405, 501].includes(headRes.status)) {
      return await executeGetFallback(url, fetchFn, timeoutMs);
    }

    return {
      reachable: false,
      url: null,
      status: headRes.status,
      error: `HTTP ${headRes.status}`
    };
  } catch (err) {
    clearTimeout(timer);

    // Fall back to GET if error was not an intentional abort/timeout
    if (err.name !== 'AbortError' && !controller.signal.aborted) {
      return await executeGetFallback(url, fetchFn, timeoutMs);
    }

    return {
      reachable: false,
      url: null,
      status: 0,
      error: err.name === 'AbortError' ? 'Request timeout' : (err.message || String(err))
    };
  }
}

async function executeGetFallback(url, fetchFn, timeoutMs) {
  const getController = new AbortController();
  const getTimer = setTimeout(() => getController.abort(), timeoutMs);

  try {
    const getRes = await fetchFn(url, {
      method: 'GET',
      redirect: 'follow',
      signal: getController.signal
    });
    clearTimeout(getTimer);

    // Header-only GET: abort/cancel body stream as soon as response headers arrive
    if (getRes.body && typeof getRes.body.cancel === 'function') {
      try {
        getRes.body.cancel();
      } catch {}
    }

    if (getRes.ok) {
      return {
        reachable: true,
        url: getRes.url || url,
        status: getRes.status
      };
    }

    return {
      reachable: false,
      url: null,
      status: getRes.status,
      error: `HTTP ${getRes.status}`
    };
  } catch (getErr) {
    clearTimeout(getTimer);
    return {
      reachable: false,
      url: null,
      status: 0,
      error: getErr.name === 'AbortError' ? 'Request timeout' : (getErr.message || String(getErr))
    };
  }
}

/**
 * Creates a bounded concurrency prober.
 *
 * @param {object} [options]
 * @param {number} [options.concurrency=DEFAULT_CONCURRENCY]
 * @param {number} [options.timeoutMs=DEFAULT_PROBE_TIMEOUT_MS]
 * @param {Function} [options.fetch=globalThis.fetch]
 * @returns {{ probe: Function, probeAll: Function }}
 */
export function createUrlProber(options = {}) {
  const concurrency = options.concurrency || DEFAULT_CONCURRENCY;

  return {
    async probe(url) {
      return probeUrl(url, options);
    },

    async probeAll(urls = []) {
      if (!urls.length) return [];

      const results = new Array(urls.length);
      let nextIndex = 0;

      const workerCount = Math.min(concurrency, urls.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < urls.length) {
          const index = nextIndex++;
          results[index] = await probeUrl(urls[index], options);
        }
      });

      await Promise.all(workers);
      return results;
    }
  };
}

/**
 * Creates an ingestion URL verifier that validates and degrades URLs before writing to Firestore.
 * - Deduplicates against existing Firestore /activities via getAll
 * - Maintains an in-memory run cache across batches
 * - Skips probing for unchanged verified URLs
 * - Re-probes previously failed (verified: false) URLs for self-healing
 * - Degrades unreachable links into Unverified Listings
 *
 * @param {object} [options]
 * @param {object} [options.adapter] - Firestore adapter instance
 * @param {object} [options.db] - Firestore db instance
 * @param {object} [options.prober] - Custom prober instance
 * @param {Map} [options.runCache] - Shared in-memory run cache
 * @param {number} [options.concurrency] - Concurrency limit
 * @param {number} [options.timeoutMs] - Request timeout in ms
 * @param {Function} [options.fetch] - Custom fetch implementation
 * @returns {{ verifyListings: Function, runCache: Map }}
 */
export function createUrlVerifier(options = {}) {
  const adapter = options.adapter;
  const db = options.db;
  const prober = options.prober || createUrlProber(options);
  const runCache = options.runCache || new Map();
  const force = Boolean(options.force);

  return {
    runCache,

    /**
     * Verifies an array of activity listing objects.
     *
     * @param {Array<object>} listings
     * @returns {Promise<Array<object>>} Updated listings conforming to canonical schema
     */
    async verifyListings(listings = []) {
      if (!listings || listings.length === 0) {
        return [];
      }

      // 1. Fetch existing Firestore records for candidate listing IDs
      const listingIds = listings.map(l => l.id).filter(Boolean);
      let existingDocsMap = options.existingDocsMap || new Map();

      if (existingDocsMap.size === 0) {
        if (adapter && typeof adapter.getActivities === 'function') {
          try {
            existingDocsMap = await adapter.getActivities(listingIds);
          } catch {
            existingDocsMap = new Map();
          }
        } else if (db && typeof db.getAll === 'function') {
          try {
            const docRefs = listingIds.map(id => db.collection('activities').doc(id));
            const snapshots = await db.getAll(...docRefs);
            for (const snap of snapshots) {
              if (snap && snap.exists) {
                existingDocsMap.set(snap.id, snap.data());
              }
            }
          } catch {
            existingDocsMap = new Map();
          }
        }
      }

      // 2. Classify listings: skip / cache-hit / probe needed
      const itemsToProbe = [];
      const resolvedListings = listings.map(l => ({ ...l }));

      for (let i = 0; i < resolvedListings.length; i++) {
        const item = resolvedListings[i];
        const rawCandidate = item.source_url || item.raw_source_url;
        const candidateUrl = typeof rawCandidate === 'string' ? rawCandidate.trim() : '';

        // Strict preservation of raw_source_url
        const preservedRawUrl = (typeof item.raw_source_url === 'string' && item.raw_source_url.trim())
          ? item.raw_source_url.trim()
          : (candidateUrl || null);
        item.raw_source_url = preservedRawUrl;

        // If no candidate URL at all, degrade to Unverified
        if (!candidateUrl) {
          item.verified = false;
          item.source_url = null;
          continue;
        }

        // Check existing Firestore record:
        // If already verified: true and matching URL, skip probing (unless force is true)
        const existing = existingDocsMap.get(item.id);
        if (!force && existing && existing.verified === true) {
          const existingUrl = existing.source_url || existing.raw_source_url;
          if (existingUrl === candidateUrl || existing.source_url === candidateUrl) {
            item.verified = true;
            item.source_url = existing.source_url || candidateUrl;
            continue;
          }
        }

        // Check in-memory run cache (unless force is true)
        if (!force) {
          const cached = runCache.get(candidateUrl);
          if (cached) {
            if (cached.reachable) {
              item.verified = true;
              item.source_url = cached.url;
            } else {
              item.verified = false;
              item.source_url = null;
            }
            continue;
          }
        }

        // Attempt automated link recovery
        const recovered = recoverUrl(candidateUrl);
        if (!recovered) {
          item.verified = false;
          item.source_url = null;
          runCache.set(candidateUrl, { reachable: false, url: null });
          continue;
        }

        // Check run cache with recovered URL (unless force is true)
        if (!force) {
          const cachedRecovered = runCache.get(recovered);
          if (cachedRecovered) {
            if (cachedRecovered.reachable) {
              item.verified = true;
              item.source_url = cachedRecovered.url;
            } else {
              item.verified = false;
              item.source_url = null;
            }
            runCache.set(candidateUrl, cachedRecovered);
            continue;
          }
        }

        itemsToProbe.push({
          index: i,
          candidateUrl,
          recoveredUrl: recovered
        });
      }

      if (itemsToProbe.length === 0) {
        return resolvedListings;
      }

      // 3. Deduplicate unique URLs to probe in parallel via bounded concurrency pool
      const uniqueRecoveredUrls = Array.from(new Set(itemsToProbe.map(p => p.recoveredUrl)));
      const probeResults = await prober.probeAll(uniqueRecoveredUrls);

      const probeResultsMap = new Map();
      for (let j = 0; j < uniqueRecoveredUrls.length; j++) {
        const url = uniqueRecoveredUrls[j];
        const res = probeResults[j];
        probeResultsMap.set(url, res);
        runCache.set(url, res);
      }

      // 4. Update listings with probe results
      for (const { index, candidateUrl, recoveredUrl } of itemsToProbe) {
        const probeResult = probeResultsMap.get(recoveredUrl);
        runCache.set(candidateUrl, probeResult);

        const item = resolvedListings[index];
        if (probeResult && probeResult.reachable) {
          item.verified = true;
          item.source_url = probeResult.url || recoveredUrl;
        } else {
          item.verified = false;
          item.source_url = null;
        }
      }

      return resolvedListings;
    }
  };
}

/**
 * Convenience one-shot helper to verify a list of activities.
 *
 * @param {Array<object>} listings
 * @param {object} [options]
 * @returns {Promise<Array<object>>}
 */
export async function verifyListings(listings = [], options = {}) {
  const verifier = createUrlVerifier(options);
  return verifier.verifyListings(listings);
}

