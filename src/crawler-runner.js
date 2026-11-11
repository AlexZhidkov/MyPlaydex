/**
 * Crawler Harness Runner
 * Discovers crawlers, executes them with error isolation, sanitizes extracted listings,
 * and writes idempotent batches to Cloud Firestore.
 */

import { pathToFileURL } from 'node:url';
import { sanitizeActivity } from './sanitizer.js';
import { createFirestoreAdapter, initFirestoreFromEnv } from './firestore-adapter.js';
import { createStirlingCrawler } from './crawlers/stirling-crawler.js';
import { createMockCrawler } from './crawlers/mock-crawler.js';
import { formatStepSummaryTable, writeStepSummary } from './crawler-reporter.js';

export { formatStepSummaryTable, writeStepSummary };

/** Maximum fraction of invalid records allowed before triggering ERR_SCHEMA_DRIFT */
export const MAX_INVALID_DROP_RATE = 0.20;

/**
 * Builds a standardized crawler execution record.
 */
function createResultRecord({
  crawlerName,
  status,
  errorCode = null,
  error = null,
  rawCount = 0,
  validCount = 0,
  invalidCount = 0,
  upsertedCount = 0,
  durationMs = 0
}) {
  return {
    crawlerName,
    status,
    errorCode,
    error,
    rawCount,
    validCount,
    invalidCount,
    upsertedCount,
    durationMs
  };
}

/**
 * Executes a suite of crawlers through the sanitization and ingestion pipeline.
 *
 * @param {object} params
 * @param {Array<object>} [params.crawlers] - Array of crawler instances
 * @param {object} params.adapter - Firestore adapter instance
 * @param {object} [params.options] - Runner configuration options
 * @param {string} [params.options.crawler='all'] - Filter to specific crawler name
 * @param {number} [params.options.limit] - Optional max listings per crawler
 * @param {object} [params.options.logger=console] - Logger interface
 * @returns {Promise<object>} Summary report of the crawl execution
 */
export async function runCrawlerHarness({ crawlers = [], adapter, options = {} }) {
  const targetCrawler = options.crawler || 'all';
  const limit = options.limit;
  const logger = options.logger || console;

  const activeCrawlers = targetCrawler === 'all'
    ? crawlers
    : crawlers.filter(c => c.name.toLowerCase() === targetCrawler.toLowerCase());

  const results = [];
  let totalRaw = 0;
  let totalValid = 0;
  let totalInvalid = 0;
  let totalUpserted = 0;
  let successfulCrawlers = 0;
  let failedCrawlers = 0;

  for (const crawler of activeCrawlers) {
    const startTime = Date.now();
    let rawItems = [];
    let validItems = [];
    let invalidItems = [];
    let upsertedCount = 0;

    try {
      logger.log?.(`[Harness] Starting crawler: ${crawler.name}`);
      rawItems = await crawler.fetchListings();

      if (limit && limit > 0) {
        rawItems = rawItems.slice(0, limit);
      }

      totalRaw += rawItems.length;

      const minExpectedListings = typeof crawler.minExpectedListings === 'number'
        ? crawler.minExpectedListings
        : (typeof options.minExpectedListings === 'number' ? options.minExpectedListings : 1);

      if (rawItems.length < minExpectedListings) {
        const durationMs = Date.now() - startTime;
        failedCrawlers += 1;
        results.push(createResultRecord({
          crawlerName: crawler.name,
          status: 'failed',
          errorCode: 'ERR_ZERO_YIELD',
          error: 'ERR_ZERO_YIELD',
          rawCount: rawItems.length,
          validCount: 0,
          invalidCount: 0,
          upsertedCount: 0,
          durationMs
        }));
        logger.error?.(`[Harness] Crawler ${crawler.name} failed with ERR_ZERO_YIELD: returned ${rawItems.length} items (expected at least ${minExpectedListings})`);
        continue;
      }

      for (const item of rawItems) {
        try {
          const sanitized = sanitizeActivity(item);
          validItems.push(sanitized);
        } catch (err) {
          invalidItems.push({ item, error: err.message });
        }
      }

      totalValid += validItems.length;
      totalInvalid += invalidItems.length;

      if (validItems.length > 0) {
        const writeResult = await adapter.batchUpsertActivities(validItems);
        upsertedCount = writeResult.upserted;
        totalUpserted += upsertedCount;
      }

      const durationMs = Date.now() - startTime;
      const isSchemaDrift = rawItems.length > 0 && (invalidItems.length / rawItems.length) > MAX_INVALID_DROP_RATE;

      if (isSchemaDrift) {
        failedCrawlers += 1;
        results.push(createResultRecord({
          crawlerName: crawler.name,
          status: 'failed',
          errorCode: 'ERR_SCHEMA_DRIFT',
          error: 'ERR_SCHEMA_DRIFT',
          rawCount: rawItems.length,
          validCount: validItems.length,
          invalidCount: invalidItems.length,
          upsertedCount,
          durationMs
        }));
        logger.error?.(`[Harness] Crawler ${crawler.name} breached anomaly gate ERR_SCHEMA_DRIFT: drop rate ${((invalidItems.length / rawItems.length) * 100).toFixed(1)}% exceeds ${(MAX_INVALID_DROP_RATE * 100).toFixed(0)}% threshold`);
      } else {
        successfulCrawlers += 1;
        results.push(createResultRecord({
          crawlerName: crawler.name,
          status: 'ok',
          errorCode: null,
          error: null,
          rawCount: rawItems.length,
          validCount: validItems.length,
          invalidCount: invalidItems.length,
          upsertedCount,
          durationMs
        }));
        logger.log?.(`[Harness] Finished ${crawler.name}: ${validItems.length} valid / ${rawItems.length} raw (${durationMs}ms)`);
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      failedCrawlers += 1;
      logger.error?.(`[Harness] Crawler ${crawler.name} failed:`, err);

      results.push(createResultRecord({
        crawlerName: crawler.name,
        status: 'failed',
        errorCode: err.code || 'ERR_EXECUTION_FAILED',
        error: err.message,
        rawCount: rawItems.length,
        validCount: validItems.length,
        invalidCount: invalidItems.length,
        upsertedCount,
        durationMs
      }));
    }
  }

  const summary = {
    totalCrawlers: activeCrawlers.length,
    successfulCrawlers,
    failedCrawlers,
    totalRaw,
    totalValid,
    totalInvalid,
    totalUpserted,
    results
  };

  const stepSummaryFile = options.stepSummaryFile !== undefined
    ? options.stepSummaryFile
    : process.env.GITHUB_STEP_SUMMARY;

  if (stepSummaryFile) {
    writeStepSummary(summary, stepSummaryFile);
  }

  return summary;
}

/**
 * Returns default registered crawlers for production execution.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeMock=false]
 * @returns {Array<object>}
 */
export function getDefaultCrawlers(options = {}) {
  const crawlers = [
    createStirlingCrawler()
  ];
  if (options.includeMock) {
    crawlers.push(createMockCrawler());
  }
  return crawlers;
}

/**
 * CLI Entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const isDryRunArg = args.includes('--dry-run');
  const isSeed = args.includes('--seed');
  const crawlerArgMatch = args.find(a => a.startsWith('--crawler='));
  const targetCrawler = crawlerArgMatch ? crawlerArgMatch.split('=')[1] : 'all';
  const projectArgMatch = args.find(a => a.startsWith('--project='));
  const targetProject = projectArgMatch ? projectArgMatch.split('=')[1] : (process.env.FIREBASE_PROJECT_ID || 'myplaydex');
  const minExpectedArgMatch = args.find(a => a.startsWith('--min-expected=') || a.startsWith('--min-expected-listings='));
  const minExpectedListings = minExpectedArgMatch ? parseInt(minExpectedArgMatch.split('=')[1], 10) : undefined;
  const useAdc = args.includes('--use-adc') || isSeed || Boolean(process.env.FIREBASE_USE_ADC);

  console.log(`[Crawler Harness] Initializing run (crawler: ${targetCrawler}, dry-run: ${isDryRunArg}, seed: ${isSeed}, project: ${targetProject})`);

  // Initialize Firestore from environment credentials (enforce key if live run and not using ADC)
  const firestoreEnv = await initFirestoreFromEnv(process.env, {
    requireCredentials: !isDryRunArg && !useAdc,
    useAdc,
    projectId: targetProject
  });
  const effectiveDryRun = isDryRunArg || firestoreEnv.dryRun;

  const adapter = createFirestoreAdapter({
    db: firestoreEnv.db,
    dryRun: effectiveDryRun
  });

  if (effectiveDryRun) {
    console.log('[Crawler Harness] Running in DRY-RUN mode (no Firestore writes will be committed).');
  } else {
    console.log(`[Crawler Harness] Connected to Firestore project: ${firestoreEnv.projectId}`);
  }

  const includeMock = targetCrawler === 'mock' || isSeed || args.includes('--include-mock');
  const crawlers = getDefaultCrawlers({ includeMock });

  const summary = await runCrawlerHarness({
    crawlers,
    adapter,
    options: {
      crawler: targetCrawler,
      minExpectedListings
    }
  });

  console.log('\n--- Ingestion Summary Report ---');
  console.log(`Total Crawlers: ${summary.totalCrawlers}`);
  console.log(`Successful:     ${summary.successfulCrawlers}`);
  console.log(`Failed:         ${summary.failedCrawlers}`);
  console.log(`Raw Records:    ${summary.totalRaw}`);
  console.log(`Valid Records:  ${summary.totalValid}`);
  console.log(`Invalid Dropped:${summary.totalInvalid}`);
  console.log(`Total Upserted: ${summary.totalUpserted}`);
  console.log('--------------------------------\n');

  if (summary.failedCrawlers > 0) {
    console.error(`[Crawler Harness] Encountered ${summary.failedCrawlers} crawler failure(s).`);
    process.exit(1);
  }
}

// Auto-run if executed as main CLI script
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[Crawler Harness Fatal Error]', err);
    process.exit(1);
  });
}
