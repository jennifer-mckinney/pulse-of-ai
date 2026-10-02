# PR #45 post-merge review — 2026-10-02

PR #45 ("Back off rate-limited hosts instead of escalating them as refusals")
was merged by Jennifer at 2026-10-02T05:27:36Z (merge commit `9f40457`, tip
`7c9f7bc`, into master on top of #94's `3aa9c44`). Scope reviewed below:
`git diff 47d06a4..7c9f7bc` — the delta since PR #45's last-reviewed tip.

Migrations 075-077 and the three 2026-10-02 owner decisions were verified
present, unchanged, and tested on `origin/master` (9f40457):
`git diff 7c9f7bc origin/master -- src/collectors/ src/db/migrations/075_source_rate_limit.sql src/db/migrations/076_source_rate_limit_routes.sql src/db/migrations/077_rate_limit_hold_store_unify.sql`
returns empty.

CI on master tip `9f40457`: all five checks (Test Node 22, Python black+pytest,
Python 3.13 image deps pytest, Docker images build, E2E Playwright) completed
SUCCESS.

## security-engineer — zero findings

Reviewed `src/collectors/http.js`, `robots.js`, `reddit/discovery.js`,
`docs/research/rate-limit-hold-matrix.md`, and the touched test files.
Traced all three owner decisions end-to-end against the live code (not just
docstrings), confirmed no secret-shaped strings introduced, confirmed the new
403+Retry-After robots branch cannot be used as a DoS amplifier (fixed
10-minute TTL, not derived from the attacker-controlled header value), and
confirmed migrations 075-077 are unchanged in this delta (predate `47d06a4`).
No CRITICAL/HIGH/MEDIUM/LOW findings.

## grumpy-developer — 2 LOW (fixed in PR #98)

1. **[LOW]** `src/collectors/robots.js`'s top-of-file comment omitted the
   403-with-bare-Retry-After exception added in this delta. Fixed.
2. **[LOW]** No direct unit test for a plain 401 on Reddit's `about()` call
   site specifically (401 coverage existed only for `listing()`, a different
   call site). Fixed — added to the parametrized refusal test.

Also verified (no issue): the new robots.txt branch is not dead code and is
ordered correctly after rate-limit/wall/401-451 checks; the undecodable-body
403 case correctly fails closed to "unreachable"; `ABOUT_REFUSAL_AFTER` was
cleanly removed with zero dangling references; the refusal/no-rules
integration tests assert real pipeline state, not tautologies.

## principal-engineer — zero P0/P1, 2 P2 (one fixed in PR #98)

No architectural drift, no hidden coupling issues, no migration rolling-
deploy hazards (verified `combineHold`/`mergeHolds`/`legacyHolds` are a true
monotone join — idempotent, never shortens a hold). Two P2 (optional)
documentation nits:
1. The per-origin robots cache entry's shape comment didn't list the `soft`
   field. Fixed in PR #98.
2. (Not fixed — speculative future work, not a concrete defect) No
   log-line/metric currently distinguishes a "soft 403 re-check" from a clean
   robots.txt miss; worth a line in a future observability pass only if
   WAF-blocked robots.txt becomes common in practice. Left as a documented
   follow-up note, not implemented.

## Disposition

Fix-up PR: https://github.com/jennifer-mckinney/pulse-of-ai/pull/98
(branch `docs/pr45-review-nits` off master `9f40457`; doc/test-only, no
production logic changed; not merged by this agent — Jennifer merges).
