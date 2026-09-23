# Remaining channel work — active implementation

Scope remains Amazon, eBay and Etsy; preserve connected Shopify. Last verified
production code is `439d9e3d3`. This record distinguishes new local work from that
deployed release. No new deployment, vendor probe or channel activation is approved
by a local implementation result.

## C9 — atomic receipt identity

**Implemented and independently reviewed locally; not deployed.**

The old `recordInbound` checked for a row before inserting it. A barrier-controlled
real PostgreSQL test forced two first deliveries to reach insertion together: the
loser returned a null receipt instead of the row the winner had stored. Additional
tests showed that a repeated delivery ID could reuse another account/topic/verifier's
receipt, and the helper copied arbitrary persistence exception text into its log.
The initial reproduction was **four failed / two passed / zero skipped**.

One `createMany(skipDuplicates:true)` insertion now lets the database's scoped unique
key choose the first receipt. A generated UUID supplies the ID without a preceding
read. UUIDs fit the existing String/TEXT column and route contract. A duplicate uses
one atomic update guarded by the scoped key, account (including null), event type,
signature verdict and verifier. It increments only `deliveries` and returns the
winner's current ID/status. Identity conflicts return no usable receipt ID. Other
persistence failures also refuse acknowledgment; the helper logs only a safe error
code. The first payload, digest, provider time, outcome, retry count and backoff are
preserved even when retry delivery metadata changes.

This uses Prisma 6's supported PostgreSQL `ON CONFLICT DO NOTHING` path:
https://docs.prisma.io/docs/orm/v6/prisma-client/queries/crud . It avoids expected
duplicate INSERT exceptions reaching Prisma's error logger with the incoming payload.
Failure-injection tests prove sanitization of this helper's own diagnostic output;
they do **not** prove global redaction of every unexpected Prisma error.

Tradeoff: null-to-owned receipt rebinding is now explicitly refused, as is switching
an existing receipt between accounts. Recovery requires a separate, verified routing
operation; it must not silently rewrite provenance. This slice preserves the stored
payload but does not yet replace legacy inline handlers with stored-payload dispatch.
Durable eBay claims, domain effects and replay remain the next work.

Proof after review: **eight real PostgreSQL tests pass, zero skips**, including two
simultaneous inserts, twelve concurrent redeliveries, two-profile separation, account/
topic/trust/null identity conflicts, failed duplicate updates, and changed retry
metadata preservation. **70 existing ledger/retry/Shopify/Etsy tests pass**; only their
database mocks were adapted, with every assertion retained. API typecheck passed.
The canonical PostgreSQL runner now mandates these eight cases (114 total expected).

Applied/restored mutations: removing duplicate-conflict handling caused **five failed /
three passed**; removing the account guard caused **two failed / six passed**. Both
restored byte-for-byte. Independent review approved; its stronger payload-preservation
control was added and the eight PostgreSQL cases reran green afterward.

Evidence under `/private/tmp/cx-completion-20260922/`: `receipt-race-red.log`,
`receipt-race-reviewed.log`, `receipt-regressions.log`, `c9-typecheck.log`,
`c9-insert-conflict-mutation.log`, `c9-receipt-account-mutation.log`. The failed real-DB
reports are retained by the runner. All database work used disposable localhost
PostgreSQL; no production operation or vendor call was made for this slice.

## C10 — durable eBay claims and atomic completion

**Implemented, tested and independently reviewed locally; not deployed or wired to receivers.**

A verified eBay receipt can now opt in to an initial retry time in its insert. Other
channels and unverified receipts remain unscheduled. The additive migration adds a
paired lease token/expiry to `WebhookEvent`; existing rows and schedules are unchanged.
A conditional database update chooses a single owner and increments the attempt once.
Database-clock lease expiry allows recovery after a crash. A random token fences an
old worker even when an explicit operator replay later reuses the same attempt number.
Five abandoned claims exhaust the budget; explicit auth/rate holds restore only the
current claim's increment, preserving prior genuine failures.

`commitEbayInbound` locks the receipt, reloads its stored account/payload, locks the
owned eBay account, executes database-only domain work, then completes the receipt in
the same transaction. Callback or completion-fence failure rolls everything back.
Network fetches belong before this transaction. The account lock serializes the short
database phase for that account and prevents a concurrent reconnect/credential update
from changing the grant mid-commit; other accounts remain independent. Account ownership
already has a separate immutable database trigger. The protocol intentionally permits
an uncontested expired token to finish; takeover changes the token and fences it.

**Proof:** 15 real PostgreSQL tests pass with zero skips, including the actual additive
migration over a legacy receipt, concurrent claims, crash recovery, replay generation,
profile RLS, authoritative stored context, atomic rollback, and both receipt/account
lock contention observed through `pg_blocking_pids`. The initial queue scheduling
reproduction failed one of two tests before implementation. Later fixture failures
(missing required product fields and an attempted forbidden ownership move) were test
construction errors, corrected without changing production requirements.

Critical mutations against the clean 15-test baseline were applied and restored:
removing the ownership token caused 2 failures; removing the final completion guard
caused 1; removing the account lock caused 1. Each intended test failed. Earlier
mutation runs against an invalid fixture are retained under `c10-invalid-fixture-*`
and are explicitly **not** counted as proof. The canonical real-PostgreSQL runner now
requires these 15 cases (129 total expected; this is not a claim that the full runner
has been rerun yet). Existing ledger/retry/Shopify/Etsy regressions: 70 passed.

Evidence under `/private/tmp/cx-completion-20260922/`: `ebay-claims-final-15.log`,
`c10-ownership-token-mutation.log`, `c10-completion-fence-mutation.log`,
`c10-account-lock-mutation.log`, `c10-regressions.log`, `c10-typecheck-final.log`.
Final API typecheck passed. Independent review approved the bounded foundation.
Initial receipt scheduling still uses application time; only claim/lease/retry timing
uses the database clock. Correct initial scheduling before C11 activation. All tests used disposable
localhost PostgreSQL. No production migration or channel call has been made.

Still required: receiver/worker/manual replay integration, safe current-grant
revocation, transactional order ingestion shared with polling, and erasure handling.
No eBay topic is declared ready by this foundation; all activation holds remain.

### C11 source amendment — delayed revocation and reconnect

Official eBay documentation explicitly permits refresh-token introspection. Revoking
a refresh token may also revoke its access tokens, so an access-token heartbeat does
not prove the refresh grant survived. A signed notice carries a user and revocation
date, not a grant ID. Comparing that date with local grant-save time is insufficient:
a newly issued grant may be revoked before a delayed callback saves it locally.
Independent review requires current-refresh-token evidence outside database locks,
fenced to the exact grant version at commit; a version change requires re-evaluation.
Unknown/introspection errors must remain retryable, and inactive token evidence must
not be described as proof of the provider's revocation reason. Primary source checked
2026-09-23: https://developer.ebay.com/develop/guides/sell/authorization . No live
introspection or activation is implied or performed by this amendment.

## C11a — grant versions and stale credential maintenance

**Implemented, tested and independently reviewed locally; not deployed.**

`storeGrant` now advances a dedicated monotonic `grantVersion` in the same database
update as credential replacement. Ordinary access-token refresh and representation-only
key maintenance do not advance it. The additive migration assigns existing rows zero,
meaning pre-versioned, and enforces a nonnegative value. This is local concurrency
ordering, never a claim about eBay's issuance or revocation timestamp.

Independent review found that version tracking alone would be unsound: credential-key
rotation could re-encrypt an old snapshot and overwrite a newer grant while retaining
its newer version. Rotation now compares the original encrypted blob before writing;
application-secret rotation likewise compares every field being replaced. Contended
writes are counted separately, not called rotated. A deliberate rerun reads a fresh
snapshot. Backfill and the retained plaintext rollback helper also compare their
consumed credential/expiry tuple, active/auth state, refresh owner and grant version.
They cannot resurrect credentials after disconnect or replace a concurrent grant.
The canonical refresh snapshot additionally includes the version.

Proof: seven real PostgreSQL generation cases and eleven credential-writer race cases
pass, zero skips. Six concurrent consent writers are observed waiting on an actual row
lock before release; each receives a distinct version paired with its own credentials.
Tests also prove related-write rollback, ordinary-refresh preservation, read-guest
refusal, reconnect/refresh/disconnect races during re-encryption, app-secret replacement,
legacy backfill/revoke/expiry races, and a positive plaintext rollback control. The
rotation races use synthetic target-key results with real local ciphertext; they prove
database fencing, **not live KMS operation**. No AWS or channel request is made.

Initial generation reproduction: five failed/two passed. Initial stale-maintenance
reproduction: six failed/two passed. The extra expiry control initially exposed test
fixture Date serialization (local offset into a timestamp-without-zone column), fixed
by sending its explicit UTC ISO value; this was not a product-logic failure. Existing
token/owner/rotation regressions: 118 passed. API typecheck passed. The full canonical
PostgreSQL runner passed **147 tests across 14 suites, zero failures/skips**, including
existing stock, pool, copy, assortment, routing and deletion controls. Evidence:
`c11a-canonical-postgres.log`. This verifies the new schema alongside existing DB flows.

The read/compute/write counter mutation lost versions under concurrent consent and was
killed (one failed/six passed), then restored. Four further maintenance mutations were killed and restored: removing the connection
rotation snapshot caused three failures; the app-secret snapshot one; the backfill
snapshot three; and the plaintext restore snapshot two. Independent review approved
the amended C11a implementation and test coverage. Evidence: `c11a-version-red.log`,
`c11a-version-green.log`, `c11a-version-lost-update-mutation.log`,
`c11a-writers-red.log`, `c11a-final-postgres.log`, `c11a-final-regressions.log`,
`c11a-typecheck-final.log`, under `/private/tmp/cx-completion-20260922/`.

Activation must require the canonical token service at processing time as well as setup;
the retained legacy token rollback path is not covered by this new-grant contract. The
unused legacy `EbayAuthService.saveTokens` has no production callers; current OAuth
callbacks go through `storeGrant`. Current-refresh-token introspection and the atomic
revocation handler are still to be integrated. A local version increase means discard
stale evidence and re-evaluate, not blindly ignore the incoming notice.
