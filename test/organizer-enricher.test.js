import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileCacheStore } from '../src/places-sync.js';
import { resolveOrganizerFacebookUrl } from '../src/url-utils.js';
import {
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
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/'), null);

  // Generic CMS / platform social handles ignored (case-insensitive)
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/wix'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/Squarespace/'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/WordPress'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/TidyHQ'), null);
  assert.equal(resolveOrganizerFacebookUrl('https://www.facebook.com/RevolutioniseSPORT'), null);
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
    ['--organizer=org_123', '--limit=5', '--dry-run', '--refresh', '--use-adc', '--project=custom-proj'],
    {}
  );
  assert.deepEqual(parsed, {
    organizer: 'org_123',
    limit: 5,
    dryRun: true,
    refresh: true,
    useAdc: true,
    project: 'custom-proj'
  });

  const envParsed = parseCliArgs([], { FIREBASE_USE_ADC: '1', FIREBASE_PROJECT_ID: 'env-proj' });
  assert.equal(envParsed.useAdc, true);
  assert.equal(envParsed.project, 'env-proj');
  assert.equal(envParsed.dryRun, false);

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
