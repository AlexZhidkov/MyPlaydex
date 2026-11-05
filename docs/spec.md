# MyPlaydex — Product & Technical Architecture Specification

**Version:** 1.0.0-mvp  
**Status:** Build-Ready  
**Launch Scope:** Greater Perth Amateur & Casual Sports Discovery  
**Target Platform:** Web (Desktop, Tablet, Mobile Responsive)  
**Infrastructure Stack:** Firebase Hosting, Cloud Firestore (Blaze Free Tier), GitHub Actions (Node.js 22 LTS), Vanilla JavaScript, Leaflet.js (OpenStreetMap)  

---

## 1. Executive Summary & Vision

MyPlaydex is a zero-friction discovery platform designed to help community members, newcomers, and sports enthusiasts find amateur, social, and casual sporting activities across Greater Perth, Western Australia.

### Core Problems Solved
1. **Fragmented Information:** Sports clubs and community pickup games are currently scattered across council event calendars, private Meetup groups, state sports association registers, Facebook groups, and ticketing platforms.
2. **High Discovery Friction:** Users are often forced to create accounts, join closed walled gardens, or decipher complex sports administration portals just to see when a casual badminton, pickleball, or soccer game is happening.
3. **Outdated Listings & Stale Data:** Platforms degrade quickly when reliance is placed on clubs manually maintaining profiles without curation.

### Solution & MVP Guiding Principles
- **Open, Account-Free Discovery:** No user accounts, passwords, or logins required for attendees. Anyone can open MyPlaydex, set their suburb or drop a pin, and see what activities are happening nearby.
- **Pure Discovery & Referral Engine:** MyPlaydex does not process payments, tickets, or RSVPs in MVP. Every Activity links directly out to the club's official website, ticketing URL, or registration portal.
- **Curated Ingestion First:** Data freshness is guaranteed via automated daily crawler scripts harvesting public portals, complemented by a zero-friction email suggestion workflow for club maintainers.
- **Zero-Cost Free-Tier Architecture:** Built entirely within the limits of Google Cloud / Firebase Free Tier quotas (Firestore 50k reads/day, static Firebase Hosting) and free GitHub Actions runner minutes.

---

## 2. Domain Vocabulary & Ubiquitous Language

All system components, database schemas, API contracts, and user-facing copy strictly adhere to the bounded context defined in [`GLOSSARY.md`](../GLOSSARY.md):

| Term | Definition | Forbidden Synonyms |
| :--- | :--- | :--- |
| **Activity** | A specific sports game, social kickabout, training session, or match that people can attend. | *Event, Gig, Happening* |
| **Club** | The sports club, community association, or league that organizes and hosts activities. | *Organizer, Host, Business, Vendor* |
| **Venue** | The physical location (park, oval, court, leisure centre, beach) where an activity takes place, with geo-coordinates. | *Place, Facility, Ground* |
| **Listing** | The published record on MyPlaydex representing an Activity, with dates, demographics, cost, and external referral link. | *Post, Entry, Ad, Submission* |

---

## 3. System Architecture & Topology

```
+-----------------------------------------------------------------------------------+
|                              DATA INGESTION PIPELINE                              |
|                                                                                   |
|  [DLGSC Club API]      [Stirling Events]      [Eventbrite JSON-LD]      [Meetup]  |
|         │                     │                        │                   │      |
|         ▼                     ▼                        ▼                   ▼      |
|  ┌─────────────────────────────────────────────────────────────────────────────┐  |
|  │ GitHub Actions Scheduled Cron Runner (01:00 AWST / 17:00 UTC daily)          │  |
|  │ - Fail-fast network fetchers (src/crawlers/*.js)                            │  |
|  │ - Anomaly & schema drift detection (zero-yield & >20% invalid drop thresholds)│  |
|  │ - Canonical schema sanitization & precision-9 geohash (src/sanitizer.js)    │  |
|  │ - Chunked batch upsert (<=500 docs, merge: true) (src/firestore-adapter.js) │  |
|  └──────────────────────────────────────┬──────────────────────────────────────┘  |
+-----------------------------------------┼-----------------------------------------+
                                          │
                                          ▼
+-----------------------------------------------------------------------------------+
|                             STORAGE & CLOUD BACKEND                               |
|                                                                                   |
|  ┌─────────────────────────────────────────────────────────────────────────────┐  |
|  │ Google Cloud Firestore (activities collection)                               │  |
|  │ - Idempotent Document IDs: ${source}_${source_id}                           │  |
|  │ - Document fields: sport, venue, geohash, dates, cost, demographics         │  |
|  │ - Queries filtered by date/active status, keeping daily reads < 1,500/day   │  |
|  └──────────────────────────────────────▲──────────────────────────────────────┘  |
+-----------------------------------------┼-----------------------------------------+
                                          │ HTTP GET (on client load)
                                          │
+-----------------------------------------------------------------------------------+
|                           CLIENT DISCOVERY INTERFACE                              |
|                                                                                   |
|  ┌─────────────────────────────────────────────────────────────────────────────┐  |
|  │ Firebase Hosting Static Single Page App (Vanilla JS + Leaflet.js)           │  |
|  │                                                                             │  |
|  │  ┌─────────────────────────────┐           ┌─────────────────────────────┐  |
|  │  │ Interactive Leaflet Map     │           │ Reactive Activity Feed      │  |
|  │  │ - OpenStreetMap vector pins │ ◄───────► │ - Sport, Cost, Gender filters│  |
|  │  │ - Proximity circle overlay  │  Bi-dir   │ - Proximity distance sort   │  |
|  │  │ - Drag/zoom center point    │   Sync    │ - Deep link & mailto edit   │  |
|  │  └─────────────────────────────┘           └─────────────────────────────┘  |
|  │                                                                             │  |
|  │  Reactive Pub-Sub Store (src/discovery-engine.js)                           │  |
|  │  - In-memory Haversine distance ranking (<0.05ms execution time)            │  |
|  │  - URL State Synchronization (HTML5 History pushState / debounced replace)  │  |
|  └─────────────────────────────────────────────────────────────────────────────┘  |
+-----------------------------------------------------------------------------------+
```

---

## 4. Data Ingestion Pipeline & Crawler Harness

### 4.1 Upstream Source Strategy

Based on comprehensive feasibility research ([Ticket 01](../.scratch/perth-sports/issues/01-research-perth-data-sources.md) & [`docs/research/01-perth-sports-data-sources.md`](research/01-perth-sports-data-sources.md)), MyPlaydex targets 5 primary high-yield sources:

| Source | Access Mechanism | Volume (Perth) | Data Quality | Ingestion Method |
| :--- | :--- | :--- | :--- | :--- |
| **WA DLGSC Directory** | Public REST JSON | ~5,000 clubs | High (verified geo) | Direct JSON fetch |
| **City of Stirling Events** | Kendo UI JSON endpoint | ~100–300 items | High (recreational) | Direct API POST |
| **Eventbrite Perth** | Schema.org Event JSON-LD | ~150–400 items | Medium-High | SSR HTML microdata parse |
| **Meetup Perth Sports** | Embedded SSR Redux State | ~200–500 items | High (social pick-up)| Next.js script extraction |
| **Volleyball WA** | Public AJAX Directory | ~65 venues | High (volleyball) | Direct JSON query |

**Explicitly Excluded / External Referrals:**
- **PlayHQ & Squadi / Football West:** Protected by CloudFront WAF and lack public read APIs. Handled as external referral links rather than automated fixture scraping.
- **Facebook Events:** Excluded due to Meta Graph API permissions and strict anti-scraping walls.

### 4.2 Crawler Harness Architecture (`src/crawler-runner.js`)

The crawler harness is organized as a modular, decoupled pipeline:

```
[Upstream Web / API]
        │
        ▼
1. Fetcher Module (`src/crawlers/*.js`)
   - Returns Array of raw, source-specific payloads
        │
        ▼
2. Drift & Anomaly Gate
   - Check rawCount >= minExpectedListings (default 1)
        │
        ▼
3. Sanitizer (`src/sanitizer.js`)
   - Validates required fields
   - Normalizes taxonomy & demographics
   - Generates precision-9 Base32 geohash
   - Checks invalidCount / rawCount <= 20%
        │
        ▼
4. Persistence Adapter (`src/firestore-adapter.js`)
   - Chunks sanitized items into batches of <= 500
   - Writes idempotent documents via `batch.set(ref, doc, { merge: true })`
```

### 4.3 Resilience, Drift Detection & Alerting ([Ticket 07](../.scratch/perth-sports/issues/07-grill-crawler-resilience-and-alerting.md))

1. **Fail-Fast Network Policy:** No retry loops or exponential backoff logic on HTTP failures. Network timeouts or 4xx/5xx responses immediately fail that crawler to maintain fast, deterministic execution.
2. **Zero-Yield Anomaly Gate:** If an active crawler yields 0 items without throwing an HTTP error, the harness marks it as failed (`ERR_ZERO_YIELD`), alerting to upstream DOM selector changes or API deprecation.
3. **Validation Drop Rate Threshold:** If more than 20% of returned items fail schema validation (`invalidCount / rawCount > 0.20`), the run fails with `ERR_SCHEMA_DRIFT`. Any valid items in that batch are still saved so fresh data is not lost.
4. **Error Containment:** Crawlers run with isolated error boundaries. A crash in Eventbrite does not prevent Stirling or DLGSC crawlers from completing.
5. **Zero-Cost Alerting:** The runner exits with status `1` on any failure. GitHub Actions sends native failure notifications to the maintainer email (`azhidkov@gmail.com`) and outputs a structured Markdown report to `$GITHUB_STEP_SUMMARY`.

### 4.4 Automation Workflow (`.github/workflows/crawler-harness.yml`)

- **Cron Schedule:** Daily at `0 17 * * *` (01:00 AWST, Western Australia Standard Time).
- **Manual Trigger:** Supports `workflow_dispatch` with `crawler` selection and `dry_run` toggle.
- **Runtime:** `ubuntu-latest` with Node.js 22 LTS.
- **Pre-execution Verification:** Runs `npm test` before executing any crawler scripts.
- **Authentication:** Service account credentials stored in secret `FIREBASE_SERVICE_ACCOUNT_KEY` (injected via environment variable `FIREBASE_SERVICE_ACCOUNT_KEY`).

---

## 5. Domain Schema & Firestore Document Model

All records written to the Firestore collection `activities` conform to the canonical `ActivityDocument` schema:

```typescript
interface ActivityDocument {
  // Identifiers & Provenance
  id: string;                      // Deterministic: `${source}_${source_id}` (e.g. "stirling_12345")
  source: string;                  // "stirling" | "dlgsc" | "eventbrite" | "meetup" | "volleyball_wa" | "manual"
  source_id: string;               // Original platform identifier
  source_url: string;              // External referral link
  title: string;                   // Clean activity title
  description: string;             // Plain text summary
  
  // Taxonomy & Classification
  sport: SportCategory;            // Canonical taxonomy enum (11 categories)
  
  // Organizing Entity
  club: {
    name: string;                  // Organizing club or group name
    website: string | null;        // Club portal or social link
  };

  // Geospatial & Venue Details
  venue: {
    name: string;                  // Facility or park name
    address: string;               // Street address or suburb
    lat: number;                   // Latitude (WGS84, e.g. -31.8943)
    lng: number;                   // Longitude (WGS84, e.g. 115.8348)
    geohash: string;               // Precision-9 Base32 geohash (e.g. "qd678x2y1")
  };

  // Schedule & Recurrence
  schedule: {
    start_date: string;            // ISO Date: "YYYY-MM-DD"
    end_date: string | null;       // ISO Date: "YYYY-MM-DD" or null if recurring
    start_time: string | null;     // Format: "HH:mm" in AWST (e.g. "18:30")
    end_time: string | null;       // Format: "HH:mm" in AWST (e.g. "20:00")
    recurrence: 'none' | 'weekly'; // Recurrence pattern
    day_of_week: number | null;    // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  };

  // Financial & Registration
  cost: {
    is_free: boolean;              // Binary cost flag for filtering
    display_price: string;         // Human label: "Free", "$5 gold coin", "$15 casual entry"
  };

  // Demographics
  demographics: {
    gender: 'all' | 'women_only' | 'men_only';
    age: 'all' | 'adults' | 'juniors' | 'masters';
  };

  // Verification & Timestamps
  verified: boolean;               // True by default for crawler and approved entries
  created_at: string;              // ISO UTC timestamp
  updated_at: string;              // ISO UTC timestamp
}
```

### 5.1 Sports Taxonomy (`SportCategory`) ([Ticket 03](../.scratch/perth-sports/issues/03-grill-activity-taxonomy-and-filters.md))

The canonical taxonomy consists of 11 discrete categories tailored to Perth's recreational habits:
1. `soccer` (Football, futsal, social soccer)
2. `volleyball` (Indoor volleyball, beach volleyball)
3. `basketball` (Indoor basketball, 3x3, social pickup)
4. `afl` (Australian Rules Football, AFL 9s, social footy)
5. `tennis` (Social tennis, court round-robins)
6. `pickleball` (Pickleball clubs, open sessions)
7. `running` (Social run clubs, parkruns, trail groups)
8. `social-fitness` (Bootcamps, outdoor HIIT, casual fitness)
9. `walking` (Community walking groups, bushwalking)
10. `cricket` (Community cricket, indoor cricket, social matches)
11. `other` (Badminton, netball, swimming, squash, multisport)

### 5.2 Demographics & Cost Facets
- **Gender:** `'all'` (Mixed / Open), `'women_only'`, `'men_only'`.
- **Age Groups:** `'all'` (All Ages), `'adults'` (18+), `'juniors'` (<18), `'masters'` (35+).
- **Cost Filter:** Binary toggle in UI (`freeOnly`). If true, filters for `cost.is_free === true`. Exact fees are displayed descriptively on cards.

---

## 6. Geospatial Search Architecture & Performance

### 6.1 The Firestore Geo-Query Dilemma & Decision ([Ticket 02](../.scratch/perth-sports/issues/02-research-firestore-geohash-schema.md))

Standard bounding-box geohash queries in Cloud Firestore require dividing proximity queries into 4 to 9 discrete prefix range queries. Combining these with sport filters and temporal ranges triggers complex compound indexes, multi-read costs, and high client query orchestration complexity.

Across Greater Perth, the total active casual sports catalog is estimated between **500 and 1,500 active activities**. 

**Selected Pattern: Ingestion Geohash + Client-Side Haversine Ranking**
1. **On Write:** Venue coordinates are indexed with a precision-9 Base32 geohash (`src/geohash.js`) down to ~4.8m resolution, future-proofing for server-side bounds if the catalog scales globally.
2. **On Read:** The client fetches active upcoming activities via standard temporal filters (`end_date >= today`).
3. **In-Memory Discovery:** The client uses the pure-function reactive engine (`src/discovery-engine.js`) to calculate exact Haversine distance from the user's selected search center (`lat, lng`).

### 6.2 Benchmarked Client Performance

Client-side filtering and Haversine ranking on modern devices:
- **Execution Time:** ~0.04 ms for 100+ activities (measured in Node.js / V8).
- **Frame Budget Impact:** Consumes <0.25% of a 60 FPS (16.6 ms) frame budget.
- **Network Quota Impact:** A single user session costs 1 initial Firestore query read instead of dozens of bounding-box reads during map panning, keeping platform operations comfortably within the 50,000 read/day free limit.

---

## 7. Frontend Architecture & Discovery Interface

### 7.1 Tech Stack & Delivery
- **Framework:** Pure Vanilla JavaScript (ES2022+ modules) — zero framework runtime overhead (no React, Vue, or Angular bundle payload).
- **Mapping Engine:** Leaflet.js 1.9.4 with OpenStreetMap CARTO Positron vector tiles.
- **Hosting:** Firebase Hosting with global Fastly CDN caching.

### 7.2 Reactive Store Pattern (`src/discovery-engine.js`) ([Ticket 04](../.scratch/perth-sports/issues/04-prototype-vanilla-js-leaflet-map.md))

The interface is driven by a lightweight, pure JavaScript pub-sub state store (`createDiscoveryStore`):

```javascript
const store = createDiscoveryStore({
  activities: MOCK_PERTH_ACTIVITIES,
  center: { lat: -31.9505, lng: 115.8605, label: 'Perth CBD' },
  radiusKm: 15,
  filters: { sport: 'all', freeOnly: false, gender: 'all', age: 'all' }
});

store.subscribe('filter', ({ filteredActivities }) => renderCards(filteredActivities));
store.subscribe('hover', ({ hoveredActivityId }) => highlightMarker(hoveredActivityId));
store.subscribe('select', ({ selectedActivityId }) => selectAndCenter(selectedActivityId));
```

### 7.3 Split Explorer Dual-View Layout

The UI implements **Variant A (Split Explorer)** validated during prototyping:
- **Desktop / Tablet (>=860px):** 50% sticky left pane displaying the interactive Leaflet map with radius circle overlay; 50% right pane displaying filter pills and the scrollable Activity card feed.
- **Mobile Viewport (<860px):** Responsive 50/50 vertical split, ensuring user orientation on the map while browsing cards below.
- **Bi-directional Synchronization:**
  - **Card Hover / Focus → Map:** Mouseover or keyboard focus on a card immediately triggers `.custom-sport-pin.highlighted` on the corresponding map pin (CSS transform scale + pulse).
  - **Map Pin Click → Card:** Clicking any marker triggers a Leaflet popup and smooth-scrolls the card into view using `card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })`.
  - **Radius & Center Adjustments:** Dragging the search center marker or toggling radius pills (5 km, 10 km, 25 km) updates the circle overlay and re-ranks the card feed with immediate visual feedback.

---

## 8. URL Routing, Deep-Linking & SEO Strategy

### 8.1 HTML5 History Routing ([Ticket 08](../.scratch/perth-sports/issues/08-grill-url-routing-and-seo-meta.md))

The application uses clean HTML5 query parameters enabled by Firebase Hosting rewrites (`"rewrites": [{"source": "**", "destination": "/index.html"}]`):

```
https://myplaydex.com.au/?sport=pickleball&suburb=cottesloe&free=1&radius=10&activity=stirling_12345
```

### 8.2 History State Navigation Discipline
1. **Discrete State Transitions (`history.pushState`):**
   - Selecting a sport category pill.
   - Toggling the Free Only filter.
   - Changing the proximity radius button.
   - Selecting a specific activity pin/card.
   - *Result:* The browser's Back and Forward buttons navigate user filter history naturally.
2. **Continuous State Transitions (`history.replaceState`):**
   - Dragging the map canvas or search center marker.
   - Debounced by **300ms** to prevent flooding browser session history.
3. **Deep-Linking Hydration:**
   - On page load, if URL contains `?activity=<id>`, the store auto-selects that activity, centers the map, opens the Leaflet popup, and smooth-scrolls to the card.

### 8.3 SEO & Social Graph Metadata
- Standard Open Graph and Twitter Card tags embedded directly in the static `index.html` shell.
- Dynamic per-activity server-side rendering (SSR) via Cloud Functions is deferred to post-MVP to avoid function execution costs and cold-start latency.

---

## 9. Verification, Curation & Club Engagement Lifecycle

### 9.1 Trust & Verification Model ([Ticket 06](../.scratch/perth-sports/issues/06-grill-club-listing-verification-lifecycle.md))

To launch rapidly and avoid spam moderation infrastructure:
- **Automated Ingestion Only for MVP:** All published Listings originate from vetted public crawlers (DLGSC, City of Stirling, Eventbrite, Meetup, Volleyball WA) or verified maintainer entries.
- **Self-Serve Club Claiming Ruled Out of Scope:** Pre-publish moderation queues and self-serve club accounts are deferred to post-MVP.
- **Zero-Friction Email Suggestions:**
  - Header displays a clear **"Suggest an Activity"** action.
  - Each Activity card includes a **"Suggest an edit"** link.
  - Generates pre-populated `mailto:azhidkov@gmail.com` drafts with activity context pre-filled.

### 9.2 Deterministic Listing Expiration
- **One-off Activities:** Filtered out from queries and UI when `schedule.end_date < today()` (Western Australia AWST timezone).
- **Recurring Activities:** (`schedule.recurrence === 'weekly'`) remain visible indefinitely until manually updated or flagged.

---

## 10. Implementation Status & Artifact Index

All components specified in this document are backed by verified research, test suites, and reference implementations:

| Component | Repository Path | Test Verification | Ticket Reference |
| :--- | :--- | :--- | :--- |
| **Sports Data Feeds** | [`docs/research/01-perth-sports-data-sources.md`](research/01-perth-sports-data-sources.md) | Verified live APIs | [Ticket 01](../.scratch/perth-sports/issues/01-research-perth-data-sources.md) |
| **Geohash & Firestore Schema** | [`docs/research/02-firestore-geohash-schema.md`](research/02-firestore-geohash-schema.md) | Architectural Analysis | [Ticket 02](../.scratch/perth-sports/issues/02-research-firestore-geohash-schema.md) |
| **Sports Taxonomy & Facets** | [`src/sanitizer.js`](../src/sanitizer.js#L14-L35) | `test/sanitizer.test.js` | [Ticket 03](../.scratch/perth-sports/issues/03-grill-activity-taxonomy-and-filters.md) |
| **Reactive Discovery Engine** | [`src/discovery-engine.js`](../src/discovery-engine.js) | `test/discovery-engine.test.js` | [Ticket 04](../.scratch/perth-sports/issues/04-prototype-vanilla-js-leaflet-map.md) |
| **Leaflet Prototype UI** | [`prototype/index.html`](../prototype/index.html) | Browser validated | [Ticket 04](../.scratch/perth-sports/issues/04-prototype-vanilla-js-leaflet-map.md) |
| **Geohash Encoder** | [`src/geohash.js`](../src/geohash.js) | `test/geohash.test.js` | [Ticket 05](../.scratch/perth-sports/issues/05-task-setup-github-actions-crawler-harness.md) |
| **Data Sanitizer** | [`src/sanitizer.js`](../src/sanitizer.js) | `test/sanitizer.test.js` | [Ticket 05](../.scratch/perth-sports/issues/05-task-setup-github-actions-crawler-harness.md) |
| **Firestore Batch Adapter** | [`src/firestore-adapter.js`](../src/firestore-adapter.js) | `test/firestore-adapter.test.js` | [Ticket 05](../.scratch/perth-sports/issues/05-task-setup-github-actions-crawler-harness.md) |
| **Crawler Harness Runner** | [`src/crawler-runner.js`](../src/crawler-runner.js) | `test/crawler-runner.test.js` | [Ticket 05](../.scratch/perth-sports/issues/05-task-setup-github-actions-crawler-harness.md) |
| **Stirling Events Crawler** | [`src/crawlers/stirling-crawler.js`](../src/crawlers/stirling-crawler.js) | `test/stirling-crawler.test.js` | [Ticket 05](../.scratch/perth-sports/issues/05-task-setup-github-actions-crawler-harness.md) |
| **GitHub Actions Pipeline** | [`.github/workflows/crawler-harness.yml`](../.github/workflows/crawler-harness.yml) | GitHub Actions schema | [Ticket 05](../.scratch/perth-sports/issues/05-task-setup-github-actions-crawler-harness.md) |
| **Curation & Verification Rules** | [Ticket 06](../.scratch/perth-sports/issues/06-grill-club-listing-verification-lifecycle.md) | Design agreement | [Ticket 06](../.scratch/perth-sports/issues/06-grill-club-listing-verification-lifecycle.md) |
| **Crawler Resilience & Alarms** | [Ticket 07](../.scratch/perth-sports/issues/07-grill-crawler-resilience-and-alerting.md) | Design agreement | [Ticket 07](../.scratch/perth-sports/issues/07-grill-crawler-resilience-and-alerting.md) |
| **URL Routing & SEO Meta** | [Ticket 08](../.scratch/perth-sports/issues/08-grill-url-routing-and-seo-meta.md) | Design agreement | [Ticket 08](../.scratch/perth-sports/issues/08-grill-url-routing-and-seo-meta.md) |

### 11. Post-MVP Roadmap (Out of Scope for Initial Launch)
1. **Self-Serve Club Management:** Authenticated club portal allowing clubs to edit schedules, post notices, and manage multiple team divisions.
2. **Dynamic Social Image Generation:** Serverless Cloud Function generating dynamic Open Graph cards per Activity.
3. **Automated Heartbeat Checks:** Periodic HTTP HEAD checks against club referral URLs to automatically detect and flag dead links.
4. **Geographic Expansion:** Scaling crawler harness to additional Australian metropolitan regions (Melbourne, Sydney, Brisbane).
