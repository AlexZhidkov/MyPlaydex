/**
 * Edit Serialization, Validation, Curated-Field Diffing & Derived-Field
 * Computation for /admin Curation Workspace.
 * Pure Vanilla JS ES2022 module (zero-build, zero side effects).
 */

import { encodeGeohash } from '../shared/geohash.js';
import {
  CANONICAL_CATEGORIES,
  CANONICAL_GENDERS,
  CANONICAL_AGES,
  CANONICAL_RECURRENCES,
  computeActivityExpireAt,
  computeScheduleDayOfWeek,
  mergeCuratedFields,
  isValidHttpUrl
} from '../shared/listing-domain.js';

export const IMMUTABLE_FIELDS = Object.freeze(['id', 'source', 'source_id', 'created_at']);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function asString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function asCoordString(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function asTrimmedOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asTrimmedString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function isValidCalendarDate(dateStr) {
  if (!ISO_DATE_RE.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function parseCoordinate(rawValue, label, min, max) {
  const str = typeof rawValue === 'number' ? String(rawValue) : asTrimmedString(rawValue);
  if (!str) {
    return { value: null, error: `${label} is required.` };
  }
  const num = Number(str);
  if (!Number.isFinite(num) || num < min || num > max) {
    return { value: null, error: `${label} must be a number between ${min} and ${max}.` };
  }
  return { value: num, error: null };
}

function parseOptionalUrl(rawValue, label) {
  const str = asTrimmedString(rawValue);
  if (!str) {
    return { value: null, error: null };
  }
  if (!isValidHttpUrl(str)) {
    return { value: null, error: `${label} must start with http:// or https://.` };
  }
  return { value: str, error: null };
}

function parseOptionalDate(rawValue, label) {
  const str = asTrimmedString(rawValue);
  if (!str) return { value: null, error: null };
  if (!isValidCalendarDate(str)) {
    return { value: null, error: `${label} must be a valid YYYY-MM-DD date.` };
  }
  return { value: str, error: null };
}

function parseOptionalTime(rawValue, label) {
  const str = asTrimmedString(rawValue);
  if (!str) return { value: null, error: null };
  if (!HH_MM_RE.test(str)) {
    return { value: null, error: `${label} must be in 24-hour HH:mm format.` };
  }
  return { value: str, error: null };
}

function parseSubcategories(rawList, rawPrimary) {
  const parts = Array.isArray(rawList)
    ? rawList
    : asTrimmedString(rawList).split(',');
  const seen = new Set();
  const list = [];
  for (const part of parts) {
    const slug = String(part ?? '').trim().toLowerCase();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    list.push(slug);
  }
  const primary = asTrimmedString(rawPrimary).toLowerCase() || list[0] || 'other';
  if (list.length === 0) {
    list.push(primary);
  } else if (!list.includes(primary) && primary !== 'other') {
    list.unshift(primary);
  }
  return { subcategory: primary, subcategories: list };
}

function normalizeChoice(rawValue, allowed, fallback) {
  const normalized = asTrimmedString(rawValue).toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

/**
 * Serializes a Listing (Activity, Organizer, or Venue) into an edit drawer draft
 * separating read-only identity/metadata from mutable form values.
 *
 * @param {'activities' | 'organizers' | 'venues'} entityType
 * @param {object} listing
 * @returns {{ readOnly: object, values: object }}
 */
export function createEditDraft(entityType, listing = {}) {
  const raw = listing?.raw && typeof listing.raw === 'object' ? listing.raw : listing;

  const readOnly = {
    id: raw.id || listing.id || listing.docId || '',
    source: raw.source || listing.source || '',
    source_id: raw.source_id || listing.sourceId || '',
    created_at: raw.created_at ?? listing.createdAtMs ?? null,
    updated_at: raw.updated_at ?? listing.updatedAtMs ?? null,
    curated_fields: Array.isArray(raw.curated_fields)
      ? [...raw.curated_fields]
      : (Array.isArray(listing.curatedFields) ? [...listing.curatedFields] : []),
    geohash: entityType === 'activities'
      ? (raw.venue?.geohash || '')
      : (raw.geohash || ''),
    expire_at: entityType === 'activities' ? (raw.expire_at ?? null) : null,
    day_of_week: entityType === 'activities' ? (raw.schedule?.day_of_week ?? null) : null
  };

  if (entityType === 'activities') {
    const coords = raw.venue?.coordinates || {};
    const schedule = raw.schedule || {};
    const cost = raw.cost || {};
    const demographics = raw.demographics || {};
    const sourceUrl = asString(raw.source_url, '');

    return {
      readOnly,
      values: {
        title: asString(raw.title || listing.name, ''),
        description: asString(raw.description, ''),
        region_id: asString(raw.region_id, 'perth'),
        category: asString(raw.category || listing.category, 'sports'),
        subcategory: asString(raw.subcategory || listing.subcategory, 'other'),
        source_url: sourceUrl,
        verified: Boolean(sourceUrl && raw.verified),
        organizer_id: asString(raw.organizer?.id, ''),
        organizer_name: asString(raw.organizer?.name || listing.organizerName, ''),
        venue_id: asString(raw.venue?.id, ''),
        venue_name: asString(raw.venue?.name || listing.venueName, ''),
        venue_google_place_id: asString(raw.venue?.google_place_id, ''),
        lat: asCoordString(coords.lat),
        lng: asCoordString(coords.lng),
        recurrence: asString(schedule.recurrence, 'none'),
        start_date: asString(schedule.start_date, ''),
        end_date: asString(schedule.end_date, ''),
        start_time: asString(schedule.start_time, ''),
        end_time: asString(schedule.end_time, ''),
        day_of_week: schedule.day_of_week === null || schedule.day_of_week === undefined
          ? ''
          : String(schedule.day_of_week),
        is_free: Boolean(cost.is_free),
        display_price: asString(cost.display_price, ''),
        gender: asString(demographics.gender, 'all'),
        age: asString(demographics.age, 'all')
      }
    };
  }

  const coords = raw.coordinates || {};
  const subcategories = Array.isArray(raw.subcategories) && raw.subcategories.length > 0
    ? raw.subcategories
    : (raw.subcategory ? [raw.subcategory] : []);
  const sourceUrl = asString(raw.source_url, '');

  if (entityType === 'organizers') {
    const contact = raw.contact || {};
    const demographics = raw.demographics || {};
    return {
      readOnly,
      values: {
        name: asString(raw.name || listing.name, ''),
        description: asString(raw.description, ''),
        address: asString(raw.address || listing.address, ''),
        region_id: asString(raw.region_id, 'perth'),
        category: asString(raw.category || listing.category, 'sports'),
        subcategory: asString(raw.subcategory || listing.subcategory, 'other'),
        subcategories: subcategories.join(', '),
        lat: asCoordString(coords.lat),
        lng: asCoordString(coords.lng),
        website: asString(raw.website, ''),
        contact_email: asString(contact.email, ''),
        contact_phone: asString(contact.phone, ''),
        contact_facebook: asString(contact.facebook, ''),
        cost_description: asString(raw.cost_description, ''),
        gender: asString(demographics.gender, 'all'),
        age: asString(demographics.age, 'all'),
        source_url: sourceUrl,
        verified: Boolean(sourceUrl && raw.verified)
      }
    };
  }

  return {
    readOnly,
    values: {
      name: asString(raw.name || listing.name, ''),
      description: asString(raw.description, ''),
      address: asString(raw.address || listing.address, ''),
      region_id: asString(raw.region_id, 'perth'),
      category: asString(raw.category || listing.category, 'sports'),
      subcategory: asString(raw.subcategory || listing.subcategory, 'other'),
      subcategories: subcategories.join(', '),
      lat: asCoordString(coords.lat),
      lng: asCoordString(coords.lng),
      source_url: sourceUrl,
      verified: Boolean(sourceUrl && raw.verified)
    }
  };
}

/**
 * Parses and validates raw form values for an Activity, Organizer, or Venue.
 * Clearing `source_url` (or providing an invalid URL) forces `verified: false`.
 *
 * @param {'activities' | 'organizers' | 'venues'} entityType
 * @param {Record<string, any>} [formValues={}]
 * @returns {{ values: object, errors: Record<string, string> }}
 */
export function parseEditFormValues(entityType, formValues = {}) {
  const errors = {};

  const latParsed = parseCoordinate(formValues.lat, 'Latitude', -90, 90);
  if (latParsed.error) errors.lat = latParsed.error;

  const lngParsed = parseCoordinate(formValues.lng, 'Longitude', -180, 180);
  if (lngParsed.error) errors.lng = lngParsed.error;

  const sourceUrlParsed = parseOptionalUrl(formValues.source_url, 'Source URL');
  if (sourceUrlParsed.error) errors.source_url = sourceUrlParsed.error;

  const verified = sourceUrlParsed.value !== null && !sourceUrlParsed.error
    ? Boolean(formValues.verified)
    : false;

  const regionId = asTrimmedString(formValues.region_id) || 'perth';
  const category = normalizeChoice(formValues.category, CANONICAL_CATEGORIES, 'sports');

  if (entityType === 'activities') {
    const title = asTrimmedString(formValues.title);
    if (!title) errors.title = 'Title is required.';

    const startDate = parseOptionalDate(formValues.start_date, 'Start date');
    if (startDate.error) errors.start_date = startDate.error;

    const endDate = parseOptionalDate(formValues.end_date, 'End date');
    if (endDate.error) errors.end_date = endDate.error;

    const startTime = parseOptionalTime(formValues.start_time, 'Start time');
    if (startTime.error) errors.start_time = startTime.error;

    const endTime = parseOptionalTime(formValues.end_time, 'End time');
    if (endTime.error) errors.end_time = endTime.error;

    const recurrence = normalizeChoice(formValues.recurrence, CANONICAL_RECURRENCES, 'none');
    const rawDayStr = asTrimmedString(formValues.day_of_week);
    let dayOfWeek = null;
    if (rawDayStr !== '') {
      const parsedDay = Number(rawDayStr);
      if (Number.isInteger(parsedDay) && parsedDay >= 0 && parsedDay <= 6) {
        dayOfWeek = parsedDay;
      } else {
        errors.day_of_week = 'Day of week must be 0 (Sunday) through 6 (Saturday).';
      }
    }

    return {
      errors,
      values: {
        title,
        description: asTrimmedString(formValues.description),
        region_id: regionId,
        category,
        subcategory: asTrimmedString(formValues.subcategory).toLowerCase() || 'other',
        source_url: sourceUrlParsed.value,
        verified,
        organizer_id: asTrimmedOrNull(formValues.organizer_id),
        organizer_name: asTrimmedString(formValues.organizer_name),
        venue_id: asTrimmedOrNull(formValues.venue_id),
        venue_name: asTrimmedString(formValues.venue_name),
        venue_google_place_id: Object.hasOwn(formValues, 'venue_google_place_id')
          ? asTrimmedOrNull(formValues.venue_google_place_id)
          : undefined,
        lat: latParsed.value,
        lng: lngParsed.value,
        recurrence,
        start_date: startDate.value,
        end_date: endDate.value,
        start_time: startTime.value,
        end_time: endTime.value,
        day_of_week: dayOfWeek,
        is_free: Boolean(formValues.is_free),
        display_price: asTrimmedString(formValues.display_price),
        gender: normalizeChoice(formValues.gender, CANONICAL_GENDERS, 'all'),
        age: normalizeChoice(formValues.age, CANONICAL_AGES, 'all')
      }
    };
  }

  const name = asTrimmedString(formValues.name);
  if (!name) errors.name = 'Name is required.';

  const { subcategory, subcategories } = parseSubcategories(
    formValues.subcategories,
    formValues.subcategory
  );

  if (entityType === 'organizers') {
    const websiteParsed = parseOptionalUrl(formValues.website, 'Website');
    if (websiteParsed.error) errors.website = websiteParsed.error;

    const facebookParsed = parseOptionalUrl(formValues.contact_facebook, 'Facebook URL');
    if (facebookParsed.error) errors.contact_facebook = facebookParsed.error;

    return {
      errors,
      values: {
        name,
        description: asTrimmedString(formValues.description),
        address: asTrimmedString(formValues.address),
        region_id: regionId,
        category,
        subcategory,
        subcategories,
        lat: latParsed.value,
        lng: lngParsed.value,
        website: websiteParsed.value,
        contact_email: asTrimmedOrNull(formValues.contact_email),
        contact_phone: asTrimmedOrNull(formValues.contact_phone),
        contact_facebook: facebookParsed.value,
        cost_description: asTrimmedString(formValues.cost_description),
        gender: normalizeChoice(formValues.gender, CANONICAL_GENDERS, 'all'),
        age: normalizeChoice(formValues.age, CANONICAL_AGES, 'all'),
        source_url: sourceUrlParsed.value,
        verified
      }
    };
  }

  return {
    errors,
    values: {
      name,
      description: asTrimmedString(formValues.description),
      address: asTrimmedString(formValues.address),
      region_id: regionId,
      category,
      subcategory,
      subcategories,
      lat: latParsed.value,
      lng: lngParsed.value,
      source_url: sourceUrlParsed.value,
      verified
    }
  };
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, idx) => item === b[idx]);
  }
  return false;
}

function coordsChanged(prevCoords, lat, lng) {
  return prevCoords?.lat !== lat || prevCoords?.lng !== lng;
}

/**
 * Diffs parsed form values against the original Firestore document, recomputes
 * derived fields (`geohash`, `day_of_week`, `expire_at`), appends modified field
 * names to `curated_fields`, and auto-approves the Listing (`needs_review: false`).
 * Never includes immutable identity/creation fields in `updatePayload`.
 *
 * @param {'activities' | 'organizers' | 'venues'} entityType
 * @param {object} originalDoc
 * @param {object} parsedValues
 * @param {object} [options={}]
 * @returns {{ updatePayload: object, nextRawDoc: object, editedFields: string[], curatedFields: string[], derived: object }}
 */
export function buildListingSavePayload(entityType, originalDoc = {}, parsedValues = {}, options = {}) {
  const {
    timestampFromDate = (d) => d,
    serverTimestamp = () => new Date().toISOString(),
    deleteField = () => null,
    nowIso = new Date().toISOString()
  } = options;

  const editedFields = [];
  const recordIfChanged = (fieldPath, prevVal, nextVal) => {
    if (!valuesEqual(prevVal, nextVal)) {
      editedFields.push(fieldPath);
    }
  };

  let mutableFields = {};
  let derived = {};

  if (entityType === 'activities') {
    const prevVenue = originalDoc.venue || {};
    const prevOrganizer = originalDoc.organizer || {};
    const prevSchedule = originalDoc.schedule || {};
    const prevCost = originalDoc.cost || {};
    const prevDemographics = originalDoc.demographics || {};

    recordIfChanged('title', originalDoc.title ?? '', parsedValues.title);
    recordIfChanged('description', originalDoc.description ?? '', parsedValues.description);
    recordIfChanged('region_id', originalDoc.region_id ?? 'perth', parsedValues.region_id);
    recordIfChanged('category', originalDoc.category ?? 'sports', parsedValues.category);
    recordIfChanged('subcategory', originalDoc.subcategory ?? 'other', parsedValues.subcategory);
    recordIfChanged('source_url', originalDoc.source_url ?? null, parsedValues.source_url);
    recordIfChanged('verified', Boolean(originalDoc.verified), parsedValues.verified);

    recordIfChanged('organizer.id', prevOrganizer.id ?? null, parsedValues.organizer_id);
    recordIfChanged('organizer.name', prevOrganizer.name ?? '', parsedValues.organizer_name);

    recordIfChanged('venue.id', prevVenue.id ?? null, parsedValues.venue_id);
    recordIfChanged('venue.name', prevVenue.name ?? '', parsedValues.venue_name);

    const prevVenueGooglePlaceId = asTrimmedOrNull(prevVenue.google_place_id);
    let nextVenueGooglePlaceId = null;
    if (parsedValues.venue_google_place_id !== undefined) {
      nextVenueGooglePlaceId = parsedValues.venue_google_place_id;
    } else if (parsedValues.venue_id === (prevVenue.id ?? null)) {
      nextVenueGooglePlaceId = prevVenueGooglePlaceId;
    }
    recordIfChanged('venue.google_place_id', prevVenueGooglePlaceId, nextVenueGooglePlaceId);

    const venueCoordsEdited = coordsChanged(prevVenue.coordinates, parsedValues.lat, parsedValues.lng);
    const venueGeohash = venueCoordsEdited || !prevVenue.geohash
      ? encodeGeohash(parsedValues.lat, parsedValues.lng, 9)
      : prevVenue.geohash;
    if (venueCoordsEdited) {
      editedFields.push('venue.coordinates', 'venue.geohash');
    }

    const scheduleChanged =
      (prevSchedule.recurrence ?? 'none') !== parsedValues.recurrence ||
      (prevSchedule.start_date ?? null) !== parsedValues.start_date ||
      (prevSchedule.end_date ?? null) !== parsedValues.end_date ||
      (prevSchedule.start_time ?? null) !== parsedValues.start_time ||
      (prevSchedule.end_time ?? null) !== parsedValues.end_time ||
      (prevSchedule.day_of_week ?? null) !== parsedValues.day_of_week;

    const candidateSchedule = {
      start_date: parsedValues.start_date,
      end_date: parsedValues.end_date,
      start_time: parsedValues.start_time,
      end_time: parsedValues.end_time,
      recurrence: parsedValues.recurrence,
      day_of_week: parsedValues.day_of_week
    };

    const nextDayOfWeek = scheduleChanged || prevSchedule.day_of_week === undefined
      ? computeScheduleDayOfWeek(candidateSchedule)
      : prevSchedule.day_of_week;
    const nextSchedule = {
      ...candidateSchedule,
      day_of_week: nextDayOfWeek
    };

    let nextExpireAt = originalDoc.expire_at ?? null;
    let nextExpireAtPayload = nextExpireAt;
    if (scheduleChanged || originalDoc.expire_at === undefined) {
      const expireDate = computeActivityExpireAt(nextSchedule);
      nextExpireAt = expireDate;
      nextExpireAtPayload = expireDate ? timestampFromDate(expireDate) : null;
    }

    if (scheduleChanged) {
      editedFields.push('schedule');
    }

    const costChanged =
      Boolean(prevCost.is_free) !== parsedValues.is_free ||
      (prevCost.display_price ?? '') !== parsedValues.display_price;
    if (costChanged) {
      editedFields.push('cost');
    }

    recordIfChanged('demographics.gender', prevDemographics.gender ?? 'all', parsedValues.gender);
    recordIfChanged('demographics.age', prevDemographics.age ?? 'all', parsedValues.age);

    mutableFields = {
      title: parsedValues.title,
      description: parsedValues.description,
      region_id: parsedValues.region_id,
      category: parsedValues.category,
      subcategory: parsedValues.subcategory,
      source_url: parsedValues.source_url,
      verified: parsedValues.verified,
      organizer: {
        id: parsedValues.organizer_id,
        name: parsedValues.organizer_name
      },
      venue: {
        id: parsedValues.venue_id,
        name: parsedValues.venue_name,
        coordinates: { lat: parsedValues.lat, lng: parsedValues.lng },
        geohash: venueGeohash,
        ...(nextVenueGooglePlaceId ? { google_place_id: nextVenueGooglePlaceId } : {})
      },
      schedule: nextSchedule,
      expire_at: nextExpireAtPayload,
      cost: {
        is_free: parsedValues.is_free,
        display_price: parsedValues.display_price
      },
      demographics: {
        gender: parsedValues.gender,
        age: parsedValues.age
      }
    };

    derived = {
      geohash: venueGeohash,
      day_of_week: nextDayOfWeek,
      expire_at: nextExpireAt
    };
  } else {
    recordIfChanged('name', originalDoc.name ?? '', parsedValues.name);
    recordIfChanged('description', originalDoc.description ?? '', parsedValues.description);
    recordIfChanged('address', originalDoc.address ?? '', parsedValues.address);
    recordIfChanged('region_id', originalDoc.region_id ?? 'perth', parsedValues.region_id);
    recordIfChanged('category', originalDoc.category ?? 'sports', parsedValues.category);
    recordIfChanged('subcategory', originalDoc.subcategory ?? 'other', parsedValues.subcategory);
    recordIfChanged(
      'subcategories',
      Array.isArray(originalDoc.subcategories) ? originalDoc.subcategories : [],
      parsedValues.subcategories
    );

    const entityCoordsEdited = coordsChanged(originalDoc.coordinates, parsedValues.lat, parsedValues.lng);
    const geohash = entityCoordsEdited || !originalDoc.geohash
      ? encodeGeohash(parsedValues.lat, parsedValues.lng, 9)
      : originalDoc.geohash;
    if (entityCoordsEdited) {
      editedFields.push('coordinates');
    }

    recordIfChanged('source_url', originalDoc.source_url ?? null, parsedValues.source_url);
    recordIfChanged('verified', Boolean(originalDoc.verified), parsedValues.verified);

    mutableFields = {
      name: parsedValues.name,
      description: parsedValues.description,
      address: parsedValues.address,
      region_id: parsedValues.region_id,
      category: parsedValues.category,
      subcategory: parsedValues.subcategory,
      subcategories: parsedValues.subcategories,
      coordinates: { lat: parsedValues.lat, lng: parsedValues.lng },
      geohash,
      source_url: parsedValues.source_url,
      verified: parsedValues.verified
    };

    if (entityType === 'organizers') {
      const prevContact = originalDoc.contact || {};
      const prevDemographics = originalDoc.demographics || {};

      recordIfChanged('website', originalDoc.website ?? null, parsedValues.website);
      recordIfChanged('contact.email', prevContact.email ?? null, parsedValues.contact_email);
      recordIfChanged('contact.phone', prevContact.phone ?? null, parsedValues.contact_phone);
      recordIfChanged('contact.facebook', prevContact.facebook ?? null, parsedValues.contact_facebook);
      recordIfChanged('cost_description', originalDoc.cost_description ?? '', parsedValues.cost_description);
      recordIfChanged('demographics.gender', prevDemographics.gender ?? 'all', parsedValues.gender);
      recordIfChanged('demographics.age', prevDemographics.age ?? 'all', parsedValues.age);

      mutableFields = {
        ...mutableFields,
        website: parsedValues.website,
        contact: {
          email: parsedValues.contact_email,
          phone: parsedValues.contact_phone,
          facebook: parsedValues.contact_facebook
        },
        cost_description: parsedValues.cost_description,
        demographics: {
          gender: parsedValues.gender,
          age: parsedValues.age
        }
      };
    }

    derived = { geohash };
  }

  const curatedFields = mergeCuratedFields(originalDoc.curated_fields, editedFields);
  const updatePayload = {
    ...mutableFields,
    ...(curatedFields.length > 0 ? { curated_fields: curatedFields } : {}),
    needs_review: false,
    review_reason: null,
    duplicate_candidate_id: deleteField(),
    updated_at: serverTimestamp()
  };

  const nextRawDoc = {
    ...originalDoc,
    ...mutableFields,
    ...(curatedFields.length > 0 ? { curated_fields: curatedFields } : {}),
    ...(entityType === 'activities' ? { expire_at: derived.expire_at } : {}),
    needs_review: false,
    review_reason: null,
    updated_at: nowIso
  };
  delete nextRawDoc.duplicate_candidate_id;

  return {
    updatePayload,
    nextRawDoc,
    editedFields,
    curatedFields,
    derived
  };
}

/**
 * Builds the embedded `venue` snapshot for an Activity from a canonical Venue record.
 *
 * @param {object} venue
 * @returns {{ id: string, name: string, coordinates: { lat: number | null, lng: number | null }, geohash: string, google_place_id?: string }}
 */
export function buildVenueSnapshot(venue = {}) {
  const raw = venue?.raw && typeof venue.raw === 'object' ? venue.raw : venue;
  const id = asString(raw.id || venue.id || venue.docId, '');
  const name = asString(raw.name || venue.name, '');
  const coords = raw.coordinates || venue.coordinates || {};
  const lat = typeof coords.lat === 'number' && Number.isFinite(coords.lat) ? coords.lat : null;
  const lng = typeof coords.lng === 'number' && Number.isFinite(coords.lng) ? coords.lng : null;
  const existingGeohash = asTrimmedString(raw.geohash || venue.geohash);
  const geohash = existingGeohash || (lat !== null && lng !== null ? encodeGeohash(lat, lng, 9) : '');
  const googlePlaceId = asTrimmedOrNull(raw.google_place_id ?? venue.google_place_id);

  return {
    id,
    name,
    coordinates: { lat, lng },
    geohash,
    ...(googlePlaceId ? { google_place_id: googlePlaceId } : {})
  };
}

/**
 * Builds the embedded `organizer` snapshot for an Activity from a canonical Organizer record.
 *
 * @param {object} organizer
 * @returns {{ id: string, name: string }}
 */
export function buildOrganizerSnapshot(organizer = {}) {
  const raw = organizer?.raw && typeof organizer.raw === 'object' ? organizer.raw : organizer;
  return {
    id: asString(raw.id || organizer.id || organizer.docId, ''),
    name: asString(raw.name || organizer.name, '')
  };
}

/**
 * Applies a canonical Venue selection onto an Activity edit draft's form values
 * while preserving all unrelated in-progress fields.
 *
 * @param {object} [values={}]
 * @param {object} [venue={}]
 * @returns {object}
 */
export function applyCanonicalVenueToDraftValues(values = {}, venue = {}) {
  const snapshot = buildVenueSnapshot(venue);
  return {
    ...values,
    venue_id: snapshot.id,
    venue_name: snapshot.name,
    venue_google_place_id: snapshot.google_place_id || '',
    lat: asCoordString(snapshot.coordinates.lat),
    lng: asCoordString(snapshot.coordinates.lng)
  };
}

/**
 * Applies a canonical Organizer selection onto an Activity edit draft's form values
 * while preserving all unrelated in-progress fields.
 *
 * @param {object} [values={}]
 * @param {object} [organizer={}]
 * @returns {object}
 */
export function applyCanonicalOrganizerToDraftValues(values = {}, organizer = {}) {
  const snapshot = buildOrganizerSnapshot(organizer);
  return {
    ...values,
    organizer_id: snapshot.id,
    organizer_name: snapshot.name
  };
}

/**
 * Filters and ranks canonical Venues or Organizers for picker search.
 * Name prefix matches rank first, then other matches, sorted alphabetically.
 *
 * @param {Array<object>} [entities=[]]
 * @param {string} [query='']
 * @param {number} [limit=25]
 * @returns {Array<object>}
 */
export function filterCanonicalEntities(entities = [], query = '', limit = 25) {
  const normalizedQuery = asTrimmedString(query).toLowerCase();
  const maxResults = Number.isInteger(limit) && limit > 0 ? limit : 25;

  const scored = [];
  for (const entity of entities) {
    if (!entity || typeof entity !== 'object') continue;
    const name = asString(entity.name, '');
    const address = asString(entity.address || entity.raw?.address, '');
    const id = asString(entity.id || entity.docId, '');
    const subcategory = asString(entity.subcategory || entity.raw?.subcategory, '');

    if (!normalizedQuery) {
      scored.push({ entity, rank: 1, name });
      continue;
    }

    const nameLower = name.toLowerCase();
    const matches =
      nameLower.includes(normalizedQuery) ||
      address.toLowerCase().includes(normalizedQuery) ||
      id.toLowerCase().includes(normalizedQuery) ||
      subcategory.toLowerCase().includes(normalizedQuery);

    if (matches) {
      const rank = nameLower.startsWith(normalizedQuery) ? 0 : 1;
      scored.push({ entity, rank, name });
    }
  }

  return scored
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, maxResults)
    .map((entry) => entry.entity);
}

/**
 * Builds a batch update payload for linked Activities when a canonical Venue's
 * `name`/`coordinates`/`geohash` or an Organizer's `name` changes.
 * Returns `null` when no cascade is needed.
 *
 * @param {'activities' | 'organizers' | 'venues'} entityType
 * @param {object} [originalDoc={}]
 * @param {object} [nextRawDoc={}]
 * @param {object} [options={}]
 * @returns {{ linkedField: string, entityId: string, activityUpdatePayload: object } | null}
 */
export function buildCascadeActivityUpdate(entityType, originalDoc = {}, nextRawDoc = {}, options = {}) {
  const { serverTimestamp = () => new Date().toISOString() } = options;

  if (entityType === 'venues') {
    const prevName = asString(originalDoc.name, '');
    const nextName = asString(nextRawDoc.name, '');
    const prevCoords = originalDoc.coordinates || {};
    const nextCoords = nextRawDoc.coordinates || {};
    const prevGeohash = asString(originalDoc.geohash, '');
    const nextGeohash = asString(nextRawDoc.geohash, '');

    const snapshotChanged =
      prevName !== nextName ||
      coordsChanged(prevCoords, nextCoords.lat, nextCoords.lng) ||
      prevGeohash !== nextGeohash;

    if (!snapshotChanged) return null;

    const snapshot = buildVenueSnapshot(nextRawDoc);
    return {
      linkedField: 'venue.id',
      entityId: snapshot.id,
      activityUpdatePayload: {
        venue: snapshot,
        updated_at: serverTimestamp()
      }
    };
  }

  if (entityType === 'organizers') {
    const prevName = asString(originalDoc.name, '');
    const nextName = asString(nextRawDoc.name, '');
    if (prevName === nextName) return null;

    const snapshot = buildOrganizerSnapshot(nextRawDoc);
    return {
      linkedField: 'organizer.id',
      entityId: snapshot.id,
      activityUpdatePayload: {
        organizer: snapshot,
        updated_at: serverTimestamp()
      }
    };
  }

  return null;
}
