# Council Crawler Platform Adapters, Attribution, and Shared Venue Fallback

To scale Greater Perth council Activity ingestion beyond City of Stirling without duplicating scraping boilerplate, polluting `/organizers` with synthetic records on tourism aggregators, or hardcoding single-point fallback coordinates, MyPlaydex adopts config-driven, zero-dependency platform adapters (**Kentico/Kendo**, **Optimizely SSR JSON**, and **OpenCities HTML**) targeting the daily GitHub Actions harness, filters civic/admin notices and online-only items inside each adapter across all 9 canonical Activity categories, distinguishes LGA calendars (council as fallback `Organizer`) from tourism aggregators like Visit Perth (unset `Organizer` flagged as `Unreviewed Listing`), and extracts the 4-step Venue/coordinate fallback chain ([ADR 0007](0007-facebook-public-events-local-sync.md)) into the shared crawler harness pipeline.

## Considered Options

1. **Standalone Per-Council Crawlers with Hardcoded Fallback Coordinates**: Rejected because multiple Greater Perth LGAs share OpenCities and Kentico/Kendo platforms, duplicating pagination, date parsing, and noise filtering while hardcoding a single lat/lng per council degrades spatial accuracy.
2. **Add HTML Parsing or Headless Browser Dependencies (`cheerio`, `playwright`)**: Rejected to preserve the repository's zero-scraping-dependency architecture (`firebase-admin` only, per [ADR 0007](0007-facebook-public-events-local-sync.md)).
3. **Uniform Organizer Attribution (Always Council or Always Unset)**: Rejected because LGA calendars genuinely host council-run community Activities (where the council is a sensible fallback `Organizer`), whereas tourism aggregators like Visit Perth aggregate third-party commercial and community Activities that the City of Perth does not organize.
4. **Config-Driven Platform Adapters + Split Organizer Attribution + Shared Pre-Sanitization Venue Fallback**: Selected. Reuses platform adapters across councils via declarative config, aligns all councils (including Stirling) with the 9-category taxonomy ([ADR 0008](0008-nine-category-taxonomy-and-eventbrite-drip-sync.md)), runs Venue/coordinate resolution before sanitization in `src/crawler-runner.js`, and keeps daily CI execution with a local-sync escape hatch only if Cloudflare blocks datacenter IPs for a specific council.

## Consequences

- **Config-Driven Platform Adapters**:
  - Three zero-dependency platform adapters cover the initial Greater Perth council wave: Kentico/Kendo (refactoring `src/crawlers/stirling-crawler.js`), Optimizely SSR JSON (City of Perth / Visit Perth), and OpenCities HTML (City of Vincent and compatible Greater Perth LGAs).
  - Listing-page only by default (hydrating detail pages only when a council's listing view lacks a mandatory field), with polite inter-page delays (1–2s, injectable for tests), a 90-day horizon cutoff, and a 20-page / 200-Activity safety cap per council.
  - Deterministic `${source}_${source_id}` document keys are preserved; cross-source Activity deduplication remains a separate pipeline concern.
- **9-Category Taxonomy & Adapter-Level Noise Filtering**:
  - All council crawlers (including Stirling, migrated off hardcoded `category: 'sports'`) map council tags into the 9 canonical categories (`sports`, `health`, `arts`, `music`, `community`, `family`, `food`, `hobbies`, `travel`).
  - Civic/administrative notices (council meetings, public consultations, roadworks, bin/waste notices), online-only items, and already-expired items are filtered inside each adapter before `rawItems` enters `sanitizeListing`, preventing false `ERR_SCHEMA_DRIFT` failures.
- **Split Organizer Attribution**:
  - Explicit organizer names from council feeds are always preferred.
  - When absent, LGA calendars attribute the council as fallback `Organizer`, while tourism aggregators (Visit Perth) leave `Organizer` unset so `crawler-runner.js` suppresses `/organizers` creation and flags the Activity as an `Unreviewed Listing` (`needs_review: true`, `review_reason: 'unmatched_organizer'`).
- **Shared Pre-Sanitization Venue & Coordinate Resolution**:
  - The 4-step Venue fallback chain from `src/facebook-sync.js` (explicit coords → `/venues` catalog name/slug match → `src/perth-centroids.js` suburb lookup → council LGA centroid) is extracted for reuse in `src/crawler-runner.js` prior to `sanitizeListing`, flagging inferred coordinates as `Unreviewed Listing`.
- **Runner & CI Ergonomics**:
  - Council crawlers run in the daily GitHub Actions `crawler-harness.yml` by default, with per-council `minExpectedListings` (allowing `0` on low-volume councils) and a `--crawler=councils` group selector in `src/crawler-runner.js` and `crawler-harness.yml`.
