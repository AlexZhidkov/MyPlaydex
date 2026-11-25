import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createFileCacheStore } from '../src/file-cache.js';
import { buildDeterministicSourceId } from '../src/markdown-activity-extractor.js';
import {
  reconcileStaleWeeklyActivities,
  runOrganizerWebsiteSync
} from '../src/organizer-website-sync.js';

describe('Stale Weekly Activity Auto-Delete (Issue #57)', () => {
  it('Seam 1 (Slice 1): marks absent single-source weekly Activities from a cleanly re-scraped URL for deletion while keeping present, non-weekly, and other-URL records', () => {
    const scrapedUrl = 'https://club.org.au/timetable';
    const otherUrl = 'https://club.org.au/other-timetable.pdf';

    const existingActivities = [
      {
        id: 'organizer_website_keep_1',
        title: 'Monday Social',
        source: 'organizer_website',
        source_id: 'keep_1',
        source_key: 'organizer_website_keep_1',
        source_url: scrapedUrl,
        raw_source_url: scrapedUrl,
        verified: true,
        sources: [
          {
            source: 'organizer_website',
            source_id: 'keep_1',
            source_key: 'organizer_website_keep_1',
            source_url: scrapedUrl,
            raw_source_url: scrapedUrl,
            verified: true
          }
        ],
        schedule: { recurrence: 'weekly', day_of_week: 1, start_time: '18:00' }
      },
      {
        id: 'organizer_website_stale_1',
        title: 'Wednesday Old Class',
        source: 'organizer_website',
        source_id: 'stale_1',
        source_key: 'organizer_website_stale_1',
        source_url: scrapedUrl,
        raw_source_url: scrapedUrl,
        verified: true,
        sources: [
          {
            source: 'organizer_website',
            source_id: 'stale_1',
            source_key: 'organizer_website_stale_1',
            source_url: scrapedUrl,
            raw_source_url: scrapedUrl,
            verified: true
          }
        ],
        schedule: { recurrence: 'weekly', day_of_week: 3, start_time: '19:00' }
      },
      {
        id: 'organizer_website_dated_1',
        title: 'Saturday Tournament',
        source: 'organizer_website',
        source_id: 'dated_1',
        source_key: 'organizer_website_dated_1',
        source_url: scrapedUrl,
        raw_source_url: scrapedUrl,
        verified: true,
        sources: [
          {
            source: 'organizer_website',
            source_id: 'dated_1',
            source_key: 'organizer_website_dated_1',
            source_url: scrapedUrl,
            raw_source_url: scrapedUrl,
            verified: true
          }
        ],
        schedule: { recurrence: 'none', start_date: '2026-12-05', start_time: '09:00' }
      },
      {
        id: 'organizer_website_other_url_1',
        title: 'Friday PDF Class',
        source: 'organizer_website',
        source_id: 'other_url_1',
        source_key: 'organizer_website_other_url_1',
        source_url: otherUrl,
        raw_source_url: otherUrl,
        verified: true,
        sources: [
          {
            source: 'organizer_website',
            source_id: 'other_url_1',
            source_key: 'organizer_website_other_url_1',
            source_url: otherUrl,
            raw_source_url: otherUrl,
            verified: true
          }
        ],
        schedule: { recurrence: 'weekly', day_of_week: 5, start_time: '17:00' }
      }
    ];

    const cleanUrlSourceKeys = new Map([
      [scrapedUrl, new Set(['organizer_website_keep_1'])]
    ]);

    const result = reconcileStaleWeeklyActivities({
      existingActivities,
      cleanUrlSourceKeys
    });

    assert.deepEqual(result.deleteIds, ['organizer_website_stale_1']);
    assert.deepEqual(result.prunedActivities, []);
  });

  it('Seam 1 (Slice 2): preserves multi-source weekly Activities when organizer_website disappears, pruning only the stale reference and re-promoting primary Source Reference', () => {
    const scrapedUrl = 'https://club.org.au/timetable';

    const existingActivities = [
      {
        id: 'facebook_fb_1',
        title: 'Thursday Mixed Social',
        source: 'organizer_website',
        source_id: 'stale_org_1',
        source_key: 'organizer_website_stale_org_1',
        source_url: scrapedUrl,
        raw_source_url: scrapedUrl,
        verified: true,
        source_keys: ['facebook_fb_1', 'organizer_website_stale_org_1'],
        sources: [
          {
            source: 'facebook',
            source_id: 'fb_1',
            source_key: 'facebook_fb_1',
            source_url: 'https://www.facebook.com/events/123',
            raw_source_url: 'https://www.facebook.com/events/123',
            verified: true
          },
          {
            source: 'organizer_website',
            source_id: 'stale_org_1',
            source_key: 'organizer_website_stale_org_1',
            source_url: scrapedUrl,
            raw_source_url: scrapedUrl,
            verified: true
          }
        ],
        schedule: { recurrence: 'weekly', day_of_week: 4, start_time: '18:30' }
      }
    ];

    const cleanUrlSourceKeys = new Map([
      [scrapedUrl, new Set(['organizer_website_active_other'])]
    ]);

    const result = reconcileStaleWeeklyActivities({
      existingActivities,
      cleanUrlSourceKeys
    });

    assert.deepEqual(result.deleteIds, []);
    assert.equal(result.prunedActivities.length, 1);

    const pruned = result.prunedActivities[0];
    assert.equal(pruned.id, 'facebook_fb_1');
    assert.equal(pruned.source, 'facebook');
    assert.equal(pruned.source_id, 'fb_1');
    assert.equal(pruned.source_key, 'facebook_fb_1');
    assert.equal(pruned.source_url, 'https://www.facebook.com/events/123');
    assert.deepEqual(pruned.source_keys, ['facebook_fb_1']);
    assert.equal(pruned.sources.length, 1);
    assert.equal(pruned.sources[0].source_key, 'facebook_fb_1');
  });

  it('Seam 2 (Slice 3): runOrganizerWebsiteSync deletes absent weekly Activities on clean re-scrape, preserves multi-source records, and reports wouldDeleteIds in --dry-run', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-stale-weekly-'));
    const timetableUrl = 'https://club.org.au/timetable';
    const keepSourceId = buildDeterministicSourceId(timetableUrl, 'Tuesday Social Badminton', 'weekly-2-18:30');
    const now = new Date('2026-11-25T10:00:00+08:00');

    const organizers = [
      {
        id: 'org_badminton',
        name: 'Perth Badminton Club',
        website: 'https://club.org.au',
        venue: {
          id: 'venue_hall',
          name: 'Perth Badminton Hall',
          coordinates: { lat: -31.9505, lng: 115.8605 }
        }
      }
    ];

    const existingActivities = [
      {
        id: `organizer_website_${keepSourceId}`,
        title: 'Tuesday Social Badminton',
        source: 'organizer_website',
        source_id: keepSourceId,
        source_key: `organizer_website_${keepSourceId}`,
        source_url: timetableUrl,
        raw_source_url: timetableUrl,
        verified: true,
        sources: [
          {
            source: 'organizer_website',
            source_id: keepSourceId,
            source_key: `organizer_website_${keepSourceId}`,
            source_url: timetableUrl,
            raw_source_url: timetableUrl,
            verified: true
          }
        ],
        schedule: { recurrence: 'weekly', day_of_week: 2, start_time: '18:30' },
        venue: { id: 'venue_hall', name: 'Perth Badminton Hall', coordinates: { lat: -31.9505, lng: 115.8605 } },
        organizer: { id: 'org_badminton', name: 'Perth Badminton Club' }
      },
      {
        id: 'organizer_website_stale_single',
        title: 'Monday Old Class',
        source: 'organizer_website',
        source_id: 'stale_single',
        source_key: 'organizer_website_stale_single',
        source_url: timetableUrl,
        raw_source_url: timetableUrl,
        verified: true,
        sources: [
          {
            source: 'organizer_website',
            source_id: 'stale_single',
            source_key: 'organizer_website_stale_single',
            source_url: timetableUrl,
            raw_source_url: timetableUrl,
            verified: true
          }
        ],
        schedule: { recurrence: 'weekly', day_of_week: 1, start_time: '18:00' },
        venue: { id: 'venue_hall', name: 'Perth Badminton Hall', coordinates: { lat: -31.9505, lng: 115.8605 } },
        organizer: { id: 'org_badminton', name: 'Perth Badminton Club' }
      },
      {
        id: 'council_multi_1',
        title: 'Friday Multi-Source Class',
        source: 'council',
        source_id: 'multi_1',
        source_key: 'council_multi_1',
        source_url: 'https://council.wa.gov.au/events/1',
        raw_source_url: 'https://council.wa.gov.au/events/1',
        verified: true,
        source_keys: ['council_multi_1', 'organizer_website_stale_multi'],
        sources: [
          {
            source: 'council',
            source_id: 'multi_1',
            source_key: 'council_multi_1',
            source_url: 'https://council.wa.gov.au/events/1',
            raw_source_url: 'https://council.wa.gov.au/events/1',
            verified: true
          },
          {
            source: 'organizer_website',
            source_id: 'stale_multi',
            source_key: 'organizer_website_stale_multi',
            source_url: timetableUrl,
            raw_source_url: timetableUrl,
            verified: true
          }
        ],
        schedule: { recurrence: 'weekly', day_of_week: 5, start_time: '19:00' },
        venue: { id: 'venue_hall', name: 'Perth Badminton Hall', coordinates: { lat: -31.9505, lng: 115.8605 } },
        organizer: { id: 'org_badminton', name: 'Perth Badminton Club' }
      }
    ];

    const firecrawlClient = {
      async map() {
        return { links: [timetableUrl] };
      },
      async scrape() {
        return {
          html: '<html><body><h1>Timetable</h1></body></html>',
          markdown: '# Timetable\nTuesday Social Badminton 6:30pm'
        };
      }
    };

    const geminiClient = {
      async extractActivitiesFromMarkdown() {
        return {
          activities: [
            {
              title: 'Tuesday Social Badminton',
              description: 'Weekly social badminton session.',
              category: 'sports',
              weekday: 'Tuesday',
              start_time: '18:30',
              is_noise: false,
              confidence: 'high'
            }
          ]
        };
      }
    };

    const appliedBatches = [];
    const adapter = {
      async scanOrganizers() { return organizers; },
      async scanVenues() { return []; },
      async scanActivities() { return existingActivities; },
      async batchApplyActivityDeduplication(payload) {
        appliedBatches.push(payload);
        return {
          updated: payload.updates.length,
          deleted: payload.deleteIds.length,
          failed: 0,
          batches: 1,
          errors: [],
          dryRun: false
        };
      }
    };

    const drySummary = await runOrganizerWebsiteSync({
      adapter,
      firecrawlClient,
      geminiClient,
      cacheStore: createFileCacheStore(path.join(tmpDir, 'dry-cache.json')),
      options: { dryRun: true, maxDomains: 5, maxUrlsPerDomain: 3, now },
      logger: { log() {}, warn() {}, error() {} }
    });

    assert.equal(drySummary.dryRun, true);
    assert.deepEqual(drySummary.wouldDeleteIds, ['organizer_website_stale_single']);
    assert.deepEqual(drySummary.wouldPruneIds, ['council_multi_1']);
    assert.equal(drySummary.deletedCount, 0);
    assert.equal(appliedBatches.length, 0);

    const applySummary = await runOrganizerWebsiteSync({
      adapter,
      firecrawlClient,
      geminiClient,
      cacheStore: createFileCacheStore(path.join(tmpDir, 'apply-cache.json')),
      options: { dryRun: false, maxDomains: 5, maxUrlsPerDomain: 3, now },
      logger: { log() {}, warn() {}, error() {} }
    });

    assert.equal(applySummary.dryRun, false);
    assert.equal(applySummary.deletedCount, 1);
    assert.equal(applySummary.prunedCount, 1);
    assert.equal(appliedBatches.length, 1);
    assert.deepEqual(appliedBatches[0].deleteIds, ['organizer_website_stale_single']);
    const prunedUpdate = appliedBatches[0].updates.find(u => u.id === 'council_multi_1');
    assert.ok(prunedUpdate);
    assert.deepEqual(prunedUpdate.source_keys, ['council_multi_1']);
  });

  it('Seam 2 (Slice 4): never deletes weekly Activities on scrape error, timeout, empty parse, or failed LLM parse, and handles PDF sources cleanly', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-stale-safety-'));
    const pdfUrl = 'https://leisure.wa.gov.au/timetable.pdf';
    const now = new Date('2026-11-25T10:00:00+08:00');

    const organizers = [
      {
        id: 'org_leisure',
        name: 'Perth Leisure Centre',
        website: 'https://leisure.wa.gov.au',
        venue: {
          id: 'venue_leisure',
          name: 'Perth Leisure Centre',
          coordinates: { lat: -31.9505, lng: 115.8605 }
        }
      }
    ];

    const existingActivities = [
      {
        id: 'organizer_website_pdf_stale',
        title: 'Old Aqua Aerobics',
        source: 'organizer_website',
        source_id: 'pdf_stale',
        source_key: 'organizer_website_pdf_stale',
        source_url: pdfUrl,
        raw_source_url: pdfUrl,
        verified: true,
        sources: [
          {
            source: 'organizer_website',
            source_id: 'pdf_stale',
            source_key: 'organizer_website_pdf_stale',
            source_url: pdfUrl,
            raw_source_url: pdfUrl,
            verified: true
          }
        ],
        schedule: { recurrence: 'weekly', day_of_week: 1, start_time: '09:00' },
        venue: { id: 'venue_leisure', name: 'Perth Leisure Centre', coordinates: { lat: -31.9505, lng: 115.8605 } },
        organizer: { id: 'org_leisure', name: 'Perth Leisure Centre' }
      }
    ];

    const appliedBatches = [];
    const adapter = {
      async scanOrganizers() { return organizers; },
      async scanVenues() { return []; },
      async scanActivities() { return existingActivities; },
      async batchApplyActivityDeduplication(payload) {
        appliedBatches.push(payload);
        return {
          updated: payload.updates.length,
          deleted: payload.deleteIds.length,
          failed: 0,
          batches: 1,
          errors: [],
          dryRun: false
        };
      }
    };

    const pdfSeeds = [
      {
        organizerId: 'org_leisure',
        organizerName: 'Perth Leisure Centre',
        url: pdfUrl,
        venueName: 'Perth Leisure Centre',
        suburb: 'Perth'
      }
    ];

    // 1. Network / HTTP timeout error during scrape
    const errorSummary = await runOrganizerWebsiteSync({
      adapter,
      firecrawlClient: {
        async scrape() { throw new Error('HTTP 503 Service Unavailable'); }
      },
      geminiClient: {
        async extractActivitiesFromMarkdown() { return { activities: [] }; }
      },
      cacheStore: createFileCacheStore(path.join(tmpDir, 'err.json')),
      options: { dryRun: false, pdfTimetableSeeds: pdfSeeds, now },
      logger: { log() {}, warn() {}, error() {} }
    });
    assert.equal(errorSummary.deletedCount, 0);
    assert.equal(appliedBatches.length, 0);

    // 2. Empty extraction result (200 OK but 0 activities parsed)
    const emptySummary = await runOrganizerWebsiteSync({
      adapter,
      firecrawlClient: {
        async scrape() { return { markdown: 'Empty PDF page' }; }
      },
      geminiClient: {
        async extractActivitiesFromMarkdown() { return { activities: [] }; }
      },
      cacheStore: createFileCacheStore(path.join(tmpDir, 'empty.json')),
      options: { dryRun: false, pdfTimetableSeeds: pdfSeeds, now },
      logger: { log() {}, warn() {}, error() {} }
    });
    assert.equal(emptySummary.deletedCount, 0);
    assert.equal(appliedBatches.length, 0);

    // 3. Failed Gemini LLM parse (throws)
    const llmErrorSummary = await runOrganizerWebsiteSync({
      adapter,
      firecrawlClient: {
        async scrape() { return { markdown: '# Timetable\nAqua 9am' }; }
      },
      geminiClient: {
        async extractActivitiesFromMarkdown() { throw new Error('Gemini 429 rate limit'); }
      },
      cacheStore: createFileCacheStore(path.join(tmpDir, 'llm-err.json')),
      options: { dryRun: false, pdfTimetableSeeds: pdfSeeds, now },
      logger: { log() {}, warn() {}, error() {} }
    });
    assert.equal(llmErrorSummary.deletedCount, 0);
    assert.equal(appliedBatches.length, 0);

    // 4. Clean PDF re-scrape with non-empty replacement triggers deletion of stale weekly PDF activity
    const cleanPdfSummary = await runOrganizerWebsiteSync({
      adapter,
      firecrawlClient: {
        async scrape() { return { markdown: '# Timetable\nNew Zumba Wednesday 10am' }; }
      },
      geminiClient: {
        async extractActivitiesFromMarkdown() {
          return {
            activities: [
              {
                title: 'New Zumba',
                description: 'Wednesday morning Zumba.',
                category: 'fitness',
                weekday: 'Wednesday',
                start_time: '10:00',
                is_noise: false,
                confidence: 'high'
              }
            ]
          };
        }
      },
      cacheStore: createFileCacheStore(path.join(tmpDir, 'clean-pdf.json')),
      options: { dryRun: false, pdfTimetableSeeds: pdfSeeds, now },
      logger: { log() {}, warn() {}, error() {} }
    });
    assert.equal(cleanPdfSummary.deletedCount, 1);
    assert.equal(appliedBatches.length, 1);
    assert.deepEqual(appliedBatches[0].deleteIds, ['organizer_website_pdf_stale']);
  });
});
