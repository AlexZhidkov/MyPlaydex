import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderActivityCard,
  renderOrganizerCard,
  renderVenueCard,
  renderTabSwitcher,
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

test('Seam 3: formatScheduleText formats weekly, one-off, and ISO timestamp dates in Australian format (en-AU)', () => {
  const fridayRef = new Date(2026, 10, 13); // Friday, 13 Nov 2026

  const weeklySunday = {
    start_time: '07:30',
    end_time: '11:30',
    recurrence: 'weekly',
    day_of_week: 0
  };
  const weeklySundayText = formatScheduleText(weeklySunday, fridayRef);
  assert.equal(weeklySundayText, 'Sunday, 15/11/2026 • 07:30 – 11:30');
  assert.ok(!weeklySundayText.includes('Weekly on Sundays'));

  const weeklyMonday = {
    start_date: '2026-11-09',
    start_time: '18:30',
    end_time: '20:00',
    recurrence: 'weekly',
    day_of_week: 1
  };
  const weeklyMondayText = formatScheduleText(weeklyMonday, fridayRef);
  assert.equal(weeklyMondayText, 'Monday, 16/11/2026 • 18:30 – 20:00');

  const weeklyNoDay = {
    recurrence: 'weekly'
  };
  assert.equal(formatScheduleText(weeklyNoDay, fridayRef), 'Weekly');

  const oneOff = {
    start_date: '2026-12-05',
    start_time: '09:00',
    end_time: '11:00',
    recurrence: 'none',
    day_of_week: 6
  };
  const oneOffText = formatScheduleText(oneOff);
  const expectedAuDate = new Date(2026, 11, 5).toLocaleDateString('en-AU');
  assert.ok(oneOffText.includes(expectedAuDate), `Expected "${oneOffText}" to include Australian date "${expectedAuDate}"`);
  assert.equal(oneOffText, 'Saturday, 05/12/2026 • 09:00 – 11:00');

  assert.equal(formatScheduleText({ start_date: '2026-11-18', recurrence: 'none' }), 'Wednesday, 18/11/2026');
  assert.equal(
    formatScheduleText({ start_date: '2026-11-18', start_time: '09:30', end_time: '11:30', recurrence: 'none' }),
    'Wednesday, 18/11/2026 • 09:30 – 11:30'
  );

  const isoSchedule = {
    start_time: '2026-11-08T12:12:05.553Z',
    end_time: '2026-11-08T12:12:05.553Z',
    recurrence: null
  };
  const isoText = formatScheduleText(isoSchedule);
  const isoDateObj = new Date('2026-11-08T12:12:05.553Z');
  const expectedIsoAuDate = isoDateObj.toLocaleDateString('en-AU');
  const expectedIsoAuTime = isoDateObj.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  assert.ok(isoText.includes(expectedIsoAuDate), `Expected "${isoText}" to include Australian date "${expectedIsoAuDate}"`);
  assert.ok(isoText.includes(expectedIsoAuTime), `Expected "${isoText}" to include Australian time "${expectedIsoAuTime}"`);
  assert.ok(!isoText.includes('2026-11-08T12:12:05.553Z'), 'Should not render raw UTC ISO timestamp');
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
  assert.ok(html.includes('data-directions-url="https://www.google.com/maps/search/?api=1'), 'card-venue-row must have data-directions-url');
  assert.ok(!html.includes('directions-link'), 'directions-link button must be removed');
  assert.ok(!html.includes('Directions ↗'), 'Directions ↗ text must be removed');
  assert.ok(html.includes('Scarborough Beach Sports Club'), 'Should include organizer name');

  // Whole-card click navigation & button removal
  assert.ok(html.includes('data-url="https://example.com/volleyball-scarborough"'), 'Card must have data-url for whole-card click navigation');
  assert.ok(html.includes('tabindex="0"'), 'Card must have tabindex="0" for keyboard focus');
  assert.ok(!html.includes('View Club / Details'), 'View Club / Details button must be removed');
  assert.ok(!html.includes('btn-referral'), 'btn-referral class must be removed');
  assert.ok(html.includes('target="_blank"'), 'Outbound links must open in external tab');
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

test('Seam 2: renderActivityCard and createSuggestEditMailtoUrl handle Unverified Listings and non-clickable styles', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const unverifiedActivity = {
    id: 'act_unverified_1',
    title: 'Subiaco Social Basketball',
    subcategory: 'basketball',
    distanceKm: 3.2,
    cost: { is_free: false, display_price: '$10' },
    verified: false,
    source_url: null,
    raw_source_url: 'https://dead-link.example.com/subiaco-hoops',
    venue: {
      id: 'venue_lords_recreation_centre_qd66fd',
      name: 'Lords Recreation Centre',
      coordinates: { lat: -31.9445, lng: 115.8241 },
      geohash: 'qd66fd123'
    },
    organizer: {
      name: 'Subiaco Hoops Club'
    },
    schedule: {
      start_date: '2026-11-18',
      start_time: '19:00',
      recurrence: 'weekly',
      day_of_week: 3
    }
  };

  const html = renderActivityCard(unverifiedActivity);

  // 1. Unverified card applies .activity-card-unverified and omits data-url and tabindex="0"
  assert.ok(html.includes('activity-card-unverified'), 'Unverified card must have activity-card-unverified class');
  assert.ok(!html.includes('data-url='), 'Unverified card must omit data-url attribute');
  assert.ok(!html.includes('tabindex="0"'), 'Unverified card must omit tabindex="0"');

  // 2. Renders Unverified badge in Tier 1 alongside sport, cost, and distance badges
  assert.ok(html.includes('badge-unverified'), 'Tier 1 must include badge-unverified');
  assert.ok(html.includes('Unverified'), 'Tier 1 must render Unverified badge text');
  assert.ok(html.includes('basketball'), 'Tier 1 must still include sport badge');
  assert.ok(html.includes('$10'), 'Tier 1 must still include cost badge');
  assert.ok(html.includes('3.2 km away'), 'Tier 1 must still include distance badge');

  // 3. Venue Google Maps outbound row and Suggest an edit link remain intact
  assert.ok(html.includes('card-venue-row'), 'Unverified card must keep card-venue-row');
  assert.ok(html.includes('data-directions-url="https://www.google.com/maps/search/?api=1'), 'Unverified card must keep Google Maps directions URL');
  assert.ok(html.includes('Suggest an edit'), 'Unverified card must keep Suggest an edit link');

  // 4. Suggest an edit mailto includes raw_source_url when source_url is null
  const editMailto = createSuggestEditMailtoUrl(unverifiedActivity);
  const decodedEdit = decodeURIComponent(editMailto);
  assert.ok(
    decodedEdit.includes('https://dead-link.example.com/subiaco-hoops'),
    'Edit mailto must include raw_source_url so curators can inspect/repair it'
  );

  // 5. Verified card does NOT include Unverified badge or activity-card-unverified
  const verifiedHtml = renderActivityCard({
    ...unverifiedActivity,
    id: 'act_verified_1',
    verified: true,
    source_url: 'https://valid.example.com/subiaco-hoops'
  });
  assert.ok(!verifiedHtml.includes('activity-card-unverified'), 'Verified card must not have activity-card-unverified');
  assert.ok(!verifiedHtml.includes('badge-unverified'), 'Verified card must not render Unverified badge');
  assert.ok(verifiedHtml.includes('data-url="https://valid.example.com/subiaco-hoops"'), 'Verified card must have data-url');
  assert.ok(verifiedHtml.includes('tabindex="0"'), 'Verified card must have tabindex="0"');

  // 6. styles.css defines non-clickable styling for .activity-card-unverified
  const css = fs.readFileSync(path.resolve('src/styles.css'), 'utf8');
  assert.match(css, /\.activity-card-unverified\s*\{[^}]*cursor:\s*default/s, 'styles.css must set cursor: default on .activity-card-unverified');
  assert.match(css, /\.activity-card-unverified:hover\s*\{[^}]*transform:\s*none/s, 'styles.css must disable hover lift on .activity-card-unverified:hover');
});

test('Seam 2 (Issue #13): renderOrganizerCard outputs 4-tier layout for verified and unverified Organizer Listings', () => {
  const verifiedOrg = {
    id: 'org_perth_volleyball',
    name: 'Perth Coastal Volleyball Club',
    description: 'Community social volleyball and junior coaching sessions.',
    address: '123 Marine Parade, Cottesloe WA 6011',
    coordinates: { lat: -31.9934, lng: 115.7578 },
    subcategories: ['volleyball', 'social-fitness'],
    cost_description: 'KidSport eligible',
    contact: {
      phone: '08 9123 4567',
      email: 'info@perthcoastalvb.org.au'
    },
    source_url: 'https://perthcoastalvb.org.au',
    verified: true,
    distanceKm: 1.84
  };

  const verifiedHtml = renderOrganizerCard(verifiedOrg);

  // Tier 1: multi-sport badges, KidSport/cost badge, distance badge, no Unverified badge
  assert.ok(verifiedHtml.includes('organizer-card'), 'Should have organizer-card class');
  assert.ok(verifiedHtml.includes('volleyball'), 'Should render first subcategory');
  assert.ok(verifiedHtml.includes('social-fitness'), 'Should render second subcategory');
  assert.ok(verifiedHtml.includes('KidSport eligible'), 'Should render KidSport/cost badge');
  assert.ok(verifiedHtml.includes('1.8 km away'), 'Should render rounded distance badge');
  assert.ok(!verifiedHtml.includes('badge-unverified'), 'Verified organizer should not render Unverified badge');

  // Tier 2: name, description, phone/email contact summary
  assert.ok(verifiedHtml.includes('Perth Coastal Volleyball Club'), 'Should include organizer name');
  assert.ok(verifiedHtml.includes('Community social volleyball'), 'Should include description');
  assert.ok(verifiedHtml.includes('08 9123 4567'), 'Should include public phone contact');
  assert.ok(verifiedHtml.includes('info@perthcoastalvb.org.au'), 'Should include public email contact');

  // Tier 3: address row with outbound Google Maps link
  assert.ok(verifiedHtml.includes('card-venue-row'), 'Should include address row');
  assert.ok(verifiedHtml.includes('123 Marine Parade, Cottesloe WA 6011'), 'Should display organizer address');
  assert.ok(verifiedHtml.includes('href="https://www.google.com/maps/search/?api=1'), 'Should link to Google Maps');

  // Tier 4: Suggest an edit mailto link
  assert.ok(verifiedHtml.includes('Suggest an edit'), 'Should include Suggest an edit link');
  assert.ok(verifiedHtml.includes('mailto:azhidkov@gmail.com'), 'Edit link must use mailto');
  assert.ok(decodeURIComponent(verifiedHtml).includes('org_perth_volleyball'), 'Edit mailto must include organizer id');

  // Whole-card click enabled for verified organizer
  assert.ok(verifiedHtml.includes('data-url="https://perthcoastalvb.org.au"'), 'Verified organizer card must expose data-url');
  assert.ok(verifiedHtml.includes('tabindex="0"'), 'Verified organizer card must be keyboard focusable');

  // Unverified organizer degrades whole-card click and shows Unverified badge
  const unverifiedOrg = {
    ...verifiedOrg,
    id: 'org_unverified',
    source_url: null,
    raw_source_url: 'https://broken.example.com/club',
    verified: false
  };
  const unverifiedHtml = renderOrganizerCard(unverifiedOrg);
  assert.ok(unverifiedHtml.includes('activity-card-unverified'), 'Unverified organizer must include activity-card-unverified');
  assert.ok(unverifiedHtml.includes('badge-unverified'), 'Unverified organizer must render Unverified badge');
  assert.ok(!unverifiedHtml.includes('data-url='), 'Unverified organizer must omit data-url');
  assert.ok(!unverifiedHtml.includes('tabindex="0"'), 'Unverified organizer must omit tabindex="0"');
  assert.ok(unverifiedHtml.includes('data-directions-url='), 'Unverified organizer still keeps Google Maps link');
  assert.ok(unverifiedHtml.includes('Suggest an edit'), 'Unverified organizer still keeps Suggest an edit link');
});

test('Seam 2 (Issue #13): renderVenueCard outputs 4-tier layout with verified URL or Google Maps fallback and Unverified badge on failed URL', () => {
  const verifiedVenue = {
    id: 'venue_lofts_qd66fd',
    name: 'Loftus Recreation Centre',
    address: '99 Loftus St, Leederville WA 6007',
    description: 'Indoor court centre for volleyball and basketball.',
    hours: 'Mon-Sun 06:00 - 22:00',
    coordinates: { lat: -31.9366, lng: 115.8431 },
    subcategories: ['volleyball', 'basketball'],
    source_url: 'https://loftusrecreationcentre.com.au',
    verified: true,
    distanceKm: 2.3
  };

  const verifiedHtml = renderVenueCard(verifiedVenue);
  assert.ok(verifiedHtml.includes('venue-card'), 'Should have venue-card class');
  assert.ok(verifiedHtml.includes('volleyball') && verifiedHtml.includes('basketball'), 'Should render sport badges');
  assert.ok(!verifiedHtml.includes('badge-unverified'), 'Verified venue should not render Unverified badge');
  assert.ok(verifiedHtml.includes('2.3 km away'), 'Should render distance badge');
  assert.ok(verifiedHtml.includes('Loftus Recreation Centre'), 'Should render venue name');
  assert.ok(verifiedHtml.includes('99 Loftus St, Leederville WA 6007'), 'Should render formatted street address');
  assert.ok(verifiedHtml.includes('Indoor court centre'), 'Should render description');
  assert.ok(verifiedHtml.includes('Mon-Sun 06:00 - 22:00'), 'Should render hours summary');
  assert.ok(verifiedHtml.includes('data-directions-url="https://www.google.com/maps/search/?api=1'), 'Tier 3 should include Google Maps link');
  assert.ok(verifiedHtml.includes('Suggest an edit'), 'Tier 4 should include Suggest an edit link');
  assert.ok(verifiedHtml.includes('data-url="https://loftusrecreationcentre.com.au"'), 'Whole-card click opens verified URL');
  assert.ok(verifiedHtml.includes('tabindex="0"'), 'Venue card should be focusable');

  // Venue with failed external URL shows Unverified badge and falls back whole-card click to Google Maps directions
  const failedUrlVenue = {
    ...verifiedVenue,
    id: 'venue_failed_qd66fd',
    source_url: null,
    raw_source_url: 'https://dead-venue.example.com',
    verified: false
  };
  const failedHtml = renderVenueCard(failedUrlVenue);
  assert.ok(failedHtml.includes('badge-unverified'), 'Failed external URL venue must render Unverified badge');
  assert.ok(
    failedHtml.includes('data-url="https://www.google.com/maps/search/?api=1'),
    'Failed external URL venue whole-card click must fall back to Google Maps directions'
  );
  assert.ok(failedHtml.includes('tabindex="0"'), 'Venue card remains focusable with Google Maps fallback');
});

test('Seam 2 (Issue #13): renderTabSwitcher and renderEmptyState adapt copy per active tab while keeping recovery buttons', () => {
  const tabsHtml = renderTabSwitcher('organizers');
  assert.ok(tabsHtml.includes('role="tablist"'), 'Tab switcher must have role="tablist"');
  assert.ok(tabsHtml.includes('data-tab="activities"') && tabsHtml.includes('Activities'));
  assert.ok(tabsHtml.includes('data-tab="organizers"') && tabsHtml.includes('Organizers'));
  assert.ok(tabsHtml.includes('data-tab="venues"') && tabsHtml.includes('Venues'));
  assert.ok(tabsHtml.includes('id="tab-organizers"') && tabsHtml.includes('aria-selected="true"'));

  const emptyActivities = renderEmptyState({ radiusKm: 10, tab: 'activities' });
  assert.ok(emptyActivities.includes('No activities found nearby'));
  assert.ok(emptyActivities.includes('data-action="expand-radius"'));
  assert.ok(emptyActivities.includes('data-action="clear-filters"'));

  const emptyOrganizers = renderEmptyState({ radiusKm: 10, tab: 'organizers' });
  assert.ok(emptyOrganizers.includes('No organizers found nearby'));
  assert.ok(emptyOrganizers.includes('data-action="expand-radius"'));
  assert.ok(emptyOrganizers.includes('data-action="clear-filters"'));

  const emptyVenues = renderEmptyState({ radiusKm: 'all', tab: 'venues' });
  assert.ok(emptyVenues.includes('No venues found nearby'));
  assert.ok(!emptyVenues.includes('data-action="expand-radius"'), 'Expand button hidden when radius is all');
  assert.ok(emptyVenues.includes('data-action="clear-filters"'));
});

