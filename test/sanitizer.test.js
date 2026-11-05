import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeActivity, normalizeSport } from '../src/sanitizer.js';

test('Seam 2: normalizeSport maps various sport aliases to canonical MVP taxonomy', () => {
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

test('Seam 2: sanitizeActivity produces a valid canonical ActivityDocument with precision-9 geohash', () => {
  const rawInput = {
    source: 'stirling',
    source_id: 'event-1092',
    title: '  Scarborough Sunset Beach Volleyball  ',
    sport: 'Beach Volleyball',
    type: 'social',
    venue_name: 'Scarborough Beach Amphitheatre',
    address: 'The Esplanade, Scarborough WA 6019',
    coordinates: { lat: -31.8942, lng: 115.7571 },
    start_time: '2026-11-12T17:30:00+08:00',
    end_time: '2026-11-12T19:30:00+08:00',
    cost_description: 'Free',
    external_url: 'https://www.stirling.wa.gov.au/events/volleyball-1092',
    club_name: 'Scarborough Beach Sports Club',
    demographics: { gender: 'mixed', age: 'adults' }
  };

  const activity = sanitizeActivity(rawInput);

  assert.equal(activity.id, 'stirling_event-1092');
  assert.equal(activity.title, 'Scarborough Sunset Beach Volleyball');
  assert.equal(activity.sport, 'volleyball');
  assert.equal(activity.type, 'social');
  assert.equal(activity.venue.name, 'Scarborough Beach Amphitheatre');
  assert.equal(activity.venue.address, 'The Esplanade, Scarborough WA 6019');
  assert.equal(activity.venue.coordinates.lat, -31.8942);
  assert.equal(activity.venue.coordinates.lng, 115.7571);
  assert.equal(activity.venue.geohash.length, 9);
  assert.equal(activity.is_free, true);
  assert.equal(activity.cost_description, 'Free');
  assert.equal(activity.club_name, 'Scarborough Beach Sports Club');
  assert.equal(activity.club_ref, 'clubs/stirling_event-1092');
  assert.deepEqual(activity.demographics, { gender: 'mixed', age: 'adults' });
  assert.equal(activity.is_active, true);
  assert.ok(activity.updated_at);
  assert.ok(activity.created_at);
});

test('Seam 2: sanitizeActivity infers free status and defaults missing optional attributes', () => {
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

  assert.equal(activity.is_free, false);
  assert.deepEqual(activity.demographics, { gender: 'all', age: 'all' });
  assert.equal(activity.type, 'social');
  assert.equal(activity.venue.address, 'North Perth Bowling & Rec Club'); // Defaults to venue_name if missing
  assert.equal(activity.club_name, 'North Perth Social Futsal'); // Defaults to title if missing
  assert.ok(activity.venue.geohash.startsWith('qd66'));
});

test('Seam 2: sanitizeActivity throws SanitizationError on invalid or missing required fields', () => {
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
