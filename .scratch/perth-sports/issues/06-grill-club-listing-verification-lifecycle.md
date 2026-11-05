Type: grilling
Status: resolved

## Question

How should sports clubs directly publish or claim listings on MyPlaydex, and what verification lifecycle ensures listings remain spam-free, accurate, and current without requiring attendee login accounts or heavy auth infrastructure?

## Answer

Settled verification and listing suggestion lifecycle for MVP:

1. **Self-Serve Ingestion Ruled Out of Scope**:
   - In-app self-serve Club publication forms, automated club claiming, and pre-publish moderation queues are deferred to post-MVP to minimize operational complexity.
   - All published Listings for MVP originate from automated crawler sources (DLGSC, City of Stirling, Eventbrite, Meetup, Volleyball WA) or maintainer manual entry.

2. **Zero-Friction Email Suggestions**:
   - Added a "Suggest an Activity" button to the discovery navigation and a "Suggest an edit" link on each Activity card.
   - Generates a pre-filled `mailto:azhidkov@gmail.com` link requesting Club Name, Sport, Venue address, Schedule, and Website/Referral link.

3. **Deterministic Expiration Lifecycle**:
   - One-off Activities with `end_date < today()` are excluded by query/client filtering.
   - Recurring Activities (`recurrence: 'weekly'`) remain visible indefinitely unless manually flagged or removed.

4. **Trust Model**:
   - Ingested records in Firestore are active by default (`verified: true`), avoiding staging collections or authentication systems.
