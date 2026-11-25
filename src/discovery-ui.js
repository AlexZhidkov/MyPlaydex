/**
 * Discovery UI Component Generators
 * Pure Vanilla JS rendering functions producing semantic, mobile-first HTML strings.
 * Zero embedded map canvas per ADR 0002.
 */

import {
  DAY_NAMES,
  parseDateInput,
  resolveNextWeeklyOccurrence
} from './discovery-engine.js';

export const CATEGORY_ICONS = {
  sports: '🏅',
  health: '🧘',
  arts: '🎨',
  music: '🎵',
  community: '🤝',
  family: '👨‍👩‍👧‍👦',
  food: '🍽️',
  hobbies: '🧩',
  travel: '🥾'
};

export const CANONICAL_CATEGORIES_META = [
  { slug: 'sports', name: 'Sports & Fitness' },
  { slug: 'health', name: 'Health & Wellness' },
  { slug: 'arts', name: 'Arts & Culture' },
  { slug: 'music', name: 'Music' },
  { slug: 'community', name: 'Community' },
  { slug: 'family', name: 'Family & Education' },
  { slug: 'food', name: 'Food & Drink' },
  { slug: 'hobbies', name: 'Hobbies' },
  { slug: 'travel', name: 'Travel & Outdoor' }
].map((cat) => ({ ...cat, icon: CATEGORY_ICONS[cat.slug] }));

const CATEGORY_BY_SLUG = new Map(CANONICAL_CATEGORIES_META.map((cat) => [cat.slug, cat]));

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
export const VENUE_TIMEZONE = 'Australia/Perth';

const PERTH_DATE_FORMATTER = new Intl.DateTimeFormat(AUSTRALIAN_LOCALE, {
  timeZone: VENUE_TIMEZONE,
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
});

const PERTH_TIME_FORMATTER = new Intl.DateTimeFormat(AUSTRALIAN_LOCALE, {
  timeZone: VENUE_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

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
  const placeId = typeof venue.google_place_id === 'string' ? venue.google_place_id.trim() : '';
  if (placeId) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${encodeURIComponent(placeId)}`;
  }

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
 * Formats a parsed date entry ({ date, hasTime }) as "<DayName>, DD/MM/YYYY" in Australian locale (en-AU).
 * Calendar-only entries (hasTime: false) preserve their calendar fields; instant timestamps
 * (hasTime: true) are formatted in Australia/Perth wall-clock time.
 *
 * @param {{ date: Date, hasTime: boolean }} dateEntry
 * @returns {string}
 */
function formatDateWithDay(dateEntry) {
  if (!dateEntry.hasTime) {
    const { date } = dateEntry;
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${DAY_NAMES[date.getDay()]}, ${day}/${month}/${year}`;
  }
  return PERTH_DATE_FORMATTER.format(dateEntry.date);
}

/**
 * Resolves a schedule endpoint (start or end) into its parsed date entry and formatted Perth time string.
 *
 * @param {*} dateInput
 * @param {*} timeInput
 * @returns {{ dateEntry: { date: Date, hasTime: boolean } | null, timeStr: string }}
 */
function resolveScheduleEndpoint(dateInput, timeInput) {
  const parsedDate = parseDateInput(dateInput);
  const parsedTime = parseDateInput(timeInput);
  const dateEntry = parsedDate || parsedTime || null;
  const timeStr = parsedTime
    ? (parsedTime.hasTime ? PERTH_TIME_FORMATTER.format(parsedTime.date) : '')
    : (typeof timeInput === 'string' ? timeInput.trim() : '');
  return { dateEntry, timeStr };
}

/**
 * Formats a schedule object into a readable date and time string in Australian format (en-AU),
 * pinned to the venue timezone (Australia/Perth).
 *
 * @param {object} [schedule={}]
 * @param {Date | string} [referenceDate=new Date()]
 * @returns {string}
 */
export function formatScheduleText(schedule = {}, referenceDate = new Date()) {
  if (!schedule || typeof schedule !== 'object') return 'Schedule details on club page';

  const recurrence = schedule.recurrence || 'none';
  const start = resolveScheduleEndpoint(schedule.start_date, schedule.start_time);
  const end = resolveScheduleEndpoint(schedule.end_date, schedule.end_time);

  const timeStr = start.timeStr
    ? (end.timeStr && end.timeStr !== start.timeStr ? `${start.timeStr} – ${end.timeStr}` : start.timeStr)
    : '';

  if (recurrence === 'weekly') {
    const nextDate = resolveNextWeeklyOccurrence(schedule, referenceDate);
    if (nextDate) {
      const dateLabel = formatDateWithDay({ date: nextDate, hasTime: false });
      return timeStr ? `${dateLabel} • ${timeStr}` : dateLabel;
    }
    return timeStr ? `Weekly • ${timeStr}` : 'Weekly';
  }

  // One-off activity
  if (start.dateEntry) {
    const startDateLabel = formatDateWithDay(start.dateEntry);
    const endDateLabel = end.dateEntry ? formatDateWithDay(end.dateEntry) : '';
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
 * Renders Tier 1 Category badge for non-sporting Listings, or sport subcategory
 * badge(s) for `sports` Listings.
 *
 * @param {object} [item={}]
 * @returns {string}
 */
function renderSportBadges(item = {}) {
  const categorySlug = typeof item.category === 'string' ? item.category.trim().toLowerCase() : '';
  const categoryMeta = categorySlug && categorySlug !== 'sports' ? CATEGORY_BY_SLUG.get(categorySlug) : null;
  if (categoryMeta) {
    return `<span class="badge badge-category" data-category="${escapeHtml(categoryMeta.slug)}">${categoryMeta.icon} ${escapeHtml(categoryMeta.name)}</span>`;
  }

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
 * @param {object} [activity={}]
 * @param {Date | string} [referenceDate=new Date()]
 * @returns {string} HTML string
 */
export function renderActivityCard(activity = {}, referenceDate = new Date()) {
  const sportBadges = renderSportBadges(activity);
  const isFree = activity.cost ? activity.cost.is_free : Boolean(activity.is_free);
  const costLabel = activity.cost?.display_price || (isFree ? 'Free' : '$');
  const distanceBadge = renderDistanceBadge(activity);

  const scheduleText = formatScheduleText(activity.schedule, referenceDate);
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
      ${isVerified ? renderSecondarySourcesRow(activity.sources, trimmedSourceUrl) : ''}

      <!-- Tier 4: Suggest edit link -->
      ${renderSuggestEditTier(editMailtoUrl, 'Suggest an edit for this activity')}
    </article>
  `.trim();
}

const SOURCE_PLATFORM_LABELS = {
  eventbrite: 'Eventbrite',
  meetup: 'Meetup',
  facebook: 'Facebook',
  stirling: 'City of Stirling',
  vincent: 'City of Vincent',
  wanneroo: 'City of Wanneroo',
  gosnells: 'City of Gosnells',
  cambridge: 'Town of Cambridge',
  victoria_park: 'Town of Victoria Park',
  visit_perth: 'Visit Perth',
  dlgsc: 'DLGSC',
  volleyball_wa: 'Volleyball WA',
  google_places: 'Google Places',
  council: 'Council'
};

/**
 * Formats a Source Reference platform slug into a human-readable label.
 *
 * @param {string} [source]
 * @returns {string}
 */
function formatSourcePlatformLabel(source) {
  const normalized = trimmedString(source).toLowerCase();
  if (!normalized) return 'External link';
  if (normalized in SOURCE_PLATFORM_LABELS) {
    return SOURCE_PLATFORM_LABELS[normalized];
  }
  return normalized
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Renders the compact "Also on: ..." secondary Source Reference links row
 * when an Activity has verified Source Reference links distinct from its primary source_url.
 *
 * @param {Array<object>} [sources=[]]
 * @param {string} [primarySourceUrl='']
 * @returns {string}
 */
function renderSecondarySourcesRow(sources = [], primarySourceUrl = '') {
  if (!Array.isArray(sources) || sources.length === 0) return '';

  const seenUrls = new Set();
  if (primarySourceUrl) {
    seenUrls.add(primarySourceUrl);
  }

  const secondaryLinks = [];
  for (const ref of sources) {
    if (!ref || ref.verified !== true) continue;
    const url = trimmedString(ref.source_url);
    if (!url || url === '#' || seenUrls.has(url)) continue;
    seenUrls.add(url);
    secondaryLinks.push({
      url,
      label: formatSourcePlatformLabel(ref.source)
    });
  }

  if (secondaryLinks.length === 0) return '';

  const linksHtml = secondaryLinks
    .map(
      (item) =>
        `<a href="${escapeHtml(item.url)}" class="secondary-source-link" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)}</a>`
    )
    .join('<span class="secondary-source-sep" aria-hidden="true"> · </span>');

  return `
      <div class="card-secondary-sources">
        <span class="secondary-sources-label">Also on:</span>
        <span class="secondary-sources-links">${linksHtml}</span>
      </div>`.trim();
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolves outbound Google Maps URL, whole-card click URL, and Unverified badge state
 * for Organizer and Venue cards, supporting Pro-tier Google Places listings without websites.
 *
 * @param {object} listing
 * @param {string} name
 * @param {string} rawCandidateUrl
 * @returns {{ directionsUrl: string, wholeCardUrl: string, hasVerifiedExternalUrl: boolean, isGooglePlaceOnly: boolean }}
 */
function resolveCardNavigationState(listing, name, rawCandidateUrl) {
  const trimmedSourceUrl = trimmedString(rawCandidateUrl);
  const hasVerifiedExternalUrl = listing.verified !== false && Boolean(trimmedSourceUrl) && trimmedSourceUrl !== '#';
  const isGooglePlaceOnly = Boolean(trimmedString(listing.google_place_id))
    && !trimmedSourceUrl
    && !trimmedString(listing.raw_source_url);
  const directionsUrl = createOutboundDirectionsUrl({
    name,
    address: listing.address,
    coordinates: listing.coordinates,
    google_place_id: listing.google_place_id
  });
  const wholeCardUrl = hasVerifiedExternalUrl
    ? trimmedSourceUrl
    : (isGooglePlaceOnly ? directionsUrl : '');

  return {
    directionsUrl,
    wholeCardUrl,
    hasVerifiedExternalUrl,
    isGooglePlaceOnly
  };
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

  const name = organizer.name || organizer.title || 'Untitled Organizer';
  const rawCandidateUrl = organizer.source_url !== undefined ? organizer.source_url : organizer.website;
  const {
    directionsUrl,
    wholeCardUrl,
    hasVerifiedExternalUrl,
    isGooglePlaceOnly
  } = resolveCardNavigationState(organizer, name, rawCandidateUrl);

  const showUnverifiedBadge = !hasVerifiedExternalUrl && !isGooglePlaceOnly;
  const unverifiedBadge = showUnverifiedBadge ? `<span class="badge badge-unverified">Unverified</span>` : '';

  const description = trimmedString(organizer.description);
  const phone = organizer.contact?.phone || organizer.phone || '';
  const email = organizer.contact?.email || organizer.email || '';
  const contactParts = [];
  if (phone) contactParts.push(`📞 ${escapeHtml(phone)}`);
  if (email) contactParts.push(`✉️ ${escapeHtml(email)}`);

  const addressText = organizer.address || name || 'Greater Perth, WA';
  const isClickable = Boolean(wholeCardUrl);
  const cardClasses = isClickable
    ? 'activity-card organizer-card'
    : 'activity-card organizer-card activity-card-unverified organizer-card-unverified';
  const cardInteractiveAttrs = isClickable
    ? ` data-url="${escapeHtml(wholeCardUrl)}" tabindex="0"`
    : '';

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

  const name = venue.name || venue.title || 'Untitled Venue';
  const addressText = venue.address || name || 'Greater Perth, WA';
  const {
    directionsUrl,
    wholeCardUrl: resolvedCardUrl,
    hasVerifiedExternalUrl,
    isGooglePlaceOnly
  } = resolveCardNavigationState(venue, name, venue.source_url);

  const hasFailedExternalUrl = !isGooglePlaceOnly
    && (venue.verified === false || (Boolean(venue.raw_source_url) && !hasVerifiedExternalUrl));
  const unverifiedBadge = hasFailedExternalUrl ? `<span class="badge badge-unverified">Unverified</span>` : '';
  const wholeCardUrl = resolvedCardUrl || directionsUrl;

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

function renderFilterChip({ slug, name, icon, dataAttr, isSelected, extraClass = '' }) {
  const classNames = ['sport-filter-chip', extraClass, isSelected ? 'active' : ''].filter(Boolean).join(' ');
  return `
    <button
      type="button"
      class="${classNames}"
      ${dataAttr}="${escapeHtml(slug)}"
      role="checkbox"
      aria-checked="${isSelected ? 'true' : 'false'}"
    >
      <span class="chip-icon" aria-hidden="true">${icon}</span>
      <span class="chip-label">${escapeHtml(name)}</span>
    </button>
  `.trim();
}

/**
 * Renders the full-screen Two-Tier Category and Sport Subcategory Filter View (/#filters).
 *
 * @param {{ categories?: string[], sports?: string[] } | string[]} [filterState={}]
 * @returns {string} HTML string
 */
export function renderFilterView(filterState = {}) {
  const normalizedState = Array.isArray(filterState)
    ? {
        categories: filterState.length > 0 ? ['sports'] : [],
        sports: filterState
      }
    : (filterState || {});

  const selectedCategories = new Set(Array.isArray(normalizedState.categories) ? normalizedState.categories : []);
  const selectedSports = new Set(Array.isArray(normalizedState.sports) ? normalizedState.sports : []);
  const isSportsActive = selectedCategories.has('sports');

  const categoryChipsHtml = CANONICAL_CATEGORIES_META.map((cat) =>
    renderFilterChip({
      slug: cat.slug,
      name: cat.name,
      icon: cat.icon,
      dataAttr: 'data-category',
      isSelected: selectedCategories.has(cat.slug),
      extraClass: 'category-filter-chip'
    })
  ).join('\n');

  const sportChipsHtml = isSportsActive
    ? CANONICAL_SPORTS.map((sport) =>
        renderFilterChip({
          slug: sport.slug,
          name: sport.name,
          icon: sport.icon,
          dataAttr: 'data-sport',
          isSelected: selectedSports.has(sport.slug)
        })
      ).join('\n')
    : '';

  const sportSectionHtml = isSportsActive
    ? `
        <div class="filter-section filter-sport-subcategories" id="filter-sport-subcategories">
          <h3 class="filter-section-title">Sport Subcategories</h3>
          <p class="filter-instructions">Narrow sports results (leave empty for all sports):</p>
          <div class="sport-chips-grid" role="group" aria-label="Sport subcategories">
            ${sportChipsHtml}
          </div>
        </div>
      `.trim()
    : '';

  return `
    <div class="filter-view-modal" id="filter-view-modal" role="dialog" aria-modal="true" aria-labelledby="filter-view-title">
      <div class="filter-view-container">
        <div class="filter-view-header">
          <h2 id="filter-view-title" class="filter-view-title">Filters</h2>
          <button type="button" class="btn-icon filter-close-btn" data-action="close-filters" aria-label="Close filters">
            &times;
          </button>
        </div>

        <div class="filter-view-body">
          <div class="filter-section">
            <h3 class="filter-section-title">Categories</h3>
            <p class="filter-instructions">Select categories to filter the feed (matches any selected category):</p>
            <div class="sport-chips-grid category-chips-grid" role="group" aria-label="Categories">
              ${categoryChipsHtml}
            </div>
          </div>
          ${sportSectionHtml}
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

