/**
 * Standalone CLI Verifier for existing Firestore Listings (ADR 0003).
 * Scans existing /activities records, executes link recovery and bounded
 * HTTP probing, and batch-updates canonical source URLs or Unverified Listing states.
 */

import { pathToFileURL } from 'node:url';
import { createUrlVerifier } from './url-verifier.js';
import { createFirestoreAdapter, initFirestoreFromEnv } from './firestore-adapter.js';

/**
 * Runs the standalone verifier pipeline against an activities collection.
 *
 * @param {object} params
 * @param {object} params.adapter - Firestore adapter instance
 * @param {object} [params.options={}] - Execution options
 * @param {boolean} [params.options.dryRun=false] - If true, do not commit writes to Firestore
 * @param {boolean} [params.options.onlyUnverified=false] - Only scan unverified listings
 * @param {boolean} [params.options.force=false] - Re-check already verified listings
 * @param {object} [params.prober] - Custom URL prober
 * @param {object} [params.logger=console] - Logger
 * @returns {Promise<object>} Summary report
 */
export async function runVerifier({
  adapter,
  options = {},
  prober,
  logger = console
} = {}) {
  const isDryRun = Boolean(options.dryRun || adapter?.isDryRun?.());
  const force = Boolean(options.force);
  const onlyUnverified = Boolean(options.onlyUnverified);

  logger.log?.(`[Verifier] Scanning /activities collection (onlyUnverified: ${onlyUnverified}, force: ${force}, dryRun: ${isDryRun})...`);

  const activities = await adapter.scanActivities({ onlyUnverified });
  const scannedCount = activities.length;

  const originalSnapshots = new Map(
    activities.map(a => [a.id, {
      verified: a.verified,
      source_url: a.source_url,
      raw_source_url: a.raw_source_url
    }])
  );

  const urlVerifier = createUrlVerifier({
    adapter,
    prober,
    force,
    existingDocsMap: originalSnapshots,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs
  });

  const verifiedActivities = await urlVerifier.verifyListings(activities);

  let skippedCount = 0;
  let repairedCount = 0;
  let unverifiedCount = 0;
  let verifiedCount = 0;
  const updatesToCommit = [];

  for (const item of verifiedActivities) {
    const orig = originalSnapshots.get(item.id) || {};
    const candidateUrl = item.source_url || item.raw_source_url;

    if (item.verified === true) {
      verifiedCount++;
      if (!force && orig.verified === true && (orig.source_url === item.source_url || orig.raw_source_url === candidateUrl)) {
        skippedCount++;
      }
      const wasRepaired = (orig.verified !== true) || (orig.source_url !== item.source_url);
      if (wasRepaired) {
        repairedCount++;
      }
    } else {
      unverifiedCount++;
    }

    const hasChanged = (item.verified !== orig.verified) ||
      (item.source_url !== orig.source_url) ||
      (item.raw_source_url !== orig.raw_source_url);

    if (hasChanged) {
      updatesToCommit.push({
        id: item.id,
        verified: item.verified,
        source_url: item.source_url,
        raw_source_url: item.raw_source_url
      });
    }
  }

  let updatedCount = updatesToCommit.length;

  if (!isDryRun && updatesToCommit.length > 0) {
    logger.log?.(`[Verifier] Committing ${updatesToCommit.length} updates to Firestore in batches...`);
    const updateResult = await adapter.batchUpdateActivityUrls(updatesToCommit);
    updatedCount = updateResult.updated;
  }

  return {
    scannedCount,
    verifiedCount,
    repairedCount,
    unverifiedCount,
    updatedCount,
    skippedCount,
    dryRun: isDryRun
  };
}

/**
 * Parses CLI arguments.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @returns {object}
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  const isDryRun = argv.includes('--dry-run');
  const onlyUnverified = argv.includes('--only-unverified');
  const force = argv.includes('--force');
  const useAdc = argv.includes('--use-adc') || Boolean(process.env.FIREBASE_USE_ADC);

  const projectArgMatch = argv.find(a => a.startsWith('--project='));
  const project = projectArgMatch ? projectArgMatch.split('=')[1] : (process.env.FIREBASE_PROJECT_ID || 'myplaydex');

  const concurrencyArgMatch = argv.find(a => a.startsWith('--concurrency='));
  const concurrency = concurrencyArgMatch ? parseInt(concurrencyArgMatch.split('=')[1], 10) : undefined;

  const timeoutArgMatch = argv.find(a => a.startsWith('--timeout='));
  const timeoutMs = timeoutArgMatch ? parseInt(timeoutArgMatch.split('=')[1], 10) : undefined;

  return {
    dryRun: isDryRun,
    onlyUnverified,
    force,
    useAdc,
    project,
    concurrency,
    timeoutMs
  };
}

/**
 * Main entry point for the standalone URL verifier CLI.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @param {object} [options={}]
 * @returns {Promise<object>} Summary report
 */
export async function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  const parsedArgs = parseCliArgs(argv);
  const logger = options.logger || console;

  const isDryRunArg = parsedArgs.dryRun;
  const targetProject = parsedArgs.project;
  const useAdc = parsedArgs.useAdc;

  logger.log?.(`[URL Verifier CLI] Initializing verifier (project: ${targetProject}, dry-run: ${isDryRunArg}, only-unverified: ${parsedArgs.onlyUnverified}, force: ${parsedArgs.force})`);

  const firestoreEnv = options.firestoreEnv || await initFirestoreFromEnv(env, {
    requireCredentials: !isDryRunArg && !useAdc,
    useAdc,
    projectId: targetProject
  });

  const effectiveDryRun = isDryRunArg || firestoreEnv.dryRun;

  const adapter = options.adapter || createFirestoreAdapter({
    db: firestoreEnv.db,
    dryRun: effectiveDryRun
  });

  if (effectiveDryRun) {
    logger.log?.('[URL Verifier CLI] Running in DRY-RUN mode (no Firestore writes will be committed).');
  } else {
    logger.log?.(`[URL Verifier CLI] Connected to Firestore project: ${firestoreEnv.projectId}`);
  }

  const summary = await runVerifier({
    adapter,
    prober: options.prober,
    options: {
      dryRun: effectiveDryRun,
      onlyUnverified: parsedArgs.onlyUnverified,
      force: parsedArgs.force,
      concurrency: parsedArgs.concurrency,
      timeoutMs: parsedArgs.timeoutMs
    },
    logger
  });

  logger.log?.('\n--- URL Verification Summary Report ---');
  logger.log?.(`Total Scanned:       ${summary.scannedCount}`);
  logger.log?.(`Verified Active:     ${summary.verifiedCount}`);
  logger.log?.(`Repaired/Recovered:  ${summary.repairedCount}`);
  logger.log?.(`Unverified Degraded: ${summary.unverifiedCount}`);
  logger.log?.(`Skipped Unchanged:   ${summary.skippedCount}`);
  logger.log?.(`Firestore Updated:   ${summary.updatedCount}`);
  logger.log?.(`Dry-Run Mode:        ${summary.dryRun}`);
  logger.log?.('---------------------------------------\n');

  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[URL Verifier Fatal Error]', err);
    process.exit(1);
  });
}

