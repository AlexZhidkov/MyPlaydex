import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileCacheStore } from '../src/places-sync.js';
import { resolveOrganizerFacebookUrl } from '../src/url-utils.js';
import {
  extractFacebookUrlFromFirecrawlResult,
  extractFacebookUrlFromHtml,
  main,
  parseCliArgs,
  runOrganizerEnricher
} from '../src/organizer-enricher.js';

test('Seam 1: resolveOrganizerFacebookUrl normalizes Page and Group URLs, resolves permalinks, and rejects share/pixel/CMS handles', () => {
  // Basic Page and Group canonicalization
  assert.equal(
    resolveOrganizerFacebookUrl('http://m.facebook.com/PerthHockeyClub/?fbclid=IwAR123&utm_source=web'),
    'https://www.facebook.com/PerthHockeyClub'
  );
  assert.equal(
    resolveOrganizerFacebookUrl('https://fb.me/groups/perthrunners/?ref=share'),
    'https://www.facebook.com/groups/perthrunners'
  );

  // Permalinks and sub-tabs resolve to parent Organizer Page / Group URL
  assert.equal(
    resolveOrganizerFacebookUrl('https://www.facebook.com/PerthHockeyClub/posts/1234567890?__tn__=R'),
    'https://www.facebook.com/PerthHockeyClub'
  );
  assert.equal(
    resolveOrganizerFacebookUrl('https://www.facebook.com/PerthHockeyClub/photos/a.111/222/'),
    'https://www.facebook.com/PerthHockeyClub'
  );
  assert.equal(
    resolveOrganizerFacebookUrl('https://www.facebook.com/PerthHockeyClub/videos/987654321/'),
    'https://www.facebook.com/PerthHockeyClub'
  );
  assert.equal(
    resolveOrganizerFacebookUrl('https://www.facebook.com/PerthHockeyClub/events/555666777/'),
    'https://www.facebook.com/PerthHockeyClub'
  );
  assert.equal(
    resolveOrganizerFacebookUrl('https://www.facebook.com/groups/perthrunners/permalink/444555666/'),
    'https://www.facebook.com/groups/perthrunners'
  );

  // Legacy /pages/<slug>/<id>, /p/<slug-id>, and profile.php?id=...
  assert.equal(
    resolveOrganizerFacebookUrl('https://www.facebook.com/pages/Perth-Hockey-Club/123456789012345/posts/999'),
    'https://www.facebook.com/pages/Perth-Hockey-Club/123456789012345'
  );
  assert.equal(
    resolveOrganizerFacebookUrl('https://www.facebook.com/p/Perth-Hockey-Club-100063712345678/?mibextid=ZbWKwL'),
    'https://www.facebook.com/p/Perth-Hockey-Club-100063712345678'
  );
  assert.equal(
    resolveOrganizerFacebookUrl('https://www.facebook.com/profile.php?id=100063712345678&sk=about'),
    'https://www.facebook.com/profile.php?id=100063712345678'
  );
  assert.equal(
    resolveOrganizerFacebookUrl('https://www.facebook.com/pg/PerthHockeyClub/about'),
    'https://www.facebook.com/PerthHockeyClub'
  );

  // Ignored share/intent/pixel/interstitial paths and standalone events
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/sharer/sharer.php?u=https://example.com'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/dialog/share?app_id=123'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/plugins/page.php?href=https://www.facebook.com/foo'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/tr?id=123456789&ev=PageView'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/l.php?u=https%3A%2F%2Fexample.com'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/events/123456789/'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/photo?fbid=123'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/reel/123456789/'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/group.php?gid=123456789'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/'), null);

  // Generic CMS / platform / government social handles ignored (case-insensitive)
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/wix'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/Squarespace/'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/WordPress'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/TidyHQ'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/RevolutioniseSPORT'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/deptlgsc'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/PlayCricketAU'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/GameDayStack'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/meetup'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/org'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/figtree'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/search/top?q=perth'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/media/set/?set=a.123'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/pages/category/Sports-Club/123456789012345/'), null);
});

test('Seam 2: extractFacebookUrlFromHtml extracts from anchors and Schema.org sameAs JSON-LD while ignoring noise', () => {
  const htmlWithSameAsAndNoise = `
    <html>
      <head>
        <script type="application/ld+json">{ invalid json </script>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "SportsOrganization",
                "name": "Swan Districts Netball",
                "sameAs": [
                  "https://www.instagram.com/swandistrictsnetball/",
                  "http://m.facebook.com/SwanDistrictsNetball/posts/998877?fbclid=xyz"
                ]
              }
            ]
          }
        </script>
      </head>
      <body>
        <a href="https://www.facebook.com/sharer/sharer.php?u=https://example.com">Share</a>
        <a href="https://www.facebook.com/TidyHQ">Powered by TidyHQ</a>
        <a href="https://www.facebook.com/OtherPartnerClub">Partner</a>
      </body>
    </html>
  `;
  assert.equal(
    extractFacebookUrlFromHtml(htmlWithSameAsAndNoise),
    'https://www.facebook.com/SwanDistrictsNetball'
  );

  const htmlWithAnchorsOnly = `
    <footer>
      <a href="https://www.facebook.com/tr?id=123&amp;ev=PageView">Pixel</a>
      <a href="https://www.facebook.com/dialog/share?app_id=1">Dialog</a>
      <a href="https://www.facebook.com/plugins/like.php?href=x">Plugin</a>
      <a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com">Redirect</a>
      <a href="https://www.facebook.com/wix">Wix</a>
      <a href="https://www.facebook.com/RevolutioniseSPORT">RevSport</a>
      <a data-href="https://example.com/ignored" href="https://www.facebook.com/profile.php?id=100063712345678&amp;sk=about">Facebook</a>
    </footer>
  `;
  assert.equal(
    extractFacebookUrlFromHtml(htmlWithAnchorsOnly),
    'https://www.facebook.com/profile.php?id=100063712345678'
  );

  assert.equal(extractFacebookUrlFromHtml('<html><body><p>No social links</p></body></html>'), null);
  assert.equal(extractFacebookUrlFromHtml(''), null);
});

test('Seam 3: runOrganizerEnricher filters eligible Organizers, isolates HTTP errors, caches large bodies with sidecars, and preserves contact.email/phone', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-org-enrich-'));
  const cachePath = path.join(tmpDir, 'cache.json');
  const cacheStore = createFileCacheStore(cachePath);

  const largePadding = 'x'.repeat(70 * 1024);
  const orgs = [
    {
      id: 'org_eligible_1',
      name: 'Perth Hockey Club',
      website: 'https://perthhockey.org.au',
      contact: { email: 'info@perthhockey.org.au', phone: '08 9123 4567', facebook: null }
    },
    {
      id: 'org_already_has_fb',
      name: 'Already Set Club',
      website: 'https://alreadyset.org.au',
      contact: { email: 'hi@alreadyset.org.au', phone: null, facebook: 'https://www.facebook.com/AlreadySet' }
    },
    {
      id: 'org_fb_website',
      name: 'FB Website Club',
      website: 'https://www.facebook.com/FBWebsiteClub',
      contact: { email: null, phone: null, facebook: null }
    },
    {
      id: 'org_directory_fallback',
      name: 'KidSport Directory Club',
      website: 'https://kidsport.dlgsc.wa.gov.au/find-a-club/?club=123',
      contact: { email: null, phone: null, facebook: null }
    },
    {
      id: 'org_no_website',
      name: 'No Website Club',
      website: null,
      contact: { email: null, phone: null, facebook: null }
    },
    {
      id: 'org_http_error',
      name: 'Broken Site Club',
      website: 'https://broken.example.org',
      contact: { email: null, phone: null, facebook: null }
    },
    {
      id: 'org_no_fb_found',
      name: 'Plain Site Club',
      website: 'http://plain.example.org',
      contact: { email: null, phone: null, facebook: null }
    },
    {
      id: 'org_http_404',
      name: 'Not Found Club',
      website: 'https://missing.example.org',
      contact: { email: null, phone: null, facebook: null }
    }
  ];

  const fetchCalls = [];
  const fetchFn = async (url) => {
    fetchCalls.push(url);
    if (url === 'https://perthhockey.org.au/') {
      return {
        ok: true,
        status: 200,
        text: async () => `<html><body><!-- ${largePadding} --><a href="https://m.facebook.com/PerthHockeyClub/posts/123">FB</a></body></html>`
      };
    }
    if (url === 'https://broken.example.org/') {
      throw new Error('ECONNREFUSED');
    }
    if (url === 'http://plain.example.org/') {
      return {
        ok: true,
        status: 200,
        text: async () => '<html><body><p>No Facebook link here</p></body></html>'
      };
    }
    if (url === 'https://missing.example.org/') {
      return {
        ok: false,
        status: 404,
        text: async () => 'Not Found'
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const upsertedBatches = [];
  const warnings = [];
  const adapter = {
    async scanOrganizers() {
      return orgs;
    },
    async batchUpsertOrganizers(items) {
      upsertedBatches.push(items);
      return { total: items.length, upserted: items.length, failed: 0, batches: 1, errors: [], dryRun: false };
    }
  };
  const logger = {
    log() {},
    warn(msg) { warnings.push(msg); }
  };

  try {
    // Run 1: Live run fetches, caches large body in sidecar, isolates broken.example.org, updates org_eligible_1
    const summary1 = await runOrganizerEnricher({
      adapter,
      fetchFn,
      cacheStore,
      options: { dryRun: false },
      logger
    });

    assert.equal(summary1.eligible, 4);
    assert.equal(summary1.scanned, 4);
    assert.equal(summary1.failedTargets, 2);
    assert.equal(summary1.matched, 1);
    assert.equal(summary1.updated, 1);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /broken\.example\.org/);
    assert.match(warnings[1], /missing\.example\.org/);
    assert.equal(fetchCalls.length, 4);

    assert.equal(upsertedBatches.length, 1);
    assert.equal(upsertedBatches[0].length, 1);
    assert.deepEqual(upsertedBatches[0][0].contact, {
      email: 'info@perthhockey.org.au',
      phone: '08 9123 4567',
      facebook: 'https://www.facebook.com/PerthHockeyClub'
    });

    // Verify sidecar file was created for >64KB body
    const sidecarFiles = await fs.readdir(`${cachePath}.d`);
    assert.equal(sidecarFiles.length, 1);

    // Run 2: Cached run (dryRun=true, no new network fetches)
    fetchCalls.length = 0;
    const summary2 = await runOrganizerEnricher({
      adapter,
      fetchFn,
      cacheStore,
      options: { dryRun: true, organizer: 'org_eligible_1' },
      logger
    });

    assert.equal(summary2.eligible, 1);
    assert.equal(summary2.matched, 1);
    assert.equal(summary2.updated, 0);
    assert.equal(summary2.dryRun, true);
    assert.equal(upsertedBatches.length, 1); // dryRun did not call batchUpsertOrganizers
    // org_eligible_1 was cached so fetchFn was not called for it
    assert.equal(fetchCalls.length, 0);

    // Run 3: --refresh forces re-fetch, --limit=1 caps targets
    const summary3 = await runOrganizerEnricher({
      adapter,
      fetchFn,
      cacheStore,
      options: { dryRun: true, refresh: true, limit: 1 },
      logger
    });
    assert.equal(summary3.eligible, 1);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0], 'https://perthhockey.org.au/');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Seam 4: parseCliArgs, main dry-run, and package.json script registration', async () => {
  const parsed = parseCliArgs(
    ['--organizer=org_123', '--limit=5', '--dry-run', '--refresh', '--force', '--use-adc', '--project=custom-proj'],
    {}
  );
  assert.deepEqual(parsed, {
    organizer: 'org_123',
    limit: 5,
    dryRun: true,
    refresh: true,
    force: true,
    useAdc: true,
    project: 'custom-proj',
    firecrawlUrl: null
  });

  const envParsed = parseCliArgs([], { FIREBASE_USE_ADC: '1', FIREBASE_PROJECT_ID: 'env-proj' });
  assert.equal(envParsed.useAdc, true);
  assert.equal(envParsed.project, 'env-proj');
  assert.equal(envParsed.dryRun, false);
  assert.equal(envParsed.force, false);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-org-main-'));
  try {
    const cacheStore = createFileCacheStore(path.join(tmpDir, 'cache.json'));
    const adapter = {
      async scanOrganizers() {
        return [
          {
            id: 'org_cli',
            name: 'CLI Club',
            website: 'https://cliclub.org.au',
            contact: { email: 'cli@cliclub.org.au', phone: null, facebook: null }
          }
        ];
      }
    };
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      text: async () => '<a href="https://www.facebook.com/CLIClub">FB</a>'
    });

    const summary = await main(
      ['--dry-run', '--limit=1', '--organizer=org_cli'],
      {},
      { adapter, cacheStore, fetchFn, logFile: false, logger: { log() {}, warn() {} } }
    );
    assert.equal(summary.dryRun, true);
    assert.equal(summary.matched, 1);
    assert.equal(summary.updated, 0);
    assert.equal(summary.updates[0].contact.facebook, 'https://www.facebook.com/CLIClub');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  const pkgRaw = await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw);
  assert.equal(pkg.scripts['enrich:organizers'], 'node src/organizer-enricher.js');
});

test('Seam 5: runOrganizerEnricher repairs legacy group.php and CometErrorRoute handles and promotes fallback/unverified source_url', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-org-repair-'));
  const fbCacheStore = createFileCacheStore(path.join(tmpDir, 'fb-cache.json'));
  const enrichCacheStore = createFileCacheStore(path.join(tmpDir, 'enrich-cache.json'));

  try {
    await fbCacheStore.write('https://www.facebook.com/StaleErrorClub', {
      url: 'https://www.facebook.com/StaleErrorClub',
      fetchedAt: '2026-11-20T00:00:00.000Z',
      body: '<html><script>{"canonicalRouteName":"comet.fbweb.CometErrorRoute"}</script></html>'
    });
    await fbCacheStore.write('https://www.facebook.com/SameStaleClub', {
      url: 'https://www.facebook.com/SameStaleClub',
      fetchedAt: '2026-11-20T00:00:00.000Z',
      body: '<html><script>{"canonicalRouteName":"comet.fbweb.CometEventsHomeRoute"}</script></html>'
    });
    await fbCacheStore.write('https://www.facebook.com/DeadTargetClub', {
      url: 'https://www.facebook.com/DeadTargetClub',
      fetchedAt: '2026-11-20T00:00:00.000Z',
      body: '<html><script>{"canonicalRouteName":"comet.fbweb.CometErrorRoute"}</script></html>'
    });
    await fbCacheStore.write('https://www.facebook.com/HealthyClub', {
      url: 'https://www.facebook.com/HealthyClub',
      fetchedAt: '2026-11-20T00:00:00.000Z',
      body: '<html><meta property="og:title" content="Healthy Club" /></html>'
    });

    const orgs = [
      {
        id: 'org_legacy_group_php',
        name: 'Legacy Group Club',
        website: 'https://legacyclub.org.au',
        verified: true,
        source_url: 'https://kidsport.dlgsc.wa.gov.au/find-a-club/?club=42',
        raw_source_url: 'https://kidsport.dlgsc.wa.gov.au/find-a-club/?club=42',
        contact: {
          email: 'info@legacyclub.org.au',
          phone: null,
          facebook: 'https://www.facebook.com/group.php?gid=123456'
        }
      },
      {
        id: 'org_comet_error',
        name: 'Comet Error Club',
        website: 'https://errorclub.org.au',
        verified: false,
        source_url: null,
        raw_source_url: 'https://www.facebook.com/StaleErrorClub',
        contact: {
          email: null,
          phone: '08 9000 1111',
          facebook: 'https://www.facebook.com/StaleErrorClub'
        }
      },
      {
        id: 'org_newly_enriched_unverified',
        name: 'Unverified Missing FB Club',
        website: 'https://unverifiedclub.org.au',
        verified: false,
        source_url: null,
        contact: {
          email: null,
          phone: null,
          facebook: null
        }
      },
      {
        id: 'org_same_stale_comet',
        name: 'Same Stale Comet Club',
        website: 'https://samestale.org.au',
        verified: false,
        source_url: null,
        contact: {
          email: null,
          phone: null,
          facebook: 'https://www.facebook.com/SameStaleClub'
        }
      },
      {
        id: 'org_discovers_dead_fb',
        name: 'Discovers Dead FB Club',
        website: 'https://discoversdead.org.au',
        verified: false,
        source_url: null,
        contact: {
          email: null,
          phone: null,
          facebook: null
        }
      },
      {
        id: 'org_healthy_existing',
        name: 'Healthy Club',
        website: 'https://healthyclub.org.au',
        verified: true,
        source_url: 'https://healthyclub.org.au',
        contact: {
          email: null,
          phone: null,
          facebook: 'https://www.facebook.com/HealthyClub'
        }
      }
    ];

    const fetchCalls = [];
    const fetchFn = async (url) => {
      fetchCalls.push(url);
      if (url === 'https://legacyclub.org.au/') {
        return {
          ok: true,
          status: 200,
          text: async () => '<a href="https://www.facebook.com/groups/legacyclubwa">Group</a>'
        };
      }
      if (url === 'https://errorclub.org.au/') {
        return {
          ok: true,
          status: 200,
          text: async () => '<a href="https://www.facebook.com/ActiveErrorClub">Active Page</a>'
        };
      }
      if (url === 'https://unverifiedclub.org.au/') {
        return {
          ok: true,
          status: 200,
          text: async () => '<a href="https://www.facebook.com/UnverifiedClubActive">Active Page</a>'
        };
      }
      if (url === 'https://samestale.org.au/') {
        return {
          ok: true,
          status: 200,
          text: async () => '<a href="https://www.facebook.com/SameStaleClub">Same Stale Page</a>'
        };
      }
      if (url === 'https://discoversdead.org.au/') {
        return {
          ok: true,
          status: 200,
          text: async () => '<a href="https://www.facebook.com/DeadTargetClub">Dead Target Page</a>'
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const upsertedBatches = [];
    const adapter = {
      async scanOrganizers() {
        return orgs;
      },
      async batchUpsertOrganizers(items) {
        upsertedBatches.push(items);
        return { total: items.length, upserted: items.length, failed: 0, batches: 1, errors: [], dryRun: false };
      }
    };

    const summary = await runOrganizerEnricher({
      adapter,
      fetchFn,
      cacheStore: enrichCacheStore,
      facebookCacheStore: fbCacheStore,
      options: { dryRun: false },
      logger: { log() {}, warn() {} }
    });

    assert.equal(summary.eligible, 5);
    assert.equal(summary.scanned, 5);
    assert.equal(summary.matched, 3);
    assert.equal(summary.updated, 3);
    assert.deepEqual(fetchCalls, [
      'https://legacyclub.org.au/',
      'https://errorclub.org.au/',
      'https://unverifiedclub.org.au/',
      'https://samestale.org.au/',
      'https://discoversdead.org.au/'
    ]);

    const updatedById = new Map(upsertedBatches[0].map(item => [item.id, item]));
    const repairedLegacy = updatedById.get('org_legacy_group_php');
    assert.equal(repairedLegacy.contact.facebook, 'https://www.facebook.com/groups/legacyclubwa');
    assert.equal(repairedLegacy.contact.email, 'info@legacyclub.org.au');
    assert.equal(repairedLegacy.source_url, 'https://www.facebook.com/groups/legacyclubwa');
    assert.equal(repairedLegacy.verified, true);

    const repairedComet = updatedById.get('org_comet_error');
    assert.equal(repairedComet.contact.facebook, 'https://www.facebook.com/ActiveErrorClub');
    assert.equal(repairedComet.contact.phone, '08 9000 1111');
    assert.equal(repairedComet.source_url, 'https://www.facebook.com/ActiveErrorClub');
    assert.equal(repairedComet.verified, true);

    const enrichedUnverified = updatedById.get('org_newly_enriched_unverified');
    assert.equal(enrichedUnverified.contact.facebook, 'https://www.facebook.com/UnverifiedClubActive');
    assert.equal(enrichedUnverified.source_url, 'https://www.facebook.com/UnverifiedClubActive');
    assert.equal(enrichedUnverified.verified, true);

    assert.equal(updatedById.has('org_same_stale_comet'), false);
    assert.equal(updatedById.has('org_discovers_dead_fb'), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Seam 6: --force re-enriches existing Organizers when Facebook handle differs and skips no-op matches', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myplaydex-org-force-'));
  const enrichCacheStore = createFileCacheStore(path.join(tmpDir, 'enrich-cache.json'));
  const fbCacheStore = createFileCacheStore(path.join(tmpDir, 'fb-cache.json'));

  try {
    const orgs = [
      {
        id: 'org_force_changed',
        name: 'Force Changed Club',
        website: 'https://forcechanged.org.au',
        verified: true,
        source_url: 'https://forcechanged.org.au',
        contact: {
          email: null,
          phone: null,
          facebook: 'https://www.facebook.com/OldHandle'
        }
      },
      {
        id: 'org_force_same',
        name: 'Force Same Club',
        website: 'https://forcesame.org.au',
        verified: true,
        source_url: 'https://forcesame.org.au',
        contact: {
          email: null,
          phone: null,
          facebook: 'https://www.facebook.com/SameHandle'
        }
      }
    ];

    const fetchFn = async (url) => {
      if (url === 'https://forcechanged.org.au/') {
        return {
          ok: true,
          status: 200,
          text: async () => '<a href="https://www.facebook.com/NewHandle">FB</a>'
        };
      }
      if (url === 'https://forcesame.org.au/') {
        return {
          ok: true,
          status: 200,
          text: async () => '<a href="https://www.facebook.com/SameHandle">FB</a>'
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const adapter = {
      async scanOrganizers() {
        return orgs;
      }
    };

    const summary = await main(
      ['--dry-run', '--force'],
      {},
      {
        adapter,
        cacheStore: enrichCacheStore,
        facebookCacheStore: fbCacheStore,
        fetchFn,
        logFile: false,
        logger: { log() {}, warn() {} }
      }
    );

    assert.equal(summary.eligible, 2);
    assert.equal(summary.scanned, 2);
    assert.equal(summary.matched, 1);
    assert.equal(summary.updates[0].id, 'org_force_changed');
    assert.equal(summary.updates[0].contact.facebook, 'https://www.facebook.com/NewHandle');
    assert.equal(summary.updates[0].source_url, 'https://forcechanged.org.au');
    assert.equal(summary.updates[0].verified, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Seam 6: runOrganizerEnricher uses firecrawlClient only as a JS/error fallback and respects CLI flags', async () => {
  assert.equal(
    extractFacebookUrlFromFirecrawlResult({
      rawHtml: '<html><body><p>No link in raw</p></body></html>',
      links: ['https://www.facebook.com/wix', 'https://m.facebook.com/PerthSpaClub/events']
    }),
    'https://www.facebook.com/PerthSpaClub'
  );

  assert.equal(parseCliArgs([], { FIRECRAWL_LOCAL_URL: 'http://127.0.0.1:3002' }).firecrawlUrl, 'http://127.0.0.1:3002');
  assert.equal(parseCliArgs(['--no-firecrawl'], { FIRECRAWL_LOCAL_URL: 'http://127.0.0.1:3002' }).firecrawlUrl, null);
  assert.equal(parseCliArgs(['--firecrawl-url=http://127.0.0.1:4000'], {}).firecrawlUrl, 'http://127.0.0.1:4000');

  const orgs = [
    {
      id: 'org_ssr',
      name: 'SSR Club',
      website: 'https://ssr.example.org',
      contact: { email: null, phone: null, facebook: null }
    },
    {
      id: 'org_spa',
      name: 'Wix SPA Club',
      website: 'https://spa.example.org',
      contact: { email: null, phone: null, facebook: null }
    },
    {
      id: 'org_403_recovered',
      name: 'Blocked Static Club',
      website: 'https://blocked.example.org',
      contact: { email: null, phone: null, facebook: null }
    }
  ];

  const firecrawlCalls = [];
  let flushed = false;
  const firecrawlClient = {
    async scrape(url, opts) {
      firecrawlCalls.push({ url, opts });
      if (url === 'https://spa.example.org/') {
        return {
          html: '<footer><a href="https://www.facebook.com/WixSpaClub">FB</a></footer>',
          links: ['https://www.facebook.com/WixSpaClub']
        };
      }
      if (url === 'https://blocked.example.org/') {
        return {
          html: '<html><body>Rendered</body></html>',
          links: ['https://www.facebook.com/RecoveredClub']
        };
      }
      throw new Error(`Unexpected firecrawl call: ${url}`);
    },
    async flushCache() {
      flushed = true;
    }
  };

  const fetchFn = async (url) => {
    if (url === 'https://ssr.example.org/') {
      return { ok: true, status: 200, text: async () => '<a href="https://www.facebook.com/SsrClub">FB</a>' };
    }
    if (url === 'https://spa.example.org/') {
      return { ok: true, status: 200, text: async () => '<div id="root"></div>' };
    }
    if (url === 'https://blocked.example.org/') {
      return { ok: false, status: 403, text: async () => 'Forbidden' };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const summary = await runOrganizerEnricher({
    adapter: { async scanOrganizers() { return orgs; } },
    fetchFn,
    firecrawlClient,
    options: { dryRun: true },
    logger: { log() {}, warn() {} }
  });

  assert.equal(summary.scanned, 3);
  assert.equal(summary.failedTargets, 0);
  assert.equal(summary.firecrawlFallbacks, 2);
  assert.equal(summary.firecrawlMatched, 2);
  assert.equal(summary.matched, 3);
  assert.equal(flushed, true);
  assert.deepEqual(firecrawlCalls.map(c => c.url), [
    'https://spa.example.org/',
    'https://blocked.example.org/'
  ]);
  assert.equal(firecrawlCalls[0].opts.onlyMainContent, false);
  assert.deepEqual(
    summary.updates.map(u => [u.id, u.contact.facebook]),
    [
      ['org_ssr', 'https://www.facebook.com/SsrClub'],
      ['org_spa', 'https://www.facebook.com/WixSpaClub'],
      ['org_403_recovered', 'https://www.facebook.com/RecoveredClub']
    ]
  );
});
