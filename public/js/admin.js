/**
 * Protected /admin Workspace Controller for MyPlaydex.
 * Pure Vanilla JS ES2022 module (zero-build, CDN modular ESM).
 */

import { isBrowserEnvironment } from './analytics.js';
import {
  LOGIN_ROUTE,
  resolveCurrentUser,
  loadFirebaseAuthClient,
  defaultNavigate,
  onDomReady
} from './auth-client.js';
import {
  loadFirebaseFirestoreClient,
  createAdminFirestoreRepository,
  requiresLinkedActivityCheck
} from './admin-data.js';
import {
  createAdminWorkspaceState,
  setActiveView,
  setEntityFilter,
  setReasonFilter,
  markApproving,
  markDeleting,
  openDeleteDialog,
  setDeleteDialogState,
  closeDeleteDialog,
  applyListingApproved,
  applyListingDeleted
} from './admin-state.js';
import { renderWorkspaceHtml, renderDeleteDialogHtml } from './admin-ui.js';

/**
 * Executes the /admin session guard and wires the sign-out action.
 *
 * @param {object} deps
 * @returns {Promise<{ status: string, email?: string, handleSignOut?: () => Promise<void>, error?: unknown }>}
 */
export async function runAdminController(deps) {
  const {
    auth,
    browserLocalPersistence,
    setPersistence,
    signOut,
    onAuthStateChanged,
    navigate = defaultNavigate,
    setStatus = () => {},
    onAuthorized = () => {},
    onSignedOut = () => {}
  } = deps;

  try {
    await setPersistence(auth, browserLocalPersistence);
    const user = await resolveCurrentUser(auth, onAuthStateChanged);

    if (!user) {
      setStatus('Redirecting to sign in...');
      navigate(LOGIN_ROUTE);
      return { status: 'redirected-to-login' };
    }

    const tokenResult = await user.getIdTokenResult();
    if (tokenResult?.claims?.admin !== true) {
      await signOut(auth);
      setStatus('Access denied.');
      return { status: 'access-denied' };
    }

    const email = user.email ?? '';
    setStatus('');
    onAuthorized({ email });

    const handleSignOut = async () => {
      try {
        await signOut(auth);
        onSignedOut();
        setStatus('Signed out.');
      } catch {
        setStatus('Unable to sign out right now. Please try again.');
      }
    };

    return { status: 'authorized', email, handleSignOut };
  } catch (error) {
    setStatus('Unable to verify admin session right now. Please try again.');
    return { status: 'error', error };
  }
}

/**
 * Creates the stateful /admin curation controller coordinating Firestore loads,
 * view/filter transitions, and 1-click Approve mutations.
 *
 * @param {object} deps
 * @param {object} deps.repository
 * @param {(state: object) => void} [deps.onStateChange]
 * @param {() => number} [deps.now]
 */
export function createAdminWorkspaceController({
  repository,
  onStateChange = () => {},
  now = () => Date.now()
}) {
  let state = createAdminWorkspaceState();

  function commit(nextState) {
    state = nextState;
    onStateChange(state);
    return state;
  }

  return {
    getState() {
      return state;
    },

    async loadAll() {
      commit({ ...state, loading: true, error: null, actionError: null });
      try {
        const nowMs = now();
        const [unreviewed, newLast24h] = await Promise.all([
          repository.fetchUnreviewedListings(),
          repository.fetchNewListingsLast24h(nowMs)
        ]);
        return commit({
          ...state,
          unreviewed,
          newLast24h,
          loading: false,
          error: null,
          lastLoadedAtMs: nowMs
        });
      } catch {
        return commit({
          ...state,
          loading: false,
          error: 'Unable to load listings right now. Please try refreshing.'
        });
      }
    },

    selectView(view) {
      return commit(setActiveView(state, view));
    },

    selectEntityFilter(entityFilter) {
      return commit(setEntityFilter(state, entityFilter));
    },

    selectReasonFilter(reasonFilter) {
      return commit(setReasonFilter(state, reasonFilter));
    },

    async approve(entityType, docId) {
      const key = `${entityType}:${docId}`;
      if (state.approvingKeys.has(key) || state.deletingKeys.has(key)) return state;

      commit({ ...markApproving(state, key, true), actionError: null });
      try {
        await repository.approveListing(entityType, docId);
        return commit(applyListingApproved(state, entityType, docId, now()));
      } catch {
        return commit({
          ...markApproving(state, key, false),
          actionError: 'Unable to approve this listing right now. Please try again.'
        });
      }
    },

    async requestDelete(entityType, docId) {
      const key = `${entityType}:${docId}`;
      const listing =
        state.unreviewed.find((item) => item.key === key) ||
        state.newLast24h.find((item) => item.key === key) ||
        { entityType, docId, id: docId, name: docId };

      const target = {
        entityType,
        docId,
        entityId: listing.id || docId,
        name: listing.name || docId
      };

      if (!requiresLinkedActivityCheck(entityType)) {
        return commit(openDeleteDialog(state, target, 'confirm'));
      }

      const isActiveDialogForTarget = () =>
        state.deleteDialog &&
        state.deleteDialog.entityType === entityType &&
        state.deleteDialog.docId === docId;

      commit(openDeleteDialog(state, target, 'checking'));
      try {
        const linkedActivities = await repository.findLinkedActivities(entityType, target.entityId);
        if (!isActiveDialogForTarget()) return state;
        if (linkedActivities.length > 0) {
          return commit(
            setDeleteDialogState(state, {
              status: 'blocked',
              linkedActivities,
              error: null
            })
          );
        }
        return commit(
          setDeleteDialogState(state, {
            status: 'confirm',
            linkedActivities: [],
            error: null
          })
        );
      } catch {
        if (!isActiveDialogForTarget()) return state;
        return commit(
          setDeleteDialogState(state, {
            status: 'error',
            error: 'Unable to check linked Activities right now. Please try again.'
          })
        );
      }
    },

    cancelDelete() {
      return commit(closeDeleteDialog(state));
    },

    async confirmDelete() {
      const dialog = state.deleteDialog;
      if (!dialog || dialog.status !== 'confirm') return state;

      const key = `${dialog.entityType}:${dialog.docId}`;
      commit(
        setDeleteDialogState(markDeleting(state, key, true), {
          status: 'deleting',
          error: null
        })
      );

      try {
        const result = await repository.deleteListing(dialog.entityType, dialog.docId, {
          entityId: dialog.entityId
        });
        if (result?.blocked) {
          return commit(
            setDeleteDialogState(markDeleting(state, key, false), {
              status: 'blocked',
              linkedActivities: result.linkedActivities || [],
              error: null
            })
          );
        }
        return commit(applyListingDeleted(state, dialog.entityType, dialog.docId));
      } catch {
        return commit(
          setDeleteDialogState(markDeleting(state, key, false), {
            status: 'confirm',
            error: 'Unable to delete this listing right now. Please try again.'
          })
        );
      }
    }
  };
}

function bindWorkspaceEvents(curationEl, deleteDialogEl, controller) {
  curationEl.addEventListener('click', (event) => {
    const target = event.target?.closest?.('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    if (action === 'switch-view') {
      controller.selectView(target.dataset.view);
    } else if (action === 'filter-entity') {
      controller.selectEntityFilter(target.dataset.entityFilter);
    } else if (action === 'refresh') {
      controller.loadAll();
    } else if (action === 'approve') {
      controller.approve(target.dataset.entityType, target.dataset.docId);
    } else if (action === 'delete') {
      controller.requestDelete(target.dataset.entityType, target.dataset.docId);
    }
  });

  curationEl.addEventListener('change', (event) => {
    const target = event.target;
    if (target?.dataset?.action === 'filter-reason') {
      controller.selectReasonFilter(target.value);
    }
  });

  if (deleteDialogEl) {
    deleteDialogEl.addEventListener('click', (event) => {
      const target = event.target?.closest?.('[data-action]');
      if (!target) return;

      const action = target.dataset.action;
      if (action === 'cancel-delete') {
        controller.cancelDelete();
      } else if (action === 'confirm-delete') {
        controller.confirmDelete();
      }
    });

    deleteDialogEl.addEventListener('close', () => {
      deleteDialogEl.returnValue = '';
      if (controller.getState().deleteDialog) {
        controller.cancelDelete();
      }
    });
  }
}

function resetDeleteDialogElement(deleteDialogEl) {
  if (!deleteDialogEl) return;
  if (deleteDialogEl.open && typeof deleteDialogEl.close === 'function') {
    deleteDialogEl.close();
  }
  deleteDialogEl.innerHTML = '';
}

/**
 * Initializes the /admin page in the browser.
 *
 * @param {object} [options={}]
 * @returns {Promise<{ status: string, email?: string, handleSignOut?: () => Promise<void>, error?: unknown }>}
 */
export async function initAdminPage(options = {}) {
  const doc = typeof document !== 'undefined' ? document : null;
  const statusEl = options.statusEl ?? doc?.getElementById('admin-status') ?? null;
  const workspaceEl = options.workspaceEl ?? doc?.getElementById('admin-workspace') ?? null;
  const emailEl = options.emailEl ?? doc?.getElementById('admin-email') ?? null;
  const signOutBtn = options.signOutBtn ?? doc?.getElementById('sign-out-btn') ?? null;
  const curationEl = options.curationEl ?? doc?.getElementById('admin-curation') ?? null;
  const deleteDialogEl = options.deleteDialogEl ?? doc?.getElementById('admin-delete-dialog') ?? null;

  const setStatus = options.setStatus ?? ((message) => {
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.hidden = message.length === 0;
    }
  });
  const loadClient = options.loadClient ?? loadFirebaseAuthClient;
  const loadFirestore = options.loadFirestoreClient ?? loadFirebaseFirestoreClient;

  try {
    const { authSdk, auth } = await loadClient();

    const result = await runAdminController({
      auth,
      browserLocalPersistence: authSdk.browserLocalPersistence,
      setPersistence: authSdk.setPersistence,
      signOut: authSdk.signOut,
      onAuthStateChanged: authSdk.onAuthStateChanged,
      navigate: options.navigate,
      setStatus,
      onAuthorized: ({ email }) => {
        if (emailEl) emailEl.textContent = email;
        if (workspaceEl) workspaceEl.hidden = false;
      },
      onSignedOut: () => {
        if (workspaceEl) workspaceEl.hidden = true;
        if (emailEl) emailEl.textContent = '';
        if (curationEl) curationEl.innerHTML = '';
        resetDeleteDialogElement(deleteDialogEl);
      }
    });

    if (result.status === 'authorized') {
      if (signOutBtn && typeof result.handleSignOut === 'function') {
        signOutBtn.addEventListener('click', async () => {
          signOutBtn.disabled = true;
          await result.handleSignOut();
          signOutBtn.disabled = false;
        });
      }

      if (curationEl) {
        const { firestoreSdk, db } = await loadFirestore();
        const repository = createAdminFirestoreRepository({ db, firestoreSdk });
        const controller = createAdminWorkspaceController({
          repository,
          onStateChange: (nextState) => {
            curationEl.innerHTML = renderWorkspaceHtml(nextState);
            if (deleteDialogEl) {
              if (nextState.deleteDialog) {
                deleteDialogEl.innerHTML = renderDeleteDialogHtml(nextState.deleteDialog);
                if (!deleteDialogEl.open && typeof deleteDialogEl.showModal === 'function') {
                  deleteDialogEl.showModal();
                }
              } else {
                resetDeleteDialogElement(deleteDialogEl);
              }
            }
          }
        });
        bindWorkspaceEvents(curationEl, deleteDialogEl, controller);
        await controller.loadAll();
      }
    }

    return result;
  } catch (error) {
    setStatus('Unable to verify admin session right now. Please try again.');
    return { status: 'error', error };
  }
}

if (isBrowserEnvironment()) {
  onDomReady(() => initAdminPage());
}
