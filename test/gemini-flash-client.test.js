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

  it('Seam 3 (Issue #61): schema includes nullable ticket_url and prompt forwards optional venueName and ticketing rule', async () => {
    const ticketUrlProp = ACTIVITY_EXTRACTION_RESPONSE_SCHEMA.properties.activities.items.properties.ticket_url;
    assert.deepEqual(ticketUrlProp, { type: 'STRING', nullable: true });
    assert.equal(ACTIVITY_EXTRACTION_RESPONSE_SCHEMA.properties.activities.items.required.includes('ticket_url'), false);

    const requests = [];
    const mockFetch = async (url, init) => {
      requests.push(JSON.parse(init.body));
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
                            title: 'Swan Lake Ballet',
                            category: 'arts',
                            start_date: '2026-12-10',
                            start_time: '19:30',
                            venue_name: 'His Majesty\'s Theatre',
                            ticket_url: 'https://premier.ticketek.com.au/shows/show.aspx?sh=SWANLAKE',
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

    const client = createGeminiFlashClient({ apiKey: 'test-key', fetchFn: mockFetch });
    const withVenue = await client.extractActivitiesFromMarkdown({
      markdown: '# Swan Lake\n[Buy Tickets](https://premier.ticketek.com.au/shows/show.aspx?sh=SWANLAKE)',
      sourceUrl: 'https://www.artsculturetrust.wa.gov.au/whats-on/swan-lake',
      venueName: 'His Majesty\'s Theatre',
      todayAwst: '2026-11-27'
    });

    assert.equal(withVenue.activities.length, 1);
    assert.equal(withVenue.activities[0].ticket_url, 'https://premier.ticketek.com.au/shows/show.aspx?sh=SWANLAKE');

    const promptWithVenue = requests[0].contents[0].parts[0].text;
    assert.ok(promptWithVenue.includes('Venue: His Majesty\'s Theatre'));
    assert.ok(promptWithVenue.includes('ticket_url'));

    await client.extractActivitiesFromMarkdown({
      markdown: '# Community Yoga',
      sourceUrl: 'https://club.org.au/yoga',
      todayAwst: '2026-11-27'
    });
    const promptWithoutVenue = requests[1].contents[0].parts[0].text;
    assert.equal(promptWithoutVenue.includes('Venue:'), false);
  });
});
