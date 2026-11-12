# Ingestion URL Verification and Unverified Listings

To prevent users from clicking broken or dead outbound links without discarding otherwise valid community activities, MyPlaydex decouples URL verification from individual crawlers into a dedicated verifier module (`src/url-verifier.js`) that runs as a pre-write ingestion gate (and standalone CLI) and degrades unreachable links into **Unverified Listings** (`verified: false`, `source_url: null`) rather than dropping the activity or running recurring background sweeps across Firestore.

## Considered Options

1. **Drop Listings with Broken URLs at Ingestion**: Rejected because many community sessions still have accurate venue coordinates and schedules; hiding them entirely deprives users of local discovery and prevents community members from submitting corrected links via "Suggest an edit".
2. **Two-Phase Firestore Write (Crawlers write unverified $\rightarrow$ Background Verifier updates Firestore)**: Rejected as the primary ingestion flow because it doubles Firestore write operations and creates an intermediate window where live users could click unverified broken links.
3. **Dedicated Pre-Write Verifier Stage with Firestore Deduplication + Standalone CLI**: Selected. Crawlers remain pure data collectors; `src/url-verifier.js` checks existing `/activities` records via batched reads (`db.getAll`) to skip already-verified URLs, attempts automated repair and HTTP probing (`HEAD` with `GET` fallback) only on new or previously failed URLs, and writes the final state in a single atomic batch.

## Consequences

- **Pure Crawlers**: Crawler modules in `src/crawlers/` only extract raw data and never perform URL health probes.
- **Deduplicated Verification**: Before probing, the verifier checks existing Firestore `/activities/{id}` documents (`db.getAll`) and an in-memory run cache. If an existing record has `verified: true` and its URL has not changed, network probing is skipped. Previously failed (`verified: false`) links are re-probed on subsequent runs to allow self-healing.
- **Automated Link Recovery**: Before declaring a URL broken, the verifier normalizes missing/insecure schemes (`https://`), trims malformed characters, follows HTTP `3xx` redirects to record the canonical destination URL, and falls back from `HEAD` to header-only `GET` requests when hosts reject `HEAD` (`403`/`405`). It never truncates paths to generic root homepages on `404`.
- **Firestore Schema**: Unreachable links set `verified: false`, `source_url: null`, and preserve the original string in `raw_source_url` for curation and debugging.
- **Whole-Card UI Degradation**: Verified cards remain whole-card clickable (`data-url`, `tabindex="0"`, `cursor: pointer`). Unverified cards render an `Unverified` badge in Tier 1, apply `.activity-card-unverified` (`cursor: default`, no `data-url` or `tabindex`), and keep the Google Maps venue row (`.card-venue-row`) and "Suggest an edit" link interactive.
