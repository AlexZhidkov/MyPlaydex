import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVITY_EXTRACTION_RESPONSE_SCHEMA,
  DEFAULT_GEMINI_FLASH_MODEL,
  createGeminiFlashClient,
  createGeminiFlashClientFromEnv
} from '../src/gemini-flash-client.js';

describe('Gemini Flash Client (Issue #54)', () => {
  it('Seam 1: returns null when GEMINI_API_KEY is unset and calls generateContent with strict JSON schema via injectable fetchFn', async () => {
    assert.equal(createGeminiFlashClient({ apiKey: '' }), null);
    assert.equal(createGeminiFlashClientFromEnv({}), null);

    const requests = [];
    const mockFetch = async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        activities: [
                          {
                            title: 'Tuesday Social Badminton',
                            description: 'All skill levels welcome',
                            category: 'sports',
                            weekday: 'Tuesday',
                            start_date: null,
                            end_date: null,
                            start_time: '19:00',
                            end_time: '21:00',
                            venue_name: 'Kings Park',
                            address: null,
                            cost_description: '$10',
                            is_free: false,
                            is_noise: false,
                            confidence: 'high'
                          }
                        ]
                      })
                    }
                  ]
                }
              }
            ]
          };
        }
      };
    };

    const client = createGeminiFlashClientFromEnv(
      { GEMINI_API_KEY: 'test-gemini-key' },
      { fetchFn: mockFetch, logger: { warn() {}, error() {} } }
    );
    assert.ok(client);

    const result = await client.extractActivitiesFromMarkdown({
      markdown: '# Tuesday Social Badminton\nEvery Tuesday 7pm - 9pm at Kings Park. $10.',
      sourceUrl: 'https://club.org.au/timetable',
      organizerName: 'Perth Badminton Club',
      todayAwst: '2026-11-25'
    });

    assert.equal(requests.length, 1);
    assert.ok(requests[0].url.includes(`/models/${DEFAULT_GEMINI_FLASH_MODEL}:generateContent`));
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(requests[0].init.headers['x-goog-api-key'], 'test-gemini-key');
    assert.equal(requests[0].body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(requests[0].body.generationConfig.responseSchema, ACTIVITY_EXTRACTION_RESPONSE_SCHEMA);

    assert.equal(result.activities.length, 1);
    assert.equal(result.activities[0].title, 'Tuesday Social Badminton');
    assert.equal(result.activities[0].weekday, 'Tuesday');
  });

  it('Seam 2: handles malformed JSON or HTTP errors gracefully without throwing raw parse crashes', async () => {
    const errorFetch = async () => ({
      ok: false,
      status: 429,
      async text() {
        return 'Rate limit exceeded';
      }
    });

    const client = createGeminiFlashClient({
      apiKey: 'test-key',
      fetchFn: errorFetch,
      logger: { warn() {}, error() {} }
    });

    await assert.rejects(
      () => client.extractActivitiesFromMarkdown({
        markdown: '# Classes',
        sourceUrl: 'https://club.org.au/classes',
        todayAwst: '2026-11-25'
      }),
      /429/
    );

    const badJsonClient = createGeminiFlashClient({
      apiKey: 'test-key',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [{ content: { parts: [{ text: 'not valid json {' }] } }]
          };
        }
      }),
      logger: { warn() {}, error() {} }
    });

    const parsed = await badJsonClient.extractActivitiesFromMarkdown({
      markdown: '# Classes',
      sourceUrl: 'https://club.org.au/classes',
      todayAwst: '2026-11-25'
    });
    assert.deepEqual(parsed.activities, []);
  });
});
