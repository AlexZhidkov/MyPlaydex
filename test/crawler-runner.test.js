import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCrawlerHarness, formatStepSummaryTable, writeStepSummary, getDefaultCrawlers } from '../src/crawler-runner.js';

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

  try {
    // 1. Successful CLI run with mock crawler exits 0
    const successResult = await execFileAsync(
      process.execPath,
      ['src/crawler-runner.js', '--dry-run', '--crawler=mock', '--include-mock'],
      {
        cwd: process.cwd(),
        env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile }
      }
    );
    assert.equal(successResult.stderr, '');

    // 2. Anomaly run with mock crawler (returns 10 items) and min-expected=100 fails with code 1
    let failedErr = null;
    try {
      await execFileAsync(
        process.execPath,
        ['src/crawler-runner.js', '--dry-run', '--crawler=mock', '--include-mock', '--min-expected=100'],
        {
          cwd: process.cwd(),
          env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile }
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
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Seam 7: getDefaultCrawlers registers all 5 canonical crawlers in production suite', () => {
  const crawlers = getDefaultCrawlers();
  const names = crawlers.map(c => c.name);

  assert.ok(names.includes('stirling'), 'stirling should be in default crawlers');
  assert.ok(names.includes('dlgsc'), 'dlgsc should be in default crawlers');
  assert.ok(names.includes('volleyball_wa'), 'volleyball_wa should be in default crawlers');
  assert.ok(names.includes('eventbrite'), 'eventbrite should be in default crawlers');
  assert.ok(names.includes('meetup'), 'meetup should be in default crawlers');
  assert.equal(names.length, 5);
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

