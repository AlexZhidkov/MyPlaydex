/**
 * URL Verification and Link Recovery Module
 * Implements pre-write ingestion link repair, bounded concurrent probing,
 * deduplication against Firestore /activities, /organizers, and /venues,
 * and graceful degradation to Unverified Listings (ADR 0003 & ADR 0004).
 */

import { resolveCollectionForListingId } from './firestore-adapter.js';
import { getSourcePriority } from './activity-deduplicator.js';
import {
  parseNormalizedUrl,
  isFacebookUrl,
  isLoginOrCheckpointPath,
  normalizeFacebookUrl
} from './url-utils.js';

export { normalizeFacebookUrl, isFacebookUrl };

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
  const parsed = parseNormalizedUrl(rawUrl);
  if (!parsed) {
    return null;
  }

  if (isFacebookUrl(parsed)) {
    return normalizeFacebookUrl(parsed);
  }

  return parsed.href;
}

function resolveFinalProbeUrl(redirectedUrl, candidateUrl) {
  if (!redirectedUrl || isLoginOrCheckpointPath(redirectedUrl)) {
    return candidateUrl;
  }
  return redirectedUrl;
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
        url: resolveFinalProbeUrl(headRes.url, url),
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
        url: resolveFinalProbeUrl(getRes.url, url),
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

function resolveCandidateUrls(entry = {}) {
  const rawCandidate = entry.source_url || entry.raw_source_url || entry.external_url || entry.url || entry.website;
  const candidateUrl = typeof rawCandidate === 'string' ? rawCandidate.trim() : '';
  const preservedRawUrl = (typeof entry.raw_source_url === 'string' && entry.raw_source_url.trim())
    ? entry.raw_source_url.trim()
    : (candidateUrl || null);
  return { candidateUrl, preservedRawUrl };
}

function readRunCache(runCache, key, force) {
  if (force || !key) {
    return null;
  }
  const cached = runCache.get(key);
  if (!cached) {
    return null;
  }
  return {
    done: true,
    reachable: Boolean(cached.reachable),
    url: cached.reachable ? cached.url : null
  };
}

function tryResolveWithoutProbing(candidateUrl, runCache, force) {
  if (!candidateUrl) {
    return { done: true, reachable: false, url: null };
  }

  const cached = readRunCache(runCache, candidateUrl, force);
  if (cached) {
    return cached;
  }

  const recovered = recoverUrl(candidateUrl);
  if (!recovered) {
    runCache.set(candidateUrl, { reachable: false, url: null });
    return { done: true, reachable: false, url: null };
  }

  if (isFacebookUrl(recovered)) {
    const fbResult = { reachable: true, url: recovered };
    runCache.set(candidateUrl, fbResult);
    runCache.set(recovered, fbResult);
    return { done: true, reachable: true, url: recovered };
  }

  const cachedRecovered = readRunCache(runCache, recovered, force);
  if (cachedRecovered) {
    runCache.set(candidateUrl, runCache.get(recovered));
    return cachedRecovered;
  }

  return { done: false, candidateUrl, recoveredUrl: recovered };
}

function prepareOrderedCandidates(item) {
  const hasSources = Array.isArray(item.sources) && item.sources.length > 0;
  if (!hasSources) {
    const { candidateUrl, preservedRawUrl } = resolveCandidateUrls(item);
    return [{
      ref: null,
      candidateUrl,
      preservedRawUrl
    }];
  }

  item.sources = item.sources.map(ref => ({ ...ref }));
  const candidates = item.sources.map(ref => {
    const { candidateUrl, preservedRawUrl } = resolveCandidateUrls(ref);
    ref.raw_source_url = preservedRawUrl;
    return {
      ref,
      source: ref.source,
      sourceKey: ref.source_key || '',
      isPrimary: false,
      candidateUrl,
      preservedRawUrl
    };
  });

  const { candidateUrl: primaryUrl, preservedRawUrl: primaryRawUrl } = resolveCandidateUrls(item);
  if (primaryUrl) {
    const alreadyInSources = candidates.some(c =>
      c.candidateUrl === primaryUrl || c.preservedRawUrl === primaryUrl
    );
    if (!alreadyInSources) {
      candidates.push({
        ref: null,
        source: item.source,
        sourceKey: '',
        isPrimary: true,
        candidateUrl: primaryUrl,
        preservedRawUrl: primaryRawUrl
      });
    }
  }

  candidates.sort((a, b) => {
    const priorityDiff = getSourcePriority(b.source) - getSourcePriority(a.source);
    if (priorityDiff !== 0) return priorityDiff;
    const primaryDiff = Number(b.isPrimary) - Number(a.isPrimary);
    if (primaryDiff !== 0) return primaryDiff;
    return String(a.sourceKey).localeCompare(String(b.sourceKey));
  });

  return candidates;
}

function applyCandidateOutcome(item, candidate, reachable, resolvedUrl) {
  if (candidate.ref) {
    candidate.ref.verified = reachable;
    candidate.ref.source_url = reachable ? resolvedUrl : null;
    candidate.ref.raw_source_url = candidate.preservedRawUrl;
  }

  if (reachable) {
    item.verified = true;
    item.source_url = resolvedUrl;
    if (candidate.ref && candidate.preservedRawUrl) {
      item.raw_source_url = candidate.preservedRawUrl;
    }
  }
}

function finalizeAllFailed(item) {
  item.verified = false;
  item.source_url = null;
}

async function resolveCandidatesInWaves(pendingStates, prober, runCache, force) {
  while (pendingStates.length > 0) {
    const waveItems = [];
    const nextRoundStates = [];

    for (const state of pendingStates) {
      let queuedForProbe = false;

      while (state.cursor < state.candidates.length) {
        const candidate = state.candidates[state.cursor];
        const instant = tryResolveWithoutProbing(candidate.candidateUrl, runCache, force);

        if (!instant.done) {
          waveItems.push({ state, candidate, recoveredUrl: instant.recoveredUrl });
          queuedForProbe = true;
          break;
        }

        if (instant.reachable) {
          applyCandidateOutcome(state.item, candidate, true, instant.url);
          break;
        }

        applyCandidateOutcome(state.item, candidate, false, null);
        state.cursor += 1;
      }

      if (!queuedForProbe && state.cursor >= state.candidates.length) {
        finalizeAllFailed(state.item);
      }
    }

    if (waveItems.length === 0) {
      break;
    }

    const uniqueRecoveredUrls = Array.from(new Set(waveItems.map(w => w.recoveredUrl)));
    const probeResults = await prober.probeAll(uniqueRecoveredUrls);

    const probeResultsMap = new Map();
    for (let j = 0; j < uniqueRecoveredUrls.length; j++) {
      const url = uniqueRecoveredUrls[j];
      const res = probeResults[j];
      probeResultsMap.set(url, res);
      runCache.set(url, res);
    }

    for (const { state, candidate, recoveredUrl } of waveItems) {
      const probeResult = probeResultsMap.get(recoveredUrl);
      runCache.set(candidate.candidateUrl, probeResult);

      if (probeResult && probeResult.reachable) {
        applyCandidateOutcome(state.item, candidate, true, probeResult.url || recoveredUrl);
      } else {
        applyCandidateOutcome(state.item, candidate, false, null);
        state.cursor += 1;
        if (state.cursor < state.candidates.length) {
          nextRoundStates.push(state);
        } else {
          finalizeAllFailed(state.item);
        }
      }
    }

    pendingStates.length = 0;
    pendingStates.push(...nextRoundStates);
  }
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

      if (existingDocsMap.size === 0 && listingIds.length > 0) {
        if (adapter && typeof adapter.getListings === 'function') {
          try {
            existingDocsMap = await adapter.getListings(listingIds);
          } catch {
            existingDocsMap = new Map();
          }
        } else if (adapter) {
          try {
            const orgIds = [];
            const venueIds = [];
            const activityIds = [];
            for (const id of listingIds) {
              const col = resolveCollectionForListingId(id);
              if (col === 'organizers' && typeof adapter.getOrganizers === 'function') {
                orgIds.push(id);
              } else if (col === 'venues' && typeof adapter.getVenues === 'function') {
                venueIds.push(id);
              } else {
                activityIds.push(id);
              }
            }
            const lookups = [];
            if (activityIds.length > 0 && typeof adapter.getActivities === 'function') {
              lookups.push(adapter.getActivities(activityIds));
            }
            if (orgIds.length > 0) {
              lookups.push(adapter.getOrganizers(orgIds));
            }
            if (venueIds.length > 0) {
              lookups.push(adapter.getVenues(venueIds));
            }
            const maps = await Promise.all(lookups);
            existingDocsMap = new Map();
            for (const map of maps) {
              if (map && typeof map.entries === 'function') {
                for (const [k, v] of map.entries()) {
                  existingDocsMap.set(k, v);
                }
              }
            }
          } catch {
            existingDocsMap = new Map();
          }
        } else if (db && typeof db.getAll === 'function') {
          try {
            const docRefs = listingIds.map(id => db.collection(resolveCollectionForListingId(id)).doc(id));
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

      // 2. Classify listings: skip / cache-hit / build priority-ordered candidate queues
      const pendingStates = [];
      const resolvedListings = listings.map(l => ({ ...l }));

      for (let i = 0; i < resolvedListings.length; i++) {
        const item = resolvedListings[i];
        const { candidateUrl, preservedRawUrl } = resolveCandidateUrls(item);
        item.raw_source_url = preservedRawUrl;

        const hasSources = Array.isArray(item.sources) && item.sources.length > 0;

        const existing = existingDocsMap.get(item.id);
        if (!hasSources && existing && Array.isArray(existing.sources) && existing.sources.length > 0) {
          item.sources = existing.sources.map(ref => ({ ...ref }));
        }

        const effectiveHasSources = Array.isArray(item.sources) && item.sources.length > 0;

        // If no candidate URL and no Source References at all, degrade to Unverified
        if (!candidateUrl && !effectiveHasSources) {
          finalizeAllFailed(item);
          continue;
        }

        // Check existing Firestore record:
        // If already verified: true and matching URL, skip probing (unless force is true)
        if (!force && existing && existing.verified === true) {
          const existingUrl = existing.source_url || existing.raw_source_url || existing.external_url || existing.url || existing.website;
          if (existingUrl === candidateUrl || existing.source_url === candidateUrl) {
            const matchedUrl = existing.source_url || candidateUrl;
            if (isFacebookUrl(matchedUrl)) {
              const canonicalFb = normalizeFacebookUrl(matchedUrl);
              item.verified = Boolean(canonicalFb);
              item.source_url = canonicalFb;
            } else {
              item.verified = true;
              item.source_url = matchedUrl;
            }
            continue;
          }
        }

        pendingStates.push({
          item,
          candidates: prepareOrderedCandidates(item),
          cursor: 0
        });
      }

      // 3. Resolve candidates in priority-ordered waves using bounded concurrency
      await resolveCandidatesInWaves(pendingStates, prober, runCache, force);

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

