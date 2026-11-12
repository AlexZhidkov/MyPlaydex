import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderActivityCard,
  renderEmptyState,
  renderLocationGate,
  renderFilterView,
  CANONICAL_SPORTS,
  createOutboundDirectionsUrl,
  formatScheduleText,
  createSuggestActivityMailtoUrl,
  createSuggestEditMailtoUrl
} from '../src/discovery-ui.js';

test('Seam 3: createOutboundDirectionsUrl generates valid Google Maps query URL per ADR 0002', () => {
  const venue = {
    name: 'Loftus Recreation Centre',
    address: 'Corner Vincent and Loftus Streets, Leederville WA 6007',
    coordinates: { lat: -31.9366, lng: 115.8431 }
  };

  const url = createOutboundDirectionsUrl(venue);
  assert.ok(url.startsWith('https://www.google.com/maps/search/?api=1&query='));
  assert.ok(url.includes('Loftus') || url.includes('-31.9366'));
});

test('Seam 3: formatScheduleText formats weekly and one-off dates cleanly in AWST context', () => {
  const weekly = {
    start_date: '2026-11-09',
    start_time: '18:30',
    end_time: '20:00',
    recurrence: 'weekly',
    day_of_week: 1
  };
  const weeklyText = formatScheduleText(weekly);
  assert.ok(weeklyText.includes('Monday') || weeklyText.includes('Weekly'));
  assert.ok(weeklyText.includes('18:30'));

  const oneOff = {
    start_date: '2026-12-05',
    start_time: '09:00',
    end_time: '11:00',
    recurrence: 'none',
    day_of_week: 6
  };
  const oneOffText = formatScheduleText(oneOff);
  assert.ok(oneOffText.includes('5 Dec') || oneOffText.includes('Dec 5') || oneOffText.includes('2026-12-05'));
  assert.ok(oneOffText.includes('09:00'));
});

test('Seam 3: renderActivityCard outputs 4-tier semantic card structure with all required badges and outbound links', () => {
  const activity = {
    id: 'act_test_1',
    title: 'Casual Beach Volleyball',
    subcategory: 'volleyball',
    distanceKm: 2.45,
    cost: { is_free: true, display_price: 'Free' },
    venue: {
      name: 'Scarborough Beach Amphitheatre',
      address: 'The Esplanade, Scarborough',
      coordinates: { lat: -31.8942, lng: 115.7571 }
    },
    organizer: {
      name: 'Scarborough Beach Sports Club'
    },
    schedule: {
      start_date: '2026-11-14',
      start_time: '08:30',
      recurrence: 'weekly',
      day_of_week: 6
    },
    source_url: 'https://example.com/volleyball-scarborough'
  };

  const html = renderActivityCard(activity);

  // Tier 1: subcategory tag + cost badge + distance badge
  assert.ok(html.includes('volleyball'), 'Should include sport subcategory');
  assert.ok(html.includes('Free'), 'Should include cost badge');
  assert.ok(html.includes('2.5 km') || html.includes('2.45 km'), 'Should include distance badge');

  // Tier 2: title + schedule
  assert.ok(html.includes('Casual Beach Volleyball'), 'Should include title');
  assert.ok(html.includes('08:30'), 'Should include schedule time');

  // Tier 3: Venue name linking to Google Maps + Organizer name (no separate directions-link)
  assert.ok(html.includes('Scarborough Beach Amphitheatre'), 'Should include venue name');
  assert.ok(html.includes('class="venue-name"'), 'Should include venue-name link');
  assert.ok(html.includes('href="https://www.google.com/maps/search/?api=1'), 'Venue name must link to outbound Google Maps');
  assert.ok(!html.includes('directions-link'), 'directions-link button must be removed');
  assert.ok(!html.includes('Directions ↗'), 'Directions ↗ text must be removed');
  assert.ok(html.includes('Scarborough Beach Sports Club'), 'Should include organizer name');

  // Tier 4: primary external referral button
  assert.ok(html.includes('https://example.com/volleyball-scarborough'), 'Must link to source_url');
  assert.ok(html.includes('target="_blank"'), 'Referral must open in external tab');
  assert.ok(html.includes('rel="noopener'), 'Must have security rel for external tab');
});

test('Seam 3: renderEmptyState renders 1-tap recovery buttons', () => {
  const html = renderEmptyState({ radiusKm: 10, hasFilters: true });

  assert.ok(html.includes('Expand radius to 25 km'), 'Must render Expand radius recovery button');
  assert.ok(html.includes('Clear sport filters'), 'Must render Clear sport filters recovery button');
  assert.ok(html.includes('data-action="expand-radius"'), 'Must have action hook for expand radius');
  assert.ok(html.includes('data-action="clear-filters"'), 'Must have action hook for clear filters');
});

test('Seam 3: renderLocationGate renders GPS trigger and search input', () => {
  const html = renderLocationGate();

  assert.ok(html.includes('📍 Use My Current Location'), 'Must include GPS trigger button');
  assert.ok(html.includes('data-action="use-gps"'), 'Must have data-action for GPS');
  assert.ok(html.includes('id="suburb-search-input"') || html.includes('name="suburb-search"'), 'Must have suburb search input');
});

test('Seam A: CANONICAL_SPORTS defines all 11 sports and renderFilterView renders interactive chips and controls', () => {
  assert.equal(CANONICAL_SPORTS.length, 11, 'Must define exactly 11 canonical sport subcategories');
  const expectedSlugs = [
    'soccer', 'volleyball', 'basketball', 'afl', 'tennis',
    'pickleball', 'running', 'social-fitness', 'walking', 'cricket', 'other'
  ];
  for (const slug of expectedSlugs) {
    assert.ok(CANONICAL_SPORTS.some(s => s.slug === slug), `Missing canonical sport: ${slug}`);
  }

  // Render with soccer and pickleball selected
  const html = renderFilterView(['soccer', 'pickleball']);

  // All 11 sport chips present
  for (const slug of expectedSlugs) {
    assert.ok(html.includes(`data-sport="${slug}"`), `Must contain chip for ${slug}`);
  }

  // Verify active state for selected sports
  assert.ok(html.includes('data-sport="soccer"') && html.includes('aria-checked="true"'));
  assert.ok(html.includes('data-sport="pickleball"') && html.includes('aria-checked="true"'));

  // Action buttons
  assert.ok(html.includes('data-action="apply-filters"'), 'Must have Apply Filters action');
  assert.ok(html.includes('data-action="clear-filters"') || html.includes('data-action="clear-all"'), 'Must have Clear All action');
  assert.ok(html.includes('data-action="close-filters"'), 'Must have Close action');
});

test('Seam 1: createSuggestActivityMailtoUrl and createSuggestEditMailtoUrl generate pre-populated mailto drafts', () => {
  // Test suggest activity URL
  const suggestUrl = createSuggestActivityMailtoUrl();
  assert.ok(suggestUrl.startsWith('mailto:azhidkov@gmail.com?'), 'Must target azhidkov@gmail.com');
  assert.ok(suggestUrl.includes('subject='), 'Must include subject parameter');
  assert.ok(suggestUrl.includes('body='), 'Must include body parameter');
  const decodedSuggest = decodeURIComponent(suggestUrl);
  assert.ok(decodedSuggest.includes('Suggest an Activity'), 'Subject must mention Suggest an Activity');
  assert.ok(decodedSuggest.includes('Club / Organizer Name:'), 'Body must prompt for club name');
  assert.ok(decodedSuggest.includes('Sport / Activity:'), 'Body must prompt for sport');
  assert.ok(decodedSuggest.includes('Venue Name & Address / Suburb:'), 'Body must prompt for venue');

  // Test suggest edit URL with activity context
  const activity = {
    id: 'act_tennis_101',
    title: 'Social Doubles Tennis',
    subcategory: 'tennis',
    source_url: 'https://example.com/tennis-club',
    venue: {
      name: 'Robertson Park Tennis Centre',
      address: '176 Fitzgerald St, Perth WA 6000'
    },
    organizer: {
      name: 'Tennis WA'
    },
    schedule: {
      start_date: '2026-11-20',
      start_time: '18:00',
      end_time: '20:00',
      recurrence: 'weekly',
      day_of_week: 5
    }
  };

  const editUrl = createSuggestEditMailtoUrl(activity);
  assert.ok(editUrl.startsWith('mailto:azhidkov@gmail.com?'), 'Must target azhidkov@gmail.com');
  const decodedEdit = decodeURIComponent(editUrl);
  assert.ok(decodedEdit.includes('act_tennis_101'), 'Must include Activity ID');
  assert.ok(decodedEdit.includes('Social Doubles Tennis'), 'Must include Activity Title');
  assert.ok(decodedEdit.includes('tennis'), 'Must include sport subcategory');
  assert.ok(decodedEdit.includes('Tennis WA'), 'Must include organizer name');
  assert.ok(decodedEdit.includes('Robertson Park Tennis Centre'), 'Must include venue name');
  assert.ok(decodedEdit.includes('176 Fitzgerald St'), 'Must include venue address');
  assert.ok(decodedEdit.includes('https://example.com/tennis-club'), 'Must include source URL');

  // Verify renderActivityCard includes the "Suggest an edit" link
  const cardHtml = renderActivityCard(activity);
  assert.ok(cardHtml.includes('Suggest an edit'), 'Activity card must include "Suggest an edit" link');
  assert.ok(cardHtml.includes('mailto:azhidkov@gmail.com'), 'Card edit link must target mailto:azhidkov@gmail.com');
  assert.ok(cardHtml.includes('suggest-edit-link'), 'Card edit link must have suggest-edit-link class');
});

