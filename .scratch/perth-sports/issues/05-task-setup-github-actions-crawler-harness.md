Type: task
Status: resolved
Blocked by: 01, 02

## Question

How can a GitHub Actions workflow be configured with a minimal Node.js runner and Firebase Admin SDK credentials to execute scheduled crawler scripts and write sanitized Activity listings directly into Firestore?

## Answer

Configured a production-ready crawler harness and GitHub Actions automation pipeline:

1. **GitHub Actions Workflow (`.github/workflows/crawler-harness.yml`)**:
   - Scheduled daily cron at **01:00 AWST** (`0 17 * * *` UTC) with manual `workflow_dispatch` trigger supporting parameters (`crawler`, `dry_run`).
   - Minimal runner on `ubuntu-latest` with **Node.js 22 LTS**.
   - Runs full verification test suite (`npm test`) before crawling.
   - Reads service account JSON or base64 credentials from repository secret `FIREBASE_SERVICE_ACCOUNT_KEY` without exposing keys on disk.

2. **Precision-9 Geohash Generation (`src/geohash.js`)**:
   - Zero-dependency, pure JavaScript Base32 geohash encoder implementing the standard Morton curve down to ~4.8m precision for all Perth venues on write.

3. **Data Sanitization & Canonical Schema Enforcement (`src/sanitizer.js`)**:
   - Cleans raw crawler payloads into the canonical `ActivityDocument` domain schema ([GLOSSARY.md](../../GLOSSARY.md), Tickets 02 & 03).
   - Generates deterministic IDs (`${source}_${source_id}`) for write idempotency.
   - Normalizes sports taxonomy (`soccer`, `volleyball`, `basketball`, `afl`, `tennis`, `pickleball`, `running`, `social-fitness`, `walking`, `cricket`, `other`).
   - Defaults demographics (`gender: 'all'`, `age: 'all'`) and parses free/cost status.

4. **Batch Ingestion & Dry-Run Firestore Adapter (`src/firestore-adapter.js`)**:
   - Batches writes in chunks of <=500 documents (Firestore limit) using `batch.set(docRef, data, { merge: true })` for safe idempotency.
   - Supports `--dry-run` execution mode without requiring live GCP credentials.

5. **Crawler Runner & Reference Implementations (`src/crawler-runner.js`, `src/crawlers/`)**:
   - Orchestrates crawlers with per-source error containment so a failure in one portal does not halt remaining sources.
   - Reference implementation for City of Stirling Events API (`src/crawlers/stirling-crawler.js`) and offline test crawler (`src/crawlers/mock-crawler.js`).
