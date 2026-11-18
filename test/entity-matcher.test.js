import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchVenueCandidate,
  matchOrganizerCandidate,
  reconcileListingWithCatalog
} from '../src/entity-matcher.js';

const VENUES_CATALOG = [
  {
    id: 'venue_scarborough_beach_amphitheatre_qd66s4',
    name: 'Scarborough Beach Amphitheatre',
    coordinates: { lat: -31.8942, lng: 115.7571 },
    geohash: 'qd66s4b9x',
    google_place_id: 'ChIJScarboroughPlace'
  },
  {
    id: 'venue_terry_tyzack_aquatic_centre_qd66h8',
    name: 'Stirling Leisure Centres - Terry Tyzack Aquatic Centre',
    coordinates: { lat: -31.9020, lng: 115.8820 },
    geohash: 'qd66h8abc',
    google_place_id: 'ChIJTerryTyzackPlace'
  },
  {
    id: 'venue_rosalie_park_qd66h2',
    name: 'Rosalie Park',
    coordinates: { lat: -31.9540, lng: 115.8220 },
    geohash: 'qd66h2xyz',
    google_place_id: 'ChIJRosalieParkPlace'
  }
];

const ORGANIZERS_CATALOG = [
  {
    id: 'org_city_of_stirling',
    name: 'City of Stirling',
    coordinates: { lat: -31.8830, lng: 115.8050 },
    needs_review: false
  },
  {
    id: 'org_chequers_volleyball_club',
    name: 'Chequers Volleyball Club',
    coordinates: { lat: -31.9450, lng: 115.8387 },
    needs_review: false
  }
];

test('Entity Matcher: matchVenueCandidate returns matched, uncertain, and unmatched based on normalized name and coordinate proximity', () => {
  // 1. Exact slug within 1km -> matched
  const exact = matchVenueCandidate(
    { name: 'Scarborough Beach Amphitheatre', coordinates: { lat: -31.8945, lng: 115.7575 } },
    VENUES_CATALOG
  );
  assert.equal(exact.status, 'matched');
  assert.equal(exact.candidate.id, 'venue_scarborough_beach_amphitheatre_qd66s4');

  // 2. Strong containment within 0.5km -> matched
  const contained = matchVenueCandidate(
    { name: 'Terry Tyzack Aquatic Centre', coordinates: { lat: -31.9025, lng: 115.8822 } },
    VENUES_CATALOG
  );
  assert.equal(contained.status, 'matched');
  assert.equal(contained.candidate.id, 'venue_terry_tyzack_aquatic_centre_qd66h8');

  // 3. Partial overlap within 2.5km -> uncertain
  const uncertainPartial = matchVenueCandidate(
    { name: 'Scarborough Beach', coordinates: { lat: -31.8960, lng: 115.7580 } },
    VENUES_CATALOG
  );
  assert.equal(uncertainPartial.status, 'uncertain');
  assert.equal(uncertainPartial.candidate.id, 'venue_scarborough_beach_amphitheatre_qd66s4');

  // 4. Exact name but ~2.5km away -> uncertain
  const uncertainFar = matchVenueCandidate(
    { name: 'Rosalie Park', coordinates: { lat: -31.9750, lng: 115.8220 } },
    VENUES_CATALOG
  );
  assert.equal(uncertainFar.status, 'uncertain');
  assert.equal(uncertainFar.candidate.id, 'venue_rosalie_park_qd66h2');

  // 5. Completely unrelated venue -> unmatched
  const unmatched = matchVenueCandidate(
    { name: 'Fremantle Leisure Centre', coordinates: { lat: -32.0560, lng: 115.7490 } },
    VENUES_CATALOG
  );
  assert.equal(unmatched.status, 'unmatched');
  assert.equal(unmatched.candidate, null);
});

test('Entity Matcher: matchOrganizerCandidate returns matched, uncertain, and unmatched', () => {
  // 1. Exact / legal-suffix-normalized match regardless of distance -> matched
  const exact = matchOrganizerCandidate(
    { id: 'org_chequers_volleyball_club_inc', name: 'Chequers Volleyball Club Inc.', coordinates: { lat: -32.05, lng: 115.75 } },
    ORGANIZERS_CATALOG
  );
  assert.equal(exact.status, 'matched');
  assert.equal(exact.candidate.id, 'org_chequers_volleyball_club');

  // 2. Partial name overlap -> uncertain
  const uncertain = matchOrganizerCandidate(
    { id: 'org_chequers_volleyball', name: 'Chequers Volleyball', coordinates: { lat: -31.9450, lng: 115.8387 } },
    ORGANIZERS_CATALOG
  );
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.candidate.id, 'org_chequers_volleyball_club');

  // 3. Unknown organizer -> unmatched
  const unmatched = matchOrganizerCandidate(
    { id: 'org_fremantle_beach_club', name: 'Fremantle Beach Club', coordinates: { lat: -32.05, lng: 115.75 } },
    ORGANIZERS_CATALOG
  );
  assert.equal(unmatched.status, 'unmatched');
  assert.equal(unmatched.candidate, null);
});

test('Entity Matcher: reconcileListingWithCatalog sets canonical links, needs_review, and review_reason across all Activity and Organizer outcomes', () => {
  const catalog = {
    venuesCatalog: VENUES_CATALOG,
    organizersCatalog: ORGANIZERS_CATALOG
  };

  // 1. Confident Venue + Confident Organizer
  const confidentActivity = reconcileListingWithCatalog({
    id: 'stirling_1',
    venue: {
      id: 'venue_raw_1',
      name: 'Scarborough Beach Amphitheatre',
      coordinates: { lat: -31.8942, lng: 115.7571 },
      geohash: 'qd66s4000'
    },
    organizer: {
      id: 'org_city_of_stirling',
      name: 'City of Stirling'
    }
  }, catalog, 'activity');

  assert.equal(confidentActivity.needs_review, false);
  assert.equal(confidentActivity.review_reason, null);
  assert.equal(confidentActivity.venue.id, 'venue_scarborough_beach_amphitheatre_qd66s4');
  assert.equal(confidentActivity.venue.google_place_id, 'ChIJScarboroughPlace');
  assert.equal(confidentActivity.organizer.id, 'org_city_of_stirling');

  // 2. Uncertain Venue
  const uncertainVenueActivity = reconcileListingWithCatalog({
    id: 'stirling_2',
    venue: {
      id: 'venue_raw_2',
      name: 'Scarborough Beach',
      coordinates: { lat: -31.8960, lng: 115.7580 },
      geohash: 'qd66s4001'
    },
    organizer: {
      id: 'org_city_of_stirling',
      name: 'City of Stirling'
    }
  }, catalog, 'activity');

  assert.equal(uncertainVenueActivity.needs_review, true);
  assert.equal(uncertainVenueActivity.review_reason, 'uncertain_venue_match');
  assert.equal(uncertainVenueActivity.venue.id, 'venue_scarborough_beach_amphitheatre_qd66s4');

  // 3. Unmatched Venue
  const unmatchedVenueActivity = reconcileListingWithCatalog({
    id: 'stirling_3',
    venue: {
      id: 'venue_raw_3',
      name: 'Secret Hidden Court',
      coordinates: { lat: -32.1000, lng: 115.9000 },
      geohash: 'qd66z9999'
    },
    organizer: {
      id: 'org_city_of_stirling',
      name: 'City of Stirling'
    }
  }, catalog, 'activity');

  assert.equal(unmatchedVenueActivity.needs_review, true);
  assert.equal(unmatchedVenueActivity.review_reason, 'unmatched_venue');
  assert.equal(unmatchedVenueActivity.venue.id, null);
  assert.equal(unmatchedVenueActivity.venue.name, 'Secret Hidden Court');
  assert.deepEqual(unmatchedVenueActivity.venue.coordinates, { lat: -32.1000, lng: 115.9000 });
  assert.equal(unmatchedVenueActivity.venue.geohash, 'qd66z9999');

  // 4. Unmatched Organizer
  const unmatchedOrgActivity = reconcileListingWithCatalog({
    id: 'stirling_4',
    venue: {
      id: 'venue_raw_4',
      name: 'Rosalie Park',
      coordinates: { lat: -31.9540, lng: 115.8220 },
      geohash: 'qd66h2xyz'
    },
    organizer: {
      id: 'org_brand_new_club',
      name: 'Brand New Club'
    }
  }, catalog, 'activity');

  assert.equal(unmatchedOrgActivity.needs_review, true);
  assert.equal(unmatchedOrgActivity.review_reason, 'unmatched_organizer');
  assert.equal(unmatchedOrgActivity.organizer.id, 'org_brand_new_club');

  // 5. Standalone Organizer not in catalog -> crawler_created
  const newOrg = reconcileListingWithCatalog({
    id: 'org_brand_new_club',
    name: 'Brand New Club',
    coordinates: { lat: -31.95, lng: 115.86 }
  }, catalog, 'organizer');

  assert.equal(newOrg.needs_review, true);
  assert.equal(newOrg.review_reason, 'crawler_created');
});
