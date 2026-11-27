/**
 * Markdown Activity Extractor & Quality Guardrails (ADR 0013)
 * Calls Gemini Flash structured-JSON extraction on scraped Markdown and enforces
 * deterministic hard-drop guardrails (noise, missing title/schedule, past or >6 months)
 * plus weekly vs discrete-dated schedule normalization.
 */

import { createHash } from 'node:crypto';
import { normalizeSport, parseSchedule } from './sanitizer.js';

export const MAX_HORIZON_MS = 183 * 24 * 60 * 60 * 1000;
export const DEFAULT_WEBSITE_SOURCE = 'organizer_website';

const WEEKDAY_NAME_TO_INT = Object.freeze({
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6
});

const NOISE_PATTERNS = [
  /\b(agm|annual general meeting|special general meeting|sgm|committee meeting|board meeting|notice of meeting|committee notice|minutes of)\b/i,
  /\b(job vacancy|now hiring|we are hiring|position vacant|coach wanted|umpire wanted|volunteer(?:s)? needed|job advertisement|careers? at)\b/i,
  /\b(private lessons? enquir(?:y|ies)|enquire for private|book a private lesson|contact us for (?:private|one-on-one|1-on-1) (?:lessons|coaching|tuition))\b/i
];

function isNonActivityNoise(item) {
  if (!item || typeof item !== 'object') return true;
  if (item.is_noise === true) return true;
  const combined = `${item.title || ''} ${item.description || ''} ${item.noise_reason || ''}`;
  return NOISE_PATTERNS.some(pattern => pattern.test(combined));
}

function normalizeDateOnly(rawDate) {
  if (typeof rawDate !== 'string') return null;
  const trimmed = rawDate.trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function normalizeTime24(rawTime) {
  if (typeof rawTime !== 'string') return null;
  const trimmed = rawTime.trim();
  return /^\d{2}:\d{2}$/.test(trimmed) ? trimmed : null;
}

function normalizeWeekdayInt(rawWeekday) {
  if (typeof rawWeekday === 'number' && Number.isInteger(rawWeekday) && rawWeekday >= 0 && rawWeekday <= 6) {
    return rawWeekday;
  }
  if (typeof rawWeekday === 'string') {
    const key = rawWeekday.trim().toLowerCase();
    if (key in WEEKDAY_NAME_TO_INT) {
      return WEEKDAY_NAME_TO_INT[key];
    }
  }
  return null;
}

function parseAwstDateTimeMs(dateOnly, time24 = null, defaultEndOfDay = false) {
  if (!dateOnly) return NaN;
  const timePart = time24 ? `${time24}:00` : (defaultEndOfDay ? '23:59:59' : '00:00:00');
  return Date.parse(`${dateOnly}T${timePart}+08:00`);
}

function formatTodayAwst(nowMs) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(nowMs));
}

export function buildDeterministicSourceId(scrapedUrl, title, scheduleKey) {
  return createHash('sha256')
    .update(`${scrapedUrl}|${title}|${scheduleKey}`)
    .digest('hex')
    .slice(0, 16);
}

function normalizeWebsiteSource(source) {
  if (typeof source !== 'string') return DEFAULT_WEBSITE_SOURCE;
  const cleaned = source.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return cleaned || DEFAULT_WEBSITE_SOURCE;
}

/**
 * Resolves a preferred outbound Activity URL from a candidate direct ticketing URL,
 * upgrading `http://` to `https://` and resolving root-relative paths against `scrapedUrl`.
 * Falls back to `scrapedUrl` when `ticketUrl` is missing, non-HTTP(S), or prose.
 *
 * @param {string | null | undefined} ticketUrl
 * @param {string} scrapedUrl
 * @returns {string}
 */
export function resolvePreferredActivityUrl(ticketUrl, scrapedUrl) {
  if (typeof ticketUrl !== 'string') return scrapedUrl;
  const cleaned = ticketUrl.trim().replace(/^["'<(\[]+|[>"')\]]+$/g, '').trim();
  if (!cleaned) return scrapedUrl;

  let candidate = null;
  if (/^https:\/\//i.test(cleaned)) {
    candidate = cleaned;
  } else if (/^http:\/\//i.test(cleaned)) {
    candidate = cleaned.replace(/^http:\/\//i, 'https://');
  } else if (/^\/\//.test(cleaned)) {
    candidate = `https:${cleaned}`;
  } else if (cleaned.startsWith('/')) {
    try {
      candidate = new URL(cleaned, scrapedUrl).href;
    } catch {
      return scrapedUrl;
    }
  } else {
    return scrapedUrl;
  }

  try {
    const parsed = new URL(candidate);
    if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname.includes('.')) {
      return parsed.href;
    }
  } catch {
    return scrapedUrl;
  }
  return scrapedUrl;
}

/**
 * Builds a single `verified: true` Source Reference for a scraped website Activity.
 *
 * @param {string} sourceId
 * @param {string} targetUrl
 * @param {string} [source=DEFAULT_WEBSITE_SOURCE]
 * @returns {object}
 */
export function buildWebsiteSourceRef(sourceId, targetUrl, source = DEFAULT_WEBSITE_SOURCE) {
  const normalizedSource = normalizeWebsiteSource(source);
  return {
    source: normalizedSource,
    source_id: sourceId,
    source_key: `${normalizedSource}_${sourceId}`,
    source_url: targetUrl,
    raw_source_url: targetUrl,
    verified: true
  };
}

export function buildOrganizerWebsiteSourceRef(sourceId, scrapedUrl) {
  return buildWebsiteSourceRef(sourceId, scrapedUrl, DEFAULT_WEBSITE_SOURCE);
}

function isLowConfidence(confidence) {
  return typeof confidence === 'string' && confidence.trim().toLowerCase() === 'low';
}

/**
 * Applies ADR 0013 hard-drop guardrails and weekly/dated schedule normalization
 * to raw structured items returned by Gemini Flash.
 *
 * @param {Array<object>} [rawItems=[]]
 * @param {object} [params={}]
 * @returns {Array<object>}
 */
export function filterAndNormalizeGeminiActivities(
  rawItems = [],
  { scrapedUrl, organizer = null, source = DEFAULT_WEBSITE_SOURCE, now = new Date() } = {}
) {
  if (!Array.isArray(rawItems) || !scrapedUrl) {
    return [];
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const nowIso = new Date(nowMs).toISOString();
  const maxFutureMs = nowMs + MAX_HORIZON_MS;
  const results = [];

  for (const item of rawItems) {
    if (isNonActivityNoise(item)) continue;

    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!title) continue;

    const startDate = normalizeDateOnly(item.start_date);
    const endDate = normalizeDateOnly(item.end_date);
    const startTime = normalizeTime24(item.start_time);
    const endTime = normalizeTime24(item.end_time);
    const weekdayInt = normalizeWeekdayInt(item.weekday ?? item.day_of_week);

    // Must have either an explicit calendar date OR a recurring weekday
    if (!startDate && weekdayInt === null) continue;

    let schedule;
    let scheduleKey;

    if (startDate) {
      const startMs = parseAwstDateTimeMs(startDate, startTime, !startTime);
      if (!Number.isFinite(startMs) || startMs > maxFutureMs) continue;

      const effectiveEndMs = endDate
        ? parseAwstDateTimeMs(endDate, endTime, !endTime)
        : startMs;
      if ((Number.isFinite(effectiveEndMs) ? effectiveEndMs : startMs) < nowMs) continue;

      schedule = parseSchedule(
        {
          recurrence: 'none',
          start_date: startDate,
          end_date: endDate || startDate,
          start_time: startTime,
          end_time: endTime
        },
        nowIso
      );
      scheduleKey = startTime ? `${startDate}T${startTime}` : startDate;
    } else {
      schedule = parseSchedule(
        {
          recurrence: 'weekly',
          day_of_week: weekdayInt,
          start_time: startTime,
          end_time: endTime
        },
        nowIso
      );
      scheduleKey = `weekly-${weekdayInt}-${startTime || 'tbd'}`;
    }

    const description = typeof item.description === 'string' ? item.description.trim() : '';
    const venueName = typeof item.venue_name === 'string' ? item.venue_name.trim() : '';
    const venueAddress = typeof item.address === 'string' ? item.address.trim() : '';
    const costDescription = typeof item.cost_description === 'string' ? item.cost_description.trim() : '';
    const isFree = item.is_free === true || /^free$/i.test(costDescription);
    const sourceId = buildDeterministicSourceId(scrapedUrl, title, scheduleKey);
    const preferredUrl = resolvePreferredActivityUrl(item.ticket_url, scrapedUrl);
    const sourceRef = buildWebsiteSourceRef(sourceId, preferredUrl, source);

    results.push({
      ...sourceRef,
      sources: [sourceRef],
      source_keys: [sourceRef.source_key],
      title,
      description,
      category: typeof item.category === 'string' ? item.category.trim().toLowerCase() : undefined,
      subcategory: normalizeSport(`${title} ${description}`),
      ...(startDate ? { start_date: startTime ? `${startDate}T${startTime}:00+08:00` : startDate } : {}),
      ...(endDate ? { end_date: endTime ? `${endDate}T${endTime}:00+08:00` : endDate } : {}),
      schedule,
      venue_name: venueName || undefined,
      venue_address: venueAddress || undefined,
      location_text: venueAddress || venueName || undefined,
      is_free: isFree,
      cost_description: costDescription || (isFree ? 'Free' : ''),
      ...(organizer ? { organizer: { id: organizer.id, name: organizer.name } } : {}),
      _missingStartTime: !schedule.start_time,
      _lowConfidence: isLowConfidence(item.confidence)
    });
  }

  return results;
}

/**
 * Extracts and guardrails Activity candidates from scraped Markdown using Gemini Flash.
 * Skips cleanly (returns `[]`) when `geminiClient` is null or `markdown` is empty.
 *
 * @param {object} [params={}]
 * @returns {Promise<Array<object>>}
 */
export async function extractMarkdownActivities({
  markdown = '',
  scrapedUrl,
  organizer = null,
  venueName = '',
  source = DEFAULT_WEBSITE_SOURCE,
  geminiClient = null,
  now = new Date(),
  logger = console,
  throwOnError = false
} = {}) {
  if (!geminiClient || typeof markdown !== 'string' || !markdown.trim() || !scrapedUrl) {
    return [];
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const todayAwst = formatTodayAwst(nowMs);

  try {
    const response = await geminiClient.extractActivitiesFromMarkdown({
      markdown,
      sourceUrl: scrapedUrl,
      organizerName: organizer?.name || '',
      venueName,
      todayAwst
    });
    return filterAndNormalizeGeminiActivities(response?.activities || [], {
      scrapedUrl,
      organizer,
      source,
      now
    });
  } catch (err) {
    logger?.warn?.(`[Markdown Extractor] Gemini Flash fallback failed for ${scrapedUrl}: ${err.message}`);
    if (throwOnError) {
      throw err;
    }
    return [];
  }
}
