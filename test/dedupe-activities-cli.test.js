import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { planActivityDeduplication } from '../src/activity-deduplicator.js';
import {
  formatDeduplicationReport,
  main,
  parseCliArgs,
  runActivityDeduplication
} from '../src/dedupe-activities-cli.js';
import { createFirestoreAdapter } from '../src/firestore-adapter.js';

function makeActivity(overrides = {}) {
  return {
    id: 'facebook_1001',
    region_id: 'perth',
    source: 'facebook',
    source_id: '1001',
    source_url: 'https://www.facebook.com/events/1001/',
    raw_source_url: 'https://www.facebook.com/events/1001/',
    title: 'Perth Social Basketball',
    description: '',
    category: 'sports',
    subcategory: 'basketball',
    organizer: { id: 'org_perth_hoops', name: 'Perth Hoops' },
    venue: {
      id: 'venue_bendat_123',
      name: 'Bendat Basketball Centre',
      coordinates: { lat: -31.9465, lng: 115.7924 },
      geohash: 'qd66h1234'
    },
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-01',
      start_time: '18:30',
      end_date: '2026-12-01',
      end_time: '20:30',
      day_of_week: 2
    },
    expire_at: null,
    cost: { is_free: false, display_price: '' },
    demographics: { gender: 'all', age: 'all' },
    verified: true,
    created_at: '2026-11-20T00:00:00.000Z',
    updated_at: '2026-11-20T00:00:00.000Z',
    ...overrides
  };
}

function createMockAdapter(activities, { dryRun = false } = {}) {
  const commits = [];
  return {
    commits,
    adapter: {
      isDryRun: () => dryRun,
      async scanActivities() {
        return activities.map(a => ({ ...a }));
      },
      async batchApplyActivityDeduplication(payload) {
        commits.push(payload);
        return {
          updated: payload.updates.length,
          deleted: payload.deleteIds.length,
          failed: 0,
          batches: 1,
          errors: [],
          dryRun
        };
      }
    }
  };
}

function createInMemoryFirestoreDb(initialActivities) {
  const store = new Map(initialActivities.map(doc => [doc.id, { ...doc }]));
  return {
    store,
    db: {
      collection(colName) {
        assert.equal(colName, 'activities');
        return {
          doc(id) {
            return { id, colName };
          },
          async get() {
            return {
              docs: Array.from(store.values()).map(doc => ({
                id: doc.id,
                data: () => ({ ...doc })
              }))
            };
          }
        };
      },
      batch() {
        const ops = [];
        return {
          set(docRef, data, options) {
            ops.push({ type: 'set', id: docRef.id, data, options });
          },
          delete(docRef) {
            ops.push({ type: 'delete', id: docRef.id });
          },
          async commit() {
            for (const op of ops) {
              if (op.type === 'set') {
                const prev = store.get(op.id) || {};
                store.set(op.id, { ...prev, ...op.data });
              } else {
                store.delete(op.id);
              }
            }
          }
        };
      }
    }
  };
}

test('Slice 1: parseCliArgs defaults to dry-run, enables apply only with --apply, and lets --dry-run override --apply', () => {
  const defaultArgs = parseCliArgs([]);
  assert.equal(defaultArgs.dryRun, true);
  assert.equal(defaultArgs.apply, false);
  assert.equal(defaultArgs.project, 'myplaydex');
  assert.equal(defaultArgs.useAdc, false);

  const applyArgs = parseCliArgs(['--apply', '--project=custom-proj', '--use-adc']);
  assert.equal(applyArgs.dryRun, false);
  assert.equal(applyArgs.apply, true);
  assert.equal(applyArgs.project, 'custom-proj');
  assert.equal(applyArgs.useAdc, true);

  const conflictArgs = parseCliArgs(['--apply', '--dry-run']);
  assert.equal(conflictArgs.dryRun, true);
  assert.equal(conflictArgs.apply, false);
});

test('Slice 2: runActivityDeduplication defaults to dry-run with zero writes/deletes and produces structured report', async () => {
  const olderFacebook = makeActivity({
    id: 'facebook_1001',
    source: 'facebook',
    source_id: '1001',
    source_url: 'https://www.facebook.com/events/1001/',
    raw_source_url: 'https://www.facebook.com/events/1001/',
    created_at: '2026-11-01T00:00:00.000Z'
  });

  const newerEventbrite = makeActivity({
    id: 'eventbrite_2002',
    source: 'eventbrite',
    source_id: '2002',
    source_url: 'https://www.eventbrite.com.au/e/perth-social-basketball-2002',
    raw_source_url: 'https://www.eventbrite.com.au/e/perth-social-basketball-2002',
    description: 'Weekly social games at Bendat.',
    created_at: '2026-11-05T00:00:00.000Z'
  });

  // Borderline candidate: same date, missing start_time, ~333m away, weak title overlap
  const borderlineDoc = makeActivity({
    id: 'meetup_3003',
    source: 'meetup',
    source_id: '3003',
    source_url: 'https://www.meetup.com/perth-hoops/events/3003/',
    raw_source_url: 'https://www.meetup.com/perth-hoops/events/3003/',
    title: 'Perth Basketball Scrimmage Night',
    organizer: { id: 'org_other_group', name: 'Other Group' },
    venue: {
      id: 'venue_nearby_hall',
      name: 'Nearby Hall',
      coordinates: { lat: -31.9495, lng: 115.7924 },
      geohash: 'qd66h1200'
    },
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-01',
      start_time: null,
      end_date: '2026-12-01',
      end_time: null,
      day_of_week: 2
    },
    created_at: '2026-11-10T00:00:00.000Z'
  });

  // Intentionally unsorted order from Firestore
  const { adapter, commits } = createMockAdapter([borderlineDoc, newerEventbrite, olderFacebook]);

  const summary = await runActivityDeduplication({
    adapter,
    logger: { log() {}, warn() {}, error() {} }
  });

  assert.equal(summary.dryRun, true);
  assert.equal(commits.length, 0);
  assert.equal(summary.scannedCount, 3);
  assert.equal(summary.clusters.length, 1);
  assert.equal(summary.clusters[0].survivorId, 'facebook_1001');
  assert.deepEqual(summary.clusters[0].redundantIds, ['eventbrite_2002']);
  assert.equal(summary.clusters[0].primarySourceUrl, 'https://www.eventbrite.com.au/e/perth-social-basketball-2002');
  assert.equal(summary.clusters[0].sources.length, 2);

  assert.equal(summary.borderlinePairs.length, 1);
  assert.equal(summary.borderlinePairs[0].activityId, 'meetup_3003');
  assert.equal(summary.borderlinePairs[0].candidateId, 'facebook_1001');

  const report = formatDeduplicationReport(summary);
  assert.match(report, /DRY-RUN/);
  assert.match(report, /facebook_1001/);
  assert.match(report, /eventbrite_2002/);
  assert.match(report, /eventbrite_2002.*https:\/\/www\.eventbrite\.com\.au\/e\/perth-social-basketball-2002/);
  assert.match(report, /meetup_3003/);
  assert.match(report, /Unreviewed Listing/);
});

test('Slice 3: --apply merges 3-way cluster and perpetual weekly Activity using source precedence and deletes redundant docs', async () => {
  const weeklyCouncil = makeActivity({
    id: 'stirling_weekly_1',
    source: 'stirling',
    source_id: 'weekly_1',
    source_url: 'https://www.stirling.wa.gov.au/events/basketball',
    raw_source_url: 'https://www.stirling.wa.gov.au/events/basketball',
    title: 'Tuesday Night Social Basketball',
    schedule: {
      recurrence: 'weekly',
      start_date: null,
      start_time: '18:30',
      end_date: null,
      end_time: '20:30',
      day_of_week: 2
    },
    expire_at: null,
    created_at: { toMillis: () => Date.parse('2026-10-01T00:00:00.000Z') }
  });

  // Dated occurrence on Tuesday 2026-12-01 from Meetup
  const datedMeetup = makeActivity({
    id: 'meetup_dated_2',
    source: 'meetup',
    source_id: 'dated_2',
    source_url: 'https://www.meetup.com/perth-hoops/events/dated_2/',
    raw_source_url: 'https://www.meetup.com/perth-hoops/events/dated_2/',
    title: 'Tuesday Night Social Basketball',
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-01',
      start_time: '18:30',
      end_date: '2026-12-01',
      end_time: '20:30',
      day_of_week: 2
    },
    expire_at: '2026-12-09T00:00:00.000Z',
    created_at: '2026-11-05T00:00:00.000Z'
  });

  // Third duplicate from Eventbrite (highest precedence)
  const datedEventbrite = makeActivity({
    id: 'eventbrite_dated_3',
    source: 'eventbrite',
    source_id: 'dated_3',
    source_url: 'https://www.eventbrite.com.au/e/tuesday-night-social-basketball-3',
    raw_source_url: 'https://www.eventbrite.com.au/e/tuesday-night-social-basketball-3',
    title: 'Tuesday Night Social Basketball',
    description: 'Full Eventbrite description.',
    cost: { is_free: false, display_price: '$12' },
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-01',
      start_time: '18:30',
      end_date: '2026-12-01',
      end_time: '20:30',
      day_of_week: 2
    },
    created_at: '2026-11-10T00:00:00.000Z'
  });

  // Return newest first to verify deterministic created_at sorting
  const { adapter, commits } = createMockAdapter([datedEventbrite, datedMeetup, weeklyCouncil]);

  const summary = await runActivityDeduplication({
    adapter,
    options: { dryRun: false },
    logger: { log() {}, warn() {}, error() {} }
  });

  assert.equal(summary.dryRun, false);
  assert.equal(commits.length, 1);

  const { updates, deleteIds } = commits[0];
  assert.equal(updates.length, 1);
  assert.deepEqual(deleteIds, ['meetup_dated_2', 'eventbrite_dated_3']);

  const survivor = updates[0];
  assert.equal(survivor.id, 'stirling_weekly_1');
  assert.equal(survivor.schedule.recurrence, 'weekly');
  assert.equal(survivor.expire_at, null);
  assert.equal(survivor.source_url, 'https://www.eventbrite.com.au/e/tuesday-night-social-basketball-3');
  assert.equal(survivor.description, 'Full Eventbrite description.');
  assert.equal(survivor.cost.display_price, '$12');
  assert.deepEqual(survivor.source_keys, ['eventbrite_dated_3', 'meetup_dated_2', 'stirling_weekly_1']);
});

test('Slice 4: preserves human-approved curation (needs_review === false) whether older or newer, plus borderline pairs', async () => {
  const curatedSurvivor = makeActivity({
    id: 'facebook_curated',
    source: 'facebook',
    source_id: 'curated',
    title: 'Curated Perth Basketball Night',
    needs_review: false,
    review_reason: null,
    venue: {
      id: 'venue_bendat_123',
      name: 'Bendat Basketball Centre (Curated)',
      coordinates: { lat: -31.9465, lng: 115.7924 },
      geohash: 'qd66h1234'
    },
    organizer: { id: 'org_perth_hoops', name: 'Perth Hoops (Curated)' },
    created_at: '2026-11-01T00:00:00.000Z'
  });

  const duplicateEventbrite = makeActivity({
    id: 'eventbrite_dup',
    source: 'eventbrite',
    source_id: 'dup',
    source_url: 'https://www.eventbrite.com.au/e/curated-perth-basketball-dup',
    raw_source_url: 'https://www.eventbrite.com.au/e/curated-perth-basketball-dup',
    title: 'Perth Basketball Night',
    needs_review: true,
    review_reason: 'uncertain_venue_match',
    venue: {
      id: 'venue_bendat_123',
      name: 'Bendat Centre',
      coordinates: { lat: -31.9465, lng: 115.7924 },
      geohash: 'qd66h1234'
    },
    created_at: '2026-11-05T00:00:00.000Z'
  });

  // Older unreviewed Activity merged with a newer curated duplicate: preserves older ID AND newer curation
  const olderUnreviewed = makeActivity({
    id: 'facebook_older_unreviewed',
    source: 'facebook',
    source_id: 'older_unreviewed',
    title: 'Wanneroo Twilight Tennis',
    needs_review: true,
    review_reason: 'uncertain_venue_match',
    venue: {
      id: 'venue_wanneroo_1',
      name: 'Wanneroo Tennis',
      coordinates: { lat: -31.7501, lng: 115.8001 },
      geohash: 'qd66x1234'
    },
    organizer: { id: 'org_wanneroo_tennis', name: 'Wanneroo Tennis' },
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-09',
      start_time: '18:00',
      end_date: '2026-12-09',
      end_time: '20:00',
      day_of_week: 3
    },
    created_at: '2026-11-01T00:00:00.000Z'
  });

  const newerCurated = makeActivity({
    id: 'eventbrite_newer_curated',
    source: 'eventbrite',
    source_id: 'newer_curated',
    source_url: 'https://www.eventbrite.com.au/e/wanneroo-twilight-tennis',
    raw_source_url: 'https://www.eventbrite.com.au/e/wanneroo-twilight-tennis',
    title: 'Wanneroo Twilight Tennis (Human Verified)',
    needs_review: false,
    review_reason: null,
    venue: {
      id: 'venue_wanneroo_1',
      name: 'Wanneroo Tennis Courts (Curated)',
      coordinates: { lat: -31.7501, lng: 115.8001 },
      geohash: 'qd66x1234'
    },
    organizer: { id: 'org_wanneroo_tennis', name: 'Wanneroo Tennis Association' },
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-09',
      start_time: '18:00',
      end_date: '2026-12-09',
      end_time: '20:00',
      day_of_week: 3
    },
    created_at: '2026-11-08T00:00:00.000Z'
  });

  // Curated record created later than an unreviewed borderline record
  const unreviewedEarly = makeActivity({
    id: 'facebook_borderline_early',
    source: 'facebook',
    source_id: 'borderline_early',
    title: 'Perth Badminton Weekend Meetup',
    organizer: { id: 'org_other', name: 'Other Group' },
    venue: {
      id: 'venue_subiaco_hall',
      name: 'Subiaco Hall',
      coordinates: { lat: -31.9495, lng: 115.8235 },
      geohash: 'qd66h1200'
    },
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-05',
      start_time: null,
      end_date: '2026-12-05',
      end_time: null,
      day_of_week: 6
    },
    created_at: '2026-11-02T00:00:00.000Z'
  });

  const curatedBorderlineLate = makeActivity({
    id: 'eventbrite_curated_late',
    source: 'eventbrite',
    source_id: 'curated_late',
    title: 'Perth Community Badminton Social Session',
    needs_review: false,
    review_reason: null,
    organizer: { id: 'org_badminton', name: 'Perth Badminton' },
    venue: {
      id: 'venue_lords',
      name: 'Lords Recreation Centre',
      coordinates: { lat: -31.9465, lng: 115.8235 },
      geohash: 'qd66h1234'
    },
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-05',
      start_time: '10:00',
      end_date: '2026-12-05',
      end_time: '12:00',
      day_of_week: 6
    },
    created_at: '2026-11-06T00:00:00.000Z'
  });

  const plan = planActivityDeduplication([
    duplicateEventbrite,
    curatedSurvivor,
    olderUnreviewed,
    newerCurated,
    curatedBorderlineLate,
    unreviewedEarly
  ]);

  assert.deepEqual(plan.activityIdsToDelete, ['eventbrite_dup', 'eventbrite_newer_curated']);

  const mergedSurvivor = plan.activitiesToUpdate.find(u => u.id === 'facebook_curated');
  assert.ok(mergedSurvivor);
  assert.equal(mergedSurvivor.needs_review, false);
  assert.equal(mergedSurvivor.review_reason, null);
  assert.equal(mergedSurvivor.title, 'Curated Perth Basketball Night');
  assert.equal(mergedSurvivor.venue.name, 'Bendat Basketball Centre (Curated)');
  assert.equal(mergedSurvivor.source_url, 'https://www.eventbrite.com.au/e/curated-perth-basketball-dup');

  const mergedOlderWithNewerCurated = plan.activitiesToUpdate.find(u => u.id === 'facebook_older_unreviewed');
  assert.ok(mergedOlderWithNewerCurated);
  assert.equal(mergedOlderWithNewerCurated.needs_review, false);
  assert.equal(mergedOlderWithNewerCurated.review_reason, null);
  assert.equal(mergedOlderWithNewerCurated.title, 'Wanneroo Twilight Tennis (Human Verified)');
  assert.equal(mergedOlderWithNewerCurated.venue.name, 'Wanneroo Tennis Courts (Curated)');
  assert.deepEqual(mergedOlderWithNewerCurated.source_keys, ['eventbrite_newer_curated', 'facebook_older_unreviewed']);

  // Curated borderline doc must remain untouched; the unreviewed doc is flagged instead
  assert.equal(plan.activitiesToUpdate.some(u => u.id === 'eventbrite_curated_late'), false);
  const flaggedUnreviewed = plan.activitiesToUpdate.find(u => u.id === 'facebook_borderline_early');
  assert.ok(flaggedUnreviewed);
  assert.equal(flaggedUnreviewed.needs_review, true);
  assert.equal(flaggedUnreviewed.review_reason, 'possible_duplicate');
  assert.equal(flaggedUnreviewed.duplicate_candidate_id, 'eventbrite_curated_late');
});

test('Slice 5: borderline candidates under --apply are flagged without deletion and idempotent on already-flagged pairs', async () => {
  const existing = makeActivity({
    id: 'eventbrite_1',
    source: 'eventbrite',
    source_id: '1',
    title: 'Perth Community Badminton Social Session',
    organizer: { id: 'org_badminton', name: 'Perth Badminton' },
    venue: {
      id: 'venue_lords',
      name: 'Lords Recreation Centre',
      coordinates: { lat: -31.9465, lng: 115.8235 },
      geohash: 'qd66h1234'
    },
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-05',
      start_time: '10:00',
      end_date: '2026-12-05',
      end_time: '12:00',
      day_of_week: 6
    },
    created_at: '2026-11-01T00:00:00.000Z'
  });

  const borderline = makeActivity({
    id: 'facebook_2',
    source: 'facebook',
    source_id: '2',
    title: 'Perth Badminton Weekend Meetup',
    organizer: { id: 'org_other', name: 'Other Group' },
    venue: {
      id: 'venue_subiaco_hall',
      name: 'Subiaco Hall',
      coordinates: { lat: -31.9495, lng: 115.8235 },
      geohash: 'qd66h1200'
    },
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-05',
      start_time: null,
      end_date: '2026-12-05',
      end_time: null,
      day_of_week: 6
    },
    created_at: '2026-11-05T00:00:00.000Z'
  });

  const { adapter, commits } = createMockAdapter([existing, borderline]);

  const firstRun = await runActivityDeduplication({
    adapter,
    options: { dryRun: false },
    logger: { log() {}, warn() {}, error() {} }
  });

  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].deleteIds, []);
  assert.equal(commits[0].updates.length, 1);
  assert.equal(commits[0].updates[0].id, 'facebook_2');
  assert.equal(commits[0].updates[0].needs_review, true);
  assert.equal(commits[0].updates[0].review_reason, 'possible_duplicate');
  assert.equal(commits[0].updates[0].duplicate_candidate_id, 'eventbrite_1');
  assert.equal(firstRun.stats.borderlineFlagged, 1);

  // Second run when already flagged performs zero writes
  const alreadyFlagged = commits[0].updates[0];
  const second = createMockAdapter([existing, alreadyFlagged]);

  const secondRun = await runActivityDeduplication({
    adapter: second.adapter,
    options: { dryRun: false },
    logger: { log() {}, warn() {}, error() {} }
  });

  assert.equal(second.commits.length, 0);
  assert.equal(secondRun.stats.borderlinePairs, 1);
  assert.equal(secondRun.stats.borderlineFlagged, 0);
});

test('Slice 6: planActivityDeduplication and runActivityDeduplication handle empty and single-item collections cleanly', async () => {
  const emptyPlan = planActivityDeduplication([]);
  assert.equal(emptyPlan.scannedCount, 0);
  assert.deepEqual(emptyPlan.clusters, []);
  assert.deepEqual(emptyPlan.borderlinePairs, []);
  assert.deepEqual(emptyPlan.activitiesToUpdate, []);
  assert.deepEqual(emptyPlan.activityIdsToDelete, []);
  assert.equal(emptyPlan.stats.unchanged, 0);

  const single = makeActivity({ id: 'eventbrite_1', source: 'eventbrite', source_id: '1' });
  const singlePlan = planActivityDeduplication([single]);
  assert.equal(singlePlan.scannedCount, 1);
  assert.deepEqual(singlePlan.clusters, []);
  assert.deepEqual(singlePlan.borderlinePairs, []);
  assert.deepEqual(singlePlan.activitiesToUpdate, []);
  assert.deepEqual(singlePlan.activityIdsToDelete, []);
  assert.equal(singlePlan.stats.unchanged, 1);

  const { adapter, commits } = createMockAdapter([single]);
  const res = await runActivityDeduplication({
    adapter,
    options: { dryRun: false },
    logger: { log() {}, warn() {}, error() {} }
  });
  assert.equal(res.scannedCount, 1);
  assert.equal(commits.length, 0);
});

test('Slice 7: main integrates end-to-end with createFirestoreAdapter, fails on commit errors, and registers dedupe:activities', async () => {
  const pkgContent = await fs.readFile(new URL('../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(pkgContent);
  assert.equal(pkg.scripts['dedupe:activities'], 'node src/dedupe-activities-cli.js');

  const dryLogs = [];
  const drySummary = await main([], {}, {
    logger: { log: (...a) => dryLogs.push(a.join(' ')), warn() {}, error() {} },
    logFile: false
  });
  assert.equal(drySummary.dryRun, true);
  assert.equal(dryLogs.some(line => line.includes('Activity Deduplication Report')), true);
  assert.equal(dryLogs.some(line => line.includes('DRY-RUN')), true);

  // End-to-end against real createFirestoreAdapter + mock Firestore db
  const { db, store } = createInMemoryFirestoreDb([
    makeActivity({
      id: 'facebook_1',
      source: 'facebook',
      source_id: '1',
      created_at: '2026-11-01T00:00:00.000Z'
    }),
    makeActivity({
      id: 'eventbrite_2',
      source: 'eventbrite',
      source_id: '2',
      source_url: 'https://www.eventbrite.com.au/e/2',
      raw_source_url: 'https://www.eventbrite.com.au/e/2',
      description: 'Eventbrite description',
      created_at: '2026-11-02T00:00:00.000Z'
    })
  ]);

  const realAdapter = createFirestoreAdapter({ db, dryRun: false });
  const applyLogs = [];
  const applySummary = await main(
    ['--apply'],
    {},
    {
      logger: { log: (...a) => applyLogs.push(a.join(' ')), warn() {}, error() {} },
      logFile: false,
      firestoreEnv: { db, dryRun: false, projectId: 'test-proj' },
      adapter: realAdapter
    }
  );

  assert.equal(applySummary.dryRun, false);
  assert.equal(store.size, 1);
  assert.equal(store.has('eventbrite_2'), false);
  const survivor = store.get('facebook_1');
  assert.equal(survivor.source_url, 'https://www.eventbrite.com.au/e/2');
  assert.equal(survivor.description, 'Eventbrite description');
  assert.deepEqual(survivor.source_keys, ['eventbrite_2', 'facebook_1']);
  assert.equal(applyLogs.some(line => line.includes('APPLY')), true);

  // main throws when commitResult reports failed operations
  const failingAdapter = {
    isDryRun: () => false,
    async scanActivities() {
      return [
        makeActivity({ id: 'a1', source: 'facebook', source_id: '1', created_at: '2026-11-01T00:00:00.000Z' }),
        makeActivity({ id: 'a2', source: 'eventbrite', source_id: '2', created_at: '2026-11-02T00:00:00.000Z' })
      ];
    },
    async batchApplyActivityDeduplication() {
      return {
        updated: 0,
        deleted: 0,
        failed: 2,
        batches: 1,
        errors: [new Error('Firestore permission denied')],
        dryRun: false
      };
    }
  };

  await assert.rejects(
    () => main(['--apply'], {}, {
      logger: { log() {}, warn() {}, error() {} },
      logFile: false,
      firestoreEnv: { db: {}, dryRun: false, projectId: 'test-proj' },
      adapter: failingAdapter
    }),
    /Deduplication failed with 2 failed Firestore operations: Firestore permission denied/
  );
});
