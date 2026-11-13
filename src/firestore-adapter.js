/**
 * Firestore Ingestion Adapter
 * Provides batched, idempotent upserts into Cloud Firestore across canonical collections
 * (/activities, /venues, /organizers, /regions) with <=500 write operations chunking
 * and zero-network dry-run capabilities.
 */

import { extractCanonicalEntities, mergeEntityDocuments, resolveListingType } from './sanitizer.js';

const FIRESTORE_MAX_BATCH_SIZE = 500;

/**
 * Resolves the target Firestore collection name from a listing document ID prefix.
 *
 * @param {string} id
 * @param {string} [defaultCollection='activities']
 * @param {object} [collections]
 * @returns {string}
 */
export function resolveCollectionForListingId(id, defaultCollection = 'activities', collections = {}) {
  const organizersCol = collections.organizersCollectionName || 'organizers';
  const venuesCol = collections.venuesCollectionName || 'venues';
  if (typeof id === 'string') {
    if (id.startsWith('org_')) return organizersCol;
    if (id.startsWith('venue_')) return venuesCol;
  }
  return defaultCollection;
}

/**
 * Creates a clean copy of a listing document without internal private properties.
 *
 * @param {object} doc
 * @returns {object}
 */
function getCleanDocument(doc) {
  const clean = { ...doc };
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

  /**
   * Resolves the target Firestore collection name from a document ID prefix.
   *
   * @param {string} id
   * @param {string} [defaultCollection=collectionName]
   * @returns {string}
   */
  function resolveCollectionForId(id, defaultCollection = collectionName) {
    return resolveCollectionForListingId(id, defaultCollection, {
      organizersCollectionName,
      venuesCollectionName
    });
  }

  /**
   * Batch-retrieves existing records from Firestore by ID, routing `org_*` and `venue_*`
   * prefixes to their respective collections.
   *
   * @param {Array<string>} ids
   * @param {string} [defaultCollection=collectionName]
   * @returns {Promise<Map<string, object>>}
   */
  async function getRecordsByIds(ids = [], defaultCollection = collectionName) {
    if (!ids.length || dryRun || !db) {
      return new Map();
    }

    const result = new Map();
    const chunkSize = 500;

    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunkIds = ids.slice(i, i + chunkSize);
      const docRefs = chunkIds.map(id => db.collection(resolveCollectionForId(id, defaultCollection)).doc(id));

      try {
        const snapshots = typeof db.getAll === 'function'
          ? await db.getAll(...docRefs)
          : await Promise.all(docRefs.map(ref => ref.get()));

        for (const snap of snapshots) {
          if (snap && snap.exists) {
            result.set(snap.id, snap.data());
          }
        }
      } catch {
        // If retrieval fails, return partial or empty map
      }
    }

    return result;
  }

  /**
   * Scans documents from a specified Firestore collection.
   *
   * @param {string} targetCollection
   * @param {object} [scanOptions={}]
   * @returns {Promise<Array<object>>}
   */
  async function scanCollection(targetCollection, scanOptions = {}) {
    if (!db) {
      return [];
    }

    const { onlyUnverified = false } = scanOptions;
    const snapshot = await db.collection(targetCollection).get();
    const records = [];
    const docs = snapshot && snapshot.docs ? snapshot.docs : [];

    for (const doc of docs) {
      const data = typeof doc.data === 'function' ? doc.data() : doc;
      const record = { id: doc.id, ...data };
      if (!onlyUnverified || record.verified !== true) {
        records.push(record);
      }
    }

    return records;
  }

  /**
   * Batch-updates URL verification state across target collection(s).
   *
   * @param {Array<object>} updates
   * @param {string} [defaultCollection=collectionName]
   * @returns {Promise<{ total: number, updated: number, failed: number, batches: number, errors: Array<Error>, dryRun: boolean }>}
   */
  async function batchUpdateUrls(updates = [], defaultCollection = collectionName) {
    const total = updates.length;
    if (total === 0) {
      return { total: 0, updated: 0, failed: 0, batches: 0, errors: [], dryRun };
    }

    const updateBatchSize = Math.min(Math.max(1, batchSize), FIRESTORE_MAX_BATCH_SIZE);
    const chunks = [];
    for (let i = 0; i < total; i += updateBatchSize) {
      chunks.push(updates.slice(i, i + updateBatchSize));
    }

    if (dryRun || !db) {
      return { total, updated: total, failed: 0, batches: chunks.length, errors: [], dryRun };
    }

    let updated = 0;
    let failed = 0;
    const errors = [];
    const nowIso = new Date().toISOString();

    for (const chunk of chunks) {
      try {
        const batch = db.batch();
        for (const item of chunk) {
          const targetCol = resolveCollectionForId(item.id, defaultCollection);
          const docRef = db.collection(targetCol).doc(item.id);
          const updatePayload = {
            verified: Boolean(item.verified),
            source_url: item.verified ? (item.source_url || null) : null,
            raw_source_url: item.raw_source_url !== undefined ? item.raw_source_url : (item.source_url || null),
            updated_at: item.updated_at || nowIso
          };
          batch.set(docRef, updatePayload, { merge: true });
        }

        await batch.commit();
        updated += chunk.length;
      } catch (err) {
        failed += chunk.length;
        errors.push(err);
      }
    }

    return { total, updated, failed, batches: chunks.length, errors, dryRun };
  }

  /**
   * Builds candidate write operations for a single Activity, Organizer, or Venue listing.
   *
   * @param {object} item
   * @param {'activity' | 'organizer' | 'venue'} [explicitType]
   * @returns {Array<{ col: string, id: string, data: object, mergeable?: boolean }>}
   */
  function buildCandidateOps(item, explicitType) {
    const cleanItem = getCleanDocument(item);
    const resolvedType = explicitType || resolveListingType(cleanItem);

    const ops = [];

    if (resolvedType === 'organizer') {
      if (cleanItem.id) {
        ops.push({ col: organizersCollectionName, id: cleanItem.id, data: cleanItem, mergeable: true });
      }
      return ops;
    }

    if (resolvedType === 'venue') {
      if (cleanItem.id) {
        ops.push({ col: venuesCollectionName, id: cleanItem.id, data: cleanItem, mergeable: true });
      }
      return ops;
    }

    const entities = item._canonicalEntities || extractCanonicalEntities(item);
    const cleanActivity = getCleanDocument(entities.activity || item);

    if (cleanActivity.id) {
      ops.push({ col: collectionName, id: cleanActivity.id, data: cleanActivity });
    }
    if (entities.venue && entities.venue.id) {
      ops.push({ col: venuesCollectionName, id: entities.venue.id, data: entities.venue, mergeable: true });
    }
    if (entities.organizer && entities.organizer.id) {
      ops.push({ col: organizersCollectionName, id: entities.organizer.id, data: entities.organizer, mergeable: true });
    }
    if (entities.region && entities.region.id) {
      ops.push({ col: regionsCollectionName, id: entities.region.id, data: entities.region });
    }

    return ops;
  }

  /**
   * Upserts an array of canonical records in atomic Firestore batches,
   * merging `subcategories` across records referencing the same Organizer or Venue ID.
   *
   * @param {Array<object>} items
   * @param {'activity' | 'organizer' | 'venue'} [explicitType]
   * @returns {Promise<{ total: number, upserted: number, failed: number, batches: number, errors: Array<Error>, dryRun: boolean }>}
   */
  async function batchUpsertRecords(items = [], explicitType) {
    const total = items.length;
    if (total === 0) {
      return { total: 0, upserted: 0, failed: 0, batches: 0, errors: [], dryRun };
    }

    const itemOpsList = items.map(item => buildCandidateOps(item, explicitType));
    const accumulatedEntityDocs = new Map();

    // Pre-fetch existing Organizer/Venue records when live db.getAll is available
    // so subcategories merge persistently across separate ingestion runs.
    if (!dryRun && db && typeof db.getAll === 'function') {
      const mergeableIds = new Set();
      for (const ops of itemOpsList) {
        for (const op of ops) {
          if (op.mergeable) {
            mergeableIds.add(op.id);
          }
        }
      }

      if (mergeableIds.size > 0) {
        const existingMap = await getRecordsByIds(Array.from(mergeableIds));
        for (const [id, data] of existingMap.entries()) {
          const col = resolveCollectionForId(id);
          accumulatedEntityDocs.set(`${col}/${id}`, data);
        }
      }
    }

    const batches = [];
    let currentBatchOps = new Map();
    let currentBatchItems = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const candidateOps = itemOpsList[i];

      let newOpsCount = 0;
      for (const op of candidateOps) {
        const key = `${op.col}/${op.id}`;
        if (!currentBatchOps.has(key)) {
          newOpsCount += 1;
        }
      }

      if (currentBatchOps.size > 0 && currentBatchOps.size + newOpsCount > effectiveBatchSize) {
        batches.push({
          ops: Array.from(currentBatchOps.values()),
          items: currentBatchItems
        });
        currentBatchOps = new Map();
        currentBatchItems = [];
      }

      for (const op of candidateOps) {
        const key = `${op.col}/${op.id}`;
        if (op.mergeable) {
          const prevDoc = accumulatedEntityDocs.get(key);
          const mergedData = prevDoc ? mergeEntityDocuments(prevDoc, op.data) : op.data;
          accumulatedEntityDocs.set(key, mergedData);
          currentBatchOps.set(key, { col: op.col, id: op.id, data: mergedData });
        } else {
          currentBatchOps.set(key, { col: op.col, id: op.id, data: op.data });
        }
      }
      currentBatchItems.push(item);
    }

    if (currentBatchOps.size > 0) {
      batches.push({
        ops: Array.from(currentBatchOps.values()),
        items: currentBatchItems
      });
    }

    const batchCount = batches.length;

    if (dryRun || !db) {
      return { total, upserted: total, failed: 0, batches: batchCount, errors: [], dryRun };
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
        upserted += batchPlan.items.length;
      } catch (err) {
        failed += batchPlan.items.length;
        errors.push(err);
      }
    }

    return { total, upserted, failed, batches: batchCount, errors, dryRun };
  }

  return {
    isDryRun() {
      return dryRun;
    },

    getActivities(ids = []) {
      return getRecordsByIds(ids, collectionName);
    },

    getOrganizers(ids = []) {
      return getRecordsByIds(ids, organizersCollectionName);
    },

    getVenues(ids = []) {
      return getRecordsByIds(ids, venuesCollectionName);
    },

    getListings(ids = []) {
      return getRecordsByIds(ids, collectionName);
    },

    scanActivities(scanOptions = {}) {
      return scanCollection(collectionName, scanOptions);
    },

    scanOrganizers(scanOptions = {}) {
      return scanCollection(organizersCollectionName, scanOptions);
    },

    scanVenues(scanOptions = {}) {
      return scanCollection(venuesCollectionName, scanOptions);
    },

    async scanListings(scanOptions = {}) {
      const [activities, organizers, venues] = await Promise.all([
        scanCollection(collectionName, scanOptions),
        scanCollection(organizersCollectionName, scanOptions),
        scanCollection(venuesCollectionName, scanOptions)
      ]);
      return [...activities, ...organizers, ...venues];
    },

    batchUpdateActivityUrls(updates = []) {
      return batchUpdateUrls(updates, collectionName);
    },

    batchUpdateOrganizerUrls(updates = []) {
      return batchUpdateUrls(updates, organizersCollectionName);
    },

    batchUpdateVenueUrls(updates = []) {
      return batchUpdateUrls(updates, venuesCollectionName);
    },

    batchUpdateListingUrls(updates = []) {
      return batchUpdateUrls(updates, collectionName);
    },

    batchUpsertActivities(activities = []) {
      return batchUpsertRecords(activities, 'activity');
    },

    batchUpsertOrganizers(organizers = []) {
      return batchUpsertRecords(organizers, 'organizer');
    },

    batchUpsertVenues(venues = []) {
      return batchUpsertRecords(venues, 'venue');
    },

    batchUpsertListings(listings = []) {
      return batchUpsertRecords(listings);
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
