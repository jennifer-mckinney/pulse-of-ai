# E2E finding — dev-seed trailing-hour staleness (environment, not a code bug)

Date: 2026-09-28 · Suite: `npm run test:e2e` · Spec: `tests/e2e/truthfulness.spec.ts`

## Symptom
`truthfulness` failed at the "posts / hour" overview-card stat: the card
rendered the resolver fallback copy with no stats.

## Root cause
The dev DB's 66 seeded posts had aged past the trailing-hour window
(max `collected_at` 19:42Z vs a ~20:50Z run). The frontend's honest-zero
path then rendered 30 zero-count launch cities, `computeInsights.cityCount`
is 0 over an all-zero snapshot, and the overview beat legitimately fell back
(FALLBACK_COPY, no stats). This is the demo-flip guard working as designed —
the truthfulness spec deliberately does NOT use `stabilizeSnapshot()`
because it asserts the `from=` window itself, so it inherently needs posts
inside the last hour.

## Resolution (environment)
Re-freshened the dev data in place, preserving relative spacing:

```sql
UPDATE raw_posts
SET collected_at = collected_at
    + (NOW() - INTERVAL '10 minutes' - (SELECT MAX(collected_at) FROM raw_posts));
```

18 posts back inside the trailing hour → full suite green (13/13).

## Note for future runs
Any e2e run more than ~1 h after the last ingest/seed will hit this again.
Freshen `raw_posts.collected_at` (query above) or re-ingest before running
the suite. No production code change is warranted: the decayed behavior is
the honest-zero contract, not a bug.

## Related environment observation
The dev DB also carried ad-hoc `bias_assessments` rows under the synonym
type `demographic_parity` (the pipeline writes `platform_sentiment_parity`).
Migration 008 folds the synonym onto the pipeline vocabulary so the stored
real value (0.031, τ 0.10) serves under the prototype's named
"Demographic parity" layer.
