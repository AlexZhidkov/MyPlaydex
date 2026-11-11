import test from 'node:test';
import assert from 'node:assert/strict';
import { createDlgscCrawler, DLGSC_ENDPOINT } from '../src/crawlers/dlgsc-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';

test('Seam 5: DLGSC Crawler parses public club search JSON, filters for Greater Perth, and formats canonical listings', async () => {
  const mockPayload = {
    clubs: {
      totalcount: 3,
      morerecords: false,
      data: [
        {
          Id: 'dlgsc-uuid-001',
          Name: 'Subiaco Junior Soccer Club',
          RegisteredName: 'Subiaco Junior Soccer Club Inc',
          Sports: 'Soccer',
          Sports1: 'Soccer',
          Latitude: '-31.9445',
          Longitude: '115.8280',
          StreetAddress: 'Rosalie Park, Onslow Road',
          Suburb: 'Subiaco',
          PostalAddress: 'PO Box 123, Subiaco WA 6008',
          Email: 'info@subiacosoccer.org.au',
          Phone: '08 9381 0000',
          Mobile: '0400 111 222',
          Website: 'https://subiacosoccer.org.au',
          KidSport: 'Valid',
          ageGroups: {
            at0to12: true,
            at13to18: true,
            at19to30: false,
            at31to50: false,
            at51to99: false
          }
        },
        {
          // Regional WA club outside Greater Perth (Albany ~390km away) - must be filtered out
          Id: 'dlgsc-uuid-002',
          Name: 'Lower Great Southern Tennis Association',
          RegisteredName: 'Lower Great Southern Tennis Association',
          Sports: 'Tennis',
          Latitude: '-33.4067',
          Longitude: '115.6304',
          StreetAddress: 'ALBANY WA 6330',
          Suburb: 'Albany',
          Website: 'https://albanytennis.com.au'
        },
        {
          // Club with invalid or missing coordinates - must be filtered out
          Id: 'dlgsc-uuid-003',
          Name: 'No Coordinates Community Club',
          Sports: 'Basketball',
          Latitude: '',
          Longitude: '',
          StreetAddress: 'Perth WA 6000'
        }
      ]
    }
  };

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

  const crawler = createDlgscCrawler({ fetchFn: mockFetch });
  assert.equal(crawler.name, 'dlgsc');

  const listings = await crawler.fetchListings();

  // URL must include the required query params and trailing slash
  assert.ok(requestedUrl.startsWith(DLGSC_ENDPOINT));
  assert.ok(requestedUrl.includes('basic=true'));
  assert.ok(requestedHeaders['User-Agent']);

  // Only the Greater Perth club should be retained (1 out of 3)
  assert.equal(listings.length, 1);
  const raw = listings[0];

  assert.equal(raw.source, 'dlgsc');
  assert.equal(raw.source_id, 'dlgsc-uuid-001');
  assert.equal(raw.title, 'Subiaco Junior Soccer Club');
  assert.equal(raw.region_id, 'perth');
  assert.equal(raw.sport, 'Soccer');
  assert.equal(raw.category, 'sports');
  assert.equal(raw.subcategory, 'soccer');
  assert.equal(raw.venue_name, 'Rosalie Park, Onslow Road');
  assert.equal(raw.address, 'Rosalie Park, Onslow Road, Subiaco');
  assert.equal(raw.coordinates.lat, -31.9445);
  assert.equal(raw.coordinates.lng, 115.828);
  assert.equal(raw.source_url, 'https://subiacosoccer.org.au');
  assert.equal(raw.external_url, 'https://subiacosoccer.org.au');
  assert.equal(raw.organizer.name, 'Subiaco Junior Soccer Club');
  assert.equal(raw.organizer.website, 'https://subiacosoccer.org.au');
  assert.equal(raw.organizer.contact.email, 'info@subiacosoccer.org.au');
  assert.equal(raw.organizer.contact.phone, '08 9381 0000');
  assert.equal(raw.cost_description, 'KidSport eligible');
  assert.equal(raw.demographics.age, 'juniors');
  assert.equal(raw.schedule.recurrence, 'weekly');

  // Verify that the emitted listing sanitizes cleanly without error
  const sanitized = sanitizeActivity(raw);
  assert.equal(sanitized.id, 'dlgsc_dlgsc-uuid-001');
  assert.equal(sanitized.region_id, 'perth');
  assert.equal(sanitized.category, 'sports');
  assert.equal(sanitized.subcategory, 'soccer');
  assert.equal(sanitized.organizer.name, 'Subiaco Junior Soccer Club');
  assert.ok(sanitized.organizer.id.startsWith('org_'));
  assert.ok(sanitized.venue.id.startsWith('venue_'));
  assert.equal(sanitized.venue.coordinates.lat, -31.9445);
  assert.equal(sanitized.venue.coordinates.lng, 115.828);
  assert.equal(sanitized.venue.geohash.length, 9);
  assert.equal(sanitized.schedule.recurrence, 'weekly');
  assert.equal(sanitized.demographics.age, 'juniors');
});

test('Seam 5: DLGSC Crawler throws descriptive error on HTTP failure', async () => {
  const mockFailingFetch = async () => ({
    ok: false,
    status: 403,
    statusText: 'Forbidden'
  });

  const crawler = createDlgscCrawler({ fetchFn: mockFailingFetch });
  await assert.rejects(
    () => crawler.fetchListings(),
    /DLGSC API responded with HTTP 403: Forbidden/
  );
});
