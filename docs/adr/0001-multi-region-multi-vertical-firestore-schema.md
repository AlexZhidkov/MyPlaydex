# Multi-Region and Multi-Vertical Firestore Schema Architecture

To support geographical expansion beyond Greater Perth and non-sporting verticals (concerts, theatre, children's activities) without exceeding Firestore's 50k reads/day free tier or executing multi-read client waterfalls, we are partitioning activities at the root collection level by `region_id`, replacing the flat `sport` taxonomy with a clean two-tier `category` + `subcategory` model, and establishing separate `/venues`, `/organizers`, and `/regions` collections while embedding read-optimized minimal snapshots into each `/activities` document.

## Considered Options

1. **Subcollections per Category (`/regions/{regionId}/{category}/{activityId}`)**: Rejected because Cloud Firestore cannot query across differently named collections in a single request, forcing the discovery feed to execute N parallel queries for a user browsing "All activities".
2. **Subcollections per Region (`/regions/{regionId}/activities/{activityId}`)**: Rejected in favor of a flat root collection `/activities` with indexed `region_id`, keeping query semantics clean and avoiding deeply nested document paths.
3. **Pure Relational Normalization (IDs only in `activities`)**: Rejected because Firestore does not support JOINs; fetching 100 activities on a map would require reading 100 venue documents or reading the entire venue database, blowing past free quotas.
4. **Native Firestore `GeoPoint`**: Rejected in favor of plain `{ lat, lng }` maps to avoid SDK serialization impedance mismatches with Leaflet (`.latitude` vs `.lat`) and allow pure JSON offline fixtures and mock data.

## Consequences

- **Activities Collection**: Root `/activities/{activityId}` contains indexed `region_id`, `category`, and `subcategory`. No legacy `sport` field.
- **Embedded Venue Snapshot**: `venue` on an activity only stores `{ id, name, coordinates: { lat, lng }, geohash }`. Street addresses are stored exclusively in canonical `/venues`. Coordinates remain plain `{ lat, lng }` objects.
- **Embedded Organizer Snapshot**: `organizer` on an activity only stores `{ id, name }`. Websites, social profiles, and descriptions are stored exclusively in canonical `/organizers`.
- **Dedicated Collections**:
  - `/regions/{regionId}`: Locality metadata, default centroid coordinates, and default discovery radius.
  - `/venues/{venueId}`: Canonical venue profiles with address, parking, and facility metadata, keyed by deterministic `venue_${slug}_${geohash6}` IDs.
  - `/organizers/{organizerId}`: Canonical organizer profiles with website, category type, and contact details, keyed by deterministic `org_${slug}` IDs.
- **Crawler Ingestion**: The batch persistence runner upserts canonical entities to `/venues` and `/organizers` in the same atomic batch write as the `/activities` documents.
