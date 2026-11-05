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

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->
- Organizer self-serve listing submission and anti-spam verification mechanism.
- URL structure and dynamic meta tags for local SEO (e.g., per-suburb and per-sport landing pages).
- Crawler resilience, schema drift detection, and breakage alerting.

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; closed, never graduates -->
- Activity format and intensity / skill level tiers (ruled out for MVP to eliminate classification overhead; simple sport + location first).
- In-platform booking, ticketing, payments, and RSVP management (pure discovery and external referral engine).
- Automated heartbeat verification and stale listing pruning (ruled out for MVP to minimize complexity; deferred to post-MVP).
- Native mobile applications (iOS/Android) — responsive web only.
- Attendee account creation or user login (open, zero-friction discovery).
