import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_CATEGORIES,
  CANONICAL_GENDERS,
  CANONICAL_AGES,
  CANONICAL_RECURRENCES,
  computeActivityExpireAt,
  computeScheduleDayOfWeek,
  normalizeCuratedFields,
  mergeCuratedFields,
  isValidHttpUrl
} from '../public/shared/listing-domain.js';

test('listing-domain exposes canonical constants', () => {
  assert.ok(CANONICAL_CATEGORIES.includes('sports'));
  assert.deepEqual(CANONICAL_GENDERS, ['all', 'women_only', 'men_only']);
  assert.deepEqual(CANONICAL_AGES, ['all', 'adults', 'juniors', 'masters']);
  assert.deepEqual(CANONICAL_RECURRENCES, ['none', 'weekly']);
});

test('computeScheduleDayOfWeek derives day_of_week for non-weekly and weekly schedules', () => {
  // 2026-11-28 is a Saturday (6)
  assert.equal(
    computeScheduleDayOfWeek({ recurrence: 'none', start_date: '2026-11-28', day_of_week: 2 }),
    6
  );
  // Weekly respects explicit day_of_week 0..6
  assert.equal(
    computeScheduleDayOfWeek({ recurrence: 'weekly', start_date: '2026-11-28', day_of_week: 3 }),
    3
  );
  // Weekly falls back to start_date when day_of_week is null/missing
  assert.equal(
    computeScheduleDayOfWeek({ recurrence: 'weekly', start_date: '2026-11-28', day_of_week: null }),
    6
  );
  assert.equal(computeScheduleDayOfWeek({ recurrence: 'none', start_date: null }), null);
});

test('computeActivityExpireAt handles non-recurring, finite weekly, and perpetual weekly', () => {
  const nonRecurring = computeActivityExpireAt({ recurrence: 'none', start_date: '2026-12-01' });
  assert.equal(nonRecurring.toISOString(), '2026-12-02T16:00:00.000Z');

  const finiteWeekly = computeActivityExpireAt({
    recurrence: 'weekly',
    start_date: '2026-11-01',
    end_date: '2026-12-10'
  });
  assert.equal(finiteWeekly.toISOString(), '2026-12-11T16:00:00.000Z');

  const perpetualWeekly = computeActivityExpireAt({
    recurrence: 'weekly',
    start_date: '2026-11-01',
    end_date: null
  });
  assert.equal(perpetualWeekly, null);
});

test('normalizeCuratedFields and mergeCuratedFields deduplicate and preserve order', () => {
  assert.deepEqual(normalizeCuratedFields([' title ', '', 'title', 42, 'venue.name']), ['title', 'venue.name']);
  assert.deepEqual(
    mergeCuratedFields(['title', 'description'], ['description', 'schedule', 'title']),
    ['title', 'description', 'schedule']
  );
});

test('isValidHttpUrl accepts http/https URLs and rejects invalid or non-http schemes', () => {
  assert.equal(isValidHttpUrl('https://example.com/path'), true);
  assert.equal(isValidHttpUrl('  http://perth.wa.gov.au  '), true);
  assert.equal(isValidHttpUrl('javascript:alert(1)'), false);
  assert.equal(isValidHttpUrl('ftp://example.com'), false);
  assert.equal(isValidHttpUrl('not a url'), false);
  assert.equal(isValidHttpUrl(''), false);
  assert.equal(isValidHttpUrl(null), false);
});
