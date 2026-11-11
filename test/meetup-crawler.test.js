import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMeetupCrawler,
  MEETUP_PERTH_SPORTS_URL,
  extractMeetupEventsFromNextData
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
