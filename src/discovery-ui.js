/**
 * Discovery UI Component Generators
 * Pure Vanilla JS rendering functions producing semantic, mobile-first HTML strings.
 * Zero embedded map canvas per ADR 0002.
 */

const SPORT_ICONS = {
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

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
 * Formats a schedule object into a readable date and time string in AWST context.
 *
 * @param {object} schedule
 * @returns {string}
 */
export function formatScheduleText(schedule = {}) {
  if (!schedule) return 'Schedule details on club page';

  const recurrence = schedule.recurrence || 'none';
  const startTime = schedule.start_time;
  const endTime = schedule.end_time;
  const timeStr = startTime ? (endTime ? `${startTime} – ${endTime}` : startTime) : '';

  if (recurrence === 'weekly') {
    let dayName = '';
    if (typeof schedule.day_of_week === 'number' && schedule.day_of_week >= 0 && schedule.day_of_week <= 6) {
      dayName = DAY_NAMES[schedule.day_of_week];
    } else if (schedule.start_date) {
      const d = new Date(`${schedule.start_date}T12:00:00Z`);
      if (!Number.isNaN(d.getTime())) {
        dayName = DAY_NAMES[d.getUTCDay()];
      }
    }
    const dayLabel = dayName ? `Weekly on ${dayName}s` : 'Weekly';
    return timeStr ? `${dayLabel} • ${timeStr}` : dayLabel;
  }

  // One-off activity
  if (schedule.start_date) {
    const parts = schedule.start_date.split('-');
    let dateLabel = schedule.start_date;
    if (parts.length === 3) {
      const year = parts[0];
      const monthIdx = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      const monthName = MONTH_NAMES[monthIdx] || '';
      dateLabel = `${day} ${monthName} ${year}`;
    }
    return timeStr ? `${dateLabel} • ${timeStr}` : dateLabel;
  }

  return timeStr || 'Check schedule details';
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
  const sourceUrl = activity.source_url || '#';

  return `
    <article class="activity-card" data-id="${escapeHtml(activity.id)}">
      <!-- Tier 1: Metadata line -->
      <div class="card-tier card-tier-1">
        <span class="badge badge-sport">${sportIcon} ${escapeHtml(sportSlug)}</span>
        <span class="badge badge-cost ${isFree ? 'badge-free' : ''}">${escapeHtml(costLabel)}</span>
        ${distanceBadge}
      </div>

      <!-- Tier 2: Title & Schedule -->
      <div class="card-tier card-tier-2">
        <h3 class="card-title">${escapeHtml(activity.title || 'Untitled Activity')}</h3>
        <p class="card-schedule"><span class="schedule-icon" aria-hidden="true">📅</span> <span>${escapeHtml(scheduleText)}</span></p>
      </div>

      <!-- Tier 3: Venue, Outbound Directions, Organizer -->
      <div class="card-tier card-tier-3">
        <div class="card-venue-row">
          <span class="venue-icon" aria-hidden="true">📍</span>
          <span class="venue-name">${escapeHtml(venue.name || 'Venue location')}</span>
          <a href="${escapeHtml(directionsUrl)}" class="directions-link" target="_blank" rel="noopener noreferrer" aria-label="Directions in Google Maps">Directions ↗</a>
        </div>
        ${organizer.name ? `<div class="card-organizer-row"><span class="organizer-icon" aria-hidden="true">👥</span> <span class="organizer-name">${escapeHtml(organizer.name)}</span></div>` : ''}
      </div>

      <!-- Tier 4: Primary external referral action -->
      <div class="card-tier card-tier-4">
        <a href="${escapeHtml(sourceUrl)}" class="btn btn-primary btn-referral" target="_blank" rel="noopener noreferrer">
          View Club / Details ↗
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
