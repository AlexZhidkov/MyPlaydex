/**
 * Discovery Engine for MyPlaydex
 * Pure JavaScript module implementing geospatial calculation, multi-facet filtering,
 * and reactive discovery state synchronization.
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
 * Filter activities by categorical facets.
 *
 * @param {Array<object>} activities
 * @param {{ sport?: string, freeOnly?: boolean, gender?: string, age?: string }} filters
 * @returns {Array<object>} Filtered activities
 */
export function filterActivities(activities, filters = {}) {
  const { sport, freeOnly, gender, age } = filters;

  return activities.filter((activity) => {
    // Sport facet
    if (sport && sport !== 'all') {
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
 * Filter and rank activities by distance from center and selected facets.
 *
 * @param {Array<object>} activities
 * @param {object} options
 * @param {{ lat: number, lng: number }} options.center
 * @param {number} [options.radiusKm=10]
 * @param {object} [options.filters={}]
 * @returns {Array<object>} Filtered and distance-ranked activities
 */
export function filterAndRankActivities(activities, options = {}) {
  const {
    center = { lat: -31.9505, lng: 115.8605 },
    radiusKm = 10,
    filters = {}
  } = options;

  // Step 1: Filter by categorical facets
  const facetMatched = filterActivities(activities, filters);

  // Step 2: Compute distance for each and filter by radius
  const withDistance = [];
  for (const activity of facetMatched) {
    const coords = activity.venue?.coordinates;
    const distanceKm = coords ? calculateDistanceKm(center, coords) : Infinity;

    if (distanceKm <= radiusKm) {
      withDistance.push({
        ...activity,
        distanceKm
      });
    }
  }

  // Step 3: Sort by proximity
  withDistance.sort((a, b) => a.distanceKm - b.distanceKm);

  return withDistance;
}

/**
 * Creates a reactive Discovery State Store.
 * Provides subscription listeners and state transition methods for zero-framework UI synchronization.
 *
 * @param {Array<object>} initialActivities
 * @param {object} [initialConfig={}]
 */
export function createDiscoveryStore(initialActivities = [], initialConfig = {}) {
  const activities = [...initialActivities];
  let center = initialConfig.center || { lat: -31.9505, lng: 115.8605 };
  let radiusKm = initialConfig.radiusKm || 10;
  let filters = {
    sport: 'all',
    freeOnly: false,
    gender: 'all',
    age: 'all',
    ...(initialConfig.filters || {})
  };
  let selectedActivityId = null;
  let hoveredActivityId = null;

  const listeners = new Set();

  function computeFiltered() {
    return filterAndRankActivities(activities, {
      center,
      radiusKm,
      filters
    });
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
      center: { ...center },
      radiusKm,
      filters: { ...filters },
      selectedActivityId,
      hoveredActivityId,
      filteredActivities: computeFiltered()
    };
  }

  return {
    getState,
    setCenter(newCenter) {
      center = { ...newCenter };
      notify('center');
    },
    setRadius(newRadiusKm) {
      radiusKm = Number(newRadiusKm);
      notify('radius');
    },
    setFilter(key, value) {
      filters[key] = value;
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
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
