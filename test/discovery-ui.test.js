import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderActivityCard,
  renderEmptyState,
  renderLocationGate,
  createOutboundDirectionsUrl,
  formatScheduleText
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

  // Tier 3: Venue name + outbound Google Maps Directions ↗ link + Organizer name
  assert.ok(html.includes('Scarborough Beach Amphitheatre'), 'Should include venue name');
  assert.ok(html.includes('Directions ↗'), 'Should include Directions ↗ link text');
  assert.ok(html.includes('https://www.google.com/maps/search/?api=1'), 'Directions must be outbound Google Maps');
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
