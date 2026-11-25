/**
 * Ingestion-Time Activity Deduplication & Multi-Source Merging
 * Deduplicates incoming Activity Listings against existing /activities records,
 * retains the first-seen canonical document ID, tracks Source References, and
 * merges metadata using deterministic source precedence.
 */

import { calculateDistanceKm } from '../public/shared/discovery-engine.js';
import { computeTokenSimilarity, tokenizeNormalized } from './entity-matcher.js';
import { PERTH_SUBURB_CENTROIDS } from '../public/shared/perth-centroids.js';
import { mergeActivityDocuments, slugify } from './sanitizer.js';

const SOURCE_PRIORITY = {
  eventbrite: 5,
  meetup: 4,
  council: 3,
  organizer_website: 2,
  facebook: 1
};

const CENTROID_EPSILON_DEG = 0.0001;
const INVALID_ORGANIZER_REVIEW_REASONS = new Set(['unmatched_organizer', 'uncertain_organizer_match']);

/**
 * Returns deterministic source precedence rank (`eventbrite > meetup > council > organizer_website > facebook`).
 *
 * @param {string} [source]
 * @returns {number}
 */
export function getSourcePriority(source) {
  if (typeof source !== 'string' || !source.trim()) {
    return 0;
  }
  const normalized = source.trim().toLowerCase();
  if (normalized in SOURCE_PRIORITY) {
    return SOURCE_PRIORITY[normalized];
  }
  return SOURCE_PRIORITY.council;
}

/**
 * Builds a normalized `${source}_${source_id}` source key for an Activity or Source Reference.
 *
 * @param {object} [activity={}]
 * @returns {string}
 */
export function buildSourceKey(activity = {}) {
  if (typeof activity.source_key === 'string' && activity.source_key.trim()) {
    return activity.source_key.trim();
  }
  const cleanSource = typeof activity.source === 'string'
    ? activity.source.toLowerCase().replace(/[^a-z0-9_-]/g, '')
    : '';
  const cleanSourceId = activity.source_id !== undefined && activity.source_id !== null
    ? String(activity.source_id).replace(/[^a-zA-Z0-9_-]/g, '_')
    : '';
  if (cleanSource && cleanSourceId) {
    return `${cleanSource}_${cleanSourceId}`;
  }
  return typeof activity.id === 'string' ? activity.id : '';
}

function normalizeSourceReference(ref = {}) {
  const source = typeof ref.source === 'string' ? ref.source.toLowerCase().trim() : '';
  const sourceId = ref.source_id !== undefined && ref.source_id !== null ? String(ref.source_id) : '';
  const sourceKey = buildSourceKey({ ...ref, source, source_id: sourceId });
  const rawSourceUrl = ref.raw_source_url || ref.source_url || null;
  const verified = Boolean(ref.verified && ref.source_url);
  const sourceUrl = verified ? ref.source_url : null;

  return {
    source,
    source_id: sourceId,
    source_key: sourceKey,
    source_url: sourceUrl,
    raw_source_url: rawSourceUrl,
    verified
  };
}

/**
 * Extracts and deduplicates all Source Reference entries on an Activity document.
 *
 * @param {object} [activity={}]
 * @returns {Array<object>}
 */
export function extractSourceReferences(activity = {}) {
  const byKey = new Map();
  const existingSources = Array.isArray(activity.sources) ? activity.sources : [];

  for (const entry of existingSources) {
    const normalized = normalizeSourceReference(entry);
    if (normalized.source_key) {
      byKey.set(normalized.source_key, normalized);
    }
  }

  if (activity.source && activity.source_id) {
    const own = normalizeSourceReference(activity);
    if (own.source_key) {
      byKey.set(own.source_key, own);
    }
  }

  return Array.from(byKey.values()).sort((a, b) => a.source_key.localeCompare(b.source_key));
}

/**
 * Selects the primary Source Reference (`verified: true` first, then source priority).
 *
 * @param {Array<object>} [sources=[]]
 * @returns {object | null}
 */
export function selectPrimarySourceReference(sources = []) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return null;
  }

  const ranked = [...sources].sort((a, b) => {
    const verifiedDiff = Number(Boolean(b.verified)) - Number(Boolean(a.verified));
    if (verifiedDiff !== 0) return verifiedDiff;

    const priorityDiff = getSourcePriority(b.source) - getSourcePriority(a.source);
    if (priorityDiff !== 0) return priorityDiff;

    return String(a.source_key || '').localeCompare(String(b.source_key || ''));
  });

  return ranked[0];
}

function hasValidCoordinates(coords) {
  return Boolean(
    coords &&
    typeof coords.lat === 'number' &&
    !Number.isNaN(coords.lat) &&
    typeof coords.lng === 'number' &&
    !Number.isNaN(coords.lng)
  );
}

function isNearSuburbCentroid(coords) {
  if (!hasValidCoordinates(coords)) return false;
  return PERTH_SUBURB_CENTROIDS.some(
    (centroid) =>
      Math.abs(centroid.lat - coords.lat) <= CENTROID_EPSILON_DEG &&
      Math.abs(centroid.lng - coords.lng) <= CENTROID_EPSILON_DEG
  );
}

/**
 * Returns true when an Activity's venue/coordinates are a fallback pin
 * (unmatched_venue, missing venue ID, or suburb centroid without a canonical Place ID).
 *
 * @param {object} [activity={}]
 * @returns {boolean}
 */
export function isFallbackVenueOrCentroid(activity = {}) {
  if (!activity || typeof activity !== 'object') return true;
  if (activity.review_reason === 'unmatched_venue') return true;
  if (activity.venue?.is_fallback === true) return true;
  const venueId = activity.venue?.id;
  if (!venueId || String(venueId).startsWith('venue_unmatched')) return true;
  if (!activity.venue?.google_place_id && isNearSuburbCentroid(activity.venue?.coordinates)) {
    return true;
  }
  return false;
}

function parseMinutesSinceMidnight(timeStr) {
  if (typeof timeStr !== 'string') return null;
  const match = timeStr.trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function resolveDayOfWeek(schedule = {}) {
  if (typeof schedule.day_of_week === 'number' && schedule.day_of_week >= 0 && schedule.day_of_week <= 6) {
    return schedule.day_of_week;
  }
  if (typeof schedule.start_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(schedule.start_date.trim())) {
    const parsed = new Date(`${schedule.start_date.trim()}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getUTCDay();
    }
  }
  return null;
}

function hasSourceKey(candidate, sourceKey) {
  if (!sourceKey) return false;
  if (candidate.id === sourceKey) return true;
  if (buildSourceKey(candidate) === sourceKey) return true;
  if (Array.isArray(candidate.source_keys) && candidate.source_keys.includes(sourceKey)) return true;
  if (Array.isArray(candidate.sources) && candidate.sources.some(s => s.source_key === sourceKey)) return true;
  return false;
}

function isCanonicalOrganizerMatch(a, b) {
  const orgA = a.organizer?.id;
  const orgB = b.organizer?.id;
  if (!orgA || !orgB || orgA !== orgB) return false;
  if (INVALID_ORGANIZER_REVIEW_REASONS.has(a.review_reason) || INVALID_ORGANIZER_REVIEW_REASONS.has(b.review_reason)) {
    return false;
  }
  return true;
}

function evaluateCandidateMatch(incoming, candidate) {
  const incomingKey = buildSourceKey(incoming);
  if (hasSourceKey(candidate, incomingKey) || (incoming.id && candidate.id === incoming.id)) {
    return { action: 'merge', reason: 'source_key', score: 1000 };
  }

  const schedA = incoming.schedule || {};
  const schedB = candidate.schedule || {};
  const isWeeklyA = schedA.recurrence === 'weekly';
  const isWeeklyB = schedB.recurrence === 'weekly';

  let scheduleDateMatches = false;
  if (!isWeeklyA && !isWeeklyB) {
    scheduleDateMatches = Boolean(
      schedA.start_date &&
      schedB.start_date &&
      schedA.start_date === schedB.start_date
    );
  } else {
    const dayA = resolveDayOfWeek(schedA);
    const dayB = resolveDayOfWeek(schedB);
    scheduleDateMatches = dayA !== null && dayB !== null && dayA === dayB;
  }

  if (!scheduleDateMatches) {
    return { action: 'keep', reason: 'different_date', score: 0 };
  }

  const minA = parseMinutesSinceMidnight(schedA.start_time);
  const minB = parseMinutesSinceMidnight(schedB.start_time);
  const timeDiff = minA !== null && minB !== null ? Math.abs(minA - minB) : null;

  if (timeDiff !== null && timeDiff > 60) {
    return { action: 'keep', reason: 'different_time', score: 0 };
  }

  const fallbackA = isFallbackVenueOrCentroid(incoming);
  const fallbackB = isFallbackVenueOrCentroid(candidate);
  const sameCanonicalVenue = Boolean(
    !fallbackA &&
    !fallbackB &&
    ((incoming.venue?.id && candidate.venue?.id && incoming.venue.id === candidate.venue.id) ||
      (incoming.venue?.google_place_id && candidate.venue?.google_place_id && incoming.venue.google_place_id === candidate.venue.google_place_id))
  );

  let nonFallbackDistanceMeters = Infinity;
  if (!fallbackA && !fallbackB && hasValidCoordinates(incoming.venue?.coordinates) && hasValidCoordinates(candidate.venue?.coordinates)) {
    nonFallbackDistanceMeters = calculateDistanceKm(
      incoming.venue.coordinates,
      candidate.venue.coordinates
    ) * 1000;
  }

  const within250m = sameCanonicalVenue || nonFallbackDistanceMeters <= 250;
  const within500m = sameCanonicalVenue || nonFallbackDistanceMeters <= 500;

  const tokensA = tokenizeNormalized(incoming.title || '');
  const tokensB = tokenizeNormalized(candidate.title || '');
  const { jaccard, allSmallerContained } = computeTokenSimilarity(tokensA, tokensB);
  const exactNormalizedTitle = slugify(incoming.title || '') !== '' && slugify(incoming.title || '') === slugify(candidate.title || '');
  const strongTitle = jaccard >= 0.65 || allSmallerContained;
  const moderateTitle = jaccard >= 0.35;
  const weakTitle = jaccard >= 0.25;
  const sameOrg = isCanonicalOrganizerMatch(incoming, candidate);

  if (timeDiff !== null && timeDiff <= 30 && within250m && (strongTitle || (sameOrg && moderateTitle))) {
    return {
      action: 'merge',
      reason: 'high_confidence',
      score: 500 + jaccard * 100 - (sameCanonicalVenue ? 0 : Math.min(nonFallbackDistanceMeters, 250) / 250)
    };
  }

  const isWeeklyVsDated = isWeeklyA !== isWeeklyB;
  if (
    (within500m && (weakTitle || sameOrg || isWeeklyVsDated)) ||
    ((fallbackA || fallbackB) && exactNormalizedTitle && sameOrg)
  ) {
    return {
      action: 'flag_borderline',
      reason: 'possible_duplicate',
      score: 100 + jaccard * 50
    };
  }

  return { action: 'keep', reason: 'distinct', score: 0 };
}

function choosePreferredField(prevVal, nextVal, prevPriority, nextPriority, isSingleSameSource) {
  const prevEmpty = prevVal === undefined || prevVal === null || prevVal === '';
  const nextEmpty = nextVal === undefined || nextVal === null || nextVal === '';
  if (prevEmpty && nextEmpty) return prevVal;
  if (prevEmpty) return nextVal;
  if (nextEmpty) return prevVal;

  if (isSingleSameSource) {
    return nextVal;
  }

  return nextPriority > prevPriority ? nextVal : prevVal;
}

function getVenueCompletenessScore(doc) {
  if (!doc?.venue) return 0;
  let score = 0;
  if (!isFallbackVenueOrCentroid(doc)) score += 4;
  if (doc.venue.google_place_id) score += 2;
  if (doc.venue.address) score += 1;
  return score;
}

function getOrganizerCompletenessScore(doc) {
  if (!doc?.organizer?.id) return 0;
  if (INVALID_ORGANIZER_REVIEW_REASONS.has(doc.review_reason)) return 0;
  let score = 2;
  if (doc.organizer.google_place_id) score += 1;
  return score;
}

function getCostCompletenessScore(doc) {
  if (!doc?.cost) return 0;
  if (typeof doc.cost.display_price === 'string' && doc.cost.display_price.trim()) return 2;
  if (doc.cost.is_free === true) return 1;
  return 0;
}

function mergeSchedule(prevSchedule = {}, nextSchedule = {}, { prevPriority = 0, nextPriority = 0, isSingleSameSource = false } = {}) {
  const isWeekly = prevSchedule.recurrence === 'weekly' || nextSchedule.recurrence === 'weekly';

  if (isWeekly) {
    const weeklySide = prevSchedule.recurrence === 'weekly' ? prevSchedule : nextSchedule;
    const otherSide = prevSchedule.recurrence === 'weekly' ? nextSchedule : prevSchedule;
    return {
      recurrence: 'weekly',
      start_date: weeklySide.start_date ?? null,
      start_time: weeklySide.start_time || otherSide.start_time || null,
      end_date: null,
      end_time: weeklySide.end_time || otherSide.end_time || null,
      day_of_week: weeklySide.day_of_week ?? otherSide.day_of_week ?? resolveDayOfWeek(weeklySide) ?? resolveDayOfWeek(otherSide)
    };
  }

  return {
    recurrence: 'none',
    start_date: isSingleSameSource ? (nextSchedule.start_date || prevSchedule.start_date || null) : (prevSchedule.start_date || nextSchedule.start_date || null),
    start_time: choosePreferredField(prevSchedule.start_time, nextSchedule.start_time, prevPriority, nextPriority, isSingleSameSource) || null,
    end_date: isSingleSameSource ? (nextSchedule.end_date || prevSchedule.end_date || null) : (prevSchedule.end_date || nextSchedule.end_date || null),
    end_time: choosePreferredField(prevSchedule.end_time, nextSchedule.end_time, prevPriority, nextPriority, isSingleSameSource) || null,
    day_of_week: prevSchedule.day_of_week ?? nextSchedule.day_of_week ?? null
  };
}

function mergeDemographics(prevDemo = {}, nextDemo = {}, { prevPriority = 0, nextPriority = 0, isSingleSameSource = false } = {}) {
  const pickSpecific = (a, b) => {
    const aSpec = a && a !== 'all';
    const bSpec = b && b !== 'all';
    if (aSpec && !bSpec) return a;
    if (bSpec && !aSpec) return b;
    if (isSingleSameSource && bSpec) return b;
    return nextPriority > prevPriority ? (b || a || 'all') : (a || b || 'all');
  };
  return {
    gender: pickSpecific(prevDemo.gender, nextDemo.gender),
    age: pickSpecific(prevDemo.age, nextDemo.age)
  };
}

/**
 * Deterministically merges an incoming Activity into an existing canonical Activity,
 * retaining the first-seen `id`, combining `sources`/`source_keys`, selecting primary
 * `source_url`, and preserving human-approved curation (`needs_review === false`).
 *
 * @param {object} existingDoc
 * @param {object} incomingDoc
 * @returns {object}
 */
export function mergeMatchedActivities(existingDoc, incomingDoc) {
  const existingSources = extractSourceReferences(existingDoc);
  const combinedSourcesMap = new Map();
  for (const ref of existingSources) {
    combinedSourcesMap.set(ref.source_key, ref);
  }
  for (const ref of extractSourceReferences(incomingDoc)) {
    combinedSourcesMap.set(ref.source_key, ref);
  }
  const sources = Array.from(combinedSourcesMap.values()).sort((a, b) => a.source_key.localeCompare(b.source_key));
  const sourceKeys = sources.map(s => s.source_key);
  const primaryRef = selectPrimarySourceReference(sources);

  const prevPriority = Math.max(
    getSourcePriority(existingDoc.source),
    ...existingSources.map(s => getSourcePriority(s.source))
  );
  const nextPriority = getSourcePriority(incomingDoc.source);
  const isSingleSameSource = existingSources.length <= 1 && buildSourceKey(existingDoc) === buildSourceKey(incomingDoc);
  const priorityCtx = { prevPriority, nextPriority, isSingleSameSource };

  const venueScoreA = getVenueCompletenessScore(existingDoc);
  const venueScoreB = getVenueCompletenessScore(incomingDoc);
  const useIncomingVenue = isSingleSameSource
    ? venueScoreB >= venueScoreA
    : (venueScoreB > venueScoreA || (venueScoreB === venueScoreA && nextPriority > prevPriority));

  const orgScoreA = getOrganizerCompletenessScore(existingDoc);
  const orgScoreB = getOrganizerCompletenessScore(incomingDoc);
  const useIncomingOrg = isSingleSameSource
    ? orgScoreB >= orgScoreA
    : (orgScoreB > orgScoreA || (orgScoreB === orgScoreA && nextPriority > prevPriority));

  const costScoreA = getCostCompletenessScore(existingDoc);
  const costScoreB = getCostCompletenessScore(incomingDoc);
  const useIncomingCost = isSingleSameSource
    ? costScoreB >= costScoreA
    : (costScoreB > costScoreA || (costScoreB === costScoreA && nextPriority > prevPriority));

  const mergedSchedule = mergeSchedule(existingDoc.schedule, incomingDoc.schedule, priorityCtx);

  const chosenVenue = useIncomingVenue ? incomingDoc.venue : existingDoc.venue;
  const chosenOrganizer = useIncomingOrg ? incomingDoc.organizer : existingDoc.organizer;
  const chosenCost = useIncomingCost ? incomingDoc.cost : existingDoc.cost;
  const chosenDescription = choosePreferredField(existingDoc.description, incomingDoc.description, prevPriority, nextPriority, isSingleSameSource) || '';
  const chosenDemographics = mergeDemographics(existingDoc.demographics, incomingDoc.demographics, priorityCtx);
  const chosenTitle = choosePreferredField(existingDoc.title, incomingDoc.title, prevPriority, nextPriority, isSingleSameSource) || existingDoc.title || incomingDoc.title;

  let needsReview = existingDoc.needs_review === false
    ? false
    : (useIncomingVenue ? Boolean(incomingDoc.needs_review) : Boolean(existingDoc.needs_review));
  let reviewReason = existingDoc.needs_review === false
    ? null
    : (useIncomingVenue ? (incomingDoc.review_reason || null) : (existingDoc.review_reason || null));
  let duplicateCandidateId = existingDoc.duplicate_candidate_id;

  if (existingDoc.needs_review !== false && existingDoc.review_reason === 'possible_duplicate') {
    needsReview = true;
    reviewReason = 'possible_duplicate';
    duplicateCandidateId = existingDoc.duplicate_candidate_id;
  }

  const nextForMerge = {
    ...incomingDoc,
    id: existingDoc.id,
    source: existingDoc.source || incomingDoc.source,
    source_id: existingDoc.source_id || incomingDoc.source_id,
    source_url: primaryRef ? primaryRef.source_url : (incomingDoc.source_url || null),
    raw_source_url: primaryRef ? primaryRef.raw_source_url : (incomingDoc.raw_source_url || null),
    verified: primaryRef ? primaryRef.verified : Boolean(incomingDoc.verified),
    sources,
    source_keys: sourceKeys,
    title: chosenTitle,
    description: chosenDescription,
    venue: chosenVenue,
    organizer: chosenOrganizer,
    schedule: mergedSchedule,
    expire_at: mergedSchedule.recurrence === 'weekly' ? null : (incomingDoc.expire_at ?? existingDoc.expire_at ?? null),
    cost: chosenCost,
    demographics: chosenDemographics,
    needs_review: needsReview,
    review_reason: reviewReason,
    ...(duplicateCandidateId ? { duplicate_candidate_id: duplicateCandidateId } : {})
  };

  return mergeActivityDocuments(existingDoc, nextForMerge);
}

function findBestCandidateMatch(incoming, catalog) {
  let bestMergeIndex = -1;
  let bestMergeMatch = null;
  let bestBorderlineIndex = -1;
  let bestBorderlineMatch = null;

  for (let i = 0; i < catalog.length; i++) {
    const candidate = catalog[i];
    const evaluation = evaluateCandidateMatch(incoming, candidate);
    if (evaluation.action === 'merge') {
      if (!bestMergeMatch || evaluation.score > bestMergeMatch.score) {
        bestMergeMatch = evaluation;
        bestMergeIndex = i;
      }
    } else if (evaluation.action === 'flag_borderline') {
      if (!bestBorderlineMatch || evaluation.score > bestBorderlineMatch.score) {
        bestBorderlineMatch = evaluation;
        bestBorderlineIndex = i;
      }
    }
  }

  return { bestMergeIndex, bestMergeMatch, bestBorderlineIndex, bestBorderlineMatch };
}

function toCreatedAtMillis(value) {
  if (value === undefined || value === null) return Infinity;
  if (typeof value?.toMillis === 'function') {
    const ms = value.toMillis();
    return Number.isFinite(ms) ? ms : Infinity;
  }
  if (typeof value?.toDate === 'function') {
    const ms = value.toDate().getTime();
    return Number.isFinite(ms) ? ms : Infinity;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : Infinity;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : Infinity;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : Infinity;
  }
  if (typeof value === 'object' && typeof value.seconds === 'number') {
    const ms = value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
    return Number.isFinite(ms) ? ms : Infinity;
  }
  return Infinity;
}

/**
 * Deduplicates incoming Activity documents against an existing /activities catalog.
 *
 * @param {Array<object>} [incomingActivities=[]]
 * @param {Array<object>} [existingActivities=[]]
 * @returns {{ activitiesToUpsert: Array<object>, catalog: Array<object>, stats: object }}
 */
export function deduplicateActivities(incomingActivities = [], existingActivities = []) {
  const catalog = existingActivities.map(doc => ({ ...doc }));
  const upsertMap = new Map();
  const stats = {
    total: incomingActivities.length,
    merged: 0,
    flaggedBorderline: 0,
    distinct: 0,
    idempotentSourceHits: 0
  };

  for (const incoming of incomingActivities) {
    const {
      bestMergeIndex,
      bestMergeMatch,
      bestBorderlineIndex
    } = findBestCandidateMatch(incoming, catalog);

    if (bestMergeIndex !== -1) {
      const merged = mergeMatchedActivities(catalog[bestMergeIndex], incoming);
      if (incoming._canonicalEntities) {
        const preservedEntities = {
          ...incoming._canonicalEntities,
          activity: merged
        };
        if (catalog[bestMergeIndex].needs_review === false) {
          preservedEntities.organizer = null;
        }
        Object.defineProperty(merged, '_canonicalEntities', {
          value: preservedEntities,
          enumerable: false,
          configurable: true,
          writable: true
        });
      }
      catalog[bestMergeIndex] = merged;
      upsertMap.set(merged.id, merged);
      stats.merged += 1;
      if (bestMergeMatch.reason === 'source_key') {
        stats.idempotentSourceHits += 1;
      }
      continue;
    }

    const ownSources = extractSourceReferences(incoming);
    const prepared = {
      ...incoming,
      sources: ownSources,
      source_keys: ownSources.map(s => s.source_key)
    };
    if (incoming._canonicalEntities) {
      Object.defineProperty(prepared, '_canonicalEntities', {
        value: { ...incoming._canonicalEntities, activity: prepared },
        enumerable: false,
        configurable: true,
        writable: true
      });
    }

    if (bestBorderlineIndex !== -1) {
      prepared.needs_review = true;
      prepared.review_reason = 'possible_duplicate';
      prepared.duplicate_candidate_id = catalog[bestBorderlineIndex].id;
      stats.flaggedBorderline += 1;
    } else {
      stats.distinct += 1;
    }

    catalog.push(prepared);
    upsertMap.set(prepared.id, prepared);
  }

  return {
    activitiesToUpsert: Array.from(upsertMap.values()),
    catalog,
    stats
  };
}

function flagBorderlineDoc(doc, candidate, dirtyIds, borderlinePairs) {
  const alreadyFlagged = doc.needs_review === true &&
    doc.review_reason === 'possible_duplicate' &&
    doc.duplicate_candidate_id === candidate.id;

  const updatedDoc = alreadyFlagged
    ? { ...doc }
    : {
        ...doc,
        needs_review: true,
        review_reason: 'possible_duplicate',
        duplicate_candidate_id: candidate.id
      };

  if (!alreadyFlagged) {
    dirtyIds.add(doc.id);
  }

  borderlinePairs.push({
    activityId: doc.id,
    title: doc.title || '',
    candidateId: candidate.id,
    candidateTitle: candidate.title || '',
    alreadyFlagged
  });

  return updatedDoc;
}

function mergeClusterPair(survivor, doc) {
  if (survivor.needs_review !== false && doc.needs_review === false) {
    // Keep the first-seen survivor identity/created_at and both Source References while preserving approved curation
    const combinedRefs = [
      ...extractSourceReferences(survivor),
      ...extractSourceReferences(doc)
    ];
    const curatedAnchor = {
      ...doc,
      id: survivor.id,
      source: survivor.source,
      source_id: survivor.source_id,
      sources: combinedRefs,
      source_keys: Array.from(new Set(combinedRefs.map(r => r.source_key))).sort(),
      created_at: survivor.created_at
    };
    return mergeMatchedActivities(curatedAnchor, survivor);
  }
  return mergeMatchedActivities(survivor, doc);
}

/**
 * Plans a deduplication pass across an existing /activities catalog, grouping
 * high-confidence duplicate clusters into their first-seen canonical survivor
 * and flagging borderline pairs as Unreviewed Listing without deleting them.
 *
 * @param {Array<object>} [existingActivities=[]]
 * @returns {object} Deduplication plan with clusters, borderlinePairs, updates, deletes, and stats
 */
export function planActivityDeduplication(existingActivities = []) {
  const count = Array.isArray(existingActivities) ? existingActivities.length : 0;
  if (count <= 1) {
    return {
      scannedCount: count,
      clusters: [],
      borderlinePairs: [],
      activitiesToUpdate: [],
      activityIdsToDelete: [],
      stats: {
        scanned: count,
        clusters: 0,
        mergedDocuments: 0,
        deletedDocuments: 0,
        borderlineFlagged: 0,
        borderlinePairs: 0,
        unchanged: count
      }
    };
  }

  const sorted = [...existingActivities].sort((a, b) => {
    const aMs = toCreatedAtMillis(a?.created_at);
    const bMs = toCreatedAtMillis(b?.created_at);
    if (aMs !== bMs) return aMs < bMs ? -1 : 1;

    const curationDiff = Number(b?.needs_review === false) - Number(a?.needs_review === false);
    if (curationDiff !== 0) return curationDiff;

    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });

  const catalog = [];
  const clustersBySurvivorId = new Map();
  const borderlinePairs = [];
  const dirtyIds = new Set();
  const deletedIds = [];

  for (const doc of sorted) {
    const { bestMergeIndex, bestBorderlineIndex } = findBestCandidateMatch(doc, catalog);

    if (bestMergeIndex !== -1) {
      const survivor = catalog[bestMergeIndex];
      catalog[bestMergeIndex] = mergeClusterPair(survivor, doc);
      dirtyIds.add(survivor.id);

      if (doc.id && doc.id !== survivor.id) {
        deletedIds.push(doc.id);
        if (!clustersBySurvivorId.has(survivor.id)) {
          clustersBySurvivorId.set(survivor.id, { mergedIds: [] });
        }
        clustersBySurvivorId.get(survivor.id).mergedIds.push(doc.id);
      }
      continue;
    }

    if (bestBorderlineIndex !== -1) {
      const candidate = catalog[bestBorderlineIndex];
      if (doc.needs_review !== false) {
        catalog.push(flagBorderlineDoc(doc, candidate, dirtyIds, borderlinePairs));
      } else {
        catalog.push({ ...doc });
        if (candidate.needs_review !== false) {
          catalog[bestBorderlineIndex] = flagBorderlineDoc(candidate, doc, dirtyIds, borderlinePairs);
        }
      }
      continue;
    }

    catalog.push({ ...doc });
  }

  const catalogById = new Map(catalog.map(doc => [doc.id, doc]));
  const clusters = Array.from(clustersBySurvivorId.entries()).map(([survivorId, entry]) => {
    const finalDoc = catalogById.get(survivorId) || {};
    return {
      survivorId,
      title: finalDoc.title || '',
      redundantIds: entry.mergedIds,
      primarySourceUrl: finalDoc.source_url || null,
      verified: Boolean(finalDoc.verified),
      recurrence: finalDoc.schedule?.recurrence || 'none',
      sources: finalDoc.sources || extractSourceReferences(finalDoc),
      sourceKeys: finalDoc.source_keys || []
    };
  });

  const activitiesToUpdate = catalog.filter(doc => dirtyIds.has(doc.id));

  return {
    scannedCount: count,
    clusters,
    borderlinePairs,
    activitiesToUpdate,
    activityIdsToDelete: deletedIds,
    stats: {
      scanned: count,
      clusters: clusters.length,
      mergedDocuments: deletedIds.length,
      deletedDocuments: deletedIds.length,
      borderlineFlagged: borderlinePairs.filter(p => !p.alreadyFlagged).length,
      borderlinePairs: borderlinePairs.length,
      unchanged: catalog.length - dirtyIds.size
    }
  };
}
