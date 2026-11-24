# Firecrawl Local Sidecar on HPt640 and JS-Rendering Fallback

To extract links and schedules from JavaScript-rendered `Organizer` SPAs (such as Wix, Squarespace, and React sites) and future PDF timetables without bloating GitHub Actions runners or bundling Playwright into the MyPlaydex repository, MyPlaydex adopts `firecrawl-local serve` as an optional, localhost-only `systemd --user` sidecar on `HPt640` (`127.0.0.1:3002`), accessed through a dedicated `src/firecrawl-client.js` HTTP transport module with serial concurrency (`1`), jittered pacing, and `src/file-cache.js` caching.

## Considered Options

1. **Keep Strict Zero-Browser / Zero-Dependency Scraping Everywhere**: Rejected because client-rendered `Organizer` websites return empty HTML shells to raw `fetch`, leaving `contact.facebook` unenriched and blocking future long-tail `Organizer` and PDF timetable ingestion.
2. **Add Playwright / Puppeteer Directly to `package.json`**: Rejected as the primary rendering runtime because it couples browser binary management, headless lifecycle, and PDF-to-Markdown conversion into every Node install and CI run, whereas `firecrawl-local` isolates Chromium behind a single 23 MB localhost HTTP binary.
3. **Optional `firecrawl-local` Sidecar on `HPt640` + Injectable `src/firecrawl-client.js` Transport**: Selected. Keeps GitHub Actions crawlers (`crawler-harness.yml`) fast and browser-free, degrades cleanly when `FIRECRAWL_LOCAL_URL` is unset, and establishes a single reusable transport for both deterministic JS fallbacks (Phase 1) and future LLM-backed `Organizer` / PDF `Activity` extraction (Phase 2).

## Consequences

- **Modifies [ADR 0007](0007-facebook-public-events-local-sync.md) and [ADR 0009](0009-council-crawler-platform-adapters-and-venue-fallback.md)**:
  - Carves out an explicit `HPt640` local-sidecar exception to the blanket no-headless-browser restriction, and relaxes the strict zero-scraping-dependency rule for future phases (such as adding an LLM SDK or HTML parser when regex parsing becomes brittle) while keeping `src/firecrawl-client.js` itself dependency-free via Node's built-in `fetch`.
- **Clean Transport & Graceful Degradation (`src/firecrawl-client.js`)**:
  - Enabled strictly via `FIRECRAWL_LOCAL_URL` (e.g. `http://127.0.0.1:3002`) or CLI flags; when unset, all crawlers and enrichers behave identically to raw `fetch`.
  - Exposes injectable `fetchFn` and `sleepFn` so all fallback behavior is 100% unit-testable without a running daemon or browser.
- **`HPt640` Resource Guardrails**:
  - `firecrawl-local serve` runs as a `systemd --user` service bound to `127.0.0.1:3002` with `Nice=15` and `MemoryMax=1.5G` (with IPv4 preference enabled in `/etc/gai.conf` to avoid IPv6 blackhole timeouts in its internal SOCKS5 proxy).
  - `src/firecrawl-client.js` enforces serial execution (`concurrency = 1`), jittered request pacing, and gzip-backed checkpoint caching via `src/file-cache.js` (protecting the thin client's 2-core CPU and eMMC storage).
- **Phased Rollout**:
  - **Phase 1**: Fallback in `src/organizer-enricher.js` — raw `fetch` remains the fast primary path; `firecrawl-local` is called only when raw `fetch` yields no discoverable Facebook URL (or fails with a transient client-render wall), returning rendered HTML/links for `extractFacebookUrlFromHtml`.
  - **Phase 2 (Future)**: Reuse `src/firecrawl-client.js` (`/v2/map` + `/v2/scrape` Markdown) to extract structured `Activity` records from long-tail `Organizer` websites and leisure-centre PDF timetables into `Unreviewed Listing` records.
