import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { extractFacebookEventLinks } from '../src/facebook-parser.js';
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

    assert.deepEqual(fetchedUrls, ['https://www.facebook.com/alphaclub/events']);
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
      'https://www.facebook.com/betaclub/events'
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
    assert.deepEqual(fetchedUrls, ['https://www.facebook.com/betaclub/events']);
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
    assert.deepEqual(extractFacebookEventLinks(errorHtml), []);
    assert.deepEqual(extractFacebookEventLinks(homeHtml), []);
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
      'https://www.facebook.com/broken'
    ]);
    assert.equal(res.targets, 3);
    assert.equal(res.failedTargets, 1);
    assert.equal(res.valid, 3);
    assert.deepEqual(res.activities.map(a => a.id), ['facebook_101', 'facebook_102', 'facebook_103']);

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
    assert.equal(cachedRes.valid, 3);

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
});
