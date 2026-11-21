# 9-Category Activity Taxonomy and Local 24-Hour Eventbrite Drip Sync Architecture

To accurately classify non-sport community Activities (concerts, arts workshops, food tastings, family gatherings, wellness sessions, hobby clubs, and outdoor trips) without collapsing them into a hardcoded `sports` category or polluting `/organizers` with synthetic organizer records named after Activity titles, MyPlaydex expands the Activity `category` taxonomy from hardcoded `sports` to the 9 canonical Eventbrite categories (`sports`, `health`, `arts`, `music`, `community`, `family`, `food`, `hobbies`, `travel`), resolves `subcategory` to a matched concrete sport slug or falls back to the canonical `category` slug (`'other'` for unclassified `sports`), suppresses standalone `/organizers` document creation in `src/crawler-runner.js` when a raw Activity lacks an Organizer name, and adopts a local 24-hour drip sync architecture for Eventbrite ingestion alongside the local Facebook Public Events sync ([ADR 0007](0007-facebook-public-events-local-sync.md)).

## Considered Options

1. **Keep Hardcoded `sports` Category + Unclassified `'other'` Subcategory**: Rejected because multi-vertical community Activities (music, arts, health, food, hobbies, family, community, travel) lose their primary vertical classification, preventing accurate filtering and discovery across non-sport verticals.
2. **Create Synthetic `/organizers` Documents from Activity Titles When Organizer Name Is Missing**: Rejected because nameless raw Activities (such as one-off Eventbrite listings without an explicit `organizer` field) would generate polluted, single-event Organizer documents named after the Activity title, degrading the Organizers directory.
3. **Unattended GitHub Actions Bulk Eventbrite Scraping**: Rejected because Eventbrite applies anti-bot challenges and rate limits to datacenter IPs when crawling multiple category pages in rapid succession.
4. **9-Category Taxonomy + Nameless Organizer Suppression + Local 24-Hour Eventbrite Drip Sync**: Selected. Expands `category` normalization across Activity sanitization and entity extraction, suppresses standalone Organizer creation for nameless Activities while flagging them as Unreviewed Listings (`needs_review: true`, `review_reason: 'unmatched_organizer'`), and spreads Eventbrite category/detail ingestion across a local 24-hour rolling drip sync with caching and pacing.

## Consequences

- **9 Canonical Activity Categories (`src/sanitizer.js`)**:
  - `CANONICAL_CATEGORIES` defines the 9 canonical categories: `sports`, `health`, `arts`, `music`, `community`, `family`, `food`, `hobbies`, `travel`.
  - `normalizeCategory` maps raw category strings and Eventbrite category labels (such as `Sports & Fitness`, `Health & Wellness`, `Performing & Visual Arts`, `Community & Culture`, `Family & Education`, `Food & Drink`, `Hobbies & Special Interest`, `Travel & Outdoor`) into the 9 canonical slugs, defaulting missing or unrecognized values to `'sports'`.
- **Subcategory Resolution (`src/sanitizer.js`)**:
  - `resolveActivitySubcategory` and `extractCanonicalEntities` resolve `subcategory` to a concrete matched sport slug (`soccer`, `running`, `social-fitness`, etc.) when present, fall back to the canonical `category` slug for non-sport categories (`category !== 'sports'`), and fall back to `'other'` for unclassified `sports` Activities.
- **Nameless Organizer Suppression (`src/crawler-runner.js`)**:
  - When a raw Activity lacks an explicit Organizer name (`organizer.name`, `organizer_name`, `club_name`, `club.name`, or `club`), `runCrawlerHarness` sets `entities.organizer = null` to suppress standalone `/organizers` document creation while marking the Activity as an Unreviewed Listing (`needs_review: true`, `review_reason: 'unmatched_organizer'`).
  - Raw Activities that provide an explicit Organizer name continue to create `crawler_created` Organizer records when unmatched against `/organizers` ([ADR 0006](0006-google-places-entity-curation-and-human-review.md)).
- **Local 24-Hour Eventbrite Drip Sync Architecture**:
  - Follows the same local-first ingestion pattern established in [ADR 0007](0007-facebook-public-events-local-sync.md) rather than unattended datacenter scraping: Eventbrite category discovery across the 9 canonical verticals is paced over a 24-hour rolling local drip window with local response caching and jittered request delays to avoid IP rate limiting while keeping Greater Perth Activities fresh.
