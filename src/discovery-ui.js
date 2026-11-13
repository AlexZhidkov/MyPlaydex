/**
 * Discovery UI Component Generators
 * Pure Vanilla JS rendering functions producing semantic, mobile-first HTML strings.
 * Zero embedded map canvas per ADR 0002.
 */

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

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const AUSTRALIAN_LOCALE = 'en-AU';

/**
 * Parses a YYYY-MM-DD date string or ISO 8601 timestamp into a local Date object.
 *
 * @param {string | Date} value
 * @returns {{ date: Date, hasTime: boolean } | null}
 */
function parseDateInput(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : { date: value, hasTime: true };
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Date-only string YYYY-MM-DD (interpreted as local calendar date)
  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const monthIdx = Number(dateOnlyMatch[2]) - 1;
    const day = Number(dateOnlyMatch[3]);
    const date = new Date(year, monthIdx, day);
    if (!Number.isNaN(date.getTime())) {
      return { date, hasTime: false };
    }
    return null;
  }

  // ISO timestamp or full date-time string (e.g. "2026-11-08T12:12:05.553Z")
  if (trimmed.includes('T') || /^\d{4}-\d{2}-\d{2}[\sT]/.test(trimmed)) {
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) {
      return { date, hasTime: true };
    }
  }

  return null;
}

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
 * Resolves a numeric day of week (0 = Sunday .. 6 = Saturday) from a schedule object or start date.
 *
 * @param {object} schedule
 * @param {Date | null} startDateObj
 * @returns {number | null}
 */
function resolveDayOfWeek(schedule, startDateObj) {
  const rawDay = schedule.day_of_week;
  if (typeof rawDay === 'number' && Number.isInteger(rawDay) && rawDay >= 0 && rawDay <= 6) {
    return rawDay;
  }
  if (typeof rawDay === 'string') {
    const normalized = rawDay.trim().toLowerCase().replace(/s$/, '');
    if (/^[0-6]$/.test(normalized)) {
      return Number(normalized);
    }
    const idx = DAY_NAMES.findIndex((name) => name.toLowerCase() === normalized);
    if (idx !== -1) {
      return idx;
    }
  }
  if (startDateObj) {
    return startDateObj.getDay();
  }
  return null;
}

/**
 * Computes the next occurrence Date (local calendar date) for a weekly schedule.
 *
 * @param {number} targetDayOfWeek
 * @param {Date | null} startDateObj
 * @param {Date} referenceDate
 * @returns {Date}
 */
function getNextWeeklyOccurrence(targetDayOfWeek, startDateObj, referenceDate) {
  const ref = referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())
    ? referenceDate
    : new Date();
  const today = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const startDay = startDateObj
    ? new Date(startDateObj.getFullYear(), startDateObj.getMonth(), startDateObj.getDate())
    : null;
  const baseDate = startDay && startDay > today ? startDay : today;
  const daysUntil = (targetDayOfWeek - baseDate.getDay() + 7) % 7;
  return new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + daysUntil);
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
 * Generates a pre-filled mailto URL for suggesting an edit to an existing activity.
 *
 * @param {object} activity
 * @returns {string} mailto: URL
 */
export function createSuggestEditMailtoUrl(activity = {}) {
  const activityId = activity.id || 'N/A';
  const title = activity.title || 'Untitled Activity';
  const sport = activity.subcategory || activity.sport || 'other';
  const organizerName = activity.organizer?.name || activity.club?.name || 'N/A';
  const venueName = activity.venue?.name || 'N/A';
  const venueAddress = activity.venue?.address || 'N/A';
  const scheduleText = formatScheduleText(activity.schedule);
  const sourceUrl = activity.source_url || activity.raw_source_url || 'N/A';

  const subject = `[MyPlaydex] Suggest an edit: ${title} (${activityId})`;
  const body = [
    'Hi Alex,',
    '',
    'I would like to suggest an edit for the following activity on MyPlaydex:',
    '',
    `Activity ID: ${activityId}`,
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
 * Renders a 4-Tier Activity card HTML string.
 *
 * @param {object} activity
 * @returns {string} HTML string
 */
export function renderActivityCard(activity = {}) {
  const sportSlug = activity.subcategory || activity.sport || 'other';
  const sportIcon = SPORT_ICONS[sportSlug] || '🏅';
  const isFree = activity.cost ? activity.cost.is_free : Boolean(activity.is_free);
  const costLabel = activity.cost?.display_price || (isFree ? 'Free' : '$');
  const distanceKm = typeof activity.distanceKm === 'number' ? Math.round(activity.distanceKm * 10) / 10 : null;
  const distanceBadge = distanceKm !== null ? `<span class="badge badge-distance">${distanceKm} km away</span>` : '';

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
    <article class="${cardClasses}" data-id="${escapeHtml(activity.id)}"${cardInteractiveAttrs}>
      <!-- Tier 1: Metadata line -->
      <div class="card-tier card-tier-1">
        <span class="badge badge-sport">${sportIcon} ${escapeHtml(sportSlug)}</span>
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
        <div class="card-venue-row" data-directions-url="${escapeHtml(directionsUrl)}" title="Open in Google Maps">
          <span class="venue-icon" aria-hidden="true">📍</span>
          <a href="${escapeHtml(directionsUrl)}" class="venue-name" target="_blank" rel="noopener noreferrer" title="Open in Google Maps">${escapeHtml(venue.name || 'Venue location')}</a>
        </div>
        ${organizer.name ? `<div class="card-organizer-row"><span class="organizer-icon" aria-hidden="true">👥</span> <span class="organizer-name">${escapeHtml(organizer.name)}</span></div>` : ''}
      </div>

      <!-- Tier 4: Suggest edit link -->
      <div class="card-tier card-tier-4">
        <a href="${escapeHtml(editMailtoUrl)}" class="suggest-edit-link" target="_blank" rel="noopener noreferrer" title="Suggest an edit for this activity">
          Suggest an edit
        </a>
      </div>
    </article>
  `.trim();
}

/**
 * Renders the empty state when no activities match the search radius or filters.
 * Includes 1-tap recovery buttons.
 *
 * @param {object} [options={}]
 * @returns {string} HTML string
 */
export function renderEmptyState(options = {}) {
  const isAllRadius = options.radiusKm === 'all';
  const expandButton = !isAllRadius
    ? `<button type="button" class="btn btn-outline" data-action="expand-radius">Expand radius to 25 km</button>`
    : '';
  const clearButton = `<button type="button" class="btn btn-outline" data-action="clear-filters">Clear sport filters</button>`;

  return `
    <div class="empty-state">
      <div class="empty-state-icon" aria-hidden="true">🔍</div>
      <h3 class="empty-state-title">No activities found nearby</h3>
      <p class="empty-state-message">
        We couldn't find any activities matching your selected radius or filters. Try expanding your search or resetting sport filters.
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

