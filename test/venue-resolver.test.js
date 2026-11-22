import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveActivityVenueAndCoordinates } from '../src/venue-resolver.js';

test('Step 1: resolves explicit coordinates within Greater Perth and rejects out-of-area coordinates', () => {
  const inPerth = resolveActivityVenueAndCoordinates({
    title: 'Perth Basketball',
    coordinates: { lat: -31.9505, lng: 115.8605 }
  });
  assert.equal(inPerth.outOfArea, false);
  assert.deepEqual(inPerth.coordinates, { lat: -31.9505, lng: 115.8605 });
  assert.equal(inPerth.geohash.length, 9);
  assert.equal(inPerth.venueOverride, null);
  assert.equal(inPerth.fallbackReviewReason, null);

  const outOfArea = resolveActivityVenueAndCoordinates({
    title: 'Sydney Basketball',
    coordinates: { lat: -33.8688, lng: 151.2093 }
  });
  assert.equal(outOfArea.outOfArea, true);
});

test('Step 2: resolves Venue from /venues catalog by name/slug when raw coordinates are omitted and flags uncertain matches', () => {
  const venuesCatalog = [
    {
      id: 'venue_bendat_qd66hx',
      name: 'Bendat Basketball Centre',
      coordinates: { lat: -31.9412, lng: 115.7924 },
      geohash: 'qd66hx123',
      google_place_id: 'ChIJ_bendat'
    },
    {
      id: 'venue_lords_subiaco',
      name: 'Lords Recreation Centre Subiaco',
      coordinates: { lat: -31.9463, lng: 115.8234 },
      geohash: 'qd66hx456',
      google_place_id: 'ChIJ_lords'
    }
  ];

  const exactMatch = resolveActivityVenueAndCoordinates(
    { title: 'Hoops Night', venue_name: 'Bendat Basketball Centre' },
    { venuesCatalog }
  );
  assert.equal(exactMatch.outOfArea, false);
  assert.deepEqual(exactMatch.coordinates, { lat: -31.9412, lng: 115.7924 });
  assert.equal(exactMatch.geohash, 'qd66hx123');
  assert.equal(exactMatch.venueOverride.id, 'venue_bendat_qd66hx');
  assert.equal(exactMatch.venueOverride.google_place_id, 'ChIJ_bendat');
  assert.equal(exactMatch.fallbackReviewReason, null);

  const uncertainMatch = resolveActivityVenueAndCoordinates(
    { title: 'Swim Session', venue: { name: 'Lords Recreation Centre' } },
    { venuesCatalog }
  );
  assert.equal(uncertainMatch.outOfArea, false);
  assert.equal(uncertainMatch.venueOverride.id, 'venue_lords_subiaco');
  assert.equal(uncertainMatch.fallbackReviewReason, 'uncertain_venue_match');

  const nonWa = resolveActivityVenueAndCoordinates(
    { title: 'Interstate', venue_name: 'Bendat Basketball Centre', location_text: 'Melbourne, VIC' },
    { venuesCatalog }
  );
  assert.equal(nonWa.outOfArea, true);
});

test('Step 3: falls back to Greater Perth suburb/postcode centroid and flags unmatched_venue', () => {
  const byPostcode = resolveActivityVenueAndCoordinates({
    title: 'Morning Yoga',
    venue_name: 'Unknown Studio',
    address: '123 Rokeby Rd, 6008'
  });
  assert.equal(byPostcode.outOfArea, false);
  assert.deepEqual(byPostcode.coordinates, { lat: -31.9463, lng: 115.8236 });
  assert.equal(byPostcode.geohash.length, 9);
  assert.equal(byPostcode.venueOverride, null);
  assert.equal(byPostcode.fallbackReviewReason, 'unmatched_venue');

  const bySuburb = resolveActivityVenueAndCoordinates({
    title: 'Community Run in Scarborough',
    venue_name: 'Coastal Reserve'
  });
  assert.equal(bySuburb.outOfArea, false);
  assert.equal(bySuburb.fallbackReviewReason, 'unmatched_venue');
});

test('Step 4: falls back to supplied fallbackCentroid or Organizer centroid and flags unmatched_venue', () => {
  const lgaCentroid = { lat: -31.8942, lng: 115.7571 };
  const fromLga = resolveActivityVenueAndCoordinates(
    { title: 'Council Craft Workshop', venue_name: 'Community Room B' },
    { fallbackCentroid: lgaCentroid }
  );
  assert.equal(fromLga.outOfArea, false);
  assert.deepEqual(fromLga.coordinates, lgaCentroid);
  assert.equal(fromLga.fallbackReviewReason, 'unmatched_venue');

  const organizersCatalog = [
    {
      id: 'org_perth_club',
      name: 'Perth Rowing Club',
      coordinates: { lat: -31.9753, lng: 115.8978 }
    }
  ];
  const fromOrg = resolveActivityVenueAndCoordinates(
    { title: 'Learn to Row', venue_name: 'Boat Shed', organizer_name: 'Perth Rowing Club' },
    { organizersCatalog }
  );
  assert.equal(fromOrg.outOfArea, false);
  assert.deepEqual(fromOrg.coordinates, { lat: -31.9753, lng: 115.8978 });
  assert.equal(fromOrg.fallbackReviewReason, 'unmatched_venue');

  // Out-of-area fallbackCentroid should be rejected
  const outOfAreaFallback = resolveActivityVenueAndCoordinates(
    { title: 'Mystery Activity', venue_name: 'Mystery Hall' },
    { fallbackCentroid: { lat: -33.8688, lng: 151.2093 } }
  );
  assert.equal(outOfAreaFallback.outOfArea, true);
});
