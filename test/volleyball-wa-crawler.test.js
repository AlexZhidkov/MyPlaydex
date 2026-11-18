import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVolleyballWaCrawler,
  extractDistinctVenueName,
  VOLLEYBALL_WA_ENDPOINT
} from '../src/crawlers/volleyball-wa-crawler.js';
import { sanitizeOrganizer, sanitizeVenue, sanitizeListing } from '../src/sanitizer.js';
import { createFirestoreAdapter } from '../src/firestore-adapter.js';

test('Seam 6: Volleyball WA Crawler emits only Organizer records and no standalone Venue listings or synthetic activities', async () => {
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

  // 3 club Organizers (Chequers, Bayswater, Northern Districts); centres (The HUB) and distinct school venues are NOT emitted
  assert.equal(listings.length, 3);
  assert.equal(listings.filter((item) => item.entity_type === 'venue').length, 0);

  // None of the listings should generate synthetic weekly activities
  for (const item of listings) {
    assert.equal(item.schedule, undefined);
    assert.equal(item.entity_type, 'organizer');
  }

  // 1. Club record -> Organizer Listing only (no distinct Venue Listing)
  const chequersOrg = listings[0];
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

  // 2. Clubs without distinct venue names emit Organizer only
  const bayswaterOrg = listings[1];
  assert.equal(bayswaterOrg.id, 'org_bayswater_volleyball_club');
  assert.equal(bayswaterOrg.entity_type, 'organizer');

  const ndvcOrg = listings[2];
  assert.equal(ndvcOrg.id, 'org_northern_districts_volleyball_club');
  assert.equal(ndvcOrg.entity_type, 'organizer');

  // Verify extractDistinctVenueName helper edge cases remain intact
  assert.equal(extractDistinctVenueName({ address: 'Perth Modern School', address2: '90 Roberts Rd' }, 'Chequers Volleyball Club'), 'Perth Modern School');
  assert.equal(extractDistinctVenueName({ address: '123 Roberts Road', address2: '' }, 'Bayswater Volleyball Club'), null);
  assert.equal(extractDistinctVenueName({ address: 'PO Box 456', address2: '' }, 'Northern Districts Volleyball Club'), null);
  assert.equal(extractDistinctVenueName({ address: 'Roberts Road', address2: '' }, 'Some Club'), null);
  assert.equal(extractDistinctVenueName({ address: 'Chequers Volleyball Club', address2: '90 Roberts Rd' }, 'Chequers Volleyball Club'), null);

  // Verify Firestore routing writes only to /organizers and zero docs to /venues or /activities
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
  assert.equal(writtenPaths.filter(p => p.startsWith('venues/')).length, 0);
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

test('Seam 6: Volleyball WA Crawler deduplicates multi-venue clubs (e.g. Fremantle Volleyball Club) into a single Organizer without emitting Venues', async () => {
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

  // Single deduplicated Organizer and 0 Venues = 1 total listing
  assert.equal(listings.length, 1);

  const organizers = listings.filter((item) => item.entity_type === 'organizer');
  const venues = listings.filter((item) => item.entity_type === 'venue');

  assert.equal(organizers.length, 1);
  assert.equal(organizers[0].id, 'org_fremantle_volleyball_club');
  assert.equal(organizers[0].name, 'Fremantle Volleyball Club');
  assert.equal(venues.length, 0);
});
