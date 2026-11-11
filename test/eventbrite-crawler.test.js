import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEventbriteCrawler,
  EVENTBRITE_PERTH_SPORTS_URL,
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

  const crawler = createEventbriteCrawler({ fetchFn: mockFetch });
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

  const crawler = createEventbriteCrawler({ fetchFn: mockFetch });
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

  const crawler = createEventbriteCrawler({ fetchFn: mockFetch });
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

  const crawler = createEventbriteCrawler({ fetchFn: mockFailingFetch });
  await assert.rejects(
    () => crawler.fetchListings(),
    /Eventbrite responded with HTTP 429: Too Many Requests/
  );
});
