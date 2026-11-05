Type: task
Status: resolved
Assignee: alex
Blocked by: 01, 02, 03, 04, 05, 06, 07, 08

## Question

How should all architectural decisions, crawler harness patterns, Firestore schemas, geohash search mechanisms, verification lifecycles, and front-end interaction designs resolved across tickets 01 through 08 be synthesized into a canonical, build-ready Product & Technical Architecture Specification at `docs/spec.md`?

## Answer

Synthesized all technical decisions, prototypes, schemas, and research into a canonical, production-ready Product & Technical Architecture Specification at [`docs/spec.md`](../../../docs/spec.md).

Key sections codified:
1. **Executive Summary & Vision**: Open, zero-friction casual sports discovery for Greater Perth without user logins or in-app payments.
2. **Domain Model & Taxonomy**: Canonical Activity, Club, Venue, Listing definitions (`GLOSSARY.md`), 11 first-class sports categories, demographic facets, and binary Free-Only filtering.
3. **Data Ingestion Pipeline**: 5 prioritized sources (WA DLGSC, City of Stirling Events, Eventbrite JSON-LD, Meetup SSR JSON, Volleyball WA), fail-fast network policy, zero-yield and >20% invalid anomaly gates, and daily 01:00 AWST GitHub Actions execution.
4. **Geospatial & Storage Strategy**: Firestore precision-9 geohash on ingestion + client-side in-memory Haversine distance ranking (0.04 ms runtime, zero multi-box query costs, strictly within 50,000 read/day free tier).
5. **Frontend Architecture & UX**: Pure Vanilla JS + Leaflet.js reactive pub-sub store, Split Explorer dual-view layout, and bi-directional map pin/card synchronization.
6. **URL Routing & Deep-Linking**: HTML5 History pushState for discrete filter changes and 300ms debounced replaceState for map dragging; direct deep-linking via `?activity=<id>`.
7. **Verification & Curation Lifecycle**: Automated crawler ingestion and zero-friction mailto suggestions for MVP; deterministic expiration of past activities; post-MVP deferral of self-serve club auth and SSR.
