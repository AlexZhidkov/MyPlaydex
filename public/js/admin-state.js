/**
 * Pure State & Filtering Helpers for /admin Curation Workspace.
 * Pure Vanilla JS ES2022 module (zero-build, zero side effects).
 */

import {
  ENTITY_TYPES,
  ENTITY_LABELS,
  formatReviewReason,
  isWithinLast24Hours
} from './admin-data.js';

export const VIEWS = Object.freeze({
  UNREVIEWED: 'unreviewed',
  NEW_24H: 'new_24h'
});

const VALID_ENTITY_FILTERS = new Set(['all', ...ENTITY_TYPES]);

/**
 * Creates the initial workspace state defaulting to Unreviewed Listings.
 *
 * @returns {object}
 */
export function createAdminWorkspaceState() {
  return {
    activeView: VIEWS.UNREVIEWED,
    entityFilter: 'all',
    reasonFilter: 'all',
    unreviewed: [],
    newLast24h: [],
    loading: false,
    error: null,
    actionError: null,
    approvingKeys: new Set(),
    deletingKeys: new Set(),
    savingKeys: new Set(),
    deleteDialog: null,
    editDrawer: null,
    lastLoadedAtMs: null
  };
}

/**
 * Switches between Unreviewed Listings and New (Last 24h) views.
 *
 * @param {object} state
 * @param {'unreviewed' | 'new_24h'} view
 * @returns {object}
 */
export function setActiveView(state, view) {
  const nextView = view === VIEWS.NEW_24H ? VIEWS.NEW_24H : VIEWS.UNREVIEWED;
  return {
    ...state,
    activeView: nextView,
    actionError: null
  };
}

/**
 * Sets the active entity-type filter and resets reasonFilter if the new
 * entity slice has zero matches for the previously selected reason.
 *
 * @param {object} state
 * @param {'all' | 'activities' | 'organizers' | 'venues'} entityFilter
 * @returns {object}
 */
export function setEntityFilter(state, entityFilter) {
  const nextEntity = VALID_ENTITY_FILTERS.has(entityFilter) ? entityFilter : 'all';
  let nextReason = state.reasonFilter;

  if (nextReason !== 'all') {
    const options = getReviewReasonOptions(state.unreviewed, nextEntity);
    const hasMatch = options.some((opt) => opt.value === nextReason);
    if (!hasMatch) {
      nextReason = 'all';
    }
  }

  return {
    ...state,
    entityFilter: nextEntity,
    reasonFilter: nextReason,
    actionError: null
  };
}

/**
 * Sets the active review_reason filter.
 *
 * @param {object} state
 * @param {string} reasonFilter
 * @returns {object}
 */
export function setReasonFilter(state, reasonFilter) {
  return {
    ...state,
    reasonFilter: typeof reasonFilter === 'string' && reasonFilter ? reasonFilter : 'all',
    actionError: null
  };
}

/**
 * Computes live counts across all entity types for a listing array.
 *
 * @param {Array<object>} listings
 * @returns {{ all: number, activities: number, organizers: number, venues: number }}
 */
export function getEntityCounts(listings = []) {
  const counts = {
    all: 0,
    activities: 0,
    organizers: 0,
    venues: 0
  };
  for (const item of listings) {
    if (item && typeof item.entityType === 'string' && item.entityType in counts) {
      counts[item.entityType] += 1;
      counts.all += 1;
    }
  }
  return counts;
}

/**
 * Returns sorted review_reason filter options with counts for the active entity slice.
 *
 * @param {Array<object>} unreviewedListings
 * @param {'all' | 'activities' | 'organizers' | 'venues'} [entityFilter='all']
 * @returns {Array<{ value: string, label: string, count: number }>}
 */
export function getReviewReasonOptions(unreviewedListings = [], entityFilter = 'all') {
  const countsByReason = new Map();

  for (const item of unreviewedListings) {
    if (entityFilter !== 'all' && item.entityType !== entityFilter) continue;
    const key = item.reviewReason || 'unspecified';
    countsByReason.set(key, (countsByReason.get(key) || 0) + 1);
  }

  return [...countsByReason.entries()]
    .map(([value, count]) => ({
      value,
      label: formatReviewReason(value === 'unspecified' ? null : value),
      count
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function compareListingsNewestFirst(a, b, preferUpdated = true) {
  const aTime = preferUpdated ? (a.updatedAtMs ?? a.createdAtMs ?? 0) : (a.createdAtMs ?? 0);
  const bTime = preferUpdated ? (b.updatedAtMs ?? b.createdAtMs ?? 0) : (b.createdAtMs ?? 0);
  if (bTime !== aTime) return bTime - aTime;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

/**
 * Filters and sorts Unreviewed Listings by entityFilter and reasonFilter.
 *
 * @param {object} state
 * @returns {Array<object>}
 */
export function getVisibleUnreviewedListings(state) {
  const { unreviewed = [], entityFilter = 'all', reasonFilter = 'all' } = state;
  return unreviewed
    .filter((item) => {
      if (entityFilter !== 'all' && item.entityType !== entityFilter) return false;
      if (reasonFilter !== 'all') {
        const itemReason = item.reviewReason || 'unspecified';
        if (itemReason !== reasonFilter) return false;
      }
      return true;
    })
    .slice()
    .sort((a, b) => compareListingsNewestFirst(a, b, true));
}

/**
 * Builds the strict 24h view model grouped by Activities, Organizers, and Venues.
 *
 * @param {object} state
 * @param {number} [nowMs=Date.now()]
 * @returns {{ counts: { all: number, activities: number, organizers: number, venues: number }, groups: Array<{ entityType: string, label: string, count: number, items: Array<object> }> }}
 */
export function getNewListingsLast24hViewModel(state, nowMs = Date.now()) {
  const fresh = (state.newLast24h || []).filter((item) =>
    isWithinLast24Hours(item.createdAtMs, nowMs)
  );
  const counts = getEntityCounts(fresh);
  const targetTypes = state.entityFilter !== 'all' ? [state.entityFilter] : ENTITY_TYPES;

  const groups = targetTypes.map((entityType) => {
    const items = fresh
      .filter((item) => item.entityType === entityType)
      .slice()
      .sort((a, b) => compareListingsNewestFirst(a, b, false));
    return {
      entityType,
      label: ENTITY_LABELS[entityType],
      count: items.length,
      items
    };
  });

  return { counts, groups };
}

function updateKeySet(keySet, key, shouldAdd) {
  const nextKeys = new Set(keySet);
  if (shouldAdd) {
    nextKeys.add(key);
  } else {
    nextKeys.delete(key);
  }
  return nextKeys;
}

function resolveRemainingReasonFilter(unreviewed, entityFilter, reasonFilter) {
  if (reasonFilter === 'all') return 'all';
  const remainingOptions = getReviewReasonOptions(unreviewed, entityFilter);
  return remainingOptions.some((opt) => opt.value === reasonFilter) ? reasonFilter : 'all';
}

/**
 * Marks a listing key as currently approving (or clears it).
 *
 * @param {object} state
 * @param {string} key
 * @param {boolean} isApproving
 * @returns {object}
 */
export function markApproving(state, key, isApproving) {
  return {
    ...state,
    approvingKeys: updateKeySet(state.approvingKeys, key, isApproving)
  };
}

/**
 * Marks a listing key as currently deleting (or clears it).
 *
 * @param {object} state
 * @param {string} key
 * @param {boolean} isDeleting
 * @returns {object}
 */
export function markDeleting(state, key, isDeleting) {
  return {
    ...state,
    deletingKeys: updateKeySet(state.deletingKeys, key, isDeleting)
  };
}

/**
 * Opens the delete confirmation / linked-Activity protection dialog.
 *
 * @param {object} state
 * @param {{ entityType: string, docId: string, entityId?: string, name?: string }} target
 * @param {'checking' | 'confirm' | 'blocked' | 'deleting' | 'error'} [status='confirm']
 * @returns {object}
 */
export function openDeleteDialog(state, { entityType, docId, entityId = docId, name = docId }, status = 'confirm') {
  return {
    ...state,
    actionError: null,
    deleteDialog: {
      status,
      entityType,
      docId,
      entityId,
      name,
      linkedActivities: [],
      error: null
    }
  };
}

/**
 * Updates fields on the active delete dialog if open.
 *
 * @param {object} state
 * @param {object} patch
 * @returns {object}
 */
export function setDeleteDialogState(state, patch) {
  if (!state.deleteDialog) return state;
  return {
    ...state,
    deleteDialog: {
      ...state.deleteDialog,
      ...patch
    }
  };
}

/**
 * Closes the delete dialog.
 *
 * @param {object} state
 * @returns {object}
 */
export function closeDeleteDialog(state) {
  if (!state.deleteDialog) return state;
  return {
    ...state,
    deleteDialog: null
  };
}

/**
 * Marks a listing key as currently saving (or clears it).
 *
 * @param {object} state
 * @param {string} key
 * @param {boolean} isSaving
 * @returns {object}
 */
export function markSaving(state, key, isSaving) {
  return {
    ...state,
    savingKeys: updateKeySet(state.savingKeys, key, isSaving)
  };
}

/**
 * Opens the edit drawer for a Listing.
 *
 * @param {object} state
 * @param {{ entityType: string, docId: string, originalDoc: object, draft: { readOnly: object, values: object } }} target
 * @returns {object}
 */
export function openEditDrawer(state, { entityType, docId, originalDoc, draft }) {
  return {
    ...state,
    actionError: null,
    editDrawer: {
      status: 'editing',
      entityType,
      docId,
      originalDoc: originalDoc || {},
      readOnly: draft?.readOnly || {},
      values: draft?.values || {},
      fieldErrors: {},
      error: null
    }
  };
}

/**
 * Updates fields on the active edit drawer if open.
 *
 * @param {object} state
 * @param {object} patch
 * @returns {object}
 */
export function setEditDrawerState(state, patch) {
  if (!state.editDrawer) return state;
  return {
    ...state,
    editDrawer: {
      ...state.editDrawer,
      ...patch
    }
  };
}

/**
 * Closes the edit drawer.
 *
 * @param {object} state
 * @returns {object}
 */
export function closeEditDrawer(state) {
  if (!state.editDrawer) return state;
  return {
    ...state,
    editDrawer: null
  };
}

/**
 * Applies a successful Listing save & auto-approve mutation to local state:
 * removes the row from Unreviewed, updates matching row in New (Last 24h), and closes the drawer.
 *
 * @param {object} state
 * @param {'activities' | 'organizers' | 'venues'} entityType
 * @param {string} docId
 * @param {object} updatedListing
 * @returns {object}
 */
export function applyListingSaved(state, entityType, docId, updatedListing) {
  const key = `${entityType}:${docId}`;
  const nextUnreviewed = (state.unreviewed || []).filter((item) => item.key !== key);
  const nextReasonFilter = resolveRemainingReasonFilter(
    nextUnreviewed,
    state.entityFilter,
    state.reasonFilter
  );

  const nextNewLast24h = (state.newLast24h || []).map((item) =>
    item.key === key ? { ...item, ...updatedListing } : item
  );

  return {
    ...state,
    unreviewed: nextUnreviewed,
    newLast24h: nextNewLast24h,
    reasonFilter: nextReasonFilter,
    savingKeys: updateKeySet(state.savingKeys, key, false),
    editDrawer: null,
    actionError: null
  };
}

/**
 * Applies a successful 1-click Approve mutation to local state:
 * removes the row from Unreviewed and marks it reviewed in New (Last 24h).
 *
 * @param {object} state
 * @param {'activities' | 'organizers' | 'venues'} entityType
 * @param {string} docId
 * @param {number} [nowMs=Date.now()]
 * @returns {object}
 */
export function applyListingApproved(state, entityType, docId, nowMs = Date.now()) {
  const key = `${entityType}:${docId}`;
  const nextKeys = updateKeySet(state.approvingKeys, key, false);

  const nextUnreviewed = (state.unreviewed || []).filter((item) => item.key !== key);
  const nextReasonFilter = resolveRemainingReasonFilter(
    nextUnreviewed,
    state.entityFilter,
    state.reasonFilter
  );

  const nextNewLast24h = (state.newLast24h || []).map((item) => {
    if (item.key !== key) return item;
    return {
      ...item,
      needsReview: false,
      reviewReason: null,
      duplicateCandidateId: null,
      updatedAtMs: nowMs
    };
  });

  return {
    ...state,
    unreviewed: nextUnreviewed,
    newLast24h: nextNewLast24h,
    reasonFilter: nextReasonFilter,
    approvingKeys: nextKeys,
    actionError: null
  };
}

/**
 * Applies a successful Listing deletion to local state:
 * removes the row from both Unreviewed and New (Last 24h) and closes the dialog.
 *
 * @param {object} state
 * @param {'activities' | 'organizers' | 'venues'} entityType
 * @param {string} docId
 * @returns {object}
 */
export function applyListingDeleted(state, entityType, docId) {
  const key = `${entityType}:${docId}`;
  const nextUnreviewed = (state.unreviewed || []).filter((item) => item.key !== key);
  const nextNewLast24h = (state.newLast24h || []).filter((item) => item.key !== key);
  const nextReasonFilter = resolveRemainingReasonFilter(
    nextUnreviewed,
    state.entityFilter,
    state.reasonFilter
  );

  return {
    ...state,
    unreviewed: nextUnreviewed,
    newLast24h: nextNewLast24h,
    reasonFilter: nextReasonFilter,
    approvingKeys: updateKeySet(state.approvingKeys, key, false),
    deletingKeys: updateKeySet(state.deletingKeys, key, false),
    deleteDialog: null,
    actionError: null
  };
}
