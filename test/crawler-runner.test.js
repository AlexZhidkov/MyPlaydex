import test from 'node:test';
import assert from 'node:assert/strict';
import { runCrawlerHarness } from '../src/crawler-runner.js';
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
          title: 'Invalid Activity Without Coordinates' // missing coordinates, should be recorded as invalid
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
  assert.equal(summary.totalRaw, 3);
  assert.equal(summary.totalValid, 2);
  assert.equal(summary.totalInvalid, 1);
  assert.equal(summary.totalUpserted, 2);

  // Check crawler results breakdown
  const stirlingResult = summary.results.find(r => r.crawlerName === 'stirling');
  assert.equal(stirlingResult.rawCount, 2);
  assert.equal(stirlingResult.validCount, 1);
  assert.equal(stirlingResult.invalidCount, 1);
  assert.equal(stirlingResult.upsertedCount, 1);
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
