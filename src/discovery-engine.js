/**
 * Discovery Engine for MyPlaydex
 * Pure JavaScript module implementing geospatial calculation, multi-facet filtering,
 * deterministic AWST listing expiration, and reactive discovery state synchronization.
 */

const EARTH_RADIUS_KM = 6371;

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
 * Filter activities by categorical facets and deterministic AWST expiration.
 *
 * @param {Array<object>} activities
 * @param {{ sport?: string, sports?: string[], freeOnly?: boolean, gender?: string, age?: string }} [filters={}]
 * @param {string} [todayAwst=getTodayAwstDate()]
 * @returns {Array<object>} Filtered activities
 */
export function filterActivities(activities, filters = {}, todayAwst = getTodayAwstDate()) {
  const { sport, sports, freeOnly, gender, age } = filters;

  return activities.filter((activity) => {
    // Expiration check
    if (isActivityExpired(activity, todayAwst)) {
      return false;
    }

    // Sport facets: multi-sport array (OR logic) or single sport string
    if (Array.isArray(sports) && sports.length > 0) {
      const actSport = activity.subcategory || activity.sport;
      if (!sports.includes(actSport)) {
        return false;
      }
    } else if (sport && sport !== 'all') {
      const actSport = activity.subcategory || activity.sport;
      if (actSport !== sport) {
        return false;
      }
    }

    // Cost facet
    const isFree = activity.cost ? activity.cost.is_free : Boolean(activity.is_free);
    if (freeOnly && !isFree) {
      return false;
    }

    // Gender facet ('all', 'women_only', 'men_only')
    if (gender && gender !== 'all') {
      const actGender = activity.demographics?.gender;
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
      const actAge = activity.demographics?.age;
      if (actAge && actAge !== age && actAge !== 'all') {
        return false;
      }
    }

    return true;
  });
}

/**
 * Filter and rank activities by distance from location and selected facets.
 * Supports location: null (returns []), numeric and 'all' radius, and maxResults cap.
 *
 * @param {Array<object>} activities
 * @param {object} [options={}]
 * @param {{ lat: number, lng: number }|null} [options.location]
 * @param {{ lat: number, lng: number }} [options.center]
 * @param {number|'all'} [options.radiusKm=10]
 * @param {object} [options.filters={}]
 * @param {number} [options.maxResults=50]
 * @param {string} [options.todayAwst]
 * @returns {Array<object>} Filtered and distance-ranked activities
 */
export function filterAndRankActivities(activities, options = {}) {
  const location = options.location !== undefined ? options.location : options.center;
  // Cold start gate: if location is null or undefined, return no activities
  if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
    return [];
  }

  const radiusKm = options.radiusKm !== undefined ? options.radiusKm : 10;
  const filters = options.filters || {};
  const maxResults = options.maxResults !== undefined ? options.maxResults : 50;
  const todayAwst = options.todayAwst || getTodayAwstDate();

  // Step 1: Filter by categorical facets and expiration
  const facetMatched = filterActivities(activities, filters, todayAwst);

  // Step 2: Compute distance for each and filter by radius (unless radiusKm === 'all')
  const isAllRadius = radiusKm === 'all' || radiusKm === Infinity;
  const numericRadius = Number(radiusKm);

  const withDistance = [];
  for (const activity of facetMatched) {
    const coords = activity.venue?.coordinates || (activity.venue?.lat !== undefined ? activity.venue : null);
    const distanceKm = coords ? calculateDistanceKm(location, coords) : Infinity;

    if (isAllRadius || distanceKm <= numericRadius) {
      withDistance.push({
        ...activity,
        distanceKm
      });
    }
  }

  // Step 3: Sort by proximity (nearest to furthest)
  withDistance.sort((a, b) => a.distanceKm - b.distanceKm);

  // Step 4: Cap at maxResults if specified
  if (typeof maxResults === 'number' && maxResults > 0) {
    return withDistance.slice(0, maxResults);
  }

  return withDistance;
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
  let hoveredActivityId = null;

  const listeners = new Set();

  function computeFiltered() {
    const list = filterAndRankActivities(activities, {
      location,
      radiusKm,
      filters,
      maxResults
    });

    if (selectedActivityId && !list.some((a) => a.id === selectedActivityId)) {
      const target = activities.find((a) => a.id === selectedActivityId);
      if (target) {
        const coords = target.venue?.coordinates || (target.venue?.lat !== undefined ? target.venue : null);
        const distanceKm = coords && location ? calculateDistanceKm(location, coords) : null;
        list.unshift({ ...target, distanceKm: distanceKm !== null ? distanceKm : 0 });
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
    return {
      activities,
      location: location ? { ...location } : null,
      center: location ? { ...location } : null,
      radiusKm,
      filters: { ...filters, sports: [...(filters.sports || [])] },
      selectedActivityId,
      hoveredActivityId,
      maxResults,
      filteredActivities: computeFiltered()
    };
  }

  return {
    getState,
    setActivities(newActivities = []) {
      activities.length = 0;
      if (Array.isArray(newActivities)) {
        activities.push(...newActivities);
      }
      notify('activities');
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
