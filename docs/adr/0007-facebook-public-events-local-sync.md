# Facebook Public Events Local Sync and URL Probe Bypass

To ingest live, in-person community Activities hosted as Facebook Public Events without hitting Meta Graph API permissions (`Page Public Content Access`), datacenter IP login walls in GitHub Actions, or false-positive `Unverified Listing` degradation in `src/url-verifier.js`, MyPlaydex ingests Facebook Public Events via an on-demand or scheduled local CLI sync (`src/facebook-sync.js`), seeds discovery from `contact.facebook` links on `/organizers`, resolves missing event coordinates through a 4-step Venue fallback chain, protects against Facebook IP rate limits with tiered caching and rolling drip pacing, and bypasses HTTP verification probing for Facebook domains while preserving clickable referral links (`verified: true`).

## Considered Options

1. **Unattended GitHub Actions Crawler (`src/crawlers/`) or Official Meta Graph API**: Rejected because Meta deprecated public event search in Graph API v3.3+, gates Page event feeds behind Meta App Review (`Page Public Content Access`), and blocks unauthenticated datacenter HTTP requests with login interstitials and anti-bot challenges.
2. **Headless Browser Automation (Playwright / Puppeteer)**: Rejected to keep the repository lightweight and zero-dependency (`firebase-admin` only) without requiring multi-hundred-MB browser binaries.
3. **Organizer-Seeded Local On-Demand CLI Sync (`src/facebook-sync.js`) with Facebook URL Probe Bypass**: Selected. Harvests Facebook Page URLs from `/organizers` (`contact.facebook`, seeded via WA DLGSC) alongside explicit event/page URLs and `.ics` calendar exports, executes locally via injectable `fetchFn` with local checkpoint caching, resolves missing coordinates against canonical `/venues` and Perth suburb centroids, and exempts Facebook domains from HTTP probing in `src/url-verifier.js`.

## Consequences

- **Supersedes Facebook Exclusion in MVP Docs**:
  - Reverses the blanket exclusion of Facebook Public Events in `docs/spec.md` and `docs/research/01-perth-sports-data-sources.md` for local ingestion.
- **In-Person Multi-Vertical Scope**:
  - Ingests all live (`is_online: false`), non-expired, in-person Greater Perth (`<= 85 km`) Activities across both 0-hop (Organizer pages) and 1-hop (`event_suggested_events` / `friends_cut` on hydrated detail pages), without dropping `subcategory: 'other'` on 1-hop.
- **Non-Entity Route Filtering & URL Canonicalization**:
  - Treats `comet.fbweb.CometEventsHomeRoute` alongside `CometErrorRoute` and `CometHomeRoute` as a non-entity route (falling back from `/events` tabs to the Organizer's base page), skips appending `/events` to legacy `/pages/<Name>/<ID>` and `/people/<Name>/<ID>` routes, rejects generic non-Organizer Facebook paths (`search`, `media`, `/pages/category/...`), and deduplicates target fetches by canonical Facebook URL per run.
- **Pre-Hydration Expired/Online Filtering**:
  - Filters discovered `/events/<id>` links against summary records already parsed from the parent page, skipping detail-page network hydration when all summary records for an `eventId` are already Expired Activities or online.
- **Rate-Limit Resilience & Rolling Drip Mode**:
  - Separates transient `"Temporarily Blocked"` rate-limit responses from permanent non-entity routes (never caching rate-limited payloads or flagging them as broken Organizer handles), supports oldest-first target ordering with `--max-fetches=<N>`, jittered live-request pacing (`--delay-ms=3500` default with $\pm 30\%$ jitter), a 3-consecutive-hit circuit breaker, incremental Firestore batch upserts, and clean Firestore client termination on CLI exit.
- **Compressed Sidecar Cache & Tiered TTLs**:
  - Stores large cached bodies (>64 KB) as `.body.gz` sidecar files in `.scratch/facebook-sync-cache.json.d/` with batched index flushes and tiered TTLs (48h for Organizer pages, 14d for upcoming `/events/<id>` detail pages, 7d for non-entity routes).
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
