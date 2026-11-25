import { after, before, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from '@firebase/rules-unit-testing';
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc
} from 'firebase/firestore';

const PROJECT_ID = 'demo-myplaydex';
const RULES_PATH = new URL('../../firestore.rules', import.meta.url);

let testEnv;

before(async () => {
  const [host, portStr] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host,
      port: Number(portStr),
      rules: readFileSync(RULES_PATH, 'utf8')
    }
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const createdAt = Timestamp.fromDate(new Date('2026-11-01T00:00:00Z'));

    await setDoc(doc(db, 'activities', 'act_1'), {
      id: 'act_1',
      title: 'Social Basketball',
      created_at: createdAt
    });
    await setDoc(doc(db, 'organizers', 'org_1'), {
      id: 'org_1',
      name: 'Perth Hoops',
      created_at: createdAt
    });
    await setDoc(doc(db, 'venues', 'venue_1'), {
      id: 'venue_1',
      name: 'Loftus Centre',
      created_at: createdAt
    });
    await setDoc(doc(db, 'regions', 'perth'), {
      id: 'perth',
      name: 'Greater Perth',
      created_at: createdAt
    });
    await setDoc(doc(db, 'internal_notes', 'note_1'), {
      secret: true
    });
  });
});

const LISTING_COLLECTIONS = [
  { name: 'activities', docId: 'act_1', newId: 'act_2' },
  { name: 'organizers', docId: 'org_1', newId: 'org_2' },
  { name: 'venues', docId: 'venue_1', newId: 'venue_2' }
];

async function assertNonAdminAccess(db) {
  for (const { name, docId, newId } of LISTING_COLLECTIONS) {
    await assertSucceeds(getDoc(doc(db, name, docId)));
    await assertSucceeds(getDocs(collection(db, name)));
    await assertFails(setDoc(doc(db, name, newId), { id: newId, created_at: Timestamp.now() }));
    await assertFails(updateDoc(doc(db, name, docId), { title: 'Mutated' }));
    await assertFails(deleteDoc(doc(db, name, docId)));
  }

  await assertFails(getDoc(doc(db, 'regions', 'perth')));
  await assertFails(getDocs(collection(db, 'regions')));
  await assertFails(setDoc(doc(db, 'regions', 'sydney'), { id: 'sydney' }));
  await assertFails(getDoc(doc(db, 'internal_notes', 'note_1')));
  await assertFails(setDoc(doc(db, 'internal_notes', 'note_2'), { secret: false }));
}

test('unauthenticated users can read Listings but cannot write Listings, read /regions, or access other paths', async () => {
  await assertNonAdminAccess(testEnv.unauthenticatedContext().firestore());
});

test('non-admin authenticated users can read Listings but cannot write Listings, read /regions, or access other paths', async () => {
  const contexts = [
    testEnv.authenticatedContext('user-no-claim'),
    testEnv.authenticatedContext('user-false-admin', { admin: false })
  ];

  for (const ctx of contexts) {
    await assertNonAdminAccess(ctx.firestore());
  }
});

test('Admin users can read, create, update (preserving id and created_at), and delete Listings', async () => {
  const db = testEnv.authenticatedContext('admin-1', { admin: true }).firestore();

  for (const { name, docId, newId } of LISTING_COLLECTIONS) {
    await assertSucceeds(getDoc(doc(db, name, docId)));
    await assertSucceeds(getDocs(collection(db, name)));
    await assertSucceeds(setDoc(doc(db, name, newId), {
      id: newId,
      title: 'Created by Admin',
      created_at: Timestamp.now()
    }));
    await assertSucceeds(updateDoc(doc(db, name, docId), {
      verified: true
    }));
    await assertSucceeds(deleteDoc(doc(db, name, docId)));
  }
});

test('Admin updates mutating id or created_at are rejected across Listing collections', async () => {
  const db = testEnv.authenticatedContext('admin-1', { admin: true }).firestore();

  for (const { name, docId } of LISTING_COLLECTIONS) {
    await assertFails(updateDoc(doc(db, name, docId), { id: 'tampered_id' }));
    await assertFails(updateDoc(doc(db, name, docId), {
      created_at: Timestamp.fromDate(new Date('2026-12-01T00:00:00Z'))
    }));
  }
});

test('Admin users can read /regions but cannot write /regions or access other paths', async () => {
  const db = testEnv.authenticatedContext('admin-1', { admin: true }).firestore();

  await assertSucceeds(getDoc(doc(db, 'regions', 'perth')));
  await assertSucceeds(getDocs(collection(db, 'regions')));
  await assertFails(setDoc(doc(db, 'regions', 'sydney'), { id: 'sydney' }));
  await assertFails(updateDoc(doc(db, 'regions', 'perth'), { name: 'Mutated' }));
  await assertFails(deleteDoc(doc(db, 'regions', 'perth')));

  await assertFails(getDoc(doc(db, 'internal_notes', 'note_1')));
  await assertFails(setDoc(doc(db, 'internal_notes', 'note_2'), { secret: false }));
});
