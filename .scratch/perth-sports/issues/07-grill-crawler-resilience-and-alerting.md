Type: grilling
Status: resolved

## Question

How should the scheduled GitHub Actions crawler harness detect upstream schema drift or selector breakages across scraped sources, handle partial failures, and alert the maintainer without incurring infrastructure costs or halting healthy crawlers?

## Answer

Settled crawler resilience, drift detection, and alerting architecture:

1. **Fail-Fast Network Policy (No Retries)**:
   - Upstream HTTP fetches will not use retry loops or backoff logic.
   - Any HTTP error (4xx/5xx) or network timeout immediately throws and fails that specific crawler, keeping execution predictable and fast.

2. **Silent Schema Drift / Zero-Yield Anomaly Detection**:
   - Each crawler specifies a minimum expected yield (default: `minExpectedListings: 1`).
   - If an active crawler returns 0 raw items without throwing an error, the harness marks it as `failed` with a selector breakage / drift alarm, preventing silent catalog starvation.

3. **Validation Drop Rate Threshold**:
   - The harness evaluates the sanitization rejection rate per crawler.
   - If `invalidCount / rawCount > 0.20` (>20% dropped invalid items), the harness marks the crawler run as `failed` due to schema drift.
   - Any valid listings in that batch are still saved to Firestore so fresh data is not discarded.

4. **Error Isolation with Partial Ingestion**:
   - Crawlers run sequentially with isolated `try/catch` blocks.
   - A broken crawler never aborts the execution of subsequent healthy crawlers.
   - All valid items extracted across all crawlers are batched and committed to Firestore.

5. **Zero-Cost Maintainer Alerting**:
   - When any crawler fails or triggers a drift threshold, the harness exits with `process.exit(1)`.
   - GitHub Actions automatically sends an email notification to repository maintainers on failed scheduled runs.
   - The harness writes a formatted Markdown summary table and error breakdown to `$GITHUB_STEP_SUMMARY` for immediate diagnosis in the Actions UI.
