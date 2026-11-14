/**
 * Discovery Engine for MyPlaydex
 * Pure JavaScript module implementing geospatial calculation, multi-facet filtering,
 * deterministic AWST listing expiration, and reactive discovery state synchronization.
 */

const EARTH_RADIUS_KM = 6371;

export const DISCOVERY_TABS = ['activities', 'organizers', 'venues'];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Parses a YYYY-MM-DD date string, ISO 8601 timestamp, or Date object into a local Date object.
 *
 * @param {string | Date} value
 * @returns {{ date: Date, hasTime: boolean } | null}
 */
export function parseDateInput(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : { date: value, hasTime: true };
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Date-only string YYYY-MM-DD (interpreted as local calendar date)
  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const monthIdx = Number(dateOnlyMatch[2]) - 1;
    const day = Number(dateOnlyMatch[3]);
    const date = new Date(year, monthIdx, day);
    if (!Number.isNaN(date.getTime())) {
      return { date, hasTime: false };
    }
    return null;
  }

  // ISO timestamp or full date-time string (e.g. "2026-11-08T12:12:05.553Z")
  if (trimmed.includes('T') || /^\d{4}-\d{2}-\d{2}[\sT]/.test(trimmed)) {
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) {
      return { date, hasTime: true };
    }
  }

  return null;
}

/**
 * Resolves a numeric day of week (0 = Sunday .. 6 = Saturday) from a schedule object or start date.
 *
 * @param {object} [schedule={}]
 * @param {Date | null} [startDateObj=null]
 * @returns {number | null}
 */
export function resolveDayOfWeek(schedule = {}, startDateObj = null) {
  const rawDay = schedule?.day_of_week;
  if (typeof rawDay === 'number' && Number.isInteger(rawDay) && rawDay >= 0 && rawDay <= 6) {
    return rawDay;
  }
  if (typeof rawDay === 'string') {
    const normalized = rawDay.trim().toLowerCase().replace(/s$/, '');
    if (/^[0-6]$/.test(normalized)) {
      return Number(normalized);
    }
    const idx = DAY_NAMES.findIndex((name) => name.toLowerCase() === normalized);
    if (idx !== -1) {
      return idx;
    }
  }
  if (startDateObj) {
    return startDateObj.getDay();
  }
  return null;
}

/**
 * Computes the next occurrence Date (local calendar date) for a weekly schedule.
 *
 * @param {number} targetDayOfWeek
 * @param {Date | null} [startDateObj=null]
 * @param {Date} [referenceDate=new Date()]
 * @returns {Date}
 */
export function getNextWeeklyOccurrence(targetDayOfWeek, startDateObj, referenceDate) {
  const ref = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
    ? referenceDate
    : new Date();
  const today = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const startDay = startDateObj
    ? new Date(startDateObj.getFullYear(), startDateObj.getMonth(), startDateObj.getDate())
    : null;
  const baseDate = startDay && startDay > today ? startDay : today;
  const daysUntil = (targetDayOfWeek - baseDate.getDay() + 7) % 7;
  return new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + daysUntil);
}

/**
 * Resolves the next occurrence calendar date (YYYY-MM-DD) and normalized start time (HH:mm)
 * for an Activity based on its schedule.
 *
 * @param {object} activity
 * @param {Date | string} [referenceDate=new Date()]
 * @returns {{ date: string | null, time: string | null }}
 */
export function resolveActivityDateTime(activity, referenceDate = new Date()) {
  if (!activity || typeof activity !== 'object') {
    return { date: null, time: null };
  }

  const schedule = activity.schedule || {};
  const recurrence = schedule.recurrence || activity.recurrence || 'none';

  const ref = typeof referenceDate === 'string'
    ? (parseDateInput(referenceDate)?.date || new Date())
    : (referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime()) ? referenceDate : new Date());

  const parsedStartTime = parseDateInput(schedule.start_time || activity.start_time);
  const parsedStartDate = parseDateInput(schedule.start_date || activity.start_date);
  const parsedEndDate = parseDateInput(schedule.end_date || activity.end_date);

  const startDateObj = parsedStartDate?.date || parsedStartTime?.date || null;
  const endDateObj = parsedEndDate?.date || null;

  let timeStr = null;
  if (parsedStartTime?.hasTime) {
    const pad = (n) => String(n).padStart(2, '0');
    timeStr = `${pad(parsedStartTime.date.getHours())}:${pad(parsedStartTime.date.getMinutes())}`;
  } else if (typeof (schedule.start_time || activity.start_time) === 'string') {
    const rawTime = (schedule.start_time || activity.start_time).trim();
    const match = rawTime.match(/^(\d{1,2}):(\d{2})/);
    if (match) {
      timeStr = `${match[1].padStart(2, '0')}:${match[2]}`;
    }
  }

  let dateStr = null;

  if (recurrence === 'weekly') {
    const targetDayOfWeek = resolveDayOfWeek(schedule, startDateObj);
    if (targetDayOfWeek !== null) {
      const nextDate = getNextWeeklyOccurrence(targetDayOfWeek, startDateObj, ref);
      const pad = (n) => String(n).padStart(2, '0');
      dateStr = `${nextDate.getFullYear()}-${pad(nextDate.getMonth() + 1)}-${pad(nextDate.getDate())}`;
    } else if (startDateObj) {
      const pad = (n) => String(n).padStart(2, '0');
      dateStr = `${startDateObj.getFullYear()}-${pad(startDateObj.getMonth() + 1)}-${pad(startDateObj.getDate())}`;
    }
  } else {
    // One-off activity
    if (startDateObj) {
      const pad = (n) => String(n).padStart(2, '0');
      const startFormatted = `${startDateObj.getFullYear()}-${pad(startDateObj.getMonth() + 1)}-${pad(startDateObj.getDate())}`;
      const todayFormatted = `${ref.getFullYear()}-${pad(ref.getMonth() + 1)}-${pad(ref.getDate())}`;

      if (endDateObj && startFormatted < todayFormatted) {
        const endFormatted = `${endDateObj.getFullYear()}-${pad(endDateObj.getMonth() + 1)}-${pad(endDateObj.getDate())}`;
        dateStr = endFormatted >= todayFormatted ? todayFormatted : startFormatted;
      } else {
        dateStr = startFormatted;
      }
    } else if (typeof (schedule.start_date || activity.start_date) === 'string') {
      const raw = (schedule.start_date || activity.start_date).trim();
      const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
      if (match) {
        dateStr = match[1];
      }
    }
  }

  return { date: dateStr, time: timeStr };
}

/**
 * Comparator function to order Activities by date, time from earlier to later.
 * Tie-breaks by proximity (distanceKm) and stable ID.
 *
 * @param {object} a
 * @param {object} b
 * @param {object} [options={}]
 * @returns {number}
 */
export function compareActivitiesByDateTime(a, b, options = {}) {
  const refDate = options.referenceDate || (options.todayAwst ? parseDateInput(options.todayAwst)?.date : null) || new Date();
  const dtA = resolveActivityDateTime(a, refDate);
  const dtB = resolveActivityDateTime(b, refDate);

  // Both have dates
  if (dtA.date && dtB.date) {
    if (dtA.date !== dtB.date) {
      return dtA.date.localeCompare(dtB.date);
    }
    // Same date, compare start times
    const timeA = dtA.time || '00:00';
    const timeB = dtB.time || '00:00';
    if (timeA !== timeB) {
      return timeA.localeCompare(timeB);
    }
  } else if (dtA.date && !dtB.date) {
    return -1;
  } else if (!dtA.date && dtB.date) {
    return 1;
  }

  // Tie-breaker: proximity (nearest to furthest)
  const distA = typeof a.distanceKm === 'number' ? a.distanceKm : Infinity;
  const distB = typeof b.distanceKm === 'number' ? b.distanceKm : Infinity;
  if (distA !== distB) {
    return distA - distB;
  }

  // Deterministic tie-breaker
  return String(a.id || '').localeCompare(String(b.id || ''));
}

/**
 * Normalizes a tab identifier to one of 'activities' | 'organizers' | 'venues'.
 *
 * @param {string} [tab='activities']
 * @returns {'activities' | 'organizers' | 'venues'}
 */
export function normalizeDiscoveryTab(tab = 'activities') {
  const normalized = String(tab || '').toLowerCase().trim();
  if (normalized === 'organizers' || normalized === 'organizer') {
    return 'organizers';
  }
  if (normalized === 'venues' || normalized === 'venue') {
    return 'venues';
  }
  return 'activities';
}

/**
 * Extracts valid { lat, lng } coordinates from an Activity, Organizer, or Venue listing.
 *
 * @param {object} [item={}]
 * @returns {{ lat: number, lng: number } | null}
 */
export function extractListingCoordinates(item = {}) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const candidates = [
    item.coordinates,
    item.venue?.coordinates,
    item.lat !== undefined && item.lng !== undefined ? { lat: item.lat, lng: item.lng } : null,
    item.venue?.lat !== undefined && item.venue?.lng !== undefined ? { lat: item.venue.lat, lng: item.venue.lng } : null
  ];

  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate.lat === 'number' &&
      typeof candidate.lng === 'number' &&
      !Number.isNaN(candidate.lat) &&
      !Number.isNaN(candidate.lng)
    ) {
      return { lat: candidate.lat, lng: candidate.lng };
    }
  }

  return null;
}

/**
 * Extracts deduplicated sport slugs from `subcategories`, `subcategory`, and `sport`.
 *
 * @param {object} [item={}]
 * @returns {string[]}
 */
function extractListingSports(item = {}) {
  if (!item || typeof item !== 'object') {
    return [];
  }

  const sports = [];
  if (Array.isArray(item.subcategories)) {
    for (const s of item.subcategories) {
      if (typeof s === 'string' && s.trim() && !sports.includes(s.trim())) {
        sports.push(s.trim());
      }
    }
  }

  for (const single of [item.subcategory, item.sport]) {
    if (typeof single === 'string' && single.trim() && !sports.includes(single.trim())) {
      sports.push(single.trim());
    }
  }

  return sports;
}

/**
 * Calculates the great-circle distance between two coordinates in kilometres
 * using the Haversine formula.
 *
 * @param {{ lat: number, lng: number }} coordA
 * @param {{ lat: number, lng: number }} coordB
 * @returns {number} Distance in kilometres rounded to 2 decimal places
 */
export function calculateDistanceKm(coordA, coordB) {
  if (coordA.lat === coordB.lat && coordA.lng === coordB.lng) {
    return 0;
  }

  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(coordB.lat - coordA.lat);
  const dLng = toRad(coordB.lng - coordA.lng);

  const lat1 = toRad(coordA.lat);
  const lat2 = toRad(coordB.lat);

  const sinHalfDlat = Math.sin(dLat / 2);
  const sinHalfDlng = Math.sin(dLng / 2);

  const chordLengthSq =
    sinHalfDlat * sinHalfDlat +
    Math.cos(lat1) * Math.cos(lat2) * sinHalfDlng * sinHalfDlng;

  const angularDistanceRad = 2 * Math.atan2(Math.sqrt(chordLengthSq), Math.sqrt(1 - chordLengthSq));
  const distance = EARTH_RADIUS_KM * angularDistanceRad;

  return Math.round(distance * 100) / 100;
}

/**
 * Formats a Date object or current time to an ISO YYYY-MM-DD date in AWST (UTC+08:00).
 *
 * @param {Date} [date=new Date()]
 * @returns {string} Date string e.g. "2026-11-11"
 */
export function getTodayAwstDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Perth',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

/**
 * Checks whether an activity is expired based on AWST date comparison.
 * Weekly recurring activities are retained indefinitely.
 * Non-recurring activities with end_date (or start_date) < today in AWST are expired.
 *
 * @param {object} activity
 * @param {string} [todayAwst=getTodayAwstDate()]
 * @returns {boolean}
 */
export function isActivityExpired(activity, todayAwst = getTodayAwstDate()) {
  const schedule = activity?.schedule;
  if (!schedule) return false;

  const recurrence = schedule.recurrence || activity.recurrence || 'none';
  if (recurrence === 'weekly') {
    return false;
  }

  const endDate = schedule.end_date || activity.end_date;
  if (endDate && endDate < todayAwst) {
    return true;
  }

  const startDate = schedule.start_date || activity.start_date;
  if (!endDate && startDate && startDate < todayAwst) {
    return true;
  }

  return false;
}

/**
 * Filter listings (Activities, Organizers, or Venues) by categorical facets
 * and optional AWST date expiration.
 *
 * @param {Array<object>} [listings=[]]
 * @param {{ sport?: string, sports?: string[], freeOnly?: boolean, gender?: string, age?: string }} [filters={}]
 * @param {object} [options={}]
 * @param {string} [options.todayAwst]
 * @param {boolean} [options.applyExpiration=true]
 * @returns {Array<object>} Filtered listings
 */
export function filterListings(listings = [], filters = {}, options = {}) {
  const { sport, sports, freeOnly, gender, age } = filters;
  const todayAwst = options.todayAwst || getTodayAwstDate();
  const applyExpiration = options.applyExpiration !== false;

  return listings.filter((item) => {
    // Expiration check (applied strictly to Activities, never Organizers/Venues)
    if (applyExpiration && isActivityExpired(item, todayAwst)) {
      return false;
    }

    // Sport facets: multi-sport array (OR logic) or single sport string
    if (Array.isArray(sports) && sports.length > 0) {
      const itemSports = extractListingSports(item);
      if (!itemSports.some((s) => sports.includes(s))) {
        return false;
      }
    } else if (sport && sport !== 'all') {
      const itemSports = extractListingSports(item);
      if (!itemSports.includes(sport)) {
        return false;
      }
    }

    // Cost facet
    const isFree = item.cost ? item.cost.is_free : Boolean(item.is_free);
    if (freeOnly && !isFree) {
      return false;
    }

    // Gender facet ('all', 'women_only', 'men_only')
    if (gender && gender !== 'all') {
      const actGender = item.demographics?.gender;
      if (actGender && actGender !== gender) {
        if (gender === 'women' && actGender === 'women_only') {
          // match
        } else if (gender === 'men' && actGender === 'men_only') {
          // match
        } else if (gender === 'mixed' && actGender === 'all') {
          // match
        } else {
          return false;
        }
      }
    }

    // Age facet ('all', 'adults', 'juniors', 'masters')
    if (age && age !== 'all') {
      const actAge = item.demographics?.age;
      if (actAge && actAge !== age && actAge !== 'all') {
        return false;
      }
    }

    return true;
  });
}

/**
 * Filter activities by categorical facets and deterministic AWST expiration.
 *
 * @param {Array<object>} activities
 * @param {{ sport?: string, sports?: string[], freeOnly?: boolean, gender?: string, age?: string }} [filters={}]
 * @param {string} [todayAwst=getTodayAwstDate()]
 * @returns {Array<object>} Filtered activities
 */
export function filterActivities(activities, filters = {}, todayAwst = getTodayAwstDate()) {
  return filterListings(activities, filters, { todayAwst, applyExpiration: true });
}

/**
 * Filter organizers by categorical facets (without AWST schedule expiration).
 *
 * @param {Array<object>} [organizers=[]]
 * @param {object} [filters={}]
 * @returns {Array<object>}
 */
export function filterOrganizers(organizers = [], filters = {}) {
  return filterListings(organizers, filters, { applyExpiration: false });
}

/**
 * Filter venues by categorical facets (without AWST schedule expiration).
 *
 * @param {Array<object>} [venues=[]]
 * @param {object} [filters={}]
 * @returns {Array<object>}
 */
export function filterVenues(venues = [], filters = {}) {
  return filterListings(venues, filters, { applyExpiration: false });
}

/**
 * Filter and rank listings (Activities, Organizers, or Venues) by distance from location and selected facets.
 * Supports location: null (returns []), numeric and 'all' radius, and maxResults cap.
 *
 * @param {Array<object>} [listings=[]]
 * @param {object} [options={}]
 * @param {{ lat: number, lng: number }|null} [options.location]
 * @param {{ lat: number, lng: number }} [options.center]
 * @param {number|'all'} [options.radiusKm=10]
 * @param {object} [options.filters={}]
 * @param {number} [options.maxResults=50]
 * @param {string} [options.todayAwst]
 * @param {boolean} [options.applyExpiration]
 * @param {string} [options.type]
 * @returns {Array<object>} Filtered and distance-ranked listings
 */
export function filterAndRankListings(listings = [], options = {}) {
  const location = options.location !== undefined ? options.location : options.center;
  // Cold start gate: if location is null or undefined, return no listings
  if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
    return [];
  }

  const radiusKm = options.radiusKm !== undefined ? options.radiusKm : 10;
  const filters = options.filters || {};
  const maxResults = options.maxResults !== undefined ? options.maxResults : 50;
  const todayAwst = options.todayAwst || getTodayAwstDate();
  const applyExpiration = options.applyExpiration !== undefined
    ? options.applyExpiration
    : (options.type !== 'organizer' && options.type !== 'organizers' && options.type !== 'venue' && options.type !== 'venues');

  // Step 1: Filter by categorical facets and optional expiration
  const facetMatched = filterListings(listings, filters, { todayAwst, applyExpiration });

  // Step 2: Compute distance for each and filter by radius (unless radiusKm === 'all')
  const isAllRadius = radiusKm === 'all' || radiusKm === Infinity;
  const numericRadius = Number(radiusKm);

  const withDistance = [];
  for (const item of facetMatched) {
    const coords = extractListingCoordinates(item);
    const distanceKm = coords ? calculateDistanceKm(location, coords) : Infinity;

    if (isAllRadius || distanceKm <= numericRadius) {
      withDistance.push({
        ...item,
        distanceKm
      });
    }
  }

  // Step 3: Sort listings
  // Organizers and venues are ranked by proximity (nearest to furthest).
  // Activities are ordered by date and time from earlier to later, with proximity tie-breaker.
  const isOrganizerOrVenue = options.type === 'organizer' || options.type === 'organizers' || options.type === 'venue' || options.type === 'venues';
  const sortBy = options.sortBy || (isOrganizerOrVenue ? 'distance' : 'datetime');

  if (sortBy === 'datetime') {
    withDistance.sort((a, b) => compareActivitiesByDateTime(a, b, { todayAwst, referenceDate: options.referenceDate }));
  } else {
    withDistance.sort((a, b) => a.distanceKm - b.distanceKm);
  }

  // Step 4: Cap at maxResults if specified
  if (typeof maxResults === 'number' && maxResults > 0) {
    return withDistance.slice(0, maxResults);
  }

  return withDistance;
}

/**
 * Filter and rank activities by date/time (earlier to later) and distance from location and selected facets.
 *
 * @param {Array<object>} activities
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
export function filterAndRankActivities(activities, options = {}) {
  return filterAndRankListings(activities, { ...options, applyExpiration: true, type: 'activities' });
}

/**
 * Filter and rank organizers by distance from location and selected facets.
 *
 * @param {Array<object>} [organizers=[]]
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
export function filterAndRankOrganizers(organizers = [], options = {}) {
  return filterAndRankListings(organizers, { ...options, applyExpiration: false, type: 'organizers' });
}

/**
 * Filter and rank venues by distance from location and selected facets.
 *
 * @param {Array<object>} [venues=[]]
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
export function filterAndRankVenues(venues = [], options = {}) {
  return filterAndRankListings(venues, { ...options, applyExpiration: false, type: 'venues' });
}

/**
 * Creates a reactive Discovery State Store.
 * Provides subscription listeners and state transition methods for zero-framework UI synchronization.
 *
 * @param {Array<object>|object} [activitiesOrConfig=[]] Initial activities array or unified configuration object
 * @param {object} [optionalConfig={}] Configuration object if first argument is array
 */
export function createDiscoveryStore(activitiesOrConfig = [], optionalConfig = {}) {
  let initialActivities = [];
  let config = {};

  if (Array.isArray(activitiesOrConfig)) {
    initialActivities = activitiesOrConfig;
    config = optionalConfig || {};
  } else if (activitiesOrConfig && typeof activitiesOrConfig === 'object') {
    initialActivities = activitiesOrConfig.activities || [];
    config = activitiesOrConfig;
  }

  const activities = [...initialActivities];
  const organizers = Array.isArray(config.organizers) ? [...config.organizers] : [];
  const venues = Array.isArray(config.venues) ? [...config.venues] : [];
  let activeTab = normalizeDiscoveryTab(config.activeTab || config.tab || 'activities');
  let location = config.location !== undefined ? config.location : (config.center || null);
  let radiusKm = config.radiusKm !== undefined ? config.radiusKm : 10;
  let maxResults = config.maxResults !== undefined ? config.maxResults : 50;
  let filters = {
    sports: [],
    sport: 'all',
    freeOnly: false,
    gender: 'all',
    age: 'all',
    ...(config.filters || {})
  };
  let selectedActivityId = config.selectedActivityId || config.pinnedActivityId || null;
  let selectedOrganizerId = config.selectedOrganizerId || null;
  let selectedVenueId = config.selectedVenueId || null;
  let hoveredActivityId = null;

  const listeners = new Set();

  const todayAwst = config.todayAwst || undefined;
  const referenceDate = config.referenceDate || undefined;

  function computeFilteredForList(sourceList, selectedId, applyExpiration, listingType) {
    const list = filterAndRankListings(sourceList, {
      location,
      radiusKm,
      filters,
      maxResults,
      applyExpiration,
      type: listingType,
      todayAwst,
      referenceDate
    });

    if (selectedId && !list.some((item) => item.id === selectedId)) {
      const target = sourceList.find((item) => item.id === selectedId);
      if (target) {
        const coords = extractListingCoordinates(target);
        const distanceKm = coords && location ? calculateDistanceKm(location, coords) : null;
        list.unshift({ ...target, distanceKm: distanceKm !== null ? distanceKm : 0 });
        if (typeof maxResults === 'number' && maxResults > 0 && list.length > maxResults) {
          list.length = maxResults;
        }
      }
    }

    return list;
  }

  function notify(changeType) {
    const currentState = getState();
    for (const listener of listeners) {
      try {
        listener(currentState, changeType);
      } catch (err) {
        console.error('Error in discovery store listener:', err);
      }
    }
  }

  function getState() {
    const filteredActivities = computeFilteredForList(activities, selectedActivityId, true, 'activities');
    const filteredOrganizers = computeFilteredForList(organizers, selectedOrganizerId, false, 'organizers');
    const filteredVenues = computeFilteredForList(venues, selectedVenueId, false, 'venues');
    const filteredListings = activeTab === 'organizers'
      ? filteredOrganizers
      : (activeTab === 'venues' ? filteredVenues : filteredActivities);

    return {
      activeTab,
      activities,
      organizers,
      venues,
      location: location ? { ...location } : null,
      center: location ? { ...location } : null,
      radiusKm,
      filters: { ...filters, sports: [...(filters.sports || [])] },
      selectedActivityId,
      selectedOrganizerId,
      selectedVenueId,
      hoveredActivityId,
      maxResults,
      filteredActivities,
      filteredOrganizers,
      filteredVenues,
      filteredListings
    };
  }

  function setTabInternal(nextTab) {
    activeTab = normalizeDiscoveryTab(nextTab);
    notify('tab');
  }

  return {
    getState,
    setTab: setTabInternal,
    setActiveTab: setTabInternal,
    setActivities(newActivities = []) {
      activities.length = 0;
      if (Array.isArray(newActivities)) {
        activities.push(...newActivities);
      }
      notify('activities');
    },
    setOrganizers(newOrganizers = []) {
      organizers.length = 0;
      if (Array.isArray(newOrganizers)) {
        organizers.push(...newOrganizers);
      }
      notify('organizers');
    },
    setVenues(newVenues = []) {
      venues.length = 0;
      if (Array.isArray(newVenues)) {
        venues.push(...newVenues);
      }
      notify('venues');
    },
    setLocation(newLocation) {
      location = newLocation ? { ...newLocation } : null;
      notify('location');
    },
    setCenter(newCenter) {
      location = newCenter ? { ...newCenter } : null;
      notify('center');
    },
    setRadius(newRadiusKm) {
      radiusKm = newRadiusKm === 'all' ? 'all' : Number(newRadiusKm);
      notify('radius');
    },
    setFilter(key, value) {
      filters[key] = value;
      notify('filter');
    },
    setSportsFilter(sportsList = []) {
      filters.sports = Array.isArray(sportsList) ? [...sportsList] : [];
      notify('filter');
    },
    clearFilters() {
      filters = {
        sports: [],
        sport: 'all',
        freeOnly: false,
        gender: 'all',
        age: 'all'
      };
      notify('filter');
    },
    setSelectedActivity(id) {
      selectedActivityId = id;
      notify('select');
    },
    setSelectedOrganizer(id) {
      selectedOrganizerId = id;
      notify('select');
    },
    setSelectedVenue(id) {
      selectedVenueId = id;
      notify('select');
    },
    setHoveredActivity(id) {
      if (hoveredActivityId === id) return;
      hoveredActivityId = id;
      notify('hover');
    },
    subscribe(eventOrListener, optionalListener) {
      let listener;
      if (typeof eventOrListener === 'string' && typeof optionalListener === 'function') {
        const targetEvent = eventOrListener;
        listener = (state, changeType) => {
          if (changeType === targetEvent || targetEvent === '*') {
            optionalListener(state, changeType);
          }
        };
      } else if (typeof eventOrListener === 'function') {
        listener = eventOrListener;
      } else {
        return () => {};
      }

      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
