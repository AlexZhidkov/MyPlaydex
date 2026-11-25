import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCrawlerHarness, formatStepSummaryTable, writeStepSummary, getDefaultCrawlers, createFileLogger, main } from '../src/crawler-runner.js';

const execFileAsync = promisify(execFile);
import { createFirestoreAdapter } from '../src/firestore-adapter.js';

test('Seam 4: runCrawlerHarness executes crawlers, sanitizes items, and batches to adapter', async () => {
  const mockCrawlerA = {
    name: 'stirling',
    async fetchListings() {
      return [
        {
          source: 'stirling',
          source_id: '101',
          title: 'Sunset Beach Volleyball',
          sport: 'volleyball',
          coordinates: { lat: -31.8942, lng: 115.7571 },
          venue_name: 'Scarborough Beach',
          cost_description: 'Free'
        },
        {
          source: 'stirling',
          source_id: '102',
          title: 'Morning Yoga by the Sea',
          sport: 'yoga',
          coordinates: { lat: -31.8940, lng: 115.7570 },
          venue_name: 'Scarborough Beach',
          cost_description: 'Free'
        },
        {
          source: 'stirling',
          source_id: '103',
          title: 'Coastal Jogging Group',
          sport: 'running',
          coordinates: { lat: -31.8935, lng: 115.7565 },
          venue_name: 'Scarborough Beach',
          cost_description: 'Free'
        },
        {
          source: 'stirling',
          source_id: '104',
          title: 'Beach Soccer Kickabout',
          sport: 'soccer',
          coordinates: { lat: -31.8930, lng: 115.7560 },
          venue_name: 'Scarborough Beach',
          cost_description: 'Free'
        },
        {
          source: 'stirling',
          source_id: '105',
          title: 'Invalid Activity Without Coordinates' // 1 invalid out of 5 (20% <= 20% threshold, not drift)
        }
      ];
    }
  };

  const mockCrawlerB = {
    name: 'dlgsc',
    async fetchListings() {
      return [
        {
          source: 'dlgsc',
          source_id: '201',
          title: 'Leederville Futsal League',
          sport: 'soccer',
          coordinates: { lat: -31.9366, lng: 115.8431 },
          venue_name: 'Loftus Centre',
          cost_description: '$10 per player'
        }
      ];
    }
  };

  const adapter = createFirestoreAdapter({ dryRun: true });

  const summary = await runCrawlerHarness({
    crawlers: [mockCrawlerA, mockCrawlerB],
    adapter,
    options: { crawler: 'all' }
  });

  assert.equal(summary.totalCrawlers, 2);
  assert.equal(summary.successfulCrawlers, 2);
  assert.equal(summary.failedCrawlers, 0);
  assert.equal(summary.totalRaw, 6);
  assert.equal(summary.totalValid, 5);
  assert.equal(summary.totalInvalid, 1);
  assert.equal(summary.totalUpserted, 5);

  // Check crawler results breakdown
  const stirlingResult = summary.results.find(r => r.crawlerName === 'stirling');
  assert.equal(stirlingResult.rawCount, 5);
  assert.equal(stirlingResult.validCount, 4);
  assert.equal(stirlingResult.invalidCount, 1);
  assert.equal(stirlingResult.upsertedCount, 4);
  assert.equal(stirlingResult.status, 'ok');
  assert.equal(stirlingResult.errorCode, null);
});

test('Seam 4: runCrawlerHarness isolates crawler failure so other crawlers still complete', async () => {
  const failingCrawler = {
    name: 'failing_source',
    async fetchListings() {
      throw new Error('503 Service Unavailable');
    }
  };

  const healthyCrawler = {
    name: 'healthy_source',
    async fetchListings() {
      return [
        {
          source: 'healthy_source',
          source_id: '99',
          title: 'Kings Park Walking Group',
          sport: 'walking',
          coordinates: { lat: -31.9610, lng: 115.8330 }
        }
      ];
    }
  };

  const adapter = createFirestoreAdapter({ dryRun: true });

  const summary = await runCrawlerHarness({
    crawlers: [failingCrawler, healthyCrawler],
    adapter
  });

  assert.equal(summary.totalCrawlers, 2);
  assert.equal(summary.successfulCrawlers, 1);
  assert.equal(summary.failedCrawlers, 1);
  assert.equal(summary.totalValid, 1);
  assert.equal(summary.totalUpserted, 1);

  const failRes = summary.results.find(r => r.crawlerName === 'failing_source');
  assert.equal(failRes.status, 'failed');
  assert.match(failRes.error, /503 Service Unavailable/);
});

test('Seam 4: runCrawlerHarness filters by specific crawler name when requested', async () => {
  const crawlerA = {
    name: 'stirling',
    async fetchListings() { return []; }
  };
  const crawlerB = {
    name: 'dlgsc',
    async fetchListings() { return []; }
  };

  const adapter = createFirestoreAdapter({ dryRun: true });

  const summary = await runCrawlerHarness({
    crawlers: [crawlerA, crawlerB],
    adapter,
    options: { crawler: 'dlgsc' }
  });

  assert.equal(summary.totalCrawlers, 1);
  assert.equal(summary.results[0].crawlerName, 'dlgsc');
});

test('Seam 4A: runCrawlerHarness marks crawler returning fewer than minExpectedListings as failed with ERR_ZERO_YIELD', async () => {
  const emptyCrawler = {
    name: 'empty_crawler',
    async fetchListings() {
      return [];
    }
  };

  const adapter = createFirestoreAdapter({ dryRun: true });
  const summary = await runCrawlerHarness({
    crawlers: [emptyCrawler],
    adapter
  });

  assert.equal(summary.totalCrawlers, 1);
  assert.equal(summary.failedCrawlers, 1);
  assert.equal(summary.successfulCrawlers, 0);
  assert.equal(summary.results[0].status, 'failed');
  assert.equal(summary.results[0].errorCode, 'ERR_ZERO_YIELD');
  assert.equal(summary.results[0].error, 'ERR_ZERO_YIELD');
  assert.equal(summary.results[0].rawCount, 0);
  assert.equal(summary.results[0].upsertedCount, 0);
});

test('Seam 4A: runCrawlerHarness marks crawler with >20% sanitization drop rate as ERR_SCHEMA_DRIFT but still upserts valid items', async () => {
  const driftCrawler = {
    name: 'drift_crawler',
    async fetchListings() {
      // 10 items total: 7 valid, 3 invalid (drop rate 30% > 20%)
      const items = [];
      for (let i = 1; i <= 7; i++) {
        items.push({
          source: 'drift_crawler',
          source_id: `valid_${i}`,
          title: `Valid Activity ${i}`,
          sport: 'tennis',
          coordinates: { lat: -31.95, lng: 115.86 },
          venue_name: 'Perth Tennis Club'
        });
      }
      for (let i = 1; i <= 3; i++) {
        items.push({
          source: 'drift_crawler',
          source_id: `invalid_${i}`,
          title: `Invalid Activity ${i}` // missing coordinates -> fails sanitization
        });
      }
      return items;
    }
  };

  const adapter = createFirestoreAdapter({ dryRun: true });
  const summary = await runCrawlerHarness({
    crawlers: [driftCrawler],
    adapter
  });

  assert.equal(summary.totalCrawlers, 1);
  assert.equal(summary.failedCrawlers, 1);
  assert.equal(summary.successfulCrawlers, 0);
  assert.equal(summary.totalRaw, 10);
  assert.equal(summary.totalValid, 7);
  assert.equal(summary.totalInvalid, 3);
  assert.equal(summary.totalUpserted, 7);

  const res = summary.results[0];
  assert.equal(res.crawlerName, 'drift_crawler');
  assert.equal(res.status, 'failed');
  assert.equal(res.errorCode, 'ERR_SCHEMA_DRIFT');
  assert.equal(res.error, 'ERR_SCHEMA_DRIFT');
  assert.equal(res.rawCount, 10);
  assert.equal(res.validCount, 7);
  assert.equal(res.invalidCount, 3);
  assert.equal(res.upsertedCount, 7);
});

test('Seam 4A: runCrawlerHarness isolates zero-yield, schema drift, and network failure so healthy crawlers complete and persist', async () => {
  const zeroYieldCrawler = {
    name: 'zero_yield',
    async fetchListings() {
      return [];
    }
  };

  const driftCrawler = {
    name: 'drift',
    async fetchListings() {
      return [
        { source: 'drift', source_id: 'd1', title: 'Valid 1', sport: 'cricket', coordinates: { lat: -31.95, lng: 115.86 }, venue_name: 'WACA' },
        { source: 'drift', source_id: 'd2', title: 'Valid 2', sport: 'cricket', coordinates: { lat: -31.95, lng: 115.86 }, venue_name: 'WACA' },
        { source: 'drift', source_id: 'd3', title: 'Invalid 1' }, // missing coordinates
        { source: 'drift', source_id: 'd4', title: 'Invalid 2' }  // missing coordinates (2/4 = 50% > 20%)
      ];
    }
  };

  const networkFailCrawler = {
    name: 'network_fail',
    async fetchListings() {
      const err = new Error('Connection refused');
      err.code = 'ECONNREFUSED';
      throw err;
    }
  };

  const healthyCrawler = {
    name: 'healthy',
    async fetchListings() {
      return [
        { source: 'healthy', source_id: 'h1', title: 'Healthy 1', sport: 'basketball', coordinates: { lat: -31.94, lng: 115.85 }, venue_name: 'Bendat Centre' },
        { source: 'healthy', source_id: 'h2', title: 'Healthy 2', sport: 'basketball', coordinates: { lat: -31.94, lng: 115.85 }, venue_name: 'Bendat Centre' }
      ];
    }
  };

  const adapter = createFirestoreAdapter({ dryRun: true });
  const summary = await runCrawlerHarness({
    crawlers: [zeroYieldCrawler, driftCrawler, networkFailCrawler, healthyCrawler],
    adapter
  });

  assert.equal(summary.totalCrawlers, 4);
  assert.equal(summary.successfulCrawlers, 1);
  assert.equal(summary.failedCrawlers, 3);
  assert.equal(summary.totalRaw, 6);
  assert.equal(summary.totalValid, 4);
  assert.equal(summary.totalInvalid, 2);
  assert.equal(summary.totalUpserted, 4); // 2 from drift + 2 from healthy

  const rZero = summary.results.find(r => r.crawlerName === 'zero_yield');
  assert.equal(rZero.status, 'failed');
  assert.equal(rZero.errorCode, 'ERR_ZERO_YIELD');

  const rDrift = summary.results.find(r => r.crawlerName === 'drift');
  assert.equal(rDrift.status, 'failed');
  assert.equal(rDrift.errorCode, 'ERR_SCHEMA_DRIFT');
  assert.equal(rDrift.upsertedCount, 2);

  const rNet = summary.results.find(r => r.crawlerName === 'network_fail');
  assert.equal(rNet.status, 'failed');
  assert.equal(rNet.errorCode, 'ECONNREFUSED');

  const rHealthy = summary.results.find(r => r.crawlerName === 'healthy');
  assert.equal(rHealthy.status, 'ok');
  assert.equal(rHealthy.errorCode, null);
  assert.equal(rHealthy.upsertedCount, 2);
});

test('Seam 4B: formatStepSummaryTable renders formatted markdown table detailing crawler status and metrics', () => {
  const sampleSummary = {
    totalCrawlers: 2,
    successfulCrawlers: 1,
    failedCrawlers: 1,
    totalRaw: 15,
    totalValid: 12,
    totalInvalid: 3,
    totalUpserted: 12,
    results: [
      {
        crawlerName: 'stirling',
        status: 'ok',
        errorCode: null,
        error: null,
        rawCount: 10,
        validCount: 10,
        invalidCount: 0,
        upsertedCount: 10,
        durationMs: 120
      },
      {
        crawlerName: 'broken_crawler',
        status: 'failed',
        errorCode: 'ERR_SCHEMA_DRIFT',
        error: 'ERR_SCHEMA_DRIFT',
        rawCount: 5,
        validCount: 2,
        invalidCount: 3,
        upsertedCount: 2,
        durationMs: 45
      }
    ]
  };

  const markdown = formatStepSummaryTable(sampleSummary);

  assert.match(markdown, /Crawler/);
  assert.match(markdown, /Status/);
  assert.match(markdown, /Raw/);
  assert.match(markdown, /Valid/);
  assert.match(markdown, /Invalid/);
  assert.match(markdown, /Upserted/);
  assert.match(markdown, /Duration/);
  assert.match(markdown, /Error/);

  assert.match(markdown, /stirling/);
  assert.match(markdown, /broken_crawler/);
  assert.match(markdown, /ERR_SCHEMA_DRIFT/);
  assert.match(markdown, /120ms/);
});

test('Seam 4B: runCrawlerHarness writes step summary to file when GITHUB_STEP_SUMMARY is set or configured', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'harness-step-summary-'));
  const summaryFile = join(tmpDir, 'step_summary.md');

  const prevEnv = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryFile;

  try {
    const crawler = {
      name: 'summary_test_crawler',
      async fetchListings() {
        return [
          {
            source: 'summary_test',
            source_id: 's1',
            title: 'Summary Test Activity',
            sport: 'badminton',
            coordinates: { lat: -31.95, lng: 115.86 },
            venue_name: 'Perth Badminton Arena'
          }
        ];
      }
    };

    const adapter = createFirestoreAdapter({ dryRun: true });
    await runCrawlerHarness({
      crawlers: [crawler],
      adapter
    });

    const fileContent = readFileSync(summaryFile, 'utf8');
    assert.match(fileContent, /summary_test_crawler/);
    assert.match(fileContent, /Crawler Ingestion Diagnostic Summary/);
    assert.match(fileContent, /\| summary_test_crawler \| OK \| 1 \| 1 \| 0 \| 1 \|/);
  } finally {
    if (prevEnv !== undefined) {
      process.env.GITHUB_STEP_SUMMARY = prevEnv;
    } else {
      delete process.env.GITHUB_STEP_SUMMARY;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Seam 4C: CLI exits with status 1 on anomaly and writes GITHUB_STEP_SUMMARY', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'harness-cli-summary-'));
  const summaryFile = join(tmpDir, 'step_summary.md');
  const cliEntrypoint = join(tmpDir, 'cli-stub.mjs');
  const runnerUrl = new URL('../src/crawler-runner.js', import.meta.url).href;
  writeFileSync(
    cliEntrypoint,
    `
      import { main } from ${JSON.stringify(runnerUrl)};
      const stubCrawler = {
        name: 'stub',
        async fetchListings() {
          return Array.from({ length: 10 }, (_, i) => ({
            id: \`stub_\${i}\`,
            region_id: 'perth',
            source: 'stub',
            source_id: \`s_\${i}\`,
            source_url: 'https://example.org/activity',
            title: \`Stub Activity \${i}\`,
            category: 'sports',
            subcategory: 'soccer',
            coordinates: { lat: -31.95, lng: 115.86 },
            venue: { name: 'Test Park', lat: -31.95, lng: 115.86 },
            organizer: { name: 'Test Org' },
            schedule: { start_date: '2026-12-01', recurrence: 'weekly' },
            cost: { is_free: true, display_price: 'Free' },
            demographics: { gender: 'all', age: 'all' }
          }));
        }
      };
      await main(process.argv.slice(2), process.env, { crawlers: [stubCrawler] });
    `,
    'utf8'
  );

  try {
    // 1. Successful CLI run with stub crawler exits 0
    const successResult = await execFileAsync(
      process.execPath,
      [cliEntrypoint, '--dry-run', '--crawler=stub'],
      {
        cwd: process.cwd(),
        env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile, CRAWLER_LOG_DIR: tmpDir }
      }
    );
    assert.equal(successResult.stderr, '');

    // 2. Anomaly run with stub crawler (returns 10 items) and min-expected=100 fails with code 1
    let failedErr = null;
    try {
      await execFileAsync(
        process.execPath,
        [cliEntrypoint, '--dry-run', '--crawler=stub', '--min-expected=100'],
        {
          cwd: process.cwd(),
          env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile, CRAWLER_LOG_DIR: tmpDir }
        }
      );
    } catch (err) {
      failedErr = err;
    }

    assert.ok(failedErr, 'CLI should fail and exit with non-zero code');
    assert.equal(failedErr.code, 1);
    assert.match(failedErr.stderr, /Encountered 1 crawler failure/);

    const summaryContent = readFileSync(summaryFile, 'utf8');
    assert.match(summaryContent, /ERR_ZERO_YIELD/);
    assert.match(summaryContent, /FAILED/);

    const logContent = readFileSync(join(tmpDir, 'crawler-runner.log'), 'utf8');
    assert.match(logContent, /\[INFO\] \[Crawler Harness\] Initializing run/);
    assert.match(logContent, /\[INFO\] \[Harness\] Finished stub:/);
    assert.match(logContent, /\[ERROR\] \[Crawler Harness\] Encountered 1 crawler failure/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Seam 7: getDefaultCrawlers registers the 15 scheduled crawlers and excludes local-only crawlers unless requested', () => {
  const crawlers = getDefaultCrawlers();
  const names = crawlers.map(c => c.name);

  assert.ok(names.includes('stirling'), 'stirling should be in default crawlers');
  assert.ok(!names.includes('visit_perth'), 'visit_perth should be excluded from default scheduled crawlers');
  assert.ok(!names.includes('cockburn'), 'cockburn should be excluded from default scheduled crawlers');
  assert.ok(names.includes('vincent'), 'vincent should be in default crawlers');
  assert.ok(names.includes('wanneroo'), 'wanneroo should be in default crawlers');
  assert.ok(names.includes('gosnells'), 'gosnells should be in default crawlers');
  assert.ok(names.includes('cambridge'), 'cambridge should be in default crawlers');
  assert.ok(names.includes('victoria_park'), 'victoria_park should be in default crawlers');
  assert.ok(names.includes('rockingham'), 'rockingham should be in default crawlers');
  assert.ok(names.includes('bassendean'), 'bassendean should be in default crawlers');
  assert.ok(names.includes('nedlands'), 'nedlands should be in default crawlers');
  assert.ok(names.includes('fremantle'), 'fremantle should be in default crawlers');
  assert.ok(names.includes('joondalup'), 'joondalup should be in default crawlers');
  assert.ok(names.includes('swan'), 'swan should be in default crawlers');
  assert.ok(names.includes('dlgsc'), 'dlgsc should be in default crawlers');
  assert.ok(names.includes('volleyball_wa'), 'volleyball_wa should be in default crawlers');
  assert.ok(names.includes('meetup'), 'meetup should be in default crawlers');
  assert.ok(!names.includes('eventbrite'), 'eventbrite should be excluded from default scheduled crawlers');
  assert.equal(names.length, 15);

  const vincent = crawlers.find(c => c.name === 'vincent');
  assert.equal(vincent?.group, 'councils');
  assert.equal(vincent?.minExpectedListings, 0);

  for (const councilName of ['wanneroo', 'gosnells', 'cambridge', 'victoria_park', 'rockingham', 'bassendean', 'nedlands', 'fremantle', 'joondalup', 'swan']) {
    const council = crawlers.find(c => c.name === councilName);
    assert.equal(council?.group, 'councils', `${councilName} should be in councils group`);
  }

  const withVisitPerth = getDefaultCrawlers({ includeVisitPerth: true });
  const withVisitPerthNames = withVisitPerth.map(c => c.name);
  assert.ok(withVisitPerthNames.includes('visit_perth'), 'visit_perth should be included when includeVisitPerth is true');
  assert.equal(withVisitPerthNames.length, 16);

  const withEventbrite = getDefaultCrawlers({ includeEventbrite: true });
  const withEventbriteNames = withEventbrite.map(c => c.name);
  assert.ok(withEventbriteNames.includes('eventbrite'), 'eventbrite should be included when includeEventbrite is true');
  assert.equal(withEventbriteNames.length, 16);

  const withAllOptIn = getDefaultCrawlers({ includeVisitPerth: true, includeCockburn: true, includeEventbrite: true });
  assert.equal(withAllOptIn.length, 18);
  for (const localName of ['visit_perth', 'cockburn', 'eventbrite']) {
    assert.equal(withAllOptIn.find(c => c.name === localName)?.localOnly, true, `${localName} should have localOnly=true`);
  }

  const withIncludeLocal = getDefaultCrawlers({ includeLocal: true });
  assert.equal(withIncludeLocal.length, 18);
  assert.ok(withIncludeLocal.some(c => c.name === 'cockburn'));
});

test('Seam 7: runCrawlerHarness targets dlgsc, volleyball_wa, eventbrite, and meetup individually', async () => {
  const mockAdapter = {
    async batchUpsertActivities(items) {
      return { total: items.length, upserted: items.length, failed: 0, batches: 1, errors: [], dryRun: true };
    }
  };

  const executed = [];
  const testCrawlers = [
    {
      name: 'stirling',
      async fetchListings() {
        executed.push('stirling');
        return [];
      }
    },
    {
      name: 'dlgsc',
      async fetchListings() {
        executed.push('dlgsc');
        return [
          {
            source: 'dlgsc',
            source_id: 'dlg-1',
            title: 'Subiaco Soccer',
            sport: 'Soccer',
            coordinates: { lat: -31.94, lng: 115.82 },
            venue_name: 'Rosalie Park'
          }
        ];
      }
    },
    {
      name: 'volleyball_wa',
      async fetchListings() {
        executed.push('volleyball_wa');
        return [
          {
            source: 'volleyball_wa',
            source_id: 'vwa-1',
            title: 'The HUB Volleyball',
            sport: 'volleyball',
            coordinates: { lat: -31.94, lng: 115.84 },
            venue_name: 'The HUB'
          }
        ];
      }
    },
    {
      name: 'eventbrite',
      async fetchListings() {
        executed.push('eventbrite');
        return [
          {
            source: 'eventbrite',
            source_id: 'eb-1',
            title: 'Perth Running Collective 5K',
            sport: 'running',
            coordinates: { lat: -31.96, lng: 115.84 },
            venue_name: 'Kings Park'
          }
        ];
      }
    },
    {
      name: 'meetup',
      async fetchListings() {
        executed.push('meetup');
        return [
          {
            source: 'meetup',
            source_id: 'mu-1',
            title: 'Social Badminton',
            sport: 'badminton',
            coordinates: { lat: -31.81, lng: 115.82 },
            venue_name: 'Kingsway Stadium'
          }
        ];
      }
    }
  ];

  // Test targeting dlgsc individually
  executed.length = 0;
  const dlgscSummary = await runCrawlerHarness({
    crawlers: testCrawlers,
    adapter: mockAdapter,
    options: { crawler: 'dlgsc' }
  });
  assert.deepEqual(executed, ['dlgsc']);
  assert.equal(dlgscSummary.successfulCrawlers, 1);
  assert.equal(dlgscSummary.totalValid, 1);

  // Test targeting volleyball_wa individually
  executed.length = 0;
  const vwaSummary = await runCrawlerHarness({
    crawlers: testCrawlers,
    adapter: mockAdapter,
    options: { crawler: 'volleyball_wa' }
  });
  assert.deepEqual(executed, ['volleyball_wa']);
  assert.equal(vwaSummary.successfulCrawlers, 1);
  assert.equal(vwaSummary.totalValid, 1);

  // Test targeting eventbrite individually
  executed.length = 0;
  const ebSummary = await runCrawlerHarness({
    crawlers: testCrawlers,
    adapter: mockAdapter,
    options: { crawler: 'eventbrite' }
  });
  assert.deepEqual(executed, ['eventbrite']);
  assert.equal(ebSummary.successfulCrawlers, 1);
  assert.equal(ebSummary.totalValid, 1);

  // Test targeting meetup individually
  executed.length = 0;
  const muSummary = await runCrawlerHarness({
    crawlers: testCrawlers,
    adapter: mockAdapter,
    options: { crawler: 'meetup' }
  });
  assert.deepEqual(executed, ['meetup']);
  assert.equal(muSummary.successfulCrawlers, 1);
  assert.equal(muSummary.totalValid, 1);
});

test('Seam 4: runCrawlerHarness executes pre-write URL verification, degrades unreachable links to Unverified, and preserves crawler health', async () => {
  const probed = [];
  const mockFetch = async (url) => {
    probed.push(url);
    if (url.includes('broken')) {
      return { ok: false, status: 404, url, body: null };
    }
    return { ok: true, status: 200, url, body: null };
  };

  const existingStore = new Map([
    ['c1_3', { id: 'c1_3', verified: true, source_url: 'https://example.com/already-good' }],
    ['c1_4', { id: 'c1_4', verified: false, raw_source_url: 'https://example.com/was-bad-now-fixed' }]
  ]);

  let upsertedActivities = [];
  const mockAdapter = {
    isDryRun() { return false; },
    async getActivities(ids) {
      const res = new Map();
      for (const id of ids) {
        if (existingStore.has(id)) {
          res.set(id, existingStore.get(id));
        }
      }
      return res;
    },
    async batchUpsertActivities(items) {
      upsertedActivities = [...items];
      return { total: items.length, upserted: items.length, failed: 0, batches: 1, errors: [], dryRun: false };
    }
  };

  const mockCrawler = {
    name: 'test_crawler',
    async fetchListings() {
      return [
        // 1. Recoverable and reachable
        {
          source: 'c1',
          source_id: '1',
          title: 'Activity 1',
          source_url: 'http://example.com/event-1',
          coordinates: { lat: -31.95, lng: 115.86 }
        },
        // 2. Unreachable (404) -> should degrade to Unverified Listing without dropping
        {
          source: 'c1',
          source_id: '2',
          title: 'Activity 2',
          source_url: 'https://example.com/broken-link',
          coordinates: { lat: -31.95, lng: 115.86 }
        },
        // 3. Existing verified record -> should skip network probe
        {
          source: 'c1',
          source_id: '3',
          title: 'Activity 3',
          source_url: 'https://example.com/already-good',
          coordinates: { lat: -31.95, lng: 115.86 }
        },
        // 4. Existing unverified record -> should re-probe and self-heal
        {
          source: 'c1',
          source_id: '4',
          title: 'Activity 4',
          source_url: 'https://example.com/was-bad-now-fixed',
          coordinates: { lat: -31.95, lng: 115.86 }
        }
      ];
    }
  };

  const summary = await runCrawlerHarness({
    crawlers: [mockCrawler],
    adapter: mockAdapter,
    options: {
      urlVerifierOptions: {
        fetch: mockFetch
      }
    }
  });

  assert.equal(summary.successfulCrawlers, 1);
  assert.equal(summary.failedCrawlers, 0);
  assert.equal(summary.totalValid, 4);
  assert.equal(summary.totalInvalid, 0);
  assert.equal(summary.totalUpserted, 4);

  // Probe calls:
  // Activity 1 was probed (after scheme recovery http -> https)
  assert.ok(probed.includes('https://example.com/event-1'));
  // Activity 2 was probed and failed
  assert.ok(probed.includes('https://example.com/broken-link'));
  // Activity 3 was skipped!
  assert.ok(!probed.includes('https://example.com/already-good'));
  // Activity 4 was re-probed and healed!
  assert.ok(probed.includes('https://example.com/was-bad-now-fixed'));

  // Upserted verification states:
  const act1 = upsertedActivities.find(a => a.id === 'c1_1');
  assert.equal(act1.verified, true);
  assert.equal(act1.source_url, 'https://example.com/event-1');

  const act2 = upsertedActivities.find(a => a.id === 'c1_2');
  assert.equal(act2.verified, false);
  assert.equal(act2.source_url, null);
  assert.equal(act2.raw_source_url, 'https://example.com/broken-link');

  const act3 = upsertedActivities.find(a => a.id === 'c1_3');
  assert.equal(act3.verified, true);
  assert.equal(act3.source_url, 'https://example.com/already-good');

  const act4 = upsertedActivities.find(a => a.id === 'c1_4');
  assert.equal(act4.verified, true);
  assert.equal(act4.source_url, 'https://example.com/was-bad-now-fixed');
});

function createMockFirestoreDb(writtenDocs) {
  return {
    collection(colName) {
      return {
        doc(id) {
          return { id, colName, path: `${colName}/${id}` };
        }
      };
    },
    async getAll(...docRefs) {
      return docRefs.map(ref => ({ id: ref.id, exists: false, data: () => undefined }));
    },
    batch() {
      const ops = [];
      return {
        set(docRef, data, options) {
          ops.push({ docRef, data, options });
        },
        async commit() {
          for (const op of ops) {
            writtenDocs.set(op.docRef.path, op.data);
          }
        }
      };
    }
  };
}

test('Seam 4: runCrawlerHarness routes directory crawlers (dlgsc, volleyball_wa) to /organizers only and never writes to /venues', async () => {
  const writtenDocs = new Map();
  const mockDb = createMockFirestoreDb(writtenDocs);

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });
  const mockFetch = async (url) => {
    if (url.includes('broken')) {
      return { ok: false, status: 404, url, body: null };
    }
    return { ok: true, status: 200, url, body: null };
  };

  const dlgscDirectoryCrawler = {
    name: 'dlgsc',
    async fetchListings() {
      return [
        {
          id: 'org_subiaco_soccer_club',
          entity_type: 'organizer',
          source: 'dlgsc',
          source_id: 'dlg-1',
          name: 'Subiaco Soccer Club',
          address: 'Rosalie Park, Subiaco',
          coordinates: { lat: -31.9445, lng: 115.828 },
          subcategories: ['soccer'],
          website: 'https://subiacosoccer.org.au',
          source_url: 'https://subiacosoccer.org.au',
          contact: { email: 'info@subiacosoccer.org.au', phone: '08 9381 0000' },
          cost_description: 'KidSport eligible',
          demographics: { gender: 'all', age: 'juniors' }
        },
        {
          id: 'org_broken_link_club',
          entity_type: 'organizer',
          source: 'dlgsc',
          source_id: 'dlg-2',
          name: 'Broken Link Club',
          address: '10 Test St, Perth',
          coordinates: { lat: -31.95, lng: 115.86 },
          subcategories: ['tennis'],
          website: 'https://broken.example.com',
          source_url: 'https://broken.example.com'
        }
      ];
    }
  };

  const vwaDirectoryCrawler = {
    name: 'volleyball_wa',
    async fetchListings() {
      return [
        {
          id: 'venue_the_hub_qd66h3',
          entity_type: 'venue',
          source: 'volleyball_wa',
          source_id: '30092',
          name: 'The HUB',
          address: 'Inner City Beach, 180 Charles St, West Perth, WA 6005',
          coordinates: { lat: -31.941599, lng: 115.847653 },
          subcategories: ['volleyball'],
          source_url: 'https://volleyballwa.com.au/social-volley/'
        },
        {
          id: 'org_chequers_volleyball_club',
          entity_type: 'organizer',
          source: 'volleyball_wa',
          source_id: '34912',
          name: 'Chequers Volleyball Club',
          address: 'Perth Modern School, 90 Roberts Rd, Subiaco, WA 6008',
          coordinates: { lat: -31.944988, lng: 115.83866 },
          subcategories: ['volleyball'],
          source_url: 'https://volleyballwa.com.au/places/chequers/'
        }
      ];
    }
  };

  const driftDirectoryCrawler = {
    name: 'dlgsc_drift',
    async fetchListings() {
      return [
        {
          id: 'org_valid_only',
          entity_type: 'organizer',
          source: 'dlgsc',
          source_id: 'd1',
          name: 'Valid Org',
          coordinates: { lat: -31.95, lng: 115.86 },
          subcategories: ['cricket'],
          source_url: 'https://valid.example.com'
        },
        {
          // Missing coordinates -> fails sanitization (50% drop rate > 20% -> ERR_SCHEMA_DRIFT)
          id: 'org_invalid_no_coords',
          entity_type: 'organizer',
          source: 'dlgsc',
          source_id: 'd2',
          name: 'Invalid Org'
        }
      ];
    }
  };

  const zeroYieldDirectoryCrawler = {
    name: 'volleyball_wa_empty',
    async fetchListings() {
      return [];
    }
  };

  const summary = await runCrawlerHarness({
    crawlers: [dlgscDirectoryCrawler, vwaDirectoryCrawler, driftDirectoryCrawler, zeroYieldDirectoryCrawler],
    adapter,
    options: {
      urlVerifierOptions: { fetch: mockFetch }
    }
  });

  assert.equal(summary.totalCrawlers, 4);
  assert.equal(summary.successfulCrawlers, 2);
  assert.equal(summary.failedCrawlers, 2);
  assert.equal(summary.results.find(r => r.crawlerName === 'dlgsc_drift').errorCode, 'ERR_SCHEMA_DRIFT');
  assert.equal(summary.results.find(r => r.crawlerName === 'volleyball_wa_empty').errorCode, 'ERR_ZERO_YIELD');

  const writtenKeys = Array.from(writtenDocs.keys());
  assert.equal(writtenKeys.filter(k => k.startsWith('activities/')).length, 0);
  assert.equal(writtenKeys.filter(k => k.startsWith('venues/')).length, 0);
  assert.ok(writtenDocs.has('organizers/org_subiaco_soccer_club'));
  assert.ok(writtenDocs.has('organizers/org_broken_link_club'));
  assert.ok(writtenDocs.has('organizers/org_chequers_volleyball_club'));
  assert.equal(writtenDocs.has('venues/venue_the_hub_qd66h3'), false);

  const brokenOrg = writtenDocs.get('organizers/org_broken_link_club');
  assert.equal(brokenOrg.verified, false);
  assert.equal(brokenOrg.source_url, null);
  assert.equal(brokenOrg.raw_source_url, 'https://broken.example.com');
});

test('Seam 4: runCrawlerHarness preserves raw venue address, organizer contact, and post-verification URL status for scheduled Activity crawlers', async () => {
  const writtenDocs = new Map();
  const mockDb = createMockFirestoreDb(writtenDocs);

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });
  const mockFetch = async (url) => {
    if (url.includes('broken-event')) {
      return { ok: false, status: 404, url, body: null };
    }
    return { ok: true, status: 200, url, body: null };
  };

  const stirlingCrawler = {
    name: 'stirling',
    async fetchListings() {
      return [
        {
          source: 'stirling',
          source_id: 's-1',
          title: 'Scarborough Beach Volleyball',
          sport: 'volleyball',
          venue_name: 'Scarborough Beach Amphitheatre',
          address: 'The Esplanade, Scarborough WA 6019',
          coordinates: { lat: -31.8942, lng: 115.7571 },
          start_time: '2026-11-20T17:30:00+08:00',
          external_url: 'https://stirling.wa.gov.au/events/beach-volley',
          organizer: {
            id: 'org_city_of_stirling',
            name: 'City of Stirling',
            website: 'https://www.stirling.wa.gov.au',
            contact: { email: 'recreation@stirling.wa.gov.au', phone: '08 9205 8555' }
          }
        },
        {
          source: 'stirling',
          source_id: 's-2',
          title: 'Broken Link Basketball',
          sport: 'basketball',
          venue_name: 'Herb Graham Recreation Centre',
          address: '38 Ashbury Cres, Mirrabooka WA 6061',
          coordinates: { lat: -31.8691, lng: 115.8622 },
          start_time: '2026-11-21T18:00:00+08:00',
          external_url: 'https://stirling.wa.gov.au/broken-event',
          organizer: {
            id: 'org_mirrabooka_hoops',
            name: 'Mirrabooka Hoops'
          }
        }
      ];
    }
  };

  const summary = await runCrawlerHarness({
    crawlers: [stirlingCrawler],
    adapter,
    options: {
      urlVerifierOptions: { fetch: mockFetch }
    }
  });

  assert.equal(summary.successfulCrawlers, 1);
  assert.equal(summary.totalUpserted, 2);

  // Activity + linked Organizer + Region are upserted; /venues is never written by crawlers
  const activity1 = writtenDocs.get('activities/stirling_s-1');
  assert.ok(activity1);
  assert.equal(activity1.verified, true);
  assert.equal(activity1.source_url, 'https://stirling.wa.gov.au/events/beach-volley');
  assert.equal(Object.prototype.propertyIsEnumerable.call(activity1, '_canonicalEntities'), false);

  assert.equal(Array.from(writtenDocs.keys()).filter(k => k.startsWith('venues/')).length, 0);

  const org1 = writtenDocs.get('organizers/org_city_of_stirling');
  assert.ok(org1);
  assert.equal(org1.website, 'https://www.stirling.wa.gov.au');
  assert.deepEqual(org1.contact, { email: 'recreation@stirling.wa.gov.au', phone: '08 9205 8555', facebook: null });
  assert.equal(org1.verified, true);

  assert.ok(writtenDocs.has('regions/perth'));

  // Degraded URL status is reflected on both the Activity and its extracted entities
  const activity2 = writtenDocs.get('activities/stirling_s-2');
  assert.equal(activity2.verified, false);
  assert.equal(activity2.source_url, null);
  assert.equal(activity2.raw_source_url, 'https://stirling.wa.gov.au/broken-event');

  const org2 = writtenDocs.get('organizers/org_mirrabooka_hoops');
  assert.equal(org2.verified, false);
  assert.equal(org2.source_url, null);
  assert.equal(org2.website, null);
});

test('Seam 4 (Issue #17): runCrawlerHarness reconciles confident, uncertain, unmatched, and human-approved entities without writing to /venues', async () => {
  const store = {
    venues: new Map([
      ['venue_scarborough_beach_amphitheatre_qd66s4', {
        id: 'venue_scarborough_beach_amphitheatre_qd66s4',
        name: 'Scarborough Beach Amphitheatre',
        coordinates: { lat: -31.8942, lng: 115.7571 },
        geohash: 'qd66s4b9x',
        google_place_id: 'ChIJScarboroughPlace',
        needs_review: false
      }],
      ['venue_rosalie_park_qd66h2', {
        id: 'venue_rosalie_park_qd66h2',
        name: 'Rosalie Park',
        coordinates: { lat: -31.9540, lng: 115.8220 },
        geohash: 'qd66h2xyz',
        google_place_id: 'ChIJRosalieParkPlace',
        needs_review: false
      }]
    ]),
    organizers: new Map([
      ['org_city_of_stirling', {
        id: 'org_city_of_stirling',
        name: 'City of Stirling',
        coordinates: { lat: -31.8830, lng: 115.8050 },
        needs_review: false,
        review_reason: null,
        address: '25 Cedric St, Stirling WA 6021',
        google_place_id: 'ChIJCityStirlingPlace'
      }]
    ]),
    activities: new Map([
      ['stirling_approved_1', {
        id: 'stirling_approved_1',
        region_id: 'perth',
        title: 'Approved Beach Volley',
        name: 'Approved Beach Volley',
        address: 'Curated Esplanade, Scarborough',
        coordinates: { lat: -31.8942, lng: 115.7571 },
        google_place_id: 'ChIJApprovedActivityPlace',
        venue: {
          id: 'venue_scarborough_beach_amphitheatre_qd66s4',
          name: 'Scarborough Beach Amphitheatre',
          coordinates: { lat: -31.8942, lng: 115.7571 },
          geohash: 'qd66s4b9x',
          google_place_id: 'ChIJScarboroughPlace'
        },
        organizer: {
          id: 'org_city_of_stirling',
          name: 'City of Stirling'
        },
        needs_review: false,
        review_reason: null
      }]
    ]),
    regions: new Map()
  };

  const mockDb = {
    collection(colName) {
      return {
        doc(id) {
          return { id, colName, path: `${colName}/${id}` };
        },
        async get() {
          const map = store[colName] || new Map();
          return {
            docs: Array.from(map.entries()).map(([id, data]) => ({
              id,
              data: () => data
            }))
          };
        }
      };
    },
    async getAll(...docRefs) {
      return docRefs.map(ref => {
        const data = store[ref.colName]?.get(ref.id);
        return { id: ref.id, exists: Boolean(data), data: () => data };
      });
    },
    batch() {
      const ops = [];
      return {
        set(docRef, data) {
          ops.push({ docRef, data });
        },
        async commit() {
          for (const op of ops) {
            store[op.docRef.colName]?.set(op.docRef.id, op.data);
          }
        }
      };
    }
  };

  const adapter = createFirestoreAdapter({ db: mockDb, dryRun: false });
  const initialVenueKeys = Array.from(store.venues.keys());

  const crawler = {
    name: 'stirling',
    async fetchListings() {
      return [
        // 1. Confident Venue + Confident Organizer
        {
          source: 'stirling',
          source_id: 'confident_1',
          title: 'Sunset Volleyball',
          sport: 'volleyball',
          venue_name: 'Scarborough Beach Amphitheatre',
          coordinates: { lat: -31.8943, lng: 115.7572 },
          start_time: '2026-11-22T17:30:00+08:00',
          external_url: 'https://stirling.wa.gov.au/sunset',
          organizer: { name: 'City of Stirling' }
        },
        // 2. Uncertain Venue
        {
          source: 'stirling',
          source_id: 'uncertain_venue_1',
          title: 'Beach Yoga',
          sport: 'yoga',
          venue_name: 'Scarborough Beach',
          coordinates: { lat: -31.8960, lng: 115.7580 },
          start_time: '2026-11-22T08:00:00+08:00',
          external_url: 'https://stirling.wa.gov.au/yoga',
          organizer: { name: 'City of Stirling' }
        },
        // 3. Uncertain Organizer
        {
          source: 'stirling',
          source_id: 'uncertain_org_1',
          title: 'Park Touch',
          sport: 'touch_football',
          venue_name: 'Rosalie Park',
          coordinates: { lat: -31.9540, lng: 115.8220 },
          start_time: '2026-11-23T18:00:00+08:00',
          external_url: 'https://stirling.wa.gov.au/touch',
          organizer: { name: 'Stirling' }
        },
        // 4. Unmatched Venue
        {
          source: 'stirling',
          source_id: 'unmatched_venue_1',
          title: 'Hidden Court Badminton',
          sport: 'badminton',
          venue_name: 'Secret Community Hall',
          coordinates: { lat: -32.1200, lng: 115.9200 },
          start_time: '2026-11-24T19:00:00+08:00',
          external_url: 'https://stirling.wa.gov.au/badminton',
          organizer: { name: 'City of Stirling' }
        },
        // 5. Unmatched Organizer
        {
          source: 'stirling',
          source_id: 'unmatched_org_1',
          title: 'New Club Pickleball',
          sport: 'pickleball',
          venue_name: 'Rosalie Park',
          coordinates: { lat: -31.9540, lng: 115.8220 },
          start_time: '2026-11-25T18:30:00+08:00',
          external_url: 'https://stirling.wa.gov.au/pickleball',
          organizer: { name: 'Brand New Pickleball Club' }
        },
        // 6. Human-approved re-crawl (with unmatched raw venue name that must NOT overwrite curated link)
        {
          source: 'stirling',
          source_id: 'approved_1',
          title: 'Raw Title Should Not Break Approved',
          sport: 'volleyball',
          venue_name: 'Unrecognized Raw Venue Name',
          coordinates: { lat: -32.2000, lng: 115.9900 },
          start_time: '2026-11-26T17:30:00+08:00',
          external_url: 'https://stirling.wa.gov.au/approved',
          organizer: { name: 'City of Stirling' }
        }
      ];
    }
  };

  const summary = await runCrawlerHarness({
    crawlers: [crawler],
    adapter,
    options: { skipUrlVerification: true }
  });

  assert.equal(summary.successfulCrawlers, 1);
  assert.equal(summary.totalUpserted, 6);

  // /venues must remain untouched
  assert.deepEqual(Array.from(store.venues.keys()), initialVenueKeys);

  // 1. Confident
  const confident = store.activities.get('stirling_confident_1');
  assert.equal(confident.needs_review, false);
  assert.equal(confident.review_reason, null);
  assert.equal(confident.venue.id, 'venue_scarborough_beach_amphitheatre_qd66s4');
  assert.equal(confident.venue.google_place_id, 'ChIJScarboroughPlace');
  assert.equal(confident.organizer.id, 'org_city_of_stirling');

  // 2. Uncertain venue
  const uncertainVenue = store.activities.get('stirling_uncertain_venue_1');
  assert.equal(uncertainVenue.needs_review, true);
  assert.equal(uncertainVenue.review_reason, 'uncertain_venue_match');
  assert.equal(uncertainVenue.venue.id, 'venue_scarborough_beach_amphitheatre_qd66s4');

  // 3. Uncertain organizer
  const uncertainOrg = store.activities.get('stirling_uncertain_org_1');
  assert.equal(uncertainOrg.needs_review, true);
  assert.equal(uncertainOrg.review_reason, 'uncertain_organizer_match');
  assert.equal(uncertainOrg.organizer.id, 'org_city_of_stirling');

  // 4. Unmatched venue
  const unmatchedVenue = store.activities.get('stirling_unmatched_venue_1');
  assert.equal(unmatchedVenue.needs_review, true);
  assert.equal(unmatchedVenue.review_reason, 'unmatched_venue');
  assert.equal(unmatchedVenue.venue.id, null);
  assert.equal(unmatchedVenue.venue.name, 'Secret Community Hall');
  assert.deepEqual(unmatchedVenue.venue.coordinates, { lat: -32.1200, lng: 115.9200 });

  // 5. Unmatched organizer
  const unmatchedOrg = store.activities.get('stirling_unmatched_org_1');
  assert.equal(unmatchedOrg.needs_review, true);
  assert.equal(unmatchedOrg.review_reason, 'unmatched_organizer');
  const createdOrg = store.organizers.get('org_brand_new_pickleball_club');
  assert.ok(createdOrg);
  assert.equal(createdOrg.needs_review, true);
  assert.equal(createdOrg.review_reason, 'crawler_created');

  // 6. Human-approved activity & organizer preserved
  const approvedActivity = store.activities.get('stirling_approved_1');
  assert.equal(approvedActivity.needs_review, false);
  assert.equal(approvedActivity.review_reason, null);
  assert.equal(approvedActivity.venue.id, 'venue_scarborough_beach_amphitheatre_qd66s4');
  assert.equal(approvedActivity.name, 'Approved Beach Volley');
  assert.equal(approvedActivity.google_place_id, 'ChIJApprovedActivityPlace');

  const approvedOrg = store.organizers.get('org_city_of_stirling');
  assert.equal(approvedOrg.needs_review, false);
  assert.equal(approvedOrg.review_reason, null);
  assert.equal(approvedOrg.address, '25 Cedric St, Stirling WA 6021');
  assert.equal(approvedOrg.google_place_id, 'ChIJCityStirlingPlace');

  // 7. Directory crawler Organizer reconciliation (unmatched -> crawler_created, approved -> preserved)
  const dirCrawler = {
    name: 'dlgsc',
    async fetchListings() {
      return [
        {
          id: 'org_city_of_stirling',
          entity_type: 'organizer',
          source: 'dlgsc',
          source_id: 'd-approved',
          name: 'Raw Stirling Name',
          address: 'Wrong Crawled Address',
          coordinates: { lat: -31.9999, lng: 115.9999 },
          subcategories: ['soccer'],
          source_url: 'https://stirling.wa.gov.au'
        },
        {
          id: 'org_unmatched_dir_club',
          entity_type: 'organizer',
          source: 'dlgsc',
          source_id: 'd-new',
          name: 'Unmatched Directory Organizer',
          address: '10 New St, Perth WA 6000',
          coordinates: { lat: -31.95, lng: 115.86 },
          subcategories: ['netball'],
          source_url: 'https://newclub.example.com'
        }
      ];
    }
  };

  await runCrawlerHarness({
    crawlers: [dirCrawler],
    adapter,
    options: { skipUrlVerification: true }
  });

  const reCrawledApprovedOrg = store.organizers.get('org_city_of_stirling');
  assert.equal(reCrawledApprovedOrg.needs_review, false);
  assert.equal(reCrawledApprovedOrg.review_reason, null);
  assert.equal(reCrawledApprovedOrg.address, '25 Cedric St, Stirling WA 6021');

  const newDirOrg = store.organizers.get('org_unmatched_dir_club');
  assert.ok(newDirOrg);
  assert.equal(newDirOrg.needs_review, true);
  assert.equal(newDirOrg.review_reason, 'crawler_created');
});

test('main loads FIREBASE_SERVICE_ACCOUNT_KEY and project config from .env when executed', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'crawler-runner-dotenv-'));
  const envFilePath = join(tmpDir, '.env');
  const scriptPath = resolve(process.cwd(), 'src/crawler-runner.js');

  try {
    writeFileSync(
      envFilePath,
      'FIREBASE_PROJECT_ID="env-crawler-proj"\nFIREBASE_SERVICE_ACCOUNT_KEY="not-valid-json-key"\n',
      'utf8'
    );

    const env = {};
    const logs = [];
    const stubCrawler = {
      name: 'stub',
      async fetchListings() {
        return [{
          id: 'stub_1',
          region_id: 'perth',
          source: 'stub',
          source_id: 's_1',
          source_url: 'https://example.org/activity',
          title: 'Stub Activity',
          category: 'sports',
          subcategory: 'soccer',
          coordinates: { lat: -31.95, lng: 115.86 },
          venue: { name: 'Test Park', lat: -31.95, lng: 115.86 },
          organizer: { name: 'Test Org' },
          schedule: { start_date: '2026-12-01', recurrence: 'weekly' },
          cost: { is_free: true, display_price: 'Free' },
          demographics: { gender: 'all', age: 'all' }
        }];
      }
    };
    const summary = await main(
      ['--dry-run', '--crawler=stub'],
      env,
      {
        envFilePath,
        crawlers: [stubCrawler],
        firestoreEnv: { db: null, dryRun: true, projectId: null },
        logger: {
          log: (...args) => logs.push(args.join(' ')),
          warn: (...args) => logs.push(args.join(' ')),
          error: (...args) => logs.push(args.join(' '))
        }
      }
    );

    assert.equal(env.FIREBASE_PROJECT_ID, 'env-crawler-proj');
    assert.equal(env.FIREBASE_SERVICE_ACCOUNT_KEY, 'not-valid-json-key');
    assert.equal(summary.successfulCrawlers, 1);
    assert.ok(logs.some(line => line.includes('project: env-crawler-proj')));

    // Verify CLI execution reads .env from cwd before checking FIREBASE_SERVICE_ACCOUNT_KEY
    const childEnv = { ...process.env };
    delete childEnv.FIREBASE_SERVICE_ACCOUNT_KEY;
    delete childEnv.FIREBASE_USE_ADC;
    delete childEnv.FIREBASE_PROJECT_ID;

    let cliErr = null;
    try {
      await execFileAsync(
        process.execPath,
        [scriptPath, '--crawler=stirling'],
        { cwd: tmpDir, env: childEnv }
      );
    } catch (err) {
      cliErr = err;
    }

    assert.ok(cliErr, 'CLI should fail when .env contains a malformed service account key');
    assert.match(cliErr.stderr, /Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY/);
    assert.doesNotMatch(cliErr.stderr, /Missing required secret/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createFileLogger and crawler-runner main write timestamped INFO, WARN, and ERROR entries to log file', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'crawler-runner-logfile-'));
  const logFilePath = join(tmpDir, 'custom-crawler.log');

  try {
    const mirrored = [];
    const fileLogger = createFileLogger({
      filePath: logFilePath,
      baseLogger: {
        log: (...args) => mirrored.push(['log', ...args]),
        info: (...args) => mirrored.push(['info', ...args]),
        warn: (...args) => mirrored.push(['warn', ...args]),
        error: (...args) => mirrored.push(['error', ...args])
      }
    });

    fileLogger.info('Info check', 1);
    fileLogger.warn('Warn check', 'be careful');
    fileLogger.error('Error check', new Error('boom').message);

    const stubCrawler = {
      name: 'stub',
      async fetchListings() {
        return [{
          source: 'stub',
          source_id: 's_1',
          source_url: 'https://example.org/activity',
          title: 'Stub Activity',
          coordinates: { lat: -31.95, lng: 115.86 }
        }];
      }
    };
    await main(
      ['--dry-run', '--crawler=stub', `--log-file=${logFilePath}`],
      {},
      {
        crawlers: [stubCrawler],
        exitOnFailure: false,
        firestoreEnv: { db: null, dryRun: true, projectId: null },
        logger: { log: () => {}, warn: () => {}, error: () => {} }
      }
    );

    const content = readFileSync(logFilePath, 'utf8');
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T.*Z\] \[INFO\] Info check 1$/m);
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T.*Z\] \[WARN\] Warn check be careful$/m);
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T.*Z\] \[ERROR\] Error check boom$/m);
    assert.match(content, /\[INFO\] \[Crawler Harness\] Initializing run/);
    assert.match(content, /\[INFO\] \n--- Ingestion Summary Report ---/);
    assert.equal(mirrored.length, 3);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Seam 4 (Issue #31): runCrawlerHarness suppresses standalone Organizer creation when raw Activity lacks Organizer name', async () => {
  const store = {
    venues: new Map([
      ['venue_perth_town_hall_qd66hx', {
        id: 'venue_perth_town_hall_qd66hx',
        name: 'Perth Town Hall',
        coordinates: { lat: -31.9547, lng: 115.8606 },
        geohash: 'qd66hx123',
        google_place_id: 'ChIJPerthTownHall'
      }]
    ]),
    organizers: new Map(),
    activities: new Map(),
    regions: new Map()
  };

  const adapter = {
    async loadCatalog() {
      return {
        venues: Array.from(store.venues.values()),
        organizers: Array.from(store.organizers.values())
      };
    },
    async batchUpsertListings(items) {
      for (const item of items) {
        const entities = item._canonicalEntities || {};
        store.activities.set(item.id, item);
        if (entities.organizer?.id) {
          store.organizers.set(entities.organizer.id, entities.organizer);
        }
        if (entities.region?.id) {
          store.regions.set(entities.region.id, entities.region);
        }
      }
      return { upserted: items.length };
    }
  };

  const crawler = {
    name: 'eventbrite',
    async fetchListings() {
      return [
        {
          source: 'eventbrite',
          source_id: 'no-org-matched-venue',
          title: 'Nameless Community Choir',
          category: 'music',
          venue_name: 'Perth Town Hall',
          coordinates: { lat: -31.9547, lng: 115.8606 },
          start_time: '2026-11-28T19:00:00+08:00',
          external_url: 'https://www.eventbrite.com.au/e/nameless-choir-111'
        },
        {
          source: 'eventbrite',
          source_id: 'no-org-unmatched-venue',
          title: 'Nameless Pottery Workshop',
          category: 'hobbies',
          venue_name: 'Unknown Studio',
          coordinates: { lat: -31.9450, lng: 115.8550 },
          start_time: '2026-11-29T10:00:00+08:00',
          external_url: 'https://www.eventbrite.com.au/e/nameless-pottery-222',
          organizer: { name: '   ' }
        }
      ];
    }
  };

  const summary = await runCrawlerHarness({
    crawlers: [crawler],
    adapter,
    options: { skipUrlVerification: true }
  });

  assert.equal(summary.successfulCrawlers, 1);
  assert.equal(summary.totalUpserted, 2);
  assert.equal(store.organizers.size, 0, 'Must not create synthetic standalone Organizer documents');

  const act1 = store.activities.get('eventbrite_no-org-matched-venue');
  assert.equal(act1.category, 'music');
  assert.equal(act1.subcategory, 'music');
  assert.equal(act1.needs_review, true);
  assert.equal(act1.review_reason, 'unmatched_organizer');

  const act2 = store.activities.get('eventbrite_no-org-unmatched-venue');
  assert.equal(act2.category, 'hobbies');
  assert.equal(act2.subcategory, 'hobbies');
  assert.equal(act2.needs_review, true);
  assert.equal(act2.review_reason, 'unmatched_organizer');
});

test('Seam 4 (Issue #35): runCrawlerHarness resolves 4-step Venue and coordinate fallback before Activity sanitization', async () => {
  const store = {
    activities: new Map(),
    organizers: new Map(),
    venues: new Map([
      ['venue_perth_town_hall_qd66hx', {
        id: 'venue_perth_town_hall_qd66hx',
        name: 'Perth Town Hall',
        coordinates: { lat: -31.9547, lng: 115.8606 },
        geohash: 'qd66hx999',
        google_place_id: 'ChIJPTH'
      }],
      ['venue_lords_subiaco', {
        id: 'venue_lords_subiaco',
        name: 'Lords Recreation Centre Subiaco',
        coordinates: { lat: -31.9463, lng: 115.8234 },
        geohash: 'qd66hx456',
        google_place_id: 'ChIJ_lords'
      }]
    ])
  };

  const adapter = {
    async scanVenues() {
      return Array.from(store.venues.values());
    },
    async scanOrganizers() {
      return [
        {
          id: 'org_city_of_stirling',
          name: 'City of Stirling',
          coordinates: { lat: -31.8942, lng: 115.7571 }
        }
      ];
    },
    async batchUpsertListings(listings) {
      for (const item of listings) {
        store.activities.set(item.id, item);
      }
      return { upserted: listings.length };
    }
  };

  const lgaCentroid = { lat: -31.8942, lng: 115.7571 };
  const crawler = {
    name: 'stirling',
    fallbackCentroid: lgaCentroid,
    async fetchListings() {
      return [
        // Step 1: Explicit Greater Perth coordinates -> preserves normal catalog matching
        {
          source: 'stirling',
          source_id: 'step1_explicit',
          title: 'Town Hall Choir',
          category: 'music',
          venue_name: 'Perth Town Hall',
          coordinates: { lat: -31.9547, lng: 115.8606 },
          organizer: { name: 'City of Stirling' },
          start_time: '2026-11-28T19:00:00+08:00',
          external_url: 'https://www.stirling.wa.gov.au/events/choir'
        },
        // Step 2a: No raw coords -> exact /venues catalog match
        {
          source: 'stirling',
          source_id: 'step2_exact',
          title: 'Town Hall Yoga',
          category: 'health',
          venue_name: 'Perth Town Hall',
          organizer: { name: 'City of Stirling' },
          start_time: '2026-11-29T08:00:00+08:00',
          external_url: 'https://www.stirling.wa.gov.au/events/yoga'
        },
        // Step 2b: No raw coords -> uncertain /venues catalog match
        {
          source: 'stirling',
          source_id: 'step2_uncertain',
          title: 'Subiaco Swim Club',
          category: 'sports',
          venue_name: 'Lords Recreation Centre',
          organizer: { name: 'City of Stirling' },
          start_time: '2026-11-29T09:00:00+08:00',
          external_url: 'https://www.stirling.wa.gov.au/events/swim'
        },
        // Step 3: No raw coords, no /venues match -> suburb/postcode centroid fallback
        {
          source: 'stirling',
          source_id: 'step3_suburb',
          title: 'Pottery Class',
          category: 'hobbies',
          venue_name: 'Unknown Community Studio',
          address: '100 Rokeby Rd, 6008',
          organizer: { name: 'City of Stirling' },
          start_time: '2026-11-30T10:00:00+08:00',
          external_url: 'https://www.stirling.wa.gov.au/events/pottery'
        },
        // Step 4: No raw coords, no /venues match, no suburb match -> supplied LGA fallbackCentroid
        {
          source: 'stirling',
          source_id: 'step4_lga',
          title: 'Council Craft Morning',
          category: 'community',
          venue_name: 'Secret Annex Room',
          organizer: { name: 'City of Stirling' },
          start_time: '2026-12-01T10:00:00+08:00',
          external_url: 'https://www.stirling.wa.gov.au/events/craft'
        }
      ];
    }
  };

  const summary = await runCrawlerHarness({
    crawlers: [crawler],
    adapter,
    options: { skipUrlVerification: true }
  });

  assert.equal(summary.successfulCrawlers, 1);
  assert.equal(summary.totalValid, 5);
  assert.equal(summary.totalInvalid, 0);
  assert.equal(summary.totalUpserted, 5);

  const step1 = store.activities.get('stirling_step1_explicit');
  assert.equal(step1.venue.id, 'venue_perth_town_hall_qd66hx');
  assert.equal(step1.venue.google_place_id, 'ChIJPTH');
  assert.equal(step1.needs_review, false);
  assert.equal(step1.review_reason, null);

  const step2Exact = store.activities.get('stirling_step2_exact');
  assert.equal(step2Exact.venue.id, 'venue_perth_town_hall_qd66hx');
  assert.equal(step2Exact.venue.google_place_id, 'ChIJPTH');
  assert.deepEqual(step2Exact.venue.coordinates, { lat: -31.9547, lng: 115.8606 });
  assert.equal(step2Exact.venue.geohash, 'qd66hx999');
  assert.equal(step2Exact.needs_review, false);
  assert.equal(step2Exact.review_reason, null);

  const step2Uncertain = store.activities.get('stirling_step2_uncertain');
  assert.equal(step2Uncertain.venue.id, 'venue_lords_subiaco');
  assert.equal(step2Uncertain.venue.google_place_id, 'ChIJ_lords');
  assert.equal(step2Uncertain.needs_review, true);
  assert.equal(step2Uncertain.review_reason, 'uncertain_venue_match');

  const step3 = store.activities.get('stirling_step3_suburb');
  assert.equal(step3.venue.id, null);
  assert.deepEqual(step3.venue.coordinates, { lat: -31.9463, lng: 115.8236 });
  assert.equal(step3.venue.geohash.length, 9);
  assert.equal(step3.needs_review, true);
  assert.equal(step3.review_reason, 'unmatched_venue');

  const step4 = store.activities.get('stirling_step4_lga');
  assert.equal(step4.venue.id, null);
  assert.deepEqual(step4.venue.coordinates, lgaCentroid);
  assert.equal(step4.venue.geohash.length, 9);
  assert.equal(step4.needs_review, true);
  assert.equal(step4.review_reason, 'unmatched_venue');

  // Step 4 (Organizer centroid without fallbackCentroid) + explicit out-of-region filtering
  const orgOnlyCrawler = {
    name: 'org_fallback',
    async fetchListings() {
      return [
        {
          source: 'org_fallback',
          source_id: 'step4_org',
          title: 'Organizer Fallback Activity',
          category: 'sports',
          venue_name: 'Unlisted Shed',
          organizer: { name: 'City of Stirling' },
          start_time: '2026-12-02T10:00:00+08:00',
          external_url: 'https://www.stirling.wa.gov.au/events/org-fallback'
        },
        {
          source: 'org_fallback',
          source_id: 'sydney_skip',
          title: 'Sydney Activity',
          category: 'sports',
          venue_name: 'Sydney Harbour',
          coordinates: { lat: -33.8688, lng: 151.2093 },
          organizer: { name: 'City of Stirling' },
          start_time: '2026-12-02T10:00:00+08:00',
          external_url: 'https://www.stirling.wa.gov.au/events/sydney'
        }
      ];
    }
  };

  const orgSummary = await runCrawlerHarness({
    crawlers: [orgOnlyCrawler],
    adapter,
    options: { skipUrlVerification: true }
  });
  assert.equal(orgSummary.successfulCrawlers, 1);
  assert.equal(orgSummary.totalValid, 1);
  assert.equal(orgSummary.totalInvalid, 0);
  const step4Org = store.activities.get('org_fallback_step4_org');
  assert.equal(step4Org.venue.id, null);
  assert.deepEqual(step4Org.venue.coordinates, { lat: -31.8942, lng: 115.7571 });
  assert.equal(step4Org.needs_review, true);
  assert.equal(step4Org.review_reason, 'unmatched_venue');
  assert.equal(store.activities.has('org_fallback_sydney_skip'), false);
});

test('Issue #37: --crawler=councils runs all council-grouped crawlers and is selectable in crawler-harness.yml', async () => {
  const ran = [];
  const makeStub = (name, group) => ({
    name,
    ...(group ? { group } : {}),
    async fetchListings() {
      ran.push(name);
      return [{
        source: name,
        source_id: `${name}_1`,
        title: `${name} Activity`,
        category: 'community',
        venue_name: 'Perth Town Hall',
        coordinates: { lat: -31.9547, lng: 115.8606 },
        start_time: '2026-12-01T10:00:00+08:00',
        external_url: 'https://example.org/activity'
      }];
    }
  });

  const summary = await main(
    ['--dry-run', '--crawler=councils'],
    {},
    {
      crawlers: [
        makeStub('stirling', 'councils'),
        makeStub('vincent', 'councils'),
        makeStub('meetup')
      ],
      exitOnFailure: false,
      firestoreEnv: { db: null, dryRun: true, projectId: null },
      logger: { log: () => {}, warn: () => {}, error: () => {} }
    }
  );

  assert.deepEqual(ran, ['stirling', 'vincent']);
  assert.equal(summary.totalCrawlers, 2);
  assert.equal(summary.successfulCrawlers, 2);

  const defaultStirling = getDefaultCrawlers().find(c => c.name === 'stirling');
  assert.equal(defaultStirling?.group, 'councils');

  const workflowYaml = readFileSync(resolve(process.cwd(), '.github/workflows/crawler-harness.yml'), 'utf8');
  assert.match(workflowYaml, /^\s*-\s*councils\s*$/m);
  assert.match(workflowYaml, /^\s*-\s*vincent\s*$/m);
});

test('--crawler=local-councils runs only localOnly council crawlers and --crawler=cockburn auto-includes cockburn', async () => {
  const ran = [];
  const makeStub = (name, group, localOnly = false) => ({
    name,
    ...(group ? { group } : {}),
    ...(localOnly ? { localOnly: true } : {}),
    async fetchListings() {
      ran.push(name);
      return [{
        source: name,
        source_id: `${name}_1`,
        title: `${name} Activity`,
        category: 'community',
        venue_name: 'Cockburn ARC',
        coordinates: { lat: -32.1278, lng: 115.8569 },
        start_time: '2026-12-01T10:00:00+08:00',
        external_url: 'https://example.org/activity'
      }];
    }
  });

  const summary = await main(
    ['--dry-run', '--crawler=local-councils'],
    {},
    {
      crawlers: [
        makeStub('stirling', 'councils', false),
        makeStub('visit_perth', 'councils', true),
        makeStub('cockburn', 'councils', true),
        makeStub('eventbrite', undefined, true)
      ],
      exitOnFailure: false,
      firestoreEnv: { db: null, dryRun: true, projectId: null },
      logger: { log: () => {}, warn: () => {}, error: () => {} }
    }
  );

  assert.deepEqual(ran, ['visit_perth', 'cockburn']);
  assert.equal(summary.totalCrawlers, 2);
  assert.equal(summary.successfulCrawlers, 2);

  const cockburnIncluded = getDefaultCrawlers({ includeLocal: true }).filter(c => c.group === 'councils' && c.localOnly).map(c => c.name);
  assert.deepEqual(cockburnIncluded, ['visit_perth', 'cockburn']);
});


