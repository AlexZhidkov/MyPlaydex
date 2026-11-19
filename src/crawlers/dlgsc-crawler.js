/**
 * WA Department of Local Government, Sport and Cultural Industries (DLGSC)
 * Sports Club Directory Crawler Adapter.
 * Ingests sports clubs across Greater Perth from the public KidSport REST API.
 */

import { slugify, normalizeSubcategories } from '../sanitizer.js';
import { normalizeFacebookUrl } from '../url-utils.js';
import { encodeGeohash } from '../geohash.js';
import { calculateDistanceKm } from '../discovery-engine.js';

export const DLGSC_ENDPOINT = 'https://kidsport.dlgsc.wa.gov.au/api/find-a-club-search/';
export const PERTH_CENTROID = { lat: -31.9505, lng: 115.8605 };
export const DEFAULT_MAX_DISTANCE_KM = 85;

/**
 * Derives demographics age group from DLGSC ageGroups flags.
 *
 * @param {object} [ageGroups]
 * @returns {'all' | 'juniors' | 'adults' | 'masters'}
 */
function deriveAgeGroup(ageGroups) {
  if (!ageGroups || typeof ageGroups !== 'object') {
    return 'all';
  }

  const isJunior = Boolean(ageGroups.at0to12 || ageGroups.at13to18);
  const isAdult = Boolean(ageGroups.at19to30 || ageGroups.at31to50);
  const isMaster = Boolean(ageGroups.at51to99);

  if (isJunior && !isAdult && !isMaster) return 'juniors';
  if (isAdult && !isJunior && !isMaster) return 'adults';
  if (isMaster && !isJunior && !isAdult) return 'masters';

  return 'all';
}

/**
 * Safely decodes URI-encoded text (e.g. %27 -> ', %2C -> ,) and trims whitespace.
 *
 * @param {string} str
 * @returns {string}
 */
function cleanText(str) {
  if (!str || typeof str !== 'string') return '';
  try {
    return decodeURIComponent(str).trim();
  } catch {
    return str.trim();
  }
}

const STRING_PROP_START_REGEX = /^\s*"[A-Za-z0-9_]+"?\s*:\s*"/;
const COMPLETE_STRING_PROP_REGEX = /^\s*"[A-Za-z0-9_]+"?\s*:\s*"[\s\S]*"\s*,?\s*$/;
const VALID_NEXT_JSON_TOKEN_REGEX = /^\s*(?:[{}\[\]]|"[A-Za-z0-9_]+"?\s*:)/;
const STRING_PROP_LINE_REGEX = /^(\s*"[A-Za-z0-9_]+"?\s*:\s*)"([\s\S]*)"(\s*,?\s*)$/;

/**
 * Escapes unescaped double quotes, bare/trailing backslashes, and raw control
 * characters inside a JSON string property value while preserving valid escapes.
 *
 * @param {string} inner
 * @returns {string}
 */
function escapeInnerJsonString(inner) {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\') {
      const next = inner[i + 1];
      if (next === undefined) {
        out += '\\\\';
      } else if (
        next === '"' ||
        next === '\\' ||
        next === '/' ||
        next === 'b' ||
        next === 'f' ||
        next === 'n' ||
        next === 'r' ||
        next === 't'
      ) {
        out += ch + next;
        i++;
      } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(inner.slice(i + 2, i + 6))) {
        out += inner.slice(i, i + 6);
        i += 5;
      } else {
        out += '\\\\';
      }
      continue;
    }

    if (ch === '"') {
      out += '\\"';
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      if (code === 0x0a) out += '\\n';
      else if (code === 0x0d) out += '\\r';
      else if (code === 0x09) out += '\\t';
      else if (code === 0x08) out += '\\b';
      else if (code === 0x0c) out += '\\f';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    out += ch;
  }
  return out;
}

/**
 * Repairs malformed DLGSC JSON containing raw multiline string properties,
 * unescaped double quotes, and bare or trailing backslashes.
 *
 * @param {string} rawText
 * @returns {string}
 */
export function repairMalformedDlgscJson(rawText = '') {
  if (!rawText || typeof rawText !== 'string') {
    return rawText;
  }

  const rawLines = rawText.split(/\r?\n/);
  const mergedLines = [];

  for (const line of rawLines) {
    if (mergedLines.length > 0) {
      const prev = mergedLines[mergedLines.length - 1];
      if (STRING_PROP_START_REGEX.test(prev)) {
        const prevComplete = COMPLETE_STRING_PROP_REGEX.test(prev);
        const nextStartsValidToken = VALID_NEXT_JSON_TOKEN_REGEX.test(line);
        if (!prevComplete || (line.trim() !== '' && !nextStartsValidToken)) {
          mergedLines[mergedLines.length - 1] = `${prev}\n${line}`;
          continue;
        }
      }
    }
    mergedLines.push(line);
  }

  return mergedLines
    .map(line => {
      const match = line.match(STRING_PROP_LINE_REGEX);
      if (!match) {
        return line;
      }
      const [, prefix, inner, suffix] = match;
      return `${prefix}"${escapeInnerJsonString(inner)}"${suffix}`;
    })
    .join('\n');
}

function extractIndividualClubObjects(text) {
  const dataMatch = text.match(/"data"\s*:\s*\[/i);
  if (!dataMatch) {
    return null;
  }

  const clubs = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let objStart = -1;

  for (let i = dataMatch.index + dataMatch[0].length; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        objStart = i;
      }
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && objStart !== -1) {
          const candidate = text.slice(objStart, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object') {
              clubs.push(parsed);
            }
          } catch {
            try {
              const parsed = JSON.parse(repairMalformedDlgscJson(candidate));
              if (parsed && typeof parsed === 'object') {
                clubs.push(parsed);
              }
            } catch {
              // Skip single irreconcilable club record
            }
          }
          objStart = -1;
        }
      }
    } else if (ch === ']' && depth === 0) {
      break;
    }
  }

  return clubs;
}

/**
 * Parses a raw DLGSC response payload with repair and per-club fallback tiers.
 *
 * @param {string} rawText
 * @returns {object}
 */
export function parseDlgscPayload(rawText) {
  try {
    return JSON.parse(rawText);
  } catch (initialError) {
    const repaired = repairMalformedDlgscJson(rawText);
    try {
      return JSON.parse(repaired);
    } catch {
      const clubs = extractIndividualClubObjects(repaired) || extractIndividualClubObjects(rawText);
      if (clubs && clubs.length > 0) {
        const moreMatch = rawText.match(/"morerecords"\s*:\s*(true|false)/i);
        return {
          clubs: {
            ...(moreMatch ? { morerecords: moreMatch[1].toLowerCase() === 'true' } : {}),
            data: clubs
          }
        };
      }
      throw initialError;
    }
  }
}

/**
 * Creates a WA DLGSC Sports Club Directory crawler instance.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn=globalThis.fetch]
 * @param {number} [options.pageSize=100]
 * @param {number} [options.timeoutMs=15000]
 * @param {{ lat: number, lng: number }} [options.center=PERTH_CENTROID]
 * @param {number} [options.maxDistanceKm=DEFAULT_MAX_DISTANCE_KM]
 * @param {string} [options.keyword='']
 * @param {string} [options.suburb]
 * @param {number} [options.maxPages]
 * @returns {object} Crawler instance with name and fetchListings method
 */
export function createDlgscCrawler(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const pageSize = options.pageSize || 100;
  const timeoutMs = options.timeoutMs || 15000;
  const center = options.center || PERTH_CENTROID;
  const maxDistanceKm = options.maxDistanceKm || DEFAULT_MAX_DISTANCE_KM;
  const keyword = options.keyword !== undefined ? options.keyword : '';
  const suburb = options.suburb;
  const singlePage = options.page !== undefined ? options.page : null;
  const maxPages = singlePage
    ? 1
    : (typeof options.maxPages === 'number' && options.maxPages > 0 ? options.maxPages : Infinity);

  return {
    name: 'dlgsc',
    ...(typeof options.minExpectedListings === 'number' ? { minExpectedListings: options.minExpectedListings } : {}),

    async fetchListings() {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot; Linux x86_64)',
        'Accept': 'application/json'
      };

      const filteredListings = [];
      const seenIds = new Set();

      const startPage = singlePage || 1;
      const endPage = singlePage
        ? singlePage
        : (Number.isFinite(maxPages) ? startPage + maxPages - 1 : Infinity);

      for (let currentPage = startPage; currentPage <= endPage; currentPage++) {
        const signal = options.signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined);
        let url = `${DLGSC_ENDPOINT}?basic=true&keyword=${encodeURIComponent(keyword)}&page=${currentPage}&count=${pageSize}`;
        if (suburb) {
          url += `&suburb=${encodeURIComponent(suburb)}`;
        }

        const response = await fetchFn(url, {
          method: 'GET',
          headers,
          ...(signal ? { signal } : {})
        });

        if (!response.ok) {
          throw new Error(`DLGSC API responded with HTTP ${response.status}: ${response.statusText}`);
        }

        const json = typeof response.text === 'function'
          ? parseDlgscPayload(await response.text())
          : await response.json();
        const rawClubs = json.clubs?.data || json.data || [];
        let newRawClubsOnPage = 0;

        for (let i = 0; i < rawClubs.length; i++) {
          const item = rawClubs[i];
          const clubId = item.Id || `${currentPage}_${i + 1}`;

          if (seenIds.has(clubId)) {
            continue;
          }

          seenIds.add(clubId);
          newRawClubsOnPage++;

          // Parse coordinates
          const lat = parseFloat(item.Latitude || item.LLat);
          const lng = parseFloat(item.Longitude || item.LLong);

          if (Number.isNaN(lat) || Number.isNaN(lng)) {
            continue;
          }

          // Filter for Greater Perth metropolitan area
          const distance = calculateDistanceKm(center, { lat, lng });
          if (distance > maxDistanceKm) {
            continue;
          }

          const rawOrganizerName = item.Name || item.RegisteredName || 'Sports Organizer';
          const organizerName = cleanText(rawOrganizerName);
          const sportRaw = cleanText(item.Sports || item.Sports1 || 'other');
          const subcategories = normalizeSubcategories(
            {
              sports: [cleanText(item.Sports), cleanText(item.Sports1)].filter(Boolean),
              sport: sportRaw
            },
            sportRaw
          );
          const subcategory = subcategories[0] || 'other';
          const website = item.Website && item.Website.startsWith('http') ? item.Website : (item.Website ? `https://${item.Website}` : null);
          const facebook = normalizeFacebookUrl(item.Facebook) || normalizeFacebookUrl(website);
          const fallbackUrl = `https://kidsport.dlgsc.wa.gov.au/find-a-club/?club=${clubId}`;
          const referralUrl = website || facebook || fallbackUrl;
          const streetAddr = cleanText(item.StreetAddress);
          const suburbName = cleanText(item.Suburb);
          const address = [streetAddr, suburbName].filter(Boolean).join(', ') || cleanText(item.PostalAddress) || 'Greater Perth, WA';
          const costDescription = item.KidSport === 'Valid' ? 'KidSport eligible' : 'Contact organizer for fees';
          const age = deriveAgeGroup(item.ageGroups);
          const geohash = encodeGeohash(lat, lng, 9);
          const id = `org_${slugify(organizerName) || 'unknown'}`;

          filteredListings.push({
            id,
            entity_type: 'organizer',
            source: 'dlgsc',
            source_id: String(clubId),
            source_url: referralUrl,
            raw_source_url: referralUrl,
            region_id: 'perth',
            name: organizerName,
            description: `${organizerName} community organizer listing via WA DLGSC directory.`,
            address,
            coordinates: { lat, lng },
            geohash,
            category: 'sports',
            subcategory,
            subcategories,
            website,
            contact: {
              email: item.Email || null,
              phone: item.Phone || item.Mobile || null,
              facebook
            },
            cost_description: costDescription,
            demographics: {
              gender: 'all',
              age
            }
          });
        }

        // If upstream has no more records, stop paginating
        if (json.clubs?.morerecords === false || rawClubs.length === 0 || newRawClubsOnPage === 0) {
          break;
        }
      }

      return filteredListings;
    }
  };
}
