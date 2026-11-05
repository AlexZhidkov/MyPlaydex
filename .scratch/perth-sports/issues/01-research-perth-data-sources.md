Type: research
Status: resolved

## Question

What are the highest-yield, technically viable data sources for amateur and casual sports activities across Greater Perth (e.g., local council event portals, PlayHQ public schedules, Volleyball WA, Football West, Meetup, Facebook public events), what are their formats/APIs, and what scraping/ingestion constraints apply?

## Answer

Target 5 high-yield, publicly accessible sources for the MVP pipeline:
1. **WA DLGSC Directory API**: REST JSON endpoint exposing ~5,000 sports clubs across Greater Perth with verified geo-coordinates, street addresses, and sports categories.
2. **City of Stirling Events API**: Direct JSON endpoint providing leisure, beach, and community sporting activities.
3. **Eventbrite Perth Sports & Fitness**: Structured Schema.org Event JSON-LD microdata for casual tournaments, fitness sessions, and community sports.
4. **Meetup Perth Sports**: Embedded SSR JSON data for social pick-up games (soccer, basketball, volleyball, running).
5. **Volleyball WA Store Search**: Open AJAX JSON endpoint with 65+ volleyball venues and social volley centers.

PlayHQ and Football West/Squadi use protected or closed architectures (CloudFront WAF/no public API) and should be referenced via external links rather than deep fixture scraping. Facebook Events is ruled out due to Meta Graph API restrictions.

Detailed technical report with sample payloads and endpoint schemas at [`docs/research/01-perth-sports-data-sources.md`](file:///home/alex/Work/docs/research/01-perth-sports-data-sources.md).
