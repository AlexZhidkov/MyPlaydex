/**
 * Discovery UI Component Generators
 * Pure Vanilla JS rendering functions producing semantic, mobile-first HTML strings.
 * Zero embedded map canvas per ADR 0002.
 */

import {
  DAY_NAMES,
  parseDateInput,
  resolveDayOfWeek,
  getNextWeeklyOccurrence
} from './discovery-engine.js';

export const SPORT_ICONS = {
  soccer: '⚽',
  volleyball: '🏐',
  basketball: '🏀',
  afl: '🏉',
  tennis: '🎾',
  pickleball: '🏓',
  running: '🏃',
  'social-fitness': '💪',
  walking: '🚶',
  cricket: '🏏',
  other: '🎯'
};

export const CANONICAL_SPORTS = [
  { slug: 'soccer', name: 'Soccer / Football' },
  { slug: 'volleyball', name: 'Volleyball' },
  { slug: 'basketball', name: 'Basketball' },
  { slug: 'afl', name: 'AFL / Footy' },
  { slug: 'tennis', name: 'Tennis' },
  { slug: 'pickleball', name: 'Pickleball' },
  { slug: 'running', name: 'Running' },
  { slug: 'social-fitness', name: 'Social Fitness' },
  { slug: 'walking', name: 'Walking' },
  { slug: 'cricket', name: 'Cricket' },
  { slug: 'other', name: 'Other Sports' }
].map((sport) => ({ ...sport, icon: SPORT_ICONS[sport.slug] }));

export const AUSTRALIAN_LOCALE = 'en-AU';

/**
 * Escapes HTML characters to prevent XSS.
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generates an outbound Google Maps directions search link per ADR 0002.
 * Combines venue name and coordinates for precise targeting.
 *
 * @param {object} venue
 * @returns {string} Outbound Google Maps URL
 */
export function createOutboundDirectionsUrl(venue = {}) {
  const name = venue.name || 'Sports Venue';
  const coords = venue.coordinates || (venue.lat !== undefined && venue.lng !== undefined ? venue : null);

  let query = name;
  if (coords && typeof coords.lat === 'number' && typeof coords.lng === 'number') {
    query = `${name} ${coords.lat},${coords.lng}`;
  } else if (venue.address) {
    query = `${name}, ${venue.address}`;
  }

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/**
 * Formats a Date object as "<DayName>, DD/MM/YYYY" in Australian locale (en-AU).
 *
 * @param {Date} date
 * @returns {string}
 */
function formatDateWithDay(date) {
  return `${DAY_NAMES[date.getDay()]}, ${date.toLocaleDateString(AUSTRALIAN_LOCALE)}`;
}

/**
 * Formats a schedule object into a readable date and time string in Australian format (en-AU).
 *
 * @param {object} [schedule={}]
 * @param {Date} [referenceDate=new Date()]
 * @returns {string}
 */
export function formatScheduleText(schedule = {}, referenceDate = new Date()) {
  if (!schedule || typeof schedule !== 'object') return 'Schedule details on club page';

  const recurrence = schedule.recurrence || 'none';

  const parsedStartTime = parseDateInput(schedule.start_time);
  const parsedEndTime = parseDateInput(schedule.end_time);
  const parsedStartDate = parseDateInput(schedule.start_date);
  const parsedEndDate = parseDateInput(schedule.end_date);

  const startDateObj = parsedStartDate?.date || parsedStartTime?.date || null;
  const endDateObj = parsedEndDate?.date || parsedEndTime?.date || null;

  const startTimeStr = parsedStartTime
    ? (parsedStartTime.hasTime ? parsedStartTime.date.toLocaleTimeString(AUSTRALIAN_LOCALE, { hour: '2-digit', minute: '2-digit' }) : '')
    : (typeof schedule.start_time === 'string' ? schedule.start_time.trim() : '');

  const endTimeStr = parsedEndTime
    ? (parsedEndTime.hasTime ? parsedEndTime.date.toLocaleTimeString(AUSTRALIAN_LOCALE, { hour: '2-digit', minute: '2-digit' }) : '')
    : (typeof schedule.end_time === 'string' ? schedule.end_time.trim() : '');

  const timeStr = startTimeStr
    ? (endTimeStr && endTimeStr !== startTimeStr ? `${startTimeStr} – ${endTimeStr}` : startTimeStr)
    : '';

  if (recurrence === 'weekly') {
    const targetDayOfWeek = resolveDayOfWeek(schedule, startDateObj);
    if (targetDayOfWeek !== null) {
      const nextDate = getNextWeeklyOccurrence(targetDayOfWeek, startDateObj, referenceDate);
      const dateLabel = formatDateWithDay(nextDate);
      return timeStr ? `${dateLabel} • ${timeStr}` : dateLabel;
    }
    return timeStr ? `Weekly • ${timeStr}` : 'Weekly';
  }

  // One-off activity
  if (startDateObj) {
    const startDateLabel = formatDateWithDay(startDateObj);
    const endDateLabel = endDateObj ? formatDateWithDay(endDateObj) : '';
    const dateLabel = endDateLabel && endDateLabel !== startDateLabel
      ? `${startDateLabel} – ${endDateLabel}`
      : startDateLabel;
    return timeStr ? `${dateLabel} • ${timeStr}` : dateLabel;
  }

  if (typeof schedule.start_date === 'string' && schedule.start_date.trim()) {
    const dateLabel = schedule.start_date.trim();
    return timeStr ? `${dateLabel} • ${timeStr}` : dateLabel;
  }

  return timeStr || 'Check schedule details';
}

export const CURATION_CONTACT_EMAIL = 'azhidkov@gmail.com';

/**
 * Generates a pre-filled mailto URL for suggesting a new sports activity or club.
 *
 * @returns {string} mailto: URL
 */
export function createSuggestActivityMailtoUrl() {
  const subject = '[MyPlaydex] Suggest an Activity / Club';
  const body = [
    'Hi Alex,',
    '',
    'I would like to suggest a new sports activity or club for MyPlaydex:',
    '',
    'Club / Organizer Name: ',
    'Sport / Activity: ',
    'Venue Name & Address / Suburb: ',
    'Schedule / Day & Time: ',
    'Cost / Free: ',
    'Website or Referral Link: ',
    'Additional Notes: ',
    ''
  ].join('\n');

  return `mailto:${CURATION_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Extracts deduplicated sport slugs for rendering Tier 1 sport badges.
 *
 * @param {object} [item={}]
 * @returns {string[]}
 */
function getItemSports(item = {}) {
  if (Array.isArray(item.subcategories) && item.subcategories.length > 0) {
    const unique = [];
    for (const s of item.subcategories) {
      if (typeof s === 'string' && s.trim() && !unique.includes(s.trim())) {
        unique.push(s.trim());
      }
    }
    if (unique.length > 0) return unique;
  }
  return [item.subcategory || item.sport || 'other'];
}

/**
 * Renders Tier 1 sport badge(s) for a Listing.
 *
 * @param {object} [item={}]
 * @returns {string}
 */
function renderSportBadges(item = {}) {
  return getItemSports(item)
    .map((sportSlug) => {
      const sportIcon = SPORT_ICONS[sportSlug] || '🏅';
      return `<span class="badge badge-sport">${sportIcon} ${escapeHtml(sportSlug)}</span>`;
    })
    .join('\n        ');
}

/**
 * Renders a distance badge if numeric `distanceKm` is present on a Listing.
 *
 * @param {object} [item={}]
 * @returns {string}
 */
function renderDistanceBadge(item = {}) {
  const distanceKm = typeof item.distanceKm === 'number' ? Math.round(item.distanceKm * 10) / 10 : null;
  return distanceKm !== null ? `<span class="badge badge-distance">${distanceKm} km away</span>` : '';
}

/**
 * Resolves listing entity kind ('organizer' | 'venue' | 'activity').
 *
 * @param {object} [listing={}]
 * @returns {'organizer' | 'venue' | 'activity'}
 */
function inferListingKind(listing = {}) {
  if (listing.entity_type === 'organizer' || listing.entity_type === 'venue' || listing.entity_type === 'activity') {
    return listing.entity_type;
  }
  if (typeof listing.id === 'string') {
    if (listing.id.startsWith('org_') && !listing.schedule) return 'organizer';
    if (listing.id.startsWith('venue_') && !listing.schedule) return 'venue';
  }
  return 'activity';
}

/**
 * Generates a pre-filled mailto URL for suggesting an edit to an existing Activity, Organizer, or Venue.
 *
 * @param {object} listing
 * @returns {string} mailto: URL
 */
export function createSuggestEditMailtoUrl(listing = {}) {
  const kind = inferListingKind(listing);
  const listingId = listing.id || 'N/A';
  const sports = getItemSports(listing).join(', ');
  const sourceUrl = listing.source_url || listing.raw_source_url || listing.website || 'N/A';

  if (kind === 'organizer') {
    const name = listing.name || listing.title || 'Untitled Organizer';
    const address = listing.address || 'N/A';
    const phone = listing.contact?.phone || listing.phone || 'N/A';
    const email = listing.contact?.email || listing.email || 'N/A';
    const subject = `[MyPlaydex] Suggest an edit: ${name} (${listingId})`;
    const body = [
      'Hi Alex,',
      '',
      'I would like to suggest an edit for the following organizer on MyPlaydex:',
      '',
      `Organizer ID: ${listingId}`,
      `Name: ${name}`,
      `Sports: ${sports}`,
      `Address: ${address}`,
      `Phone: ${phone}`,
      `Email: ${email}`,
      `Source URL: ${sourceUrl}`,
      '',
      'Suggested Changes / Notes:',
      '',
      ''
    ].join('\n');
    return `mailto:${CURATION_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  if (kind === 'venue') {
    const name = listing.name || listing.title || 'Untitled Venue';
    const address = listing.address || 'N/A';
    const subject = `[MyPlaydex] Suggest an edit: ${name} (${listingId})`;
    const body = [
      'Hi Alex,',
      '',
      'I would like to suggest an edit for the following venue on MyPlaydex:',
      '',
      `Venue ID: ${listingId}`,
      `Name: ${name}`,
      `Sports: ${sports}`,
      `Address: ${address}`,
      `Source URL: ${sourceUrl}`,
      '',
      'Suggested Changes / Notes:',
      '',
      ''
    ].join('\n');
    return `mailto:${CURATION_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  const title = listing.title || listing.name || 'Untitled Activity';
  const sport = listing.subcategory || listing.sport || 'other';
  const organizerName = listing.organizer?.name || listing.club?.name || 'N/A';
  const venueName = listing.venue?.name || 'N/A';
  const venueAddress = listing.venue?.address || 'N/A';
  const scheduleText = formatScheduleText(listing.schedule);

  const subject = `[MyPlaydex] Suggest an edit: ${title} (${listingId})`;
  const body = [
    'Hi Alex,',
    '',
    'I would like to suggest an edit for the following activity on MyPlaydex:',
    '',
    `Activity ID: ${listingId}`,
    `Title: ${title}`,
    `Sport: ${sport}`,
    `Organizer: ${organizerName}`,
    `Venue: ${venueName} (${venueAddress})`,
    `Current Schedule: ${scheduleText}`,
    `Source URL: ${sourceUrl}`,
    '',
    'Suggested Changes / Notes:',
    '',
    ''
  ].join('\n');

  return `mailto:${CURATION_CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Renders Tier 3 Google Maps outbound row shared across Activity, Organizer, and Venue cards.
 *
 * @param {string} directionsUrl
 * @param {string} labelText
 * @returns {string}
 */
function renderMapsRow(directionsUrl, labelText) {
  return `
        <div class="card-venue-row" data-directions-url="${escapeHtml(directionsUrl)}" title="Open in Google Maps">
          <span class="venue-icon" aria-hidden="true">📍</span>
          <a href="${escapeHtml(directionsUrl)}" class="venue-name" target="_blank" rel="noopener noreferrer" title="Open in Google Maps">${escapeHtml(labelText)}</a>
        </div>`.trim();
}

/**
 * Renders Tier 4 "Suggest an edit" footer row shared across all Listing cards.
 *
 * @param {string} editMailtoUrl
 * @param {string} titleText
 * @returns {string}
 */
function renderSuggestEditTier(editMailtoUrl, titleText) {
  return `
      <div class="card-tier card-tier-4">
        <a href="${escapeHtml(editMailtoUrl)}" class="suggest-edit-link" target="_blank" rel="noopener noreferrer" title="${escapeHtml(titleText)}">
          Suggest an edit
        </a>
      </div>`.trim();
}

/**
 * Renders a 4-Tier Activity card HTML string.
 *
 * @param {object} activity
 * @returns {string} HTML string
 */
export function renderActivityCard(activity = {}) {
  const sportBadges = renderSportBadges(activity);
  const isFree = activity.cost ? activity.cost.is_free : Boolean(activity.is_free);
  const costLabel = activity.cost?.display_price || (isFree ? 'Free' : '$');
  const distanceBadge = renderDistanceBadge(activity);

  const scheduleText = formatScheduleText(activity.schedule);
  const venue = activity.venue || {};
  const organizer = activity.organizer || activity.club || {};
  const directionsUrl = createOutboundDirectionsUrl(venue);
  const trimmedSourceUrl = typeof activity.source_url === 'string' ? activity.source_url.trim() : '';
  const isVerified = activity.verified !== false && Boolean(trimmedSourceUrl) && trimmedSourceUrl !== '#';
  const unverifiedBadge = !isVerified ? `<span class="badge badge-unverified">Unverified</span>` : '';
  const cardClasses = isVerified ? 'activity-card' : 'activity-card activity-card-unverified';
  const cardInteractiveAttrs = isVerified
    ? ` data-url="${escapeHtml(trimmedSourceUrl)}" tabindex="0"`
    : '';
  const editMailtoUrl = createSuggestEditMailtoUrl(activity);

  return `
    <article class="${cardClasses}" data-id="${escapeHtml(activity.id)}" data-entity-type="activity"${cardInteractiveAttrs}>
      <!-- Tier 1: Metadata line -->
      <div class="card-tier card-tier-1">
        ${sportBadges}
        <span class="badge badge-cost ${isFree ? 'badge-free' : ''}">${escapeHtml(costLabel)}</span>
        ${unverifiedBadge}
        ${distanceBadge}
      </div>

      <!-- Tier 2: Title & Schedule -->
      <div class="card-tier card-tier-2">
        <h3 class="card-title">${escapeHtml(activity.title || 'Untitled Activity')}</h3>
        <p class="card-schedule"><span class="schedule-icon" aria-hidden="true">📅</span> <span>${escapeHtml(scheduleText)}</span></p>
      </div>

      <!-- Tier 3: Venue (Outbound Google Maps), Organizer -->
      <div class="card-tier card-tier-3">
        ${renderMapsRow(directionsUrl, venue.name || 'Venue location')}
        ${organizer.name ? `<div class="card-organizer-row"><span class="organizer-icon" aria-hidden="true">👥</span> <span class="organizer-name">${escapeHtml(organizer.name)}</span></div>` : ''}
      </div>

      <!-- Tier 4: Suggest edit link -->
      ${renderSuggestEditTier(editMailtoUrl, 'Suggest an edit for this activity')}
    </article>
  `.trim();
}

/**
 * Renders a 4-Tier Organizer card HTML string.
 *
 * @param {object} [organizer={}]
 * @returns {string} HTML string
 */
export function renderOrganizerCard(organizer = {}) {
  const sportBadges = renderSportBadges(organizer);
  const distanceBadge = renderDistanceBadge(organizer);

  const rawCost = (
    organizer.cost_description ||
    organizer.cost?.display_price ||
    (organizer.kidsport ? 'KidSport eligible' : '')
  ).trim();
  const isHighlightCost = Boolean(organizer.cost?.is_free || organizer.is_free || /free|kidsport/i.test(rawCost));
  const costBadge = rawCost
    ? `<span class="badge badge-cost ${isHighlightCost ? 'badge-free' : ''}">${escapeHtml(rawCost)}</span>`
    : '';

  const rawCandidateUrl = organizer.source_url !== undefined ? organizer.source_url : organizer.website;
  const trimmedSourceUrl = typeof rawCandidateUrl === 'string' ? rawCandidateUrl.trim() : '';
  const isVerified = organizer.verified !== false && Boolean(trimmedSourceUrl) && trimmedSourceUrl !== '#';
  const unverifiedBadge = !isVerified ? `<span class="badge badge-unverified">Unverified</span>` : '';

  const cardClasses = isVerified
    ? 'activity-card organizer-card'
    : 'activity-card organizer-card activity-card-unverified organizer-card-unverified';
  const cardInteractiveAttrs = isVerified
    ? ` data-url="${escapeHtml(trimmedSourceUrl)}" tabindex="0"`
    : '';

  const name = organizer.name || organizer.title || 'Untitled Organizer';
  const description = typeof organizer.description === 'string' ? organizer.description.trim() : '';
  const phone = organizer.contact?.phone || organizer.phone || '';
  const email = organizer.contact?.email || organizer.email || '';
  const contactParts = [];
  if (phone) contactParts.push(`📞 ${escapeHtml(phone)}`);
  if (email) contactParts.push(`✉️ ${escapeHtml(email)}`);

  const addressText = organizer.address || name || 'Greater Perth, WA';
  const directionsUrl = createOutboundDirectionsUrl({
    name,
    address: organizer.address,
    coordinates: organizer.coordinates
  });
  const editMailtoUrl = createSuggestEditMailtoUrl({ ...organizer, entity_type: 'organizer' });

  return `
    <article class="${cardClasses}" data-id="${escapeHtml(organizer.id)}" data-entity-type="organizer"${cardInteractiveAttrs}>
      <!-- Tier 1: Sport badge(s), optional KidSport/cost badge, Unverified badge, distance -->
      <div class="card-tier card-tier-1">
        ${sportBadges}
        ${costBadge}
        ${unverifiedBadge}
        ${distanceBadge}
      </div>

      <!-- Tier 2: Organizer name, description, and public phone/email contact summary -->
      <div class="card-tier card-tier-2">
        <h3 class="card-title">${escapeHtml(name)}</h3>
        ${description ? `<p class="card-description">${escapeHtml(description)}</p>` : ''}
        ${contactParts.length > 0 ? `<p class="card-contact">${contactParts.join(' • ')}</p>` : ''}
      </div>

      <!-- Tier 3: Address row with outbound Google Maps link -->
      <div class="card-tier card-tier-3">
        ${renderMapsRow(directionsUrl, addressText)}
      </div>

      <!-- Tier 4: Suggest edit link -->
      ${renderSuggestEditTier(editMailtoUrl, 'Suggest an edit for this organizer')}
    </article>
  `.trim();
}

/**
 * Renders a 4-Tier Venue card HTML string.
 *
 * @param {object} [venue={}]
 * @returns {string} HTML string
 */
export function renderVenueCard(venue = {}) {
  const sportBadges = renderSportBadges(venue);
  const distanceBadge = renderDistanceBadge(venue);

  const trimmedSourceUrl = typeof venue.source_url === 'string' ? venue.source_url.trim() : '';
  const hasVerifiedExternalUrl = venue.verified !== false && Boolean(trimmedSourceUrl) && trimmedSourceUrl !== '#';
  const hasFailedExternalUrl = venue.verified === false || (Boolean(venue.raw_source_url) && !hasVerifiedExternalUrl);
  const unverifiedBadge = hasFailedExternalUrl ? `<span class="badge badge-unverified">Unverified</span>` : '';

  const name = venue.name || venue.title || 'Untitled Venue';
  const addressText = venue.address || name || 'Greater Perth, WA';
  const directionsUrl = createOutboundDirectionsUrl({
    name,
    address: venue.address,
    coordinates: venue.coordinates
  });
  const wholeCardUrl = hasVerifiedExternalUrl ? trimmedSourceUrl : directionsUrl;

  const summaryParts = [];
  if (typeof venue.description === 'string' && venue.description.trim()) {
    summaryParts.push(venue.description.trim());
  }
  if (typeof venue.hours === 'string' && venue.hours.trim() && !summaryParts.some((p) => p.includes(venue.hours.trim()))) {
    summaryParts.push(venue.hours.trim());
  }
  const summaryText = summaryParts.join(' • ');
  const editMailtoUrl = createSuggestEditMailtoUrl({ ...venue, entity_type: 'venue' });

  return `
    <article class="activity-card venue-card" data-id="${escapeHtml(venue.id)}" data-entity-type="venue" data-url="${escapeHtml(wholeCardUrl)}" tabindex="0">
      <!-- Tier 1: Sport badge(s), Unverified badge if external URL failed, distance -->
      <div class="card-tier card-tier-1">
        ${sportBadges}
        ${unverifiedBadge}
        ${distanceBadge}
      </div>

      <!-- Tier 2: Venue name and description/hours summary -->
      <div class="card-tier card-tier-2">
        <h3 class="card-title">${escapeHtml(name)}</h3>
        ${summaryText ? `<p class="card-description">${escapeHtml(summaryText)}</p>` : ''}
      </div>

      <!-- Tier 3: Outbound Google Maps link -->
      <div class="card-tier card-tier-3">
        ${renderMapsRow(directionsUrl, addressText)}
      </div>

      <!-- Tier 4: Suggest edit link -->
      ${renderSuggestEditTier(editMailtoUrl, 'Suggest an edit for this venue')}
    </article>
  `.trim();
}

const DISCOVERY_TAB_CONFIG = [
  { slug: 'activities', label: 'Activities' },
  { slug: 'organizers', label: 'Organizers' },
  { slug: 'venues', label: 'Venues' }
];

/**
 * Renders the accessible 3-tab switcher (Activities | Organizers | Venues).
 *
 * @param {string} [activeTab='activities']
 * @returns {string} HTML string
 */
export function renderTabSwitcher(activeTab = 'activities') {
  const buttonsHtml = DISCOVERY_TAB_CONFIG.map(({ slug, label }) => {
    const isActive = activeTab === slug;
    return `
      <button
        type="button"
        id="tab-${slug}"
        class="discovery-tab ${isActive ? 'active' : ''}"
        data-tab="${slug}"
        role="tab"
        aria-selected="${isActive ? 'true' : 'false'}"${isActive ? '\n        focusgroupstart' : ''}
      >
        ${label}
      </button>
    `.trim();
  }).join('\n      ');

  return `
    <div
      id="discovery-tabs"
      class="discovery-tabs"
      role="tablist"
      focusgroup="tablist nomemory"
      aria-label="Discovery categories"
    >
      ${buttonsHtml}
    </div>
  `.trim();
}

const EMPTY_STATE_COPY = {
  activities: {
    title: 'No activities found nearby',
    noun: 'activities'
  },
  organizers: {
    title: 'No organizers found nearby',
    noun: 'organizers'
  },
  venues: {
    title: 'No venues found nearby',
    noun: 'venues'
  }
};

/**
 * Renders the empty state when no listings match the search radius or filters.
 * Adapts copy to the active tab while preserving 1-tap recovery buttons.
 *
 * @param {object} [options={}]
 * @returns {string} HTML string
 */
export function renderEmptyState(options = {}) {
  const isAllRadius = options.radiusKm === 'all';
  const rawTab = String(options.tab || options.activeTab || 'activities').toLowerCase();
  const normalizedTab = rawTab === 'organizer' ? 'organizers' : (rawTab === 'venue' ? 'venues' : rawTab);
  const copy = EMPTY_STATE_COPY[normalizedTab] || EMPTY_STATE_COPY.activities;

  const expandButton = !isAllRadius
    ? `<button type="button" class="btn btn-outline" data-action="expand-radius">Expand radius to 25 km</button>`
    : '';
  const clearButton = `<button type="button" class="btn btn-outline" data-action="clear-filters">Clear sport filters</button>`;

  return `
    <div class="empty-state">
      <div class="empty-state-icon" aria-hidden="true">🔍</div>
      <h3 class="empty-state-title">${copy.title}</h3>
      <p class="empty-state-message">
        We couldn't find any ${copy.noun} matching your selected radius or filters. Try expanding your search or resetting sport filters.
      </p>
      <div class="empty-state-actions">
        ${expandButton}
        ${clearButton}
      </div>
    </div>
  `.trim();
}

/**
 * Renders the Cold-Start Location Gate overlay / onboarding screen.
 *
 * @returns {string} HTML string
 */
export function renderLocationGate() {
  return `
    <div class="location-gate" id="location-gate">
      <div class="location-gate-card">
        <div class="gate-hero-icon" aria-hidden="true">📍</div>
        <h2 class="gate-title">Find Social Sports Near You</h2>
        <p class="gate-subtitle">
          Discover casual sports games, weekly social leagues, and club kickabouts across Greater Perth without accounts or passwords.
        </p>

        <div class="gate-actions">
          <button type="button" class="btn btn-primary btn-block btn-gps" data-action="use-gps">
            📍 Use My Current Location
          </button>
        </div>

        <div class="gate-divider">
          <span>or choose your suburb</span>
        </div>

        <div class="suburb-search-box">
          <label for="suburb-search-input" class="visually-hidden">Search Greater Perth Suburb or Postcode</label>
          <div class="input-with-icon">
            <span class="search-icon" aria-hidden="true">🔎</span>
            <input
              type="text"
              id="suburb-search-input"
              name="suburb-search"
              placeholder="Enter suburb or postcode (e.g. Scarborough, 6000)..."
              autocomplete="off"
            />
          </div>
          <div id="suburb-suggestions-list" class="suburb-suggestions-list" role="listbox"></div>
        </div>

        <div class="gate-quick-presets">
          <span class="presets-label">Popular suburbs:</span>
          <div class="preset-chips">
            <button type="button" class="chip-preset" data-suburb="Perth">Perth CBD</button>
            <button type="button" class="chip-preset" data-suburb="Scarborough">Scarborough</button>
            <button type="button" class="chip-preset" data-suburb="Fremantle">Fremantle</button>
            <button type="button" class="chip-preset" data-suburb="Joondalup">Joondalup</button>
            <button type="button" class="chip-preset" data-suburb="Cottesloe">Cottesloe</button>
          </div>
        </div>
      </div>
    </div>
  `.trim();
}

/**
 * Renders the full-screen Dedicated Multi-Category Sport Filter View (/#filters).
 *
 * @param {string[]} [selectedSports=[]]
 * @returns {string} HTML string
 */
export function renderFilterView(selectedSports = []) {
  const selectedSet = new Set(selectedSports);

  const chipsHtml = CANONICAL_SPORTS.map((sport) => {
    const isSelected = selectedSet.has(sport.slug);
    return `
      <button
        type="button"
        class="sport-filter-chip ${isSelected ? 'active' : ''}"
        data-sport="${escapeHtml(sport.slug)}"
        role="checkbox"
        aria-checked="${isSelected ? 'true' : 'false'}"
      >
        <span class="chip-icon" aria-hidden="true">${sport.icon}</span>
        <span class="chip-label">${escapeHtml(sport.name)}</span>
      </button>
    `.trim();
  }).join('\n');

  return `
    <div class="filter-view-modal" id="filter-view-modal" role="dialog" aria-modal="true" aria-labelledby="filter-view-title">
      <div class="filter-view-container">
        <div class="filter-view-header">
          <h2 id="filter-view-title" class="filter-view-title">Filter by Sport</h2>
          <button type="button" class="btn-icon filter-close-btn" data-action="close-filters" aria-label="Close filters">
            &times;
          </button>
        </div>

        <div class="filter-view-body">
          <p class="filter-instructions">Select sports to filter the feed (matches any selected sport):</p>
          <div class="sport-chips-grid" role="group" aria-label="Sport categories">
            ${chipsHtml}
          </div>
        </div>

        <div class="filter-view-footer">
          <button type="button" class="btn btn-outline" data-action="clear-filters">
            Clear All
          </button>
          <button type="button" class="btn btn-primary" data-action="apply-filters">
            Apply Filters
          </button>
        </div>
      </div>
    </div>
  `.trim();
}

