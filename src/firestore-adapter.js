/**
 * Firestore Ingestion Adapter
 * Provides batched, idempotent upserts into Cloud Firestore with <=500 doc chunking
 * and zero-network dry-run capabilities.
 */

const FIRESTORE_MAX_BATCH_SIZE = 500;

/**
 * Creates a Firestore Ingestion Adapter instance.
 *
 * @param {object} options
 * @param {object} [options.db] - Firestore database instance (e.g. from firebase-admin)
 * @param {boolean} [options.dryRun=false] - Whether to simulate writes without calling Firestore
 * @param {number} [options.batchSize=500] - Batch chunk limit (max 500 per Firestore specs)
 * @param {string} [options.collectionName='activities'] - Destination collection name
 * @returns {object} Adapter with batchUpsertActivities method
 */
export function createFirestoreAdapter(options = {}) {
  const {
    db = null,
    dryRun = !db,
    batchSize = FIRESTORE_MAX_BATCH_SIZE,
    collectionName = 'activities'
  } = options;

  const effectiveBatchSize = Math.min(Math.max(1, batchSize), FIRESTORE_MAX_BATCH_SIZE);

  return {
    isDryRun() {
      return dryRun;
    },

    /**
     * Upserts an array of activity documents in batches.
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

      let upserted = 0;
      let failed = 0;
      let batchCount = 0;
      const errors = [];

      for (let i = 0; i < total; i += effectiveBatchSize) {
        const chunk = activities.slice(i, i + effectiveBatchSize);
        batchCount += 1;

        if (dryRun || !db) {
          upserted += chunk.length;
          continue;
        }

        try {
          const batch = db.batch();
          const colRef = db.collection(collectionName);

          for (const item of chunk) {
            const docRef = colRef.doc(item.id);
            batch.set(docRef, item, { merge: true });
          }

          await batch.commit();
          upserted += chunk.length;
        } catch (err) {
          failed += chunk.length;
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

  if (!rawKey) {
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
    // If firebase-admin is not installed in the environment, fallback to dryRun with warning
    return {
      db: null,
      dryRun: true,
      projectId: credentials?.project_id || null,
      warning: `firebase-admin not installed: ${err.message}`
    };
  }
}
