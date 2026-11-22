/**
 * Crawler Harness Runner
 * Discovers crawlers, executes them with error isolation, sanitizes extracted listings,
 * and writes idempotent batches to Cloud Firestore.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeListing, resolveListingType, extractCanonicalEntities, hasExplicitOrganizerName } from './sanitizer.js';
import { reconcileListingWithCatalog } from './entity-matcher.js';
import { applyVenueResolution, resolveActivityVenueAndCoordinates } from './venue-resolver.js';
import { createFirestoreAdapter, initFirestoreFromEnv } from './firestore-adapter.js';
import { createUrlVerifier } from './url-verifier.js';
import { createStirlingCrawler } from './crawlers/stirling-crawler.js';
import { createVisitPerthCrawler } from './crawlers/visit-perth-crawler.js';
import { createVincentCrawler } from './crawlers/vincent-crawler.js';
import { createWannerooCrawler } from './crawlers/wanneroo-crawler.js';
import { createGosnellsCrawler } from './crawlers/gosnells-crawler.js';
import { createCambridgeCrawler } from './crawlers/cambridge-crawler.js';
import { createVictoriaParkCrawler } from './crawlers/victoria-park-crawler.js';
import { createDlgscCrawler } from './crawlers/dlgsc-crawler.js';
import { createVolleyballWaCrawler } from './crawlers/volleyball-wa-crawler.js';
import { createEventbriteCrawler } from './crawlers/eventbrite-crawler.js';
import { createMeetupCrawler } from './crawlers/meetup-crawler.js';
import {
  createFileLogger,
  DEFAULT_LOG_DIR,
  formatStepSummaryTable,
  resolveCliLogger,
  writeStepSummary
} from './crawler-reporter.js';
import { loadDotEnv } from './places-sync.js';

export {
  createFileLogger,
  DEFAULT_LOG_DIR,
  formatStepSummaryTable,
  resolveCliLogger,
  writeStepSummary
};

export const DEFAULT_CRAWLER_LOG_PATH = resolve(DEFAULT_LOG_DIR, 'crawler-runner.log');

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

  const urlVerifier = options.urlVerifier || createUrlVerifier({
    adapter,
    ...options.urlVerifierOptions
  });

  const normalizedTarget = targetCrawler.toLowerCase();
  const activeCrawlers = normalizedTarget === 'all'
    ? crawlers
    : crawlers.filter(c =>
        c.name.toLowerCase() === normalizedTarget ||
        (typeof c.group === 'string' && c.group.toLowerCase() === normalizedTarget)
      );

  const venuesCatalog = Array.isArray(options.existingVenues)
    ? options.existingVenues
    : (typeof adapter?.scanVenues === 'function' ? await adapter.scanVenues() : []);
  const organizersCatalog = Array.isArray(options.existingOrganizers)
    ? options.existingOrganizers
    : (typeof adapter?.scanOrganizers === 'function' ? await adapter.scanOrganizers() : []);

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

      const validEntries = [];
      for (const item of rawItems) {
        try {
          const listingType = resolveListingType(item);
          if (listingType === 'venue') {
            continue;
          }
          let resolvedVenue = null;
          let itemForSanitization = item;
          if (listingType === 'activity') {
            resolvedVenue = resolveActivityVenueAndCoordinates(item, {
              venuesCatalog,
              organizersCatalog,
              fallbackCentroid: item.fallbackCentroid || item.fallback_centroid || crawler.fallbackCentroid || options.fallbackCentroid || null
            });
            if (resolvedVenue.outOfArea && resolvedVenue.outOfRegionReason === 'explicit_out_of_region') {
              continue;
            }
            if (!resolvedVenue.outOfArea) {
              itemForSanitization = {
                ...item,
                coordinates: resolvedVenue.coordinates,
                geohash: resolvedVenue.geohash,
                ...(resolvedVenue.venueOverride ? { venue_name: resolvedVenue.venueOverride.name } : {})
              };
            }
          }
          const sanitized = sanitizeListing(itemForSanitization);
          validItems.push(sanitized);
          validEntries.push({ raw: item, listingType, resolvedVenue, sanitizedVenue: sanitized.venue });
        } catch (err) {
          invalidItems.push({ item, error: err.message });
        }
      }

      totalValid += validItems.length;
      totalInvalid += invalidItems.length;

      if (validItems.length > 0) {
        const verifiedItems = options.skipUrlVerification
          ? validItems
          : await urlVerifier.verifyListings(validItems);

        const reconciledItems = [];
        for (let idx = 0; idx < verifiedItems.length; idx++) {
          const verifiedItem = verifiedItems[idx];
          const entry = validEntries[idx];
          const reconciled = reconcileListingWithCatalog(
            verifiedItem,
            { venuesCatalog, organizersCatalog },
            entry?.listingType || 'activity'
          );

          if (entry?.listingType === 'activity') {
            applyVenueResolution(reconciled, entry.resolvedVenue, entry.sanitizedVenue);
            const entities = extractCanonicalEntities(reconciled, entry.raw);
            if (!hasExplicitOrganizerName(entry.raw)) {
              entities.organizer = null;
              reconciled.needs_review = true;
              reconciled.review_reason = 'unmatched_organizer';
            } else if (reconciled.review_reason === 'unmatched_organizer' && entities.organizer) {
              entities.organizer.needs_review = true;
              entities.organizer.review_reason = 'crawler_created';
            } else if (reconciled.review_reason === 'uncertain_organizer_match') {
              entities.organizer = null;
            }
            Object.defineProperty(reconciled, '_canonicalEntities', {
              value: entities,
              enumerable: false,
              configurable: true,
              writable: true
            });
          }

          reconciledItems.push(reconciled);
        }

        const writeResult = typeof adapter.batchUpsertListings === 'function'
          ? await adapter.batchUpsertListings(reconciledItems)
          : await adapter.batchUpsertActivities(reconciledItems);
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
 * @param {boolean} [options.includeEventbrite=false]
 * @returns {Array<object>}
 */
export function getDefaultCrawlers(options = {}) {
  const crawlers = [
    createStirlingCrawler(),
    createVisitPerthCrawler(),
    createVincentCrawler(),
    createWannerooCrawler(),
    createGosnellsCrawler(),
    createCambridgeCrawler(),
    createVictoriaParkCrawler(),
    createDlgscCrawler(),
    createVolleyballWaCrawler(),
    createMeetupCrawler()
  ];
  if (options.includeEventbrite) {
    crawlers.push(createEventbriteCrawler());
  }
  return crawlers;
}

/**
 * CLI Entry point
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @param {object} [options={}]
 * @returns {Promise<object>} Summary report
 */
export async function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  if (env === process.env || options.envFilePath) {
    await loadDotEnv(options.envFilePath, env);
  }

  const args = argv;
  const logger = resolveCliLogger('crawler-runner.log', argv, options, env);
  const isDryRunArg = args.includes('--dry-run');
  const crawlerArgMatch = args.find(a => a.startsWith('--crawler='));
  const targetCrawler = crawlerArgMatch ? crawlerArgMatch.split('=')[1] : 'all';
  const projectArgMatch = args.find(a => a.startsWith('--project='));
  const targetProject = projectArgMatch ? projectArgMatch.split('=')[1] : (env.FIREBASE_PROJECT_ID || 'myplaydex');
  const minExpectedArgMatch = args.find(a => a.startsWith('--min-expected=') || a.startsWith('--min-expected-listings='));
  const minExpectedListings = minExpectedArgMatch ? parseInt(minExpectedArgMatch.split('=')[1], 10) : undefined;
  const useAdc = args.includes('--use-adc') || Boolean(env.FIREBASE_USE_ADC);

  logger.log?.(`[Crawler Harness] Initializing run (crawler: ${targetCrawler}, dry-run: ${isDryRunArg}, project: ${targetProject})`);

  // Initialize Firestore from environment credentials (enforce key if live run and not using ADC)
  const firestoreEnv = options.firestoreEnv || (isDryRunArg
    ? { db: null, dryRun: true, projectId: targetProject }
    : await initFirestoreFromEnv(env, {
        requireCredentials: !isDryRunArg && !useAdc,
        useAdc,
        projectId: targetProject
      }));
  const effectiveDryRun = isDryRunArg || firestoreEnv.dryRun;

  const adapter = options.adapter || createFirestoreAdapter({
    db: firestoreEnv.db,
    dryRun: effectiveDryRun
  });

  if (effectiveDryRun) {
    logger.log?.('[Crawler Harness] Running in DRY-RUN mode (no Firestore writes will be committed).');
  } else {
    logger.log?.(`[Crawler Harness] Connected to Firestore project: ${firestoreEnv.projectId}`);
  }

  const includeEventbrite = targetCrawler.toLowerCase() === 'eventbrite' || args.includes('--include-eventbrite');
  const crawlers = options.crawlers || getDefaultCrawlers({ includeEventbrite });

  const summary = await runCrawlerHarness({
    crawlers,
    adapter,
    options: {
      crawler: targetCrawler,
      minExpectedListings,
      logger
    }
  });

  logger.log?.('\n--- Ingestion Summary Report ---');
  logger.log?.(`Total Crawlers: ${summary.totalCrawlers}`);
  logger.log?.(`Successful:     ${summary.successfulCrawlers}`);
  logger.log?.(`Failed:         ${summary.failedCrawlers}`);
  logger.log?.(`Raw Records:    ${summary.totalRaw}`);
  logger.log?.(`Valid Records:  ${summary.totalValid}`);
  logger.log?.(`Invalid Dropped:${summary.totalInvalid}`);
  logger.log?.(`Total Upserted: ${summary.totalUpserted}`);
  logger.log?.('--------------------------------\n');

  if (summary.failedCrawlers > 0) {
    logger.error?.(`[Crawler Harness] Encountered ${summary.failedCrawlers} crawler failure(s).`);
    if (options.exitOnFailure !== false) {
      process.exit(1);
    }
  }

  return summary;
}

// Auto-run if executed as main CLI script
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cliLogger = resolveCliLogger('crawler-runner.log', process.argv.slice(2), {}, process.env);
  main(process.argv.slice(2), process.env, { logger: cliLogger }).catch(err => {
    cliLogger.error('[Crawler Harness Fatal Error]', err);
    process.exit(1);
  });
}
