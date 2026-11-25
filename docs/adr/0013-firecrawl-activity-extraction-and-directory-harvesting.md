# Firecrawl Activity Extraction, Hybrid LLM Parsing, and Directory Harvesting

Extending [ADR 0011](0011-firecrawl-local-sidecar-and-js-fallback.md) Phase 2, MyPlaydex ingests `Activity` records from existing `Organizer` websites (prioritizing those missing Eventbrite, Meetup, or Facebook `Source Reference` links), leisure-centre and council PDF timetables, and newly discovered club websites harvested from outbound links on council and state-association directories. Extraction runs as a capped, prioritized `HPt640` drip CLI using `/v2/map` and `/v2/scrape` with a hybrid pipeline: deterministic Schema.org `Event` JSON-LD extraction first, falling back to a zero-dependency Node `fetch` Gemini Flash structured-JSON extraction pass on scraped Markdown.

## Considered Options

1. **Deterministic-Only / Regex Parsing**: Rejected because unstructured `Organizer` pages and PDF timetables vary too widely across formats and layouts.
2. **Local LLM (Ollama) on `HPt640` or Firecrawl `/v2/extract`**: Rejected because `HPt640` (2 CPU cores, no GPU, 1.5 GB Chromium `MemoryMax`) cannot run fast local inference alongside Chromium, and delegating to `/v2/extract` gives less control over MyPlaydex's 9-category taxonomy and AWST date rules.
3. **External Search Engine APIs for Broad Discovery**: Rejected for now in favor of zero-extra-key outbound directory harvesting from council and state-association directories (e.g., DLGSC, Volleyball WA, council A–Z club lists).
4. **Materializing Weekly Timetable Classes into Dated Occurrences**: Rejected because [ADR 0005](0005-firestore-native-ttl-retention-and-timestamp-migration.md) and [ADR 0010](0010-activity-deduplication-and-source-merging.md) already model undated weekly programs as perpetual `schedule.recurrence: 'weekly'` (`expire_at: null`) and absorb dated duplicates into them.
5. **Hybrid JSON-LD + Gemini Flash REST (`fetch`) + Outbound Directory Harvesting**: Selected.

## Consequences

- **Modifies [ADR 0010](0010-activity-deduplication-and-source-merging.md) and extends [ADR 0011](0011-firecrawl-local-sidecar-and-js-fallback.md)**:
  - Primary outbound `Source Reference` URL precedence becomes `eventbrite > meetup > council > organizer_website > facebook` so an `Organizer`'s own website outranks login-walled Facebook links.
- **Per-Domain Crawl Funnel & Drip Prioritization**:
  - `/v2/map` (cached 14–30 days) filters candidate URLs by high-signal keywords (`/events`, `/calendar`, `/whats-on`, `/timetable`, `/schedule`, `/classes`, `/sessions`, `/fixtures`, `*.pdf`) and scrapes at most 3–5 URLs per domain (falling back to the homepage if none match).
  - Capped `HPt640` drip job (`src/file-cache.js` checkpoints) prioritizes:
    1. **Tier 1**: Leisure-centre/council PDFs and existing `Organizer` sites with 0 active `Activity` records and no Eventbrite/Meetup/Facebook `Source Reference`.
    2. **Tier 2**: Newly harvested outbound directory domains.
    3. **Tier 3**: Productive domains re-crawled every 7 days; zero-yield brochure sites backed off to 30 days.
- **Hybrid Extraction & Zero-Dependency Gemini Flash Transport**:
  - Deterministic Schema.org `Event` JSON-LD runs first; only pages and PDFs yielding no JSON-LD events call Gemini Flash via zero-dependency Node `fetch` (`GEMINI_API_KEY`, `responseMimeType: 'application/json'`, `responseSchema`, injectable `fetchFn` for unit tests), keeping `package.json` minimal (`firebase-admin` only).
- **Relaxed Curation Gate & Automated Guardrails**:
  - Extracted `Activity` records publish directly rather than forcing `Unreviewed Listing` on every LLM result, subject to three guardrails:
    1. **Hard drop**: records missing a title, missing both date and weekday, dated in the past or >6 months out, or classified as non-activity noise (AGMs, committee notices, job ads, private-lesson enquiries).
    2. **Flag as `Unreviewed Listing` (`needs_review: true`)**: when `Venue` cannot resolve to a canonical `Venue` or `Organizer` home `Venue`, or when LLM confidence is low or start time is missing.
    3. **Strict grounding**: attach the exact scraped page or PDF URL as `Source Reference` and run through `src/sanitizer.js` and `src/activity-deduplicator.js`.
- **New-Domain `Organizer` Policy**:
  - Harvested directory domains not yet in `/organizers` attach `organizer` metadata on the `Activity` without auto-creating `/organizers` documents, keeping `/organizers` curated.
- **Weekly Recurrence & Stale Auto-Delete**:
  - Undated weekly timetable classes emit `schedule.recurrence: 'weekly'` (`expire_at: null`); explicit calendar dates emit discrete dated `Activity` records.
  - When a previously scraped website or PDF re-crawls cleanly (`200 OK`, non-empty parse) and an extracted `recurrence: 'weekly'` `Activity` from that source is absent from the latest scrape, it is auto-deleted to prevent stale weekly timetables from lingering.
