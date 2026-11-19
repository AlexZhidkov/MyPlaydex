/**
 * Crawler Harness Step Summary Reporter
 * Generates formatted GitHub Step Summary Markdown tables and handles step report file writing.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { format } from 'node:util';

export const DEFAULT_LOG_DIR = resolve(process.cwd(), '.scratch/logs');

/**
 * Creates a logger that tees console output (`log`, `info`, `warn`, `error`)
 * into a timestamped log file on disk.
 *
 * @param {object} [params]
 * @param {string} [params.filePath] - Target log file path
 * @param {object} [params.baseLogger=console] - Underlying console/logger to mirror to
 * @param {boolean} [params.truncate=false] - Whether to clear an existing log file on creation
 * @returns {object} Logger instance
 */
export function createFileLogger({ filePath, baseLogger = console, truncate = false } = {}) {
  if (truncate && filePath) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, '', 'utf8');
    } catch {
      // Never abort a crawler run if log file initialization fails
    }
  }

  function writeToFile(level, args) {
    if (!filePath) return;
    try {
      const message = format(...args);
      const timestamp = new Date().toISOString();
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, `[${timestamp}] [${level}] ${message}\n`, 'utf8');
    } catch {
      // Never crash a crawl due to log file write failures
    }
  }

  return {
    isFileLogger: true,
    logFilePath: filePath,
    log(...args) {
      baseLogger?.log?.(...args);
      writeToFile('INFO', args);
    },
    info(...args) {
      (baseLogger?.info || baseLogger?.log)?.call(baseLogger, ...args);
      writeToFile('INFO', args);
    },
    warn(...args) {
      baseLogger?.warn?.(...args);
      writeToFile('WARN', args);
    },
    error(...args) {
      baseLogger?.error?.(...args);
      writeToFile('ERROR', args);
    }
  };
}

/**
 * Resolves the CLI logger, enabling file-backed logging by default unless disabled
 * or overridden by an in-process custom logger without an explicit log file.
 *
 * @param {string} defaultFileName - Default log filename under DEFAULT_LOG_DIR
 * @param {Array<string>} [argv=[]] - CLI arguments
 * @param {object} [options={}] - Entrypoint options
 * @param {object} [env=process.env] - Environment variables
 * @returns {object} Logger instance
 */
export function resolveCliLogger(defaultFileName, argv = [], options = {}, env = process.env) {
  if (options.logger?.isFileLogger) {
    return options.logger;
  }
  if (options.logFile === false || argv.includes('--no-log-file')) {
    return options.logger || console;
  }

  const logFileArg = argv.find(a => a.startsWith('--log-file='));
  const cliLogFile = logFileArg ? logFileArg.slice('--log-file='.length) : undefined;
  const explicitLogFile = options.logFile || cliLogFile || env.CRAWLER_LOG_FILE;

  if (explicitLogFile) {
    return createFileLogger({
      filePath: resolve(process.cwd(), explicitLogFile),
      baseLogger: options.logger || console,
      truncate: Boolean(options.truncateLog)
    });
  }

  if (!options.logger) {
    const logDir = env.CRAWLER_LOG_DIR ? resolve(process.cwd(), env.CRAWLER_LOG_DIR) : DEFAULT_LOG_DIR;
    return createFileLogger({
      filePath: resolve(logDir, defaultFileName),
      baseLogger: console,
      truncate: Boolean(options.truncateLog)
    });
  }

  return options.logger;
}

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
