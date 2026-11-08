# MyPlaydex — Product & Technical Architecture Specification

**Version:** 1.0.0-mvp  
**Status:** Build-Ready  
**Launch Scope:** Greater Perth Amateur & Casual Sports Discovery  
**Target Platform:** Web (Desktop, Tablet, Mobile Responsive)  
**Infrastructure Stack:** Firebase Hosting, Cloud Firestore (Blaze Free Tier), GitHub Actions (Node.js 22 LTS), Vanilla JavaScript, Outbound Google Maps Navigation

---

## 1. Executive Summary & Vision

MyPlaydex is a zero-friction discovery platform designed to help community members, newcomers, and sports enthusiasts find amateur, social, and casual sporting activities across Greater Perth, Western Australia.

### Core Problems Solved

1. **Fragmented Information:** Sports clubs and community pickup games are currently scattered across council event calendars, private Meetup groups, state sports association registers, Facebook groups, and ticketing platforms.
2. **High Discovery Friction:** Users are often forced to create accounts, join closed walled gardens, or decipher complex sports administration portals just to see when a casual badminton, pickleball, or soccer game is happening.
3. **Outdated Listings & Stale Data:** Platforms degrade quickly when reliance is placed on clubs manually maintaining profiles without curation.

### Solution & MVP Guiding Principles

- **Open, Account-Free Discovery:** No user accounts, passwords, or logins required for attendees. Anyone can open MyPlaydex, set their suburb or tap "Near Me", and see what activities are happening nearby.
- **Pure Discovery & Referral Engine:** MyPlaydex does not process payments, tickets, or RSVPs in MVP. Every Activity links directly out to the club's official website, ticketing URL, or registration portal, with outbound Google Maps links for physical venue navigation.
- **Curated Ingestion First:** Data freshness is guaranteed via automated daily crawler scripts harvesting public portals, complemented by a zero-friction email suggestion workflow for club maintainers.
- **Zero-Cost Free-Tier Architecture:** Built entirely within the limits of Google Cloud / Firebase Free Tier quotas (Firestore 50k reads/day, static Firebase Hosting) and free GitHub Actions runner minutes.

---

## 2. Domain Vocabulary & Ubiquitous Language

All system components, database schemas, API contracts, and user-facing copy strictly adhere to the bounded context defined in [`GLOSSARY.md`](../GLOSSARY.md):

| Term         | Definition                                                                                                              | Forbidden Synonyms                  |
| :----------- | :---------------------------------------------------------------------------------------------------------------------- | :---------------------------------- |
| **Activity** | A specific sports game, social kickabout, training session, or match that people can attend.                            | _Event, Gig, Happening_             |
| **Club**     | The sports club, community association, or league that organizes and hosts activities.                                  | _Organizer, Host, Business, Vendor_ |
| **Venue**    | The physical location (park, oval, court, leisure centre, beach) where an activity takes place, with geo-coordinates.   | _Place, Facility, Ground_           |
| **Listing**  | The published record on MyPlaydex representing an Activity, with dates, demographics, cost, and external referral link. | _Post, Entry, Ad, Submission_       |

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
|  │ Firebase Hosting Static Single Page App (Pure Vanilla JS, Zero Map Canvas)  │  |
|  │                                                                             │  |
|  │  ┌─────────────────────────────┐           ┌─────────────────────────────┐  |
|  │  │ Cold-Start Location Gate    │           │ Responsive Activity Feed    │  |
|  │  │ - "📍 Near Me" (GPS)        │           │ - Top Location & Filter Bar │  |
|  │  │ - Searchable suburb/postcode│  Unlocks  │ - Radius pills (5,10,25,All)│  |
|  │  │ - LocalStorage persistence  ├──────────►│ - Top 50 closest Activities │  |
|  │  │ - Zero-cost Perth centroids │           │ - Outbound Google Maps link │  |
|  │  └─────────────────────────────┘           └──────────────┬──────────────┘  |
|  │                                                           │                 |
|  │  ┌─────────────────────────────┐                          │                 |
|  │  │ Dedicated Filters (/#filters)│ ◄────────────────────────┘                 |
|  │  │ - Multi-select sport chips  │                                            |
|  │  │ - Stored in localStorage    │                                            |
|  │  └─────────────────────────────┘                                            |
|  │                                                                             │  |
|  │  Reactive State Store (src/discovery-engine.js)                             │  |
|  │  - In-memory Haversine distance ranking (<0.05ms execution time)            │  |
|  │  - HTML5 Hash Navigation (/#filters) & Activity Deep-Linking (?activity=id) │  |
|  └─────────────────────────────────────────────────────────────────────────────┘  |
+-----------------------------------------------------------------------------------+
```

---

## 4. Data Ingestion Pipeline & Crawler Harness

### 4.1 Upstream Source Strategy

Based on comprehensive feasibility research ([Ticket 01](../.scratch/perth-sports/issues/01-research-perth-data-sources.md) & [`docs/research/01-perth-sports-data-sources.md`](research/01-perth-sports-data-sources.md)), MyPlaydex targets 5 primary high-yield sources:

| Source                      | Access Mechanism         | Volume (Perth) | Data Quality          | Ingestion Method          |
| :-------------------------- | :----------------------- | :------------- | :-------------------- | :------------------------ |
| **WA DLGSC Directory**      | Public REST JSON         | ~5,000 clubs   | High (verified geo)   | Direct JSON fetch         |
| **City of Stirling Events** | Kendo UI JSON endpoint   | ~100–300 items | High (recreational)   | Direct API POST           |
| **Eventbrite Perth**        | Schema.org Event JSON-LD | ~150–400 items | Medium-High           | SSR HTML microdata parse  |
| **Meetup Perth Sports**     | Embedded SSR Redux State | ~200–500 items | High (social pick-up) | Next.js script extraction |
| **Volleyball WA**           | Public AJAX Directory    | ~65 venues     | High (volleyball)     | Direct JSON query         |

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
  id: string; // Deterministic: `${source}_${source_id}` (e.g. "stirling_12345")
  source: string; // "stirling" | "dlgsc" | "eventbrite" | "meetup" | "volleyball_wa" | "manual"
  source_id: string; // Original platform identifier
  source_url: string; // External referral link
  title: string; // Clean activity title
  description: string; // Plain text summary

  // Taxonomy & Classification
  sport: SportCategory; // Canonical taxonomy enum (11 categories)

  // Organizing Entity
  club: {
    name: string; // Organizing club or group name
    website: string | null; // Club portal or social link
  };

  // Geospatial & Venue Details
  venue: {
    name: string; // Facility or park name
    address: string; // Street address or suburb
    lat: number; // Latitude (WGS84, e.g. -31.8943)
    lng: number; // Longitude (WGS84, e.g. 115.8348)
    geohash: string; // Precision-9 Base32 geohash (e.g. "qd678x2y1")
  };

  // Schedule & Recurrence
  schedule: {
    start_date: string; // ISO Date: "YYYY-MM-DD"
    end_date: string | null; // ISO Date: "YYYY-MM-DD" or null if recurring
    start_time: string | null; // Format: "HH:mm" in AWST (e.g. "18:30")
    end_time: string | null; // Format: "HH:mm" in AWST (e.g. "20:00")
    recurrence: "none" | "weekly"; // Recurrence pattern
    day_of_week: number | null; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  };

  // Financial & Registration
  cost: {
    is_free: boolean; // Binary cost flag for filtering
    display_price: string; // Human label: "Free", "$5 gold coin", "$15 casual entry"
  };

  // Demographics
  demographics: {
    gender: "all" | "women_only" | "men_only";
    age: "all" | "adults" | "juniors" | "masters";
  };

  // Verification & Timestamps
  verified: boolean; // True by default for crawler and approved entries
  created_at: string; // ISO UTC timestamp
  updated_at: string; // ISO UTC timestamp
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
- **Mapping & Outbound Navigation:** Zero embedded map canvas. Leaflet.js and OpenStreetMap vector tiles are removed for MVP ([ADR 0002](adr/0002-outbound-navigation-minimalist-feed.md)). Venue navigation is delegated to external Google Maps deep links.
- **Hosting:** Firebase Hosting with global Fastly CDN caching.

### 7.2 Reactive Store Pattern (`src/discovery-engine.js`)

The interface is driven by a lightweight, pure JavaScript pub-sub state store (`createDiscoveryStore`):

```javascript
const store = createDiscoveryStore({
  activities: MOCK_PERTH_ACTIVITIES,
  location: null, // null until set via GPS or suburb/postcode input
  radiusKm: 15,   // 5, 10, 25, or 'all'
  filters: {
    sports: [],   // Array of selected SportCategory slugs (OR logic; empty = all)
  },
  maxResults: 50,
});

store.subscribe("location", ({ location, filteredActivities }) => {
  renderFeed(filteredActivities);
});
store.subscribe("radius", ({ radiusKm, filteredActivities }) => {
  renderFeed(filteredActivities);
});
store.subscribe("filters", ({ filters, filteredActivities }) => {
  updateFilterIconState(filters);
  renderFeed(filteredActivities);
});
```

### 7.3 Cold-Start Onboarding Flow (Location Gate)

To maintain a clean and battery-efficient initial load:
- **Zero Activities on Cold Start:** No Activities are rendered until the user explicitly sets their location.
- **Onboarding Interface:**
  - Primary Action: **"📍 Use My Current Location"** triggering the browser Geolocation API (`navigator.geolocation.getCurrentPosition`).
  - Searchable Suburb / Postcode Input: Instant autocomplete powered by a static, zero-cost dictionary of Greater Perth suburbs and postcodes with centroid `{ lat, lng }` coordinates.
- **Device Persistence:** The selected location is saved in `localStorage.setItem('myplaydex_location', ...)` so returning visitors immediately bypass the onboarding gate and see their nearby feed.

### 7.4 Main Discovery Feed (Minimalist & Mobile-Optimized)

Once a location is established, the interface transitions to a focused, responsive single-column feed:
- **Top Header:**
  - Branding logo / text.
  - Location Selector (`📍 Suburb / Near Me ▾`): Tapping it opens a sleek switcher to change suburbs or re-trigger GPS.
  - Filter Icon Button: Clean icon button that updates visually (active indicator / filled state) whenever any sport filters are active.
- **Proximity Radius Selector Bar:**
  - Prominent horizontal pill group on the main page: `5 km`, `10 km`, `25 km`, and `All`.
  - In **"All"** mode: Distance cutoff is removed while preserving nearest-to-furthest distance sorting and distance badges.
  - Results are capped at the **top 50 closest Activities**.
- **Activity Card Hierarchy (4-Tier Scannable Layout):**
  1. *Metadata Line:* Sport tag, Cost badge (e.g. "Free" or "$10"), and Distance badge (e.g. "2.4 km away").
  2. *Title & Schedule:* Activity title followed by start date and time.
  3. *Venue & Organizer:* Venue name with an inline **"Directions ↗"** Google Maps link (`https://www.google.com/maps/search/?api=1&query=...`), and the hosting Organizer name.
  4. *Primary Action:* Single prominent button linking to the official Club / Registration URL.
- **Empty State Recovery:** If filters or narrow radius yield zero results, displays clear 1-tap recovery buttons (**"Expand radius to 25 km"** or **"Clear sport filters"**).

### 7.5 Dedicated Multi-Category Filter Page (`/#filters`)

- **Full-Screen View:** Accessed via the top header filter icon and synchronized with URL hash `/#filters` (ensuring native browser "Back" returns to the feed).
- **Multi-Select Sports:** Interactive toggle chips for all 11 sport categories.
- **Matching Logic:** Standard OR matching (an Activity matches if its sport category is in the selected set; empty set matches all sports).
- **Persistence & Controls:** **"Apply Filters"** button (persists to `localStorage` and returns to feed) and **"Clear All"** button.

---

## 8. URL Routing, Deep-Linking & SEO Strategy

### 8.1 HTML5 History & Hash Routing ([Ticket 08](../.scratch/perth-sports/issues/08-grill-url-routing-and-seo-meta.md))

The application combines clean query parameters with hash routing:

```
https://myplaydex.com.au/?suburb=cottesloe&radius=10&activity=stirling_12345
https://myplaydex.com.au/#filters
```

### 8.2 State Navigation Discipline

1. **Hash Navigation (`/#filters`):**
   - Opening the dedicated filter page pushes `/#filters` to browser history.
   - Pressing browser Back or tapping "Apply / Close" pops the hash and smoothly returns to the discovery feed.
2. **Activity Deep-Linking (`?activity=<id>`):**
   - Direct links containing `?activity=<id>` bypass the cold-start location gate, automatically scroll the target Activity card into view, and flash a highlight border/pulse.
3. **Continuous State Transitions (`history.replaceState`):**
   - Updating proximity radius or switching suburbs updates the query parameters (`?suburb=...&radius=...`) without polluting history.

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

| Component                         | Repository Path                                                                              | Test Verification                | Ticket Reference                                                                             |
| :-------------------------------- | :------------------------------------------------------------------------------------------- | :------------------------------- | :------------------------------------------------------------------------------------------- |
| **Sports Data Feeds**             | [`docs/research/01-perth-sports-data-sources.md`](research/01-perth-sports-data-sources.md)  | Verified live APIs               | [Ticket 01](../.scratch/perth-sports/issues/01-research-perth-data-sources.md)               |
| **Geohash & Firestore Schema**    | [`docs/research/02-firestore-geohash-schema.md`](research/02-firestore-geohash-schema.md)    | Architectural Analysis           | [Ticket 02](../.scratch/perth-sports/issues/02-research-firestore-geohash-schema.md)         |
| **Sports Taxonomy & Facets**      | [`src/sanitizer.js`](../src/sanitizer.js#L14-L35)                                            | `test/sanitizer.test.js`         | [Ticket 03](../.scratch/perth-sports/issues/03-grill-activity-taxonomy-and-filters.md)       |
| **Reactive Discovery Engine**     | [`src/discovery-engine.js`](../src/discovery-engine.js)                                      | `test/discovery-engine.test.js`  | [Ticket 04](../.scratch/perth-sports/issues/04-prototype-vanilla-js-leaflet-map.md)          |
| **Leaflet Prototype UI (Deprecated)** | [`prototype/index.html`](../prototype/index.html)                                            | Browser validated                | [Ticket 04](../.scratch/perth-sports/issues/04-prototype-vanilla-js-leaflet-map.md)          |
| **Outbound Maps Navigation ADR**  | [`docs/adr/0002-outbound-navigation-minimalist-feed.md`](adr/0002-outbound-navigation-minimalist-feed.md) | Architectural Decision           | [ADR 0002](adr/0002-outbound-navigation-minimalist-feed.md)                                  |
| **Geohash Encoder**               | [`src/geohash.js`](../src/geohash.js)                                                        | `test/geohash.test.js`           | [Ticket 05](../.scratch/perth-sports/issues/05-task-setup-github-actions-crawler-harness.md) |
| **Data Sanitizer**                | [`src/sanitizer.js`](../src/sanitizer.js)                                                    | `test/sanitizer.test.js`         | [Ticket 05](../.scratch/perth-sports/issues/05-task-setup-github-actions-crawler-harness.md) |
| **Firestore Batch Adapter**       | [`src/firestore-adapter.js`](../src/firestore-adapter.js)                                    | `test/firestore-adapter.test.js` | [Ticket 05](../.scratch/perth-sports/issues/05-task-setup-github-actions-crawler-harness.md) |
| **Crawler Harness Runner**        | [`src/crawler-runner.js`](../src/crawler-runner.js)                                          | `test/crawler-runner.test.js`    | [Ticket 05](../.scratch/perth-sports/issues/05-task-setup-github-actions-crawler-harness.md) |
| **Stirling Events Crawler**       | [`src/crawlers/stirling-crawler.js`](../src/crawlers/stirling-crawler.js)                    | `test/stirling-crawler.test.js`  | [Ticket 05](../.scratch/perth-sports/issues/05-task-setup-github-actions-crawler-harness.md) |
| **GitHub Actions Pipeline**       | [`.github/workflows/crawler-harness.yml`](../.github/workflows/crawler-harness.yml)          | GitHub Actions schema            | [Ticket 05](../.scratch/perth-sports/issues/05-task-setup-github-actions-crawler-harness.md) |
| **Curation & Verification Rules** | [Ticket 06](../.scratch/perth-sports/issues/06-grill-club-listing-verification-lifecycle.md) | Design agreement                 | [Ticket 06](../.scratch/perth-sports/issues/06-grill-club-listing-verification-lifecycle.md) |
| **Crawler Resilience & Alarms**   | [Ticket 07](../.scratch/perth-sports/issues/07-grill-crawler-resilience-and-alerting.md)     | Design agreement                 | [Ticket 07](../.scratch/perth-sports/issues/07-grill-crawler-resilience-and-alerting.md)     |
| **URL Routing & SEO Meta**        | [Ticket 08](../.scratch/perth-sports/issues/08-grill-url-routing-and-seo-meta.md)            | Design agreement                 | [Ticket 08](../.scratch/perth-sports/issues/08-grill-url-routing-and-seo-meta.md)            |

### 11. Post-MVP Roadmap (Out of Scope for Initial Launch)

1. **Self-Serve Club Management:** Authenticated club portal allowing clubs to edit schedules, post notices, and manage multiple team divisions.
2. **Dynamic Social Image Generation:** Serverless Cloud Function generating dynamic Open Graph cards per Activity.
3. **Automated Heartbeat Checks:** Periodic HTTP HEAD checks against club referral URLs to automatically detect and flag dead links.
4. **Geographic Expansion:** Scaling crawler harness to additional Australian metropolitan regions (Melbourne, Sydney, Brisbane).
