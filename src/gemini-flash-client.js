/**
 * Zero-Dependency Gemini Flash Structured-JSON REST Client
 * Uses Node `fetch` (`GEMINI_API_KEY`, `responseMimeType: 'application/json'`, `responseSchema`)
 * with an injectable `fetchFn` for unit testing (ADR 0013).
 */

import { CANONICAL_CATEGORIES } from './sanitizer.js';

export const DEFAULT_GEMINI_FLASH_MODEL = 'gemini-2.5-flash-lite';
export const DEFAULT_GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_MARKDOWN_CHARS = 30000;

export const ACTIVITY_EXTRACTION_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    activities: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          description: { type: 'STRING', nullable: true },
          category: { type: 'STRING', enum: [...CANONICAL_CATEGORIES] },
          weekday: {
            type: 'STRING',
            nullable: true,
            enum: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
          },
          start_date: { type: 'STRING', nullable: true },
          end_date: { type: 'STRING', nullable: true },
          start_time: { type: 'STRING', nullable: true },
          end_time: { type: 'STRING', nullable: true },
          venue_name: { type: 'STRING', nullable: true },
          address: { type: 'STRING', nullable: true },
          cost_description: { type: 'STRING', nullable: true },
          is_free: { type: 'BOOLEAN', nullable: true },
          is_noise: { type: 'BOOLEAN' },
          noise_reason: { type: 'STRING', nullable: true },
          confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] }
        },
        required: ['title', 'is_noise', 'confidence']
      }
    }
  },
  required: ['activities']
};

function buildExtractionPrompt({ markdown, sourceUrl, organizerName, todayAwst }) {
  const truncated = markdown.length > DEFAULT_MAX_MARKDOWN_CHARS
    ? markdown.slice(0, DEFAULT_MAX_MARKDOWN_CHARS)
    : markdown;

  return [
    'Extract scheduled, in-person Activities (social sports, fitness classes, cultural performances, family activities, workshops, community gatherings) in Greater Perth, Western Australia from the scraped Markdown below.',
    `Today (AWST): ${todayAwst || 'unknown'}`,
    `Source URL: ${sourceUrl || 'unknown'}`,
    organizerName ? `Organizer: ${organizerName}` : null,
    '',
    'Rules:',
    '- Only extract real, scheduled in-person activities with either an explicit calendar date (start_date as YYYY-MM-DD) OR a recurring weekly weekday (weekday as Sunday..Saturday with start_date null).',
    '- For undated recurring weekly timetable classes, set weekday (e.g. "Tuesday") and leave start_date and end_date as null.',
    '- For dated Activities, set start_date (and end_date if multi-day) as YYYY-MM-DD in AWST.',
    '- Format start_time and end_time as 24-hour HH:mm when known, or null if missing.',
    '- Mark is_noise: true (or omit) for AGMs, committee notices, job ads, volunteer recruitment, generic "contact us for private lessons" enquiries, or news articles without a scheduled session.',
    '- Set confidence to "high", "medium", or "low" based on how clearly the schedule and venue are stated.',
    '',
    'Markdown:',
    truncated
  ].filter(line => line !== null).join('\n');
}

/**
 * Creates a zero-dependency Gemini Flash structured-JSON client.
 * Returns `null` if `apiKey` is missing or blank so callers skip cleanly.
 *
 * @param {object} [options={}]
 * @returns {object|null}
 */
export function createGeminiFlashClient({
  apiKey,
  model = DEFAULT_GEMINI_FLASH_MODEL,
  baseUrl = DEFAULT_GEMINI_API_BASE_URL,
  fetchFn = globalThis.fetch,
  timeoutMs = DEFAULT_GEMINI_TIMEOUT_MS,
  logger = console
} = {}) {
  const cleanKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!cleanKey) {
    return null;
  }

  const normalizedBaseUrl = String(baseUrl || DEFAULT_GEMINI_API_BASE_URL).replace(/\/+$/, '');
  const cleanModel = String(model || DEFAULT_GEMINI_FLASH_MODEL).trim();

  async function extractActivitiesFromMarkdown({
    markdown = '',
    sourceUrl = '',
    organizerName = '',
    todayAwst = ''
  } = {}) {
    if (typeof markdown !== 'string' || !markdown.trim()) {
      return { activities: [] };
    }

    const endpoint = `${normalizedBaseUrl}/models/${encodeURIComponent(cleanModel)}:generateContent`;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`Gemini Flash request timed out after ${timeoutMs}ms`)), timeoutMs)
      : null;

    let response;
    try {
      response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cleanKey
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: buildExtractionPrompt({ markdown, sourceUrl, organizerName, todayAwst })
                }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: ACTIVITY_EXTRACTION_RESPONSE_SCHEMA,
            temperature: 0.1
          }
        }),
        ...(controller ? { signal: controller.signal } : {})
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Gemini Flash HTTP ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const payload = await response.json();
    const rawText = payload?.candidates?.[0]?.content?.parts
      ?.map(part => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();

    if (!rawText) {
      return { activities: [] };
    }

    try {
      const parsed = JSON.parse(rawText);
      const activities = Array.isArray(parsed?.activities) ? parsed.activities : [];
      return { activities };
    } catch (err) {
      logger?.warn?.(`[Gemini Flash] Failed to parse structured JSON response for ${sourceUrl}: ${err.message}`);
      return { activities: [] };
    }
  }

  return {
    model: cleanModel,
    extractActivitiesFromMarkdown
  };
}

/**
 * Builds a Gemini Flash client from environment variables (`GEMINI_API_KEY`).
 * Returns `null` when `GEMINI_API_KEY` is unset.
 *
 * @param {object} [env=process.env]
 * @param {object} [overrides={}]
 * @returns {object|null}
 */
export function createGeminiFlashClientFromEnv(env = process.env, overrides = {}) {
  return createGeminiFlashClient({
    apiKey: env?.GEMINI_API_KEY,
    model: env?.GEMINI_FLASH_MODEL || DEFAULT_GEMINI_FLASH_MODEL,
    ...overrides
  });
}
