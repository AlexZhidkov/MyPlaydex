## Destination

A build-ready Product & Technical Architecture Specification for MyPlaydex (launching with Greater Perth sports discovery), defining the data ingestion pipeline, domain schema, geo-search architecture, and verification lifecycle.

## Notes

Domain: MyPlaydex amateur and social sports discovery; Launch market: Greater Perth;
Skills to consult: `research`, `prototype`, `grilling`, `domain-modeling`;
Stack preferences: Firebase (Firestore + Hosting + Blaze tier), Vanilla JS + Leaflet.js (OpenStreetMap), GitHub Actions for scheduled crawling.

## Decisions so far

<!-- the index: one line per closed ticket, enough to judge relevance, then zoom the link for the detail the ticket holds -->
- [01-research-perth-data-sources](issues/01-research-perth-data-sources.md): Target 5 high-yield accessible sources (WA DLGSC Directory, City of Stirling Events, Eventbrite JSON-LD, Meetup SSR JSON, and Volleyball WA) for automated ingestion; rely on external links for PlayHQ/Squadi; rule out Facebook Events.
- [02-research-firestore-geohash-schema](issues/02-research-firestore-geohash-schema.md): Store precision-9 geohash on ingestion, query by sport/date, and perform client-side Haversine distance ranking for zero-cost interactive filtering within Firebase free tier.
- [03-grill-activity-taxonomy-and-filters](issues/03-grill-activity-taxonomy-and-filters.md): Lock 11 discrete sport categories (including separate tennis, pickleball, running, fitness, walking), binary Free-Only cost toggle, and basic gender/age filters; omit activity format tiers for MVP.
- [04-prototype-vanilla-js-leaflet-map](issues/04-prototype-vanilla-js-leaflet-map.md): Adopt pure JS pub-sub store with Split Explorer (Variant A) dual-view for bi-directional map-pin/card synchronization and zero-cost client-side radius adjustments.
- [05-task-setup-github-actions-crawler-harness](issues/05-task-setup-github-actions-crawler-harness.md): Configure GitHub Actions daily workflow (01:00 AWST, Node.js 22) with Firebase Admin SDK, precision-9 geohash generation, Activity schema sanitization, and <=500 batch Firestore upserts.
- [06-grill-club-listing-verification-lifecycle](issues/06-grill-club-listing-verification-lifecycle.md): Curate listings via crawlers and manual mailto suggestions for MVP; rule out self-serve submission and moderation queues; expire one-off activities deterministically by date.
- [07-grill-crawler-resilience-and-alerting](issues/07-grill-crawler-resilience-and-alerting.md): Enforce fail-fast execution without retries, fail on zero-yield (<1 listing) or >20% schema invalidation, write GitHub Step Summaries, and rely on native Actions email alerts.
- [08-grill-url-routing-and-seo-meta](issues/08-grill-url-routing-and-seo-meta.md): Use HTML5 query parameters with pushState for filter changes and debounced replaceState for map dragging; deep-link activities via `?activity=<id>`; embed static Open Graph shell on Firebase Hosting.
- [09-task-synthesize-architecture-spec](issues/09-task-synthesize-architecture-spec.md): Synthesize all technical decisions, schemas, crawler harness patterns, geohash search mechanisms, and UX flows into a canonical build-ready architecture specification at docs/spec.md.

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->
*(All initial fog has graduated into frontier tickets)*

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; closed, never graduates -->
- Activity format and intensity / skill level tiers (ruled out for MVP to eliminate classification overhead; simple sport + location first).
- In-platform booking, ticketing, payments, and RSVP management (pure discovery and external referral engine).
- Automated heartbeat verification and stale listing pruning (ruled out for MVP to minimize complexity; deferred to post-MVP).
- Native mobile applications (iOS/Android) — responsive web only.
- Attendee account creation or user login (open, zero-friction discovery).
- Self-serve Club listing publication forms, automated club claiming, and pre-publish moderation queues (ruled out for MVP to eliminate operational complexity; defer to post-MVP).
- Dynamic server-side rendering (SSR) via Cloud Functions / Cloud Run for per-activity Open Graph meta tags (deferred to post-MVP; static shell on Firebase Hosting).
