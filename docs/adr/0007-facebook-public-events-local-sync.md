# Facebook Public Events Local Sync and URL Probe Bypass

To ingest community sports activities hosted as Facebook Public Events without hitting Meta Graph API permissions (`Page Public Content Access`), datacenter IP login walls in GitHub Actions, or false-positive `Unverified Listing` degradation in `src/url-verifier.js`, MyPlaydex ingests Facebook Public Events via an on-demand local CLI sync (`src/facebook-sync.js`), seeds discovery from `contact.facebook` links on `/organizers`, resolves missing event coordinates through a 4-step Venue fallback chain, and bypasses HTTP verification probing for Facebook domains while preserving clickable referral links (`verified: true`).

## Considered Options

1. **Unattended GitHub Actions Crawler (`src/crawlers/`) or Official Meta Graph API**: Rejected because Meta deprecated public event search in Graph API v3.3+, gates Page event feeds behind Meta App Review (`Page Public Content Access`), and blocks unauthenticated datacenter HTTP requests with login interstitials and anti-bot challenges.
2. **Headless Browser Automation (Playwright / Puppeteer)**: Rejected to keep the repository lightweight and zero-dependency (`firebase-admin` only) without requiring multi-hundred-MB browser binaries.
3. **Organizer-Seeded Local On-Demand CLI Sync (`src/facebook-sync.js`) with Facebook URL Probe Bypass**: Selected. Harvests Facebook Page URLs from `/organizers` (`contact.facebook`, seeded via WA DLGSC) alongside explicit event/page URLs and `.ics` calendar exports, executes locally on-demand via injectable `fetchFn` with local checkpoint caching, resolves missing coordinates against canonical `/venues` and Perth suburb centroids, and exempts Facebook domains from HTTP probing in `src/url-verifier.js`.

## Consequences

- **Supersedes Facebook Exclusion in MVP Docs**:
  - Reverses the blanket exclusion of Facebook Public Events in `docs/spec.md` and `docs/research/01-perth-sports-data-sources.md` for local on-demand ingestion, keeping scope strictly within `category: 'sports'` and the 11 canonical sport subcategories.
- **Organizer Facebook Seeding (`contact.facebook`)**:
  - Canonical `/organizers` documents (`src/sanitizer.js`: `sanitizeOrganizer`, `extractCanonicalEntities`, `mergeEntityDocuments`) store a normalized `contact.facebook: string | null` URL (also populated when an Organizer's `website` is a `facebook.com` link).
  - `src/crawlers/dlgsc-crawler.js` extracts `item.Facebook` into `contact.facebook` and uses it as the Organizer's referral `source_url` ahead of the generic KidSport fallback when `item.Website` is absent.
- **Local On-Demand Sync CLI (`src/facebook-sync.js` / `npm run sync:facebook`)**:
  - Scans `/organizers` for `contact.facebook` seeds by default, and accepts `--url=<fb_event_or_page_url>`, `--organizer=<org_id>`, `--input=<path.ics|path.json|path.html>`, `--dry-run`, `--refresh`, and `--limit=<n>`.
  - Uses injectable `fetchFn` (supporting optional `.env` `FACEBOOK_COOKIE`) with a multi-tier parser (**Schema.org `Event` JSON-LD** $\rightarrow$ **embedded Relay `__bbox` / `ScheduledServerJS` JSON** $\rightarrow$ **OpenGraph `<meta>` tags** $\rightarrow$ **iCal `.ics`**) and caches responses in `.scratch/facebook-sync-cache.json`.
  - Keys records deterministically as `facebook_${eventId}` (or `facebook_${eventId}_${YYYYMMDD}` for multi-date recurring series) and filters out already-expired activities (`computeActivityExpireAt(schedule) <= now`) before Firestore batch upsert.
- **4-Step Venue & Coordinate Resolution ([ADR 0006](0006-google-places-entity-curation-and-human-review.md))**:
  1. Explicit `{ lat, lng }` from the Facebook payload (within Greater Perth `<= 85 km`), reconciled via `reconcileListingWithCatalog`.
  2. Normalized name/slug lookup against the pre-loaded `/venues` Google Places catalog when coordinates are absent—adopting the matched Venue's `{ lat, lng }`, `geohash`, and `google_place_id` (`needs_review: false` on a unique exact slug match; `needs_review: true, review_reason: 'uncertain_venue_match'` on partial/ambiguous matches).
  3. Greater Perth suburb/postcode centroid lookup (`src/perth-centroids.js`) from location/address/description text, flagged as `needs_review: true, review_reason: 'unmatched_venue'`.
  4. Parent Organizer's coordinates from `/organizers`, flagged as `needs_review: true, review_reason: 'unmatched_venue'` (dropping online events or events outside WA).
- **Facebook URL Probe Bypass ([ADR 0003](0003-ingestion-url-verification-and-unverified-listings.md))**:
  - `src/url-verifier.js` and `src/facebook-sync.js` do not execute network `HEAD`/`GET` probes against `facebook.com` / `fb.me` URLs.
  - Structurally valid Facebook Event and Page URLs are canonicalized (`https://www.facebook.com/...` with tracking query parameters stripped) and preserved with `verified: true` and `source_url` intact so cards remain clickable in the UI.
