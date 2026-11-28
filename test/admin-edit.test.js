import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeGeohash } from '../public/shared/geohash.js';
import {
  IMMUTABLE_FIELDS,
  createEditDraft,
  parseEditFormValues,
  buildListingSavePayload,
  buildVenueSnapshot,
  buildOrganizerSnapshot,
  applyCanonicalVenueToDraftValues,
  applyCanonicalOrganizerToDraftValues,
  filterCanonicalEntities,
  buildCascadeActivityUpdate
} from '../public/js/admin-edit.js';

const baseActivityDoc = {
  id: 'eventbrite_100',
  region_id: 'perth',
  source: 'eventbrite',
  source_id: '100',
  source_url: 'https://eventbrite.com.au/e/100',
  verified: true,
  title: 'Twilight Social Soccer',
  description: 'Friendly 5-a-side games',
  category: 'sports',
  subcategory: 'soccer',
  organizer: { id: 'org_perth_fc', name: 'Perth Social FC' },
  venue: {
    id: 'venue_langley_qd66hr',
    name: 'Langley Park',
    coordinates: { lat: -31.9598, lng: 115.8693 },
    geohash: encodeGeohash(-31.9598, 115.8693, 9)
  },
  schedule: {
    start_date: '2026-12-01',
    end_date: '2026-12-01',
    start_time: '18:00',
    end_time: '19:30',
    recurrence: 'none',
    day_of_week: 2
  },
  expire_at: new Date('2026-12-02T16:00:00.000Z'),
  cost: { is_free: false, display_price: '$15' },
  demographics: { gender: 'all', age: 'adults' },
  needs_review: true,
  review_reason: 'unmatched_venue',
  duplicate_candidate_id: 'meetup_99',
  curated_fields: ['description'],
  created_at: '2026-11-20T00:00:00.000Z',
  updated_at: '2026-11-21T00:00:00.000Z'
};

test('createEditDraft serializes Activity, Organizer, and Venue fields and preserves read-only metadata', () => {
  const activityDraft = createEditDraft('activities', { raw: baseActivityDoc });
  assert.equal(activityDraft.readOnly.id, 'eventbrite_100');
  assert.equal(activityDraft.readOnly.source, 'eventbrite');
  assert.equal(activityDraft.readOnly.source_id, '100');
  assert.equal(activityDraft.readOnly.created_at, '2026-11-20T00:00:00.000Z');
  assert.equal(activityDraft.values.title, 'Twilight Social Soccer');
  assert.equal(activityDraft.values.lat, '-31.9598');
  assert.equal(activityDraft.values.lng, '115.8693');
  assert.equal(activityDraft.values.verified, true);
  assert.equal(activityDraft.values.is_free, false);

  const orgDoc = {
    id: 'org_perth_fc',
    region_id: 'perth',
    source: 'google_places',
    source_id: 'ChIJ_org',
    name: 'Perth Social FC',
    description: 'Community club',
    address: '100 Riverside Dr, Perth',
    coordinates: { lat: -31.955, lng: 115.86 },
    geohash: encodeGeohash(-31.955, 115.86, 9),
    category: 'sports',
    subcategory: 'soccer',
    subcategories: ['soccer', 'futsal'],
    website: 'https://perthsocialfc.org.au',
    contact: { email: 'hi@perthsocialfc.org.au', phone: '0400 000 000', facebook: null },
    cost_description: '$15/week',
    demographics: { gender: 'all', age: 'adults' },
    source_url: 'https://perthsocialfc.org.au',
    verified: true,
    created_at: '2026-11-01T00:00:00.000Z'
  };
  const orgDraft = createEditDraft('organizers', { raw: orgDoc });
  assert.equal(orgDraft.readOnly.id, 'org_perth_fc');
  assert.equal(orgDraft.values.subcategories, 'soccer, futsal');
  assert.equal(orgDraft.values.contact_email, 'hi@perthsocialfc.org.au');

  const venueDoc = {
    id: 'venue_langley_qd66hr',
    region_id: 'perth',
    name: 'Langley Park',
    description: 'Foreshore oval',
    address: 'Riverside Dr, Perth WA 6000',
    coordinates: { lat: -31.9598, lng: 115.8693 },
    geohash: encodeGeohash(-31.9598, 115.8693, 9),
    category: 'sports',
    subcategory: 'soccer',
    subcategories: ['soccer'],
    source_url: null,
    verified: false,
    created_at: '2026-11-01T00:00:00.000Z'
  };
  const venueDraft = createEditDraft('venues', { raw: venueDoc });
  assert.equal(venueDraft.readOnly.id, 'venue_langley_qd66hr');
  assert.equal(venueDraft.values.address, 'Riverside Dr, Perth WA 6000');
  assert.equal(venueDraft.values.verified, false);
});

test('parseEditFormValues validates inputs and enforces source_url -> verified coupling', () => {
  // Clearing source_url forces verified: false even if checkbox was checked
  const clearedUrl = parseEditFormValues('venues', {
    name: 'Langley Park',
    description: '',
    address: 'Riverside Dr',
    region_id: 'perth',
    category: 'sports',
    subcategory: 'soccer',
    subcategories: 'soccer, cricket',
    lat: '-31.9598',
    lng: '115.8693',
    source_url: '   ',
    verified: true
  });
  assert.deepEqual(clearedUrl.errors, {});
  assert.equal(clearedUrl.values.source_url, null);
  assert.equal(clearedUrl.values.verified, false);
  assert.deepEqual(clearedUrl.values.subcategories, ['soccer', 'cricket']);

  // Valid http(s) URL allows toggling verified
  const validUrl = parseEditFormValues('venues', {
    name: 'Langley Park',
    lat: '-31.9598',
    lng: '115.8693',
    source_url: 'https://perth.wa.gov.au/langley',
    verified: true
  });
  assert.deepEqual(validUrl.errors, {});
  assert.equal(validUrl.values.source_url, 'https://perth.wa.gov.au/langley');
  assert.equal(validUrl.values.verified, true);

  // Invalid values produce field errors
  const invalid = parseEditFormValues('activities', {
    title: '  ',
    lat: '95',
    lng: 'abc',
    source_url: 'javascript:alert(1)',
    verified: true,
    start_date: '2026-02-30',
    start_time: '25:99'
  });
  assert.ok(invalid.errors.title);
  assert.ok(invalid.errors.lat);
  assert.ok(invalid.errors.lng);
  assert.ok(invalid.errors.source_url);
  assert.ok(invalid.errors.start_date);
  assert.ok(invalid.errors.start_time);
  assert.equal(invalid.values.verified, false);
});

test('buildListingSavePayload diffs curated_fields, excludes immutable fields, recomputes derived fields, and auto-approves', () => {
  const serverTimestampToken = { __type: 'serverTimestamp' };
  const deleteFieldToken = { __type: 'deleteField' };
  const timestampFromDate = (d) => ({ __type: 'Timestamp', iso: d.toISOString() });

  const parsed = parseEditFormValues('activities', {
    title: 'Twilight Social Soccer (Edited)',
    description: baseActivityDoc.description,
    region_id: 'perth',
    category: 'sports',
    subcategory: 'soccer',
    source_url: '',
    verified: true,
    organizer_id: 'org_perth_fc',
    organizer_name: 'Perth Social FC',
    venue_id: 'venue_langley_qd66hr',
    venue_name: 'Langley Park',
    lat: '-31.9505',
    lng: '115.8605',
    recurrence: 'none',
    start_date: '2026-12-05', // Saturday -> day_of_week 6
    end_date: '2026-12-05',
    start_time: '18:00',
    end_time: '19:30',
    day_of_week: '2',
    is_free: false,
    display_price: '$15',
    gender: 'all',
    age: 'adults'
  });
  assert.deepEqual(parsed.errors, {});

  const result = buildListingSavePayload('activities', baseActivityDoc, parsed.values, {
    timestampFromDate,
    serverTimestamp: () => serverTimestampToken,
    deleteField: () => deleteFieldToken
  });

  // Immutable fields never in updatePayload
  for (const immutable of IMMUTABLE_FIELDS) {
    assert.equal(Object.hasOwn(result.updatePayload, immutable), false);
  }

  // Auto-approve fields
  assert.equal(result.updatePayload.needs_review, false);
  assert.equal(result.updatePayload.review_reason, null);
  assert.deepEqual(result.updatePayload.duplicate_candidate_id, deleteFieldToken);
  assert.deepEqual(result.updatePayload.updated_at, serverTimestampToken);

  // source_url cleared -> verified forced false
  assert.equal(result.updatePayload.source_url, null);
  assert.equal(result.updatePayload.verified, false);

  // Derived geohash recomputed on coordinate change
  const expectedGeohash = encodeGeohash(-31.9505, 115.8605, 9);
  assert.equal(result.updatePayload.venue.geohash, expectedGeohash);

  // Derived day_of_week and expire_at recomputed on schedule change
  assert.equal(result.updatePayload.schedule.day_of_week, 6);
  assert.deepEqual(result.updatePayload.expire_at, {
    __type: 'Timestamp',
    iso: '2026-12-06T16:00:00.000Z'
  });

  // curated_fields preserves existing ('description') and appends only modified fields
  assert.deepEqual(result.curatedFields, [
    'description',
    'title',
    'source_url',
    'verified',
    'venue.coordinates',
    'venue.geohash',
    'schedule'
  ]);
  assert.deepEqual(result.updatePayload.curated_fields, result.curatedFields);
});

test('buildListingSavePayload recomputes top-level geohash for Venue/Organizer coordinate edits and handles perpetual weekly Activity', () => {
  const venueDoc = {
    id: 'venue_1',
    name: 'Beatty Park',
    description: '',
    address: '220 Vincent St',
    region_id: 'perth',
    category: 'sports',
    subcategory: 'other',
    subcategories: ['other'],
    coordinates: { lat: -31.937, lng: 115.85 },
    geohash: encodeGeohash(-31.937, 115.85, 9),
    source_url: null,
    verified: false,
    needs_review: true,
    review_reason: 'crawler_created',
    curated_fields: ['name']
  };

  const parsedVenue = parseEditFormValues('venues', {
    name: 'Beatty Park',
    description: '',
    address: '220 Vincent St',
    region_id: 'perth',
    category: 'sports',
    subcategory: 'other',
    subcategories: 'other',
    lat: '-31.938',
    lng: '115.851',
    source_url: '',
    verified: false
  });

  const venueSave = buildListingSavePayload('venues', venueDoc, parsedVenue.values);
  assert.equal(venueSave.updatePayload.geohash, encodeGeohash(-31.938, 115.851, 9));
  assert.deepEqual(venueSave.curatedFields, ['name', 'coordinates']);
  assert.equal(venueSave.updatePayload.needs_review, false);

  // Perpetual weekly activity -> expire_at is null
  const weeklyParsed = parseEditFormValues('activities', {
    title: baseActivityDoc.title,
    description: baseActivityDoc.description,
    region_id: 'perth',
    category: 'sports',
    subcategory: 'soccer',
    source_url: baseActivityDoc.source_url,
    verified: true,
    organizer_id: 'org_perth_fc',
    organizer_name: 'Perth Social FC',
    venue_id: 'venue_langley_qd66hr',
    venue_name: 'Langley Park',
    lat: '-31.9598',
    lng: '115.8693',
    recurrence: 'weekly',
    start_date: '2026-12-01',
    end_date: '',
    start_time: '18:00',
    end_time: '19:30',
    day_of_week: '4',
    is_free: false,
    display_price: '$15',
    gender: 'all',
    age: 'adults'
  });

  const weeklySave = buildListingSavePayload('activities', baseActivityDoc, weeklyParsed.values);
  assert.equal(weeklySave.updatePayload.schedule.recurrence, 'weekly');
  assert.equal(weeklySave.updatePayload.schedule.day_of_week, 4);
  assert.equal(weeklySave.updatePayload.expire_at, null);
});

test('buildVenueSnapshot and buildOrganizerSnapshot construct embedded Activity snapshots', () => {
  const venueWithPlace = {
    id: 'venue_loftus_qd66hx',
    name: 'Loftus Recreation Centre',
    coordinates: { lat: -31.9369, lng: 115.8473 },
    google_place_id: '  ChIJ_loftus_123  '
  };
  const snapWithPlace = buildVenueSnapshot(venueWithPlace);
  assert.deepEqual(snapWithPlace, {
    id: 'venue_loftus_qd66hx',
    name: 'Loftus Recreation Centre',
    coordinates: { lat: -31.9369, lng: 115.8473 },
    geohash: encodeGeohash(-31.9369, 115.8473, 9),
    google_place_id: 'ChIJ_loftus_123'
  });

  const venueWithoutPlace = {
    docId: 'venue_langley_qd66hr',
    name: 'Langley Park',
    raw: {
      coordinates: { lat: -31.9598, lng: 115.8693 },
      geohash: 'qd66hr999',
      google_place_id: ''
    }
  };
  const snapWithoutPlace = buildVenueSnapshot(venueWithoutPlace);
  assert.deepEqual(snapWithoutPlace, {
    id: 'venue_langley_qd66hr',
    name: 'Langley Park',
    coordinates: { lat: -31.9598, lng: 115.8693 },
    geohash: 'qd66hr999'
  });
  assert.equal(Object.hasOwn(snapWithoutPlace, 'google_place_id'), false);

  assert.deepEqual(
    buildOrganizerSnapshot({ id: 'org_perth_fc', name: 'Perth Social FC' }),
    { id: 'org_perth_fc', name: 'Perth Social FC' }
  );
});

test('applyCanonicalVenueToDraftValues and applyCanonicalOrganizerToDraftValues update only linked fields', () => {
  const baseValues = {
    title: 'Edited Activity Title',
    description: 'Keep me',
    venue_id: 'old_v',
    venue_name: 'Old Venue',
    venue_google_place_id: 'ChIJ_old',
    lat: '-31.90',
    lng: '115.80',
    organizer_id: 'old_o',
    organizer_name: 'Old Org'
  };

  const afterVenue = applyCanonicalVenueToDraftValues(baseValues, {
    id: 'venue_beatty',
    name: 'Beatty Park',
    raw: {
      coordinates: { lat: -31.937, lng: 115.85 },
      google_place_id: 'ChIJ_beatty'
    }
  });
  assert.equal(afterVenue.title, 'Edited Activity Title');
  assert.equal(afterVenue.description, 'Keep me');
  assert.equal(afterVenue.venue_id, 'venue_beatty');
  assert.equal(afterVenue.venue_name, 'Beatty Park');
  assert.equal(afterVenue.lat, '-31.937');
  assert.equal(afterVenue.lng, '115.85');
  assert.equal(afterVenue.venue_google_place_id, 'ChIJ_beatty');

  const afterVenueNoPlace = applyCanonicalVenueToDraftValues(afterVenue, {
    id: 'venue_park',
    name: 'Local Park',
    coordinates: { lat: -31.94, lng: 115.86 }
  });
  assert.equal(afterVenueNoPlace.venue_google_place_id, '');

  const afterOrg = applyCanonicalOrganizerToDraftValues(afterVenueNoPlace, {
    id: 'org_new',
    name: 'Swan River Runners'
  });
  assert.equal(afterOrg.title, 'Edited Activity Title');
  assert.equal(afterOrg.venue_id, 'venue_park');
  assert.equal(afterOrg.organizer_id, 'org_new');
  assert.equal(afterOrg.organizer_name, 'Swan River Runners');
});

test('filterCanonicalEntities matches name/address/id/subcategory, ranks name prefixes first, and caps limit', () => {
  const entities = [
    { id: 'venue_1', name: 'Subiaco Oval', address: 'Subiaco Rd', subcategory: 'football' },
    { id: 'venue_2', name: 'Perth Hockey Stadium', address: 'Bentley', subcategory: 'hockey' },
    { id: 'venue_3', name: 'North Perth Tennis Club', address: 'Vincent St', subcategory: 'tennis' },
    { id: 'venue_4', name: 'Perth Arena', address: 'Wellington St', subcategory: 'basketball' }
  ];

  const perthResults = filterCanonicalEntities(entities, 'perth', 10);
  assert.deepEqual(
    perthResults.map((e) => e.id),
    ['venue_4', 'venue_2', 'venue_3']
  );

  assert.deepEqual(
    filterCanonicalEntities(entities, 'hockey', 10).map((e) => e.id),
    ['venue_2']
  );

  assert.deepEqual(
    filterCanonicalEntities(entities, 'venue_1', 10).map((e) => e.id),
    ['venue_1']
  );

  assert.equal(filterCanonicalEntities(entities, '', 2).length, 2);
});

test('Activity draft/parse/save handles venue.google_place_id preservation, update, and omission', () => {
  const activityWithPlace = {
    ...baseActivityDoc,
    venue: {
      ...baseActivityDoc.venue,
      google_place_id: 'ChIJ_langley_1'
    }
  };
  const draft = createEditDraft('activities', { raw: activityWithPlace });
  assert.equal(draft.values.venue_google_place_id, 'ChIJ_langley_1');

  // When venue_google_place_id is omitted from formValues and venue_id is unchanged, preserve existing
  const parsedPreserved = parseEditFormValues('activities', {
    title: activityWithPlace.title,
    description: activityWithPlace.description,
    region_id: 'perth',
    category: 'sports',
    subcategory: 'soccer',
    source_url: activityWithPlace.source_url,
    verified: true,
    organizer_id: 'org_perth_fc',
    organizer_name: 'Perth Social FC',
    venue_id: 'venue_langley_qd66hr',
    venue_name: 'Langley Park',
    lat: '-31.9598',
    lng: '115.8693',
    recurrence: 'none',
    start_date: '2026-12-01',
    end_date: '2026-12-01',
    start_time: '18:00',
    end_time: '19:30',
    day_of_week: '2',
    is_free: false,
    display_price: '$15',
    gender: 'all',
    age: 'adults'
  });
  assert.equal(parsedPreserved.values.venue_google_place_id, undefined);
  const savePreserved = buildListingSavePayload('activities', activityWithPlace, parsedPreserved.values);
  assert.equal(savePreserved.updatePayload.venue.google_place_id, 'ChIJ_langley_1');
  assert.deepEqual(savePreserved.curatedFields, ['description']);

  // When venue_google_place_id is explicitly updated
  const parsedUpdated = parseEditFormValues('activities', {
    ...draft.values,
    venue_id: 'venue_new',
    venue_name: 'New Venue',
    venue_google_place_id: 'ChIJ_new_place'
  });
  const saveUpdated = buildListingSavePayload('activities', activityWithPlace, parsedUpdated.values);
  assert.equal(saveUpdated.updatePayload.venue.google_place_id, 'ChIJ_new_place');
  assert.equal(saveUpdated.curatedFields.includes('venue.google_place_id'), true);

  // When venue_google_place_id is cleared, omit from venue snapshot
  const parsedCleared = parseEditFormValues('activities', {
    ...draft.values,
    venue_google_place_id: ''
  });
  const saveCleared = buildListingSavePayload('activities', activityWithPlace, parsedCleared.values);
  assert.equal(Object.hasOwn(saveCleared.updatePayload.venue, 'google_place_id'), false);
  assert.equal(saveCleared.curatedFields.includes('venue.google_place_id'), true);
});

test('buildCascadeActivityUpdate builds cascade payload only when Venue/Organizer snapshot fields change', () => {
  const serverTimestampToken = { __type: 'serverTimestamp' };
  const originalVenue = {
    id: 'venue_1',
    name: 'Beatty Park',
    description: 'Old desc',
    coordinates: { lat: -31.937, lng: 115.85 },
    geohash: encodeGeohash(-31.937, 115.85, 9),
    google_place_id: 'ChIJ_beatty'
  };

  // Activity never cascades
  assert.equal(
    buildCascadeActivityUpdate('activities', baseActivityDoc, baseActivityDoc, {
      serverTimestamp: () => serverTimestampToken
    }),
    null
  );

  // Venue non-snapshot edit -> null
  assert.equal(
    buildCascadeActivityUpdate('venues', originalVenue, {
      ...originalVenue,
      description: 'New desc'
    }),
    null
  );

  // Venue name/coordinate edit -> cascade payload
  const newCoords = { lat: -31.938, lng: 115.851 };
  const newGeohash = encodeGeohash(newCoords.lat, newCoords.lng, 9);
  const venueCascade = buildCascadeActivityUpdate(
    'venues',
    originalVenue,
    {
      ...originalVenue,
      name: 'Beatty Park Leisure Centre',
      coordinates: newCoords,
      geohash: newGeohash
    },
    { serverTimestamp: () => serverTimestampToken }
  );
  assert.deepEqual(venueCascade, {
    linkedField: 'venue.id',
    entityId: 'venue_1',
    activityUpdatePayload: {
      venue: {
        id: 'venue_1',
        name: 'Beatty Park Leisure Centre',
        coordinates: newCoords,
        geohash: newGeohash,
        google_place_id: 'ChIJ_beatty'
      },
      updated_at: serverTimestampToken
    }
  });

  // Organizer non-name edit -> null
  const originalOrg = { id: 'org_1', name: 'Perth FC', description: 'Old' };
  assert.equal(
    buildCascadeActivityUpdate('organizers', originalOrg, { ...originalOrg, description: 'New' }),
    null
  );

  // Organizer name edit -> cascade payload
  const orgCascade = buildCascadeActivityUpdate(
    'organizers',
    originalOrg,
    { ...originalOrg, name: 'Perth Social FC' },
    { serverTimestamp: () => serverTimestampToken }
  );
  assert.deepEqual(orgCascade, {
    linkedField: 'organizer.id',
    entityId: 'org_1',
    activityUpdatePayload: {
      organizer: { id: 'org_1', name: 'Perth Social FC' },
      updated_at: serverTimestampToken
    }
  });
});
