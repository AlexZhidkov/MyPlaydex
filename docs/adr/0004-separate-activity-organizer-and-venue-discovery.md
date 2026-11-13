# Separate Activity, Organizer, and Venue Discovery Lists

To prevent directory-only clubs and venues from polluting the scheduled Activity feed with synthetic weekly entries, MyPlaydex separates discovery into three independent, publicly readable collections and UI lists (`/activities`, `/organizers`, and `/venues`), each lazy-loaded on tab activation and capped at the top 50 records.

## Considered Options

1. **Single Unified `/activities` Feed with Synthetic Weekly Directory Entries (ADR 0001 status quo)**: Rejected because directory sources without session schedules (such as the WA DLGSC KidSport Club Directory and Volleyball WA store locator) had to fabricate recurring weekly activities and placeholder venue names (`"<Club> Venue"`), cluttering the Activity feed and hiding true scheduled sessions.
2. **Three Separate Pages with Eager Multi-Collection Fetching**: Rejected because fetching all three collections on initial page load would triple Firestore document reads and duplicate location/filter state across routes.
3. **Unified 3-Tab Discovery View with Independent Public Collections and 50-Record Lazy Loading**: Selected. Scheduled gatherings live exclusively in `/activities`, clubs and groups in `/organizers`, and physical locations in `/venues`, presented through a shared `Activities | Organizers | Venues` tab switcher (`?tab=activities|organizers|venues`).

## Consequences

- **Strict Entity Boundaries at Ingestion**:
  - `/activities` contains only scheduled gatherings with concrete dates/times (e.g., City of Stirling, Meetup, Eventbrite), while still extracting and upserting their linked `/organizers` and `/venues`.
  - **WA DLGSC** ingests strictly into `/organizers` with club coordinates, address, contact metadata, and sports—never generating synthetic `/activities` or placeholder `/venues`.
  - **Volleyball WA** routes club records (`terms` matching club) to `/organizers` and venue/centre records (`terms` matching centre/beach/courts or distinct facility addresses) to `/venues` without generating synthetic `/activities`.
- **Enriched Canonical `/organizers` and `/venues` Schemas**:
  - Both `/organizers` and `/venues` store `region_id`, `coordinates: { lat, lng }`, precision-9 `geohash`, and `subcategories: string[]` (merged across records sharing the same deterministic ID) so all three lists support proximity Haversine ranking and multi-sport filtering.
  - Both collections undergo pre-write URL verification (`src/url-verifier.js`), storing `source_url`, `raw_source_url`, and `verified: boolean`.
- **Firestore Security Rules**: `/organizers` and `/venues` are granted public read access (`allow read: if true; allow write: if false;`) alongside `/activities`, exposing public directory contact details (`website`, `email`, `phone`).
- **50-Record Load & Render Cap with Lazy Tab Hydration**:
  - Each list loads at most 50 records from Firestore (`pageSize = 50` / `.limit(50)`, single request without multi-page traversal) and caps rendered proximity-ranked output at `maxResults = 50`.
  - Only the active tab's collection is fetched on initial load; switching tabs lazy-loads `/organizers` or `/venues` on first activation and caches results in memory for the session.
- **Consistent 4-Tier Cards & Deep-Linking**:
  - **Organizer** and **Venue** cards follow the 4-tier layout (sport/distance/unverified badges, title/details/contact, outbound Google Maps row, and "Suggest an edit" link with whole-card outbound referral click).
  - URL routing syncs `?tab=activities|organizers|venues` and supports deep-linking via `?activity=<id>`, `?organizer=<id>`, and `?venue=<id>`.
