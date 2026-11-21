import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEventbriteCrawler,
  EVENTBRITE_PERTH_FEEDS,
  EVENTBRITE_PERTH_SPORTS_URL,
  extractEventbritePageCount,
  extractJsonLdEvents
} from '../src/crawlers/eventbrite-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';

const MOCK_EVENTBRITE_HTML = `
<!DOCTYPE html>
<html lang="en-AU">
<head>
  <title>Perth Sports & Fitness Events | Eventbrite</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "itemListElement": [
      {
        "@type": "ListItem",
        "position": 1,
        "item": {
          "@type": "Event",
          "name": "Perth Social Run Club - Kings Park 5K",
          "description": "Weekly casual morning run around Kings Park followed by coffee.",
          "url": "https://www.eventbrite.com.au/e/perth-social-run-club-tickets-101010101",
          "startDate": "2026-11-15T08:00:00+08:00",
          "endDate": "2026-11-15T09:30:00+08:00",
          "location": {
            "@type": "Place",
            "name": "Kings Park War Memorial",
            "address": {
              "@type": "PostalAddress",
              "streetAddress": "Fraser Ave",
              "addressLocality": "Perth",
              "addressRegion": "WA",
              "postalCode": "6005",
              "addressCountry": "AU"
            },
            "geo": {
              "@type": "GeoCoordinates",
              "latitude": -31.9608,
              "longitude": 115.8447
            }
          },
          "organizer": {
            "@type": "Organization",
            "name": "Perth Running Collective",
            "url": "https://www.eventbrite.com.au/o/perth-running-collective-987654321"
          },
          "offers": {
            "@type": "Offer",
            "price": "0",
            "priceCurrency": "AUD",
            "isAccessibleForFree": true,
            "url": "https://www.eventbrite.com.au/e/perth-social-run-club-tickets-101010101"
          }
        }
      },
      {
        "@type": "ListItem",
        "position": 2,
        "item": {
          "@type": "Event",
          "name": "Perth Casual Basketball Scrimmage",
          "description": "Open social scrimmage for intermediate basketball players.",
          "url": "https://www.eventbrite.com.au/e/perth-casual-basketball-scrimmage-tickets-202020202",
          "startDate": "2026-11-16T18:00:00+08:00",
          "endDate": "2026-11-16T20:00:00+08:00",
          "location": {
            "@type": "Place",
            "name": "Loftus Recreation Centre",
            "address": "99 Loftus St, Leederville WA 6007",
            "geo": {
              "@type": "GeoCoordinates",
              "latitude": "-31.9365",
              "longitude": "115.8432"
            }
          },
          "organizer": {
            "@type": "Organization",
            "name": "Perth Social Hoops",
            "url": "https://www.eventbrite.com.au/o/perth-social-hoops-12345"
          },
          "offers": [
            {
              "@type": "Offer",
              "price": "12.50",
              "priceCurrency": "AUD",
              "isAccessibleForFree": false
            }
          ]
        }
      },
      {
        "@type": "ListItem",
        "position": 3,
        "item": {
          "@type": "Event",
          "name": "Online Sports Fitness Webinar",
          "description": "Virtual webinar with no physical location or coordinates.",
          "url": "https://www.eventbrite.com.au/e/online-sports-webinar-tickets-303030303",
          "startDate": "2026-11-17T19:00:00+08:00"
        }
      }
    ]
  }
  </script>
  <!-- Secondary JSON-LD block with a single Event -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Event",
    "name": "Scarborough Beach Sunset Yoga",
    "description": "Community sunset yoga session on Scarborough Beach amphitheatre.",
    "url": "https://www.eventbrite.com.au/e/scarborough-sunset-yoga-tickets-404040404",
    "startDate": "2026-11-18T18:30:00+08:00",
    "location": {
      "@type": "Place",
      "name": "Scarborough Beach Amphitheatre",
      "address": "The Esplanade, Scarborough WA 6019",
      "geo": {
        "@type": "GeoCoordinates",
        "latitude": -31.8942,
        "longitude": 115.7571
      }
    },
    "organizer": "Scarborough Community Fitness",
    "isAccessibleForFree": true
  }
  </script>
</head>
<body>
  <div>Eventbrite Directory Body Content</div>
</body>
</html>
`;

test('Seam 8: Eventbrite Crawler parses HTML, extracts Schema.org Event JSON-LD, and maps canonical listings', async () => {
  let requestedUrl = null;
  let requestedHeaders = null;

  const mockFetch = async (url, options) => {
    requestedUrl = url;
    requestedHeaders = options?.headers;
    return {
      ok: true,
      status: 200,
      async text() {
        return MOCK_EVENTBRITE_HTML;
      }
    };
  };

  const crawler = createEventbriteCrawler({
    fetchFn: mockFetch,
    now: new Date('2026-11-10T00:00:00+08:00')
  });
  assert.equal(crawler.name, 'eventbrite');

  const listings = await crawler.fetchListings();

  assert.equal(requestedUrl, EVENTBRITE_PERTH_SPORTS_URL);
  assert.ok(requestedHeaders['User-Agent'], 'Must provide a valid User-Agent');
  assert.ok(requestedHeaders['Accept'], 'Must request HTML accept header');

  // Should extract 3 valid physical events (the 3rd item has no coordinates so it is skipped)
  assert.equal(listings.length, 3);

  // 1st listing: Free Run Club
  const runClub = listings[0];
  assert.equal(runClub.source, 'eventbrite');
  assert.equal(runClub.source_id, '101010101');
  assert.equal(runClub.title, 'Perth Social Run Club - Kings Park 5K');
  assert.equal(runClub.subcategory, 'running');
  assert.equal(runClub.venue_name, 'Kings Park War Memorial');
  assert.ok(runClub.address.includes('Fraser Ave'));
  assert.equal(runClub.coordinates.lat, -31.9608);
  assert.equal(runClub.coordinates.lng, 115.8447);
  assert.equal(runClub.organizer.name, 'Perth Running Collective');
  assert.equal(runClub.organizer.website, 'https://www.eventbrite.com.au/o/perth-running-collective-987654321');
  assert.equal(runClub.is_free, true);
  assert.equal(runClub.display_price, 'Free');
  assert.equal(runClub.source_url, 'https://www.eventbrite.com.au/e/perth-social-run-club-tickets-101010101');

  // Verify sanitization
  const sanitizedRun = sanitizeActivity(runClub);
  assert.equal(sanitizedRun.id, 'eventbrite_101010101');
  assert.equal(sanitizedRun.region_id, 'perth');
  assert.equal(sanitizedRun.subcategory, 'running');
  assert.equal(sanitizedRun.cost.is_free, true);
  assert.equal(sanitizedRun.venue.geohash.length, 9);

  // 2nd listing: Paid Basketball Scrimmage
  const hoops = listings[1];
  assert.equal(hoops.source, 'eventbrite');
  assert.equal(hoops.source_id, '202020202');
  assert.equal(hoops.title, 'Perth Casual Basketball Scrimmage');
  assert.equal(hoops.subcategory, 'basketball');
  assert.equal(hoops.venue_name, 'Loftus Recreation Centre');
  assert.equal(hoops.coordinates.lat, -31.9365);
  assert.equal(hoops.coordinates.lng, 115.8432);
  assert.equal(hoops.is_free, false);
  assert.equal(hoops.display_price, '$12.50 AUD');

  const sanitizedHoops = sanitizeActivity(hoops);
  assert.equal(sanitizedHoops.id, 'eventbrite_202020202');
  assert.equal(sanitizedHoops.cost.is_free, false);

  // 3rd listing: Standalone single Event from 2nd script tag
  const yoga = listings[2];
  assert.equal(yoga.source, 'eventbrite');
  assert.equal(yoga.source_id, '404040404');
  assert.equal(yoga.title, 'Scarborough Beach Sunset Yoga');
  assert.equal(yoga.coordinates.lat, -31.8942);
  assert.equal(yoga.coordinates.lng, 115.7571);
  assert.equal(yoga.organizer.name, 'Scarborough Community Fitness');
  assert.equal(yoga.is_free, true);

  const sanitizedYoga = sanitizeActivity(yoga);
  assert.equal(sanitizedYoga.id, 'eventbrite_404040404');
});

test('Seam 8: Eventbrite Crawler handles object country in address and date-only strings', async () => {
  const htmlWithObjCountry = `
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Event",
            "name": "Perth Beach Volleyball Tournament",
            "url": "https://www.eventbrite.com.au/e/volleyball-tournament-606060606",
            "startDate": "2026-11-25",
            "location": {
              "@type": "Place",
              "name": "City Beach Courts",
              "address": {
                "streetAddress": "Challenger Parade",
                "addressLocality": "City Beach",
                "addressCountry": {
                  "@type": "Country",
                  "name": "Australia"
                }
              },
              "geo": { "latitude": -31.936, "longitude": 115.755 }
            }
          }
        </script>
      </head>
      <body>Events</body>
    </html>
  `;

  const mockFetch = async () => ({
    ok: true,
    async text() {
      return htmlWithObjCountry;
    }
  });

  const crawler = createEventbriteCrawler({
    fetchFn: mockFetch,
    now: new Date('2026-11-10T00:00:00+08:00')
  });
  const listings = await crawler.fetchListings();

  assert.equal(listings.length, 1);
  assert.equal(listings[0].title, 'Perth Beach Volleyball Tournament');
  assert.ok(listings[0].address.includes('Australia'));
  assert.ok(!listings[0].address.includes('[object Object]'));
  assert.equal(listings[0].start_date, '2026-11-25');
  assert.equal(listings[0].start_time, null);

  const sanitized = sanitizeActivity(listings[0]);
  assert.equal(sanitized.schedule.start_date, '2026-11-25');
});

test('Seam 8: Eventbrite Crawler handles malformed JSON-LD and missing scripts gracefully', async () => {
  const htmlWithMalformedJson = `
    <html>
      <head>
        <script type="application/ld+json">
          { malformed json ::: invalid }
        </script>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Event",
            "name": "Perth Beach Volleyball",
            "url": "https://www.eventbrite.com.au/e/volleyball-505050505",
            "startDate": "2026-11-20T10:00:00+08:00",
            "location": {
              "@type": "Place",
              "name": "City Beach Courts",
              "geo": { "latitude": -31.936, "longitude": 115.755 }
            }
          }
        </script>
      </head>
      <body>Empty</body>
    </html>
  `;

  const mockFetch = async () => ({
    ok: true,
    async text() {
      return htmlWithMalformedJson;
    }
  });

  const crawler = createEventbriteCrawler({
    fetchFn: mockFetch,
    now: new Date('2026-11-10T00:00:00+08:00')
  });
  const listings = await crawler.fetchListings();

  assert.equal(listings.length, 1);
  assert.equal(listings[0].title, 'Perth Beach Volleyball');
  assert.equal(listings[0].source_id, '505050505');
});

test('Seam 8: Eventbrite Crawler throws descriptive error on HTTP failure', async () => {
  const mockFailingFetch = async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests'
  });

  const crawler = createEventbriteCrawler({
    fetchFn: mockFailingFetch,
    now: new Date('2026-11-10T00:00:00+08:00')
  });
  await assert.rejects(
    () => crawler.fetchListings(),
    /Eventbrite responded with HTTP 429: Too Many Requests/
  );
});

test('Seam 8 (Issue #32): Dual extraction merges window.__SERVER_DATA__ and *Event/@type array JSON-LD by source_id with zero detail-page requests', async () => {
  const requestedUrls = [];
  const html = `
    <html>
      <head>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "ItemList",
            "itemListElement": [
              {
                "@type": "ListItem",
                "position": 1,
                "item": {
                  "@type": "SportsEvent",
                  "name": "Fremantle Twilight Touch Rugby",
                  "description": "Social mixed touch rugby by the river.",
                  "url": "https://www.eventbrite.com.au/e/fremantle-touch-tickets-701701701",
                  "startDate": "2026-12-01T18:00:00+08:00",
                  "location": {
                    "@type": "Place",
                    "name": "Fremantle Oval",
                    "address": {
                      "@type": "PostalAddress",
                      "streetAddress": "70 Parry St",
                      "addressLocality": "Fremantle",
                      "addressRegion": "WA",
                      "postalCode": "6160",
                      "addressCountry": "AU"
                    },
                    "geo": { "@type": "GeoCoordinates", "latitude": -32.0569, "longitude": 115.7479 }
                  }
                }
              },
              {
                "@type": "ListItem",
                "position": 2,
                "item": {
                  "@type": ["Event", "MusicEvent"],
                  "name": "Northbridge Jazz & Wine Night",
                  "url": "https://www.eventbrite.com.au/e/northbridge-jazz-tickets-702702702",
                  "startDate": "2026-12-02T19:30:00+08:00",
                  "location": {
                    "@type": "Place",
                    "name": "The Rechabite",
                    "address": "224 William St, Northbridge WA 6003",
                    "geo": { "@type": "GeoCoordinates", "latitude": -31.9472, "longitude": 115.8576 }
                  }
                }
              }
            ]
          }
        </script>
      </head>
      <body>
        <script>
          window.__SERVER_DATA__ = {
            "search_data": {
              "events": {
                "results": [
                  {
                    "id": "701701701",
                    "name": "Fremantle Twilight Touch Rugby",
                    "url": "https://www.eventbrite.com.au/e/fremantle-touch-tickets-701701701",
                    "start_date": "2026-12-01",
                    "start_time": "18:00",
                    "primary_organizer": {
                      "id": "99001",
                      "name": "Freo Touch Collective",
                      "url": "https://www.eventbrite.com.au/o/freo-touch-99001"
                    },
                    "category": "Sports & Fitness"
                  },
                  {
                    "id": "703703703",
                    "name": "Subiaco Sunday Pottery Workshop",
                    "summary": "Beginner wheel-throwing class for adults.",
                    "url": "https://www.eventbrite.com.au/e/subiaco-pottery-tickets-703703703",
                    "start_date": "2026-12-03",
                    "start_time": "10:00",
                    "category": "Hobbies & Special Interest",
                    "primary_venue": {
                      "name": "Subiaco Arts Centre",
                      "address": {
                        "localized_address_display": "180 Hamersley Rd, Subiaco WA 6008",
                        "latitude": -31.9457,
                        "longitude": 115.8266
                      }
                    },
                    "primary_organizer": {
                      "name": "Subiaco Clay Studio"
                    },
                    "ticket_availability": {
                      "is_free": false,
                      "minimum_ticket_price": { "major_value": "45.00", "currency": "AUD" }
                    }
                  }
                ]
              }
            }
          };
        </script>
      </body>
    </html>
  `;

  const mockFetch = async (url) => {
    requestedUrls.push(url);
    return { ok: true, async text() { return html; } };
  };

  const crawler = createEventbriteCrawler({
    fetchFn: mockFetch,
    now: new Date('2026-11-21T00:00:00+08:00')
  });
  const listings = await crawler.fetchListings();

  assert.equal(requestedUrls.length, 1, 'Must issue only the single search-page request (zero detail-page requests)');
  assert.equal(listings.length, 3);

  const touch = listings.find(l => l.source_id === '701701701');
  assert.equal(touch.organizer.name, 'Freo Touch Collective');
  assert.equal(touch.organizer.website, 'https://www.eventbrite.com.au/o/freo-touch-99001');
  assert.equal(touch.category, 'sports');

  const jazz = listings.find(l => l.source_id === '702702702');
  assert.equal(jazz.title, 'Northbridge Jazz & Wine Night');
  assert.equal(jazz.category, 'music');

  const pottery = listings.find(l => l.source_id === '703703703');
  assert.equal(pottery.title, 'Subiaco Sunday Pottery Workshop');
  assert.equal(pottery.category, 'hobbies');
  assert.equal(pottery.display_price, '$45.00 AUD');
});

test('Seam 8 (Issue #32): Pre-ingestion filtering drops online/virtual, cancelled/postponed, undated, expired, and >85 km records while keeping all in-person Perth categories', async () => {
  const html = `
    <html>
      <head>
        <script type="application/ld+json">
          [
            {
              "@type": "Event",
              "name": "Online Yoga Stream",
              "url": "https://www.eventbrite.com.au/e/online-yoga-tickets-801",
              "startDate": "2026-12-01T18:00:00+08:00",
              "eventAttendanceMode": "https://schema.org/OnlineEventAttendanceMode",
              "location": { "@type": "VirtualLocation", "url": "https://zoom.us/j/123" }
            },
            {
              "@type": "Event",
              "name": "Cancelled Run",
              "url": "https://www.eventbrite.com.au/e/cancelled-run-tickets-802",
              "startDate": "2026-12-01T08:00:00+08:00",
              "eventStatus": "https://schema.org/EventCancelled",
              "location": { "@type": "Place", "name": "Kings Park", "geo": { "latitude": -31.9608, "longitude": 115.8447 } }
            },
            {
              "@type": "Event",
              "name": "Postponed Market",
              "url": "https://www.eventbrite.com.au/e/postponed-market-tickets-803",
              "startDate": "2026-12-01T09:00:00+08:00",
              "eventStatus": "https://schema.org/EventPostponed",
              "location": { "@type": "Place", "name": "Perth Cultural Centre", "geo": { "latitude": -31.9495, "longitude": 115.8606 } }
            },
            {
              "@type": "Event",
              "name": "Undated Gathering",
              "url": "https://www.eventbrite.com.au/e/undated-tickets-804",
              "location": { "@type": "Place", "name": "Perth CBD", "geo": { "latitude": -31.9505, "longitude": 115.8605 } }
            },
            {
              "@type": "Event",
              "name": "Expired Past Picnic",
              "url": "https://www.eventbrite.com.au/e/expired-picnic-tickets-805",
              "startDate": "2026-11-18T12:00:00+08:00",
              "location": { "@type": "Place", "name": "Hyde Park", "geo": { "latitude": -31.9381, "longitude": 115.8617 } }
            },
            {
              "@type": "Event",
              "name": "Bunbury Coastal Walk (>85km)",
              "url": "https://www.eventbrite.com.au/e/bunbury-walk-tickets-806",
              "startDate": "2026-12-05T08:00:00+08:00",
              "location": { "@type": "Place", "name": "Bunbury Foreshore", "geo": { "latitude": -33.3271, "longitude": 115.6414 } }
            },
            {
              "@type": "FoodEvent",
              "name": "Fremantle Farmers Food Tasting",
              "url": "https://www.eventbrite.com.au/e/freo-food-tickets-807",
              "startDate": "2026-12-05T10:00:00+08:00",
              "location": { "@type": "Place", "name": "Fremantle Markets", "geo": { "latitude": -32.0562, "longitude": 115.7489 } }
            },
            {
              "@type": "Event",
              "name": "UTC Early Morning Session (2026-11-20 AWST)",
              "url": "https://www.eventbrite.com.au/e/utc-awst-tickets-810",
              "startDate": "2026-11-19T20:00:00Z",
              "location": { "@type": "Place", "name": "Perth CBD", "geo": { "latitude": -31.9505, "longitude": 115.8605 } }
            }
          ]
        </script>
      </head>
      <body>
        <script>
          window.__SERVER_DATA__ = {
            "search_data": {
              "events": {
                "results": [
                  {
                    "id": "808",
                    "name": "Online Coding Bootcamp",
                    "url": "https://www.eventbrite.com.au/e/online-coding-tickets-808",
                    "start_date": "2026-12-06",
                    "is_online_event": true,
                    "primary_venue": { "address": { "latitude": -31.9505, "longitude": 115.8605 } }
                  },
                  {
                    "id": "809",
                    "name": "Mandurah Paddle (Within 85km)",
                    "url": "https://www.eventbrite.com.au/e/mandurah-paddle-tickets-809",
                    "start_date": "2026-12-06",
                    "start_time": "09:00",
                    "primary_venue": {
                      "name": "Mandurah Foreshore",
                      "address": { "latitude": -32.5269, "longitude": 115.7217 }
                    }
                  }
                ]
              }
            }
          };
        </script>
      </body>
    </html>
  `;

  const crawler = createEventbriteCrawler({
    fetchFn: async () => ({ ok: true, async text() { return html; } }),
    now: new Date('2026-11-21T12:00:00+08:00')
  });

  const listings = await crawler.fetchListings();
  const ids = listings.map(l => l.source_id);

  assert.deepEqual(ids, ['809', '807', '810']);
});

test('Seam 8 (Issue #32): Normalization resolves missing geo via suburb/postcode centroids, anchors naive ISO to +08:00, parses AggregateOffer/null prices, and infers demographics', async () => {
  const html = `
    <html>
      <head>
        <script type="application/ld+json">
          [
            {
              "@type": "SportsEvent",
              "name": "Women's Social Netball (Adults 18+)",
              "description": "Fun Wednesday night netball for ladies.",
              "url": "https://www.eventbrite.com.au/e/womens-netball-tickets-901",
              "startDate": "2026-12-09T18:30:00",
              "endDate": "2026-12-09T20:00:00",
              "location": {
                "@type": "Place",
                "name": "Joondalup Arena",
                "address": {
                  "@type": "PostalAddress",
                  "addressLocality": "Joondalup",
                  "addressRegion": "WA",
                  "postalCode": "6027",
                  "addressCountry": "AU"
                }
              },
              "offers": {
                "@type": "AggregateOffer",
                "lowPrice": 15,
                "highPrice": 25,
                "priceCurrency": "AUD"
              }
            },
            {
              "@type": "Event",
              "name": "Junior Kids Soccer Clinic",
              "description": "School holidays soccer skills for boys and girls.",
              "url": "https://www.eventbrite.com.au/e/junior-soccer-tickets-902",
              "startDate": "2026-12-10T09:00:00",
              "location": {
                "@type": "Place",
                "address": "123 High St, Fremantle WA 6160"
              },
              "offers": {
                "@type": "Offer",
                "price": null,
                "priceCurrency": "AUD"
              }
            },
            {
              "@type": "Event",
              "name": "Masters Men's Lawn Bowls",
              "description": "Over 50s social bowls for blokes.",
              "url": "https://www.eventbrite.com.au/e/masters-bowls-tickets-903",
              "startDate": "2026-12-11T14:00:00+08:00",
              "location": {
                "@type": "Place",
                "name": "Subiaco Bowls",
                "geo": { "latitude": -31.9457, "longitude": 115.8266 }
              },
              "offers": {
                "@type": "AggregateOffer",
                "lowPrice": "0",
                "highPrice": "0",
                "priceCurrency": "AUD"
              }
            },
            {
              "@type": "Event",
              "name": "Melbourne Tech Meetup",
              "url": "https://www.eventbrite.com.au/e/melbourne-tech-tickets-904",
              "startDate": "2026-12-12T18:00:00",
              "location": {
                "@type": "Place",
                "address": {
                  "addressLocality": "Melbourne",
                  "addressRegion": "VIC",
                  "postalCode": "3000"
                }
              }
            }
          ]
        </script>
      </head>
    </html>
  `;

  const crawler = createEventbriteCrawler({
    fetchFn: async () => ({ ok: true, async text() { return html; } }),
    now: new Date('2026-11-21T12:00:00+08:00')
  });

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 3, 'Melbourne listing without geo must be dropped');

  const netball = listings.find(l => l.source_id === '901');
  assert.ok(netball.coordinates.lat < -31.7 && netball.coordinates.lat > -31.8, 'Resolves Joondalup centroid');
  assert.equal(netball.start_time, '2026-12-09T18:30:00+08:00');
  assert.equal(netball.end_time, '2026-12-09T20:00:00+08:00');
  assert.equal(netball.display_price, '$15 - $25 AUD');
  assert.equal(netball.is_free, false);
  assert.deepEqual(netball.demographics, { gender: 'women_only', age: 'adults' });

  const soccer = listings.find(l => l.source_id === '902');
  assert.ok(soccer.coordinates.lat < -32.0 && soccer.coordinates.lat > -32.1, 'Resolves Fremantle 6160 centroid');
  assert.equal(soccer.display_price, 'See listing details');
  assert.ok(!soccer.display_price.includes('null'));
  assert.deepEqual(soccer.demographics, { gender: 'all', age: 'juniors' });

  const bowls = listings.find(l => l.source_id === '903');
  assert.equal(bowls.is_free, true);
  assert.equal(bowls.display_price, 'Free');
  assert.deepEqual(bowls.demographics, { gender: 'men_only', age: 'masters' });
});

test('Seam 8 (Issue #32): Removes synthetic placeholders so missing URLs degrade to Unverified Listings and missing Venue names fall back to formatted address', async () => {
  const html = `
    <html>
      <head>
        <script type="application/ld+json">
          [
            {
              "@type": "Event",
              "name": "",
              "url": "https://www.eventbrite.com.au/e/nameless-tickets-950",
              "startDate": "2026-12-10T10:00:00+08:00",
              "location": { "@type": "Place", "geo": { "latitude": -31.9505, "longitude": 115.8605 } }
            },
            {
              "@type": "Event",
              "@id": "951",
              "name": "Cottesloe Beach Cleanup",
              "startDate": "2026-12-10T08:00:00+08:00",
              "location": {
                "@type": "Place",
                "address": "Marine Parade, Cottesloe WA 6011",
                "geo": { "latitude": -31.9958, "longitude": 115.7513 }
              }
            }
          ]
        </script>
      </head>
    </html>
  `;

  const crawler = createEventbriteCrawler({
    fetchFn: async () => ({ ok: true, async text() { return html; } }),
    now: new Date('2026-11-21T12:00:00+08:00')
  });

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 1, 'Nameless Activity must be skipped rather than given a fake title');

  const cleanup = listings[0];
  assert.equal(cleanup.source_url, null, 'Must not fall back to directory URL');
  assert.equal(cleanup.external_url, null);
  assert.equal(cleanup.organizer, undefined, 'Must not fabricate Eventbrite Community Organizer');
  assert.equal(cleanup.venue_name, 'Marine Parade, Cottesloe WA 6011', 'Missing Venue name must fall back to formatted address');

  const sanitized = sanitizeActivity(cleanup);
  assert.equal(sanitized.verified, false, 'Missing referral URL degrades to Unverified Listing');
  assert.equal(sanitized.source_url, null);
});

test('Seam 8 (Issue #34): extractEventbritePageCount extracts positive page_count from __SERVER_DATA__', () => {
  assert.equal(
    extractEventbritePageCount({ search_data: { events: { pagination: { page_count: 4 } } } }),
    4
  );
  assert.equal(
    extractEventbritePageCount({ pagination: { page_count: '3' } }),
    3
  );
  assert.equal(extractEventbritePageCount({ search_data: { events: {} } }), null);
  assert.equal(extractEventbritePageCount(null), null);
});

function buildEventbriteSearchHtml(events, pageCount = 1) {
  return `
    <html>
      <body>
        <script>
          window.__SERVER_DATA__ = ${JSON.stringify({
            search_data: {
              events: {
                pagination: { page_count: pageCount },
                results: events
              }
            }
          })};
        </script>
      </body>
    </html>
  `;
}

test('Seam 8 (Issue #34): Multi-feed crawler polls all 10 Greater Perth feeds and lets specific category feeds override /all-events/ on deduplication', async () => {
  assert.equal(EVENTBRITE_PERTH_FEEDS.length, 10);
  const slugs = EVENTBRITE_PERTH_FEEDS.map(f => f.slug);
  assert.deepEqual(slugs, [
    'all-events',
    'sports',
    'health',
    'arts',
    'music',
    'community',
    'family-and-education',
    'food-and-drink',
    'hobbies',
    'travel-and-outdoor'
  ]);

  const requestedUrls = [];
  const mockFetch = async (url) => {
    requestedUrls.push(url);
    if (url.includes('/all-events/')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return buildEventbriteSearchHtml([
            {
              id: '9001',
              name: 'Kings Park Sunset Run (Generic)',
              url: 'https://www.eventbrite.com.au/e/kings-park-run-9001',
              start_date: '2026-12-01',
              start_time: '18:00',
              primary_venue: { name: 'Kings Park', address: { latitude: -31.9608, longitude: 115.8447 } }
            },
            {
              id: '9002',
              name: 'Perth General Community Market',
              url: 'https://www.eventbrite.com.au/e/perth-market-9002',
              start_date: '2026-12-02',
              start_time: '09:00',
              primary_venue: { name: 'Forrest Place', address: { latitude: -31.9522, longitude: 115.8602 } }
            }
          ], 1);
        }
      };
    }
    if (url.includes('/music--events/')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return buildEventbriteSearchHtml([
            {
              id: '9001',
              name: 'Kings Park Sunset Music & Run Festival',
              url: 'https://www.eventbrite.com.au/e/kings-park-run-9001',
              start_date: '2026-12-01',
              start_time: '18:00',
              primary_venue: { name: 'Kings Park', address: { latitude: -31.9608, longitude: 115.8447 } }
            }
          ], 1);
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return buildEventbriteSearchHtml([], 1);
      }
    };
  };

  const crawler = createEventbriteCrawler({
    multiFeed: true,
    fetchFn: mockFetch,
    now: new Date('2026-11-21T00:00:00+08:00')
  });
  const listings = await crawler.fetchListings();

  assert.equal(requestedUrls.length, 10, 'Each single-page feed should stop after page 1 when page_count === 1');
  const byId = new Map(listings.map(item => [item.source_id, item]));
  assert.equal(byId.size, 2);
  assert.equal(byId.get('9001').category, 'music', 'Specific category feed must override /all-events/');
  assert.equal(byId.get('9001').title, 'Kings Park Sunset Music & Run Festival');
  assert.equal(byId.get('9002').category, 'sports', 'Unclassified /all-events/ listing defaults to sports');
});

test('Seam 8 (Issue #34): Multi-feed crawler paginates ?page=1..maxPages and stops early on page >= page_count or 0 new IDs', async () => {
  const requestedUrls = [];
  const feeds = [
    { slug: 'sports', url: 'https://www.eventbrite.com.au/d/australia--perth/sports--events/', category: 'sports', priority: 1 },
    { slug: 'arts', url: 'https://www.eventbrite.com.au/d/australia--perth/arts--events/', category: 'arts', priority: 1 }
  ];

  const mockFetch = async (url) => {
    requestedUrls.push(url);
    // sports: page_count is 2, so page 3..5 must not be requested
    if (url.includes('/sports--events/')) {
      const pageMatch = url.match(/[?&]page=(\d+)/);
      const page = pageMatch ? Number(pageMatch[1]) : 1;
      return {
        ok: true,
        status: 200,
        async text() {
          return buildEventbriteSearchHtml([
            {
              id: `sport-${page}`,
              name: `Perth Sport Page ${page}`,
              url: `https://www.eventbrite.com.au/e/sport-${page}`,
              start_date: '2026-12-01',
              primary_venue: { name: 'Perth Oval', address: { latitude: -31.946, longitude: 115.87 } }
            }
          ], 2);
        }
      };
    }
    // arts: page_count is 5, but page 2 yields only duplicate ID from page 1 (0 new IDs) -> stop after page 2
    if (url.includes('/arts--events/')) {
      return {
        ok: true,
        status: 200,
        async text() {
          return buildEventbriteSearchHtml([
            {
              id: 'art-1',
              name: 'Perth Art Exhibition',
              url: 'https://www.eventbrite.com.au/e/art-1',
              start_date: '2026-12-01',
              primary_venue: { name: 'AGWA', address: { latitude: -31.951, longitude: 115.861 } }
            }
          ], 5);
        }
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const crawler = createEventbriteCrawler({
    feeds,
    maxPages: 5,
    fetchFn: mockFetch,
    now: new Date('2026-11-21T00:00:00+08:00')
  });
  const listings = await crawler.fetchListings();

  assert.deepEqual(requestedUrls, [
    'https://www.eventbrite.com.au/d/australia--perth/sports--events/?page=1',
    'https://www.eventbrite.com.au/d/australia--perth/sports--events/?page=2',
    'https://www.eventbrite.com.au/d/australia--perth/arts--events/?page=1',
    'https://www.eventbrite.com.au/d/australia--perth/arts--events/?page=2'
  ]);
  assert.equal(listings.length, 3);
});
