# 02: Standardize Audit Fields to Native Firestore Timestamps

**What to build:** Database records across all collections (`/activities`, `/organizers`, `/venues`, and `/regions`) use native Firestore Timestamps for `created_at` and `updated_at` audit fields. The web app transparently unwraps these timestamps on fetch, and offline mocks maintain schema parity.

**Blocked by:** None (can start immediately)

**Status:** closed

- [x] Ingestion adapter writes `created_at` and `updated_at` as native Firestore `Timestamp` objects (or `FieldValue.serverTimestamp()`) across `/activities`, `/organizers`, `/venues`, and `/regions`
- [x] Client REST deserializer unwraps `timestampValue` fields into standard date values without runtime errors
- [x] Security rules comments and schema definitions document `timestamp` types for audit fields
- [x] Unit and integration tests verify multi-collection batch persistence and round-trip deserialization
