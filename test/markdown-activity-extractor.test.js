import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
});
