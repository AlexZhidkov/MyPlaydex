Type: research
Status: resolved

## Question

How should the Firestore document model and index structure be designed to support geo-radius queries (via geohashes/geofire-common or client-side Haversine filtering) combined with sport category and date filters, while remaining strictly within low-cost/free-tier operational limits?

## Answer

Store precision-9 geohash (`venue.geohash`) on write, but execute proximity discovery via temporal + sport category queries with client-side Haversine distance filtering. This eliminates the 9-query multi-box Firestore overhead, keeps reads well under the 50,000/day free tier for Perth's ~500–1,500 activities, and enables zero-cost interactive map pans and radius adjustments.

Detailed research report captured on branch `research/02-research-firestore-geohash-schema` at [`docs/research/02-firestore-geohash-schema.md`](file:///home/alex/Work/docs/research/02-firestore-geohash-schema.md).
