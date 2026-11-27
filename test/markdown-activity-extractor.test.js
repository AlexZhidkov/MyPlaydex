import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDeterministicSourceId,
  extractMarkdownActivities,
  filterAndNormalizeGeminiActivities
} from '../src/markdown-activity-extractor.js';

describe('Markdown Activity Extractor & Guardrails (Issue #54)', () => {
  const now = new Date('2026-11-25T10:00:00+08:00');
  const scrapedUrl = 'https://club.org.au/timetable';

  it('Seam 1: hard-drops noise (AGMs, committee notices, job ads, private-lesson enquiries), missing title/schedule, and past or >6-month dates', () => {
    const rawItems = [
      { title: 'Annual General Meeting (AGM)', weekday: 'Tuesday', start_time: '18:00', is_noise: false, confidence: 'high' },
      { title: 'Committee Notice: New Fees', start_date: '2026-12-01', start_time: '10:00', is_noise: false, confidence: 'high' },
      { title: 'Job Vacancy: Head Coach Wanted', start_date: '2026-12-05', start_time: '09:00', is_noise: false, confidence: 'high' },
      { title: 'Private Lessons Enquiry', weekday: 'Monday', start_time: '16:00', is_noise: false, confidence: 'high' },
      { title: 'LLM Flagged Noise', weekday: 'Wednesday', start_time: '19:00', is_noise: true, confidence: 'high' },
      { title: '', weekday: 'Thursday', start_time: '19:00', is_noise: false, confidence: 'high' },
      { title: 'No Date Or Weekday', weekday: null, start_date: null, start_time: '19:00', is_noise: false, confidence: 'high' },
      { title: 'Expired Past Activity', start_date: '2026-11-20', start_time: '18:00', is_noise: false, confidence: 'high' },
      { title: 'Too Far Future Activity', start_date: '2027-07-01', start_time: '18:00', is_noise: false, confidence: 'high' },
      { title: 'Valid Social Hit', weekday: 'Thursday', start_time: '19:00', end_time: '21:00', venue_name: 'Kings Park', is_noise: false, confidence: 'high' }
    ];

    const kept = filterAndNormalizeGeminiActivities(rawItems, {
      scrapedUrl,
      organizer: { id: 'org_club', name: 'Perth Club' },
      now
    });

    assert.equal(kept.length, 1);
    assert.equal(kept[0].title, 'Valid Social Hit');
  });

  it('Seam 2: emits weekly recurrence (no start_date) for undated classes and discrete dated schedules for dated Activities, preserving confidence/start_time flags', async () => {
    const mockGeminiClient = {
      async extractActivitiesFromMarkdown() {
        return {
          activities: [
            {
              title: 'Tuesday Evening Badminton',
              category: 'sports',
              weekday: 'Tuesday',
              start_date: null,
              end_date: null,
              start_time: '19:00',
              end_time: '21:00',
              venue_name: 'Kings Park',
              is_noise: false,
              confidence: 'high'
            },
            {
              title: 'Summer Open Tournament',
              category: 'sports',
              weekday: null,
              start_date: '2026-12-12',
              end_date: null,
              start_time: null,
              end_time: null,
              venue_name: 'Kings Park',
              is_noise: false,
              confidence: 'low'
            }
          ]
        };
      }
    };

    const extracted = await extractMarkdownActivities({
      markdown: '# Timetable\nTuesday Evening Badminton 7pm-9pm',
      scrapedUrl,
      organizer: { id: 'org_club', name: 'Perth Club' },
      geminiClient: mockGeminiClient,
      now
    });

    assert.equal(extracted.length, 2);

    const weekly = extracted[0];
    assert.equal(weekly.schedule.recurrence, 'weekly');
    assert.equal(weekly.schedule.day_of_week, 2);
    assert.equal(weekly.schedule.start_date, null);
    assert.equal(weekly.schedule.start_time, '19:00');
    assert.equal(weekly._missingStartTime, false);
    assert.equal(weekly._lowConfidence, false);

    const dated = extracted[1];
    assert.equal(dated.schedule.recurrence, 'none');
    assert.equal(dated.schedule.start_date, '2026-12-12');
    assert.equal(dated.schedule.start_time, null);
    assert.equal(dated._missingStartTime, true);
    assert.equal(dated._lowConfidence, true);
    assert.equal(dated.source, 'organizer_website');
    assert.equal(dated.source_url, scrapedUrl);
  });

  it('Seam 3 (Issue #61): supports configurable source (venue_website vs organizer_website), prefers valid direct ticket_url, and falls back to scrapedUrl', async () => {
    const venuePageUrl = 'https://optusstadium.com.au/whats-on/big-bash-derby';
    const rawItems = [
      {
        title: 'Perth Scorchers vs Melbourne Stars',
        category: 'sports',
        start_date: '2026-12-20',
        start_time: '16:15',
        venue_name: 'Optus Stadium',
        ticket_url: 'http://premier.ticketek.com.au/shows/show.aspx?sh=SCORCHERS',
        is_noise: false,
        confidence: 'high'
      },
      {
        title: 'Stadium Tour Behind the Scenes',
        category: 'community',
        start_date: '2026-12-21',
        start_time: '10:00',
        venue_name: 'Optus Stadium',
        ticket_url: '/tickets/stadium-tour',
        is_noise: false,
        confidence: 'high'
      },
      {
        title: 'Free Fan Zone',
        category: 'family',
        start_date: '2026-12-22',
        start_time: '12:00',
        venue_name: 'Optus Stadium',
        ticket_url: 'mailto:boxoffice@optusstadium.com.au',
        is_noise: false,
        confidence: 'high'
      },
      {
        title: 'New Year Eve Fireworks',
        category: 'community',
        start_date: '2026-12-31',
        start_time: '20:00',
        venue_name: 'Optus Stadium',
        ticket_url: 'Call box office',
        is_noise: false,
        confidence: 'high'
      }
    ];

    const normalized = filterAndNormalizeGeminiActivities(rawItems, {
      scrapedUrl: venuePageUrl,
      source: 'venue_website',
      now
    });

    assert.equal(normalized.length, 4);

    const expectedFirstId = buildDeterministicSourceId(venuePageUrl, 'Perth Scorchers vs Melbourne Stars', '2026-12-20T16:15');
    assert.equal(normalized[0].source, 'venue_website');
    assert.equal(normalized[0].source_id, expectedFirstId);
    assert.equal(normalized[0].source_key, `venue_website_${expectedFirstId}`);
    assert.equal(normalized[0].source_url, 'https://premier.ticketek.com.au/shows/show.aspx?sh=SCORCHERS');
    assert.equal(normalized[0].raw_source_url, 'https://premier.ticketek.com.au/shows/show.aspx?sh=SCORCHERS');
    assert.equal(normalized[0].verified, true);
    assert.equal(normalized[0].sources.length, 1);
    assert.deepEqual(normalized[0].sources[0], {
      source: 'venue_website',
      source_id: expectedFirstId,
      source_key: `venue_website_${expectedFirstId}`,
      source_url: 'https://premier.ticketek.com.au/shows/show.aspx?sh=SCORCHERS',
      raw_source_url: 'https://premier.ticketek.com.au/shows/show.aspx?sh=SCORCHERS',
      verified: true
    });
    assert.deepEqual(normalized[0].source_keys, [`venue_website_${expectedFirstId}`]);

    assert.equal(normalized[1].source_url, 'https://optusstadium.com.au/tickets/stadium-tour');
    assert.equal(normalized[1].sources.length, 1);

    assert.equal(normalized[2].source_url, venuePageUrl);
    assert.equal(normalized[2].raw_source_url, venuePageUrl);
    assert.equal(normalized[3].source_url, venuePageUrl);

    const forwardedCalls = [];
    const mockGeminiClient = {
      async extractActivitiesFromMarkdown(params) {
        forwardedCalls.push(params);
        return {
          activities: [
            {
              title: 'Concert at RAC Arena',
              category: 'music',
              start_date: '2026-12-15',
              start_time: '20:00',
              venue_name: 'RAC Arena',
              ticket_url: 'https://www.ticketmaster.com.au/event/12345',
              is_noise: false,
              confidence: 'high'
            }
          ]
        };
      }
    };

    const extracted = await extractMarkdownActivities({
      markdown: '# Concert at RAC Arena',
      scrapedUrl: 'https://www.racarena.com.au/whats-on/concert',
      venueName: 'RAC Arena',
      source: 'Venue_Website',
      geminiClient: mockGeminiClient,
      now
    });

    assert.equal(forwardedCalls.length, 1);
    assert.equal(forwardedCalls[0].venueName, 'RAC Arena');
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].source, 'venue_website');
    assert.equal(extracted[0].source_url, 'https://www.ticketmaster.com.au/event/12345');
    assert.equal(extracted[0].verified, true);
    assert.equal(extracted[0].sources.length, 1);
  });
});
