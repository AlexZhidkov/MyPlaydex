/**
 * Standalone CLI Deduplicator for existing /activities in Firestore (ADR 0010, Issue #45).
 * Scans existing /activities documents, clusters high-confidence duplicates into their
 * first-seen canonical survivor ID using shared merge and source-precedence rules,
 * flags borderline matches as Unreviewed Listing, and defaults to --dry-run unless --apply is passed.
 */

import { pathToFileURL } from 'node:url';
import { planActivityDeduplication } from './activity-deduplicator.js';
import { resolveCliLogger } from './crawler-reporter.js';
import { createFirestoreAdapter, initFirestoreFromEnv } from './firestore-adapter.js';
import { loadDotEnv } from './places-sync.js';

/**
 * Parses CLI arguments for the /activities deduplication runner.
 * Defaults to dry-run unless `--apply` is explicitly supplied without `--dry-run`.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @returns {object}
 */
export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  const apply = argv.includes('--apply') && !argv.includes('--dry-run');
  const dryRun = !apply;
  const useAdc = argv.includes('--use-adc') || Boolean(env.FIREBASE_USE_ADC);

  const projectArgMatch = argv.find(a => a.startsWith('--project='));
  const project = projectArgMatch ? projectArgMatch.split('=')[1] : (env.FIREBASE_PROJECT_ID || 'myplaydex');

  return {
    apply,
    dryRun,
    useAdc,
    project
  };
}

/**
 * Formats a human-reviewable deduplication report covering high-confidence clusters,
 * resulting Source Reference links, and borderline Unreviewed Listing pairs.
 *
 * @param {object} summary
 * @returns {string}
 */
export function formatDeduplicationReport(summary = {}) {
  const mode = summary.dryRun ? 'DRY-RUN' : 'APPLY';
  const stats = summary.stats || {};
  const commit = summary.commitResult || {};
  const clusters = Array.isArray(summary.clusters) ? summary.clusters : [];
  const borderlinePairs = Array.isArray(summary.borderlinePairs) ? summary.borderlinePairs : [];

  const lines = [
    `\n--- Activity Deduplication Report (${mode}) ---`,
    `Scanned Activities:              ${summary.scannedCount ?? stats.scanned ?? 0}`,
    `High-Confidence Clusters:        ${stats.clusters ?? clusters.length}`,
    `${summary.dryRun ? 'Redundant Docs to Delete:       ' : 'Redundant Docs Deleted:         '} ${stats.deletedDocuments ?? 0}`,
    `Borderline Unreviewed Pairs:     ${stats.borderlinePairs ?? borderlinePairs.length}`,
    `Borderline Newly Flagged:        ${stats.borderlineFlagged ?? 0}`,
    `Unchanged Activities:            ${stats.unchanged ?? 0}`,
    `Firestore Writes / Deletes:      ${commit.updated ?? 0} / ${commit.deleted ?? 0} (${commit.batches ?? 0} batches)`
  ];

  if ((commit.failed ?? 0) > 0) {
    lines.push(`Failed Firestore Operations:     ${commit.failed}`);
  }

  if (clusters.length > 0) {
    lines.push('', 'High-Confidence Duplicate Clusters:');
    for (const cluster of clusters) {
      const recurrenceNote = cluster.recurrence === 'weekly' ? ' [weekly]' : '';
      lines.push(`- Survivor: ${cluster.survivorId}${recurrenceNote} ("${cluster.title}")`);
      lines.push(`  Redundant IDs: ${cluster.redundantIds.join(', ')}`);
      lines.push(`  Primary URL:   ${cluster.primarySourceUrl || '(unverified)'}`);
      const refs = Array.isArray(cluster.sources) ? cluster.sources : [];
      if (refs.length > 0) {
        lines.push('  Source References:');
        for (const ref of refs) {
          const status = ref.verified ? 'verified' : 'unverified';
          const url = ref.source_url || ref.raw_source_url || '(none)';
          lines.push(`    * ${ref.source_key} [${status}]: ${url}`);
        }
      }
    }
  }

  if (borderlinePairs.length > 0) {
    lines.push('', 'Borderline Unreviewed Listing Pairs:');
    for (const pair of borderlinePairs) {
      const status = pair.alreadyFlagged ? 'already flagged' : 'flag';
      lines.push(
        `- ${pair.activityId} ("${pair.title}") <-> ${pair.candidateId} ("${pair.candidateTitle}") [${status}]`
      );
    }
  }

  lines.push('------------------------------------------\n');
  return lines.join('\n');
}

/**
 * Scans /activities via the Firestore adapter, plans deduplication clusters and
 * borderline Unreviewed Listing flags, and commits updates/deletes only when not in dry-run mode.
 *
 * @param {object} params
 * @param {object} params.adapter - Firestore adapter instance
 * @param {object} [params.options={}] - Execution options (`dryRun`)
 * @param {object} [params.logger=console] - Logger instance
 * @returns {Promise<object>} Deduplication summary and commit result
 */
export async function runActivityDeduplication({
  adapter,
  options = {},
  logger = console
} = {}) {
  const isDryRun = options.dryRun !== false || Boolean(adapter?.isDryRun?.());

  logger.log?.(`[Dedupe CLI] Scanning /activities collection (dryRun: ${isDryRun})...`);
  const activities = typeof adapter?.scanActivities === 'function'
    ? await adapter.scanActivities()
    : [];

  const plan = planActivityDeduplication(activities);

  let commitResult = {
    updated: 0,
    deleted: 0,
    failed: 0,
    batches: 0,
    errors: [],
    dryRun: isDryRun
  };

  if (!isDryRun && (plan.activitiesToUpdate.length > 0 || plan.activityIdsToDelete.length > 0)) {
    logger.log?.(
      `[Dedupe CLI] Applying ${plan.activitiesToUpdate.length} updates and ${plan.activityIdsToDelete.length} deletions to /activities...`
    );
    commitResult = await adapter.batchApplyActivityDeduplication({
      updates: plan.activitiesToUpdate,
      deleteIds: plan.activityIdsToDelete
    });
  }

  return {
    ...plan,
    dryRun: isDryRun,
    commitResult
  };
}

/**
 * Main entry point for the /activities deduplication CLI.
 *
 * @param {Array<string>} [argv=process.argv.slice(2)]
 * @param {object} [env=process.env]
 * @param {object} [options={}]
 * @returns {Promise<object>} Deduplication summary
 */
export async function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  if (env === process.env || options.envFilePath) {
    await loadDotEnv(options.envFilePath, env);
  }

  const parsedArgs = parseCliArgs(argv, env);
  const logger = resolveCliLogger('dedupe-activities-cli.log', argv, options, env);

  logger.log?.(
    `[Dedupe CLI] Initializing /activities deduplication (project: ${parsedArgs.project}, dry-run: ${parsedArgs.dryRun})`
  );

  const firestoreEnv = options.firestoreEnv || await initFirestoreFromEnv(env, {
    requireCredentials: !parsedArgs.dryRun && !parsedArgs.useAdc,
    useAdc: parsedArgs.useAdc,
    projectId: parsedArgs.project
  });

  const effectiveDryRun = parsedArgs.dryRun || firestoreEnv.dryRun;

  const adapter = options.adapter || createFirestoreAdapter({
    db: firestoreEnv.db,
    dryRun: effectiveDryRun
  });

  if (effectiveDryRun) {
    logger.log?.('[Dedupe CLI] Running in DRY-RUN mode (zero Firestore writes or deletes will be committed).');
  } else {
    logger.log?.(`[Dedupe CLI] Connected to Firestore project: ${firestoreEnv.projectId} (APPLY mode).`);
  }

  const summary = await runActivityDeduplication({
    adapter,
    options: { dryRun: effectiveDryRun },
    logger
  });

  logger.log?.(formatDeduplicationReport(summary));

  if ((summary.commitResult?.failed ?? 0) > 0) {
    const firstError = summary.commitResult.errors?.[0];
    throw new Error(
      `Deduplication failed with ${summary.commitResult.failed} failed Firestore operations` +
      (firstError ? `: ${firstError.message}` : '')
    );
  }

  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cliLogger = resolveCliLogger('dedupe-activities-cli.log', process.argv.slice(2), {}, process.env);
  main(process.argv.slice(2), process.env, { logger: cliLogger }).catch(err => {
    cliLogger.error('[Dedupe CLI Fatal Error]', err);
    process.exit(1);
  });
}
