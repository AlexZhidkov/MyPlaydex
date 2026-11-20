import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  extractFacebookEventLinks,
  extractRelatedFacebookEventLinks
} from '../src/facebook-parser.js';
import {
  extractFacebookEvents,
  main,
  parseCliArgs,
  runFacebookSync
} from '../src/facebook-sync.js';
import { createFileCacheStore } from '../src/places-sync.js';
import { deriveFacebookEventsTabUrl } from '../src/url-utils.js';

describe('Facebook Public Events Sync CLI (Issue #20)', () => {
  it('Seam 1: parseCliArgs parses --url, --input, --organizer, --dry-run, --refresh, --limit, --use-adc, and --project', () => {
    const parsed = parseCliArgs([
      '--url=https://m.facebook.com/events/123456789?fbclid=abc',
      '--organizer=org_perth_club',
      '--dry-run',
      '--refresh',
      '--limit=5',
      '--use-adc',
      '--project=custom-proj'
    ], {});

    assert.equal(parsed.url, 'https://m.facebook.com/events/123456789?fbclid=abc');
    assert.equal(parsed.input, undefined);
    assert.equal(parsed.organizer, 'org_perth_club');
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.refresh, true);
    assert.equal(parsed.limit, 5);
    assert.equal(parsed.useAdc, true);
    assert.equal(parsed.project, 'custom-proj');

    const inputParsed = parseCliArgs(['--input=./events.ics'], {
      FIREBASE_USE_ADC: '1',
      FIREBASE_PROJECT_ID: 'env-proj'
    });
    assert.equal(inputParsed.input, './events.ics');
    assert.equal(inputParsed.dryRun, false);
    assert.equal(inputParsed.refresh, false);
    assert.equal(inputParsed.useAdc, true);
    assert.equal(inputParsed.project, 'env-proj');
  });

  it('Seam 5: package.json registers sync:facebook and .gitignore ignores .scratch/facebook-sync-cache.json', async () => {
    const pkg = JSON.parse(await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['sync:facebook'], 'node src/facebook-sync.js');

    const gitignore = await fs.readFile(path.resolve(process.cwd(), '.gitignore'), 'utf8');
    assert.ok(gitignore.split(/\r?\n/).some(line => line.trim() === '.scratch/facebook-sync-cache.json'));
  });

  it('Seam 2: extractFacebookEvents parses Schema.org Event JSON-LD and normalizes schedules into AWST', () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "SportsEvent",
              "name": "Social Twilight Tennis",
              "description": "Casual doubles at Robertson Park.",
              "url": "https://m.facebook.com/events/555111222/?fbclid=xyz",
              "startDate": "2026-12-10T10:00:00Z",
              "endDate": "2026-12-10T12:00:00Z",
              "organizer": {
                "@type": "Organization",
                "name": "Perth Tennis Club"
              },
              "location": {
                "@type": "Place",
                "name": "Robertson Park Tennis Centre",
                "address": {
                  "@type": "PostalAddress",
                  "streetAddress": "176 Fitzgerald St",
                  "addressLocality": "Perth",
                  "addressRegion": "WA",
                  "postalCode": "6000",
                  "addressCountry": "AU"
                },
                "geo": {
                  "@type": "GeoCoordinates",
                  "latitude": -31.9428,
                  "longitude": 115.8601
                }
              },
              "offers": {
                "@type": "Offer",
                "price": "15",
                "priceCurrency": "AUD"
              }
            }
          </script>
        </head>
        <body></body>
      </html>
    `;

    const events = extractFacebookEvents(html, {
      sourceUrl: 'https://www.facebook.com/events/555111222/'
    });

    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.eventId, '555111222');
    assert.equal(ev.source_id, '555111222');
    assert.equal(ev.title, 'Social Twilight Tennis');
    assert.equal(ev.source_url, 'https://www.facebook.com/events/555111222/');
    // 10:00Z -> 18:00 AWST (+08:00)
    assert.equal(ev.start_date, '2026-12-10');
    assert.equal(ev.start_time, '18:00');
    assert.equal(ev.end_date, '2026-12-10');
    assert.equal(ev.end_time, '20:00');
    assert.equal(ev.venue_name, 'Robertson Park Tennis Centre');
    assert.deepEqual(ev.coordinates, { lat: -31.9428, lng: 115.8601 });
    assert.equal(ev.organizer_name, 'Perth Tennis Club');
    assert.equal(ev.is_online, false);
  });

  it('Seam 2: extractFacebookEvents parses Relay __bbox / ScheduledServerJS JSON including recurring child_events', () => {
    const relayPayload = {
      require: [
        ['ScheduledServerJS', 'handle', null, [{
          __bbox: {
            result: {
              data: {
                event: {
                  id: '987654321',
                  name: 'Sunday Morning Beach Volleyball',
                  description: { text: 'Weekly social games at Scarborough Beach.' },
                  url: 'https://www.facebook.com/events/987654321/',
                  start_timestamp: 1796518800, // 2026-12-06T01:00:00Z -> 09:00 AWST
                  end_timestamp: 1796526000,   // 2026-12-06T03:00:00Z -> 11:00 AWST
                  event_place: {
                    name: 'Scarborough Beach',
                    location: { latitude: -31.8942, longitude: 115.7571 }
                  },
                  event_hosts: [{ name: 'Perth Beach Volleyball' }],
                  child_events: {
                    nodes: [
                      {
                        id: '1110001',
                        start_timestamp: 1796518800,
                        end_timestamp: 1796526000
                      },
                      {
                        id: '1110002',
                        start_timestamp: 1797123600, // 2026-12-13T01:00:00Z -> 09:00 AWST
                        end_timestamp: 1797130800
                      }
                    ]
                  }
                }
              }
            }
          }
        }]]
      ]
    };

    const html = `<html><body><script type="application/json">${JSON.stringify(relayPayload)}</script></body></html>`;
    const events = extractFacebookEvents(html, {
      sourceUrl: 'https://www.facebook.com/events/987654321/'
    });

    assert.equal(events.length, 2);
    assert.equal(events[0].source_id, '987654321_20261206');
    assert.equal(events[0].start_date, '2026-12-06');
    assert.equal(events[0].start_time, '09:00');
    assert.equal(events[0].end_time, '11:00');
    assert.equal(events[0].venue_name, 'Scarborough Beach');
    assert.deepEqual(events[0].coordinates, { lat: -31.8942, lng: 115.7571 });

    assert.equal(events[1].source_id, '987654321_20261213');
    assert.equal(events[1].start_date, '2026-12-13');
    assert.equal(events[1].organizer_name, 'Perth Beach Volleyball');
  });

  it('Seam 2: extractFacebookEvents falls back to OpenGraph meta tags and parses RFC 5545 iCal VEVENTs', () => {
    const ogHtml = `
      <!doctype html>
      <html>
        <head>
          <meta property="og:title" content="Fremantle Parkrun" />
          <meta property="og:description" content="Free 5km timed run in Fremantle 6160." />
          <meta property="og:url" content="https://www.facebook.com/events/444555666/" />
          <meta property="event:start_time" content="2026-12-12T00:00:00Z" />
          <meta property="event:end_time" content="2026-12-12T01:30:00Z" />
          <meta property="place:location:latitude" content="-32.0569" />
          <meta property="place:location:longitude" content="115.7439" />
        </head>
      </html>
    `;

    const ogEvents = extractFacebookEvents(ogHtml);
    assert.equal(ogEvents.length, 1);
    assert.equal(ogEvents[0].source_id, '444555666');
    assert.equal(ogEvents[0].title, 'Fremantle Parkrun');
    assert.equal(ogEvents[0].start_date, '2026-12-12');
    assert.equal(ogEvents[0].start_time, '08:00');
    assert.equal(ogEvents[0].end_time, '09:30');
    assert.deepEqual(ogEvents[0].coordinates, { lat: -32.0569, lng: 115.7439 });

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:e777888999@facebook.com',
      'SUMMARY:Subiaco Social Netball',
      'DESCRIPTION:Friendly mixed netball.\\nBring water.',
      'LOCATION:Lords Recreation Centre\\, Subiaco WA 6008',
      'DTSTART:20261215T103000Z',
      'DTEND:20261215T120000Z',
      'URL:https://www.facebook.com/events/777888999/',
      'ORGANIZER;CN=Subiaco Netball Club:mailto:info@example.com',
      'GEO:-31.9463;115.8236',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const icsEvents = extractFacebookEvents(ics, { format: 'ics' });
    assert.equal(icsEvents.length, 1);
    assert.equal(icsEvents[0].source_id, '777888999');
    assert.equal(icsEvents[0].title, 'Subiaco Social Netball');
    assert.equal(icsEvents[0].description, 'Friendly mixed netball.\nBring water.');
    assert.equal(icsEvents[0].start_date, '2026-12-15');
    assert.equal(icsEvents[0].start_time, '18:30');
    assert.equal(icsEvents[0].end_time, '20:00');
    assert.equal(icsEvents[0].venue_name, 'Lords Recreation Centre');
    assert.equal(icsEvents[0].organizer_name, 'Subiaco Netball Club');
    assert.deepEqual(icsEvents[0].coordinates, { lat: -31.9463, lng: 115.8236 });
  });

  it('Seam 3: runFacebookSync filters online/non-Perth/expired activities, resolves 4-step coordinates/venues, and batch-upserts with verified: true', async () => {
    const now = new Date('2026-12-10T00:00:00+08:00');
    const html = `
      <html><head>
        <script type="application/ld+json">[
          {
            "@type": "SportsEvent",
            "name": "Expired Tennis Match",
            "url": "https://www.facebook.com/events/1001/",
            "startDate": "2026-12-01T18:00:00+08:00",
            "location": { "@type": "Place", "name": "Perth", "geo": { "latitude": -31.9505, "longitude": 115.8605 } }
          },
          {
            "@type": "SportsEvent",
            "name": "Online Yoga Class",
            "url": "https://www.facebook.com/events/1002/",
            "eventAttendanceMode": "https://schema.org/OnlineEventAttendanceMode",
            "startDate": "2026-12-20T18:00:00+08:00",
            "location": { "@type": "VirtualLocation", "name": "Zoom" }
          },
          {
            "@type": "SportsEvent",
            "name": "Sydney Harbour Run",
            "url": "https://www.facebook.com/events/1003/",
            "startDate": "2026-12-20T18:00:00+08:00",
            "location": { "@type": "Place", "name": "Sydney", "geo": { "latitude": -33.8688, "longitude": 151.2093 } }
          },
          {
            "@type": "SportsEvent",
            "name": "Venue Catalog Basketball",
            "url": "https://m.facebook.com/events/1004/?fbclid=track",
            "startDate": "2026-12-20T18:00:00+08:00",
            "organizer": { "@type": "Organization", "name": "Perth Redbacks" },
            "location": { "@type": "Place", "name": "Bendat Basketball Centre" }
          },
          {
            "@type": "SportsEvent",
            "name": "Suburb Centroid Touch Rugby",
            "url": "https://www.facebook.com/events/1005/",
            "startDate": "2026-12-21T18:00:00+08:00",
            "location": { "@type": "Place", "name": "Local Oval", "address": { "addressLocality": "Subiaco", "postalCode": "6008", "addressRegion": "WA" } }
          },
          {
            "@type": "SportsEvent",
            "name": "Organizer Fallback Social Bowls",
            "url": "https://www.facebook.com/events/1006/",
            "startDate": "2026-12-22T18:00:00+08:00",
            "location": { "@type": "Place", "name": "Club Green" }
          }
        ]</script>
      </head></html>
    `;

    const upsertedBatches = [];
    const upsertedVenues = [];
    const mockAdapter = {
      async scanVenues() {
        return [{
          id: 'venue_bendat_qd66hx',
          name: 'Bendat Basketball Centre',
          coordinates: { lat: -31.9462, lng: 115.7924 },
          geohash: 'qd66hx123',
          google_place_id: 'ChIJ_bendat'
        }];
      },
      async scanOrganizers() {
        return [{
          id: 'org_perth_redbacks',
          name: 'Perth Redbacks',
          coordinates: { lat: -31.9753, lng: 115.8978 },
          contact: { facebook: 'https://www.facebook.com/perthredbacks' }
        }];
      },
      async batchUpsertActivities(activities) {
        upsertedBatches.push(activities);
        return { upserted: activities.length };
      },
      async batchUpsertVenues(venues) {
        upsertedVenues.push(venues);
      }
    };

    const result = await runFacebookSync({
      adapter: mockAdapter,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => html
      }),
      cacheStore: { read: async () => null, write: async () => {} },
      options: {
        url: 'https://m.facebook.com/perthredbacks/events',
        organizer: 'org_perth_redbacks',
        now
      }
    });

    assert.equal(upsertedVenues.length, 0);
    assert.equal(upsertedBatches.length, 1);
    const saved = upsertedBatches[0];
    assert.equal(saved.length, 3);
    assert.equal(result.filteredExpired, 1);
    assert.equal(result.filteredOnline, 1);
    assert.equal(result.filteredOutOfArea, 1);

    // 1004: matched Bendat Basketball Centre from /venues catalog without coords in payload
    const ev1004 = saved.find(a => a.id === 'facebook_1004');
    assert.ok(ev1004);
    assert.equal(ev1004.verified, true);
    assert.equal(ev1004.source_url, 'https://www.facebook.com/events/1004/');
    assert.equal(ev1004.venue.id, 'venue_bendat_qd66hx');
    assert.equal(ev1004.venue.google_place_id, 'ChIJ_bendat');
    assert.equal(ev1004.needs_review, false);

    // 1005: Subiaco 6008 centroid fallback
    const ev1005 = saved.find(a => a.id === 'facebook_1005');
    assert.ok(ev1005);
    assert.equal(ev1005.venue.coordinates.lat, -31.9463);
    assert.equal(ev1005.venue.geohash.length, 9);
    assert.equal(ev1005.needs_review, true);
    assert.equal(ev1005.review_reason, 'unmatched_venue');

    // 1006: Parent Organizer coordinate fallback
    const ev1006 = saved.find(a => a.id === 'facebook_1006');
    assert.ok(ev1006);
    assert.equal(ev1006.venue.coordinates.lat, -31.9753);
    assert.equal(ev1006.needs_review, true);
    assert.equal(ev1006.review_reason, 'unmatched_venue');
  });

  it('Seam 4: main loads .env FACEBOOK_COOKIE, respects local checkpoint cache & --refresh, supports --input and --dry-run without credentials', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-fb-'));
    try {
      const envPath = path.join(tmpDir, '.env');
      await fs.writeFile(envPath, 'FACEBOOK_COOKIE=c_user=123; xs=secret\n', 'utf8');

      const icsPath = path.join(tmpDir, 'club.ics');
      await fs.writeFile(icsPath, [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:e888999000@facebook.com',
        'SUMMARY:Joondalup Social Soccer',
        'LOCATION:Arena Joondalup, Joondalup WA 6027',
        'DTSTART:20270110T100000Z',
        'DTEND:20270110T113000Z',
        'URL:https://www.facebook.com/events/888999000/',
        'END:VEVENT',
        'END:VCALENDAR'
      ].join('\r\n'), 'utf8');

      // 1. --input + --dry-run without Firestore credentials
      const dryRunEnv = {};
      const inputRes = await main(
        [`--input=${icsPath}`, '--dry-run'],
        dryRunEnv,
        { envFilePath: envPath, logger: { log: () => {} } }
      );
      assert.equal(inputRes.dryRun, true);
      assert.equal(inputRes.upserted, 0);
      assert.equal(inputRes.valid, 1);
      assert.equal(inputRes.activities[0].id, 'facebook_888999000');
      assert.equal(dryRunEnv.FACEBOOK_COOKIE, 'c_user=123; xs=secret');

      // 2. --url with checkpoint cache hit and --refresh bypass + cookie forwarding
      const cacheMap = new Map();
      const cacheStore = {
        read: async (k) => cacheMap.get(k) || null,
        write: async (k, v) => { cacheMap.set(k, v); }
      };

      const fetchCalls = [];
      const mockFetch = async (url, init) => {
        fetchCalls.push({ url, headers: init?.headers || {} });
        return {
          ok: true,
          status: 200,
          text: async () => `
            <html><head>
              <meta property="og:title" content="Cached Perth Run" />
              <meta property="og:url" content="https://www.facebook.com/events/222333444/" />
              <meta property="event:start_time" content="2027-01-15T00:00:00Z" />
              <meta property="place:location:latitude" content="-31.9505" />
              <meta property="place:location:longitude" content="115.8605" />
            </head></html>
          `
        };
      };

      // First fetch populates cache and forwards FACEBOOK_COOKIE
      await main(
        ['--url=https://m.facebook.com/events/222333444?fbclid=dropme', '--dry-run'],
        { FACEBOOK_COOKIE: 'c_user=999; xs=abc' },
        { fetchFn: mockFetch, cacheStore, logger: { log: () => {} } }
      );
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url, 'https://www.facebook.com/events/222333444');
      assert.equal(fetchCalls[0].headers.Cookie, 'c_user=999; xs=abc');

      // Second fetch without --refresh hits cache
      await main(
        ['--url=https://www.facebook.com/events/222333444', '--dry-run'],
        { FACEBOOK_COOKIE: 'c_user=999; xs=abc' },
        { fetchFn: mockFetch, cacheStore, logger: { log: () => {} } }
      );
      assert.equal(fetchCalls.length, 1);

      // Third fetch with --refresh bypasses cache
      await main(
        ['--url=https://www.facebook.com/events/222333444', '--dry-run', '--refresh'],
        { FACEBOOK_COOKIE: 'c_user=999; xs=abc' },
        { fetchFn: mockFetch, cacheStore, logger: { log: () => {} } }
      );
      assert.equal(fetchCalls.length, 2);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('Seam 4: runFacebookSync seeds from /organizers contact.facebook by default and respects --limit', async () => {
    const fetchedUrls = [];
    const mockAdapter = {
      async scanVenues() {
        return [];
      },
      async scanOrganizers() {
        return [
          {
            id: 'org_alpha',
            name: 'Alpha Club',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://www.facebook.com/alphaclub' }
          },
          {
            id: 'org_beta',
            name: 'Beta Club',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://www.facebook.com/betaclub' }
          },
          {
            id: 'org_no_fb',
            name: 'No FB Club',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: null }
          }
        ];
      },
      async batchUpsertActivities(activities) {
        return { upserted: activities.length };
      }
    };

    const res = await runFacebookSync({
      adapter: mockAdapter,
      fetchFn: async (url) => {
        fetchedUrls.push(url);
        return {
          ok: true,
          status: 200,
          text: async () => `
            <html><head>
              <meta property="og:title" content="Seeded Activity" />
              <meta property="og:url" content="https://www.facebook.com/events/333444555/" />
              <meta property="event:start_time" content="2027-02-01T10:00:00Z" />
            </head></html>
          `
        };
      },
      cacheStore: { read: async () => null, write: async () => {} },
      options: { limit: 1 },
      logger: { log: () => {} }
    });

    assert.deepEqual(fetchedUrls, [
      'https://www.facebook.com/alphaclub/events',
      'https://www.facebook.com/events/333444555/'
    ]);
    assert.equal(res.targets, 1);
    assert.equal(res.upserted, 1);
    assert.equal(res.activities[0].organizer.id, 'org_alpha');
  });

  it('Seam 4 (Issue #21): runFacebookSync filters invalid contact.facebook URLs and filters by --organizer=<id>', async () => {
    const fetchedUrls = [];
    const mockAdapter = {
      async scanVenues() {
        return [];
      },
      async scanOrganizers() {
        return [
          {
            id: 'org_invalid_fb',
            name: 'Invalid FB Club',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://www.facebook.com/login' }
          },
          {
            id: 'org_ignored_deptlgsc',
            name: 'KidSport Polluted Club',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://www.facebook.com/deptlgsc' }
          },
          {
            id: 'org_alpha',
            name: 'Alpha Club',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://m.facebook.com/alphaclub?fbclid=123' }
          },
          {
            id: 'org_beta',
            name: 'Beta Club',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://www.facebook.com/betaclub' }
          }
        ];
      },
      async batchUpsertActivities(activities) {
        return { upserted: activities.length };
      }
    };

    const makeFetch = () => async (url) => {
      fetchedUrls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => `
          <html><head>
            <meta property="og:title" content="Club Session" />
            <meta property="og:url" content="https://www.facebook.com/events/444555666/" />
            <meta property="event:start_time" content="2027-02-01T10:00:00Z" />
          </head></html>
        `
      };
    };

    // Without --organizer: skips org_invalid_fb, seeds org_alpha and org_beta
    await runFacebookSync({
      adapter: mockAdapter,
      fetchFn: makeFetch(),
      cacheStore: { read: async () => null, write: async () => {} },
      options: {},
      logger: { log: () => {} }
    });
    assert.deepEqual(fetchedUrls, [
      'https://www.facebook.com/alphaclub/events',
      'https://www.facebook.com/events/444555666/',
      'https://www.facebook.com/betaclub/events',
      'https://www.facebook.com/events/444555666/'
    ]);

    // With --organizer=org_beta: seeds only org_beta
    fetchedUrls.length = 0;
    const filteredRes = await runFacebookSync({
      adapter: mockAdapter,
      fetchFn: makeFetch(),
      cacheStore: { read: async () => null, write: async () => {} },
      options: { organizer: 'org_beta' },
      logger: { log: () => {} }
    });
    assert.deepEqual(fetchedUrls, [
      'https://www.facebook.com/betaclub/events',
      'https://www.facebook.com/events/444555666/'
    ]);
    assert.equal(filteredRes.targets, 1);
    assert.equal(filteredRes.activities[0].organizer.id, 'org_beta');
  });

  it('Seam 4 (Issue #21): runFacebookSync hydrates /events/<id> detail links from Organizer Page HTML through checkpoint cache', async () => {
    const pageHtml = `
      <html><body>
        <a href="/events/777888999/?acontext=%7B%22ref%22%3A1%7D">Saturday Social</a>
        <a href="https://m.facebook.com/events/888999000?fbclid=xyz">Sunday League</a>
        <script>var data = {"url":"https:\\/\\/www.facebook.com\\/events\\/777888999\\/"};</script>
      </body></html>
    `;
    const event777Html = `
      <html><head>
        <meta property="og:title" content="Saturday Social Volleyball" />
        <meta property="og:url" content="https://www.facebook.com/events/777888999/" />
        <meta property="event:start_time" content="2027-03-06T09:00:00Z" />
        <meta property="place:location:latitude" content="-31.9462" />
        <meta property="place:location:longitude" content="115.7924" />
      </head></html>
    `;
    const event888Html = `
      <html><head>
        <meta property="og:title" content="Sunday League Volleyball" />
        <meta property="og:url" content="https://www.facebook.com/events/888999000/" />
        <meta property="event:start_time" content="2027-03-07T09:00:00Z" />
        <meta property="place:location:latitude" content="-31.9462" />
        <meta property="place:location:longitude" content="115.7924" />
      </head></html>
    `;

    const cacheMap = new Map();
    const cacheStore = {
      read: async (k) => cacheMap.get(k) || null,
      write: async (k, v) => { cacheMap.set(k, v); }
    };
    const fetchCalls = [];
    const mockFetch = async (url) => {
      fetchCalls.push(url);
      if (url === 'https://www.facebook.com/perthvolleyball/events') {
        return { ok: true, status: 200, text: async () => pageHtml };
      }
      if (url === 'https://www.facebook.com/events/777888999/') {
        return { ok: true, status: 200, text: async () => event777Html };
      }
      if (url === 'https://www.facebook.com/events/888999000/') {
        return { ok: true, status: 200, text: async () => event888Html };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const mockAdapter = {
      async scanVenues() { return []; },
      async scanOrganizers() {
        return [{
          id: 'org_perth_vb',
          name: 'Perth Volleyball',
          subcategory: 'volleyball',
          coordinates: { lat: -31.9505, lng: 115.8605 },
          contact: { facebook: 'https://www.facebook.com/perthvolleyball' }
        }];
      },
      async batchUpsertActivities(activities) {
        return { upserted: activities.length };
      }
    };

    const res = await runFacebookSync({
      adapter: mockAdapter,
      fetchFn: mockFetch,
      cacheStore,
      options: {},
      logger: { log: () => {} }
    });

    assert.deepEqual(fetchCalls, [
      'https://www.facebook.com/perthvolleyball/events',
      'https://www.facebook.com/events/777888999/',
      'https://www.facebook.com/events/888999000/'
    ]);
    assert.equal(res.valid, 2);
    assert.deepEqual(res.activities.map(a => a.id), ['facebook_777888999', 'facebook_888999000']);
    assert.ok(cacheMap.has('https://www.facebook.com/events/777888999/'));
    assert.ok(cacheMap.has('https://www.facebook.com/events/888999000/'));

    // Second run uses cached detail pages without extra fetches
    fetchCalls.length = 0;
    const cachedRes = await runFacebookSync({
      adapter: mockAdapter,
      fetchFn: mockFetch,
      cacheStore,
      options: {},
      logger: { log: () => {} }
    });
    assert.equal(fetchCalls.length, 0);
    assert.equal(cachedRes.valid, 2);
  });

  it('Seam 3 (Issue #21): Activities inherit parent or matched Organizer subcategory only when title and description resolve to other', async () => {
    const html = `
      <html><head>
        <script type="application/ld+json">[
          {
            "@type": "Event",
            "name": "Thursday Social Night",
            "description": "Come join us for a fun evening!",
            "url": "https://www.facebook.com/events/9001/",
            "startDate": "2027-04-01T10:00:00Z",
            "location": { "@type": "Place", "name": "Club Hall", "geo": { "latitude": -31.9505, "longitude": 115.8605 } }
          },
          {
            "@type": "Event",
            "name": "Social Twilight Tennis",
            "description": "Doubles hit around.",
            "url": "https://www.facebook.com/events/9002/",
            "startDate": "2027-04-02T10:00:00Z",
            "location": { "@type": "Place", "name": "Club Courts", "geo": { "latitude": -31.9505, "longitude": 115.8605 } }
          },
          {
            "@type": "Event",
            "name": "Friday Club Mixer",
            "description": "All members welcome!",
            "url": "https://www.facebook.com/events/9003/",
            "organizer": { "@type": "Organization", "name": "Perth Redbacks" },
            "startDate": "2027-04-03T10:00:00Z",
            "location": { "@type": "Place", "name": "Main Court", "geo": { "latitude": -31.9505, "longitude": 115.8605 } }
          }
        ]</script>
      </head></html>
    `;

    const mockAdapter = {
      async scanVenues() { return []; },
      async scanOrganizers() {
        return [
          {
            id: 'org_perth_vb',
            name: 'Perth Volleyball',
            subcategory: 'volleyball',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://www.facebook.com/perthvolleyball' }
          },
          {
            id: 'org_perth_redbacks',
            name: 'Perth Redbacks',
            subcategories: ['basketball'],
            coordinates: { lat: -31.9753, lng: 115.8978 }
          }
        ];
      },
      async batchUpsertActivities(activities) { return { upserted: activities.length }; }
    };

    const res = await runFacebookSync({
      adapter: mockAdapter,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => html }),
      cacheStore: { read: async () => null, write: async () => {} },
      options: { organizer: 'org_perth_vb' },
      logger: { log: () => {} }
    });

    const ev9001 = res.activities.find(a => a.id === 'facebook_9001');
    const ev9002 = res.activities.find(a => a.id === 'facebook_9002');
    const ev9003 = res.activities.find(a => a.id === 'facebook_9003');

    assert.equal(ev9001.subcategory, 'volleyball');
    assert.equal(ev9002.subcategory, 'tennis');
    assert.equal(ev9003.subcategory, 'basketball');
  });

  it('Seam 3 (Issue #21): 4-step Venue & coordinate resolution handles multiple exact, allSmallerContained/jaccard>=0.6 partial, weak non-match, and parent Organizer fallback with venue.id: null', async () => {
    const html = `
      <html><head>
        <script type="application/ld+json">[
          {
            "@type": "SportsEvent",
            "name": "Duplicate Venue Name Event",
            "url": "https://www.facebook.com/events/9101/",
            "organizer": { "@type": "Organization", "name": "Perth Redbacks" },
            "startDate": "2027-04-10T10:00:00Z",
            "location": { "@type": "Place", "name": "Community Sports Hall" }
          },
          {
            "@type": "SportsEvent",
            "name": "Contained Partial Venue Match",
            "url": "https://www.facebook.com/events/9102/",
            "organizer": { "@type": "Organization", "name": "Perth Redbacks" },
            "startDate": "2027-04-11T10:00:00Z",
            "location": { "@type": "Place", "name": "Lords Recreation Centre" }
          },
          {
            "@type": "SportsEvent",
            "name": "Reordered Jaccard Venue Match",
            "url": "https://www.facebook.com/events/9103/",
            "organizer": { "@type": "Organization", "name": "Perth Redbacks" },
            "startDate": "2027-04-12T10:00:00Z",
            "location": { "@type": "Place", "name": "Robertson Tennis Park Centre" }
          },
          {
            "@type": "SportsEvent",
            "name": "Weak Single Token Overlap Fallback",
            "url": "https://www.facebook.com/events/9104/",
            "organizer": { "@type": "Organization", "name": "Perth Redbacks" },
            "startDate": "2027-04-13T10:00:00Z",
            "location": { "@type": "Place", "name": "Centre" }
          }
        ]</script>
      </head></html>
    `;

    const mockAdapter = {
      async scanVenues() {
        return [
          {
            id: 'venue_hall_north',
            name: 'Community Sports Hall',
            coordinates: { lat: -31.901, lng: 115.801 },
            geohash: 'qd66n1111',
            google_place_id: 'ChIJ_hall_1'
          },
          {
            id: 'venue_hall_south',
            name: 'Community Sports Hall',
            coordinates: { lat: -32.011, lng: 115.851 },
            geohash: 'qd66s2222',
            google_place_id: 'ChIJ_hall_2'
          },
          {
            id: 'venue_lords_subiaco',
            name: 'Lords Recreation Centre Subiaco',
            coordinates: { lat: -31.9445, lng: 115.8265 },
            geohash: 'qd66h3333',
            google_place_id: 'ChIJ_lords'
          },
          {
            id: 'venue_robertson',
            name: 'Robertson Park Tennis Centre',
            coordinates: { lat: -31.9428, lng: 115.8601 },
            geohash: 'qd66j4444',
            google_place_id: 'ChIJ_robertson'
          }
        ];
      },
      async scanOrganizers() {
        return [{
          id: 'org_perth_redbacks',
          name: 'Perth Redbacks',
          coordinates: { lat: -31.9753, lng: 115.8978 }
        }];
      },
      async batchUpsertActivities(activities) { return { upserted: activities.length }; }
    };

    const res = await runFacebookSync({
      adapter: mockAdapter,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => html }),
      cacheStore: { read: async () => null, write: async () => {} },
      options: { url: 'https://www.facebook.com/perthredbacks' },
      logger: { log: () => {} }
    });

    // Multiple exact slug matches -> uncertain_venue_match
    const ev9101 = res.activities.find(a => a.id === 'facebook_9101');
    assert.equal(ev9101.venue.id, 'venue_hall_north');
    assert.equal(ev9101.needs_review, true);
    assert.equal(ev9101.review_reason, 'uncertain_venue_match');

    // allSmallerContained (>= 2 tokens) -> uncertain_venue_match
    const ev9102 = res.activities.find(a => a.id === 'facebook_9102');
    assert.equal(ev9102.venue.id, 'venue_lords_subiaco');
    assert.equal(ev9102.venue.google_place_id, 'ChIJ_lords');
    assert.equal(ev9102.needs_review, true);
    assert.equal(ev9102.review_reason, 'uncertain_venue_match');

    // Reordered tokens (jaccard = 1.0 >= 0.6) -> uncertain_venue_match
    const ev9103 = res.activities.find(a => a.id === 'facebook_9103');
    assert.equal(ev9103.venue.id, 'venue_robertson');
    assert.equal(ev9103.needs_review, true);
    assert.equal(ev9103.review_reason, 'uncertain_venue_match');

    // Weak 1-token overlap ("Centre") must NOT match /venues; falls back to matched Organizer coords with venue.id: null
    const ev9104 = res.activities.find(a => a.id === 'facebook_9104');
    assert.equal(ev9104.venue.id, null);
    assert.deepEqual(ev9104.venue.coordinates, { lat: -31.9753, lng: 115.8978 });
    assert.equal(ev9104.needs_review, true);
    assert.equal(ev9104.review_reason, 'unmatched_venue');
  });

  it('Seam 4: runFacebookSync sends browser navigation headers and isolates per-target HTTP 400/404 errors', async () => {
    const fetchRequests = [];
    const warnings = [];
    const logs = [];

    const mockAdapter = {
      async scanVenues() { return []; },
      async scanOrganizers() {
        return [
          {
            id: 'org_broken_fb',
            name: 'Hunter Ballet Forte',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://www.facebook.com/hunter.balletforte' }
          },
          {
            id: 'org_healthy_fb',
            name: 'Perth Social Tennis',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://www.facebook.com/perthsocialtennis' }
          }
        ];
      },
      async batchUpsertActivities(activities) {
        return { upserted: activities.length };
      }
    };

    const mockFetch = async (url, init) => {
      fetchRequests.push({ url, headers: init?.headers || {} });
      if (url.startsWith('https://www.facebook.com/hunter.balletforte')) {
        return { ok: false, status: 400, text: async () => '' };
      }
      if (url === 'https://www.facebook.com/events/555666777/') {
        return { ok: false, status: 404, text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        text: async () => `
          <html>
            <head>
              <script type="application/ld+json">
                {
                  "@type": "SportsEvent",
                  "name": "Wednesday Night Tennis",
                  "url": "https://www.facebook.com/events/999000111/",
                  "startDate": "2027-05-05T18:00:00+08:00",
                  "location": { "@type": "Place", "name": "Perth", "geo": { "latitude": -31.9505, "longitude": 115.8605 } }
                }
              </script>
            </head>
            <body>
              <a href="/events/555666777/">Broken Event Link</a>
            </body>
          </html>
        `
      };
    };

    const res = await runFacebookSync({
      adapter: mockAdapter,
      fetchFn: mockFetch,
      cacheStore: { read: async () => null, write: async () => {} },
      options: {},
      logger: {
        log: (...args) => logs.push(args.join(' ')),
        warn: (...args) => warnings.push(args.join(' '))
      }
    });

    // Browser navigation headers sent on outgoing requests
    assert.ok(fetchRequests.length >= 2);
    for (const req of fetchRequests) {
      assert.equal(req.headers['Accept-Language'], 'en-AU,en-US;q=0.9,en;q=0.8');
      assert.equal(req.headers['Sec-Fetch-Dest'], 'document');
      assert.equal(req.headers['Sec-Fetch-Mode'], 'navigate');
      assert.equal(req.headers['Sec-Fetch-Site'], 'none');
      assert.equal(req.headers['Sec-Fetch-User'], '?1');
      assert.equal(req.headers['Upgrade-Insecure-Requests'], '1');
    }

    // Per-target HTTP 400 and HTTP 404 errors are logged as warnings without aborting healthy organizer ingestion
    assert.equal(res.targets, 1);
    assert.equal(res.failedTargets, 2);
    assert.equal(res.valid, 1);
    assert.equal(res.upserted, 1);
    assert.equal(res.activities[0].id, 'facebook_999000111');
    assert.ok(warnings.some(w => w.includes('hunter.balletforte') && w.includes('HTTP 400')));
    assert.ok(warnings.some(w => w.includes('555666777') && w.includes('HTTP 404')));
    assert.ok(logs.some(l => l.includes('Failed: 2')));
  });

  it('writes timestamped INFO and WARN logs to disk via --log-file and .gitignore ignores .scratch/logs/', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-fb-log-'));
    const logFilePath = path.join(tmpDir, 'facebook-sync.log');

    try {
      const gitignore = await fs.readFile(path.resolve(process.cwd(), '.gitignore'), 'utf8');
      assert.ok(gitignore.split(/\r?\n/).some(line => line.trim() === '.scratch/logs/'));

      const res = await main(
        ['--url=https://www.facebook.com/broken-page', '--dry-run', `--log-file=${logFilePath}`],
        {},
        {
          fetchFn: async () => ({ ok: false, status: 400, text: async () => '' }),
          cacheStore: { read: async () => null, write: async () => {} },
          logger: { log: () => {}, warn: () => {}, error: () => {} }
        }
      );

      assert.equal(res.failedTargets, 1);
      const logContent = await fs.readFile(logFilePath, 'utf8');
      assert.match(logContent, /^\[\d{4}-\d{2}-\d{2}T.*Z\] \[INFO\] \[Facebook Sync\] Initializing run/m);
      assert.match(logContent, /^\[\d{4}-\d{2}-\d{2}T.*Z\] \[WARN\] \[Facebook Sync\] Skipping target/m);
      assert.match(logContent, /^\[\d{4}-\d{2}-\d{2}T.*Z\] \[INFO\] \[Facebook Sync\] Targets: 0, Failed: 1/m);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('createFileCacheStore externalizes large >64KB bodies to sidecar files and migrates legacy inline caches', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-fb-cache-'));
    const cachePath = path.join(tmpDir, 'cache.json');
    const largeBody = '<html>' + 'x'.repeat(70000) + '</html>';
    const legacyBody = '<html>' + 'y'.repeat(70000) + '</html>';

    try {
      // Seed a legacy monolithic cache file with an inline oversized body
      await fs.writeFile(cachePath, JSON.stringify({
        'https://www.facebook.com/legacyclub': {
          url: 'https://www.facebook.com/legacyclub',
          fetchedAt: '2026-11-19T00:00:00.000Z',
          body: legacyBody
        }
      }, null, 2), 'utf8');

      const store = createFileCacheStore(cachePath);

      // Reading triggers migration of inline large body into cache.json.d/*.body
      const migratedEntry = await store.read('https://www.facebook.com/legacyclub');
      assert.equal(migratedEntry.body, legacyBody);

      // Writing another large body externalizes it too
      await store.write('https://www.facebook.com/newclub', {
        url: 'https://www.facebook.com/newclub',
        fetchedAt: '2026-11-19T01:00:00.000Z',
        body: largeBody
      });

      const indexJson = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      assert.equal(indexJson['https://www.facebook.com/legacyclub'].body, undefined);
      assert.ok(indexJson['https://www.facebook.com/legacyclub'].bodyFile);
      assert.equal(indexJson['https://www.facebook.com/newclub'].body, undefined);
      assert.ok(indexJson['https://www.facebook.com/newclub'].bodyFile);

      const sidecarFiles = await fs.readdir(`${cachePath}.d`);
      assert.equal(sidecarFiles.length, 2);

      // Fresh store instance reads the externalized body transparently
      const freshStore = createFileCacheStore(cachePath);
      const readBack = await freshStore.read('https://www.facebook.com/newclub');
      assert.equal(readBack.body, largeBody);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('createFileCacheStore writes .body.gz sidecars, reads legacy .body sidecars, and cleans up previous sidecars on overwrite or delete', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-gz-cache-'));
    const cachePath = path.join(tmpDir, 'cache.json');
    const sidecarDir = `${cachePath}.d`;
    const largeBody = '<html>' + 'z'.repeat(70000) + '</html>';
    const legacyUncompressedBody = '<html>' + 'u'.repeat(70000) + '</html>';

    try {
      await fs.mkdir(sidecarDir, { recursive: true });
      await fs.writeFile(path.join(sidecarDir, 'legacy.body'), legacyUncompressedBody, 'utf8');
      await fs.writeFile(cachePath, JSON.stringify({
        'https://www.facebook.com/legacy-sidecar': {
          url: 'https://www.facebook.com/legacy-sidecar',
          fetchedAt: '2026-11-19T00:00:00.000Z',
          bodyFile: 'legacy.body'
        }
      }, null, 2), 'utf8');

      const store = createFileCacheStore(cachePath);

      // 1. Existing uncompressed .body sidecar remains readable
      const legacyRead = await store.read('https://www.facebook.com/legacy-sidecar');
      assert.equal(legacyRead.body, legacyUncompressedBody);

      // 2. Overwriting legacy .body key with a new large body writes .body.gz and removes legacy.body
      await store.write('https://www.facebook.com/legacy-sidecar', {
        url: 'https://www.facebook.com/legacy-sidecar',
        fetchedAt: '2026-11-19T01:00:00.000Z',
        body: largeBody
      });

      const indexAfterOverwrite = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      const gzFile = indexAfterOverwrite['https://www.facebook.com/legacy-sidecar'].bodyFile;
      assert.match(gzFile, /\.body\.gz$/);
      const sidecarsAfterOverwrite = await fs.readdir(sidecarDir);
      assert.deepEqual(sidecarsAfterOverwrite, [gzFile]);
      const gzStat = await fs.stat(path.join(sidecarDir, gzFile));
      assert.ok(gzStat.size < largeBody.length);

      // Transparently decompressed on read from fresh store
      const freshStore = createFileCacheStore(cachePath);
      const decompressedRead = await freshStore.read('https://www.facebook.com/legacy-sidecar');
      assert.equal(decompressedRead.body, largeBody);

      // 3. Overwriting with a small inline body cleans up the .body.gz sidecar
      await freshStore.write('https://www.facebook.com/legacy-sidecar', {
        url: 'https://www.facebook.com/legacy-sidecar',
        fetchedAt: '2026-11-19T02:00:00.000Z',
        body: '<html>small</html>'
      });
      assert.deepEqual(await fs.readdir(sidecarDir), []);

      // 4. Deleting a cached key with a sidecar cleans up the sidecar and removes it from index
      await freshStore.write('https://www.facebook.com/to-delete', {
        url: 'https://www.facebook.com/to-delete',
        fetchedAt: '2026-11-19T03:00:00.000Z',
        body: largeBody
      });
      assert.equal((await fs.readdir(sidecarDir)).length, 1);
      await freshStore.delete('https://www.facebook.com/to-delete');
      assert.equal(await freshStore.read('https://www.facebook.com/to-delete'), null);
      assert.deepEqual(await fs.readdir(sidecarDir), []);
      const indexAfterDelete = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      assert.equal(indexAfterDelete['https://www.facebook.com/to-delete'], undefined);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('createFileCacheStore supports batched and explicit index JSON flushing and runFacebookSync flushes on completion', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-batch-cache-'));
    const explicitPath = path.join(tmpDir, 'explicit.json');
    const batchedPath = path.join(tmpDir, 'batched.json');

    try {
      // 1. Explicit flush mode (autoFlush: false)
      const explicitStore = createFileCacheStore(explicitPath, { autoFlush: false });
      await explicitStore.write('k1', { body: 'v1' });
      await explicitStore.write('k2', { body: 'v2' });
      assert.equal((await explicitStore.read('k1')).body, 'v1');
      await assert.rejects(() => fs.stat(explicitPath), { code: 'ENOENT' });

      await explicitStore.flush();
      const explicitJson = JSON.parse(await fs.readFile(explicitPath, 'utf8'));
      assert.deepEqual(Object.keys(explicitJson), ['k1', 'k2']);

      // 2. Batched flush mode (flushEvery: 3)
      const batchedStore = createFileCacheStore(batchedPath, { flushEvery: 3 });
      await batchedStore.write('b1', { body: '1' });
      await batchedStore.write('b2', { body: '2' });
      await assert.rejects(() => fs.stat(batchedPath), { code: 'ENOENT' });

      await batchedStore.write('b3', { body: '3' });
      const afterThree = JSON.parse(await fs.readFile(batchedPath, 'utf8'));
      assert.deepEqual(Object.keys(afterThree), ['b1', 'b2', 'b3']);

      await batchedStore.write('b4', { body: '4' });
      const stillThree = JSON.parse(await fs.readFile(batchedPath, 'utf8'));
      assert.deepEqual(Object.keys(stillThree), ['b1', 'b2', 'b3']);

      await batchedStore.flush();
      const afterFinalFlush = JSON.parse(await fs.readFile(batchedPath, 'utf8'));
      assert.deepEqual(Object.keys(afterFinalFlush), ['b1', 'b2', 'b3', 'b4']);

      // 3. runFacebookSync calls cacheStore.flush() at end of run
      let flushedCount = 0;
      const spyCacheStore = {
        read: async () => null,
        write: async () => {},
        flush: async () => { flushedCount += 1; }
      };
      await runFacebookSync({
        adapter: { scanVenues: async () => [], scanOrganizers: async () => [] },
        fetchFn: async () => ({ ok: false, status: 500 }),
        cacheStore: spyCacheStore,
        options: { url: 'https://www.facebook.com/nonexistent', dryRun: true },
        logger: { log: () => {}, warn: () => {} }
      });
      assert.equal(flushedCount, 1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('extractFacebookEventLinks ignores external /events/<id> URLs, discovers Relay Event IDs, and skips CometErrorRoute/CometHomeRoute', () => {
    const timelineHtml = `
      <html><body>
        <a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fapp.utrsports.net%2Fevents%2F409907">External UTR</a>
        <script type="application/json">{"external_url":"https:\\/\\/www.squashwa.asn.au\\/events\\/391708"}</script>
        <script type="application/json">{"__typename":"Event","id":"1683713346681049","name":"Relay Forward"}</script>
        <script type="application/json">{"id":"2047253656144310","__typename":"Event"}</script>
      </body></html>
    `;
    const links = extractFacebookEventLinks(timelineHtml);
    assert.deepEqual(links, [
      { eventId: '1683713346681049', url: 'https://www.facebook.com/events/1683713346681049/' },
      { eventId: '2047253656144310', url: 'https://www.facebook.com/events/2047253656144310/' }
    ]);

    const errorHtml = `<html><script>{"canonicalRouteName":"comet.fbweb.CometErrorRoute","url":"https:\\/\\/www.facebook.com\\/events\\/999111222\\/"}</script></html>`;
    const homeHtml = `<html><script>{"canonicalRouteName":"comet.fbweb.CometHomeRoute","__typename":"Event","id":"999111222"}</script></html>`;
    const eventsHomeHtml = `<html><script>{"canonicalRouteName":"comet.fbweb.CometEventsHomeRoute","__typename":"Event","id":"999111222"}</script></html>`;
    assert.deepEqual(extractFacebookEventLinks(errorHtml), []);
    assert.deepEqual(extractFacebookEventLinks(homeHtml), []);
    assert.deepEqual(extractFacebookEventLinks(eventsHomeHtml), []);
  });

  it('extractFacebookEvents parses Comet Relay day_time_sentence variants, merges split fragments, and extracts event_place.contextual_name', () => {
    const now = new Date('2026-11-19T14:00:00+08:00'); // Thursday
    const cometHtml = `
      <html><body>
        <script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"result":{"data":{"node":{"__typename":"Event","id":"1683713346681049","url":"https://www.facebook.com/events/1683713346681049/"}}}}}]]]}</script>
        <script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"result":{"data":{"node":{"__typename":"Event","id":"1683713346681049","name":"Summer Trials Night #1","day_time_sentence":"This Saturday at 3\\u202fPM","is_canceled":false,"event_place":{"__typename":"Page","contextual_name":"AJS MotoTrials Park","city":{"contextual_name":"Perth, WA"}}}}}}}]]]}</script>
        <script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"result":{"data":{"node":{"__typename":"Event","id":"1678092483391749","name":"Winter Dance Gala","day_time_sentence":"Sun, Jun 20, 2027 at 2\\u202fPM","is_canceled":false}}}}}]]]}</script>
        <script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"result":{"data":{"node":{"__typename":"Event","id":"1149783274296978","name":"Veterans Shield","capitalized_day_time_sentence":"Sat, Nov 14","is_canceled":false,"event_place":{"__typename":"Page","contextual_name":"Cockburn Ice Arena","city":{"contextual_name":"Perth, WA"}}}}}}}]]]}</script>
        <script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"result":{"data":{"node":{"__typename":"Event","id":"555000111","name":"Canceled Event","day_time_sentence":"Sun, Jun 20, 2027 at 2\\u202fPM","is_canceled":true}}}}}]]]}</script>
      </body></html>
    `;

    const events = extractFacebookEvents(cometHtml, { now });
    assert.equal(events.length, 3);

    const ajs = events.find(e => e.eventId === '1683713346681049');
    assert.ok(ajs);
    assert.equal(ajs.title, 'Summer Trials Night #1');
    assert.equal(ajs.source_url, 'https://www.facebook.com/events/1683713346681049/');
    assert.equal(ajs.start_date, '2026-11-21');
    assert.equal(ajs.start_time, '15:00');
    assert.equal(ajs.venue_name, 'AJS MotoTrials Park');
    assert.equal(ajs.location_text, 'AJS MotoTrials Park, Perth, WA');

    const gala = events.find(e => e.eventId === '1678092483391749');
    assert.ok(gala);
    assert.equal(gala.start_date, '2027-06-20');
    assert.equal(gala.start_time, '14:00');

    const shield = events.find(e => e.eventId === '1149783274296978');
    assert.ok(shield);
    assert.equal(shield.start_date, '2026-11-14');
    assert.equal(shield.start_time, null);
    assert.equal(shield.venue_name, 'Cockburn Ice Arena');

    // CometErrorRoute returns empty even if it contains markup
    const errorPayload = `<html><script>{"canonicalRouteName":"comet.fbweb.CometErrorRoute"}</script><meta property="og:title" content="Error" /><meta property="og:url" content="https://www.facebook.com/events/123456/" /></html>`;
    assert.deepEqual(extractFacebookEvents(errorPayload, { now }), []);
  });

  it('runFacebookSync isolates cacheStore.write failures without discarding fetched activities', async () => {
    const warnings = [];
    const res = await runFacebookSync({
      adapter: {
        async scanVenues() { return []; },
        async scanOrganizers() { return []; }
      },
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => `
          <html><head>
            <meta property="og:title" content="Resilient Tennis Hit" />
            <meta property="og:url" content="https://www.facebook.com/events/666777888/" />
            <meta property="event:start_time" content="2027-06-01T10:00:00Z" />
            <meta property="place:location:latitude" content="-31.9505" />
            <meta property="place:location:longitude" content="115.8605" />
          </head></html>
        `
      }),
      cacheStore: {
        read: async () => null,
        write: async () => { throw new RangeError('Invalid string length'); }
      },
      options: { url: 'https://www.facebook.com/events/666777888/', dryRun: true },
      logger: { log: () => {}, warn: (...args) => warnings.push(args.join(' ')) }
    });

    assert.equal(res.valid, 1);
    assert.equal(res.activities[0].id, 'facebook_666777888');
    assert.ok(warnings.some(w => w.includes('Cache write failed') && w.includes('Invalid string length')));
  });

  it('Seam 1 (Issue #22): deriveFacebookEventsTabUrl resolves Pages, Groups, and profile.php to /events tab while preserving /events and /events/<id>', () => {
    // Organizer Pages
    assert.equal(
      deriveFacebookEventsTabUrl('https://www.facebook.com/perthvolleyball'),
      'https://www.facebook.com/perthvolleyball/events'
    );
    assert.equal(
      deriveFacebookEventsTabUrl('https://m.facebook.com/perthvolleyball/?fbclid=123'),
      'https://www.facebook.com/perthvolleyball/events'
    );
    assert.equal(
      deriveFacebookEventsTabUrl('https://www.facebook.com/perthvolleyball/about'),
      'https://www.facebook.com/perthvolleyball/events'
    );

    // Public Groups
    assert.equal(
      deriveFacebookEventsTabUrl('https://www.facebook.com/groups/perth-volleyball/'),
      'https://www.facebook.com/groups/perth-volleyball/events'
    );
    assert.equal(
      deriveFacebookEventsTabUrl('https://www.facebook.com/groups/123456/about'),
      'https://www.facebook.com/groups/123456/events'
    );

    // profile.php?id=...
    assert.equal(
      deriveFacebookEventsTabUrl('https://www.facebook.com/profile.php?id=100064123456'),
      'https://www.facebook.com/profile.php?id=100064123456&sk=events'
    );
    assert.equal(
      deriveFacebookEventsTabUrl('https://m.facebook.com/profile.php?id=100064123456&sk=about'),
      'https://www.facebook.com/profile.php?id=100064123456&sk=events'
    );

    // Already /events or /events/<id>
    assert.equal(
      deriveFacebookEventsTabUrl('https://www.facebook.com/events'),
      'https://www.facebook.com/events'
    );
    assert.equal(
      deriveFacebookEventsTabUrl('https://www.facebook.com/events/123456789/'),
      'https://www.facebook.com/events/123456789/'
    );
    assert.equal(
      deriveFacebookEventsTabUrl('https://www.facebook.com/perthvolleyball/events'),
      'https://www.facebook.com/perthvolleyball/events'
    );
    assert.equal(
      deriveFacebookEventsTabUrl('https://www.facebook.com/groups/perth-volleyball/events'),
      'https://www.facebook.com/groups/perth-volleyball/events'
    );
    assert.equal(
      deriveFacebookEventsTabUrl('https://www.facebook.com/profile.php?id=100064123456&sk=events'),
      'https://www.facebook.com/profile.php?id=100064123456&sk=events'
    );

    // Legacy /pages/<Name>/<ID> and /people/<Name>/<ID> remain unchanged
    assert.equal(
      deriveFacebookEventsTabUrl('https://www.facebook.com/pages/Perth-Hockey-Club/123456789012345'),
      'https://www.facebook.com/pages/Perth-Hockey-Club/123456789012345'
    );
    assert.equal(
      deriveFacebookEventsTabUrl('https://m.facebook.com/people/Perth-Club/987654321098765/?fbclid=123'),
      'https://www.facebook.com/people/Perth-Club/987654321098765/'
    );

    // Root and invalid URLs
    assert.equal(
      deriveFacebookEventsTabUrl('https://www.facebook.com/'),
      'https://www.facebook.com/'
    );
    assert.equal(deriveFacebookEventsTabUrl('https://www.facebook.com/login'), null);
    assert.equal(deriveFacebookEventsTabUrl('https://example.com/events'), null);
  });

  it('Seam 4 (Issue #22): runFacebookSync targets /events tabs, falls back to base URL on HTTP or Comet error/home routes, caches by fetched URL, and respects --refresh', async () => {
    const fetchCalls = [];
    const cacheMap = new Map();
    const cacheStore = {
      read: async (k) => cacheMap.get(k) || null,
      write: async (k, v) => { cacheMap.set(k, v); }
    };

    const makeEventHtml = (id, title) => `
      <html><head>
        <meta property="og:title" content="${title}" />
        <meta property="og:url" content="https://www.facebook.com/events/${id}/" />
        <meta property="event:start_time" content="2027-04-10T10:00:00Z" />
        <meta property="place:location:latitude" content="-31.9505" />
        <meta property="place:location:longitude" content="115.8605" />
      </head></html>
    `;

    const mockFetch = async (url) => {
      fetchCalls.push(url);
      if (url === 'https://www.facebook.com/pageok/events') {
        return { ok: true, status: 200, text: async () => makeEventHtml('101', 'Page Tab Event') };
      }
      if (url === 'https://www.facebook.com/groups/hoops/events') {
        return { ok: false, status: 404, text: async () => 'Not Found' };
      }
      if (url === 'https://www.facebook.com/groups/hoops') {
        return { ok: true, status: 200, text: async () => makeEventHtml('102', 'Group Base Event') };
      }
      if (url === 'https://www.facebook.com/profile.php?id=998877&sk=events') {
        return {
          ok: true,
          status: 200,
          text: async () => '<html><script>{"canonicalRouteName":"comet.fbweb.CometErrorRoute"}</script></html>'
        };
      }
      if (url === 'https://www.facebook.com/profile.php?id=998877') {
        return { ok: true, status: 200, text: async () => makeEventHtml('103', 'Profile Base Event') };
      }
      if (url === 'https://www.facebook.com/broken/events') {
        return {
          ok: true,
          status: 200,
          text: async () => '<html><script>{"canonicalRouteName":"comet.fbweb.CometHomeRoute"}</script></html>'
        };
      }
      if (url === 'https://www.facebook.com/broken') {
        return { ok: false, status: 500, text: async () => 'Server Error' };
      }
      if (url === 'https://www.facebook.com/eventshomeorg/events') {
        return {
          ok: true,
          status: 200,
          text: async () => `<html><script>{"canonicalRouteName":"comet.fbweb.CometEventsHomeRoute","__typename":"Event","id":"888999000","name":"Generic Feed Event"}</script></html>`
        };
      }
      if (url === 'https://www.facebook.com/eventshomeorg') {
        return { ok: true, status: 200, text: async () => makeEventHtml('104', 'Events Home Fallback Event') };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const mockAdapter = {
      async scanVenues() { return []; },
      async scanOrganizers() {
        return [
          {
            id: 'org_page',
            name: 'Page Org',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://www.facebook.com/pageok' }
          },
          {
            id: 'org_group',
            name: 'Group Org',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://www.facebook.com/groups/hoops' }
          },
          {
            id: 'org_profile',
            name: 'Profile Org',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://www.facebook.com/profile.php?id=998877' }
          },
          {
            id: 'org_broken',
            name: 'Broken Org',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://www.facebook.com/broken' }
          },
          {
            id: 'org_events_home',
            name: 'Events Home Org',
            coordinates: { lat: -31.9505, lng: 115.8605 },
            contact: { facebook: 'https://www.facebook.com/eventshomeorg' }
          }
        ];
      },
      async batchUpsertActivities(activities) {
        return { upserted: activities.length };
      }
    };

    const res = await runFacebookSync({
      adapter: mockAdapter,
      fetchFn: mockFetch,
      cacheStore,
      options: {},
      logger: { log: () => {}, warn: () => {} }
    });

    assert.deepEqual(fetchCalls, [
      'https://www.facebook.com/pageok/events',
      'https://www.facebook.com/groups/hoops/events',
      'https://www.facebook.com/groups/hoops',
      'https://www.facebook.com/profile.php?id=998877&sk=events',
      'https://www.facebook.com/profile.php?id=998877',
      'https://www.facebook.com/broken/events',
      'https://www.facebook.com/broken',
      'https://www.facebook.com/eventshomeorg/events',
      'https://www.facebook.com/eventshomeorg'
    ]);
    assert.equal(res.targets, 4);
    assert.equal(res.failedTargets, 1);
    assert.equal(res.valid, 4);
    assert.deepEqual(res.activities.map(a => a.id), ['facebook_101', 'facebook_102', 'facebook_103', 'facebook_104']);

    // Verify cache keys under normalized fetched URLs
    assert.ok(cacheMap.has('https://www.facebook.com/pageok/events'));
    assert.ok(cacheMap.has('https://www.facebook.com/groups/hoops'));
    assert.ok(cacheMap.has('https://www.facebook.com/profile.php?id=998877'));

    // Second run without --refresh reuses cached payloads for the 3 succeeded targets
    // (groups/hoops/events was 404 so not cached, broken was 500 so not cached)
    fetchCalls.length = 0;
    const cachedRes = await runFacebookSync({
      adapter: {
        async scanVenues() { return []; },
        async scanOrganizers() {
          return (await mockAdapter.scanOrganizers()).filter(o => o.id !== 'org_broken');
        }
      },
      fetchFn: mockFetch,
      cacheStore,
      options: { dryRun: true },
      logger: { log: () => {}, warn: () => {} }
    });
    assert.deepEqual(fetchCalls, [
      'https://www.facebook.com/groups/hoops/events'
    ]);
    assert.equal(cachedRes.valid, 4);

    // Explicit --url with --refresh bypasses cache
    fetchCalls.length = 0;
    const refreshRes = await runFacebookSync({
      adapter: mockAdapter,
      fetchFn: mockFetch,
      cacheStore,
      options: { url: 'https://m.facebook.com/pageok?fbclid=xyz', refresh: true, dryRun: true },
      logger: { log: () => {}, warn: () => {} }
    });
    assert.deepEqual(fetchCalls, ['https://www.facebook.com/pageok/events']);
    assert.equal(refreshRes.valid, 1);
  });

  it('Seam 2 (Issue #23): extractFacebookEvents merges keyless data.event detail fragments with typed Event header fragments', () => {
    const now = new Date('2026-11-19T14:00:00+08:00');
    const detailHtml = `
      <html><body>
        <script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"result":{"data":{"node":{"__typename":"Event","id":"2468013579","name":"Twilight Pickleball Session","day_time_sentence":"Sun, Jun 20, 2027 at 5\\u202fPM","is_canceled":false,"event_place":{"__typename":"Page","name":"Kings Park Courts"}}}}}}]]]}</script>
        <script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"result":{"data":{"event":{"id":"2468013579","url":"https://www.facebook.com/events/2468013579/","event_description":{"text":"All skill levels welcome. Paddles provided."},"event_place":{"name":"Kings Park Courts","location":{"latitude":-31.9612,"longitude":115.8394},"city":{"contextual_name":"Perth, WA"}},"event_hosts_meet_your_host":[{"name":"Perth Pickleball Club"}]}}}}}]]]}</script>
      </body></html>
    `;

    const events = extractFacebookEvents(detailHtml, {
      sourceUrl: 'https://www.facebook.com/events/2468013579/',
      now
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, '2468013579');
    assert.equal(events[0].title, 'Twilight Pickleball Session');
    assert.equal(events[0].description, 'All skill levels welcome. Paddles provided.');
    assert.equal(events[0].source_url, 'https://www.facebook.com/events/2468013579/');
    assert.equal(events[0].start_date, '2027-06-20');
    assert.equal(events[0].start_time, '17:00');
    assert.equal(events[0].venue_name, 'Kings Park Courts');
    assert.deepEqual(events[0].coordinates, { lat: -31.9612, lng: 115.8394 });
    assert.equal(events[0].organizer_name, 'Perth Pickleball Club');
  });

  it('Seam 2 (Issue #23): extractFacebookEvents scopes detail page extraction to target event ID and its child_events, ignoring event_suggested_events and friends_cut', () => {
    const now = new Date('2026-11-19T14:00:00+08:00');
    const detailHtmlWithSidebar = `
      <html><body>
        <script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"result":{"data":{"event":{"id":"2468013579","name":"Primary Club Training","day_time_sentence":"Sun, Jun 20, 2027 at 5\\u202fPM","is_canceled":false,"url":"https://www.facebook.com/events/2468013579/","child_events":{"nodes":[{"id":"24680135791","start_timestamp":1813482000,"end_timestamp":1813489200},{"id":"24680135792","start_timestamp":1814086800,"end_timestamp":1814094000}]},"event_suggested_events":{"nodes":[{"__typename":"Event","id":"999111222","name":"Unrelated Suggested Concert","day_time_sentence":"Sun, Jun 20, 2027 at 8\\u202fPM","is_canceled":false}]},"friends_cut":{"nodes":[{"__typename":"Event","id":"888111222","name":"Unrelated Friends Event","day_time_sentence":"Sun, Jun 20, 2027 at 9\\u202fPM","is_canceled":false}]}}}}}}]]]}</script>
        <script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"result":{"data":{"node":{"__typename":"Event","id":"777111222","name":"Another Sidebar Event","day_time_sentence":"Sun, Jun 20, 2027 at 7\\u202fPM","is_canceled":false}}}}}]]]}</script>
      </body></html>
    `;

    const events = extractFacebookEvents(detailHtmlWithSidebar, {
      sourceUrl: 'https://www.facebook.com/events/2468013579/',
      now
    });

    assert.equal(events.length, 2);
    assert.ok(events.every(e => e.eventId === '2468013579'));
    assert.deepEqual(events.map(e => e.source_id), ['2468013579_20270620', '2468013579_20270627']);
  });

  it('Seam 4 (Issue #23): runFacebookSync always hydrates /events/<id> detail pages even when summary cards have start dates and excludes sidebar events', async () => {
    const now = new Date('2026-11-19T14:00:00+08:00');
    const eventsTabHtml = `
      <html><body>
        <script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"result":{"data":{"node":{"__typename":"Event","id":"555666777","name":"Sunday Social Tennis","day_time_sentence":"Sun, Jun 20, 2027 at 5\\u202fPM","is_canceled":false}}}}}]]]}</script>
      </body></html>
    `;
    const detailHtml = `
      <html><body>
        <script type="application/json">{"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"result":{"data":{"node":{"__typename":"Event","id":"555666777","name":"Sunday Social Tennis","day_time_sentence":"Sun, Jun 20, 2027 at 5\\u202fPM","is_canceled":false}}}}}]]]}</script>
        <script type="application/json">${JSON.stringify({
          require: [['ScheduledServerJS', 'handle', null, [{
            __bbox: {
              result: {
                data: {
                  event: {
                    id: '555666777',
                    url: 'https://www.facebook.com/events/555666777/',
                    event_description: { text: 'Full hydrated description from detail page.' },
                    event_place: { name: 'UWA Tennis Club', location: { latitude: -31.9812, longitude: 115.8194 } },
                    event_hosts_meet_your_host: [{ name: 'UWA Tennis Club' }],
                    event_suggested_events: {
                      nodes: [{
                        __typename: 'Event',
                        id: '999888777',
                        name: 'Sidebar Suggested Gig',
                        day_time_sentence: 'Sun, Jun 20, 2027 at 8\u202fPM',
                        is_canceled: false,
                        event_place: { name: 'Perth Concert Hall', location: { latitude: -31.9565, longitude: 115.8626 } }
                      }]
                    }
                  }
                }
              }
            }
          }]]]
        })}</script>
      </body></html>
    `;

    const cacheMap = new Map();
    const cacheStore = {
      read: async (k) => cacheMap.get(k) || null,
      write: async (k, v) => { cacheMap.set(k, v); }
    };
    const fetchCalls = [];
    const mockFetch = async (url) => {
      fetchCalls.push(url);
      if (url === 'https://www.facebook.com/uwatennis/events') {
        return { ok: true, status: 200, text: async () => eventsTabHtml };
      }
      if (url === 'https://www.facebook.com/events/555666777/') {
        return { ok: true, status: 200, text: async () => detailHtml };
      }
      if (url === 'https://www.facebook.com/events/999888777/') {
        return {
          ok: true,
          status: 200,
          text: async () => `
            <html><body>
              <script type="application/json">${JSON.stringify({
                require: [['ScheduledServerJS', 'handle', null, [{
                  __bbox: {
                    result: {
                      data: {
                        event: {
                          id: '999888777',
                          name: 'Sidebar Suggested Gig',
                          day_time_sentence: 'Sun, Jun 20, 2027 at 8\u202fPM',
                          is_canceled: false,
                          url: 'https://www.facebook.com/events/999888777/',
                          event_description: { text: 'Live orchestral concert.' },
                          event_place: { name: 'Perth Concert Hall', location: { latitude: -31.9565, longitude: 115.8626 } }
                        }
                      }
                    }
                  }
                }]]]
              })}</script>
            </body></html>
          `
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const res = await runFacebookSync({
      adapter: {
        async scanVenues() { return []; },
        async scanOrganizers() {
          return [{
            id: 'org_uwa_tennis',
            name: 'UWA Tennis Club',
            subcategory: 'tennis',
            coordinates: { lat: -31.9812, lng: 115.8194 },
            contact: { facebook: 'https://www.facebook.com/uwatennis' }
          }];
        }
      },
      fetchFn: mockFetch,
      cacheStore,
      options: { dryRun: true, now },
      logger: { log: () => {}, warn: () => {} }
    });

    assert.deepEqual(fetchCalls, [
      'https://www.facebook.com/uwatennis/events',
      'https://www.facebook.com/events/555666777/',
      'https://www.facebook.com/events/999888777/'
    ]);
    assert.ok(cacheMap.has('https://www.facebook.com/events/555666777/'));
    assert.equal(res.valid, 2);
    assert.equal(res.activities.length, 2);
    const seedActivity = res.activities.find(a => a.id === 'facebook_555666777');
    const sidebarActivity = res.activities.find(a => a.id === 'facebook_999888777');
    assert.ok(seedActivity);
    assert.equal(seedActivity.description, 'Full hydrated description from detail page.');
    assert.equal(seedActivity.source_url, 'https://www.facebook.com/events/555666777/');
    assert.deepEqual(seedActivity.venue.coordinates, { lat: -31.9812, lng: 115.8194 });
    assert.ok(sidebarActivity);
    assert.equal(sidebarActivity.subcategory, 'other');
    assert.notEqual(sidebarActivity.organizer?.id, 'org_uwa_tennis');
  });

  it('Seam 2 (Issue #24): extractRelatedFacebookEventLinks extracts deduplicated 1-hop event IDs from event_suggested_events and friends_cut', () => {
    const detailHtml = `
      <html><body>
        <script type="application/json">${JSON.stringify({
          require: [['ScheduledServerJS', 'handle', null, [{
            __bbox: {
              result: {
                data: {
                  event: {
                    id: '2468013579',
                    name: 'Primary Club Training',
                    event_suggested_events: {
                      nodes: [
                        { __typename: 'Event', id: '111222333', name: 'Suggested Pickleball' },
                        { __typename: 'Event', id: '999888777', name: 'Suggested Food Festival' },
                        { __typename: 'Event', id: '2468013579', name: 'Self Reference' }
                      ]
                    },
                    friends_cut: {
                      edges: [
                        { node: { __typename: 'Event', id: '111222333', name: 'Duplicate Suggested Pickleball' } },
                        { node: { __typename: 'Event', id: '444555666', name: 'Friends Badminton Night' } }
                      ]
                    }
                  }
                }
              }
            }
          }]]]
        })}</script>
      </body></html>
    `;

    const related = extractRelatedFacebookEventLinks(detailHtml, { excludeEventId: '2468013579' });
    assert.deepEqual(related, [
      { eventId: '111222333', url: 'https://www.facebook.com/events/111222333/' },
      { eventId: '999888777', url: 'https://www.facebook.com/events/999888777/' },
      { eventId: '444555666', url: 'https://www.facebook.com/events/444555666/' }
    ]);

    assert.deepEqual(extractRelatedFacebookEventLinks('BEGIN:VCALENDAR\nEND:VCALENDAR'), []);
    assert.deepEqual(extractRelatedFacebookEventLinks('{"canonicalRouteName":"comet.fbweb.CometErrorRoute"}'), []);
  });

  it('Seam 4 (Issue #24): runFacebookSync discovers 1-hop sports Activities from hydrated Perth detail pages, reconciles Organizers, excludes non-sport/out-of-area events, and enforces --limit and deduplication', async () => {
    const now = new Date('2026-11-19T14:00:00+08:00');
    const makeDetailHtml = (eventObj) => `
      <html><body>
        <script type="application/json">${JSON.stringify({
          require: [['ScheduledServerJS', 'handle', null, [{
            __bbox: { result: { data: { event: eventObj } } }
          }]]]
        })}</script>
      </body></html>
    `;

    const eventsTabHtml = `
      <html><body>
        <script type="application/json">${JSON.stringify({
          require: [['ScheduledServerJS', 'handle', null, [{
            __bbox: {
              result: {
                data: {
                  node: {
                    __typename: 'Event',
                    id: '555666777',
                    name: 'Sunday Social Tennis',
                    day_time_sentence: 'Sun, Jun 20, 2027 at 5\u202fPM',
                    is_canceled: false
                  }
                }
              }
            }
          }]]]
        })}</script>
      </body></html>
    `;

    const seedDetailHtml = makeDetailHtml({
      id: '555666777',
      name: 'Sunday Social Tennis',
      day_time_sentence: 'Sun, Jun 20, 2027 at 5\u202fPM',
      is_canceled: false,
      url: 'https://www.facebook.com/events/555666777/',
      event_description: { text: 'Social tennis doubles at UWA.' },
      event_place: { name: 'UWA Tennis Club', location: { latitude: -31.9812, longitude: 115.8194 } },
      event_hosts_meet_your_host: [{ name: 'UWA Tennis Club' }],
      event_suggested_events: {
        nodes: [
          { __typename: 'Event', id: '999888777', name: 'Perth Night Market & Food Festival' },
          { __typename: 'Event', id: '111222333', name: 'Saturday Morning Pickleball' },
          { __typename: 'Event', id: '555666777', name: 'Duplicate Seed Event' }
        ]
      },
      friends_cut: {
        nodes: [
          { __typename: 'Event', id: '222333444', name: 'Social Volleyball Night' },
          { __typename: 'Event', id: '333444555', name: 'Sydney Harbour Volleyball' },
          { __typename: 'Event', id: '666777888', name: 'Online Fitness Webinar' },
          { __typename: 'Event', id: '777888999', name: 'Past Perth Market' },
          { __typename: 'Event', id: '111222333', name: 'Duplicate Suggested Pickleball' }
        ]
      }
    });

    const pages = {
      'https://www.facebook.com/uwatennis/events': eventsTabHtml,
      'https://www.facebook.com/events/555666777/': seedDetailHtml,
      'https://www.facebook.com/events/999888777/': makeDetailHtml({
        id: '999888777',
        name: 'Perth Night Market & Food Festival',
        day_time_sentence: 'Sun, Jun 20, 2027 at 6\u202fPM',
        is_canceled: false,
        url: 'https://www.facebook.com/events/999888777/',
        event_description: { text: 'Street food, live music, and artisan stalls in Perth.' },
        event_place: { name: 'Forrest Place', location: { latitude: -31.9522, longitude: 115.8589 } },
        event_hosts_meet_your_host: [{ name: 'Perth Night Markets' }]
      }),
      'https://www.facebook.com/events/111222333/': makeDetailHtml({
        id: '111222333',
        name: 'Saturday Morning Pickleball',
        day_time_sentence: 'Sat, Jun 26, 2027 at 9\u202fAM',
        is_canceled: false,
        url: 'https://www.facebook.com/events/111222333/',
        event_description: { text: 'Open pickleball rally games, paddles supplied.' },
        event_place: { name: 'Kings Park Courts', location: { latitude: -31.9612, longitude: 115.8394 } },
        event_hosts_meet_your_host: [{ name: 'Perth Pickleball Club' }],
        event_suggested_events: {
          nodes: [{ __typename: 'Event', id: '444555666', name: '2-Hop Should Never Be Fetched' }]
        }
      }),
      'https://www.facebook.com/events/222333444/': makeDetailHtml({
        id: '222333444',
        name: 'Social Volleyball Night',
        day_time_sentence: 'Fri, Jun 25, 2027 at 7\u202fPM',
        is_canceled: false,
        url: 'https://www.facebook.com/events/222333444/',
        event_description: { text: 'Casual volleyball doubles for all levels.' },
        event_place: { name: 'Kings Park Courts', location: { latitude: -31.9612, longitude: 115.8394 } },
        event_hosts: [{ name: 'Unmatched Volleyball Group' }]
      }),
      'https://www.facebook.com/events/333444555/': makeDetailHtml({
        id: '333444555',
        name: 'Sydney Harbour Volleyball',
        day_time_sentence: 'Sat, Jun 26, 2027 at 10\u202fAM',
        is_canceled: false,
        url: 'https://www.facebook.com/events/333444555/',
        event_description: { text: 'Beach volleyball in Sydney.' },
        event_place: { name: 'Bondi Beach', location: { latitude: -33.8915, longitude: 151.2767 } },
        event_hosts_meet_your_host: [{ name: 'Sydney Beach Club' }]
      }),
      'https://www.facebook.com/events/666777888/': makeDetailHtml({
        id: '666777888',
        name: 'Online Fitness Webinar',
        day_time_sentence: 'Sat, Jun 26, 2027 at 11\u202fAM',
        is_canceled: false,
        is_online: true,
        url: 'https://www.facebook.com/events/666777888/',
        event_description: { text: 'Live Zoom workout from Perth.' },
        event_place: { name: 'Online', location: { latitude: -31.9505, longitude: 115.8605 } },
        event_hosts_meet_your_host: [{ name: 'Perth Fitness Online' }]
      }),
      'https://www.facebook.com/events/777888999/': makeDetailHtml({
        id: '777888999',
        name: 'Past Perth Market',
        day_time_sentence: 'Sun, Jun 20, 2025 at 10\u202fAM',
        is_canceled: false,
        url: 'https://www.facebook.com/events/777888999/',
        event_description: { text: 'Expired local gathering in Perth.' },
        event_place: { name: 'Forrest Place', location: { latitude: -31.9522, longitude: 115.8589 } },
        event_hosts_meet_your_host: [{ name: 'Perth Night Markets' }]
      })
    };

    const cacheMap = new Map();
    const cacheStore = {
      read: async (k) => cacheMap.get(k) || null,
      write: async (k, v) => { cacheMap.set(k, v); }
    };
    const fetchCalls = [];
    const mockFetch = async (url) => {
      fetchCalls.push(url);
      if (pages[url]) {
        return { ok: true, status: 200, text: async () => pages[url] };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const mockAdapter = {
      async scanVenues() {
        return [
          {
            id: 'venue_uwa_tennis',
            name: 'UWA Tennis Club',
            coordinates: { lat: -31.9812, lng: 115.8194 },
            geohash: 'qd66h0000'
          },
          {
            id: 'venue_kings_park_courts',
            name: 'Kings Park Courts',
            coordinates: { lat: -31.9612, lng: 115.8394 },
            geohash: 'qd66h1111'
          }
        ];
      },
      async scanOrganizers() {
        return [
          {
            id: 'org_uwa_tennis',
            name: 'UWA Tennis Club',
            subcategory: 'tennis',
            coordinates: { lat: -31.9812, lng: 115.8194 },
            contact: { facebook: 'https://www.facebook.com/uwatennis' }
          },
          {
            id: 'org_perth_pickleball',
            name: 'Perth Pickleball Club',
            subcategory: 'pickleball',
            coordinates: { lat: -31.9612, lng: 115.8394 }
          }
        ];
      }
    };

    const res = await runFacebookSync({
      adapter: mockAdapter,
      fetchFn: mockFetch,
      cacheStore,
      options: { dryRun: true, now },
      logger: { log: () => {}, warn: () => {} }
    });

    // 2-hop candidate 444555666 must never be fetched; 111222333 and 555666777 must not be fetched twice
    assert.ok(!fetchCalls.includes('https://www.facebook.com/events/444555666/'));
    assert.equal(fetchCalls.filter(u => u === 'https://www.facebook.com/events/111222333/').length, 1);
    assert.equal(fetchCalls.filter(u => u === 'https://www.facebook.com/events/555666777/').length, 1);
    assert.ok(cacheMap.has('https://www.facebook.com/events/111222333/'));

    // Seed tennis + 1-hop pickleball + 1-hop volleyball + 1-hop 'other' (online, expired, & Sydney excluded)
    assert.equal(res.valid, 4);
    const byId = new Map(res.activities.map(a => [a.id, a]));
    assert.ok(byId.has('facebook_555666777'));
    assert.ok(byId.has('facebook_111222333'));
    assert.ok(byId.has('facebook_222333444'));
    assert.ok(byId.has('facebook_999888777'));
    assert.equal(byId.get('facebook_999888777').subcategory, 'other');
    assert.ok(!byId.has('facebook_333444555'));
    assert.ok(!byId.has('facebook_666777888'));
    assert.ok(!byId.has('facebook_777888999'));

    // 111222333 reconciled to canonical Perth Pickleball Club, not UWA Tennis Club
    const pickleball = byId.get('facebook_111222333');
    assert.equal(pickleball.subcategory, 'pickleball');
    assert.equal(pickleball.organizer.id, 'org_perth_pickleball');
    assert.equal(pickleball.organizer.name, 'Perth Pickleball Club');
    assert.equal(pickleball.needs_review, false);

    // 222333444 keeps its unmatched Organizer name and is flagged needs_review: true (unmatched_organizer)
    const volleyball = byId.get('facebook_222333444');
    assert.equal(volleyball.subcategory, 'volleyball');
    assert.equal(volleyball.organizer.name, 'Unmatched Volleyball Group');
    assert.notEqual(volleyball.organizer.id, 'org_uwa_tennis');
    assert.equal(volleyball.needs_review, true);
    assert.equal(volleyball.review_reason, 'unmatched_organizer');

    // Bounded by --limit=2
    const limitedFetchCalls = [];
    const limitedRes = await runFacebookSync({
      adapter: mockAdapter,
      fetchFn: async (url) => {
        limitedFetchCalls.push(url);
        return mockFetch(url);
      },
      cacheStore: { read: async () => null, write: async () => {} },
      options: { dryRun: true, limit: 2, now },
      logger: { log: () => {}, warn: () => {} }
    });
    assert.equal(limitedRes.valid, 2);
    assert.ok(!limitedFetchCalls.includes('https://www.facebook.com/events/222333444/'));
  });

  it('Seam 4 (Issue #28): runFacebookSync enforces tiered cache TTLs (48h organizer, 14d detail, 7d non-entity) relative to options.now', async () => {
    const t0 = new Date('2026-11-01T00:00:00.000Z');
    const orgTabHtml = `
      <html><body>
        <script type="application/json">{"__typename":"Event","id":"123456789","name":"Sunday Tennis"}</script>
      </body></html>
    `;
    const eventDetailHtml = `
      <html><head>
        <meta property="og:title" content="Sunday Tennis Social" />
        <meta property="event:start_time" content="2026-12-01T09:00:00+08:00" />
        <meta property="place:location:latitude" content="-31.9505" />
        <meta property="place:location:longitude" content="115.8605" />
      </head></html>
    `;
    const nonEntityHtml = `<html><script>{"canonicalRouteName":"comet.fbweb.CometErrorRoute"}</script></html>`;
    const basePageHtml = `<html><body><p>No upcoming events</p></body></html>`;

    const cacheMap = new Map([
      ['https://www.facebook.com/clubalpha/events', {
        url: 'https://www.facebook.com/clubalpha/events',
        fetchedAt: t0.toISOString(),
        body: orgTabHtml
      }],
      ['https://www.facebook.com/events/123456789/', {
        url: 'https://www.facebook.com/events/123456789/',
        fetchedAt: t0.toISOString(),
        body: eventDetailHtml
      }],
      ['https://www.facebook.com/clubbeta/events', {
        url: 'https://www.facebook.com/clubbeta/events',
        fetchedAt: t0.toISOString(),
        body: nonEntityHtml
      }],
      ['https://www.facebook.com/clubbeta', {
        url: 'https://www.facebook.com/clubbeta',
        fetchedAt: t0.toISOString(),
        body: basePageHtml
      }]
    ]);

    const cacheStore = {
      read: async (k) => cacheMap.get(k) || null,
      write: async (k, v) => { cacheMap.set(k, v); }
    };

    const mockAdapter = {
      async scanVenues() { return []; },
      async scanOrganizers() {
        return [
          { id: 'org_alpha', name: 'Club Alpha', contact: { facebook: 'https://www.facebook.com/clubalpha' } },
          { id: 'org_beta', name: 'Club Beta', contact: { facebook: 'https://www.facebook.com/clubbeta' } }
        ];
      }
    };

    const fetchCalls = [];
    const mockFetch = async (url) => {
      fetchCalls.push(url);
      if (url === 'https://www.facebook.com/clubalpha/events') return { ok: true, status: 200, text: async () => orgTabHtml };
      if (url === 'https://www.facebook.com/events/123456789/') return { ok: true, status: 200, text: async () => eventDetailHtml };
      if (url === 'https://www.facebook.com/clubbeta/events') return { ok: true, status: 200, text: async () => nonEntityHtml };
      if (url === 'https://www.facebook.com/clubbeta') return { ok: true, status: 200, text: async () => basePageHtml };
      return { ok: false, status: 404, text: async () => '' };
    };

    const runAt = (offsetMs) => {
      fetchCalls.length = 0;
      return runFacebookSync({
        adapter: mockAdapter,
        fetchFn: mockFetch,
        cacheStore,
        options: { dryRun: true, now: new Date(t0.getTime() + offsetMs) },
        logger: { log: () => {}, warn: () => {} }
      });
    };

    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;

    // 1. At 47h59m: all 4 cached entries are fresh -> 0 fetches
    await runAt(48 * HOUR - 60_000);
    assert.deepEqual(fetchCalls, []);

    // 2. At 48h01m: organizer /events tab and base page expire (48h TTL), while non-entity (7d) and detail (14d) stay cached
    await runAt(48 * HOUR + 60_000);
    assert.deepEqual(fetchCalls, [
      'https://www.facebook.com/clubalpha/events',
      'https://www.facebook.com/clubbeta'
    ]);

    // 3. At 6d23h (from t0): non-entity route is still cached (7d TTL)
    await runAt(7 * DAY - 60_000);
    assert.ok(!fetchCalls.includes('https://www.facebook.com/clubbeta/events'));
    assert.ok(!fetchCalls.includes('https://www.facebook.com/events/123456789/'));

    // 4. At 7d01m (from t0): non-entity route expires (7d TTL), detail page still cached (14d TTL)
    await runAt(7 * DAY + 60_000);
    assert.ok(fetchCalls.includes('https://www.facebook.com/clubbeta/events'));
    assert.ok(!fetchCalls.includes('https://www.facebook.com/events/123456789/'));

    // 5. At 13d23h (from t0): detail page is still cached (14d TTL)
    await runAt(14 * DAY - 60_000);
    assert.ok(!fetchCalls.includes('https://www.facebook.com/events/123456789/'));

    // 6. At 14d01m (from t0): detail page expires (14d TTL) and is re-fetched
    await runAt(14 * DAY + 60_000);
    assert.ok(fetchCalls.includes('https://www.facebook.com/events/123456789/'));

    // 7. Entry missing fetchedAt is treated as expired and re-fetched
    cacheMap.set('https://www.facebook.com/events/123456789/', {
      url: 'https://www.facebook.com/events/123456789/',
      body: eventDetailHtml
    });
    await runAt(14 * DAY + 120_000);
    assert.ok(fetchCalls.includes('https://www.facebook.com/events/123456789/'));
  });
});
