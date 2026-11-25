/**
 * Outbound Directory Link Harvester (ADR 0013)
 * Extracts and normalizes outbound club/Organizer website domains from council
 * club directories and state-association pages, filtering social platforms,
 * generic directories, and domains already represented in `/organizers`.
 */

import { decodeHtmlEntities } from './crawlers/html-utils.js';

export const DEFAULT_DIRECTORY_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DIRECTORY_HARVEST_QUEUE_KEY = 'tier2_harvested_domains';

export const DEFAULT_DIRECTORY_SOURCES = Object.freeze([
  {
    name: 'dlgsc_find_a_club',
    url: 'https://kidsport.dlgsc.wa.gov.au/find-a-club/'
  },
  {
    name: 'volleyball_wa_clubs',
    url: 'https://volleyballwa.com.au/places/find-a-club/'
  },
  {
    name: 'stirling_club_directory',
    url: 'https://www.stirling.wa.gov.au/services-and-support/community/clubs-and-groups/a-z-club-directory'
  },
  {
    name: 'joondalup_club_directory',
    url: 'https://www.joondalup.wa.gov.au/kb/resident/community-directory'
  }
]);

const SOCIAL_PLATFORM_SUFFIXES = [
  'facebook.com',
  'fb.com',
  'fb.me',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'pinterest.com',
  'threads.net',
  'snapchat.com',
  'whatsapp.com',
  't.me',
  'discord.gg',
  'discord.com'
];

const GENERIC_DIRECTORY_SUFFIXES = [
  'eventbrite.com',
  'eventbrite.com.au',
  'meetup.com',
  'trybooking.com',
  'humanitix.com',
  'mycommunitydirectory.com.au',
  'mycommunitydiary.com.au',
  'dlgsc.wa.gov.au',
  'wa.gov.au',
  'sportaus.gov.au',
  'yellowpages.com.au',
  'truelocal.com.au',
  'yelp.com',
  'yelp.com.au',
  'google.com',
  'goo.gl',
  'bit.ly',
  'linktr.ee',
  'linktree.com',
  'wikipedia.org',
  'apple.com',
  'play.google.com',
  'actbelongcommit.org.au',
  'volleyballwa.com.au'
];

const GENERIC_LINK_LABELS = new Set([
  'website',
  'visit website',
  'official website',
  'club website',
  'homepage',
  'home page',
  'home',
  'click here',
  'here',
  'link',
  'more',
  'more info',
  'more information',
  'learn more',
  'read more',
  'view website',
  'external link'
]);

const HTML_ANCHOR_REGEX = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
const MARKDOWN_LINK_REGEX = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi;

function matchesDomainSuffix(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function parseHttpUrl(rawUrl, { allowBareHost = false } = {}) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const withScheme = (!/^https?:\/\//i.test(trimmed) && allowBareHost)
      ? `https://${trimmed}`
      : trimmed;
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Normalizes a URL or hostname to its lowercase root domain without `www.`.
 *
 * @param {unknown} rawUrlOrHost
 * @returns {string|null}
 */
export function normalizeDomainHost(rawUrlOrHost) {
  const parsed = parseHttpUrl(rawUrlOrHost, { allowBareHost: true });
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  return host && host.includes('.') ? host : null;
}

function normalizeRootWebsiteUrl(rawUrl) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return null;
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}/`;
}

function cleanLinkLabel(rawLabel) {
  if (typeof rawLabel !== 'string') return '';
  const withoutTags = rawLabel.replace(/<[^>]+>/g, ' ');
  const cleaned = decodeHtmlEntities(withoutTags).replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (/^https?:\/\//i.test(cleaned) || GENERIC_LINK_LABELS.has(cleaned.toLowerCase())) {
    return '';
  }
  return cleaned;
}

function deriveNameFromHost(host) {
  const firstLabel = String(host || '').split('.')[0] || 'community-organizer';
  return firstLabel
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase())
    .trim();
}

function isExcludedHost(host, directoryHost) {
  if (!host) return true;
  if (directoryHost && matchesDomainSuffix(host, directoryHost)) {
    return true;
  }
  if (SOCIAL_PLATFORM_SUFFIXES.some(suffix => matchesDomainSuffix(host, suffix))) {
    return true;
  }
  if (GENERIC_DIRECTORY_SUFFIXES.some(suffix => matchesDomainSuffix(host, suffix))) {
    return true;
  }
  return false;
}

/**
 * Collects normalized domain hosts already represented in `/organizers`.
 *
 * @param {Array<object>} [organizersCatalog=[]]
 * @returns {Set<string>}
 */
export function collectKnownOrganizerHosts(organizersCatalog = []) {
  const hosts = new Set();
  for (const org of Array.isArray(organizersCatalog) ? organizersCatalog : []) {
    if (!org || typeof org !== 'object') continue;
    const candidates = [org.website, org.source_url, org.raw_source_url];
    for (const ref of Array.isArray(org.sources) ? org.sources : []) {
      candidates.push(ref?.source_url);
    }
    for (const raw of candidates) {
      const host = normalizeDomainHost(raw);
      if (host) {
        hosts.add(host);
      }
    }
  }
  return hosts;
}

/**
 * Extracts and normalizes outbound club/Organizer domain links from a directory
 * page's HTML and/or Markdown, filtering social platforms, generic directories,
 * and domains already represented in `/organizers`.
 *
 * @param {object} [params={}]
 * @returns {Array<{ host: string, websiteUrl: string, organizerName: string, sourceDirectoryUrl: string }>}
 */
export function extractOutboundDirectoryLinks({
  html = '',
  markdown = '',
  directoryUrl = '',
  organizersCatalog = []
} = {}) {
  const directoryHost = normalizeDomainHost(directoryUrl);
  const knownHosts = collectKnownOrganizerHosts(organizersCatalog);
  const discoveredByHost = new Map();

  function considerCandidate(rawHref, rawLabel) {
    const websiteUrl = normalizeRootWebsiteUrl(rawHref);
    const host = normalizeDomainHost(websiteUrl);
    if (!websiteUrl || !host) return;
    if (isExcludedHost(host, directoryHost)) return;
    if (knownHosts.has(host)) return;
    if (discoveredByHost.has(host)) return;

    const label = cleanLinkLabel(rawLabel);
    discoveredByHost.set(host, {
      host,
      websiteUrl,
      organizerName: label || deriveNameFromHost(host),
      sourceDirectoryUrl: directoryUrl
    });
  }

  if (typeof html === 'string' && html) {
    HTML_ANCHOR_REGEX.lastIndex = 0;
    let match;
    while ((match = HTML_ANCHOR_REGEX.exec(html)) !== null) {
      const href = match[1] ?? match[2] ?? match[3] ?? '';
      const label = match[4] ?? '';
      considerCandidate(href, label);
    }
  }

  if (typeof markdown === 'string' && markdown) {
    MARKDOWN_LINK_REGEX.lastIndex = 0;
    let match;
    while ((match = MARKDOWN_LINK_REGEX.exec(markdown)) !== null) {
      considerCandidate(match[2], match[1]);
    }
  }

  return Array.from(discoveredByHost.values());
}

function directoryCheckpointKey(directoryUrl) {
  return `directory_harvest_checkpoint|${directoryUrl}`;
}

function isFreshDirectoryCheckpoint(checkpoint, nowMs, ttlMs, refresh, force) {
  if (refresh || force || !checkpoint || typeof checkpoint !== 'object') {
    return false;
  }
  const harvestedAtMs = checkpoint.harvestedAt ? Date.parse(checkpoint.harvestedAt) : NaN;
  return Number.isFinite(harvestedAtMs) && (nowMs - harvestedAtMs) < ttlMs;
}

/**
 * Scrapes configured council and state-association directory pages (with checkpoint
 * caching) and persists newly discovered outbound club domains for the Tier-2 drip queue.
 *
 * @param {object} [params={}]
 * @returns {Promise<{ harvestedDomains: Array<object>, scrapedDirectories: number, cachedDirectories: number, failedDirectories: number }>}
 */
export async function harvestDirectoryDomains({
  directorySources = DEFAULT_DIRECTORY_SOURCES,
  firecrawlClient = null,
  cacheStore = null,
  organizersCatalog = [],
  now = new Date(),
  dryRun = false,
  refresh = false,
  force = false,
  directoryCacheTtlMs = DEFAULT_DIRECTORY_CACHE_TTL_MS,
  logger = console
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const knownHosts = collectKnownOrganizerHosts(organizersCatalog);
  const existingQueueEntry = cacheStore ? await cacheStore.read(DIRECTORY_HARVEST_QUEUE_KEY) : null;
  const queuedByHost = new Map();

  for (const item of Array.isArray(existingQueueEntry?.domains) ? existingQueueEntry.domains : []) {
    const host = normalizeDomainHost(item?.websiteUrl || item?.host);
    if (!host || knownHosts.has(host)) continue;
    queuedByHost.set(host, item);
  }

  let scrapedDirectories = 0;
  let cachedDirectories = 0;
  let failedDirectories = 0;
  let queueDirty = false;

  for (const source of Array.isArray(directorySources) ? directorySources : []) {
    const directoryUrl = typeof source === 'string' ? source : source?.url;
    if (!directoryUrl) continue;

    const checkpoint = cacheStore ? await cacheStore.read(directoryCheckpointKey(directoryUrl)) : null;
    if (isFreshDirectoryCheckpoint(checkpoint, nowMs, directoryCacheTtlMs, refresh, force)) {
      cachedDirectories += 1;
      continue;
    }

    if (!firecrawlClient) continue;

    try {
      const scraped = await firecrawlClient.scrape(directoryUrl, {
        formats: ['html', 'markdown'],
        onlyMainContent: false,
        refresh
      });
      scrapedDirectories += 1;

      const discovered = extractOutboundDirectoryLinks({
        html: scraped?.html || '',
        markdown: scraped?.markdown || '',
        directoryUrl,
        organizersCatalog
      });

      for (const candidate of discovered) {
        if (!queuedByHost.has(candidate.host)) {
          queuedByHost.set(candidate.host, {
            ...candidate,
            discoveredAt: new Date(nowMs).toISOString()
          });
          queueDirty = true;
        }
      }

      if (!dryRun && cacheStore) {
        await cacheStore.write(directoryCheckpointKey(directoryUrl), {
          directoryUrl,
          harvestedAt: new Date(nowMs).toISOString(),
          discoveredCount: discovered.length
        });
      }
    } catch (err) {
      failedDirectories += 1;
      logger?.warn?.(`[Directory Harvester] Failed to scrape directory ${directoryUrl}: ${err.message}`);
    }
  }

  const harvestedDomains = Array.from(queuedByHost.values()).filter(
    item => !knownHosts.has(normalizeDomainHost(item?.websiteUrl || item?.host))
  );

  if (!dryRun && cacheStore && (queueDirty || scrapedDirectories > 0)) {
    await cacheStore.write(DIRECTORY_HARVEST_QUEUE_KEY, {
      updatedAt: new Date(nowMs).toISOString(),
      domains: harvestedDomains
    });
  }

  return {
    harvestedDomains,
    scrapedDirectories,
    cachedDirectories,
    failedDirectories
  };
}
