import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeActivity,
  sanitizeOrganizer,
  sanitizeVenue,
  sanitizeListing,
  resolveListingType,
  normalizeSport,
  normalizeSubcategories,
  extractCanonicalEntities,
  mergeActivityDocuments,
  mergeEntityDocuments
} from '../src/sanitizer.js';

test('Seam 1: normalizeSport maps various sport aliases to canonical MVP taxonomy', () => {
  assert.equal(normalizeSport('Football (Soccer)'), 'soccer');
  assert.equal(normalizeSport('Futsal'), 'soccer');
  assert.equal(normalizeSport('Beach Volleyball'), 'volleyball');
  assert.equal(normalizeSport('Volleyball'), 'volleyball');
  assert.equal(normalizeSport('Hoops / Basketball'), 'basketball');
  assert.equal(normalizeSport('AFL 9s'), 'afl');
  assert.equal(normalizeSport('Tennis Socials'), 'tennis');
  assert.equal(normalizeSport('Pickleball Open Play'), 'pickleball');
  assert.equal(normalizeSport('Social Run Club'), 'running');
  assert.equal(normalizeSport('Outdoor Bootcamp & Fitness'), 'social-fitness');
  assert.equal(normalizeSport('Community Walking Group'), 'walking');
  assert.equal(normalizeSport('Super 8s Cricket'), 'cricket');
  assert.equal(normalizeSport('Underwater Hockey'), 'other');
});

test('Seam 1: sanitizeActivity produces a valid canonical ActivityDocument with precision-9 geohash', () => {
  const rawInput = {
    source: 'stirling',
    source_id: 'event-1092',
    title: '  Scarborough Sunset Beach Volleyball  ',
    description: 'Weekly sunset social volleyball match on the beach.',
    sport: 'Beach Volleyball',
    venue_name: 'Scarborough Beach Amphitheatre',
    address: 'The Esplanade, Scarborough WA 6019',
    coordinates: { lat: -31.8942, lng: 115.7571 },
    start_time: '2026-11-12T17:30:00+08:00',
    end_time: '2026-11-12T19:30:00+08:00',
    recurrence: 'weekly',
    cost_description: 'Free',
    external_url: 'https://www.stirling.wa.gov.au/events/volleyball-1092',
    club_name: 'Scarborough Beach Sports Club',
    website: 'https://scarboroughbeachsports.com.au',
    demographics: { gender: 'all', age: 'adults' }
  };

  const activity = sanitizeActivity(rawInput);

  assert.equal(activity.id, 'stirling_event-1092');
  assert.equal(activity.region_id, 'perth');
  assert.equal(activity.source, 'stirling');
  assert.equal(activity.source_id, 'event-1092');
  assert.equal(activity.source_url, 'https://www.stirling.wa.gov.au/events/volleyball-1092');
  assert.equal(activity.title, 'Scarborough Sunset Beach Volleyball');
  assert.equal(activity.description, 'Weekly sunset social volleyball match on the beach.');
  assert.equal(activity.category, 'sports');
  assert.equal(activity.subcategory, 'volleyball');

  // Embedded venue snapshot
  assert.equal(activity.venue.id, 'venue_scarborough_beach_amphitheatre_qd66d1');
  assert.equal(activity.venue.name, 'Scarborough Beach Amphitheatre');
  assert.equal(activity.venue.coordinates.lat, -31.8942);
  assert.equal(activity.venue.coordinates.lng, 115.7571);
  assert.equal(activity.venue.geohash.length, 9);
  assert.equal(activity.venue.address, undefined); // address not in embedded snapshot

  // Embedded organizer snapshot
  assert.equal(activity.organizer.id, 'org_scarborough_beach_sports_club');
  assert.equal(activity.organizer.name, 'Scarborough Beach Sports Club');

  // Structured schedule
  assert.equal(activity.schedule.start_date, '2026-11-12');
  assert.equal(activity.schedule.end_date, null);
  assert.equal(activity.schedule.start_time, '17:30');
  assert.equal(activity.schedule.end_time, '19:30');
  assert.equal(activity.schedule.recurrence, 'weekly');
  assert.equal(activity.schedule.day_of_week, 4); // Thursday

  // Cost
  assert.equal(activity.cost.is_free, true);
  assert.equal(activity.cost.display_price, 'Free');

  // Demographics
  assert.deepEqual(activity.demographics, { gender: 'all', age: 'adults' });
  assert.equal(activity.verified, true);
  assert.ok(activity.updated_at);
  assert.ok(activity.created_at);

  // Canonical entity extraction for dedicated collections
  const entities = extractCanonicalEntities(activity, rawInput);
  assert.equal(entities.venue.id, 'venue_scarborough_beach_amphitheatre_qd66d1');
  assert.equal(entities.venue.name, 'Scarborough Beach Amphitheatre');
  assert.equal(entities.venue.address, 'The Esplanade, Scarborough WA 6019');
  assert.equal(entities.venue.region_id, 'perth');
  assert.equal(entities.venue.geohash.length, 9);

  assert.equal(entities.organizer.id, 'org_scarborough_beach_sports_club');
  assert.equal(entities.organizer.name, 'Scarborough Beach Sports Club');
  assert.equal(entities.organizer.website, 'https://scarboroughbeachsports.com.au');
  assert.deepEqual(entities.organizer.contact, { email: null, phone: null, facebook: null });

  assert.equal(entities.region.id, 'perth');
  assert.equal(entities.region.name, 'Greater Perth');
});

test('Seam 1: sanitizeActivity infers free status and defaults missing optional attributes', () => {
  const minimalInput = {
    source: 'dlgsc',
    source_id: 'club-456',
    title: 'North Perth Social Futsal',
    sport: 'futsal',
    venue_name: 'North Perth Bowling & Rec Club',
    coordinates: { lat: -31.9366, lng: 115.8431 },
    start_time: '2026-11-10T18:00:00Z',
    cost_description: '$10 per player',
    external_url: 'https://example.com/futsal'
  };

  const activity = sanitizeActivity(minimalInput);

  assert.equal(activity.region_id, 'perth');
  assert.equal(activity.category, 'sports');
  assert.equal(activity.subcategory, 'soccer');
  assert.equal(activity.cost.is_free, false);
  assert.equal(activity.cost.display_price, '$10 per player');
  assert.deepEqual(activity.demographics, { gender: 'all', age: 'all' });
  assert.equal(activity.organizer.name, 'North Perth Social Futsal');
  assert.equal(activity.organizer.id, 'org_north_perth_social_futsal');
  assert.ok(activity.venue.geohash.startsWith('qd66'));
  assert.ok(activity.venue.id.startsWith('venue_north_perth_bowling_rec_club_'));
});

test('Seam 1: sanitizeActivity maps demographics gender variations properly', () => {
  const womenInput = {
    source: 'mock',
    source_id: '1',
    title: 'Women Tennis',
    coordinates: { lat: -31.9, lng: 115.8 },
    demographics: { gender: 'women', age: 'adults' }
  };
  const menInput = {
    source: 'mock',
    source_id: '2',
    title: 'Men Basketball',
    coordinates: { lat: -31.9, lng: 115.8 },
    demographics: { gender: 'men_only', age: 'adults' }
  };
  const mixedInput = {
    source: 'mock',
    source_id: '3',
    title: 'Mixed AFL',
    coordinates: { lat: -31.9, lng: 115.8 },
    demographics: { gender: 'mixed', age: 'all' }
  };

  assert.equal(sanitizeActivity(womenInput).demographics.gender, 'women_only');
  assert.equal(sanitizeActivity(menInput).demographics.gender, 'men_only');
  assert.equal(sanitizeActivity(mixedInput).demographics.gender, 'all');
});

test('Seam 1: sanitizeActivity throws SanitizationError on invalid or missing required fields', () => {
  // Missing title
  assert.throws(() => sanitizeActivity({
    source: 'stirling',
    source_id: '123',
    coordinates: { lat: -31.9, lng: 115.8 }
  }), /Missing required field: title/);

  // Missing coordinates
  assert.throws(() => sanitizeActivity({
    source: 'stirling',
    source_id: '123',
    title: 'Casual Tennis'
  }), /Missing valid coordinates/);

  // Missing source or source_id
  assert.throws(() => sanitizeActivity({
    title: 'Casual Tennis',
    coordinates: { lat: -31.9, lng: 115.8 }
  }), /Missing required source identity/);
});

test('Seam 1: sanitizeActivity and extractCanonicalEntities handle Unverified Listings and preserve raw_source_url', () => {
  // 1. Explicitly unverified listing with a broken external_url
  const unverifiedRaw = {
    source: 'meetup',
    source_id: 'broken-99',
    title: 'Subiaco Social Basketball',
    sport: 'basketball',
    venue_name: 'Lords Recreation Centre',
    coordinates: { lat: -31.9445, lng: 115.8241 },
    external_url: 'https://www.meetup.com/perth-hoops/events/broken-99/',
    verified: false
  };

  const unverifiedActivity = sanitizeActivity(unverifiedRaw);
  assert.equal(unverifiedActivity.verified, false);
  assert.equal(unverifiedActivity.source_url, null);
  assert.equal(unverifiedActivity.raw_source_url, 'https://www.meetup.com/perth-hoops/events/broken-99/');

  const unverifiedEntities = extractCanonicalEntities(unverifiedActivity, unverifiedRaw);
  assert.equal(unverifiedEntities.organizer.website, null, 'Should not use broken external_url as organizer website fallback');

  // 2. Listing with missing/empty referral link degrades to unverified
  const missingUrlRaw = {
    source: 'dlgsc',
    source_id: 'no-url-10',
    title: 'Fremantle Community Walkers',
    sport: 'walking',
    venue_name: 'Esplanade Reserve',
    coordinates: { lat: -32.0569, lng: 115.7439 }
  };

  const missingUrlActivity = sanitizeActivity(missingUrlRaw);
  assert.equal(missingUrlActivity.verified, false);
  assert.equal(missingUrlActivity.source_url, null);
  assert.equal(missingUrlActivity.raw_source_url, null);

  // 3. Verified listing preserves both source_url and raw_source_url
  const verifiedRaw = {
    source: 'stirling',
    source_id: 'ok-200',
    title: 'Stirling Social Tennis',
    sport: 'tennis',
    coordinates: { lat: -31.88, lng: 115.80 },
    source_url: 'https://stirling.wa.gov.au/tennis',
    raw_source_url: 'http://stirling.wa.gov.au/tennis'
  };

  const verifiedActivity = sanitizeActivity(verifiedRaw);
  assert.equal(verifiedActivity.verified, true);
  assert.equal(verifiedActivity.source_url, 'https://stirling.wa.gov.au/tennis');
  assert.equal(verifiedActivity.raw_source_url, 'http://stirling.wa.gov.au/tennis');
  assert.equal(verifiedActivity.schedule.start_date, null, 'Undated listing must not default start_date to crawl execution date');
  assert.equal(verifiedActivity.schedule.start_time, null);
  assert.equal(verifiedActivity.schedule.day_of_week, null);
});

test('Seam 1: normalizeSubcategories deduplicates normalized sport slugs and drops fallback other when concrete sports exist', () => {
  assert.deepEqual(
    normalizeSubcategories({ subcategories: ['Beach Volleyball', 'volleyball', 'Basketball'] }),
    ['volleyball', 'basketball']
  );
  assert.deepEqual(
    normalizeSubcategories({ sports: 'Futsal, Tennis Socials; Other' }),
    ['soccer', 'tennis']
  );
  assert.deepEqual(
    normalizeSubcategories({ sport: 'Underwater Hockey' }),
    ['other']
  );
  assert.deepEqual(
    normalizeSubcategories({}, 'pickleball'),
    ['pickleball']
  );
});

test('Seam 1: sanitizeOrganizer produces canonical Organizer Listing with geohash, subcategories, contact, and verification', () => {
  const organizer = sanitizeOrganizer({
    source: 'dlgsc',
    source_id: 'club-77',
    name: '  Perth Coastal Sports Club  ',
    description: 'Community club offering volleyball and basketball.',
    address: '12 Ocean Dr, Scarborough WA 6019',
    coordinates: { lat: -31.8942, lng: 115.7571 },
    sports: ['Beach Volleyball', 'Hoops / Basketball'],
    website: 'https://perthcoastal.org.au',
    contact: { email: 'info@perthcoastal.org.au', phone: '08 9000 1111' },
    cost_description: 'KidSport eligible',
    demographics: { gender: 'women', age: 'juniors' },
    source_url: 'https://perthcoastal.org.au/join',
    raw_source_url: 'http://perthcoastal.org.au/join'
  });

  assert.equal(organizer.id, 'org_perth_coastal_sports_club');
  assert.equal(organizer.region_id, 'perth');
  assert.equal(organizer.name, 'Perth Coastal Sports Club');
  assert.equal(organizer.description, 'Community club offering volleyball and basketball.');
  assert.equal(organizer.address, '12 Ocean Dr, Scarborough WA 6019');
  assert.deepEqual(organizer.coordinates, { lat: -31.8942, lng: 115.7571 });
  assert.equal(organizer.geohash.length, 9);
  assert.equal(organizer.category, 'sports');
  assert.equal(organizer.subcategory, 'volleyball');
  assert.deepEqual(organizer.subcategories, ['volleyball', 'basketball']);
  assert.equal(organizer.website, 'https://perthcoastal.org.au');
  assert.deepEqual(organizer.contact, { email: 'info@perthcoastal.org.au', phone: '08 9000 1111', facebook: null });
  assert.equal(organizer.cost_description, 'KidSport eligible');
  assert.deepEqual(organizer.demographics, { gender: 'women_only', age: 'juniors' });
  assert.equal(organizer.source_url, 'https://perthcoastal.org.au/join');
  assert.equal(organizer.raw_source_url, 'http://perthcoastal.org.au/join');
  assert.equal(organizer.verified, true);
  assert.ok(organizer.updated_at);

  // Unverified organizer degrades source_url while preserving raw_source_url
  const unverifiedOrg = sanitizeOrganizer({
    id: 'org_broken_club',
    name: 'Broken Club',
    coordinates: { lat: -31.95, lng: 115.86 },
    raw_source_url: 'https://broken-club.example',
    verified: false
  });
  assert.equal(unverifiedOrg.id, 'org_broken_club');
  assert.equal(unverifiedOrg.verified, false);
  assert.equal(unverifiedOrg.source_url, null);
  assert.equal(unverifiedOrg.raw_source_url, 'https://broken-club.example');
});

test('Seam 1: sanitizeOrganizer throws SanitizationError on missing identity, name, or coordinates', () => {
  assert.throws(() => sanitizeOrganizer({
    name: 'No Identity Club',
    coordinates: { lat: -31.95, lng: 115.86 }
  }), /Missing required source identity/);

  assert.throws(() => sanitizeOrganizer({
    source: 'dlgsc',
    source_id: '123',
    coordinates: { lat: -31.95, lng: 115.86 }
  }), /Missing required field: name/);

  assert.throws(() => sanitizeOrganizer({
    source: 'dlgsc',
    source_id: '123',
    name: 'No Coords Club'
  }), /Missing valid coordinates/);
});

test('Seam 1: sanitizeVenue produces canonical Venue Listing with deterministic id, geohash, subcategories, and verification', () => {
  const venue = sanitizeVenue({
    source: 'volleyball_wa',
    source_id: 'v-55',
    name: '  Loftus Recreation Centre  ',
    description: 'Indoor court venue in Leederville.',
    address: '99 Loftus St, Leederville WA 6007',
    coordinates: { lat: -31.9366, lng: 115.8431 },
    subcategories: ['Volleyball', 'Futsal', 'Basketball'],
    source_url: 'https://loftus.example.com.au',
    raw_source_url: 'http://loftus.example.com.au'
  });

  assert.ok(venue.id.startsWith('venue_loftus_recreation_centre_'));
  assert.equal(venue.id.length, 'venue_loftus_recreation_centre_'.length + 6);
  assert.equal(venue.region_id, 'perth');
  assert.equal(venue.name, 'Loftus Recreation Centre');
  assert.equal(venue.description, 'Indoor court venue in Leederville.');
  assert.equal(venue.address, '99 Loftus St, Leederville WA 6007');
  assert.deepEqual(venue.coordinates, { lat: -31.9366, lng: 115.8431 });
  assert.equal(venue.geohash.length, 9);
  assert.equal(venue.category, 'sports');
  assert.equal(venue.subcategory, 'volleyball');
  assert.deepEqual(venue.subcategories, ['volleyball', 'soccer', 'basketball']);
  assert.equal(venue.source_url, 'https://loftus.example.com.au');
  assert.equal(venue.raw_source_url, 'http://loftus.example.com.au');
  assert.equal(venue.verified, true);
  assert.ok(venue.updated_at);

  // Unverified venue degrades source_url while preserving raw_source_url and defaults address to name
  const unverifiedVenue = sanitizeVenue({
    id: 'venue_esplanade_qd66d1',
    name: 'Esplanade Reserve',
    coordinates: { lat: -32.0569, lng: 115.7439 },
    source_url: 'https://dead.example.com',
    verified: false
  });
  assert.equal(unverifiedVenue.id, 'venue_esplanade_qd66d1');
  assert.equal(unverifiedVenue.address, 'Esplanade Reserve');
  assert.equal(unverifiedVenue.verified, false);
  assert.equal(unverifiedVenue.source_url, null);
  assert.equal(unverifiedVenue.raw_source_url, 'https://dead.example.com');
});

test('Seam 1: sanitizeVenue throws SanitizationError on missing identity, name, or coordinates', () => {
  assert.throws(() => sanitizeVenue({
    name: 'No Identity Venue',
    coordinates: { lat: -31.95, lng: 115.86 }
  }), /Missing required source identity/);

  assert.throws(() => sanitizeVenue({
    source: 'vwa',
    source_id: '1',
    coordinates: { lat: -31.95, lng: 115.86 }
  }), /Missing required field: name/);

  assert.throws(() => sanitizeVenue({
    source: 'vwa',
    source_id: '1',
    name: 'No Coords Venue'
  }), /Missing valid coordinates/);
});

test('Seam 1: extractCanonicalEntities enriches Organizer and Venue documents with region_id, coordinates, geohash, subcategories, and verification fields', () => {
  const rawInput = {
    source: 'stirling',
    source_id: 'event-1092',
    title: 'Scarborough Sunset Beach Volleyball',
    description: 'Weekly sunset social volleyball match on the beach.',
    sport: 'Beach Volleyball',
    venue_name: 'Scarborough Beach Amphitheatre',
    address: 'The Esplanade, Scarborough WA 6019',
    coordinates: { lat: -31.8942, lng: 115.7571 },
    cost_description: 'Free',
    external_url: 'https://www.stirling.wa.gov.au/events/volleyball-1092',
    club_name: 'Scarborough Beach Sports Club',
    website: 'https://scarboroughbeachsports.com.au',
    demographics: { gender: 'all', age: 'adults' }
  };

  const activity = sanitizeActivity(rawInput);
  const entities = extractCanonicalEntities(activity, rawInput);

  assert.equal(entities.organizer.region_id, 'perth');
  assert.deepEqual(entities.organizer.coordinates, { lat: -31.8942, lng: 115.7571 });
  assert.equal(entities.organizer.geohash.length, 9);
  assert.equal(entities.organizer.category, 'sports');
  assert.equal(entities.organizer.subcategory, 'volleyball');
  assert.deepEqual(entities.organizer.subcategories, ['volleyball']);
  assert.equal(entities.organizer.address, 'The Esplanade, Scarborough WA 6019');
  assert.equal(entities.organizer.cost_description, 'Free');
  assert.deepEqual(entities.organizer.demographics, { gender: 'all', age: 'adults' });
  assert.equal(entities.organizer.website, 'https://scarboroughbeachsports.com.au');
  assert.equal(entities.organizer.source_url, 'https://www.stirling.wa.gov.au/events/volleyball-1092');
  assert.equal(entities.organizer.raw_source_url, 'https://www.stirling.wa.gov.au/events/volleyball-1092');
  assert.equal(entities.organizer.verified, true);

  assert.equal(entities.venue.region_id, 'perth');
  assert.deepEqual(entities.venue.coordinates, { lat: -31.8942, lng: 115.7571 });
  assert.equal(entities.venue.geohash.length, 9);
  assert.equal(entities.venue.category, 'sports');
  assert.equal(entities.venue.subcategory, 'volleyball');
  assert.deepEqual(entities.venue.subcategories, ['volleyball']);
  assert.equal(entities.venue.source_url, 'https://www.stirling.wa.gov.au/events/volleyball-1092');
  assert.equal(entities.venue.raw_source_url, 'https://www.stirling.wa.gov.au/events/volleyball-1092');
  assert.equal(entities.venue.verified, true);
});

test('Seam 1: resolveListingType and sanitizeListing route organizer, venue, and activity records uniformly', () => {
  // Explicit entity_type / listing_type / type / kind and org_/venue_ prefix resolution
  assert.equal(resolveListingType({ entity_type: 'organizer', name: 'Club A' }), 'organizer');
  assert.equal(resolveListingType({ listing_type: 'organizer', name: 'Club B' }), 'organizer');
  assert.equal(resolveListingType({ type: 'organizer', name: 'Club C' }), 'organizer');
  assert.equal(resolveListingType({ kind: 'organizer', name: 'Club D' }), 'organizer');
  assert.equal(resolveListingType({ id: 'org_perth_club', name: 'Perth Club' }), 'organizer');

  assert.equal(resolveListingType({ entity_type: 'venue', name: 'Venue A' }), 'venue');
  assert.equal(resolveListingType({ listing_type: 'venue', name: 'Venue B' }), 'venue');
  assert.equal(resolveListingType({ type: 'venue', name: 'Venue C' }), 'venue');
  assert.equal(resolveListingType({ kind: 'venue', name: 'Venue D' }), 'venue');
  assert.equal(resolveListingType({ id: 'venue_loftus_qd66hd', name: 'Loftus' }), 'venue');

  // Activity with venue/schedule or without entity_type resolves to activity
  assert.equal(resolveListingType({ id: 'org_something', title: 'Session', schedule: { recurrence: 'weekly' } }), 'activity');
  assert.equal(resolveListingType({ source: 'stirling', source_id: '101', title: 'Morning Run' }), 'activity');

  const sanitizedOrg = sanitizeListing({
    entity_type: 'organizer',
    source: 'dlgsc',
    source_id: 'c-1',
    name: 'Subiaco Soccer Club',
    sports: ['Soccer'],
    coordinates: { lat: -31.9445, lng: 115.828 },
    source_url: 'https://subiacosoccer.org.au'
  });
  assert.equal(sanitizedOrg.id, 'org_subiaco_soccer_club');
  assert.deepEqual(sanitizedOrg.subcategories, ['soccer']);
  assert.equal(sanitizedOrg.schedule, undefined);

  const sanitizedVenue = sanitizeListing({
    entity_type: 'venue',
    source: 'volleyball_wa',
    source_id: 'v-1',
    name: 'The HUB',
    subcategory: 'volleyball',
    coordinates: { lat: -31.9416, lng: 115.8477 },
    source_url: 'https://volleyballwa.com.au/social-volley/'
  });
  assert.ok(sanitizedVenue.id.startsWith('venue_the_hub_'));
  assert.deepEqual(sanitizedVenue.subcategories, ['volleyball']);
  assert.equal(sanitizedVenue.schedule, undefined);

  const sanitizedAct = sanitizeListing({
    source: 'stirling',
    source_id: 'a-1',
    title: 'Beach Volleyball Session',
    sport: 'volleyball',
    coordinates: { lat: -31.8942, lng: 115.7571 },
    start_time: '2026-11-20T17:30:00+08:00'
  });
  assert.equal(sanitizedAct.id, 'stirling_a-1');
  assert.equal(sanitizedAct.schedule.start_date, '2026-11-20');
});

test('Seam 1: sanitizeActivity computes expire_at as Date (end_date or start_date + 24h AWST grace) and null for weekly recurring', () => {
  const withEndDate = sanitizeActivity({
    source: 'stirling',
    source_id: 'oneoff-end',
    title: 'Weekend Pickleball Tournament',
    sport: 'pickleball',
    coordinates: { lat: -31.9505, lng: 115.8605 },
    start_date: '2026-11-10',
    end_date: '2026-11-12',
    recurrence: 'none'
  });

  assert.ok(withEndDate.expire_at instanceof Date, 'expire_at should be a Date');
  // End of 2026-11-12 AWST (2026-11-13T00:00:00+08:00) + 24h grace = 2026-11-14T00:00:00+08:00 = 2026-11-13T16:00:00.000Z
  assert.equal(withEndDate.expire_at.toISOString(), '2026-11-13T16:00:00.000Z');

  const withStartDateOnly = sanitizeActivity({
    source: 'stirling',
    source_id: 'oneoff-start',
    title: 'Single Day Tennis Clinic',
    sport: 'tennis',
    coordinates: { lat: -31.9505, lng: 115.8605 },
    start_date: '2026-11-10',
    recurrence: 'none'
  });

  assert.ok(withStartDateOnly.expire_at instanceof Date, 'expire_at should be a Date when end_date omitted');
  // End of 2026-11-10 AWST (2026-11-11T00:00:00+08:00) + 24h grace = 2026-11-12T00:00:00+08:00 = 2026-11-11T16:00:00.000Z
  assert.equal(withStartDateOnly.expire_at.toISOString(), '2026-11-11T16:00:00.000Z');

  const weeklyRecurring = sanitizeActivity({
    source: 'stirling',
    source_id: 'weekly-1',
    title: 'Weekly Social Volleyball',
    sport: 'volleyball',
    coordinates: { lat: -31.9505, lng: 115.8605 },
    start_date: '2026-11-10',
    recurrence: 'weekly'
  });

  assert.equal(weeklyRecurring.expire_at, null);

  const finiteWeeklyRecurring = sanitizeActivity({
    source: 'humanitix',
    source_id: 'weekly-finite',
    title: 'Term 4 Junior Tennis',
    sport: 'tennis',
    coordinates: { lat: -31.9505, lng: 115.8605 },
    start_date: '2026-11-10',
    end_date: '2026-12-15',
    recurrence: 'weekly'
  });

  assert.ok(finiteWeeklyRecurring.expire_at instanceof Date);
  assert.equal(finiteWeeklyRecurring.expire_at.toISOString(), '2026-12-16T16:00:00.000Z');
});

test('Seam 1 (Issue #19): sanitizeOrganizer, extractCanonicalEntities, and mergeEntityDocuments support and preserve contact.facebook', () => {
  // 1. sanitizeOrganizer normalizes explicit contact.facebook
  const orgExplicitFb = sanitizeOrganizer({
    source: 'dlgsc',
    source_id: 'fb-1',
    name: 'Fremantle Runners',
    subcategory: 'running',
    coordinates: { lat: -32.0569, lng: 115.7439 },
    website: 'https://fremantlerunners.org.au',
    contact: {
      email: 'run@fremantle.org.au',
      phone: '0400 000 111',
      facebook: 'http://m.facebook.com/FremantleRunners?fbclid=abc123'
    }
  });
  assert.deepEqual(orgExplicitFb.contact, {
    email: 'run@fremantle.org.au',
    phone: '0400 000 111',
    facebook: 'https://www.facebook.com/FremantleRunners'
  });

  // 2. sanitizeOrganizer auto-populates contact.facebook when website is a Facebook URL
  const orgFbWebsite = sanitizeOrganizer({
    source: 'dlgsc',
    source_id: 'fb-2',
    name: 'Perth Pickleball Social',
    subcategory: 'pickleball',
    coordinates: { lat: -31.9505, lng: 115.8605 },
    website: 'https://fb.me/PerthPickleball?ref=page_internal'
  });
  assert.deepEqual(orgFbWebsite.contact, {
    email: null,
    phone: null,
    facebook: 'https://www.facebook.com/PerthPickleball'
  });

  // 3. extractCanonicalEntities populates contact.facebook from Facebook website/source_url
  const activity = sanitizeActivity({
    source: 'facebook',
    source_id: 'act-1',
    title: 'Social Basketball Night',
    sport: 'basketball',
    organizer_name: 'Subiaco Hoops',
    venue_name: 'Lords Recreation Centre',
    coordinates: { lat: -31.9445, lng: 115.8280 },
    start_time: '2026-11-25T18:00:00+08:00',
    source_url: 'https://www.facebook.com/SubiacoHoops'
  });
  const entities = extractCanonicalEntities(activity, {
    website: 'https://m.facebook.com/SubiacoHoops?__tn__=C'
  });
  assert.deepEqual(entities.organizer.contact, {
    email: null,
    phone: null,
    facebook: 'https://www.facebook.com/SubiacoHoops'
  });

  // 4. mergeEntityDocuments preserves contact.facebook across merges
  const mergedFromPrev = mergeEntityDocuments(
    {
      id: 'org_subiaco_hoops',
      subcategories: ['basketball'],
      contact: { email: null, phone: null, facebook: 'https://www.facebook.com/SubiacoHoops' }
    },
    {
      id: 'org_subiaco_hoops',
      subcategories: ['basketball'],
      contact: { email: 'info@subiacohoops.org.au', phone: null, facebook: null }
    }
  );
  assert.deepEqual(mergedFromPrev.contact, {
    email: 'info@subiacohoops.org.au',
    phone: null,
    facebook: 'https://www.facebook.com/SubiacoHoops'
  });
});

test('Seam 1: sanitizeOrganizer and extractCanonicalEntities do not copy generic directory fallback source_url into website', () => {
  const fallbackUrl = 'https://kidsport.dlgsc.wa.gov.au/find-a-club/?club=123';

  const sanitizedOrg = sanitizeOrganizer({
    source: 'dlgsc',
    source_id: 'org-fallback-1',
    name: 'Fallback Directory Club',
    subcategory: 'soccer',
    coordinates: { lat: -31.9505, lng: 115.8605 },
    source_url: fallbackUrl
  });
  assert.equal(sanitizedOrg.website, null);
  assert.equal(sanitizedOrg.source_url, fallbackUrl);
  assert.equal(sanitizedOrg.verified, true);

  const activity = sanitizeActivity({
    source: 'dlgsc',
    source_id: 'act-fallback-1',
    title: 'Fallback Club Training',
    sport: 'soccer',
    organizer_name: 'Fallback Directory Club',
    venue_name: 'Perth Oval',
    coordinates: { lat: -31.9505, lng: 115.8605 },
    start_time: '2026-11-25T18:00:00+08:00',
    source_url: fallbackUrl
  });
  const entities = extractCanonicalEntities(activity);
  assert.equal(entities.organizer.website, null);
  assert.equal(entities.organizer.source_url, fallbackUrl);
  assert.equal(entities.organizer.verified, true);
});

test('Seam 1 (Issue #31): sanitizeActivity and extractCanonicalEntities normalize 9 canonical categories and resolve subcategories', () => {
  const base = {
    source: 'eventbrite',
    venue_name: 'Perth Cultural Centre',
    coordinates: { lat: -31.9495, lng: 115.8608 },
    start_time: '2026-11-28T19:00:00+08:00',
    organizer_name: 'Perth Arts Collective'
  };

  const cases = [
    { input: 'sports', expectedCat: 'sports', expectedSub: 'other' },
    { input: 'Sports & Fitness', expectedCat: 'sports', expectedSub: 'other' },
    { input: 'health', expectedCat: 'health', expectedSub: 'health' },
    { input: 'Health & Wellness', expectedCat: 'health', expectedSub: 'health' },
    { input: 'arts', expectedCat: 'arts', expectedSub: 'arts' },
    { input: 'Performing & Visual Arts', expectedCat: 'arts', expectedSub: 'arts' },
    { input: 'music', expectedCat: 'music', expectedSub: 'music' },
    { input: 'community', expectedCat: 'community', expectedSub: 'community' },
    { input: 'Community & Culture', expectedCat: 'community', expectedSub: 'community' },
    { input: 'family', expectedCat: 'family', expectedSub: 'family' },
    { input: 'Family & Education', expectedCat: 'family', expectedSub: 'family' },
    { input: 'food', expectedCat: 'food', expectedSub: 'food' },
    { input: 'Food & Drink', expectedCat: 'food', expectedSub: 'food' },
    { input: 'hobbies', expectedCat: 'hobbies', expectedSub: 'hobbies' },
    { input: 'Hobbies & Special Interest', expectedCat: 'hobbies', expectedSub: 'hobbies' },
    { input: 'travel', expectedCat: 'travel', expectedSub: 'travel' },
    { input: 'Travel & Outdoor', expectedCat: 'travel', expectedSub: 'travel' },
    { input: 'Martial Arts', expectedCat: 'sports', expectedSub: 'other' },
    { input: 'Party', expectedCat: 'sports', expectedSub: 'other' },
    { input: 'unknown-vertical', expectedCat: 'sports', expectedSub: 'other' },
    { input: '', expectedCat: 'sports', expectedSub: 'other' }
  ];

  for (const [idx, c] of cases.entries()) {
    const activity = sanitizeActivity({
      ...base,
      source_id: `cat-${idx}`,
      title: `Activity ${idx}`,
      category: c.input
    });
    assert.equal(activity.category, c.expectedCat, `category mismatch for "${c.input}"`);
    assert.equal(activity.subcategory, c.expectedSub, `subcategory mismatch for "${c.input}"`);

    const entities = extractCanonicalEntities(activity, { category: c.input });
    assert.equal(entities.venue.category, c.expectedCat);
    assert.equal(entities.venue.subcategory, c.expectedSub);
    assert.deepEqual(entities.venue.subcategories, [c.expectedSub]);
    assert.equal(entities.organizer.category, c.expectedCat);
    assert.equal(entities.organizer.subcategory, c.expectedSub);
    assert.deepEqual(entities.organizer.subcategories, [c.expectedSub]);
  }

  // Concrete sport slug takes precedence when matched
  const charityRun = sanitizeActivity({
    ...base,
    source_id: 'charity-run',
    title: 'Community Fun Run',
    category: 'Community & Culture',
    subcategory: 'running'
  });
  assert.equal(charityRun.category, 'community');
  assert.equal(charityRun.subcategory, 'running');
  const runEntities = extractCanonicalEntities(charityRun);
  assert.equal(runEntities.venue.category, 'community');
  assert.equal(runEntities.venue.subcategory, 'running');
  assert.deepEqual(runEntities.venue.subcategories, ['running']);
});

test('parseSchedule does not misclassify weekday names containing "T" (Tuesday/Thursday) as ISO timestamps', () => {
  const tuesdayActivity = sanitizeActivity({
    source: 'vincent',
    source_id: 'tue-1',
    title: 'Reusable Gift Wrapping Workshops',
    venue_name: 'Kyilla Park',
    coordinates: { lat: -31.92, lng: 115.84 },
    start_time: 'Saturday 21 November - Tuesday 8 December 2026, 10am - 11am'
  });
  assert.equal(tuesdayActivity.schedule.start_date, '2026-11-21');
  assert.equal(tuesdayActivity.schedule.end_date, '2026-12-08');
  assert.equal(tuesdayActivity.schedule.start_time, '10:00');
  assert.equal(tuesdayActivity.schedule.end_time, '11:00');

  const thursdayActivity = sanitizeActivity({
    source: 'vincent',
    source_id: 'thu-1',
    title: 'Social Strings: Term 4',
    venue_name: 'Community Hall',
    coordinates: { lat: -31.93, lng: 115.84 },
    start_time: 'Thursday 26 November 2026, 6pm - 8pm'
  });
  assert.equal(thursdayActivity.schedule.start_date, '2026-11-26');
  assert.equal(thursdayActivity.schedule.start_time, '18:00');
  assert.equal(thursdayActivity.schedule.end_time, '20:00');
});

test('Issue #66: mergeActivityDocuments preserves curated_fields (including cleared values, dot paths, and coupled derived fields) while merging untouched fields and sources', () => {
  const curatedSchedule = {
    start_date: '2026-12-01',
    end_date: '2026-12-01',
    start_time: '18:30',
    end_time: '20:00',
    recurrence: 'none',
    day_of_week: 2
  };
  const curatedExpireAt = '2026-12-03T16:00:00.000Z';

  const prevActivity = {
    id: 'stirling_curated_66',
    source: 'stirling',
    source_id: 'curated_66',
    title: 'Curated Volleyball Social',
    description: 'Admin-edited description',
    category: 'sports',
    subcategory: 'volleyball',
    source_url: null,
    verified: false,
    cost: { is_free: true, display_price: 'Free' },
    schedule: curatedSchedule,
    expire_at: curatedExpireAt,
    demographics: { gender: 'all', age: 'adults' },
    sources: [{ source: 'stirling', source_id: 'curated_66', source_key: 'stirling_curated_66', source_url: null, verified: false }],
    source_keys: ['stirling_curated_66'],
    needs_review: false,
    review_reason: null,
    curated_fields: ['description', 'cost', 'schedule', 'source_url', 'verified', 'demographics.age']
  };

  const nextActivity = {
    id: 'stirling_curated_66',
    source: 'stirling',
    source_id: 'curated_66',
    title: 'Curated Volleyball Social',
    description: 'Crawler-overwritten description',
    category: 'community',
    subcategory: 'volleyball',
    source_url: 'https://stirling.wa.gov.au/events/66',
    verified: true,
    cost: { is_free: false, display_price: '$25' },
    schedule: {
      start_date: '2026-12-05',
      end_date: '2026-12-05',
      start_time: '10:00',
      end_time: '12:00',
      recurrence: 'none',
      day_of_week: 6
    },
    expire_at: '2026-12-07T16:00:00.000Z',
    demographics: { gender: 'women', age: 'youth' },
    sources: [{ source: 'eventbrite', source_id: 'eb_66', source_key: 'eventbrite_eb_66', source_url: 'https://eventbrite.com.au/e/66', verified: true }],
    source_keys: ['eventbrite_eb_66'],
    needs_review: true,
    review_reason: 'crawler_created'
  };

  const merged = mergeActivityDocuments(prevActivity, nextActivity);
  assert.equal(merged.description, 'Admin-edited description');
  assert.deepEqual(merged.cost, { is_free: true, display_price: 'Free' });
  assert.deepEqual(merged.schedule, curatedSchedule);
  assert.equal(merged.expire_at, curatedExpireAt);
  assert.equal(merged.source_url, null);
  assert.equal(merged.verified, false);
  assert.equal(merged.demographics.age, 'adults');
  // Untouched fields and Source References still update
  assert.equal(merged.category, 'community');
  assert.equal(merged.demographics.gender, 'women');
  assert.deepEqual(merged.source_keys, ['eventbrite_eb_66', 'stirling_curated_66']);
  assert.deepEqual(merged.curated_fields, ['description', 'cost', 'schedule', 'source_url', 'verified', 'demographics.age']);
  assert.equal(merged.needs_review, false);
  assert.equal(merged.review_reason, null);
});

test('Issue #66: mergeEntityDocuments preserves curated_fields on Organizers and Venues across Google Places re-syncs without regressing uncurated updates', () => {
  const prevVenue = {
    id: 'venue_curated_arena_qd66d1',
    name: 'Curated Arena Name',
    description: 'Admin-curated venue description',
    address: '100 Admin St, Perth WA 6000',
    coordinates: { lat: -31.9501, lng: 115.8601 },
    geohash: 'qd66hr9z1',
    category: 'sports',
    subcategory: 'basketball',
    subcategories: ['basketball'],
    google_place_id: 'ChIJ_venue_66',
    needs_review: false,
    review_reason: null,
    curated_fields: ['name', 'coordinates', 'category']
  };

  const googlePlacesVenueUpdate = {
    id: 'venue_curated_arena_qd66d1',
    source: 'google_places',
    name: 'Google Places Raw Name',
    description: 'Google Places description',
    address: '100 Updated Google Rd, Perth WA 6000',
    coordinates: { lat: -31.96, lng: 115.87 },
    geohash: 'qd66hxxxx',
    category: 'community',
    subcategory: 'volleyball',
    subcategories: ['volleyball'],
    google_place_id: 'ChIJ_venue_66',
    needs_review: true,
    review_reason: 'crawler_created'
  };

  const mergedVenue = mergeEntityDocuments(prevVenue, googlePlacesVenueUpdate);
  assert.equal(mergedVenue.name, 'Curated Arena Name');
  assert.deepEqual(mergedVenue.coordinates, { lat: -31.9501, lng: 115.8601 });
  assert.equal(mergedVenue.geohash, 'qd66hr9z1');
  assert.equal(mergedVenue.category, 'sports');
  // Untouched fields and subcategories still update
  assert.equal(mergedVenue.address, '100 Updated Google Rd, Perth WA 6000');
  assert.equal(mergedVenue.description, 'Google Places description');
  assert.deepEqual(mergedVenue.subcategories, ['basketball', 'volleyball']);
  assert.deepEqual(mergedVenue.curated_fields, ['name', 'coordinates', 'category']);
  assert.equal(mergedVenue.needs_review, false);
  assert.equal(mergedVenue.review_reason, null);

  // Uncurated Venue from Google Places (no curated_fields) still receives updates
  const uncuratedVenue = {
    id: 'venue_uncurated_qd66d1',
    name: 'Old Venue',
    address: 'Old Address',
    category: 'community',
    subcategory: 'basketball',
    subcategories: ['basketball'],
    needs_review: false,
    review_reason: null
  };
  const updatedUncuratedVenue = mergeEntityDocuments(uncuratedVenue, googlePlacesVenueUpdate);
  assert.equal(updatedUncuratedVenue.name, 'Google Places Raw Name');
  assert.equal(updatedUncuratedVenue.category, 'community');
  assert.equal(updatedUncuratedVenue.curated_fields, undefined);

  // Curated Organizer preserves curated_fields across Google Places re-sync
  const prevOrg = {
    id: 'org_curated_club_66',
    name: 'Curated Perth Club',
    website: 'https://curated-club.org.au',
    contact: { email: 'admin@curated-club.org.au', phone: null, facebook: null },
    address: 'Old Club Address',
    category: 'sports',
    subcategory: 'tennis',
    subcategories: ['tennis'],
    needs_review: false,
    review_reason: null,
    curated_fields: ['name', 'website', 'contact']
  };
  const nextOrg = {
    id: 'org_curated_club_66',
    source: 'google_places',
    name: 'Google Places Club',
    website: 'https://places.example.com',
    contact: { email: 'places@example.com', phone: '08 9000 0000', facebook: null },
    address: '123 New Place Rd, Perth WA 6000',
    category: 'sports',
    subcategory: 'pickleball',
    subcategories: ['pickleball'],
    needs_review: false,
    review_reason: null
  };
  const mergedOrg = mergeEntityDocuments(prevOrg, nextOrg);
  assert.equal(mergedOrg.name, 'Curated Perth Club');
  assert.equal(mergedOrg.website, 'https://curated-club.org.au');
  assert.deepEqual(mergedOrg.contact, { email: 'admin@curated-club.org.au', phone: null, facebook: null });
  assert.equal(mergedOrg.address, '123 New Place Rd, Perth WA 6000');
  assert.deepEqual(mergedOrg.subcategories, ['tennis', 'pickleball']);
  assert.deepEqual(mergedOrg.curated_fields, ['name', 'website', 'contact']);
});
