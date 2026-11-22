# Ingestion-Time Activity Deduplication and Multi-Source Merging

To prevent duplicate Activities across Eventbrite, Meetup, Facebook, and Greater Perth council calendars—as well as same-source ID drift and recurring vs. dated-occurrence collisions left open in [ADR 0009](0009-council-crawler-platform-adapters-and-venue-fallback.md)—MyPlaydex deduplicates Activity records at ingestion time into one canonical `/activities` document retaining its first-seen document ID, tracks all merged `Source Reference` links on the document, merges metadata using deterministic source precedence, flags borderline matches as `Unreviewed Listing`, surfaces verified secondary links on Activity cards, and provides a `--dry-run`/`--apply` CLI cleanup tool for existing records.

## Considered Options

1. **Client-Side Feed Deduplication Only (Keep Source-Keyed Docs in Firestore)**: Rejected because duplicate documents in `/activities` inflate Firestore document reads, complicate human curation and TTL retention, and leave the underlying database polluted.
2. **Content-Hash Canonical Document IDs**: Rejected because migrating away from `${source}_${source_id}` document IDs requires rewriting all existing `/activities` records and breaks document ID stability whenever an Activity title or Venue string changes slightly.
3. **Ingestion-Time Deduplication with First-Seen Document ID and `Source Reference` Merging**: Selected. Preserves existing `${source}_${source_id}` document IDs for backward compatibility with [ADR 0009](0009-council-crawler-platform-adapters-and-venue-fallback.md) while storing all matched `source_keys` and `sources` (`Source Reference` records) on the canonical Activity document so re-crawls from any source resolve idempotently.

## Consequences

- **Duplicate Identity & Matching Guardrails**:
  - High-confidence auto-merge requires: (1) matching date (or matching weekday when comparing a weekly recurring Activity with a dated occurrence) and both records having `start_time` within ±30 minutes, (2) matching canonical `venue.id` or non-fallback coordinates within ≤250 m, and (3) strong title similarity (normalized token Jaccard ≥ 0.65, or all tokens of the shorter title contained in the longer with ≥ 2 tokens) or matching canonical `organizer.id` with moderate title similarity (Jaccard ≥ 0.35).
  - Suburb-centroid and `unmatched_venue` fallback coordinates are strictly excluded from proximity matching so unrelated Activities sharing a suburb fallback pin never collide.
  - Distinct dates of a multi-date series remain separate occurrences; same title at different Venues or different start times on the same date remain distinct Activities.
- **Borderline Match Handling**:
  - Candidates on the same date with `start_time` within ±60 minutes (or missing `start_time` on one side) and matching Venue or ≤500 m non-fallback proximity with weaker title similarity (Jaccard ≥ 0.25) or same Organizer—or same date, exact normalized title, and same Organizer when one side uses a fallback Venue—are kept separate and flagged as `Unreviewed Listing` (`needs_review: true`, `review_reason: 'possible_duplicate'`, storing `duplicate_candidate_id`).
- **Source Precedence & Metadata Merging**:
  - Primary outbound `source_url` follows deterministic source priority `eventbrite > meetup > council > facebook`, with `verified: true` always taking precedence over unverified URLs.
  - Non-URL fields (`description`, `cost`, `venue`, `organizer`, `demographics`) prefer the more complete or specific value (such as a matched canonical Venue over a fallback centroid, or populated descriptions/prices over empty values), using source priority to break ties while preserving human-approved curation when `needs_review === false`.
- **Recurring vs. Dated Collisions**:
  - High-confidence matches between a perpetual `recurrence: 'weekly'` Activity and a dated occurrence are absorbed into the weekly Activity (retaining `recurrence: 'weekly'` and attaching the dated `Source Reference`), while divergent-title overlaps remain separate and are flagged as `Unreviewed Listing`.
- **Parser Stability, Link Failover, UI & Cleanup**:
  - Council Kentico/Kendo adapters replace unstable `index + 1` ID fallbacks with deterministic URL (or title + date) slugs; Facebook recurring `child_events` avoid emitting a duplicate bare parent Activity for the same date.
  - Pre-write URL verification probes secondary `Source Reference` URLs in priority order and promotes the first healthy link to primary before degrading an Activity to an `Unverified Listing`.
  - Discovery Activity cards keep whole-card click opening the primary verified link and render a compact `Also on: ...` row for additional verified `Source Reference` links whose URL differs from the primary (without triggering card navigation).
  - A reusable CLI deduplication script scans existing `/activities` in `--dry-run` mode by default and merges/deletes redundant records under `--apply`.
