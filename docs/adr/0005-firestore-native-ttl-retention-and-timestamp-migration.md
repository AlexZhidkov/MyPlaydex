# Firestore Native TTL Retention and Timestamp Migration

To prevent unbounded database growth and avoid compute or document delete costs, MyPlaydex relies on Cloud Firestore native Time-To-Live (TTL) on a dedicated `expire_at` timestamp to automatically purge expired non-recurring activities after a 24-hour AWST grace period, while migrating audit timestamps to native Firestore `Timestamp` objects and pinning UI display formatting to `Australia/Perth`.

## Considered Options

1. **Custom Batch Ingestion Purge Runner**: Rejected in favor of native TTL because Firestore TTL deletions are completely free of charge and execute fully serverless without requiring custom delete scripts, IAM permissions, or GitHub Actions runtime overhead.
2. **Immediate Expiration at Midnight**: Rejected in favor of a 24-hour grace window (`end_date` + 24 hours in AWST) to ensure late-night activities and next-morning direct deep-link lookups (`?activity=<id>`) do not prematurely 404.
3. **Browser Local Time Conversion**: Rejected in favor of explicit `Australia/Perth` venue timezone pinning (`Intl.DateTimeFormat`) because scheduled activities occur physically at local venues; formatting against a remote user's device clock would display incorrect start times to travelers and out-of-region visitors.

## Consequences

- **Native TTL on `/activities`**:
  - Non-recurring activities compute `expire_at` as a native Firestore `Timestamp` set to the conclusion of the activity plus a 24-hour AWST grace buffer.
  - Weekly recurring activities set `expire_at: null`, preserving them perpetually from TTL deletion.
  - TTL policy is applied on the `activities` collection group on the `expire_at` field path (`gcloud firestore fields ttls update --collection-group=activities --field-path=expire_at`).
- **Client In-Memory Expiration Filtering**:
  - Because Firestore TTL deletes asynchronously within a 24 to 72-hour sweep window, `src/discovery-engine.js` retains `isActivityExpired()` for TTL alignment and filters the regular discovery feed via `isActivityUpcoming()` (AWST-pinned, without the 24-hour grace buffer) so only upcoming and currently ongoing activities appear in the feed while deep-linked records remain resolvable during the grace window.
- **Timestamp Standardization**:
  - `created_at` and `updated_at` across `/activities`, `/organizers`, `/venues`, and `/regions` are migrated from ISO 8601 strings to native Firestore `Timestamp` objects (`FieldValue.serverTimestamp()`).
  - One-off scheduled activity start/end times are stored as native Firestore `Timestamp` objects alongside canonical AWST string schedules.
- **Venue Timezone Display**:
  - All UI timestamp parsing and formatting in `src/discovery-ui.js` and `src/app.js` explicitly formats into `Australia/Perth` wall-clock time.
