/**
 * Crawler Harness Step Summary Reporter
 * Generates formatted GitHub Step Summary Markdown tables and handles step report file writing.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Sanitizes text to be safely displayed inside a single Markdown table cell.
 *
 * @param {string} text
 * @returns {string}
 */
function sanitizeTableCell(text) {
  if (text == null) return '-';
  return String(text)
    .replace(/\r?\n|\r/g, ' ')
    .replace(/\|/g, '\\|')
    .trim() || '-';
}

/**
 * Formats a crawler execution summary as a GitHub Step Summary Markdown report table.
 *
 * @param {object} summary - Ingestion summary report from runCrawlerHarness
 * @returns {string} Markdown table
 */
export function formatStepSummaryTable(summary) {
  const lines = [
    '### Crawler Ingestion Diagnostic Summary',
    '',
    '| Crawler | Status | Raw | Valid | Invalid Drop | Upserted | Duration | Error Code / Message |',
    '|:---|:---:|---:|---:|---:|---:|---:|:---|'
  ];

  for (const res of summary?.results || []) {
    const statusLabel = res.status === 'ok' ? 'OK' : 'FAILED';
    const errText = res.errorCode
      ? (res.error && res.error !== res.errorCode ? `${res.errorCode}: ${res.error}` : res.errorCode)
      : (res.error || '-');
    const safeError = sanitizeTableCell(errText);
    const duration = `${res.durationMs ?? 0}ms`;

    lines.push(
      `| ${sanitizeTableCell(res.crawlerName)} | ${statusLabel} | ${res.rawCount ?? 0} | ${res.validCount ?? 0} | ${res.invalidCount ?? 0} | ${res.upsertedCount ?? 0} | ${duration} | ${safeError} |`
    );
  }

  lines.push('');
  lines.push(`**Total Crawlers:** ${summary?.totalCrawlers ?? 0} | **Successful:** ${summary?.successfulCrawlers ?? 0} | **Failed:** ${summary?.failedCrawlers ?? 0} | **Total Upserted:** ${summary?.totalUpserted ?? 0}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Writes or appends the Markdown step summary to a file (typically $GITHUB_STEP_SUMMARY).
 *
 * @param {object} summary - Ingestion summary report
 * @param {string} [filePath=process.env.GITHUB_STEP_SUMMARY] - Target file path
 * @returns {boolean} Whether writing succeeded
 */
export function writeStepSummary(summary, filePath = process.env.GITHUB_STEP_SUMMARY) {
  if (!filePath) {
    return false;
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const markdown = formatStepSummaryTable(summary);
    appendFileSync(filePath, markdown + '\n', 'utf8');
    return true;
  } catch (err) {
    console.error?.('[Crawler Harness] Failed writing step summary:', err);
    return false;
  }
}
