import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateActivities, getSourcePriority } from '../src/activity-deduplicator.js';
import { runCrawlerHarness } from '../src/crawler-runner.js';
import { runFacebookSync } from '../src/facebook-sync.js';

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

test('Slice 1: merges high-confidence cross-source duplicate into first-seen ID with source_url precedence', () => {
  const existingFacebook = makeActivity({
    id: 'facebook_1001',
    source: 'facebook',
    source_id: '1001',
    source_url: 'https://www.facebook.com/events/1001/',
    raw_source_url: 'https://www.facebook.com/events/1001/',
    verified: true,
    description: '',
    cost: { is_free: false, display_price: '' }
  });

  const incomingEventbrite = makeActivity({
    id: 'eventbrite_2002',
    source: 'eventbrite',
    source_id: '2002',
    source_url: 'https://www.eventbrite.com.au/e/perth-social-basketball-2002',
    raw_source_url: 'https://www.eventbrite.com.au/e/perth-social-basketball-2002',
    verified: true,
    description: 'Weekly social basketball games for all skill levels.',
    cost: { is_free: false, display_price: '$15' },
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-01',
      start_time: '18:45',
      end_date: '2026-12-01',
      end_time: '20:45',
      day_of_week: 2
    },
    venue: {
      id: 'venue_bendat_123',
      name: 'Bendat Basketball Centre',
      coordinates: { lat: -31.9465, lng: 115.7924 },
      geohash: 'qd66h1234'
    }
  });

  const result = deduplicateActivities([incomingEventbrite], [existingFacebook]);

  assert.equal(result.activitiesToUpsert.length, 1);
  const merged = result.activitiesToUpsert[0];
  assert.equal(merged.id, 'facebook_1001');
  assert.equal(merged.source_url, 'https://www.eventbrite.com.au/e/perth-social-basketball-2002');
  assert.equal(merged.verified, true);
  assert.equal(merged.description, 'Weekly social basketball games for all skill levels.');
  assert.equal(merged.cost.display_price, '$15');
  assert.deepEqual(merged.source_keys, ['eventbrite_2002', 'facebook_1001']);
  assert.equal(merged.sources.length, 2);
});

test('Slice 2: idempotent source_key lookup retains canonical ID and prefers verified over unverified across priority tiers', () => {
  const existingCanonical = makeActivity({
    id: 'facebook_1001',
    source: 'facebook',
    source_id: '1001',
    source_url: 'https://www.meetup.com/perth-hoops/events/3003/',
    raw_source_url: 'https://www.meetup.com/perth-hoops/events/3003/',
    verified: true,
    source_keys: ['eventbrite_2002', 'facebook_1001', 'meetup_3003'],
    sources: [
      {
        source: 'eventbrite',
        source_id: '2002',
        source_key: 'eventbrite_2002',
        source_url: null,
        raw_source_url: 'https://www.eventbrite.com.au/e/dead-2002',
        verified: false
      },
      {
        source: 'facebook',
        source_id: '1001',
        source_key: 'facebook_1001',
        source_url: 'https://www.facebook.com/events/1001/',
        raw_source_url: 'https://www.facebook.com/events/1001/',
        verified: true
      },
      {
        source: 'meetup',
        source_id: '3003',
        source_key: 'meetup_3003',
        source_url: 'https://www.meetup.com/perth-hoops/events/3003/',
        raw_source_url: 'https://www.meetup.com/perth-hoops/events/3003/',
        verified: true
      }
    ]
  });

  // Re-crawl Eventbrite with slightly drifted title and still-unverified URL
  const recrawledEventbrite = makeActivity({
    id: 'eventbrite_2002',
    source: 'eventbrite',
    source_id: '2002',
    title: 'Perth Social Basketball - Tuesday Night',
    source_url: null,
    raw_source_url: 'https://www.eventbrite.com.au/e/dead-2002',
    verified: false
  });

  const firstPass = deduplicateActivities([recrawledEventbrite], [existingCanonical]);
  assert.equal(firstPass.activitiesToUpsert.length, 1);
  const afterFirst = firstPass.activitiesToUpsert[0];
  assert.equal(afterFirst.id, 'facebook_1001');
  assert.equal(afterFirst.verified, true);
  // Verified meetup beats unverified eventbrite
  assert.equal(afterFirst.source_url, 'https://www.meetup.com/perth-hoops/events/3003/');
  assert.equal(firstPass.stats.idempotentSourceHits, 1);

  // Re-crawling again produces identical canonical ID and source_url (no flipping)
  const secondPass = deduplicateActivities([recrawledEventbrite], [afterFirst]);
  assert.equal(secondPass.activitiesToUpsert.length, 1);
  assert.equal(secondPass.activitiesToUpsert[0].id, 'facebook_1001');
  assert.equal(secondPass.activitiesToUpsert[0].source_url, 'https://www.meetup.com/perth-hoops/events/3003/');
});

test('Slice 3: suburb-centroid and unmatched_venue fallback pins never auto-merge, and distinct dates/venues/times stay separate', () => {
  // Suburb centroid for Perth (-31.9505, 115.8605)
  const centroidA = makeActivity({
    id: 'eventbrite_c1',
    source: 'eventbrite',
    source_id: 'c1',
    title: 'Perth Social Run Club',
    organizer: { id: 'org_run_club', name: 'Perth Run Club' },
    venue: {
      id: 'venue_perth_qd66hx',
      name: 'Perth',
      coordinates: { lat: -31.9505, lng: 115.8605 },
      geohash: 'qd66hx123'
    }
  });

  const centroidB = makeActivity({
    id: 'meetup_c2',
    source: 'meetup',
    source_id: 'c2',
    title: 'Perth Social Run Club',
    organizer: { id: 'org_other_run', name: 'Other Run Group' },
    venue: {
      id: 'venue_perth_qd66hx',
      name: 'Perth CBD',
      coordinates: { lat: -31.9505, lng: 115.8605 },
      geohash: 'qd66hx123'
    }
  });

  const unmatchedA = makeActivity({
    id: 'stirling_u1',
    source: 'stirling',
    source_id: 'u1',
    title: 'Morning Yoga in the Park',
    needs_review: true,
    review_reason: 'unmatched_venue',
    organizer: { id: 'org_stirling', name: 'City of Stirling' },
    venue: {
      id: null,
      name: 'Stirling',
      coordinates: { lat: -31.8819, lng: 115.8108 },
      geohash: 'qd66k1234'
    }
  });

  const unmatchedB = makeActivity({
    id: 'facebook_u2',
    source: 'facebook',
    source_id: 'u2',
    title: 'Morning Yoga in the Park',
    needs_review: true,
    review_reason: 'unmatched_venue',
    organizer: { id: 'org_yoga_wa', name: 'Yoga WA' },
    venue: {
      id: null,
      name: 'Stirling',
      coordinates: { lat: -31.8819, lng: 115.8108 },
      geohash: 'qd66k1234'
    }
  });

  // Same venue/title but different date (multi-date series)
  const nextWeek = makeActivity({
    id: 'eventbrite_nextweek',
    source: 'eventbrite',
    source_id: 'nextweek',
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-08',
      start_time: '18:30',
      end_date: '2026-12-08',
      end_time: '20:30',
      day_of_week: 2
    }
  });

  const resCentroids = deduplicateActivities([centroidB], [centroidA]);
  assert.equal(resCentroids.activitiesToUpsert.length, 1);
  assert.equal(resCentroids.stats.merged, 0);
  assert.equal(resCentroids.activitiesToUpsert[0].id, 'meetup_c2');

  const resUnmatched = deduplicateActivities([unmatchedB], [unmatchedA]);
  assert.equal(resUnmatched.activitiesToUpsert.length, 1);
  assert.equal(resUnmatched.stats.merged, 0);
  assert.equal(resUnmatched.activitiesToUpsert[0].id, 'facebook_u2');

  const baseActivity = makeActivity();
  const resDifferentDate = deduplicateActivities([nextWeek], [baseActivity]);
  assert.equal(resDifferentDate.stats.merged, 0);
  assert.equal(resDifferentDate.stats.distinct, 1);
});

test('Slice 4: weekly Activity absorbs high-confidence dated occurrence while divergent-title overlap is flagged as Unreviewed Listing', () => {
  const weeklyActivity = makeActivity({
    id: 'stirling_weekly_1',
    source: 'stirling',
    source_id: 'weekly_1',
    source_url: 'https://www.stirling.wa.gov.au/events/weekly-basketball',
    raw_source_url: 'https://www.stirling.wa.gov.au/events/weekly-basketball',
    title: 'Tuesday Night Social Basketball',
    schedule: {
      recurrence: 'weekly',
      start_date: null,
      start_time: '18:30',
      end_date: null,
      end_time: '20:30',
      day_of_week: 2 // Tuesday
    },
    expire_at: null
  });

  // 2026-12-01 is a Tuesday
  const datedMatch = makeActivity({
    id: 'meetup_dated_1',
    source: 'meetup',
    source_id: 'dated_1',
    source_url: 'https://www.meetup.com/perth-hoops/events/dated_1/',
    raw_source_url: 'https://www.meetup.com/perth-hoops/events/dated_1/',
    title: 'Tuesday Night Social Basketball',
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-01',
      start_time: '18:30',
      end_date: '2026-12-01',
      end_time: '20:30',
      day_of_week: 2
    },
    expire_at: '2026-12-09T00:00:00.000Z'
  });

  const datedDivergent = makeActivity({
    id: 'facebook_dated_2',
    source: 'facebook',
    source_id: 'dated_2',
    title: 'Junior Coaching Clinic',
    organizer: { id: 'org_different', name: 'Junior Hoops' },
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-01',
      start_time: '18:30',
      end_date: '2026-12-01',
      end_time: '20:30',
      day_of_week: 2
    }
  });

  const res = deduplicateActivities([datedMatch, datedDivergent], [weeklyActivity]);
  assert.equal(res.activitiesToUpsert.length, 2);

  const absorbed = res.activitiesToUpsert.find(a => a.id === 'stirling_weekly_1');
  assert.ok(absorbed);
  assert.equal(absorbed.schedule.recurrence, 'weekly');
  assert.equal(absorbed.expire_at, null);
  assert.deepEqual(absorbed.source_keys, ['meetup_dated_1', 'stirling_weekly_1']);
  assert.equal(absorbed.source_url, 'https://www.meetup.com/perth-hoops/events/dated_1/');

  const divergent = res.activitiesToUpsert.find(a => a.id === 'facebook_dated_2');
  assert.ok(divergent);
  assert.equal(divergent.needs_review, true);
  assert.equal(divergent.review_reason, 'possible_duplicate');
  assert.equal(divergent.duplicate_candidate_id, 'stirling_weekly_1');
});

test('Slice 5: borderline matches remain separate and are flagged as Unreviewed Listing with duplicate_candidate_id', () => {
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
    }
  });

  // Missing start_time, ~400m away, weak title overlap (Jaccard >= 0.25)
  const borderline = makeActivity({
    id: 'facebook_2',
    source: 'facebook',
    source_id: '2',
    title: 'Perth Badminton Weekend Meetup',
    organizer: { id: 'org_other', name: 'Other Group' },
    venue: {
      id: 'venue_subiaco_hall',
      name: 'Subiaco Hall',
      coordinates: { lat: -31.9495, lng: 115.8235 }, // ~333m south
      geohash: 'qd66h1200'
    },
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-05',
      start_time: null,
      end_date: '2026-12-05',
      end_time: null,
      day_of_week: 6
    }
  });

  const res = deduplicateActivities([borderline], [existing]);
  assert.equal(res.activitiesToUpsert.length, 1);
  assert.equal(res.stats.flaggedBorderline, 1);
  const flagged = res.activitiesToUpsert[0];
  assert.equal(flagged.id, 'facebook_2');
  assert.equal(flagged.needs_review, true);
  assert.equal(flagged.review_reason, 'possible_duplicate');
  assert.equal(flagged.duplicate_candidate_id, 'eventbrite_1');
});

test('Slice 6: human-approved curation (needs_review === false) is preserved during cross-source merges', () => {
  const curatedExisting = makeActivity({
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
    organizer: { id: 'org_perth_hoops', name: 'Perth Hoops (Curated)' }
  });

  const incomingEventbrite = makeActivity({
    id: 'eventbrite_999',
    source: 'eventbrite',
    source_id: '999',
    source_url: 'https://www.eventbrite.com.au/e/perth-basketball-999',
    raw_source_url: 'https://www.eventbrite.com.au/e/perth-basketball-999',
    title: 'Perth Basketball Night',
    needs_review: true,
    review_reason: 'uncertain_venue_match',
    venue: {
      id: 'venue_bendat_123',
      name: 'Bendat Centre',
      coordinates: { lat: -31.9465, lng: 115.7924 },
      geohash: 'qd66h1234'
    },
    organizer: { id: 'org_perth_hoops', name: 'Perth Hoops' }
  });

  const res = deduplicateActivities([incomingEventbrite], [curatedExisting]);
  assert.equal(res.activitiesToUpsert.length, 1);
  const merged = res.activitiesToUpsert[0];
  assert.equal(merged.id, 'facebook_curated');
  assert.equal(merged.needs_review, false);
  assert.equal(merged.review_reason, null);
  assert.equal(merged.title, 'Curated Perth Basketball Night');
  assert.equal(merged.venue.name, 'Bendat Basketball Centre (Curated)');
  assert.equal(merged.organizer.name, 'Perth Hoops (Curated)');
  assert.equal(merged.source_url, 'https://www.eventbrite.com.au/e/perth-basketball-999');
});

test('Slice 7: runCrawlerHarness deduplicates across crawlers and existing /activities before writing', async () => {
  const upsertedBatches = [];
  const existingActivities = [
    makeActivity({
      id: 'facebook_existing_55',
      source: 'facebook',
      source_id: 'existing_55',
      source_url: 'https://www.facebook.com/events/55/',
      raw_source_url: 'https://www.facebook.com/events/55/',
      title: 'Perth Social Basketball',
      verified: true
    })
  ];

  const adapter = {
    async scanVenues() {
      return [
        {
          id: 'venue_bendat_123',
          name: 'Bendat Basketball Centre',
          coordinates: { lat: -31.9465, lng: 115.7924 },
          geohash: 'qd66h1234'
        }
      ];
    },
    async scanOrganizers() {
      return [{ id: 'org_perth_hoops', name: 'Perth Hoops' }];
    },
    async scanActivities() {
      return existingActivities;
    },
    async batchUpsertListings(items) {
      upsertedBatches.push(items);
      return { total: items.length, upserted: items.length, failed: 0, batches: 1, errors: [], dryRun: false };
    }
  };

  const crawlers = [
    {
      name: 'eventbrite',
      async fetchListings() {
        return [
          {
            source: 'eventbrite',
            source_id: 'eb_55',
            source_url: 'https://www.eventbrite.com.au/e/perth-social-basketball-55',
            title: 'Perth Social Basketball',
            description: 'Join us for social basketball.',
            category: 'sports',
            subcategory: 'basketball',
            organizer_name: 'Perth Hoops',
            venue_name: 'Bendat Basketball Centre',
            coordinates: { lat: -31.9465, lng: 115.7924 },
            start_date: '2026-12-01',
            start_time: '18:30',
            end_date: '2026-12-01',
            end_time: '20:30'
          }
        ];
      }
    }
  ];

  const summary = await runCrawlerHarness({
    crawlers,
    adapter,
    options: {
      skipUrlVerification: true,
      logger: { log() {}, error() {}, warn() {} }
    }
  });

  assert.equal(summary.results[0].status, 'ok');
  assert.equal(upsertedBatches.length, 1);
  const persisted = upsertedBatches[0].filter(item => !String(item.id).startsWith('org_') && !String(item.id).startsWith('venue_'));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].id, 'facebook_existing_55');
  assert.equal(persisted[0].source_url, 'https://www.eventbrite.com.au/e/perth-social-basketball-55');
  assert.deepEqual(persisted[0].source_keys, ['eventbrite_eb_55', 'facebook_existing_55']);
});

test('Slice 8: runFacebookSync deduplicates incoming Facebook Activities against existing /activities before writing', async () => {
  const upsertedBatches = [];
  const existingActivities = [
    makeActivity({
      id: 'eventbrite_777',
      source: 'eventbrite',
      source_id: '777',
      source_url: 'https://www.eventbrite.com.au/e/perth-social-basketball-777',
      raw_source_url: 'https://www.eventbrite.com.au/e/perth-social-basketball-777',
      title: 'Perth Social Basketball',
      verified: true,
      description: 'Eventbrite canonical description'
    })
  ];

  const adapter = {
    async scanVenues() {
      return [
        {
          id: 'venue_bendat_123',
          name: 'Bendat Basketball Centre',
          coordinates: { lat: -31.9465, lng: 115.7924 },
          geohash: 'qd66h1234'
        }
      ];
    },
    async scanOrganizers() {
      return [{ id: 'org_perth_hoops', name: 'Perth Hoops' }];
    },
    async scanActivities() {
      return existingActivities;
    },
    async batchUpsertActivities(items) {
      upsertedBatches.push(items);
      return { total: items.length, upserted: items.length, failed: 0, batches: 1, errors: [], dryRun: false };
    }
  };

  const jsonLdHtml = `
    <html><head>
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Event",
          "name": "Perth Social Basketball",
          "url": "https://www.facebook.com/events/888/",
          "startDate": "2026-12-01T18:30:00+08:00",
          "endDate": "2026-12-01T20:30:00+08:00",
          "location": {
            "@type": "Place",
            "name": "Bendat Basketball Centre",
            "geo": { "@type": "GeoCoordinates", "latitude": -31.9465, "longitude": 115.7924 }
          },
          "organizer": { "@type": "Organization", "name": "Perth Hoops" }
        }
      </script>
    </head><body></body></html>
  `;

  const result = await runFacebookSync({
    adapter,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      text: async () => jsonLdHtml
    }),
    options: {
      url: 'https://www.facebook.com/events/888/',
      now: new Date('2026-11-25T00:00:00.000Z')
    },
    logger: { log() {}, error() {}, warn() {} }
  });

  assert.equal(result.upserted, 1);
  assert.equal(upsertedBatches.length, 1);
  assert.equal(upsertedBatches[0].length, 1);
  const persisted = upsertedBatches[0][0];
  assert.equal(persisted.id, 'eventbrite_777');
  assert.equal(persisted.source_url, 'https://www.eventbrite.com.au/e/perth-social-basketball-777');
  assert.deepEqual(persisted.source_keys, ['eventbrite_777', 'facebook_888']);
});

test('Slice 9 (Issue #52): organizer_website precedence ranks above facebook and below council, promoting/retaining Source References and merging metadata', () => {
  assert.ok(getSourcePriority('eventbrite') > getSourcePriority('meetup'));
  assert.ok(getSourcePriority('meetup') > getSourcePriority('council'));
  assert.ok(getSourcePriority('council') > getSourcePriority('organizer_website'));
  assert.ok(getSourcePriority('stirling') > getSourcePriority('organizer_website'));
  assert.ok(getSourcePriority('organizer_website') > getSourcePriority('facebook'));

  // 1. Merging organizer_website onto an existing Facebook-sourced Activity promotes organizer_website URL and merges metadata
  const existingFacebook = makeActivity({
    id: 'facebook_1001',
    source: 'facebook',
    source_id: '1001',
    source_url: 'https://www.facebook.com/events/1001/',
    raw_source_url: 'https://www.facebook.com/events/1001/',
    verified: true,
    title: 'Social Basketball',
    description: 'Facebook event post',
    cost: { is_free: false, display_price: '' }
  });

  const incomingOrganizerSite = makeActivity({
    id: 'organizer_website_club_1',
    source: 'organizer_website',
    source_id: 'club_1',
    source_url: 'https://perthhoops.org.au/social-basketball',
    raw_source_url: 'https://perthhoops.org.au/social-basketball',
    verified: true,
    title: 'Perth Social Basketball',
    description: 'Official club timetable for Tuesday social basketball.',
    cost: { is_free: false, display_price: '$12' },
    schedule: {
      recurrence: 'none',
      start_date: '2026-12-01',
      start_time: '18:30',
      end_date: '2026-12-01',
      end_time: '20:30',
      day_of_week: 2
    }
  });

  const fbToOrgResult = deduplicateActivities([incomingOrganizerSite], [existingFacebook]);
  assert.equal(fbToOrgResult.activitiesToUpsert.length, 1);
  const promoted = fbToOrgResult.activitiesToUpsert[0];
  assert.equal(promoted.id, 'facebook_1001');
  assert.equal(promoted.source_url, 'https://perthhoops.org.au/social-basketball');
  assert.equal(promoted.verified, true);
  assert.equal(promoted.description, 'Official club timetable for Tuesday social basketball.');
  assert.equal(promoted.cost.display_price, '$12');
  assert.deepEqual(promoted.source_keys, ['facebook_1001', 'organizer_website_club_1']);
  assert.equal(promoted.sources.length, 2);
  assert.equal(
    promoted.sources.find(s => s.source_key === 'facebook_1001').source_url,
    'https://www.facebook.com/events/1001/'
  );

  // 2. Merging higher-priority sources (council, meetup, eventbrite) over organizer_website promotes the higher-priority URL and preserves organizer_website
  for (const higher of [
    {
      id: 'council_501',
      source: 'council',
      source_id: '501',
      source_url: 'https://perth.wa.gov.au/whats-on/basketball',
      description: 'Council listing description'
    },
    {
      id: 'meetup_502',
      source: 'meetup',
      source_id: '502',
      source_url: 'https://www.meetup.com/perth-hoops/events/502/',
      description: 'Meetup listing description'
    },
    {
      id: 'eventbrite_503',
      source: 'eventbrite',
      source_id: '503',
      source_url: 'https://www.eventbrite.com.au/e/perth-social-basketball-503',
      description: 'Eventbrite listing description'
    }
  ]) {
    const existingOrgSite = makeActivity({
      id: 'organizer_website_club_1',
      source: 'organizer_website',
      source_id: 'club_1',
      source_url: 'https://perthhoops.org.au/social-basketball',
      raw_source_url: 'https://perthhoops.org.au/social-basketball',
      verified: true,
      description: 'Official club timetable'
    });

    const incomingHigher = makeActivity({
      ...higher,
      raw_source_url: higher.source_url,
      verified: true
    });

    const res = deduplicateActivities([incomingHigher], [existingOrgSite]);
    assert.equal(res.activitiesToUpsert.length, 1);
    const merged = res.activitiesToUpsert[0];
    assert.equal(merged.id, 'organizer_website_club_1');
    assert.equal(merged.source_url, higher.source_url);
    assert.equal(merged.description, higher.description);
    assert.ok(merged.source_keys.includes('organizer_website_club_1'));
    assert.ok(merged.source_keys.includes(`${higher.source}_${higher.source_id}`));
    assert.equal(
      merged.sources.find(s => s.source_key === 'organizer_website_club_1').source_url,
      'https://perthhoops.org.au/social-basketball'
    );
  }
});

test('Humanitix source priority equals Eventbrite (5) and outranks Meetup/Facebook', () => {
  assert.equal(getSourcePriority('humanitix'), 5);
  assert.equal(getSourcePriority('humanitix'), getSourcePriority('eventbrite'));
  assert.ok(getSourcePriority('humanitix') > getSourcePriority('meetup'));

  const existingMeetup = makeActivity({
    id: 'meetup_801',
    source: 'meetup',
    source_id: '801',
    source_url: 'https://www.meetup.com/perth-hoops/events/801/',
    raw_source_url: 'https://www.meetup.com/perth-hoops/events/801/',
    verified: true
  });
  const incomingHumanitix = makeActivity({
    id: 'humanitix_802',
    source: 'humanitix',
    source_id: '802',
    source_url: 'https://events.humanitix.com/perth-social-basketball',
    raw_source_url: 'https://events.humanitix.com/perth-social-basketball',
    verified: true
  });

  const res = deduplicateActivities([incomingHumanitix], [existingMeetup]);
  assert.equal(res.activitiesToUpsert.length, 1);
  assert.equal(res.activitiesToUpsert[0].id, 'meetup_801');
  assert.equal(res.activitiesToUpsert[0].source_url, 'https://events.humanitix.com/perth-social-basketball');
});



