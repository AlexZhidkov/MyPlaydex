import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeActivity, normalizeSport, extractCanonicalEntities } from '../src/sanitizer.js';

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
  assert.deepEqual(entities.organizer.contact, { email: null, phone: null });

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
