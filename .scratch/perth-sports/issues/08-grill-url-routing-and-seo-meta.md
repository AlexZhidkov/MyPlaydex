Type: grilling
Status: resolved
Assignee: alex

## Question

What URL routing structure, hash/query parameter strategy, and dynamic meta tag approach should MyPlaydex use for shareable filter states and per-suburb/per-sport landing pages on Firebase Hosting?

## Answer

Settled URL routing, deep-linking, and SEO meta architecture for MyPlaydex:

1. **HTML5 History API with Query Parameters**:
   - Single-page application served via Firebase Hosting rewrites (`"rewrites": [{"source": "**", "destination": "/index.html"}]`).
   - Clean query parameter format (e.g. `/?sport=pickleball&suburb=cottesloe&free=1&activity=<id>`). No hash-based routing (`/#/...`).

2. **History State Navigation Discipline**:
   - Discrete filter transitions (selecting sport, toggling free-only, selecting activity) invoke `history.pushState` so the browser's Back and Forward buttons work seamlessly.
   - Continuous map dragging and zooming update latitude, longitude, and zoom parameters via a 300ms debounced `history.replaceState` to keep the URL shareable without flooding browser history.

3. **Direct Activity Deep-Linking**:
   - A URL containing `?activity=<id>` prompts the client on hydration to highlight the matching card in the Split Explorer, center/zoom the Leaflet map to the Venue coordinates, and open the marker popup.

4. **Static SEO & Social Shell**:
   - Static Open Graph (`og:title`, `og:description`, `og:image`) and Twitter Card meta tags embedded directly in `index.html`.
   - Dynamic per-activity SSR via Cloud Functions deferred to post-MVP, preserving zero-cost static hosting and eliminating cold-start latency.
