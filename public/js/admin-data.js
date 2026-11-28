/**
 * Firestore Data Access & Normalization for /admin Workspace.
 * Pure Vanilla JS ES2022 module (zero-build, CDN modular ESM).
 * Uses single-field queries and client-side sorting/filtering so no custom
 * composite Firestore indexes are required.
 */

import {
  FIREBASE_SDK_VERSION,
  FIREBASE_APP_CDN_URL
} from './analytics.js';
import { FIREBASE_AUTH_CONFIG } from './auth-client.js';
import { normalizeCuratedFields } from '../shared/listing-domain.js';
import { buildListingSavePayload, buildCascadeActivityUpdate } from './admin-edit.js';

export const FIREBASE_FIRESTORE_CDN_URL = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`;

export const FIRESTORE_BATCH_LIMIT = 500;

export const ENTITY_TYPES = Object.freeze(['activities', 'organizers', 'venues']);

export const ENTITY_LABELS = Object.freeze({
  activities: 'Activities',
  organizers: 'Organizers',
  venues: 'Venues'
});

const LINKED_ACTIVITY_FIELD_BY_ENTITY = Object.freeze({
  venues: 'venue.id',
  organizers: 'organizer.id'
});

/**
 * Returns true if deleting this entity type requires checking for linked Activities.
 *
 * @param {string} entityType
 * @returns {boolean}
 */
export function requiresLinkedActivityCheck(entityType) {
  return Object.hasOwn(LINKED_ACTIVITY_FIELD_BY_ENTITY, entityType);
}

function validateEntityAndDocId(entityType, docId) {
  if (!ENTITY_TYPES.includes(entityType)) {
    throw new Error(`Invalid entityType: ${entityType}`);
  }
  if (typeof docId !== 'string' || !docId.trim()) {
    throw new Error('docId is required');
  }
}

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export const REVIEW_REASON_LABELS = Object.freeze({
  unmatched_venue: 'Unmatched venue',
  uncertain_venue_match: 'Uncertain venue match',
  unmatched_organizer: 'Unmatched organizer',
  uncertain_organizer_match: 'Uncertain organizer match',
  crawler_created: 'Crawler created',
  possible_duplicate: 'Possible duplicate',
  missing_start_time: 'Missing start time',
  low_confidence: 'Low confidence'
});

/**
 * Formats a review_reason slug into a sentence-case human-readable label.
 *
 * @param {string | null | undefined} reason
 * @returns {string}
 */
export function formatReviewReason(reason) {
  if (typeof reason !== 'string' || !reason.trim()) {
    return 'Unspecified';
  }
  const normalized = reason.trim();
  if (REVIEW_REASON_LABELS[normalized]) {
    return REVIEW_REASON_LABELS[normalized];
  }
  const words = normalized.replaceAll('_', ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Converts Firestore Timestamp, plain seconds object, Date, ISO string,
 * or epoch number into epoch milliseconds (or null if invalid).
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function toEpochMs(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof value === 'object') {
    if (typeof value.toMillis === 'function') {
      const ms = value.toMillis();
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value.toDate === 'function') {
      const d = value.toDate();
      const ms = d instanceof Date ? d.getTime() : NaN;
      return Number.isFinite(ms) ? ms : null;
    }
    const seconds = typeof value.seconds === 'number' ? value.seconds : value._seconds;
    const nanoseconds = typeof value.nanoseconds === 'number' ? value.nanoseconds : value._nanoseconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      const ns = typeof nanoseconds === 'number' && Number.isFinite(nanoseconds) ? nanoseconds : 0;
      return seconds * 1000 + Math.floor(ns / 1_000_000);
    }
  }

  return null;
}

/**
 * Checks whether a timestamp falls strictly within the last 24 hours of nowMs.
 *
 * @param {number | null | undefined} createdAtMs
 * @param {number} [nowMs=Date.now()]
 * @returns {boolean}
 */
export function isWithinLast24Hours(createdAtMs, nowMs = Date.now()) {
  return (
    typeof createdAtMs === 'number' &&
    Number.isFinite(createdAtMs) &&
    createdAtMs >= nowMs - TWENTY_FOUR_HOURS_MS
  );
}

/**
 * Normalizes a raw Firestore document from activities, organizers, or venues
 * into a uniform admin Listing view model.
 *
 * @param {'activities' | 'organizers' | 'venues'} entityType
 * @param {string} docId
 * @param {Record<string, any>} [data={}]
 * @returns {object}
 */
export function normalizeListingDoc(entityType, docId, data = {}) {
  const safeData = data && typeof data === 'object' ? data : {};
  return {
    id: safeData.id || docId,
    docId,
    entityType,
    key: `${entityType}:${docId}`,
    name: safeData.title || safeData.name || docId,
    category: safeData.category || '',
    subcategory: safeData.subcategory || '',
    subcategories: Array.isArray(safeData.subcategories) ? safeData.subcategories : [],
    source: safeData.source || '',
    sourceId: safeData.source_id || '',
    sourceUrl: safeData.source_url || safeData.website || null,
    verified: Boolean(safeData.verified),
    needsReview: Boolean(safeData.needs_review),
    reviewReason: safeData.review_reason || null,
    duplicateCandidateId: safeData.duplicate_candidate_id || null,
    curatedFields: normalizeCuratedFields(safeData.curated_fields),
    organizerName: safeData.organizer?.name || '',
    venueName: safeData.venue?.name || '',
    address: safeData.address || '',
    schedule: safeData.schedule || null,
    createdAtMs: toEpochMs(safeData.created_at),
    updatedAtMs: toEpochMs(safeData.updated_at),
    raw: safeData
  };
}

/**
 * Loads Firebase App and Firestore modular SDKs from the official CDN and
 * returns the initialized Firestore instance.
 *
 * @returns {Promise<{ appSdk: object, firestoreSdk: object, db: object }>}
 */
export async function loadFirebaseFirestoreClient() {
  const [appSdk, firestoreSdk] = await Promise.all([
    import(FIREBASE_APP_CDN_URL),
    import(FIREBASE_FIRESTORE_CDN_URL)
  ]);
  const existingApps = typeof appSdk.getApps === 'function' ? appSdk.getApps() : [];
  const app = existingApps.length > 0 ? existingApps[0] : appSdk.initializeApp(FIREBASE_AUTH_CONFIG);
  const db = firestoreSdk.getFirestore(app);
  return { appSdk, firestoreSdk, db };
}

/**
 * Creates a Firestore repository for /admin curation using single-field queries.
 *
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} deps.firestoreSdk
 * @param {() => number} [deps.now]
 */
export function createAdminFirestoreRepository({ db, firestoreSdk, now = () => Date.now() }) {
  async function querySingleFieldAcrossCollections(field, op, value) {
    const snapshots = await Promise.all(
      ENTITY_TYPES.map((entityType) => {
        const colRef = firestoreSdk.collection(db, entityType);
        const q = firestoreSdk.query(colRef, firestoreSdk.where(field, op, value));
        return firestoreSdk.getDocs(q).then((snap) =>
          (snap?.docs || []).map((docSnap) =>
            normalizeListingDoc(
              entityType,
              docSnap.id,
              typeof docSnap.data === 'function' ? docSnap.data() : docSnap.data
            )
          )
        );
      })
    );
    return snapshots.flat();
  }

  return {
    async fetchUnreviewedListings() {
      return querySingleFieldAcrossCollections('needs_review', '==', true);
    },

    async fetchNewListingsLast24h(nowMs = now()) {
      const cutoffDate = new Date(nowMs - TWENTY_FOUR_HOURS_MS);
      const cutoffValue = typeof firestoreSdk.Timestamp?.fromDate === 'function'
        ? firestoreSdk.Timestamp.fromDate(cutoffDate)
        : cutoffDate;
      const items = await querySingleFieldAcrossCollections('created_at', '>=', cutoffValue);
      return items.filter((item) => isWithinLast24Hours(item.createdAtMs, nowMs));
    },

    async fetchListingById(entityType, docId) {
      validateEntityAndDocId(entityType, docId);
      const docRef = firestoreSdk.doc(db, entityType, docId);
      const docSnap = await firestoreSdk.getDoc(docRef);
      const exists = typeof docSnap?.exists === 'function' ? docSnap.exists() : Boolean(docSnap?.exists);
      if (!exists) return null;
      const raw = typeof docSnap.data === 'function' ? docSnap.data() : docSnap.data;
      return normalizeListingDoc(entityType, docSnap.id || docId, raw);
    },

    async fetchCanonicalEntities(entityType) {
      if (entityType !== 'venues' && entityType !== 'organizers') {
        throw new Error(`Invalid canonical entityType: ${entityType}`);
      }
      const colRef = firestoreSdk.collection(db, entityType);
      const snap = await firestoreSdk.getDocs(colRef);
      return (snap?.docs || [])
        .map((docSnap) =>
          normalizeListingDoc(
            entityType,
            docSnap.id,
            typeof docSnap.data === 'function' ? docSnap.data() : docSnap.data
          )
        )
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },

    async approveListing(entityType, docId) {
      validateEntityAndDocId(entityType, docId);

      const docRef = firestoreSdk.doc(db, entityType, docId);
      await firestoreSdk.updateDoc(docRef, {
        needs_review: false,
        review_reason: null,
        duplicate_candidate_id: firestoreSdk.deleteField(),
        updated_at: firestoreSdk.serverTimestamp()
      });
    },

    async findLinkedActivities(entityType, entityId) {
      validateEntityAndDocId(entityType, entityId);
      const linkedField = LINKED_ACTIVITY_FIELD_BY_ENTITY[entityType];
      if (!linkedField) return [];

      const colRef = firestoreSdk.collection(db, 'activities');
      const q = firestoreSdk.query(colRef, firestoreSdk.where(linkedField, '==', entityId));
      const snap = await firestoreSdk.getDocs(q);

      return (snap?.docs || [])
        .map((docSnap) => {
          const raw = typeof docSnap.data === 'function' ? docSnap.data() : docSnap.data;
          const safeData = raw && typeof raw === 'object' ? raw : {};
          return {
            id: safeData.id || docSnap.id,
            docId: docSnap.id,
            title: safeData.title || docSnap.id
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    },

    async deleteListing(entityType, docId, { entityId = docId } = {}) {
      validateEntityAndDocId(entityType, docId);

      if (requiresLinkedActivityCheck(entityType)) {
        const linkedActivities = await this.findLinkedActivities(entityType, entityId);
        if (linkedActivities.length > 0) {
          return { deleted: false, blocked: true, linkedActivities };
        }
      }

      const docRef = firestoreSdk.doc(db, entityType, docId);
      await firestoreSdk.deleteDoc(docRef);
      return { deleted: true, blocked: false, linkedActivities: [] };
    },

    async saveListing(entityType, docId, originalDoc, parsedValues) {
      validateEntityAndDocId(entityType, docId);

      const timestampFromDate = typeof firestoreSdk.Timestamp?.fromDate === 'function'
        ? (d) => firestoreSdk.Timestamp.fromDate(d)
        : (d) => d;

      const result = buildListingSavePayload(entityType, originalDoc, parsedValues, {
        timestampFromDate,
        serverTimestamp: () => firestoreSdk.serverTimestamp(),
        deleteField: () => firestoreSdk.deleteField()
      });

      const docRef = firestoreSdk.doc(db, entityType, docId);
      await firestoreSdk.updateDoc(docRef, result.updatePayload);

      const cascade = buildCascadeActivityUpdate(entityType, originalDoc, result.nextRawDoc, {
        serverTimestamp: () => firestoreSdk.serverTimestamp()
      });

      if (cascade && typeof firestoreSdk.getDocs === 'function') {
        const entityId = originalDoc?.id || docId;
        const linkedActivities = await this.findLinkedActivities(entityType, entityId);
        if (linkedActivities.length > 0) {
          if (typeof firestoreSdk.writeBatch === 'function') {
            for (let i = 0; i < linkedActivities.length; i += FIRESTORE_BATCH_LIMIT) {
              const chunk = linkedActivities.slice(i, i + FIRESTORE_BATCH_LIMIT);
              const batch = firestoreSdk.writeBatch(db);
              for (const act of chunk) {
                batch.update(
                  firestoreSdk.doc(db, 'activities', act.docId),
                  cascade.activityUpdatePayload
                );
              }
              await batch.commit();
            }
          } else {
            await Promise.all(
              linkedActivities.map((act) =>
                firestoreSdk.updateDoc(
                  firestoreSdk.doc(db, 'activities', act.docId),
                  cascade.activityUpdatePayload
                )
              )
            );
          }
        }
        return {
          ...result,
          cascadedActivityCount: linkedActivities.length,
          cascadedActivityIds: linkedActivities.map((act) => act.docId)
        };
      }

      return {
        ...result,
        cascadedActivityCount: 0,
        cascadedActivityIds: []
      };
    }
  };
}
