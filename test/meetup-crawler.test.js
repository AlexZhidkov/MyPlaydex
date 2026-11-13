import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMeetupCrawler,
  MEETUP_PERTH_SPORTS_URL,
  extractMeetupEventsFromNextData,
  resolveMeetupVenueCoordinates
} from '../src/crawlers/meetup-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';

const MOCK_MEETUP_SSR_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Sports & Fitness events in Perth | Meetup</title>
  <script id="__NEXT_DATA__" type="application/json">
  {
    "props": {
      "pageProps": {
        "__APOLLO_STATE__": {
          "ROOT_QUERY": {
            "__typename": "Query"
          },
          "Event:301001": {
            "__typename": "Event",
            "id": "301001",
            "title": "Perth Saturday Morning Social Badminton",
            "description": "Weekly casual badminton games for all skill levels at Kingsway.",
            "dateTime": "2026-11-14T09:00:00+08:00",
            "endTime": "2026-11-14T11:00:00+08:00",
            "eventUrl": "https://www.meetup.com/perth-social-racquets/events/301001/",
            "venue": {
              "__ref": "Venue:venue-kingsway"
            },
            "group": {
              "__ref": "Group:group-racquets"
            },
            "feeSettings": {
              "amount": 10.0,
              "currency": "AUD"
            }
          },
          "Venue:venue-kingsway": {
            "__typename": "Venue",
            "id": "venue-kingsway",
            "name": "Kingsway Indoor Stadium",
            "address": "130 Kingsway",
            "city": "Madeley",
            "lat": -31.8156,
            "lng": 115.8272
          },
          "Group:group-racquets": {
            "__typename": "Group",
            "id": "group-racquets",
            "name": "Perth Social Racquets & Fitness Club",
            "urlname": "perth-social-racquets"
          },
          "Event:301002": {
            "__typename": "Event",
            "id": "301002",
            "title": "Scarborough Beach Sunset Volleyball Scrimmage",
            "description": "Casual 4v4 beach volleyball games by the amphitheatre. Free to join!",
            "dateTime": "2026-11-15T17:00:00+08:00",
            "endTime": "2026-11-15T19:00:00+08:00",
            "eventUrl": "https://www.meetup.com/perth-beach-volleyball/events/301002/",
            "venue": {
              "name": "Scarborough Beach Courts",
              "address": "The Esplanade, Scarborough WA",
              "lat": -31.8942,
              "lng": 115.7571
            },
            "group": {
              "name": "Perth Beach Volleyballers",
              "urlname": "perth-beach-volleyball"
            },
            "feeSettings": null
          },
          "Event:301003": {
            "__typename": "Event",
            "id": "301003",
            "title": "Online Sports Strategy Hangout",
            "description": "Virtual discussion with no venue coordinates.",
            "dateTime": "2026-11-16T19:00:00+08:00",
            "eventUrl": "https://www.meetup.com/perth-sports/events/301003/",
            "venue": null
          }
        }
      }
    }
  }
  </script>
</head>
<body>
  <div>Meetup Content</div>
</body>
</html>
`;

test('Seam 9: Meetup Crawler parses SSR HTML with __NEXT_DATA__, resolves Apollo state, and maps canonical listings', async () => {
  let requestedUrl = null;
  let requestedHeaders = null;

  const mockFetch = async (url, options) => {
    requestedUrl = url;
    requestedHeaders = options?.headers;
    return {
      ok: true,
      status: 200,
      async text() {
        return MOCK_MEETUP_SSR_HTML;
      }
    };
  };

  const crawler = createMeetupCrawler({ fetchFn: mockFetch });
  assert.equal(crawler.name, 'meetup');

  const listings = await crawler.fetchListings();

  assert.equal(requestedUrl, MEETUP_PERTH_SPORTS_URL);
  assert.ok(requestedHeaders['User-Agent'], 'Must provide a browser User-Agent');
  assert.ok(requestedHeaders['Accept'], 'Must request HTML accept header');

  // Should extract 2 valid physical listings (the 3rd online event with null venue must be skipped)
  assert.equal(listings.length, 2);

  // 1st listing: Badminton at Kingsway with dereferenced Apollo venue and group
  const badminton = listings[0];
  assert.equal(badminton.source, 'meetup');
  assert.equal(badminton.source_id, '301001');
  assert.equal(badminton.title, 'Perth Saturday Morning Social Badminton');
  assert.equal(badminton.subcategory, 'other'); // badminton maps to 'other' or sport taxonomy
  assert.equal(badminton.venue_name, 'Kingsway Indoor Stadium');
  assert.ok(badminton.address.includes('130 Kingsway'));
  assert.equal(badminton.coordinates.lat, -31.8156);
  assert.equal(badminton.coordinates.lng, 115.8272);
  assert.equal(badminton.organizer.name, 'Perth Social Racquets & Fitness Club');
  assert.equal(badminton.organizer.website, 'https://www.meetup.com/perth-social-racquets');
  assert.equal(badminton.is_free, false);
  assert.equal(badminton.display_price, '$10.00 AUD');
  assert.equal(badminton.source_url, 'https://www.meetup.com/perth-social-racquets/events/301001/');

  // Verify sanitization
  const sanitizedBadminton = sanitizeActivity(badminton);
  assert.equal(sanitizedBadminton.id, 'meetup_301001');
  assert.equal(sanitizedBadminton.region_id, 'perth');
  assert.equal(sanitizedBadminton.cost.is_free, false);
  assert.equal(sanitizedBadminton.venue.geohash.length, 9);

  // 2nd listing: Beach Volleyball with inline venue and free feeSettings
  const volley = listings[1];
  assert.equal(volley.source, 'meetup');
  assert.equal(volley.source_id, '301002');
  assert.equal(volley.title, 'Scarborough Beach Sunset Volleyball Scrimmage');
  assert.equal(volley.subcategory, 'volleyball');
  assert.equal(volley.venue_name, 'Scarborough Beach Courts');
  assert.equal(volley.coordinates.lat, -31.8942);
  assert.equal(volley.coordinates.lng, 115.7571);
  assert.equal(volley.organizer.name, 'Perth Beach Volleyballers');
  assert.equal(volley.is_free, true);
  assert.equal(volley.display_price, 'Free');

  const sanitizedVolley = sanitizeActivity(volley);
  assert.equal(sanitizedVolley.id, 'meetup_301002');
  assert.equal(sanitizedVolley.subcategory, 'volleyball');
  assert.equal(sanitizedVolley.cost.is_free, true);
});

test('Seam 9: Meetup Crawler extracts activities from direct pageProps array format', async () => {
  const directArrayHtml = `
    <html>
      <head>
        <script id="__NEXT_DATA__" type="application/json">
        {
          "props": {
            "pageProps": {
              "events": [
                {
                  "id": "direct-event-1",
                  "title": "Kings Park Casual Walk & Run",
                  "description": "5km scenic run through Kings Park.",
                  "dateTime": "2026-11-20T07:30:00+08:00",
                  "eventUrl": "https://www.meetup.com/kings-park-runners/events/direct-event-1/",
                  "venue": {
                    "name": "Wadjuk Carpark",
                    "address": "Fraser Ave, Kings Park WA",
                    "lat": -31.961,
                    "lng": 115.842
                  },
                  "group": {
                    "name": "Kings Park Runners"
                  }
                }
              ]
            }
          }
        }
        </script>
      </head>
      <body>SSR</body>
    </html>
  `;

  const mockFetch = async () => ({
    ok: true,
    async text() {
      return directArrayHtml;
    }
  });

  const crawler = createMeetupCrawler({ fetchFn: mockFetch });
  const listings = await crawler.fetchListings();

  assert.equal(listings.length, 1);
  assert.equal(listings[0].title, 'Kings Park Casual Walk & Run');
  assert.equal(listings[0].subcategory, 'running');
  assert.equal(listings[0].coordinates.lat, -31.961);
});

test('Seam 9: Meetup Crawler extracts activities from Redux SSR window.__PRELOADED_STATE__ with epoch timestamp', async () => {
  const reduxHtml = `
    <html>
      <head>
        <script>
          window.__PRELOADED_STATE__ = {
            "search": {
              "results": [
                {
                  "id": "redux-event-1",
                  "title": "Perth Social Netball Scrimmage",
                  "description": "Casual mixed netball session.",
                  "time": 1794500000000,
                  "venue": {
                    "name": "Matthews Netball Centre",
                    "address": "Salvado Rd, Jolimont WA",
                    "lat": -31.942,
                    "lng": 115.803
                  },
                  "group": {
                    "name": "Perth Social Netball",
                    "urlname": "perth-netball"
                  }
                }
              ]
            }
          };
        </script>
      </head>
      <body>Redux SSR Content</body>
    </html>
  `;

  const mockFetch = async () => ({
    ok: true,
    async text() {
      return reduxHtml;
    }
  });

  const crawler = createMeetupCrawler({ fetchFn: mockFetch });
  const listings = await crawler.fetchListings();

  assert.equal(listings.length, 1);
  assert.equal(listings[0].title, 'Perth Social Netball Scrimmage');
  assert.equal(listings[0].source_id, 'redux-event-1');
  assert.ok(listings[0].start_time.includes('T'));
  assert.equal(listings[0].coordinates.lat, -31.942);

  const sanitized = sanitizeActivity(listings[0]);
  assert.equal(sanitized.id, 'meetup_redux-event-1');
  assert.ok(sanitized.schedule.start_time.includes(':'));
});

test('Seam 9: Meetup Crawler handles malformed __NEXT_DATA__ gracefully', async () => {
  const malformedHtml = `
    <html>
      <head>
        <script id="__NEXT_DATA__" type="application/json">
          { INVALID JSON }
        </script>
      </head>
      <body>No events</body>
    </html>
  `;

  const mockFetch = async () => ({
    ok: true,
    async text() {
      return malformedHtml;
    }
  });

  const crawler = createMeetupCrawler({ fetchFn: mockFetch });
  const listings = await crawler.fetchListings();
  assert.deepEqual(listings, []);
});

test('Seam 9: Meetup Crawler throws descriptive error on HTTP failure', async () => {
  const mockFailingFetch = async () => ({
    ok: false,
    status: 502,
    statusText: 'Bad Gateway'
  });

  const crawler = createMeetupCrawler({ fetchFn: mockFailingFetch });
  await assert.rejects(
    () => crawler.fetchListings(),
    /Meetup responded with HTTP 502: Bad Gateway/
  );
});

test('Seam 9 Regression: Meetup Crawler targets categoryId=482, resolves venues without lat/lng, and filters stubs/online/non-Perth events', async () => {
  assert.ok(MEETUP_PERTH_SPORTS_URL.includes('categoryId=482'), 'MEETUP_PERTH_SPORTS_URL must target Sports & Fitness (482)');

  const liveShapeHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <script id="__NEXT_DATA__" type="application/json">
        {
          "props": {
            "pageProps": {
              "userLocation": {
                "city": "Perth",
                "country": "au",
                "lat": -31.96,
                "lon": 115.84
              },
              "__APOLLO_STATE__": {
                "Event:401001": {
                  "__typename": "Event",
                  "id": "401001",
                  "title": "Perth WA Friday Indoor Soccer and Futsal",
                  "description": "Social indoor soccer at AH Sport.",
                  "dateTime": "2026-11-13T19:30:00+08:00",
                  "eventType": "PHYSICAL",
                  "eventUrl": "https://www.meetup.com/social-soccer-perth/events/401001/",
                  "group": {
                    "__typename": "Group",
                    "name": "Social Soccer Perth - AH Sport",
                    "urlname": "social-soccer-perth",
                    "timezone": "Australia/Perth"
                  },
                  "venue": {
                    "__typename": "Venue",
                    "name": "AH Sport",
                    "address": "6 Lucca Street, Churchlands",
                    "city": "Perth",
                    "state": "",
                    "country": "AU"
                  }
                },
                "Event:401002": {
                  "__typename": "Event",
                  "id": "401002",
                  "title": "Victoria Park Social Run",
                  "description": "Casual evening run.",
                  "dateTime": "2026-11-15T18:00:00+08:00",
                  "eventType": "PHYSICAL",
                  "eventUrl": "https://www.meetup.com/vic-park-runners/events/401002/",
                  "group": {
                    "__typename": "Group",
                    "name": "Vic Park Runners",
                    "urlname": "vic-park-runners",
                    "timezone": "Australia/Perth"
                  },
                  "venue": {
                    "__typename": "Venue",
                    "name": "McCallum Park",
                    "address": "901 Albany Hwy",
                    "city": "Victoria Park",
                    "state": "WA",
                    "country": "au"
                  }
                },
                "Event:401003": {
                  "__typename": "Event",
                  "id": "401003",
                  "title": "Lathlain Social Basketball",
                  "description": "Pickup basketball.",
                  "dateTime": "2026-11-16T19:00:00+08:00",
                  "eventType": "PHYSICAL",
                  "eventUrl": "https://www.meetup.com/lathlain-hoops/events/401003/",
                  "group": {
                    "__typename": "Group",
                    "name": "Lathlain Hoops",
                    "urlname": "lathlain-hoops",
                    "timezone": "Australia/Perth"
                  },
                  "venue": {
                    "__typename": "Venue",
                    "name": "Lathlain Court",
                    "address": "220 Great Eastern Hwy, Lathlain",
                    "city": "",
                    "state": "WA",
                    "country": "au"
                  }
                },
                "Event:401004-stub": {
                  "__typename": "Event",
                  "id": "401004-stub",
                  "dateTime": "2026-11-20T19:30:00+08:00"
                },
                "Event:401005-online": {
                  "__typename": "Event",
                  "id": "401005-online",
                  "title": "Online Stretching Session",
                  "dateTime": "2026-11-15T10:00:00+08:00",
                  "eventType": "ONLINE",
                  "group": {
                    "name": "Perth Fitness",
                    "timezone": "Australia/Perth"
                  },
                  "venue": {
                    "name": "Online event",
                    "address": "",
                    "city": "",
                    "state": "",
                    "country": ""
                  }
                },
                "Event:401006-melbourne": {
                  "__typename": "Event",
                  "id": "401006-melbourne",
                  "title": "Melbourne Run Club",
                  "dateTime": "2026-11-15T10:00:00+11:00",
                  "eventType": "PHYSICAL",
                  "group": {
                    "name": "Melbourne Runners",
                    "timezone": "Australia/Melbourne"
                  },
                  "venue": {
                    "name": "Tan Track",
                    "address": "Birdwood Ave",
                    "city": "Melbourne",
                    "state": "VIC",
                    "country": "AU"
                  }
                },
                "Event:401007-hobart": {
                  "__typename": "Event",
                  "id": "401007-hobart",
                  "title": "Hobart Social Walk",
                  "dateTime": "2026-11-15T10:00:00+08:00",
                  "eventType": "PHYSICAL",
                  "group": {
                    "name": "Hobart Walkers"
                  },
                  "venue": {
                    "name": "Bierhalle",
                    "address": "124 Davey st",
                    "city": "hobart",
                    "state": "",
                    "country": "AU"
                  }
                }
              }
            }
          }
        }
        </script>
      </head>
      <body>Meetup Live Shape</body>
    </html>
  `;

  const mockFetch = async (url) => {
    assert.equal(url, MEETUP_PERTH_SPORTS_URL);
    return {
      ok: true,
      status: 200,
      async text() {
        return liveShapeHtml;
      }
    };
  };

  const crawler = createMeetupCrawler({ fetchFn: mockFetch });
  const listings = await crawler.fetchListings();

  assert.equal(listings.length, 3, 'Should extract only the 3 physical Perth events');

  const soccer = listings.find(l => l.source_id === '401001');
  assert.ok(soccer);
  assert.equal(soccer.subcategory, 'soccer');
  assert.equal(soccer.coordinates.lat, -31.9505);
  assert.equal(soccer.coordinates.lng, 115.8605);

  const vicPark = listings.find(l => l.source_id === '401002');
  assert.ok(vicPark);
  assert.equal(vicPark.coordinates.lat, -31.9753);
  assert.equal(vicPark.coordinates.lng, 115.8978);

  const lathlain = listings.find(l => l.source_id === '401003');
  assert.ok(lathlain);
  assert.equal(lathlain.coordinates.lat, -31.9694);
  assert.equal(lathlain.coordinates.lng, 115.9039);

  for (const listing of listings) {
    const sanitized = sanitizeActivity(listing);
    assert.equal(sanitized.region_id, 'perth');
    assert.equal(sanitized.venue.geohash.length, 9);
  }

  // Direct helper assertions for postcode and fallback behavior
  assert.deepEqual(
    resolveMeetupVenueCoordinates({ name: 'Venue 6018', address: '123 Street, 6018', city: '' }),
    { lat: -31.8967, lng: 115.7956 } // first 6018 suburb (Innaloo)
  );
  assert.deepEqual(
    resolveMeetupVenueCoordinates({ name: 'Mystery Park', address: '10 Nowhere Rd', city: '' }, { lat: -31.96, lng: 115.84 }),
    { lat: -31.96, lng: 115.84 }
  );
  assert.equal(resolveMeetupVenueCoordinates({ name: 'Online event', city: 'Perth' }), null);
  assert.equal(resolveMeetupVenueCoordinates({ name: 'Bierhalle', city: 'hobart' }), null);
});
