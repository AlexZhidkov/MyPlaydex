import test from 'node:test';
import assert from 'node:assert/strict';
import { createVolleyballWaCrawler, VOLLEYBALL_WA_ENDPOINT } from '../src/crawlers/volleyball-wa-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';

test('Seam 6: Volleyball WA Crawler queries AJAX directory endpoint, formats venues and sessions, and maps canonical listings', async () => {
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

  // Records with missing coordinates dropped (2 of 3 retained)
  assert.equal(listings.length, 2);

  const raw1 = listings[0];
  assert.equal(raw1.source, 'volleyball_wa');
  assert.equal(raw1.source_id, '30092');
  assert.equal(raw1.title, 'The HUB');
  assert.equal(raw1.region_id, 'perth');
  assert.equal(raw1.sport, 'volleyball');
  assert.equal(raw1.category, 'sports');
  assert.equal(raw1.subcategory, 'volleyball');
  assert.equal(raw1.venue_name, 'The HUB');
  assert.equal(raw1.address, 'Inner City Beach, 180 Charles St, West Perth, WA 6005');
  assert.equal(raw1.coordinates.lat, -31.941599);
  assert.equal(raw1.coordinates.lng, 115.847653);
  assert.equal(raw1.source_url, 'https://volleyballwa.com.au/social-volley/');
  assert.equal(raw1.external_url, 'https://volleyballwa.com.au/social-volley/');
  assert.equal(raw1.organizer.name, 'The HUB');
  assert.equal(raw1.organizer.website, 'https://volleyballwa.com.au/social-volley/');
  assert.equal(raw1.organizer.contact.phone, '08 9228 8522');
  assert.equal(raw1.organizer.contact.email, 'info@volleyballwa.com.au');
  assert.equal(raw1.schedule.recurrence, 'weekly');
  assert.equal(raw1.demographics.gender, 'all');
  assert.equal(raw1.demographics.age, 'all');

  // Verify that listing sanitizes cleanly into canonical ActivityDocument
  const sanitized1 = sanitizeActivity(raw1);
  assert.equal(sanitized1.id, 'volleyball_wa_30092');
  assert.equal(sanitized1.region_id, 'perth');
  assert.equal(sanitized1.category, 'sports');
  assert.equal(sanitized1.subcategory, 'volleyball');
  assert.equal(sanitized1.organizer.name, 'The HUB');
  assert.ok(sanitized1.organizer.id.startsWith('org_'));
  assert.ok(sanitized1.venue.id.startsWith('venue_'));
  assert.equal(sanitized1.venue.coordinates.lat, -31.941599);
  assert.equal(sanitized1.venue.coordinates.lng, 115.847653);
  assert.equal(sanitized1.venue.geohash.length, 9);
  assert.equal(sanitized1.schedule.recurrence, 'weekly');

  const raw2 = listings[1];
  assert.equal(raw2.source_id, '34912');
  assert.equal(raw2.title, 'Chequers Volleyball Club');
  assert.equal(raw2.coordinates.lat, -31.944988);
  assert.equal(raw2.coordinates.lng, 115.83866);
  assert.equal(raw2.organizer.contact.email, 'contact@chequers.org.au');

  const sanitized2 = sanitizeActivity(raw2);
  assert.equal(sanitized2.id, 'volleyball_wa_34912');
  assert.equal(sanitized2.subcategory, 'volleyball');
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
