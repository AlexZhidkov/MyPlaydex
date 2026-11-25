import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createFileCacheStore } from '../src/file-cache.js';
import {
  DEFAULT_PDF_SCRAPE_TIMEOUT_MS,
  DEFAULT_PDF_TIMETABLE_SEEDS,
  isPdfUrl,
  isTimetablePdfUrl
} from '../src/pdf-timetable-seeds.js';
import {
  filterCandidateUrls,
  parseCliArgs,
  runOrganizerWebsiteSync,
  selectDripOrganizerTargets
} from '../src/organizer-website-sync.js';

describe('Leisure-Centre & Council PDF Timetable Ingestion (Issue #56)', () => {
  it('Seam 1: selects /v2/map-discovered timetable PDFs, filters non-activity PDFs, and prioritizes Tier-1 PDF seeds', async () => {
    assert.ok(Array.isArray(DEFAULT_PDF_TIMETABLE_SEEDS) && DEFAULT_PDF_TIMETABLE_SEEDS.length > 0);
    assert.ok(DEFAULT_PDF_SCRAPE_TIMEOUT_MS >= 60000);
    assert.equal(isPdfUrl('https://example.wa.gov.au/docs/Group-Fitness-Timetable.PDF?v=2'), true);
    assert.equal(isPdfUrl('https://example.wa.gov.au/events'), false);
    assert.equal(isTimetablePdfUrl('https://example.wa.gov.au/wp-content/uploads/2026/11/group-fitness-timetable.pdf'), true);
    assert.equal(isTimetablePdfUrl('https://example.wa.gov.au/docs/annual-report-2026.pdf'), false);

    const baseUrl = 'https://www.bayswaterwaves.wa.gov.au/';
    const mapLinks = [
      'https://www.bayswaterwaves.wa.gov.au/about',
      'https://www.bayswaterwaves.wa.gov.au/contact',
      'https://www.bayswaterwaves.wa.gov.au/docs/privacy-policy.pdf',
      'https://www.bayswaterwaves.wa.gov.au/docs/annual-report-2026.pdf',
      'https://www.bayswaterwaves.wa.gov.au/docs/membership-form.pdf',
      'https://www.bayswaterwaves.wa.gov.au/wp-content/uploads/2026/11/group-fitness-timetable.pdf',
      'https://www.bayswaterwaves.wa.gov.au/wp-content/uploads/2026/11/aquatic-classes-schedule.pdf',
      'https://www.bayswaterwaves.wa.gov.au/events',
      'https://www.bayswaterwaves.wa.gov.au/calendar',
      'https://www.bayswaterwaves.wa.gov.au/classes'
    ];

    const selected = filterCandidateUrls(mapLinks, baseUrl, { maxUrls: 5 });
    assert.equal(selected.length, 5);
    assert.ok(selected.includes('https://www.bayswaterwaves.wa.gov.au/wp-content/uploads/2026/11/group-fitness-timetable.pdf'));
    assert.ok(selected.includes('https://www.bayswaterwaves.wa.gov.au/wp-content/uploads/2026/11/aquatic-classes-schedule.pdf'));
    assert.ok(!selected.some(u => u.includes('privacy-policy.pdf') || u.includes('annual-report-2026.pdf') || u.includes('membership-form.pdf')));

    const cliDefault = parseCliArgs([], {});
    assert.equal(cliDefault.includePdfSeeds, true);
    const cliDisabled = parseCliArgs(['--no-pdf-seeds'], {});
    assert.equal(cliDisabled.includePdfSeeds, false);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-pdf-seeds-'));
    const cacheStore = createFileCacheStore(path.join(tmpDir, 'cache.json'));
    const now = new Date('2026-11-25T10:00:00+08:00');

    const seeds = [
      {
        name: 'cockburn_arc_group_fitness',
        url: 'https://www.cockburnarc.com.au/docs/group-fitness-timetable.pdf',
        organizerName: 'City of Cockburn - Cockburn ARC',
        venueName: 'Cockburn ARC'
      }
    ];

    const targets = await selectDripOrganizerTargets({
      organizersCatalog: [
        { id: 'org_tier2', name: 'Tier 2 Organizer', website: 'https://tier2org.org.au' },
        { id: 'org_tier1', name: 'Tier 1 Organizer', website: 'https://tier1org.org.au' }
      ],
      activitiesCatalog: [
        { id: 'act_1', organizer: { id: 'org_tier2', name: 'Tier 2 Organizer' }, expire_at: null }
      ],
      pdfTimetableSeeds: [
        ...seeds,
        ...seeds
      ],
      cacheStore,
      now,
      maxDomains: 10
    });

    assert.equal(targets.length, 3);
    assert.equal(targets[0].organizer.id, 'org_tier1');
    assert.equal(targets[0].tier, 1);
    assert.equal(targets[1].websiteUrl, 'https://www.cockburnarc.com.au/docs/group-fitness-timetable.pdf');
    assert.equal(targets[1].tier, 1);
    assert.equal(targets[1].isPdfSeed, true);
    assert.equal(targets[1].venueName, 'Cockburn ARC');
    assert.equal(targets[2].organizer.id, 'org_tier2');
    assert.equal(targets[2].tier, 2);
  });

  it('Seam 2: uses PDF-appropriate scrape timeouts, skips /v2/map for PDF seeds, and extracts multi-row weekly timetable classes via Gemini Flash', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-pdf-extract-'));
    const cacheStore = createFileCacheStore(path.join(tmpDir, 'cache.json'));
    const now = new Date('2026-11-25T10:00:00+08:00');

    const mapCalls = [];
    const scrapeCalls = [];
    const geminiCalls = [];

    const pdfSeedUrl = 'https://www.cockburnarc.com.au/docs/group-fitness-timetable.pdf';
    const mappedPdfUrl = 'https://www.bayswaterwaves.wa.gov.au/docs/aquatic-timetable.pdf';

    const firecrawlClient = {
      async map(url) {
        mapCalls.push(url);
        return {
          url,
          links: [mappedPdfUrl],
          fromCache: false
        };
      },
      async scrape(url, opts) {
        scrapeCalls.push({ url, opts });
        if (url === pdfSeedUrl) {
          return {
            url,
            html: null,
            markdown: [
              '# Cockburn ARC Group Fitness Timetable',
              '| Day | Time | Class | Studio |',
              '| Monday | 06:00 - 06:45 | Spin Cycle | Cycle Studio |',
              '| Wednesday | 09:30 - 10:30 | Hatha Yoga | Studio 2 |',
              '| Friday | 17:30 - 18:15 | BodyPump | Main Hall |'
            ].join('\n'),
            links: []
          };
        }
        return {
          url,
          html: null,
          markdown: [
            '# Bayswater Waves Aquatic Timetable',
            '- Tuesday 07:00-07:45 Aqua Aerobics (Main Pool)',
            '- 2026-12-15 10:00-11:30 School Holiday Swim Clinic'
          ].join('\n'),
          links: []
        };
      },
      async flushCache() {}
    };

    const geminiClient = {
      async extractActivitiesFromMarkdown(payload) {
        geminiCalls.push(payload);
        if (payload.sourceUrl === pdfSeedUrl) {
          return {
            activities: [
              {
                title: 'Spin Cycle',
                category: 'sports',
                weekday: 'Monday',
                start_date: null,
                end_date: null,
                start_time: '06:00',
                end_time: '06:45',
                venue_name: 'Cycle Studio',
                is_noise: false,
                confidence: 'high'
              },
              {
                title: 'Hatha Yoga',
                category: 'sports',
                weekday: 'Wednesday',
                start_date: null,
                end_date: null,
                start_time: '09:30',
                end_time: '10:30',
                venue_name: 'Studio 2',
                is_noise: false,
                confidence: 'high'
              },
              {
                title: 'BodyPump',
                category: 'sports',
                weekday: 'Friday',
                start_date: null,
                end_date: null,
                start_time: '17:30',
                end_time: '18:15',
                venue_name: 'Main Hall',
                is_noise: false,
                confidence: 'high'
              }
            ]
          };
        }
        return {
          activities: [
            {
              title: 'Aqua Aerobics',
              category: 'sports',
              weekday: 'Tuesday',
              start_date: null,
              end_date: null,
              start_time: '07:00',
              end_time: '07:45',
              venue_name: 'Main Pool',
              is_noise: false,
              confidence: 'high'
            },
            {
              title: 'School Holiday Swim Clinic',
              category: 'sports',
              weekday: null,
              start_date: '2026-12-15',
              end_date: null,
              start_time: '10:00',
              end_time: '11:30',
              venue_name: 'Bayswater Waves',
              is_noise: false,
              confidence: 'high'
            }
          ]
        };
      }
    };

    const upsertedBatches = [];
    const adapter = {
      async scanOrganizers() {
        return [
          {
            id: 'org_waves',
            name: 'Bayswater Waves',
            website: 'https://www.bayswaterwaves.wa.gov.au',
            venue: {
              id: 'venue_waves',
              name: 'Bayswater Waves',
              coordinates: { lat: -31.9089, lng: 115.9083 }
            }
          }
        ];
      },
      async scanVenues() {
        return [
          { id: 'venue_cockburn_arc', name: 'Cockburn ARC', coordinates: { lat: -32.1264, lng: 115.8582 } },
          { id: 'venue_waves', name: 'Bayswater Waves', coordinates: { lat: -31.9089, lng: 115.9083 } }
        ];
      },
      async scanActivities() {
        return [];
      },
      async batchUpsertActivities(items) {
        upsertedBatches.push(items);
        return { upserted: items.length };
      }
    };

    const summary = await runOrganizerWebsiteSync({
      adapter,
      firecrawlClient,
      geminiClient,
      cacheStore,
      options: {
        dryRun: false,
        maxDomains: 5,
        maxUrlsPerDomain: 3,
        now,
        pdfTimetableSeeds: [
          {
            name: 'cockburn_arc_group_fitness',
            url: pdfSeedUrl,
            organizerName: 'City of Cockburn - Cockburn ARC',
            venueName: 'Cockburn ARC'
          }
        ]
      },
      logger: { log() {}, warn() {}, error() {} }
    });

    // Only the Organizer website should be mapped via /v2/map; the direct PDF seed skips /v2/map
    assert.deepEqual(mapCalls, ['https://www.bayswaterwaves.wa.gov.au/']);
    assert.equal(scrapeCalls.length, 2);
    for (const call of scrapeCalls) {
      assert.deepEqual(call.opts.formats, ['markdown']);
      assert.equal(call.opts.timeoutMs, DEFAULT_PDF_SCRAPE_TIMEOUT_MS);
    }
    assert.equal(geminiCalls.length, 2);
    assert.equal(summary.extractedCount, 5);
    assert.equal(summary.upsertedCount, 5);

    const saved = upsertedBatches[0];
    const weeklyClasses = saved.filter(a => a.schedule.recurrence === 'weekly');
    const datedClasses = saved.filter(a => a.schedule.recurrence === 'none');
    assert.equal(weeklyClasses.length, 4);
    assert.equal(datedClasses.length, 1);
    assert.ok(weeklyClasses.every(a => a.expire_at === null));
  });

  it('Seam 3: grounds each extracted Activity to the exact PDF URL, resolves Venue to the leisure centre/hall, and deduplicates idempotently', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-pdf-dedupe-'));
    const now = new Date('2026-11-25T10:00:00+08:00');
    const pdfSeedUrl = 'https://www.cockburnarc.com.au/docs/group-fitness-timetable.pdf';

    const firecrawlClient = {
      async map() {
        throw new Error('map should not be called for PDF seed');
      },
      async scrape(url) {
        return {
          url,
          html: null,
          markdown: '# Cockburn ARC\n- Monday 06:00-06:45 Spin Cycle (Cycle Studio)\n- Monday 17:30-18:15 Spin Cycle (Cycle Studio)',
          links: []
        };
      },
      async flushCache() {}
    };

    const geminiClient = {
      async extractActivitiesFromMarkdown() {
        return {
          activities: [
            {
              title: 'Spin Cycle',
              category: 'sports',
              weekday: 'Monday',
              start_date: null,
              end_date: null,
              start_time: '06:00',
              end_time: '06:45',
              venue_name: 'Cycle Studio',
              is_noise: false,
              confidence: 'high'
            },
            {
              title: 'Spin Cycle',
              category: 'sports',
              weekday: 'Monday',
              start_date: null,
              end_date: null,
              start_time: '17:30',
              end_time: '18:15',
              venue_name: null,
              is_noise: false,
              confidence: 'high'
            }
          ]
        };
      }
    };

    const storedActivities = [];
    const adapter = {
      async scanOrganizers() {
        return [
          {
            id: 'org_cockburn_arc',
            name: 'City of Cockburn - Cockburn ARC'
          }
        ];
      },
      async scanVenues() {
        return [
          {
            id: 'venue_cockburn_arc',
            name: 'Cockburn ARC',
            coordinates: { lat: -32.1264, lng: 115.8582 }
          }
        ];
      },
      async scanActivities() {
        return storedActivities;
      },
      async batchUpsertActivities(items) {
        for (const item of items) {
          const idx = storedActivities.findIndex(existing => existing.id === item.id);
          if (idx >= 0) {
            storedActivities[idx] = item;
          } else {
            storedActivities.push(item);
          }
        }
        return { upserted: items.length };
      }
    };

    const seeds = [
      {
        name: 'cockburn_arc_group_fitness',
        url: pdfSeedUrl,
        organizerName: 'City of Cockburn - Cockburn ARC',
        venueName: 'Cockburn ARC',
        suburb: 'Cockburn Central'
      }
    ];

    const firstRun = await runOrganizerWebsiteSync({
      adapter,
      firecrawlClient,
      geminiClient,
      cacheStore: createFileCacheStore(path.join(tmpDir, 'cache-1.json')),
      options: { dryRun: false, maxDomains: 5, now, pdfTimetableSeeds: seeds },
      logger: { log() {}, warn() {}, error() {} }
    });

    assert.equal(firstRun.upsertedCount, 2);
    assert.equal(storedActivities.length, 2);
    assert.notEqual(storedActivities[0].id, storedActivities[1].id);

    for (const act of storedActivities) {
      assert.equal(act.source, 'organizer_website');
      assert.equal(act.source_url, pdfSeedUrl);
      assert.equal(act.raw_source_url, pdfSeedUrl);
      assert.equal(act.sources[0].source_url, pdfSeedUrl);
      assert.equal(act.venue.id, 'venue_cockburn_arc');
      assert.equal(act.venue.name, 'Cockburn ARC');
      assert.equal(act.schedule.recurrence, 'weekly');
      assert.equal(act.expire_at, null);
      assert.equal(act.needs_review, false);
    }

    // Re-running against existing /activities deduplicates idempotently without creating duplicates
    const secondRun = await runOrganizerWebsiteSync({
      adapter,
      firecrawlClient,
      geminiClient,
      cacheStore: createFileCacheStore(path.join(tmpDir, 'cache-2.json')),
      options: { dryRun: false, maxDomains: 5, now, pdfTimetableSeeds: seeds },
      logger: { log() {}, warn() {}, error() {} }
    });

    assert.equal(secondRun.upsertedCount, 2);
    assert.equal(storedActivities.length, 2);
  });
});
