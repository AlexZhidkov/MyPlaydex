/**
 * Firestore Ingestion Adapter
 * Provides batched, idempotent upserts into Cloud Firestore across canonical collections
 * (/activities, /venues, /organizers, /regions) with <=500 write operations chunking
 * and zero-network dry-run capabilities.
 */

import { extractCanonicalEntities } from './sanitizer.js';

const FIRESTORE_MAX_BATCH_SIZE = 500;

/**
 * Creates a clean copy of an activity document without internal private properties.
 *
 * @param {object} activity
 * @returns {object}
 */
function getCleanActivity(activity) {
  const clean = { ...activity };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('_')) {
      delete clean[key];
    }
  }
  return clean;
}

/**
 * Creates a Firestore Ingestion Adapter instance.
 *
 * @param {object} options
 * @param {object} [options.db] - Firestore database instance (e.g. from firebase-admin)
 * @param {boolean} [options.dryRun=false] - Whether to simulate writes without calling Firestore
 * @param {number} [options.batchSize=500] - Batch chunk limit of write operations (max 500 per Firestore specs)
 * @param {string} [options.collectionName='activities'] - Destination activities collection name
 * @param {string} [options.venuesCollectionName='venues'] - Destination venues collection name
 * @param {string} [options.organizersCollectionName='organizers'] - Destination organizers collection name
 * @param {string} [options.regionsCollectionName='regions'] - Destination regions collection name
 * @returns {object} Adapter with batchUpsertActivities method
 */
export function createFirestoreAdapter(options = {}) {
  const {
    db = null,
    dryRun = !db,
    batchSize = FIRESTORE_MAX_BATCH_SIZE,
    collectionName = 'activities',
    venuesCollectionName = 'venues',
    organizersCollectionName = 'organizers',
    regionsCollectionName = 'regions'
  } = options;

  // Minimum batch size of 4 ensures atomic write of activity + venue + organizer + region
  const effectiveBatchSize = Math.min(Math.max(4, batchSize), FIRESTORE_MAX_BATCH_SIZE);

  return {
    isDryRun() {
      return dryRun;
    },

    /**
     * Batch-retrieves existing activity records from Firestore for deduplication.
     *
     * @param {Array<string>} ids - Array of activity IDs
     * @returns {Promise<Map<string, object>>} Map of id -> document data
     */
    async getActivities(ids = []) {
      if (!ids.length || dryRun || !db) {
        return new Map();
      }

      const result = new Map();
      const chunkSize = 500;

      for (let i = 0; i < ids.length; i += chunkSize) {
        const chunkIds = ids.slice(i, i + chunkSize);
        const docRefs = chunkIds.map(id => db.collection(collectionName).doc(id));

        try {
          if (typeof db.getAll === 'function') {
            const snapshots = await db.getAll(...docRefs);
            for (const snap of snapshots) {
              if (snap && snap.exists) {
                result.set(snap.id, snap.data());
              }
            }
          } else {
            const snapshots = await Promise.all(docRefs.map(ref => ref.get()));
            for (const snap of snapshots) {
              if (snap && snap.exists) {
                result.set(snap.id, snap.data());
              }
            }
          }
        } catch {
          // If retrieval fails, return partial or empty map
        }
      }

      return result;
    },

    /**
     * Upserts an array of activity documents and their canonical entities in batches.
     * Atomically updates /activities, /venues, /organizers, and /regions collections.
     *
     * @param {Array<object>} activities
     * @returns {Promise<{ total: number, upserted: number, failed: number, batches: number, errors: Array<Error>, dryRun: boolean }>}
     */
    async batchUpsertActivities(activities = []) {
      const total = activities.length;
      if (total === 0) {
        return {
          total: 0,
          upserted: 0,
          failed: 0,
          batches: 0,
          errors: [],
          dryRun
        };
      }

      // Group activities into multi-collection batches where operations count <= effectiveBatchSize
      // and each activity's related entities are committed in the same atomic batch write
      const batches = [];
      let currentBatchOps = new Map();
      let currentBatchActivities = [];

      for (const item of activities) {
        const entities = item._canonicalEntities || extractCanonicalEntities(item);
        const cleanActivity = getCleanActivity(entities.activity || item);

        // Candidate operations for this activity
        const candidateOps = [];

        // 1. Activity doc
        if (cleanActivity.id) {
          candidateOps.push({
            col: collectionName,
            id: cleanActivity.id,
            data: cleanActivity
          });
        }

        // 2. Venue doc
        if (entities.venue && entities.venue.id) {
          candidateOps.push({
            col: venuesCollectionName,
            id: entities.venue.id,
            data: entities.venue
          });
        }

        // 3. Organizer doc
        if (entities.organizer && entities.organizer.id) {
          candidateOps.push({
            col: organizersCollectionName,
            id: entities.organizer.id,
            data: entities.organizer
          });
        }

        // 4. Region doc
        if (entities.region && entities.region.id) {
          candidateOps.push({
            col: regionsCollectionName,
            id: entities.region.id,
            data: entities.region
          });
        }

        // Calculate how many new ops would be added
        let newOpsCount = 0;
        for (const op of candidateOps) {
          const key = `${op.col}/${op.id}`;
          if (!currentBatchOps.has(key)) {
            newOpsCount += 1;
          }
        }

        // If adding these operations would exceed effectiveBatchSize, flush current batch
        if (currentBatchOps.size > 0 && currentBatchOps.size + newOpsCount > effectiveBatchSize) {
          batches.push({
            ops: Array.from(currentBatchOps.values()),
            activities: currentBatchActivities
          });
          currentBatchOps = new Map();
          currentBatchActivities = [];
        }

        // Add all candidate operations atomically to the current batch
        for (const op of candidateOps) {
          const key = `${op.col}/${op.id}`;
          currentBatchOps.set(key, op);
        }
        currentBatchActivities.push(item);
      }

      if (currentBatchOps.size > 0) {
        batches.push({
          ops: Array.from(currentBatchOps.values()),
          activities: currentBatchActivities
        });
      }

      const batchCount = batches.length;

      if (dryRun || !db) {
        return {
          total,
          upserted: total,
          failed: 0,
          batches: batchCount,
          errors: [],
          dryRun
        };
      }

      let upserted = 0;
      let failed = 0;
      const errors = [];

      for (const batchPlan of batches) {
        try {
          const batch = db.batch();
          for (const op of batchPlan.ops) {
            const docRef = db.collection(op.col).doc(op.id);
            batch.set(docRef, op.data, { merge: true });
          }

          await batch.commit();
          upserted += batchPlan.activities.length;
        } catch (err) {
          failed += batchPlan.activities.length;
          errors.push(err);
        }
      }

      return {
        total,
        upserted,
        failed,
        batches: batchCount,
        errors,
        dryRun
      };
    }
  };
}

/**
 * Initializes Firestore instance from environment variable credentials if available.
 * Reads service account JSON or base64 credentials from FIREBASE_SERVICE_ACCOUNT_KEY.
 *
 * @param {object} [env=process.env]
 * @param {object} [options]
 * @param {boolean} [options.requireCredentials=false]
 * @returns {Promise<{ db: object | null, dryRun: boolean, projectId: string | null }>}
 */
export async function initFirestoreFromEnv(env = process.env, options = {}) {
  const rawKey = env.FIREBASE_SERVICE_ACCOUNT_KEY;
  const useAdc = options.useAdc || env.FIREBASE_USE_ADC === 'true' || Boolean(env.FIREBASE_PROJECT_ID);
  const projectId = env.FIREBASE_PROJECT_ID || options.projectId || (useAdc ? 'myplaydex' : null);

  if (!rawKey) {
    if (useAdc) {
      try {
        const adminApp = await import('firebase-admin/app');
        const adminFirestore = await import('firebase-admin/firestore');

        const app = adminApp.getApps().length > 0
          ? adminApp.getApps()[0]
          : adminApp.initializeApp({
              credential: adminApp.applicationDefault(),
              projectId: projectId || 'myplaydex'
            });

        const db = adminFirestore.getFirestore(app);
        return {
          db,
          dryRun: false,
          projectId: projectId || 'myplaydex'
        };
      } catch (err) {
        if (options.requireCredentials) {
          throw new Error(`Failed to initialize Firestore via ADC: ${err.message}`);
        }
        return { db: null, dryRun: true, projectId: null };
      }
    }

    if (options.requireCredentials) {
      throw new Error('Missing required secret: FIREBASE_SERVICE_ACCOUNT_KEY is required to write to Firestore');
    }
    return { db: null, dryRun: true, projectId: null };
  }

  let credentials;
  try {
    const trimmed = rawKey.trim();
    if (trimmed.startsWith('{')) {
      credentials = JSON.parse(trimmed);
    } else {
      // Decode base64 string
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
      credentials = JSON.parse(decoded);
    }
  } catch (err) {
    throw new Error(`Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY: ${err.message}`);
  }

  try {
    const adminApp = await import('firebase-admin/app');
    const adminFirestore = await import('firebase-admin/firestore');

    const app = adminApp.getApps().length > 0
      ? adminApp.getApps()[0]
      : adminApp.initializeApp({
          credential: adminApp.cert(credentials)
        });

    const db = adminFirestore.getFirestore(app);
    return {
      db,
      dryRun: false,
      projectId: credentials.project_id || null
    };
  } catch (err) {
    return {
      db: null,
      dryRun: true,
      projectId: credentials?.project_id || null,
      warning: `firebase-admin not installed: ${err.message}`
    };
  }
}
