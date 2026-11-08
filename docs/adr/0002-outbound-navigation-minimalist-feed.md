# Outbound Google Maps Navigation and Minimalist Discovery Feed

To deliver a fast, frictionless, mobile-first experience without map touch conflicts or mapping API costs, we are removing the embedded Leaflet.js map from the MVP discovery interface. Instead, MyPlaydex uses an empty cold-start state prompting users for their suburb or "Near Me" GPS location, displays a single-column responsive Activity feed with in-memory Haversine distance badges, and delegates map viewing and turn-by-turn navigation directly to external Google Maps deep links on each Activity card.

## Considered Options

1. **Embedded Leaflet.js with OpenStreetMap Tiles**: Rejected for MVP because interactive maps add ~150KB bundle weight, trigger continuous tile network requests, suffer from touch-scroll trapping on mobile screens, and complicate client state synchronization.
2. **Embedded Google Maps JavaScript API**: Rejected due to mandatory billing accounts, API key leakage risks, and usage quotas for little added discovery value over a structured feed.
3. **Outbound Universal Maps Links with Proximity Ranking**: Selected. Users set their locality via suburb presets or device GPS; MyPlaydex ranks Activities using client-side Haversine math and provides a one-click outbound link to Google Maps (`https://www.google.com/maps/search/?api=1&query=...`), seamlessly opening the user's native mapping app on iOS/Android.

## Consequences

- **Zero Map Assets**: Leaflet CSS, JS, and tile assets are completely removed from the web client, dropping external dependencies and speeding up initial load times.
- **Mobile-First Single Feed**: The dual-pane 50/50 desktop split layout is replaced by a clean, single-column responsive Activity feed optimized for handheld devices.
- **Cold-Start Location Gate**: No Activities are rendered until the user explicitly selects a suburb preset or grants browser geolocation ("Near Me").
- **Dedicated Multi-Category Filter Page**: Sport category filtering moves off the main toolbar into a dedicated filter view where multiple sports can be toggled and persisted to `localStorage`.
- **Venue Outbound Navigation**: Each Activity card includes a direct outbound link targeting Google Maps using `venue.name` and coordinates, opening in a new tab or the native Google Maps app.
