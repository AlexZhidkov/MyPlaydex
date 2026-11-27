/**
 * Semantic HTML Renderers for /admin Curation Workspace.
 * Pure Vanilla JS ES2022 module (zero-build, zero side effects).
 */

import {
  ENTITY_TYPES,
  ENTITY_LABELS,
  formatReviewReason,
  requiresLinkedActivityCheck,
  toEpochMs
} from './admin-data.js';
import {
  CANONICAL_CATEGORIES,
  CANONICAL_GENDERS,
  CANONICAL_AGES,
  CANONICAL_RECURRENCES,
  DAY_NAMES,
  isValidHttpUrl
} from '../shared/listing-domain.js';
import {
  VIEWS,
  getEntityCounts,
  getReviewReasonOptions,
  getVisibleUnreviewedListings,
  getNewListingsLast24hViewModel,
  shouldClearSurvivorDuplicateFlag
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

function renderListingRow(item, { showApprove, approvingKeys, deletingKeys, savingKeys, nowMs }) {
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
  const isDeleting = deletingKeys?.has(item.key);
  const isSaving = savingKeys?.has(item.key);
  const isBusy = isApproving || isDeleting || isSaving;
  const compareButtonHtml = showApprove && item.entityType === 'activities' && item.reviewReason === 'possible_duplicate'
    ? `<button
          type="button"
          class="compare-btn"
          data-action="review-duplicate"
          data-entity-type="${escapeHtml(item.entityType)}"
          data-doc-id="${escapeHtml(item.docId)}"
          ${isBusy ? 'disabled' : ''}
        >Compare</button>`
    : '';
  const editButtonHtml = `<button
        type="button"
        class="edit-btn"
        data-action="edit"
        data-entity-type="${escapeHtml(item.entityType)}"
        data-doc-id="${escapeHtml(item.docId)}"
        ${isBusy ? 'disabled' : ''}
      >Edit</button>`;
  const approveButtonHtml = showApprove
    ? `<button
          type="button"
          class="approve-btn"
          data-action="approve"
          data-entity-type="${escapeHtml(item.entityType)}"
          data-doc-id="${escapeHtml(item.docId)}"
          ${isBusy ? 'disabled' : ''}
        >${isApproving ? 'Approving...' : 'Approve'}</button>`
    : '';
  const deleteButtonHtml = `<button
        type="button"
        class="delete-btn"
        data-action="delete"
        data-entity-type="${escapeHtml(item.entityType)}"
        data-doc-id="${escapeHtml(item.docId)}"
        ${isBusy ? 'disabled' : ''}
      >${isDeleting ? 'Deleting...' : 'Delete'}</button>`;

  const actionHtml = `<div class="listing-actions">
        ${compareButtonHtml}
        ${editButtonHtml}
        ${approveButtonHtml}
        ${deleteButtonHtml}
      </div>`;

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
              deletingKeys: state.deletingKeys,
              savingKeys: state.savingKeys,
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
                deletingKeys: state.deletingKeys,
                savingKeys: state.savingKeys,
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

function wrapDeleteDialogBody(title, contentHtml) {
  return `<div class="delete-dialog-body">
    <h1 id="delete-dialog-title" class="delete-dialog-title">${escapeHtml(title)}</h1>
    ${contentHtml}
  </div>`;
}

function renderDialogCancelButton(label, { disabled = false } = {}) {
  return `<button type="button" class="dialog-cancel-btn" data-action="cancel-delete" autofocus${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;
}

/**
 * Renders the modal dialog content for Listing deletion and linked-Activity protection.
 *
 * @param {object | null | undefined} deleteDialog
 * @returns {string}
 */
export function renderDeleteDialogHtml(deleteDialog) {
  if (!deleteDialog) return '';

  const entitySingular = ENTITY_SINGULAR_LABELS[deleteDialog.entityType] || 'Listing';
  const safeName = escapeHtml(deleteDialog.name || deleteDialog.docId);
  const safeId = escapeHtml(deleteDialog.entityId || deleteDialog.docId);

  if (deleteDialog.status === 'checking') {
    return wrapDeleteDialogBody(
      'Checking linked Activities...',
      `<p class="dialog-note">Checking whether any Activities reference <strong>${safeName}</strong> (<code>${safeId}</code>).</p>
      <div class="dialog-actions">${renderDialogCancelButton('Cancel')}</div>`
    );
  }

  if (deleteDialog.status === 'blocked') {
    const linked = Array.isArray(deleteDialog.linkedActivities) ? deleteDialog.linkedActivities : [];
    const count = linked.length;
    const activityNoun = count === 1 ? 'Activity' : 'Activities';
    const itemsHtml = linked
      .map(
        (act) => `<li class="linked-activity-item">
          <span class="linked-activity-title">${escapeHtml(act.title || act.id)}</span>
          <code class="linked-activity-id">${escapeHtml(act.id)}</code>
        </li>`
      )
      .join('');

    return wrapDeleteDialogBody(
      `Cannot delete ${entitySingular}`,
      `<p class="dialog-note">
        <strong>${safeName}</strong> (<code>${safeId}</code>) is referenced by
        <strong>${count} ${activityNoun}</strong>. Re-link or delete those Activities first.
      </p>
      <ul class="linked-activities-list" aria-label="Linked Activities">${itemsHtml}</ul>
      <form method="dialog" class="dialog-actions">
        <button type="submit" value="cancel" class="dialog-cancel-btn" data-action="cancel-delete" autofocus>Close</button>
      </form>`
    );
  }

  if (deleteDialog.status === 'error') {
    return wrapDeleteDialogBody(
      `Unable to delete ${entitySingular}`,
      `<p class="workspace-alert" role="alert">${escapeHtml(deleteDialog.error || 'Unable to check linked Activities right now.')}</p>
      <div class="dialog-actions">${renderDialogCancelButton('Close')}</div>`
    );
  }

  const isDeleting = deleteDialog.status === 'deleting';
  const unreferencedNote = requiresLinkedActivityCheck(deleteDialog.entityType)
    ? `<p class="dialog-note">No linked Activities reference this ${escapeHtml(entitySingular.toLowerCase())}.</p>`
    : '';
  const errorHtml = deleteDialog.error
    ? `<p class="workspace-alert" role="alert">${escapeHtml(deleteDialog.error)}</p>`
    : '';

  return wrapDeleteDialogBody(
    `Delete ${entitySingular}?`,
    `<p class="dialog-note">
      This permanently removes <strong>${safeName}</strong> (<code>${safeId}</code>) from Firestore.
    </p>
    ${unreferencedNote}
    ${errorHtml}
    <div class="dialog-actions">
      ${renderDialogCancelButton('Cancel', { disabled: isDeleting })}
      <button type="button" class="dialog-confirm-delete-btn" data-action="confirm-delete"${isDeleting ? ' disabled' : ''}>${isDeleting ? 'Deleting...' : `Delete ${escapeHtml(entitySingular)}`}</button>
    </div>`
  );
}

function formatReadOnlyDate(value) {
  const ms = toEpochMs(value);
  if (ms === null) return '—';
  return `${AWST_FORMATTER.format(new Date(ms))} AWST`;
}

function renderFormField({
  name,
  label,
  value = '',
  type = 'text',
  required = false,
  autofocus = false,
  placeholder = '',
  hint = '',
  error = '',
  step = '',
  autocorrectOff = false,
  dataRole = ''
}) {
  const inputId = `edit-field-${name}`;
  const errorId = `edit-err-${name}`;
  const hintId = hint ? `edit-hint-${name}` : '';
  const describedBy = [hintId, error ? errorId : ''].filter(Boolean).join(' ');
  const invalidAttr = error ? ' aria-invalid="true"' : ' aria-invalid="false"';
  const describedByAttr = describedBy ? ` aria-describedby="${escapeHtml(describedBy)}"` : '';
  const requiredAttr = required ? ' required' : '';
  const autofocusAttr = autofocus ? ' autofocus' : '';
  const placeholderAttr = placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : '';
  const stepAttr = step ? ` step="${escapeHtml(step)}"` : '';
  const textCorrectionAttrs = autocorrectOff
    ? ' autocorrect="off" autocapitalize="none" spellcheck="false"'
    : '';
  const roleAttr = dataRole ? ` data-role="${escapeHtml(dataRole)}"` : '';

  const controlHtml = type === 'textarea'
    ? `<textarea id="${escapeHtml(inputId)}" name="${escapeHtml(name)}" rows="3"${requiredAttr}${autofocusAttr}${placeholderAttr}${invalidAttr}${describedByAttr}>${escapeHtml(value)}</textarea>`
    : `<input id="${escapeHtml(inputId)}" name="${escapeHtml(name)}" type="${escapeHtml(type)}" value="${escapeHtml(value)}"${requiredAttr}${autofocusAttr}${placeholderAttr}${stepAttr}${textCorrectionAttrs}${roleAttr}${invalidAttr}${describedByAttr} />`;

  const hintHtml = hint ? `<span id="${escapeHtml(hintId)}" class="field-hint">${escapeHtml(hint)}</span>` : '';
  const errorHtml = error ? `<p id="${escapeHtml(errorId)}" class="field-error">${escapeHtml(error)}</p>` : '';

  return `<div class="edit-field">
    <label for="${escapeHtml(inputId)}" class="edit-label">${escapeHtml(label)}${required ? ' <span aria-hidden="true">*</span>' : ''}</label>
    ${hintHtml}
    ${controlHtml}
    ${errorHtml}
  </div>`;
}

function renderSelectField({ name, label, value = '', options = [], error = '' }) {
  const inputId = `edit-field-${name}`;
  const errorId = `edit-err-${name}`;
  const invalidAttr = error ? ' aria-invalid="true"' : ' aria-invalid="false"';
  const describedByAttr = error ? ` aria-describedby="${escapeHtml(errorId)}"` : '';
  const optionsHtml = options
    .map((opt) => {
      const optValue = typeof opt === 'string' ? opt : opt.value;
      const optLabel = typeof opt === 'string' ? opt : opt.label;
      const selected = String(value) === String(optValue) ? ' selected' : '';
      return `<option value="${escapeHtml(optValue)}"${selected}>${escapeHtml(optLabel)}</option>`;
    })
    .join('');
  const errorHtml = error ? `<p id="${escapeHtml(errorId)}" class="field-error">${escapeHtml(error)}</p>` : '';

  return `<div class="edit-field">
    <label for="${escapeHtml(inputId)}" class="edit-label">${escapeHtml(label)}</label>
    <select id="${escapeHtml(inputId)}" name="${escapeHtml(name)}"${invalidAttr}${describedByAttr}>${optionsHtml}</select>
    ${errorHtml}
  </div>`;
}

function renderCheckboxField({ name, label, checked = false, disabled = false, hint = '', dataRole = '' }) {
  const inputId = `edit-field-${name}`;
  const hintId = hint ? `edit-hint-${name}` : '';
  const describedByAttr = hintId ? ` aria-describedby="${escapeHtml(hintId)}"` : '';
  const roleAttr = dataRole ? ` data-role="${escapeHtml(dataRole)}"` : '';
  const hintHtml = hint ? `<span id="${escapeHtml(hintId)}" class="field-hint">${escapeHtml(hint)}</span>` : '';

  return `<div class="edit-field edit-field-checkbox">
    <div class="checkbox-row">
      <input id="${escapeHtml(inputId)}" name="${escapeHtml(name)}" type="checkbox"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}${roleAttr}${describedByAttr} />
      <label for="${escapeHtml(inputId)}" class="edit-checkbox-label">${escapeHtml(label)}</label>
    </div>
    ${hintHtml}
  </div>`;
}

function renderReferralFieldset(values, fieldErrors, hasValidSourceUrl) {
  return `<fieldset class="edit-fieldset">
    <legend>Referral &amp; verification</legend>
    ${renderFormField({ name: 'source_url', label: 'Source URL', value: values.source_url, type: 'url', placeholder: 'https://...', hint: 'Clearing Source URL automatically sets verified to false.', error: fieldErrors.source_url, autocorrectOff: true, dataRole: 'source-url' })}
    ${renderCheckboxField({ name: 'verified', label: 'Verified referral URL', checked: hasValidSourceUrl && Boolean(values.verified), disabled: !hasValidSourceUrl, dataRole: 'verified-toggle' })}
  </fieldset>`;
}

/**
 * Renders the slide-over edit drawer HTML for an Activity, Organizer, or Venue.
 *
 * @param {object | null | undefined} editDrawer
 * @returns {string}
 */
export function renderEditDrawerHtml(editDrawer) {
  if (!editDrawer) return '';

  const {
    status = 'editing',
    entityType,
    readOnly = {},
    values = {},
    fieldErrors = {},
    error = null
  } = editDrawer;

  const isSaving = status === 'saving';
  const entitySingular = ENTITY_SINGULAR_LABELS[entityType] || 'Listing';
  const hasValidSourceUrl = isValidHttpUrl(values.source_url);
  const curatedList = Array.isArray(readOnly.curated_fields) && readOnly.curated_fields.length > 0
    ? readOnly.curated_fields.join(', ')
    : 'None yet';

  const readOnlyHtml = `<dl class="edit-readonly-grid" aria-label="Read-only metadata">
    <div class="readonly-item"><dt>ID</dt><dd><code>${escapeHtml(readOnly.id || '—')}</code></dd></div>
    <div class="readonly-item"><dt>Source</dt><dd><code>${escapeHtml(readOnly.source || '—')}</code></dd></div>
    <div class="readonly-item"><dt>Source ID</dt><dd><code>${escapeHtml(readOnly.source_id || '—')}</code></dd></div>
    <div class="readonly-item"><dt>Created</dt><dd>${escapeHtml(formatReadOnlyDate(readOnly.created_at))}</dd></div>
    <div class="readonly-item"><dt>Geohash</dt><dd><code>${escapeHtml(readOnly.geohash || '—')}</code></dd></div>
    <div class="readonly-item"><dt>Curated fields</dt><dd><code>${escapeHtml(curatedList)}</code></dd></div>
  </dl>`;

  const categoryOptions = CANONICAL_CATEGORIES.map((c) => ({ value: c, label: c }));
  const genderOptions = CANONICAL_GENDERS.map((g) => ({ value: g, label: g.replaceAll('_', ' ') }));
  const ageOptions = CANONICAL_AGES.map((a) => ({ value: a, label: a }));
  const recurrenceOptions = CANONICAL_RECURRENCES.map((r) => ({ value: r, label: r }));
  const dayOptions = [
    { value: '', label: 'Auto from start date' },
    ...DAY_NAMES.map((dayName, idx) => ({ value: String(idx), label: dayName }))
  ];

  let sectionsHtml = '';
  if (entityType === 'activities') {
    sectionsHtml = `
      <fieldset class="edit-fieldset">
        <legend>Activity details</legend>
        ${renderFormField({ name: 'title', label: 'Title', value: values.title, required: true, autofocus: true, error: fieldErrors.title })}
        ${renderFormField({ name: 'description', label: 'Description', value: values.description, type: 'textarea', error: fieldErrors.description })}
        <div class="edit-row-2">
          ${renderSelectField({ name: 'category', label: 'Category', value: values.category, options: categoryOptions })}
          ${renderFormField({ name: 'subcategory', label: 'Subcategory', value: values.subcategory, autocorrectOff: true })}
        </div>
        ${renderFormField({ name: 'region_id', label: 'Region ID', value: values.region_id, autocorrectOff: true })}
      </fieldset>
      ${renderReferralFieldset(values, fieldErrors, hasValidSourceUrl)}
      <fieldset class="edit-fieldset">
        <legend>Venue &amp; coordinates</legend>
        <div class="edit-row-2">
          ${renderFormField({ name: 'venue_name', label: 'Venue name', value: values.venue_name })}
          ${renderFormField({ name: 'venue_id', label: 'Venue ID', value: values.venue_id, autocorrectOff: true })}
        </div>
        <div class="edit-row-2">
          ${renderFormField({ name: 'lat', label: 'Latitude', value: values.lat, type: 'number', step: 'any', required: true, error: fieldErrors.lat })}
          ${renderFormField({ name: 'lng', label: 'Longitude', value: values.lng, type: 'number', step: 'any', required: true, error: fieldErrors.lng })}
        </div>
      </fieldset>
      <fieldset class="edit-fieldset">
        <legend>Organizer</legend>
        <div class="edit-row-2">
          ${renderFormField({ name: 'organizer_name', label: 'Organizer name', value: values.organizer_name })}
          ${renderFormField({ name: 'organizer_id', label: 'Organizer ID', value: values.organizer_id, autocorrectOff: true })}
        </div>
      </fieldset>
      <fieldset class="edit-fieldset">
        <legend>Schedule</legend>
        <div class="edit-row-2">
          ${renderSelectField({ name: 'recurrence', label: 'Recurrence', value: values.recurrence, options: recurrenceOptions })}
          ${renderSelectField({ name: 'day_of_week', label: 'Day of week', value: values.day_of_week, options: dayOptions, error: fieldErrors.day_of_week })}
        </div>
        <div class="edit-row-2">
          ${renderFormField({ name: 'start_date', label: 'Start date', value: values.start_date, type: 'date', error: fieldErrors.start_date })}
          ${renderFormField({ name: 'end_date', label: 'End date', value: values.end_date, type: 'date', error: fieldErrors.end_date })}
        </div>
        <div class="edit-row-2">
          ${renderFormField({ name: 'start_time', label: 'Start time', value: values.start_time, type: 'time', error: fieldErrors.start_time })}
          ${renderFormField({ name: 'end_time', label: 'End time', value: values.end_time, type: 'time', error: fieldErrors.end_time })}
        </div>
      </fieldset>
      <fieldset class="edit-fieldset">
        <legend>Cost &amp; demographics</legend>
        ${renderCheckboxField({ name: 'is_free', label: 'Free activity', checked: Boolean(values.is_free) })}
        ${renderFormField({ name: 'display_price', label: 'Display price', value: values.display_price, placeholder: 'e.g. Free or $15' })}
        <div class="edit-row-2">
          ${renderSelectField({ name: 'gender', label: 'Gender', value: values.gender, options: genderOptions })}
          ${renderSelectField({ name: 'age', label: 'Age group', value: values.age, options: ageOptions })}
        </div>
      </fieldset>`;
  } else if (entityType === 'organizers') {
    sectionsHtml = `
      <fieldset class="edit-fieldset">
        <legend>Organizer details</legend>
        ${renderFormField({ name: 'name', label: 'Name', value: values.name, required: true, autofocus: true, error: fieldErrors.name })}
        ${renderFormField({ name: 'description', label: 'Description', value: values.description, type: 'textarea' })}
        ${renderFormField({ name: 'address', label: 'Address', value: values.address })}
        <div class="edit-row-2">
          ${renderSelectField({ name: 'category', label: 'Category', value: values.category, options: categoryOptions })}
          ${renderFormField({ name: 'subcategory', label: 'Primary subcategory', value: values.subcategory, autocorrectOff: true })}
        </div>
        ${renderFormField({ name: 'subcategories', label: 'Subcategories (comma-separated)', value: values.subcategories, autocorrectOff: true })}
        ${renderFormField({ name: 'region_id', label: 'Region ID', value: values.region_id, autocorrectOff: true })}
      </fieldset>
      <fieldset class="edit-fieldset">
        <legend>Coordinates</legend>
        <div class="edit-row-2">
          ${renderFormField({ name: 'lat', label: 'Latitude', value: values.lat, type: 'number', step: 'any', required: true, error: fieldErrors.lat })}
          ${renderFormField({ name: 'lng', label: 'Longitude', value: values.lng, type: 'number', step: 'any', required: true, error: fieldErrors.lng })}
        </div>
      </fieldset>
      <fieldset class="edit-fieldset">
        <legend>Website, contact &amp; verification</legend>
        ${renderFormField({ name: 'website', label: 'Website', value: values.website, type: 'url', placeholder: 'https://...', error: fieldErrors.website, autocorrectOff: true })}
        <div class="edit-row-2">
          ${renderFormField({ name: 'contact_email', label: 'Contact email', value: values.contact_email, type: 'email', autocorrectOff: true })}
          ${renderFormField({ name: 'contact_phone', label: 'Contact phone', value: values.contact_phone, type: 'tel' })}
        </div>
        ${renderFormField({ name: 'contact_facebook', label: 'Facebook URL', value: values.contact_facebook, type: 'url', placeholder: 'https://facebook.com/...', error: fieldErrors.contact_facebook, autocorrectOff: true })}
        ${renderFormField({ name: 'source_url', label: 'Source URL', value: values.source_url, type: 'url', placeholder: 'https://...', hint: 'Clearing Source URL automatically sets verified to false.', error: fieldErrors.source_url, autocorrectOff: true, dataRole: 'source-url' })}
        ${renderCheckboxField({ name: 'verified', label: 'Verified referral URL', checked: hasValidSourceUrl && Boolean(values.verified), disabled: !hasValidSourceUrl, dataRole: 'verified-toggle' })}
      </fieldset>
      <fieldset class="edit-fieldset">
        <legend>Cost &amp; demographics</legend>
        ${renderFormField({ name: 'cost_description', label: 'Cost description', value: values.cost_description })}
        <div class="edit-row-2">
          ${renderSelectField({ name: 'gender', label: 'Gender', value: values.gender, options: genderOptions })}
          ${renderSelectField({ name: 'age', label: 'Age group', value: values.age, options: ageOptions })}
        </div>
      </fieldset>`;
  } else {
    sectionsHtml = `
      <fieldset class="edit-fieldset">
        <legend>Venue details</legend>
        ${renderFormField({ name: 'name', label: 'Name', value: values.name, required: true, autofocus: true, error: fieldErrors.name })}
        ${renderFormField({ name: 'description', label: 'Description', value: values.description, type: 'textarea' })}
        ${renderFormField({ name: 'address', label: 'Address', value: values.address })}
        <div class="edit-row-2">
          ${renderSelectField({ name: 'category', label: 'Category', value: values.category, options: categoryOptions })}
          ${renderFormField({ name: 'subcategory', label: 'Primary subcategory', value: values.subcategory, autocorrectOff: true })}
        </div>
        ${renderFormField({ name: 'subcategories', label: 'Subcategories (comma-separated)', value: values.subcategories, autocorrectOff: true })}
        ${renderFormField({ name: 'region_id', label: 'Region ID', value: values.region_id, autocorrectOff: true })}
      </fieldset>
      <fieldset class="edit-fieldset">
        <legend>Coordinates</legend>
        <div class="edit-row-2">
          ${renderFormField({ name: 'lat', label: 'Latitude', value: values.lat, type: 'number', step: 'any', required: true, error: fieldErrors.lat })}
          ${renderFormField({ name: 'lng', label: 'Longitude', value: values.lng, type: 'number', step: 'any', required: true, error: fieldErrors.lng })}
        </div>
      </fieldset>
      ${renderReferralFieldset(values, fieldErrors, hasValidSourceUrl)}`;
  }

  const errorBannerHtml = error
    ? `<p class="workspace-alert" role="alert">${escapeHtml(error)}</p>`
    : '';

  return `<div class="edit-drawer-shell">
    <header class="edit-drawer-header">
      <div>
        <h1 id="edit-dialog-title" class="edit-drawer-title">Edit ${escapeHtml(entitySingular)}</h1>
        <p class="edit-drawer-subtitle">Saving approves this Listing and protects edited fields from crawler overwrites.</p>
      </div>
      <button type="button" class="dialog-cancel-btn" data-action="close-edit" aria-label="Close edit drawer"${isSaving ? ' disabled' : ''}>Close</button>
    </header>
    <div class="edit-drawer-body">
      ${readOnlyHtml}
      ${errorBannerHtml}
      <form id="admin-edit-form" class="edit-form" novalidate>
        ${sectionsHtml}
      </form>
    </div>
    <footer class="edit-drawer-footer">
      <button type="button" class="dialog-cancel-btn" data-action="close-edit"${isSaving ? ' disabled' : ''}>Cancel</button>
      <button type="submit" form="admin-edit-form" class="save-btn"${isSaving ? ' disabled' : ''}>${isSaving ? 'Saving...' : 'Save & Approve'}</button>
    </footer>
  </div>`;
}

function formatActivitySchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return 'Not specified';
  const parts = [];
  if (schedule.recurrence && schedule.recurrence !== 'none') {
    const dayLabel = Number.isInteger(schedule.day_of_week) && DAY_NAMES[schedule.day_of_week]
      ? ` (${DAY_NAMES[schedule.day_of_week]})`
      : '';
    parts.push(`${schedule.recurrence}${dayLabel}`);
  }
  if (schedule.start_date) {
    const dateRange = schedule.end_date && schedule.end_date !== schedule.start_date
      ? `${schedule.start_date} – ${schedule.end_date}`
      : schedule.start_date;
    parts.push(dateRange);
  }
  if (schedule.start_time) {
    const timeRange = schedule.end_time
      ? `${schedule.start_time}–${schedule.end_time}`
      : schedule.start_time;
    parts.push(timeRange);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Not specified';
}

function renderDuplicateCard(listing, roleLabel, roleClass) {
  const safeTitle = escapeHtml(listing.name || listing.docId);
  const safeId = escapeHtml(listing.id || listing.docId);
  const scheduleText = escapeHtml(formatActivitySchedule(listing.schedule));
  const venueText = escapeHtml(listing.venueName || '—');
  const organizerText = escapeHtml(listing.organizerName || '—');
  const sourceText = escapeHtml(listing.source ? listing.source.replaceAll('_', ' ') : '—');
  const safeHref = getSafeHttpUrl(listing.sourceUrl);
  const linkHtml = safeHref
    ? `<a class="listing-link" href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(safeHref)}</a>`
    : '<span class="duplicate-muted">No link</span>';
  const statusText = listing.needsReview
    ? formatReviewReason(listing.reviewReason)
    : 'Reviewed';

  return `<article class="duplicate-card ${escapeHtml(roleClass)}">
    <div class="duplicate-card-header">
      <span class="duplicate-role-badge">${escapeHtml(roleLabel)}</span>
      <span class="duplicate-status-text">${escapeHtml(statusText)}</span>
    </div>
    <h2 class="duplicate-card-title">${safeTitle}</h2>
    <p class="duplicate-card-id"><code>${safeId}</code></p>
    <dl class="duplicate-card-fields">
      <div class="duplicate-field"><dt>Schedule</dt><dd>${scheduleText}</dd></div>
      <div class="duplicate-field"><dt>Venue</dt><dd>${venueText}</dd></div>
      <div class="duplicate-field"><dt>Organizer</dt><dd>${organizerText}</dd></div>
      <div class="duplicate-field"><dt>Source</dt><dd>${sourceText}</dd></div>
      <div class="duplicate-field"><dt>Link</dt><dd>${linkHtml}</dd></div>
    </dl>
  </article>`;
}

/**
 * Renders the side-by-side duplicate review modal dialog for a possible_duplicate Activity.
 *
 * @param {object | null | undefined} duplicateReview
 * @returns {string}
 */
export function renderDuplicateReviewDialogHtml(duplicateReview) {
  if (!duplicateReview) return '';

  const {
    status = 'loading',
    flagged = null,
    candidateId = null,
    candidate = null,
    confirmDeleteTarget = null,
    error = null
  } = duplicateReview;

  const isBusy = status === 'dismissing' || status === 'deleting';
  const errorHtml = error
    ? `<p class="workspace-alert" role="alert">${escapeHtml(error)}</p>`
    : '';

  const headerHtml = `<header class="duplicate-dialog-header">
    <div>
      <h1 id="duplicate-dialog-title" class="delete-dialog-title">Compare possible duplicate</h1>
      <p class="dialog-note">Review both Activities side-by-side to dismiss the flag or delete the duplicate.</p>
    </div>
    <button type="button" class="dialog-cancel-btn" data-action="close-duplicate" aria-label="Close duplicate review"${isBusy ? ' disabled' : ''}>Close</button>
  </header>`;

  if (status === 'loading') {
    return `<div class="duplicate-dialog-body">
      ${headerHtml}
      <p class="dialog-note" role="status">Loading candidate Activity <code>${escapeHtml(candidateId || '—')}</code>...</p>
    </div>`;
  }

  if (status === 'error') {
    return `<div class="duplicate-dialog-body">
      ${headerHtml}
      <p class="workspace-alert" role="alert">${escapeHtml(error || 'Unable to load candidate Activity right now.')}</p>
      <div class="dialog-actions">
        <button type="button" class="dialog-cancel-btn" data-action="close-duplicate" autofocus>Close</button>
      </div>
    </div>`;
  }

  const flaggedCardHtml = flagged
    ? renderDuplicateCard(flagged, 'Flagged duplicate', 'is-flagged')
    : '';

  const candidateCardHtml = candidate
    ? renderDuplicateCard(candidate, 'Candidate match', 'is-candidate')
    : `<article class="duplicate-card is-missing">
        <div class="duplicate-card-header">
          <span class="duplicate-role-badge">Candidate match</span>
          <span class="duplicate-status-text">Missing</span>
        </div>
        <h2 class="duplicate-card-title">Candidate Activity not found</h2>
        <p class="dialog-note">
          Referenced candidate <code>${escapeHtml(candidateId || 'unknown')}</code> no longer exists (it may have already been deleted).
        </p>
      </article>`;

  if (status === 'confirm_delete' || status === 'deleting') {
    const targetRole = confirmDeleteTarget === 'candidate' ? 'candidate' : 'flagged';
    const targetListing = targetRole === 'candidate' ? candidate : flagged;
    const targetLabel = targetRole === 'candidate' ? 'candidate Activity' : 'flagged Activity';
    const survivor = targetRole === 'candidate' ? flagged : candidate;
    const survivorWillClear = shouldClearSurvivorDuplicateFlag(targetRole, targetListing, survivor);
    const survivorNote = survivorWillClear
      ? ` The duplicate flag on <strong>${escapeHtml(survivor.name || survivor.docId)}</strong> will be cleared.`
      : '';
    const isDeleting = status === 'deleting';

    return `<div class="duplicate-dialog-body">
      ${headerHtml}
      <div class="duplicate-compare-grid">
        ${flaggedCardHtml}
        ${candidateCardHtml}
      </div>
      ${errorHtml}
      <div class="duplicate-confirm-box" role="region" aria-label="Confirm deletion">
        <p class="dialog-note">
          Permanently delete the ${escapeHtml(targetLabel)} <strong>${escapeHtml(targetListing?.name || targetListing?.docId || '')}</strong>
          (<code>${escapeHtml(targetListing?.id || targetListing?.docId || '')}</code>)?${survivorNote}
        </p>
        <div class="dialog-actions">
          <button type="button" class="dialog-cancel-btn" data-action="cancel-delete-duplicate" autofocus${isDeleting ? ' disabled' : ''}>Cancel</button>
          <button type="button" class="dialog-confirm-delete-btn" data-action="confirm-delete-duplicate"${isDeleting ? ' disabled' : ''}>${isDeleting ? 'Deleting...' : 'Confirm delete'}</button>
        </div>
      </div>
    </div>`;
  }

  const deleteCandidateBtn = candidate
    ? `<button type="button" class="delete-btn" data-action="prompt-delete-duplicate" data-target="candidate"${isBusy ? ' disabled' : ''}>Delete candidate</button>`
    : '';

  return `<div class="duplicate-dialog-body">
    ${headerHtml}
    ${errorHtml}
    <div class="duplicate-compare-grid">
      ${flaggedCardHtml}
      ${candidateCardHtml}
    </div>
    <footer class="duplicate-dialog-footer">
      <div class="duplicate-delete-actions">
        <button type="button" class="delete-btn" data-action="prompt-delete-duplicate" data-target="flagged"${isBusy ? ' disabled' : ''}>Delete flagged</button>
        ${deleteCandidateBtn}
      </div>
      <div class="duplicate-resolve-actions">
        <button type="button" class="approve-btn" data-action="dismiss-duplicate"${isBusy ? ' disabled' : ''}>${status === 'dismissing' ? 'Approving...' : 'Not a duplicate'}</button>
      </div>
    </footer>
  </div>`;
}
