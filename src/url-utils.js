/**
 * Shared URL normalization and Facebook URL canonicalization utilities.
 */

const FACEBOOK_HOSTNAMES = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'mbasic.facebook.com',
  'web.facebook.com',
  'fb.me',
  'www.fb.me',
  'fb.com',
  'www.fb.com'
]);

const FACEBOOK_TRACKING_PARAM_PREFIXES = ['__cft__', '__tn__'];
const FACEBOOK_TRACKING_PARAMS = new Set(['fbclid', 'acontext', 'ref', 'aref']);
const INTERSTITIAL_PATH_PREFIXES = ['/login', '/checkpoint'];
const FACEBOOK_INTERSTITIAL_PATH_PREFIXES = [...INTERSTITIAL_PATH_PREFIXES, '/sharer'];

function hasPathPrefix(parsed, prefixes) {
  const pathname = parsed.pathname.toLowerCase();
  return prefixes.some(prefix =>
    pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}.`)
  );
}

/**
 * Strips wrapper characters, upgrades http:// to https://, and parses a URL.
 *
 * @param {string} rawUrl
 * @returns {URL | null}
 */
export function parseNormalizedUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return null;
  }

  let cleaned = rawUrl.trim();
  if (!cleaned) {
    return null;
  }

  cleaned = cleaned.replace(/^["'<(\[]+|[>"')\]]+$/g, '').trim();
  if (!cleaned) {
    return null;
  }

  if (/^http:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/^http:\/\//i, 'https://');
  } else if (/^\/\//.test(cleaned)) {
    cleaned = `https:${cleaned}`;
  } else if (!/^https:\/\//i.test(cleaned)) {
    cleaned = `https://${cleaned}`;
  }

  try {
    const parsed = new URL(cleaned);
    if (!parsed.hostname || !parsed.hostname.includes('.')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Checks whether a URL string or URL object points to a supported Facebook domain.
 *
 * @param {string | URL} urlOrParsed
 * @returns {boolean}
 */
export function isFacebookUrl(urlOrParsed) {
  const parsed = urlOrParsed instanceof URL ? urlOrParsed : parseNormalizedUrl(urlOrParsed);
  if (!parsed) {
    return false;
  }
  return FACEBOOK_HOSTNAMES.has(parsed.hostname.toLowerCase());
}

/**
 * Checks whether a URL's pathname starts with a /login or /checkpoint interstitial path.
 *
 * @param {string | URL} urlOrParsed
 * @returns {boolean}
 */
export function isLoginOrCheckpointPath(urlOrParsed) {
  const parsed = urlOrParsed instanceof URL ? urlOrParsed : parseNormalizedUrl(urlOrParsed);
  if (!parsed) {
    return false;
  }
  return hasPathPrefix(parsed, INTERSTITIAL_PATH_PREFIXES);
}

/**
 * Normalizes a Facebook URL to canonical `https://www.facebook.com/...` format:
 * - Upgrades http:// to https://
 * - Normalizes mobile/short Facebook hostnames to www.facebook.com
 * - Strips tracking query parameters (fbclid, acontext, ref, aref, __cft__*, __tn__*)
 * - Rejects /login, /checkpoint, and /sharer interstitial paths (returns null)
 * - Returns null for non-Facebook or invalid URLs
 *
 * @param {string | URL} rawUrlOrParsed
 * @returns {string | null}
 */
export function normalizeFacebookUrl(rawUrlOrParsed) {
  const parsed = rawUrlOrParsed instanceof URL
    ? new URL(rawUrlOrParsed.href)
    : parseNormalizedUrl(rawUrlOrParsed);
  if (!parsed || !isFacebookUrl(parsed)) {
    return null;
  }

  if (parsed.hash && parsed.hash.startsWith('#!')) {
    const hashTarget = parsed.hash.slice(2).trim();
    if (hashTarget.startsWith('/') && (parsed.pathname === '/' || !parsed.pathname)) {
      const hashUrl = new URL(hashTarget, 'https://www.facebook.com');
      parsed.pathname = hashUrl.pathname;
      for (const [key, value] of hashUrl.searchParams.entries()) {
        if (!parsed.searchParams.has(key)) {
          parsed.searchParams.set(key, value);
        }
      }
    }
    parsed.hash = '';
  }

  if (hasPathPrefix(parsed, FACEBOOK_INTERSTITIAL_PATH_PREFIXES)) {
    return null;
  }

  parsed.protocol = 'https:';
  parsed.hostname = 'www.facebook.com';

  for (const key of Array.from(parsed.searchParams.keys())) {
    const lowerKey = key.toLowerCase();
    const isTracking =
      FACEBOOK_TRACKING_PARAMS.has(lowerKey) ||
      FACEBOOK_TRACKING_PARAM_PREFIXES.some(prefix => lowerKey === prefix || lowerKey.startsWith(`${prefix}[`));
    if (isTracking) {
      parsed.searchParams.delete(key);
    }
  }

  return parsed.href;
}

const FACEBOOK_PAGE_TABS = new Set([
  'about',
  'posts',
  'photos',
  'videos',
  'reels',
  'mentions',
  'community',
  'reviews',
  'followers',
  'following'
]);

/**
 * Derives the dedicated `/events` tab URL for a Facebook Organizer Page, Public Group,
 * or `profile.php?id=...` URL while leaving `/events` and `/events/<id>` URLs unchanged.
 *
 * @param {string | URL} rawUrlOrParsed
 * @returns {string | null}
 */
export function deriveFacebookEventsTabUrl(rawUrlOrParsed) {
  const normalized = normalizeFacebookUrl(rawUrlOrParsed);
  if (!normalized) {
    return null;
  }

  const parsed = new URL(normalized);
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return normalized;
  }

  const lowerSegments = segments.map(s => s.toLowerCase());
  const isAlreadyEventsRoute =
    lowerSegments[0] === 'events' ||
    lowerSegments[lowerSegments.length - 1] === 'events' ||
    (lowerSegments[0] === 'groups' && segments.length >= 3 && lowerSegments[2] === 'events');
  if (isAlreadyEventsRoute) {
    return normalized;
  }

  if (segments.length === 1 && lowerSegments[0] === 'profile.php') {
    if (parsed.searchParams.has('id')) {
      parsed.searchParams.set('sk', 'events');
      return parsed.href;
    }
    return normalized;
  }

  if (lowerSegments[0] === 'groups' && segments.length >= 2) {
    parsed.pathname = `/groups/${segments[1]}/events`;
    return parsed.href;
  }

  if (segments.length === 2 && FACEBOOK_PAGE_TABS.has(lowerSegments[1])) {
    parsed.pathname = `/${segments[0]}/events`;
    return parsed.href;
  }

  parsed.pathname = `/${segments.join('/')}/events`;
  return parsed.href;
}
