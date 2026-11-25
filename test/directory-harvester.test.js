import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createFileCacheStore } from '../src/file-cache.js';
import {
  DEFAULT_DIRECTORY_CACHE_TTL_MS,
  extractOutboundDirectoryLinks,
  harvestDirectoryDomains,
  normalizeDomainHost
} from '../src/directory-harvester.js';
import {
  runOrganizerWebsiteSync,
  selectDripOrganizerTargets
} from '../src/organizer-website-sync.js';

describe('Directory Harvester (Issue #55)', () => {
  it('Seam 1: extracts and normalizes outbound club links, filters social/directories, and deduplicates against /organizers', () => {
    const directoryUrl = 'https://www.stirling.wa.gov.au/services-and-support/community/clubs-and-groups/a-z-club-directory';
    const organizersCatalog = [
      {
        id: 'org_existing_club',
        name: 'Existing Stirling Club',
        website: 'https://www.existingclub.org.au/about'
      },
      {
        id: 'org_source_ref_club',
        name: 'Source Ref Club',
        source_url: 'https://sourcerefclub.com.au/events',
        sources: [{ source: 'organizer_website', source_url: 'https://sourcerefclub.com.au/timetable' }]
      }
    ];

    const html = `
      <html><body>
        <ul>
          <li><a href="https://www.perthrowing.org.au/join#top">Perth Rowing Club</a></li>
          <li><a href="http://perthrowing.org.au/sessions">Perth Rowing Sessions</a></li>
          <li><a href="https://scarboroughsurf.com.au">Scarborough Surf Life Saving</a></li>
          <li><a href="https://www.existingclub.org.au/">Existing Stirling Club</a></li>
          <li><a href="https://sourcerefclub.com.au">Source Ref Club</a></li>
          <li><a href="https://www.facebook.com/perthrowing">Facebook</a></li>
          <li><a href="https://www.instagram.com/perthrowing/">Instagram</a></li>
          <li><a href="https://www.eventbrite.com.au/e/123">Eventbrite</a></li>
          <li><a href="https://www.meetup.com/perth-runners/">Meetup</a></li>
          <li><a href="https://www.stirling.wa.gov.au/parks">Stirling Parks</a></li>
          <li><a href="https://kidsport.dlgsc.wa.gov.au/find-a-club/">DLGSC KidSport</a></li>
          <li><a href="https://www.mycommunitydirectory.com.au/perth">My Community Directory</a></li>
          <li><a href="mailto:info@perthrowing.org.au">Email Us</a></li>
          <li><a href="/local-relative-link">Relative</a></li>
        </ul>
      </body></html>
    `;

    const markdown = `
      - [North Beach Tennis Club](https://northbeachtennis.org.au/programs)
      - [Website](https://fremantle-hockey.org.au/)
      - [Twitter](https://x.com/northbeachtennis)
    `;

    const results = extractOutboundDirectoryLinks({
      html,
      markdown,
      directoryUrl,
      organizersCatalog
    });

    assert.equal(normalizeDomainHost('https://www.PerthRowing.org.au/join'), 'perthrowing.org.au');
    assert.deepEqual(
      results.map(r => ({ host: r.host, websiteUrl: r.websiteUrl, organizerName: r.organizerName })),
      [
        {
          host: 'perthrowing.org.au',
          websiteUrl: 'https://www.perthrowing.org.au/',
          organizerName: 'Perth Rowing Club'
        },
        {
          host: 'scarboroughsurf.com.au',
          websiteUrl: 'https://scarboroughsurf.com.au/',
          organizerName: 'Scarborough Surf Life Saving'
        },
        {
          host: 'northbeachtennis.org.au',
          websiteUrl: 'https://northbeachtennis.org.au/',
          organizerName: 'North Beach Tennis Club'
        },
        {
          host: 'fremantle-hockey.org.au',
          websiteUrl: 'https://fremantle-hockey.org.au/',
          organizerName: 'Fremantle Hockey'
        }
      ]
    );
    assert.ok(results.every(r => r.sourceDirectoryUrl === directoryUrl));
  });

  it('Seam 2: harvestDirectoryDomains caches directory scrapes and enqueues Tier-2 targets behind Tier-1 with 7d/30d backoff', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-dir-harvest-'));
    const cacheStore = createFileCacheStore(path.join(tmpDir, 'cache.json'));
    const now = new Date('2026-11-25T10:00:00+08:00');
    const nowMs = now.getTime();

    const scrapeCalls = [];
    const firecrawlClient = {
      async scrape(url) {
        scrapeCalls.push(url);
        return {
          url,
          html: `
            <a href="https://pertharchery.org.au/events">Perth Archery Club</a>
            <a href="https://harvested-recent.org.au/">Recent Harvested Club</a>
            <a href="https://harvested-zero-due.org.au/">Zero Due Harvested Club</a>
            <a href="https://existing-org.org.au/">Already In Organizers</a>
          `,
          markdown: ''
        };
      }
    };

    const directorySources = [
      { name: 'stirling_clubs', url: 'https://www.stirling.wa.gov.au/clubs' }
    ];
    const organizersCatalog = [
      { id: 'org_tier1', name: 'Tier 1 Club', website: 'https://tier1club.org.au/' },
      { id: 'org_existing', name: 'Existing Org', website: 'https://existing-org.org.au/' }
    ];

    // Seed backoff checkpoints: org_existing is on cooldown, and two harvested domains have checkpoints
    await cacheStore.write('drip_checkpoint|https://existing-org.org.au/', {
      lastCrawledAt: new Date(nowMs - 1 * 24 * 60 * 60 * 1000).toISOString(),
      lastYieldCount: 1
    });
    await cacheStore.write('drip_checkpoint|https://harvested-recent.org.au/', {
      lastCrawledAt: new Date(nowMs - 2 * 24 * 60 * 60 * 1000).toISOString(),
      lastYieldCount: 1
    });
    await cacheStore.write('drip_checkpoint|https://harvested-zero-due.org.au/', {
      lastCrawledAt: new Date(nowMs - 31 * 24 * 60 * 60 * 1000).toISOString(),
      lastYieldCount: 0
    });

    const firstHarvest = await harvestDirectoryDomains({
      directorySources,
      firecrawlClient,
      cacheStore,
      organizersCatalog,
      now
    });

    assert.equal(scrapeCalls.length, 1);
    assert.equal(firstHarvest.scrapedDirectories, 1);
    assert.equal(firstHarvest.harvestedDomains.length, 3);
    assert.ok(DEFAULT_DIRECTORY_CACHE_TTL_MS >= 14 * 24 * 60 * 60 * 1000);

    // Second call within TTL uses cached directory checkpoint without re-scraping
    const secondHarvest = await harvestDirectoryDomains({
      directorySources,
      firecrawlClient,
      cacheStore,
      organizersCatalog,
      now: new Date(nowMs + 24 * 60 * 60 * 1000)
    });
    assert.equal(scrapeCalls.length, 1);
    assert.equal(secondHarvest.scrapedDirectories, 0);
    assert.equal(secondHarvest.cachedDirectories, 1);
    assert.equal(secondHarvest.harvestedDomains.length, 3);

    const targets = await selectDripOrganizerTargets({
      organizersCatalog,
      activitiesCatalog: [],
      harvestedDomains: secondHarvest.harvestedDomains,
      cacheStore,
      now
    });

    const targetUrls = targets.map(t => t.websiteUrl);
    assert.equal(targetUrls[0], 'https://tier1club.org.au/');
    assert.ok(targetUrls.includes('https://pertharchery.org.au/'));
    assert.ok(targetUrls.includes('https://harvested-zero-due.org.au/'));
    assert.ok(!targetUrls.includes('https://harvested-recent.org.au/'));
    assert.ok(!targetUrls.includes('https://existing-org.org.au/'));

    const archeryTarget = targets.find(t => t.websiteUrl === 'https://pertharchery.org.au/');
    assert.equal(archeryTarget.tier, 2);
    assert.equal(archeryTarget.isHarvestedDomain, true);
    assert.equal(archeryTarget.organizer.name, 'Perth Archery Club');
  });

  it('Seam 3: runOrganizerWebsiteSync ingests Activities from harvested Tier-2 domains with organizer metadata and without creating /organizers docs', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-dir-e2e-'));
    const cacheStore = createFileCacheStore(path.join(tmpDir, 'cache.json'));
    const now = new Date('2026-11-25T10:00:00+08:00');

    const directoryUrl = 'https://www.stirling.wa.gov.au/clubs';
    const firecrawlClient = {
      async map(url) {
        return { url, links: [`${url.replace(/\/$/, '')}/events`], fromCache: false };
      },
      async scrape(url) {
        if (url === directoryUrl) {
          return {
            url,
            html: `
              <a href="https://pertharchery.org.au/">Perth Archery Club</a>
              <a href="https://existingclub.org.au/">Existing Club</a>
            `,
            markdown: ''
          };
        }
        if (url === 'https://pertharchery.org.au/events') {
          return {
            url,
            html: `<script type="application/ld+json">${JSON.stringify({
              '@type': 'SportsEvent',
              name: 'Saturday Come and Try Archery',
              description: 'Beginner archery session at Kings Park.',
              startDate: '2026-12-05T09:00:00',
              endDate: '2026-12-05T11:00:00',
              location: {
                '@type': 'Place',
                name: 'Kings Park',
                geo: { latitude: -31.9615, longitude: 115.8435 }
              }
            })}</script>`,
            markdown: '',
            links: []
          };
        }
        return { url, html: '<html></html>', markdown: '', links: [] };
      },
      async flushCache() {}
    };

    const upsertedActivityBatches = [];
    const upsertedOrganizerBatches = [];
    const adapter = {
      async scanOrganizers() {
        return [
          {
            id: 'org_existing',
            name: 'Existing Club',
            website: 'https://existingclub.org.au/',
            sources: [{ source: 'council', source_url: 'https://stirling.wa.gov.au/existing' }]
          }
        ];
      },
      async scanVenues() {
        return [
          { id: 'venue_kings_park', name: 'Kings Park', coordinates: { lat: -31.9615, lng: 115.8435 } }
        ];
      },
      async scanActivities() {
        return [
          {
            id: 'act_existing',
            organizer: { id: 'org_existing', name: 'Existing Club' },
            expire_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
          }
        ];
      },
      async batchUpsertActivities(items) {
        upsertedActivityBatches.push(items);
        return { upserted: items.length };
      },
      async batchUpsertOrganizers(items) {
        upsertedOrganizerBatches.push(items);
        return { upserted: items.length };
      }
    };

    const summary = await runOrganizerWebsiteSync({
      adapter,
      firecrawlClient,
      cacheStore,
      options: {
        dryRun: false,
        maxDomains: 5,
        maxUrlsPerDomain: 3,
        now,
        directorySources: [{ name: 'stirling_clubs', url: directoryUrl }]
      },
      logger: { log() {}, warn() {}, error() {} }
    });

    assert.equal(summary.harvestedDomainsCount, 1);
    assert.equal(summary.upsertedCount, 1);
    assert.equal(upsertedOrganizerBatches.length, 0);
    assert.equal(upsertedActivityBatches.length, 1);

    const savedActivity = upsertedActivityBatches[0][0];
    assert.equal(savedActivity.title, 'Saturday Come and Try Archery');
    assert.equal(savedActivity.source, 'organizer_website');
    assert.equal(savedActivity.source_url, 'https://pertharchery.org.au/events');
    assert.equal(savedActivity.organizer.name, 'Perth Archery Club');
    assert.equal(savedActivity.organizer.id, 'org_perth_archery_club');
  });
});
