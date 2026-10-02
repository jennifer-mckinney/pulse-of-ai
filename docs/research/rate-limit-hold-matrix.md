# Rate-limit hold matrix (PR #45)

Every path that meets a response, crossed with every response class. Each cell has a test
(`tests/unit/pure/collectorHoldMatrix.test.js` for the HTTP paths, `tests/integration/collect.holdMatrix.test.js`
and `collect.ratelimit.test.js` for the database rows). One hold store: `source_collection_state.rate_limited_hosts`.
A 5xx Retry-After hold (`retry_after_5xx`) is a separate server backoff, not a rate limit.

## Response classes and what each must do

| Class | Result | Hold | Refused state |
|---|---|---|---|
| 429 | RateLimitedError (`rate_limited`) | host, until the source's time (60 s floor doubling, 24 h cap; 5 min with no time) | never; the 14th consecutive rate limit of any kind with no success escalates to a refusal |
| 403 + `x-ratelimit-remaining: 0` + an ABSOLUTE reset instant in (now, now+24 h] | RateLimitedError | host, until the reset | never; the 5th consecutive strong 403 (or the 14th rate limit of any kind) escalates to a refusal |
| 403 + `x-ratelimit-remaining: 0` without an absolute, plausible reset (none, past, beyond 24 h, or a relative `1` / `60`) | AccessDeniedError (a bare header proves nothing) | none | yes |
| Bot wall: `cf-mitigated: challenge` at any status, a challenge page at 3xx / 4xx / 5xx, a small HTML 2xx challenge page (a robots.txt 2xx only as an HTML page too), a redirect into `/cdn-cgi/challenge-platform/` | AccessDeniedError (`refusal: 'bot_wall'`), checked before a redirect is followed and before a success clears anything | none | yes |
| 2xx JSON / feed / text that merely mentions a vendor | content | n/a | no |
| 503 + Retry-After over 10 s | HttpError `http_5xx` | host, `retry_after_5xx`, capped 1 h, no streak | never |
| Plain 403 / 401 / 451 | AccessDeniedError | none | yes |
| 2xx / 304 | success | ends the streak (expired holds) of the answering host and the host first asked | n/a |

## Paths

| Path | 429 | 403 + remaining 0 | bot wall | 503 + RA | plain 403 | success |
|---|---|---|---|---|---|---|
| `request()` first hop | hold, thrown | hold, thrown | refusal, no hold | `retry_after_5xx` hold, HttpError | refusal | clears host |
| `request()` behind a redirect | hold on target and on the host first asked | same | refusal | same as 429 | refusal | clears both |
| `request()` into an already-held host | the first host is held too | same | n/a | same | n/a | n/a |
| `fetchRobots` direct | hold, thrown, nothing cached | same | refusal (any status) | hold, robots unreachable | refusal (ADR 0001 ruling 5; was "no rules") | clears host |
| `fetchRobots` behind a redirect | target and first host held | same | refusal before the hop is followed | both held | refusal | clears both |
| `heldError` (next call) | RateLimitedError `held`, nothing sent | same | no hold, sent again | HttpError `held` `http_5xx`, nothing sent | sent again | n/a |
| mid-retry hold (`withRetries`) | thrown as the answer, not retried or wrapped | same | n/a | same | n/a | n/a |
| governance terms fetch | refused unsent | same | recorded unreachable | same | unreachable | clears and saves |
| `saveHolds` / `mergeHolds` / `combineHold` | until = latest; cause = record with the latest until (tie to the rate limit); streaks = record whose rate limit wrote them last; order-independent | same | no hold | never writes streaks | n/a | expired copies cleared on every row; an active copy kept |
| `loadHolds` | merged across rows, plus `retry-after:` keys left in `http_cache` by a previous-release worker (rows with an empty map too) | same | n/a | key 503 is a server backoff | n/a | n/a |
| migration 077 | COPIES keys (they stay for a previous-release worker; the runner removes them on the source's next claim); keeps existing streaks; cause rule as runtime (also between two records of one class); `IS DISTINCT FROM` for a null signal | n/a | n/a | 503 never in `rate_limited_until` | n/a | n/a |
| status / `/api/sources` | `rate_limited_*`; all open routes held with at least one rate limit gives `rate_limited` | same | refusal wins | `server_backoff_until`, `_routes`, `_hosts`, never `rate_limited_*`; every route held means not online | n/a | n/a |
| source health | `source_rate_limited` warning at 3, or one hold of 6 h or more, only for routes open now | same | critical `source_refused` | never (a host answering 5xx for ever opens `source_failing` after 3 runs) | critical `source_refused` | resolves |
| Reddit discovery `about()` | stops, incomplete | stops | rethrown at once | stops, incomplete | 3 in a row rethrown; one is "unavailable" | resets the 403 run |
| Reddit recheck / maintenance | stops, hold saved | same | refusal recorded | stops (`serverBackoff`) | refusal recorded | clears |
| runner | host skipped; all-held is a skip, not a failure | same | refusal | `backoffUntil`, not `rateLimitedUntil` | refusal | clears |

Further columns: DB-disabled route (never held, never stored as rate-limited, re-read at save under the lock); concurrent merge in both orders
(`collectorHoldMatrix`, `collect.holdMatrix`); env-derived route sharing a terms host (the worker writes `terms_only` into the hold, so the web
process, the evaluator and the 5xx time all see the collection hold).

## Known transients and decisions

- After migration 077, `rate_limited_routes` is recomputed by the worker's next save (it needs the registry and env, not SQL). Enforcement is
  immediate (`loadHolds` reads the hold map). `rate_limited_until` is informational only; `/api/sources` computes its time from the holds.
- Reddit `about()`: a lone plain 403 is how Reddit answers a private or quarantined subreddit; a refusing Reddit answers every lookup, so 3 in a
  row (`ABOUT_REFUSAL_AFTER`) are a refusal. A bot wall, 401, 451 or an escalated refusal is rethrown at once. Owner decision (Copilot suggested the first 403).
- Behaviour change: a 401 / 403 / 451 on `robots.txt` is a refusal (ADR 0001 ruling 5), no longer "no rules".

Diagrams (`docs/diagrams/states/source-gate-status`, `flows/collection-1-schedule-and-gates`) do not yet show the `rate_limited` state; they are updated under the diagram accuracy contract (independent row-by-row audit, PNG regenerated), tracked with the other diagram issues, not edited here.
