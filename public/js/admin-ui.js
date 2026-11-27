/**
 * Semantic HTML Renderers for /admin Curation Workspace.
 * Pure Vanilla JS ES2022 module (zero-build, zero side effects).
 */

import {
  ENTITY_TYPES,
  ENTITY_LABELS,
  formatReviewReason
} from './admin-data.js';
import {
  VIEWS,
  getEntityCounts,
  getReviewReasonOptions,
  getVisibleUnreviewedListings,
  getNewListingsLast24hViewModel
} from './admin-state.js';

const ENTITY_SINGULAR_LABELS = Object.freeze({
  activities: 'Activity',
  organizers: 'Organizer',
  venues: 'Venue'
});

const AWST_FORMATTER = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Perth',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

/**
 * Escapes HTML special characters to prevent XSS in template strings.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Returns a safe http/https URL or null.
 *
 * @param {unknown} rawUrl
 * @returns {string | null}
 */
export function getSafeHttpUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Formats an epoch timestamp in AWST with relative age when recent.
 *
 * @param {number | null | undefined} epochMs
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function formatAwstTimestamp(epochMs, nowMs = Date.now()) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    return 'Unknown time';
  }
  const diffMs = Math.max(0, nowMs - epochMs);
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${AWST_FORMATTER.format(new Date(epochMs))} AWST`;
}

function buildMetadataParts(item, nowMs) {
  const parts = [ENTITY_SINGULAR_LABELS[item.entityType] || item.entityType];

  if (item.entityType === 'activities') {
    if (item.venueName) parts.push(item.venueName);
    if (item.organizerName) parts.push(item.organizerName);
    if (item.schedule?.start_date) {
      const time = item.schedule.start_time ? ` ${item.schedule.start_time}` : '';
      parts.push(`${item.schedule.start_date}${time}`);
    }
  } else if (item.address) {
    parts.push(item.address);
  } else if (item.subcategory) {
    parts.push(item.subcategory.replaceAll('_', ' '));
  }

  if (item.source) {
    parts.push(item.source.replaceAll('_', ' '));
  }

  const timestamp = item.createdAtMs ?? item.updatedAtMs;
  if (timestamp) {
    parts.push(formatAwstTimestamp(timestamp, nowMs));
  }

  return parts;
}

function renderListingRow(item, { showApprove, approvingKeys, nowMs }) {
  const safeName = escapeHtml(item.name);
  const safeHref = getSafeHttpUrl(item.sourceUrl);
  const titleHtml = safeHref
    ? `<a class="listing-link" href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${safeName}</a>`
    : `<span class="listing-name">${safeName}</span>`;

  const metadataHtml = buildMetadataParts(item, nowMs)
    .map((part) => `<span>${escapeHtml(part)}</span>`)
    .join('<span class="meta-sep" aria-hidden="true">/</span>');

  let statusHtml = '';
  if (showApprove) {
    statusHtml = `<span class="listing-reason">${escapeHtml(formatReviewReason(item.reviewReason))}</span>`;
  } else if (item.needsReview) {
    const reasonText = item.reviewReason ? `Needs review: ${formatReviewReason(item.reviewReason)}` : 'Needs review';
    statusHtml = `<span class="listing-reason">${escapeHtml(reasonText)}</span>`;
  } else {
    statusHtml = '<span class="listing-reviewed">Reviewed</span>';
  }

  const isApproving = approvingKeys?.has(item.key);
  const actionHtml = showApprove
    ? `<div class="listing-actions">
        <button
          type="button"
          class="approve-btn"
          data-action="approve"
          data-entity-type="${escapeHtml(item.entityType)}"
          data-doc-id="${escapeHtml(item.docId)}"
          ${isApproving ? 'disabled' : ''}
        >${isApproving ? 'Approving...' : 'Approve'}</button>
      </div>`
    : '';

  return `<li class="listing-row">
    <div class="listing-main">
      <div class="listing-headline">
        ${titleHtml}
        ${statusHtml}
      </div>
      <div class="listing-meta">${metadataHtml}</div>
    </div>
    ${actionHtml}
  </li>`;
}

function renderEntityFilterTabs(counts, activeFilter) {
  const options = [
    { key: 'all', label: 'All', count: counts.all },
    ...ENTITY_TYPES.map((type) => ({
      key: type,
      label: ENTITY_LABELS[type],
      count: counts[type]
    }))
  ];

  const buttonsHtml = options
    .map((opt) => {
      const selected = opt.key === activeFilter;
      return `<button
        type="button"
        role="tab"
        aria-selected="${selected ? 'true' : 'false'}"
        class="segmented-btn${selected ? ' is-active' : ''}"
        data-action="filter-entity"
        data-entity-filter="${escapeHtml(opt.key)}"
      >${escapeHtml(opt.label)} <span class="count-num">${opt.count}</span></button>`;
    })
    .join('');

  return `<div class="segmented-control" role="tablist" aria-label="Filter by listing type">${buttonsHtml}</div>`;
}

function renderReasonSelect(unreviewed, entityFilter, reasonFilter) {
  const options = getReviewReasonOptions(unreviewed, entityFilter);
  const optionRows = [
    '<option value="all">All reasons</option>',
    ...options.map((opt) => {
      const selected = opt.value === reasonFilter ? ' selected' : '';
      return `<option value="${escapeHtml(opt.value)}"${selected}>${escapeHtml(opt.label)} (${opt.count})</option>`;
    })
  ].join('');

  return `<div class="reason-filter-wrap">
    <label for="reason-filter" class="filter-label">Review reason</label>
    <select id="reason-filter" class="reason-select" data-action="filter-reason">
      ${optionRows}
    </select>
  </div>`;
}

/**
 * Renders the complete /admin curation workspace HTML from state.
 *
 * @param {object} state
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function renderWorkspaceHtml(state, nowMs = state.lastLoadedAtMs ?? Date.now()) {
  const isNew24hView = state.activeView === VIEWS.NEW_24H;
  const unreviewedCount = (state.unreviewed || []).length;
  const new24hViewModel = getNewListingsLast24hViewModel(state, nowMs);
  const new24hCount = new24hViewModel.counts.all;

  const viewTabsHtml = `<div class="view-switcher">
    <div class="segmented-control view-tabs" role="tablist" aria-label="Workspace views">
      <button
        type="button"
        role="tab"
        aria-selected="${!isNew24hView ? 'true' : 'false'}"
        class="segmented-btn${!isNew24hView ? ' is-active' : ''}"
        data-action="switch-view"
        data-view="${VIEWS.UNREVIEWED}"
      >Unreviewed Listings <span class="count-num">${unreviewedCount}</span></button>
      <button
        type="button"
        role="tab"
        aria-selected="${isNew24hView ? 'true' : 'false'}"
        class="segmented-btn${isNew24hView ? ' is-active' : ''}"
        data-action="switch-view"
        data-view="${VIEWS.NEW_24H}"
      >New (Last 24h) <span class="count-num">${new24hCount}</span></button>
    </div>
    <button type="button" class="refresh-btn" data-action="refresh"${state.loading ? ' disabled' : ''}>
      ${state.loading ? 'Refreshing...' : 'Refresh'}
    </button>
  </div>`;

  const actionErrorHtml = state.actionError
    ? `<p class="workspace-alert" role="alert">${escapeHtml(state.actionError)}</p>`
    : '';

  if (state.loading && unreviewedCount === 0 && new24hCount === 0) {
    return `${viewTabsHtml}
      <div class="workspace-panel">
        <p class="workspace-empty" role="status">Loading listings...</p>
      </div>`;
  }

  if (state.error && unreviewedCount === 0 && new24hCount === 0) {
    return `${viewTabsHtml}
      <div class="workspace-panel">
        <p class="workspace-alert" role="alert">${escapeHtml(state.error)}</p>
      </div>`;
  }

  if (!isNew24hView) {
    const counts = getEntityCounts(state.unreviewed);
    const visible = getVisibleUnreviewedListings(state);
    const filterBarHtml = `<div class="filter-bar">
      ${renderEntityFilterTabs(counts, state.entityFilter)}
      ${renderReasonSelect(state.unreviewed, state.entityFilter, state.reasonFilter)}
    </div>`;

    const bodyHtml = visible.length === 0
      ? '<p class="workspace-empty">No unreviewed listings match the current filters.</p>'
      : `<ul class="listing-list">${visible
          .map((item) =>
            renderListingRow(item, {
              showApprove: true,
              approvingKeys: state.approvingKeys,
              nowMs
            })
          )
          .join('')}</ul>`;

    return `${viewTabsHtml}
      ${actionErrorHtml}
      ${filterBarHtml}
      <section class="workspace-panel" aria-label="Unreviewed Listings">
        ${bodyHtml}
      </section>`;
  }

  const filterBarHtml = `<div class="filter-bar">
    ${renderEntityFilterTabs(new24hViewModel.counts, state.entityFilter)}
    <p class="window-note">Listings created in the last 24 hours</p>
  </div>`;

  const groupsHtml = new24hViewModel.groups
    .map((group) => {
      const groupBody = group.count === 0
        ? `<p class="group-empty">No new ${escapeHtml(group.label.toLowerCase())} in the last 24 hours.</p>`
        : `<ul class="listing-list">${group.items
            .map((item) =>
              renderListingRow(item, {
                showApprove: false,
                approvingKeys: state.approvingKeys,
                nowMs
              })
            )
            .join('')}</ul>`;

      return `<section class="workspace-panel group-section" aria-label="${escapeHtml(group.label)}">
        <div class="group-header">
          <h2 class="group-title">${escapeHtml(group.label)}</h2>
          <span class="group-count count-num">${group.count}</span>
        </div>
        ${groupBody}
      </section>`;
    })
    .join('');

  return `${viewTabsHtml}
    ${actionErrorHtml}
    ${filterBarHtml}
    <div class="groups-stack">${groupsHtml}</div>`;
}
