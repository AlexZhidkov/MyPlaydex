# Google Places Entity Curation and Human Review Workflow

To establish a clean, canonical directory of physical locations and clubs without polluting `/venues` with noisy or duplicated crawler strings, MyPlaydex populates `/venues` (and baseline `/organizers`) via an on-demand local Google Places API (New) sync using Pro-tier fields, prohibits automated crawlers from creating new `/venues` documents, links crawled activities against existing canonical entities, and flags crawler-created `/organizers` and unmatched/uncertain links as Unreviewed Listings (`needs_review: true`) for human curation.

## Considered Options

1. **Unrestricted Crawler Upserts into `/venues` and `/organizers` (ADR 0001 / ADR 0004 status quo)**: Rejected because activity and directory crawlers produce inconsistent venue names, suburb-centroid fallback pins, and duplicate facility records that degrade directory quality.
2. **Strict Rejection of Unmatched Activities or Crawler-Discovered Organizers**: Rejected because informal community groups and casual clubs often lack a Google Maps Place listing; dropping them would hide valid community activities before a human curator can review them.
3. **Google Places Canonical Venue Catalog + Crawler Entity Matching with Human Review Flag (`needs_review`)**: Selected. `/venues` is populated exclusively from Google Places API (New); crawlers match against existing `/venues` and `/organizers`, create new `/organizers` only with `needs_review: true`, flag activities with unmatched or uncertain entity links as `needs_review: true`, and preserve human-approved (`needs_review: false`) records across subsequent crawler runs.

## Consequences

- **Supersedes Automatic Venue Upserts in ADR 0001 & ADR 0004**:
  - Activity crawlers (`stirling`, `meetup`, `eventbrite`) and directory crawlers (`dlgsc`, `volleyball_wa`) never create or upsert documents in `/venues`.
  - `/venues` is populated exclusively by the local on-demand Google Places sync (`src/places-sync.js`).
- **Cost-Controlled Google Places API (New) Sync**:
  - Requests strictly Pro-tier fields via `X-Goog-FieldMask` (`places.id`, `places.displayName`, `places.formattedAddress`, `places.location`, `places.types`, `places.primaryType`, `places.businessStatus`), omitting Enterprise contact fields (`websiteUri`, `nationalPhoneNumber`, `regularOpeningHours`) to minimize API costs.
  - Filters out `CLOSED_PERMANENTLY` places, stores `google_place_id`, `primary_type`, and `google_types`, and deduplicates against existing Firestore documents by `google_place_id` before falling back to deterministic slug IDs (`venue_${slug}_${geohash6}` and `org_${slug}`).
- **Crawler Matching & Human Review (`needs_review`)**:
  - Google Places records are written with `needs_review: false, review_reason: null`.
  - Crawler-created `/organizers` missing from `/organizers` are upserted with `needs_review: true, review_reason: 'crawler_created'`.
  - Activities whose Venue or Organizer match is uncertain or missing remain published in `/activities` (with `venue.id: null` when the venue is unmatched) and are marked `needs_review: true` with `review_reason` (`'unmatched_venue'`, `'uncertain_venue_match'`, `'unmatched_organizer'`, or `'uncertain_organizer_match'`).
  - Pre-write merge logic in `src/firestore-adapter.js` preserves `needs_review: false` and human-curated fields/links on re-crawl so manual approvals are never overwritten by daily crawler runs.
- **Outbound Google Maps Navigation via `google_place_id`**:
  - Matched Activity venue snapshots embed `google_place_id` alongside `{ id, name, coordinates, geohash }`.
  - `createOutboundDirectionsUrl()` in `src/discovery-ui.js` appends `&query_place_id=${google_place_id}` when available so outbound links open the exact Google Maps Place profile, falling back to coordinate search when `google_place_id` is absent.
