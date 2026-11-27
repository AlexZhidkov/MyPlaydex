/**
 * Shared Listing Domain Constants and Derived-Field Helpers.
 * Pure ES2022 module shared between browser (/admin) and Node backend (ADR 0012).
 */

export const CANONICAL_CATEGORIES = Object.freeze([
  'sports',
  'health',
  'arts',
  'music',
  'community',
  'family',
  'food',
  'hobbies',
  'travel'
]);

export const CANONICAL_GENDERS = Object.freeze([
  'all',
  'women_only',
  'men_only'
]);

export const CANONICAL_AGES = Object.freeze([
  'all',
  'adults',
  'juniors',
  'masters'
]);

export const CANONICAL_RECURRENCES = Object.freeze([
  'none',
  'weekly'
]);

export const DAY_NAMES = Object.freeze([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
]);

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addTwoDaysAwst(dateStr) {
  const trimmed = typeof dateStr === 'string' ? dateStr.trim() : '';
  if (!ISO_DATE_RE.test(trimmed)) {
    return null;
  }
  const startOfDayMs = Date.parse(`${trimmed}T00:00:00+08:00`);
  return Number.isNaN(startOfDayMs) ? null : new Date(startOfDayMs + 2 * ONE_DAY_MS);
}

/**
 * Computes the expiration Date for an Activity schedule.
 * Perpetual weekly recurring activities (without an explicit `end_date`) return `null`.
 * Non-recurring activities and finite weekly series expire 24 hours after the conclusion of `end_date`
 * (or `start_date` if `end_date` is omitted for non-recurring) in AWST (UTC+08:00).
 *
 * @param {object} [schedule={}]
 * @returns {Date | null}
 */
export function computeActivityExpireAt(schedule = {}) {
  if (!schedule || typeof schedule !== 'object') {
    return null;
  }

  const recurrence = schedule.recurrence || 'none';
  if (recurrence === 'weekly') {
    return addTwoDaysAwst(schedule.end_date);
  }

  return addTwoDaysAwst(schedule.end_date || schedule.start_date);
}

/**
 * Computes `day_of_week` (0 = Sunday .. 6 = Saturday) for an Activity schedule.
 * - For `recurrence === 'weekly'`: uses explicit integer `day_of_week` (0..6) if provided;
 *   otherwise derives from `start_date` (`YYYY-MM-DD`), or returns `null`.
 * - For non-weekly schedules: always derives from `start_date` (`YYYY-MM-DD`), or returns `null`.
 *
 * @param {object} [schedule={}]
 * @returns {number | null}
 */
export function computeScheduleDayOfWeek(schedule = {}) {
  if (!schedule || typeof schedule !== 'object') {
    return null;
  }

  const recurrence = schedule.recurrence || 'none';
  const rawDay = schedule.day_of_week;

  if (recurrence === 'weekly') {
    if (typeof rawDay === 'number' && Number.isInteger(rawDay) && rawDay >= 0 && rawDay <= 6) {
      return rawDay;
    }
  }

  const startDate = typeof schedule.start_date === 'string' ? schedule.start_date.trim() : '';
  if (!ISO_DATE_RE.test(startDate)) {
    return null;
  }

  const dateObj = new Date(`${startDate}T12:00:00Z`);
  if (Number.isNaN(dateObj.getTime())) {
    return null;
  }

  return dateObj.getUTCDay();
}

/**
 * Normalizes a `curated_fields` list into a deduplicated array of non-empty field paths.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeCuratedFields(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const normalized = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

/**
 * Merges existing `curated_fields` with newly edited field names, preserving existing order
 * and deduplicating.
 *
 * @param {unknown} existing
 * @param {unknown} added
 * @returns {string[]}
 */
export function mergeCuratedFields(existing, added) {
  return normalizeCuratedFields([
    ...normalizeCuratedFields(existing),
    ...normalizeCuratedFields(added)
  ]);
}

/**
 * Returns true iff `value` is a non-empty valid `http://` or `https://` URL.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidHttpUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
