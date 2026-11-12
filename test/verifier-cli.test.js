import test from 'node:test';
import assert from 'node:assert/strict';
import { runVerifier } from '../src/verifier-cli.js';

test('Seam 2: runVerifier scans, recovers URLs, probes reachable/unreachable links, and updates Firestore', async () => {
  const initialActivities = [
    {
      id: 'act_repaired',
      title: 'Repaired Volleyball',
      verified: false,
      source_url: null,
      raw_source_url: 'http://stirling.wa.gov.au/volleyball' // http will be upgraded to https and resolved
    },
    {
      id: 'act_unreachable',
      title: 'Unreachable Tennis Session',
      verified: false,
      source_url: 'https://deadlink.com.au/404',
      raw_source_url: 'https://deadlink.com.au/404'
    },
    {
      id: 'act_no_link',
      title: 'No Link Activity',
      verified: true,
      source_url: null,
      raw_source_url: null
    },
    {
      id: 'act_unchanged',
      title: 'Already Verified Healthy Activity',
      verified: true,
      source_url: 'https://healthy.com/session',
      raw_source_url: 'https://healthy.com/session'
    }
  ];

  const scannedCalls = [];
  const updateCalls = [];

  const mockAdapter = {
    isDryRun: () => false,
    async scanActivities(options) {
      scannedCalls.push(options);
      return initialActivities.map(a => ({ ...a }));
    },
    async batchUpdateActivityUrls(updates) {
      updateCalls.push(updates);
      return { total: updates.length, updated: updates.length, failed: 0, dryRun: false };
    }
  };

  const probedUrls = [];
  const mockProber = {
    async probeAll(urls) {
      probedUrls.push(...urls);
      return urls.map(url => {
        if (url.includes('stirling.wa.gov.au')) {
          return {
            reachable: true,
            status: 200,
            url: 'https://stirling.wa.gov.au/canonical/volleyball'
          };
        }
        if (url.includes('deadlink.com.au')) {
          return {
            reachable: false,
            status: 404,
            url: null,
            error: 'HTTP 404'
          };
        }
        return {
          reachable: true,
          status: 200,
          url
        };
      });
    }
  };

  const summary = await runVerifier({
    adapter: mockAdapter,
    prober: mockProber,
    options: {
      force: false,
      dryRun: false
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });

  // 1. Scanned all 4 activities
  assert.equal(summary.scannedCount, 4);

  // 2. Already verified healthy activity was skipped because force=false
  assert.equal(summary.skippedCount, 1);
  assert.equal(probedUrls.includes('https://healthy.com/session'), false);

  // 3. act_repaired was recovered and probed
  assert.equal(probedUrls.includes('https://stirling.wa.gov.au/volleyball'), true);
  assert.equal(summary.repairedCount, 1);

  // 4. act_unreachable was probed, failed, and degraded
  assert.equal(probedUrls.includes('https://deadlink.com.au/404'), true);
  assert.equal(summary.unverifiedCount, 2); // act_unreachable + act_no_link

  // 5. Check what was sent to batchUpdateActivityUrls
  assert.equal(updateCalls.length, 1);
  const updates = updateCalls[0];
  // act_repaired, act_unreachable, act_no_link were changed
  assert.equal(updates.length, 3);

  const repairedUpdate = updates.find(u => u.id === 'act_repaired');
  assert.equal(repairedUpdate.verified, true);
  assert.equal(repairedUpdate.source_url, 'https://stirling.wa.gov.au/canonical/volleyball');
  assert.equal(repairedUpdate.raw_source_url, 'http://stirling.wa.gov.au/volleyball');

  const deadUpdate = updates.find(u => u.id === 'act_unreachable');
  assert.equal(deadUpdate.verified, false);
  assert.equal(deadUpdate.source_url, null);
  assert.equal(deadUpdate.raw_source_url, 'https://deadlink.com.au/404');

  const noLinkUpdate = updates.find(u => u.id === 'act_no_link');
  assert.equal(noLinkUpdate.verified, false);
  assert.equal(noLinkUpdate.source_url, null);
});

test('Seam 2: runVerifier respects --dry-run without committing updates', async () => {
  const initialActivities = [
    {
      id: 'act_1',
      title: 'Bad Link',
      verified: true,
      source_url: 'https://bad.com',
      raw_source_url: 'https://bad.com'
    }
  ];

  let wroteToFirestore = false;
  const mockAdapter = {
    isDryRun: () => true,
    async scanActivities() {
      return [...initialActivities];
    },
    async batchUpdateActivityUrls() {
      wroteToFirestore = true;
      return { total: 1, updated: 1, failed: 0, dryRun: true };
    }
  };

  const mockProber = {
    async probeAll() {
      return [{ reachable: false, status: 500, url: null }];
    }
  };

  const summary = await runVerifier({
    adapter: mockAdapter,
    prober: mockProber,
    options: { dryRun: true, force: true },
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });

  assert.equal(summary.scannedCount, 1);
  assert.equal(summary.unverifiedCount, 1);
  assert.equal(summary.dryRun, true);
  assert.equal(wroteToFirestore, false);
});

test('Seam 2: runVerifier with --force re-probes even already verified listings and degrades unreachable ones', async () => {
  const initialActivities = [
    {
      id: 'act_1',
      title: 'Previously Verified Unreachable Listing',
      verified: true,
      source_url: 'https://example.com/unreachable',
      raw_source_url: 'https://example.com/unreachable'
    }
  ];

  const probedUrls = [];
  const updateCalls = [];
  const mockAdapter = {
    isDryRun: () => false,
    async scanActivities() {
      return [...initialActivities];
    },
    async batchUpdateActivityUrls(updates) {
      updateCalls.push(updates);
      return { total: updates.length, updated: updates.length, failed: 0, dryRun: false };
    }
  };

  const mockProber = {
    async probeAll(urls) {
      probedUrls.push(...urls);
      return urls.map(() => ({ reachable: false, status: 404, url: null }));
    }
  };

  const summary = await runVerifier({
    adapter: mockAdapter,
    prober: mockProber,
    options: { force: true, dryRun: false },
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });

  assert.equal(summary.scannedCount, 1);
  assert.equal(summary.skippedCount, 0);
  assert.equal(probedUrls.length, 1);
  assert.equal(probedUrls[0], 'https://example.com/unreachable');
  assert.equal(summary.unverifiedCount, 1);
  assert.equal(summary.updatedCount, 1);
  assert.equal(updateCalls[0][0].verified, false);
  assert.equal(updateCalls[0][0].source_url, null);
  assert.equal(updateCalls[0][0].raw_source_url, 'https://example.com/unreachable');
});

test('Seam 2: runVerifier with --only-unverified passes filter flag to scanActivities', async () => {
  let scanOptionsPassed = null;
  const mockAdapter = {
    isDryRun: () => false,
    async scanActivities(opts) {
      scanOptionsPassed = opts;
      return [];
    },
    async batchUpdateActivityUrls() {
      return { total: 0, updated: 0, failed: 0, dryRun: false };
    }
  };

  const summary = await runVerifier({
    adapter: mockAdapter,
    options: { onlyUnverified: true, dryRun: false },
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });

  assert.equal(scanOptionsPassed?.onlyUnverified, true);
  assert.equal(summary.scannedCount, 0);
});

test('Seam 3: parseCliArgs parses flags correctly', async () => {
  const { parseCliArgs } = await import('../src/verifier-cli.js');

  const args1 = parseCliArgs(['--dry-run', '--only-unverified', '--force', '--project=test-proj', '--use-adc']);
  assert.equal(args1.dryRun, true);
  assert.equal(args1.onlyUnverified, true);
  assert.equal(args1.force, true);
  assert.equal(args1.project, 'test-proj');
  assert.equal(args1.useAdc, true);

  const args2 = parseCliArgs([]);
  assert.equal(args2.dryRun, false);
  assert.equal(args2.onlyUnverified, false);
  assert.equal(args2.force, false);
  assert.equal(args2.useAdc, false);
});

test('Seam 3: main runs end-to-end in dry-run mode and formats summary table', async () => {
  const { main } = await import('../src/verifier-cli.js');

  const logs = [];
  const customLogger = {
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' '))
  };

  const summary = await main(['--dry-run'], {}, { logger: customLogger });

  assert.equal(summary.dryRun, true);
  assert.equal(typeof summary.scannedCount, 'number');
  assert.equal(logs.some(l => l.includes('URL Verification Summary Report')), true);
  assert.equal(logs.some(l => l.includes('DRY-RUN mode')), true);
});

test('Seam 3: package.json registers verify-urls npm script pointing to src/verifier-cli.js', async () => {
  const fs = await import('node:fs/promises');
  const pkgContent = await fs.readFile(new URL('../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(pkgContent);

  assert.ok(pkg.scripts['verify-urls'], 'verify-urls script should exist in package.json');
  assert.equal(pkg.scripts['verify-urls'], 'node src/verifier-cli.js');
});

test('Seam 2: runVerifier preserves distinct existing raw_source_url when degraded or repaired', async () => {
  const initialActivities = [
    {
      id: 'act_preserve_degraded',
      title: 'Listing with original raw url',
      verified: true,
      source_url: 'https://bad.org/event',
      raw_source_url: 'https://original-raw.org/flyer.pdf'
    },
    {
      id: 'act_preserve_repaired',
      title: 'Listing to repair',
      verified: false,
      source_url: null,
      raw_source_url: 'http://stirling.wa.gov.au/tennis'
    }
  ];

  const updateCalls = [];
  const mockAdapter = {
    isDryRun: () => false,
    async scanActivities() {
      return initialActivities.map(a => ({ ...a }));
    },
    async batchUpdateActivityUrls(updates) {
      updateCalls.push(updates);
      return { total: updates.length, updated: updates.length, failed: 0, dryRun: false };
    }
  };

  const mockProber = {
    async probeAll(urls) {
      return urls.map(url => {
        if (url.includes('stirling.wa.gov.au')) {
          return { reachable: true, status: 200, url: 'https://stirling.wa.gov.au/canonical/tennis' };
        }
        return { reachable: false, status: 404, url: null };
      });
    }
  };

  await runVerifier({
    adapter: mockAdapter,
    prober: mockProber,
    options: { force: true, dryRun: false },
    logger: { log: () => {} }
  });

  const updates = updateCalls[0];
  const degraded = updates.find(u => u.id === 'act_preserve_degraded');
  assert.equal(degraded.verified, false);
  assert.equal(degraded.source_url, null);
  assert.equal(degraded.raw_source_url, 'https://original-raw.org/flyer.pdf');

  const repaired = updates.find(u => u.id === 'act_preserve_repaired');
  assert.equal(repaired.verified, true);
  assert.equal(repaired.source_url, 'https://stirling.wa.gov.au/canonical/tennis');
  assert.equal(repaired.raw_source_url, 'http://stirling.wa.gov.au/tennis');
});

test('Seam 2: runVerifier detects and updates legacy external_url documents in Firestore', async () => {
  const initialActivities = [
    {
      id: 'legacy_stirling_1',
      title: 'Legacy Stirling Farmers Market',
      external_url: 'https://stirling.wa.gov.au/market'
    }
  ];

  const updateCalls = [];
  const mockAdapter = {
    isDryRun: () => false,
    async scanActivities() {
      return initialActivities.map(a => ({ ...a }));
    },
    async batchUpdateActivityUrls(updates) {
      updateCalls.push(updates);
      return { total: updates.length, updated: updates.length, failed: 0, dryRun: false };
    }
  };

  const mockProber = {
    async probeAll(urls) {
      return urls.map(url => ({ reachable: true, status: 200, url }));
    }
  };

  const summary = await runVerifier({
    adapter: mockAdapter,
    prober: mockProber,
    options: { force: false, dryRun: false },
    logger: { log: () => {} }
  });

  assert.equal(summary.scannedCount, 1);
  assert.equal(summary.verifiedCount, 1);
  assert.equal(summary.updatedCount, 1);
  assert.equal(updateCalls[0][0].verified, true);
  assert.equal(updateCalls[0][0].source_url, 'https://stirling.wa.gov.au/market');
  assert.equal(updateCalls[0][0].raw_source_url, 'https://stirling.wa.gov.au/market');
});




