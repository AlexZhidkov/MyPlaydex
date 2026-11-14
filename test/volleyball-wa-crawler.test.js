import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVolleyballWaCrawler,
  extractDistinctVenueName,
  VOLLEYBALL_WA_ENDPOINT
} from '../src/crawlers/volleyball-wa-crawler.js';
import { sanitizeOrganizer, sanitizeVenue, sanitizeListing } from '../src/sanitizer.js';
import { createFirestoreAdapter } from '../src/firestore-adapter.js';

test('Seam 6: Volleyball WA Crawler classifies centres into Venues and clubs into Organizers (plus distinct Venues) without synthetic activities', async () => {
  const mockPayload = [
    {
      id: 30092,
      store: 'The HUB',
      address: 'Inner City Beach',
      address2: '180 Charles St',
      city: 'West Perth',
      state: 'WA',
      zip: '6005',
      country: 'Australia',
      lat: '-31.941599',
      lng: '115.847653',
      phone: '08 9228 8522',
      email: 'info@volleyballwa.com.au',
      url: 'https://volleyballwa.com.au/social-volley/',
      terms: 'Social Volley Centre',
      hours: '<table class="wpsl-opening-hours"><tr><td>Monday</td><td>9:00 AM – 5:00 PM</td></tr></table>'
    },
    {
      id: 34912,
      store: 'Chequers Volleyball Club',
      address: 'Perth Modern School',
      address2: '90 Roberts Rd',
      city: 'Subiaco',
      state: 'WA',
      zip: '6008',
      country: 'Australia',
      lat: '-31.944988',
      lng: '115.838660',
      phone: '',
      email: 'contact@chequers.org.au',
      url: 'https://volleyballwa.com.au/places/chequers-volleyball-club/',
      terms: 'Affiliated Club',
      hours: ''
    },
    {
      // Club with street-only address (no distinct physical venue name) -> emits Organizer only
      id: 35001,
      store: 'Bayswater Volleyball Club',
      address: '123 Roberts Road',
      address2: '',
      city: 'Bayswater',
      state: 'WA',
      zip: '6053',
      country: 'Australia',
      lat: '-31.918100',
      lng: '115.913200',
      phone: '0400 999 888',
      email: 'hello@bayswatervolley.org.au',
      url: 'https://bayswatervolley.org.au',
      terms: 'Affiliated Club',
      hours: ''
    },
    {
      // Club with PO Box address (no distinct physical venue name) -> emits Organizer only
      id: 35002,
      store: 'Northern Districts Volleyball Club',
      address: 'PO Box 456',
      address2: '',
      city: 'Joondalup',
      state: 'WA',
      zip: '6027',
      country: 'Australia',
      lat: '-31.745000',
      lng: '115.766000',
      phone: '',
      email: '',
      url: 'https://ndvc.org.au',
      terms: 'Affiliated Club',
      hours: ''
    },
    {
      // Missing coordinates - should be dropped safely
      id: 99999,
      store: 'Virtual Volleyball Club',
      lat: '',
      lng: '',
      url: 'https://volleyballwa.com.au'
    }
  ];

  let requestedUrl = null;
  let requestedHeaders = null;

  const mockFetch = async (url, options) => {
    requestedUrl = url;
    requestedHeaders = options.headers;
    return {
      ok: true,
      async json() {
        return mockPayload;
      }
    };
  };

  const crawler = createVolleyballWaCrawler({ fetchFn: mockFetch });
  assert.equal(crawler.name, 'volleyball_wa');

  const listings = await crawler.fetchListings();

  // Verify request URL parameters
  assert.ok(requestedUrl.startsWith(VOLLEYBALL_WA_ENDPOINT));
  assert.ok(requestedUrl.includes('action=store_search'));
  assert.ok(requestedUrl.includes('lat=-31.95'));
  assert.ok(requestedUrl.includes('lng=115.86'));
  assert.ok(requestedUrl.includes('search_radius=100'));
  assert.ok(requestedHeaders['User-Agent']);

  // 1 venue (The HUB) + 1 organizer & 1 venue (Chequers / Perth Modern School) + 1 organizer (Bayswater) + 1 organizer (Northern Districts) = 5
  assert.equal(listings.length, 5);

  // None of the listings should generate synthetic weekly activities
  for (const item of listings) {
    assert.equal(item.schedule, undefined);
  }

  // 1. Centre record -> Venue Listing
  const hubVenue = listings[0];
  assert.ok(hubVenue.id.startsWith('venue_the_hub_'));
  assert.equal(hubVenue.entity_type, 'venue');
  assert.equal(hubVenue.source, 'volleyball_wa');
  assert.equal(hubVenue.source_id, '30092');
  assert.equal(hubVenue.name, 'The HUB');
  assert.equal(hubVenue.region_id, 'perth');
  assert.equal(hubVenue.category, 'sports');
  assert.equal(hubVenue.subcategory, 'volleyball');
  assert.deepEqual(hubVenue.subcategories, ['volleyball']);
  assert.equal(hubVenue.address, 'Inner City Beach, 180 Charles St, West Perth, WA 6005');
  assert.deepEqual(hubVenue.coordinates, { lat: -31.941599, lng: 115.847653 });
  assert.equal(hubVenue.geohash.length, 9);
  assert.match(hubVenue.description, /Monday 9:00 AM/);
  assert.equal(hubVenue.source_url, 'https://volleyballwa.com.au/social-volley/');
  assert.equal(hubVenue.raw_source_url, 'https://volleyballwa.com.au/social-volley/');

  const sanitizedHub = sanitizeVenue(hubVenue);
  assert.equal(sanitizedHub.id, hubVenue.id);
  assert.deepEqual(sanitizedHub.subcategories, ['volleyball']);

  // 2. Club record -> Organizer Listing + distinct Venue Listing
  const chequersOrg = listings[1];
  assert.equal(chequersOrg.id, 'org_chequers_volleyball_club');
  assert.equal(chequersOrg.entity_type, 'organizer');
  assert.equal(chequersOrg.name, 'Chequers Volleyball Club');
  assert.equal(chequersOrg.address, 'Perth Modern School, 90 Roberts Rd, Subiaco, WA 6008');
  assert.deepEqual(chequersOrg.coordinates, { lat: -31.944988, lng: 115.83866 });
  assert.equal(chequersOrg.geohash.length, 9);
  assert.deepEqual(chequersOrg.subcategories, ['volleyball']);
  assert.equal(chequersOrg.website, 'https://volleyballwa.com.au/places/chequers-volleyball-club/');
  assert.deepEqual(chequersOrg.contact, { phone: null, email: 'contact@chequers.org.au' });
  assert.equal(chequersOrg.cost_description, 'Casual volleyball fees apply');
  assert.deepEqual(chequersOrg.demographics, { gender: 'all', age: 'all' });
  assert.equal(chequersOrg.source_url, 'https://volleyballwa.com.au/places/chequers-volleyball-club/');
  assert.equal(chequersOrg.raw_source_url, 'https://volleyballwa.com.au/places/chequers-volleyball-club/');

  const sanitizedChequers = sanitizeOrganizer(chequersOrg);
  assert.equal(sanitizedChequers.id, 'org_chequers_volleyball_club');

  const pmsVenue = listings[2];
  assert.ok(pmsVenue.id.startsWith('venue_perth_modern_school_'));
  assert.equal(pmsVenue.entity_type, 'venue');
  assert.equal(pmsVenue.name, 'Perth Modern School');
  assert.equal(pmsVenue.address, 'Perth Modern School, 90 Roberts Rd, Subiaco, WA 6008');
  assert.deepEqual(pmsVenue.coordinates, { lat: -31.944988, lng: 115.83866 });
  assert.equal(pmsVenue.geohash.length, 9);
  assert.deepEqual(pmsVenue.subcategories, ['volleyball']);
  assert.equal(pmsVenue.source_url, 'https://volleyballwa.com.au/places/chequers-volleyball-club/');
  assert.equal(pmsVenue.raw_source_url, 'https://volleyballwa.com.au/places/chequers-volleyball-club/');

  // 3. Clubs without distinct venue names emit Organizer only
  const bayswaterOrg = listings[3];
  assert.equal(bayswaterOrg.id, 'org_bayswater_volleyball_club');
  assert.equal(bayswaterOrg.entity_type, 'organizer');

  const ndvcOrg = listings[4];
  assert.equal(ndvcOrg.id, 'org_northern_districts_volleyball_club');
  assert.equal(ndvcOrg.entity_type, 'organizer');

  // Verify extractDistinctVenueName helper edge cases
  assert.equal(extractDistinctVenueName({ address: 'Perth Modern School', address2: '90 Roberts Rd' }, 'Chequers Volleyball Club'), 'Perth Modern School');
  assert.equal(extractDistinctVenueName({ address: '123 Roberts Road', address2: '' }, 'Bayswater Volleyball Club'), null);
  assert.equal(extractDistinctVenueName({ address: 'PO Box 456', address2: '' }, 'Northern Districts Volleyball Club'), null);
  assert.equal(extractDistinctVenueName({ address: 'Roberts Road', address2: '' }, 'Some Club'), null);
  assert.equal(extractDistinctVenueName({ address: 'Chequers Volleyball Club', address2: '90 Roberts Rd' }, 'Chequers Volleyball Club'), null);

  // Verify Firestore routing writes only to /organizers and /venues and zero docs to /activities
  const sanitizedListings = listings.map(item => sanitizeListing(item));
  const writtenPaths = [];
  const mockDb = {
    collection(colName) {
      return {
        doc(id) {
          return { id, colName, path: `${colName}/${id}` };
        }
      };
    },
    batch() {
      const ops = [];
      return {
        set(docRef, data, options) {
          ops.push({ docRef, data, options });
        },
        async commit() {
          for (const op of ops) {
            writtenPaths.push(op.docRef.path);
          }
        }
      };
    }
  };
  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });
  await adapter.batchUpsertListings(sanitizedListings);

  assert.equal(writtenPaths.filter(p => p.startsWith('activities/')).length, 0);
  assert.equal(writtenPaths.filter(p => p.startsWith('organizers/')).length, 3);
  assert.equal(writtenPaths.filter(p => p.startsWith('venues/')).length, 2);
});

test('Seam 6: Volleyball WA Crawler throws descriptive error on HTTP failure', async () => {
  const mockFailingFetch = async () => ({
    ok: false,
    status: 502,
    statusText: 'Bad Gateway'
  });

  const crawler = createVolleyballWaCrawler({ fetchFn: mockFailingFetch });
  await assert.rejects(
    () => crawler.fetchListings(),
    /Volleyball WA API responded with HTTP 502: Bad Gateway/
  );
});

test('Seam 6: Volleyball WA Crawler classifies multi-venue clubs (e.g. Fremantle Volleyball Club) into single Organizer and distinct school Venues', async () => {
  const multiVenuePayload = [
    {
      id: 40001,
      store: 'Fremantle Volleyball Club',
      address: 'Methodist Ladies College, 356 Stirling Hwy',
      address2: '',
      city: 'Claremont',
      state: 'WA',
      zip: '6010',
      country: 'Australia',
      lat: '-31.983000',
      lng: '115.779000',
      phone: '08 9430 0000',
      email: 'info@fremantlevolley.com',
      url: 'https://volleyballwa.com.au/places/fremantle-volleyball-club/',
      terms: 'Social Volley Centre, WA Volleyball Junior League',
      hours: '<table class="wpsl-opening-hours"><tr><td>Monday</td><td>9:00 AM – 5:00 PM</td></tr></table>'
    },
    {
      id: 40002,
      store: 'Fremantle Volleyball Club',
      address: 'Iona Presentation College, 33 Palmerston St',
      address2: '',
      city: 'Mosman Park',
      state: 'WA',
      zip: '6012',
      country: 'Australia',
      lat: '-32.012000',
      lng: '115.762000',
      phone: '08 9430 0000',
      email: 'info@fremantlevolley.com',
      url: 'https://volleyballwa.com.au/places/fremantle-volleyball-club/',
      terms: 'WA Volleyball Junior League, WA Volleyball League',
      hours: '<table class="wpsl-opening-hours"><tr><td>Monday</td><td>9:00 AM – 5:00 PM</td></tr></table>'
    }
  ];

  const crawler = createVolleyballWaCrawler({
    fetchFn: async () => ({
      ok: true,
      async json() {
        return multiVenuePayload;
      }
    })
  });

  const listings = await crawler.fetchListings();

  // Single deduplicated Organizer + 2 distinct school Venues = 3 total listings
  assert.equal(listings.length, 3);

  const organizers = listings.filter((item) => item.entity_type === 'organizer');
  const venues = listings.filter((item) => item.entity_type === 'venue');

  assert.equal(organizers.length, 1);
  assert.equal(organizers[0].id, 'org_fremantle_volleyball_club');
  assert.equal(organizers[0].name, 'Fremantle Volleyball Club');

  assert.equal(venues.length, 2);
  const mlcVenue = venues.find((v) => v.name === 'Methodist Ladies College');
  const ionaVenue = venues.find((v) => v.name === 'Iona Presentation College');

  assert.ok(mlcVenue, 'Must extract Methodist Ladies College as distinct venue');
  assert.ok(mlcVenue.id.startsWith('venue_methodist_ladies_college_'));
  assert.equal(mlcVenue.address, 'Methodist Ladies College, 356 Stirling Hwy, Claremont, WA 6010');

  assert.ok(ionaVenue, 'Must extract Iona Presentation College as distinct venue');
  assert.ok(ionaVenue.id.startsWith('venue_iona_presentation_college_'));
  assert.equal(ionaVenue.address, 'Iona Presentation College, 33 Palmerston St, Mosman Park, WA 6012');
});
