# Humanitix Public Search SSR Drip Sync and Finite Weekly Retention

To ingest Greater Perth `Activity` records from Humanitix without relying on the organizer-scoped official REST API or scraping all-of-Australia sitemaps, MyPlaydex polls Humanitix's public Greater Perth search SSR pages (`https://humanitix.com/au/search/au--wa--perth?categories=<category>`) and optional `POST /api/search` pagination via zero-dependency Node `fetch` in a local 24-hour rolling `HPt640` drip sync (`src/humanitix-sync.js`). Syncs perform zero detail-page requests, exclude `businessAndProfessional` and unfiltered `all` feeds, rank `humanitix` equal to `eventbrite` (`5`) in multi-source deduplication, and anchor `expire_at` to `schedule.end_date` when finite recurring term series end within 6 months.

## Considered Options

1. **Official Humanitix REST API (`https://api.humanitix.com/v1/events`)**: Rejected because standard API keys are strictly scoped to the authenticated host account's own events rather than platform-wide public discovery.
2. **AU Sitemaps (`events.humanitix.com/sitemaps/sitemap-au-*.xml`) + Detail-Page Scraping**: Rejected because AU sitemaps mix all Australian states and would require fetching thousands of individual event pages to filter for Greater Perth.
3. **Headless Browser Rendering (`firecrawl-local` / Playwright)**: Rejected because Humanitix's search SSR (`__NEXT_DATA__`) returns HTTP 200 structured JSON directly to raw `fetch`, avoiding Chromium overhead.
4. **Public Search SSR + `/api/search` Local 24-Hour Drip Sync**: Selected. Mirrors [ADR 0008](0008-nine-category-taxonomy-and-eventbrite-drip-sync.md) using `src/file-cache.js` (24-hour TTL), oldest-first rotation, fetch budgeting, jittered pacing, and a `429`/`403` circuit breaker.

## Consequences

- **Feed Scope & Taxonomy Mapping (`src/crawlers/humanitix-crawler.js`, `src/crawlers/humanitix-parser.js`)**:
  - Polls 11 Greater Perth category feeds: the 9 canonical verticals (`sportsAndFitness`, `healthAndWellness`, `performingAndVisualArts`, `music`, `communityAndCulture`, `familyAndEducation`, `foodAndDrink`, `hobbiesAndSpecialInterest`, `travelAndOutdoor`), `charityAndCauses` (mapped into `community`, priority `1`), and `other` (priority `0`, category inferred from title or falling back to `community`).
  - Excludes `businessAndProfessional` and the unfiltered `all` feed (which mixes B2B networking and IT training courses).
- **Zero Detail-Page Requests & Nameless Organizer Suppression**:
  - Ingests directly from search payloads (`_id`, `name`, `slug`, `hostname`, `dates`, `isRecurring`, `eventLocation`, `pricing`, `suspendSales`, `offSaleDateIds`) and resolves coordinates via Greater Perth suburb/postcode centroids.
  - Because search payloads omit `organizer` names, raw listings omit `organizer` so `src/crawler-runner.js` suppresses synthetic `/organizers` documents and flags unmatched records as `Unreviewed Listing` ([ADR 0008](0008-nine-category-taxonomy-and-eventbrite-drip-sync.md)).
- **Pre-Ingestion Noise Filtering**:
  - Hard-drops non-in-person events (`eventLocation.type !== 'address'`), suspended/off-sale listings, non-WA or >85 km out-of-region venues, and non-Activity administrative/commercial titles (donations, player/club memberships, corporate IT/B2B courses, AGMs/EOIs).
- **Multi-Source Deduplication Precedence (`src/activity-deduplicator.js`)**:
  - Updates [ADR 0010](0010-activity-deduplication-and-source-merging.md) and [ADR 0013](0013-firecrawl-activity-extraction-and-directory-harvesting.md) precedence to `eventbrite = humanitix (5) > meetup (4) > council (3) > organizer_website (2) > facebook (1)`.
- **Finite vs. Perpetual Weekly `expire_at` (`src/sanitizer.js`)**:
  - Refines [ADR 0005](0005-firestore-native-ttl-retention-and-timestamp-migration.md): `computeActivityExpireAt` remains `null` for perpetual `recurrence: 'weekly'` Activities without an `end_date` (e.g. >6 months of future dates), while finite weekly series with an explicit `schedule.end_date` (such as an 8-week school-term program) expire 24 hours after `end_date` in AWST.
