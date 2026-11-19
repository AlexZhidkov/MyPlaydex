import test from 'node:test';
import assert from 'node:assert/strict';
import { createDlgscCrawler, DLGSC_ENDPOINT } from '../src/crawlers/dlgsc-crawler.js';
import { sanitizeOrganizer, sanitizeListing } from '../src/sanitizer.js';
import { createFirestoreAdapter } from '../src/firestore-adapter.js';

test('Seam 5: DLGSC Crawler parses public club search JSON, filters for Greater Perth, and emits canonical Organizer Listings', async () => {
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

  assert.equal(raw.id, 'org_subiaco_junior_soccer_club');
  assert.equal(raw.entity_type, 'organizer');
  assert.equal(raw.source, 'dlgsc');
  assert.equal(raw.source_id, 'dlgsc-uuid-001');
  assert.equal(raw.name, 'Subiaco Junior Soccer Club');
  assert.equal(raw.region_id, 'perth');
  assert.equal(raw.category, 'sports');
  assert.equal(raw.subcategory, 'soccer');
  assert.deepEqual(raw.subcategories, ['soccer']);
  assert.equal(raw.address, 'Rosalie Park, Onslow Road, Subiaco');
  assert.deepEqual(raw.coordinates, { lat: -31.9445, lng: 115.828 });
  assert.equal(raw.geohash.length, 9);
  assert.equal(raw.website, 'https://subiacosoccer.org.au');
  assert.equal(raw.contact.email, 'info@subiacosoccer.org.au');
  assert.equal(raw.contact.phone, '08 9381 0000');
  assert.equal(raw.cost_description, 'KidSport eligible');
  assert.deepEqual(raw.demographics, { gender: 'all', age: 'juniors' });
  assert.equal(raw.source_url, 'https://subiacosoccer.org.au');
  assert.equal(raw.raw_source_url, 'https://subiacosoccer.org.au');

  // Must not fabricate synthetic weekly activities or placeholder "<Organizer> Venue" records
  assert.equal(raw.schedule, undefined);
  assert.equal(raw.venue, undefined);
  assert.equal(raw.venue_name, undefined);

  // Verify that the emitted listing sanitizes cleanly via sanitizeOrganizer and sanitizeListing
  const sanitized = sanitizeOrganizer(raw);
  assert.equal(sanitized.id, 'org_subiaco_junior_soccer_club');
  assert.equal(sanitized.name, 'Subiaco Junior Soccer Club');
  assert.equal(sanitized.region_id, 'perth');
  assert.equal(sanitized.category, 'sports');
  assert.equal(sanitized.subcategory, 'soccer');
  assert.deepEqual(sanitized.subcategories, ['soccer']);
  assert.deepEqual(sanitized.coordinates, { lat: -31.9445, lng: 115.828 });
  assert.equal(sanitized.geohash.length, 9);
  assert.equal(sanitized.address, 'Rosalie Park, Onslow Road, Subiaco');
  assert.equal(sanitized.website, 'https://subiacosoccer.org.au');
  assert.deepEqual(sanitized.contact, { email: 'info@subiacosoccer.org.au', phone: '08 9381 0000', facebook: null });
  assert.equal(sanitized.cost_description, 'KidSport eligible');
  assert.deepEqual(sanitized.demographics, { gender: 'all', age: 'juniors' });
  assert.equal(sanitized.source_url, 'https://subiacosoccer.org.au');
  assert.equal(sanitized.raw_source_url, 'https://subiacosoccer.org.au');
  assert.equal(sanitized.schedule, undefined);

  const sanitizedViaListing = sanitizeListing(raw);
  assert.equal(sanitizedViaListing.id, 'org_subiaco_junior_soccer_club');

  // Verify Firestore routing writes strictly to /organizers and zero docs to /activities or /venues
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
  await adapter.batchUpsertListings([sanitizedViaListing]);

  assert.deepEqual(writtenPaths, ['organizers/org_subiaco_junior_soccer_club']);
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

test('Seam 5 (Issue #19): DLGSC Crawler extracts Facebook into contact.facebook and uses it as source_url fallback ahead of KidSport', async () => {
  const mockPayload = {
    clubs: {
      totalcount: 3,
      morerecords: false,
      data: [
        {
          Id: 'org-with-both',
          Name: 'Perth Tennis Organizer',
          Sports: 'Tennis',
          Latitude: '-31.9505',
          Longitude: '115.8605',
          Website: 'https://perthtennis.org.au',
          Facebook: 'm.facebook.com/PerthTennisOrganizer?ref=bookmarks'
        },
        {
          Id: 'org-fb-only',
          Name: 'Perth Badminton Organizer',
          Sports: 'Badminton',
          Latitude: '-31.9510',
          Longitude: '115.8610',
          Website: '',
          Facebook: 'http://fb.me/PerthBadminton?fbclid=IwAR123'
        },
        {
          Id: 'org-neither',
          Name: 'Perth Squash Organizer',
          Sports: 'Squash',
          Latitude: '-31.9520',
          Longitude: '115.8620',
          Website: '',
          Facebook: 'https://www.facebook.com/login'
        }
      ]
    }
  };

  const crawler = createDlgscCrawler({
    fetchFn: async () => ({
      ok: true,
      async json() {
        return mockPayload;
      }
    })
  });

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 3);

  const both = listings.find(l => l.source_id === 'org-with-both');
  assert.equal(both.contact.facebook, 'https://www.facebook.com/PerthTennisOrganizer');
  assert.equal(both.source_url, 'https://perthtennis.org.au');
  assert.equal(both.raw_source_url, 'https://perthtennis.org.au');

  const fbOnly = listings.find(l => l.source_id === 'org-fb-only');
  assert.equal(fbOnly.website, null);
  assert.equal(fbOnly.contact.facebook, 'https://www.facebook.com/PerthBadminton');
  assert.equal(fbOnly.source_url, 'https://www.facebook.com/PerthBadminton');
  assert.equal(fbOnly.raw_source_url, 'https://www.facebook.com/PerthBadminton');

  const neither = listings.find(l => l.source_id === 'org-neither');
  assert.equal(neither.contact.facebook, null);
  assert.equal(neither.source_url, 'https://kidsport.dlgsc.wa.gov.au/find-a-club/?club=org-neither');
  assert.equal(neither.raw_source_url, 'https://kidsport.dlgsc.wa.gov.au/find-a-club/?club=org-neither');
});

test('Seam 5: DLGSC Crawler paginates past 3 pages by default until morerecords is false', async () => {
  const requestedPages = [];
  const pages = {
    1: {
      clubs: {
        morerecords: true,
        data: [
          {
            Id: 'dlgsc-page-1',
            Name: 'Perth Club Page 1',
            Sports: 'Soccer',
            Latitude: '-31.9505',
            Longitude: '115.8605'
          }
        ]
      }
    },
    2: {
      clubs: {
        morerecords: true,
        data: [
          {
            Id: 'dlgsc-page-2',
            Name: 'Perth Club Page 2',
            Sports: 'Tennis',
            Latitude: '-31.9510',
            Longitude: '115.8610'
          }
        ]
      }
    },
    3: {
      clubs: {
        morerecords: true,
        data: [
          {
            Id: 'dlgsc-page-3',
            Name: 'Perth Club Page 3',
            Sports: 'Basketball',
            Latitude: '-31.9515',
            Longitude: '115.8615'
          }
        ]
      }
    },
    4: {
      clubs: {
        morerecords: true,
        data: [
          {
            Id: 'dlgsc-page-4',
            Name: 'Perth Club Page 4',
            Sports: 'Volleyball',
            Latitude: '-31.9520',
            Longitude: '115.8620',
            Facebook: 'https://www.facebook.com/PerthClubPage4'
          }
        ]
      }
    },
    5: {
      clubs: {
        morerecords: false,
        data: [
          {
            Id: 'dlgsc-page-5',
            Name: 'Perth Club Page 5',
            Sports: 'Badminton',
            Latitude: '-31.9525',
            Longitude: '115.8625'
          }
        ]
      }
    }
  };

  const crawler = createDlgscCrawler({
    fetchFn: async (url) => {
      const parsed = new URL(url);
      const page = Number(parsed.searchParams.get('page'));
      requestedPages.push(page);
      return {
        ok: true,
        async json() {
          return pages[page] || { clubs: { morerecords: false, data: [] } };
        }
      };
    }
  });

  const listings = await crawler.fetchListings();
  assert.deepEqual(requestedPages, [1, 2, 3, 4, 5]);
  assert.equal(listings.length, 5);
  assert.deepEqual(
    listings.map(l => l.source_id),
    ['dlgsc-page-1', 'dlgsc-page-2', 'dlgsc-page-3', 'dlgsc-page-4', 'dlgsc-page-5']
  );
  assert.equal(listings[3].contact.facebook, 'https://www.facebook.com/PerthClubPage4');
});

test('Seam 5: DLGSC Crawler repairs malformed JSON with unescaped quotes, backslashes, and raw newlines', async () => {
  const malformedRawPayload = `{
  "clubs": {
    "totalcount": 2,
    "morerecords": false,
    "data": [
      {
        "Id": "dlgsc-malformed-1",
        "Name": "Perth \\"A\\" & "B" Volleyball Club",
        "Sports": "Volleyball",
        "Latitude": "-31.9505",
        "Longitude": "115.8605",
        "StreetAddress": "Lot 12 "The Arena" Road",
        "Suburb": "Perth",
        "Website": "https://www.facebook.com/perthvolley\\",
        "PostalAddress": "PO Box 10\\nPerth\\South"
      },
      {
        "Id": "dlgsc-malformed-2",
        "Name": "Subiaco Social Netball",
        "Sports": "Netball",
        "Latitude": "-31.9445",
        "Longitude": "115.8280",
        "StreetAddress": "Rosalie Park,
Onslow Road",
        "Suburb": "Subiaco",
        "PostalAddress": "Level 1
PO Box 456, Subiaco WA 6008"
      }
    ]
  }
}`;

  const crawler = createDlgscCrawler({
    fetchFn: async () => ({
      ok: true,
      async text() {
        return malformedRawPayload;
      }
    })
  });

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 2);

  const first = listings[0];
  assert.equal(first.source_id, 'dlgsc-malformed-1');
  assert.equal(first.name, 'Perth "A" & "B" Volleyball Club');
  assert.equal(first.address, 'Lot 12 "The Arena" Road, Perth');
  assert.equal(first.contact.facebook, 'https://www.facebook.com/perthvolley/');

  const second = listings[1];
  assert.equal(second.source_id, 'dlgsc-malformed-2');
  assert.equal(second.name, 'Subiaco Social Netball');
  assert.equal(second.address, 'Rosalie Park,\nOnslow Road, Subiaco');
});

test('Seam 5: DLGSC Crawler falls back to per-club recovery when a single record is irreconcilable', async () => {
  const mixedPayload = `{
  "clubs": {
    "morerecords": false,
    "data": [
      {
        "Id": "dlgsc-healthy-1",
        "Name": "Healthy Club One",
        "Sports": "Soccer",
        "Latitude": "-31.9505",
        "Longitude": "115.8605",
        "Facebook": "https://www.facebook.com/HealthyClubOne"
      },
      {
        "Id": "dlgsc-broken-2",
        "Name": unquoted_corrupt_value,
        "Latitude": "-31.9510",
        "Longitude": "115.8610"
      },
      {
        "Id": "dlgsc-healthy-3",
        "Name": "Healthy "Club" Three",
        "Sports": "Tennis",
        "Latitude": "-31.9520",
        "Longitude": "115.8620"
      }
    ]
  }
}`;

  const crawler = createDlgscCrawler({
    fetchFn: async () => ({
      ok: true,
      async text() {
        return mixedPayload;
      }
    })
  });

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 2);
  assert.deepEqual(
    listings.map(l => l.source_id),
    ['dlgsc-healthy-1', 'dlgsc-healthy-3']
  );
  assert.equal(listings[0].contact.facebook, 'https://www.facebook.com/HealthyClubOne');
  assert.equal(listings[1].name, 'Healthy "Club" Three');
});
