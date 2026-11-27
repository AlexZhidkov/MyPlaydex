# `/admin` Curation Workspace and `curated_fields` Overwrite Protection

To allow `Admin` operators to review, verify, edit, and remove published `Listing` records in `/admin` without manual edits being overwritten by automated crawlers or Google Places re-syncs, MyPlaydex records edited field paths in a per-document `curated_fields` array (`string[]`), propagates denormalized `Venue` and `Organizer` snapshot edits to linked `Activity` documents while blocking deletion of referenced entities, and queries `/admin` using single-field Firestore queries with client-side filtering.

## Considered Options

1. **Whole-document freeze on `needs_review === false`**: Rejected because freezing an entire `Listing` prevents automated crawlers from appending newly discovered `Source Reference` entries (`sources`/`source_keys`), merging new `subcategories`, or enriching untouched fields, and conflicts with Google Places re-syncs for `Venue` and `Organizer` records.
2. **Field-level `curated_fields` array (`string[]`) with coupled derived-field protection**: Selected. Preserves only the specific fields edited by an `Admin` (including cleared `null`, `false`, or `''` values and coupled derived fields) across all automated merges, `Activity` deduplication, and Google Places re-syncs while allowing untouched fields and new `Source Reference` links to update.
3. **Composite Firestore indexes for `/admin` queues**: Rejected to avoid index-deployment coupling for a low-volume internal workspace; parallel single-field queries across `/activities`, `/organizers`, and `/venues` with client-side sorting, filtering, and grouping require zero custom composite indexes.

## Consequences

- **`curated_fields` Overwrite Protection (`src/sanitizer.js`, `src/activity-deduplicator.js`, `src/firestore-adapter.js`)**:
  - When an `Admin` edits a `Listing` in `/admin`, modified field names (top-level or dot-notated paths) are appended to `curated_fields` and deduplicated, preserving any previously recorded `curated_fields`.
  - Automated `Activity`, `Organizer`, and `Venue` merges (`mergeActivityDocuments`, `mergeEntityDocuments`), cross-source `Activity` deduplication (`mergeMatchedActivities`, `deduplicateActivities`, `planActivityDeduplication`), and Google Places `google_place_id` re-syncs preserve every field listed in `curated_fields`—even when `nextDoc` comes from `google_places` or targets a `venue_*` record—including coupled derived fields (`coordinates` → `geohash`, `schedule` → `expire_at`) and `needs_review: false` when already approved.
  - Untouched fields, `Organizer`/`Venue` `subcategories`, and newly merged `Source Reference` entries (`sources`/`source_keys`) continue to receive automated updates. Legacy `needs_review: false` curation preservation (`CURATED_PRESERVED_FIELDS`) remains intact for records without `curated_fields`.
- **Denormalized `Activity` Snapshot Propagation and Delete Blocking**:
  - Extending [ADR 0004](0004-separate-activity-organizer-and-venue-discovery.md), editing a canonical `Venue` (`name` or `coordinates`/`geohash`) or `Organizer` (`name`) in `/admin` batch-updates the embedded `venue` or `organizer` snapshot and `updated_at` on all linked `Activity` documents (`venue.id == id` or `organizer.id == id`).
  - `Activity` `Listing` records may be deleted directly after `Admin` confirmation. Deleting a `Venue` or `Organizer` queries for linked `Activity` records (`venue.id == id` or `organizer.id == id`) and blocks deletion whenever one or more linked `Activity` records exist, surfacing their count and titles/IDs so the `Admin` can re-link or delete them first.
- **Single-Page `/admin` Query Strategy (`public/js/admin-data.js`, `public/js/admin-state.js`, `public/js/admin-ui.js`, `public/js/admin.js`)**:
  - Extending [ADR 0012](0012-dedicated-public-hosting-root-and-shared-modules.md) and [ADR 0014](0014-admin-google-auth-and-separate-workspace.md), `/admin` runs as zero-build Vanilla JS ES2022 using the CDN modular Firebase SDK.
  - Both initial views (`Unreviewed Listings` via `where('needs_review', '==', true)` and `New (Last 24h)` via `where('created_at', '>=', cutoffTimestamp)`) run parallel single-field queries across `/activities`, `/organizers`, and `/venues` with client-side sorting, entity/reason filtering, and grouping, requiring zero custom composite Firestore indexes.
