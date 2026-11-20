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

const NON_ORGANIZER_FACEBOOK_PREFIXES = new Set([
  'login',
  'checkpoint',
  'sharer',
  'sharer.php',
  'share',
  'share.php',
  'dialog',
  'plugins',
  'tr',
  'l.php',
  'ajax',
  'rsrc.php',
  'policies',
  'privacy',
  'legal',
  'help',
  'settings',
  'recover',
  'reg',
  'r.php',
  'home.php',
  'events',
  'watch',
  'marketplace',
  'gaming',
  'bookmarks',
  'notifications',
  'messages',
  'stories',
  'photo.php',
  'video.php',
  'photo',
  'video',
  'reel',
  'reels',
  'permalink',
  'story'
]);

const IGNORED_PLATFORM_FACEBOOK_HANDLES = new Set([
  'wix',
  'wixstudio',
  'squarespace',
  'wordpress',
  'wordpresscom',
  'wordpressorg',
  'tidyhq',
  'tidyclub',
  'revolutionisesport',
  'revolutionise',
  'weebly',
  'webflow',
  'godaddy',
  'shopify'
]);

/**
 * Resolves a Facebook URL into a canonical Organizer Page or Public Group URL
 * (`https://www.facebook.com/...`), stripping tracking/extra query params,
 * resolving post/photo/video/event permalinks back to the parent Page/Group,
 * and ignoring share/intent/pixel paths and generic CMS/platform handles.
 *
 * @param {string | URL} rawUrlOrParsed
 * @returns {string | null}
 */
export function resolveOrganizerFacebookUrl(rawUrlOrParsed) {
  const normalized = normalizeFacebookUrl(rawUrlOrParsed);
  if (!normalized) {
    return null;
  }

  const parsed = new URL(normalized);
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  const firstLower = segments[0].toLowerCase();
  if (NON_ORGANIZER_FACEBOOK_PREFIXES.has(firstLower)) {
    return null;
  }

  if (firstLower === 'profile.php' || firstLower === 'permalink.php' || firstLower === 'story.php') {
    const id = parsed.searchParams.get('id');
    if (!id || !/^\d+$/.test(id)) {
      return null;
    }
    return `https://www.facebook.com/profile.php?id=${id}`;
  }

  if (firstLower === 'groups') {
    if (segments.length < 2) {
      return null;
    }
    const groupSlug = segments[1];
    if (IGNORED_PLATFORM_FACEBOOK_HANDLES.has(groupSlug.toLowerCase())) {
      return null;
    }
    return `https://www.facebook.com/groups/${groupSlug}`;
  }

  if (firstLower === 'pages' || firstLower === 'people') {
    if (segments.length < 3) {
      return null;
    }
    return `https://www.facebook.com/${firstLower}/${segments[1]}/${segments[2]}`;
  }

  if (firstLower === 'p') {
    if (segments.length < 2) {
      return null;
    }
    return `https://www.facebook.com/p/${segments[1]}`;
  }

  if (firstLower === 'pg') {
    if (segments.length < 2 || IGNORED_PLATFORM_FACEBOOK_HANDLES.has(segments[1].toLowerCase())) {
      return null;
    }
    return `https://www.facebook.com/${segments[1]}`;
  }

  if (IGNORED_PLATFORM_FACEBOOK_HANDLES.has(firstLower)) {
    return null;
  }

  return `https://www.facebook.com/${segments[0]}`;
}
