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

## C11b — current eBay refresh-grant inspection

**Implemented and independently reviewed locally; no production caller or activation.**

The token service can now inspect the exact stored eBay refresh token using the official
OAuth introspection endpoint. It refuses other businesses (including publish guests),
other channels, inactive/terminal accounts, environment-managed credentials and the
legacy token-service mode before making a request. It captures the local grant version
before the remote read and returns only that version, owning account/profile and the
boolean activity result. A reconnect during the request does not relabel old evidence
as belonging to the new grant. The result is immutable and contains no credentials,
provider identity fields or speculative issuance timestamp.

The OAuth request uses the matching production/sandbox app, Basic authentication and
`token_type_hint=refresh_token`, with redirects refused, a 20-second request/body
signal and a 16-KiB streamed response ceiling. Only a valid boolean from HTTP200 is
evidence. HTTP401 is an app/remote failure, not proof the seller grant was revoked;
HTTP429 is explicitly typed for later budget-preserving deferral. Decryption,
configuration, transport and malformed/read/oversize response failures expose static
messages, never vendor bodies or credential errors. An `active:false` result means the
token is unusable; it does not identify why. No account state changes in this helper.

Proof: **42 focused tests pass**, including strict owner refusal with a publish-share
positive fixture, cached-access/current-refresh distinction, malformed credential and
response rejection, configuration errors, response cancellation, and abort after
headers. Three new real PostgreSQL controls bring the grant suite to **10 passed /zero
skips**: actual owned inspection leaves the row unchanged, reconnect preserves its
newer grant, and a readable publish guest makes zero calls. The canonical runner now
requires150 cases; the last full runner remains C11a's147, with these three additions
run separately. The prior118 token/owner/rotation regressions also pass.

Four applied/restored mutations were killed by their intended controls: removed owner
check, removed canonical-service check, access-token substitution, and accepting error
HTTP statuses as grant evidence. The initial32-test TDD run failed because this new
capability did not yet exist; it is not presented as a production-defect reproduction.
Independent review required stronger configuration/body-failure coverage, now included.

Evidence under `/private/tmp/cx-completion-20260922/`: `c11b-inspection-red.log`,
`c11b-inspection-reviewed.log`, `c11b-regressions.log`, `c11b-postgres.log`,
`c11b-owner-mutation.log`, `c11b-canonical-mutation.log`,
`c11b-refresh-token-mutation.log`, `c11b-http-status-mutation.log`,
`c11b-typecheck-reviewed.log` (final typecheck passed).
All transport is synthetic. This is not successful live introspection, a durable
revocation handler, receipt integration or production enablement. The next slice must
compare evidence under the owned account lock, atomically commit lifecycle/audit/
notification/receipt changes, and re-evaluate when the grant changed.

C11c policy amendment from independent review: a current `active:true` result preserves
the grant but does **not** establish that a signed notice is obsolete. eBay documents
no notification/introspection propagation deadline. Keep such notices unresolved and
retry within the bounded attempt budget; exhaustion must be an explicit unresolved
DLQ with owner warning, never forced revocation or false DONE. Handle already-terminal
cleanup before requiring introspection. Revocation, strict audit, durable per-owner
notifications and receipt completion must commit together. Dedupe notices by profile,
connection, grantVersion, kind and recipient (not unread state alone). Zero active
owners is an explicit durable audit disposition, not proof notification was delivered.

## C11c — atomic eBay revocation domain transaction

**Implemented, tested and independently reviewed locally; not deployed or wired to ingress.**

The transaction-only domain handler receives the authoritative stored receipt plus
current-grant evidence. It verifies the account/profile, locks the owned account,
compares the grant version, and refuses active or stale evidence as unresolved. Already
revoked/disconnected accounts are reconciled without requiring introspection; inactive
state and cleared refresh leases are enforced, preserving disconnected semantics.
Account status changes remain in the token service and share its transition policy.

Strict transaction-aware audit and notification helpers now underlie the existing
best-effort wrappers. Revocation, audit records, active-owner inbox rows and receipt
completion commit together through C10. A deterministic per-profile/account/grant/kind/
recipient notification identity prevents duplicate notices across delivery IDs and
read-state changes while allowing a later grant to raise a new notice. A profile with
no active owners still gets its necessary security transition and a durable
`no_active_owners` audit disposition; this does not claim anybody was notified.

Sixteen real PostgreSQL controls pass with zero skips: complete atomic effects,
terminal cleanup, both reconnect orderings, late refresh fencing, account/proof
refusal, active evidence remains pending, injected account/notification/audit failures,
failed final receipt fence, occurrence dedupe and zero-owner handling. The callback
runs under an instrumented context that rejects every global-client access; network
is stubbed and no remote call occurs inside the transaction. Actual row-lock contention
is observed via PostgreSQL blocking state. Existing alert/lifecycle/token regressions:
121 passed. API typecheck and inbound-ledger state-machine/replay ratchet pass.

The first TDD run lacked the new helper (11 failed/one negative control passed); this
is feature-development evidence, not a production-defect reproduction. A syntax error
and a later missing synthetic app-credential fixture were corrected separately; the
latter produced a timeout and unhandled assertion rejection, so that run is **not**
counted as passing. The final run has no skipped/failed tests. Critical guard mutations
were applied/restored after its clean baseline: removing the grant version fence,
active-evidence refusal or notification occurrence version each caused one failure;
removing stand-down/lease cleanup caused five. Independent review approved the bounded
implementation and suggested an ambient non-owner control. That test was added, all16
cases passed, and removing the explicit owner-only recipient selection killed that
new control. The guard was restored.
Evidence under `/private/tmp/cx-completion-20260922/`: `c11c-revocation-red.log`,
`c11c-revocation-green.log`, `c11c-revocation-races.log` (failed fixture run),
`c11c-revocation-races-final.log`, `c11c-revocation-reviewed.log`,
`c11c-regressions.log`, `c11c-typecheck-reviewed.log`, and
`c11c-*-mutation.log`. Canonical PostgreSQL registration now requires166 tests; the last
full runner remains147, with subsequent grant/revocation additions run separately.

Still open in C11d: signed envelope validation and stable/inactive-account routing;
receiver/worker/manual replay integration; initial DB-clock scheduling; bounded
unresolved-notice retries and final owner warning; private lease fields in diagnostics.
The old inline eBay receiver and legacy lifecycle wrapper remain until that integration
replaces their execution path. No eBay topic has been declared ready or activated.

## C11d1 — database scheduling and fenced manual replay

**Implemented, tested and independently reviewed locally; not deployed.**

Initial verified eBay scheduling now reads database time before its atomic receipt
insert (one extra scalar read per scheduled arrival). The application clock cannot
put a new receipt into the far future. The existing `replayInbound` entry point now
sends eBay resets through a receipt-row lock and authoritative rechecks of the signature
scheme, archive state, queue and active lease. A reset clears old lease tokens and
error/processed fields, uses database time, and preserves payload/account/delivery
identity. Other channel replay paths keep their existing behavior.

Seven new real PostgreSQL cases pass, plus15 existing claim cases and33 ledger/retry
regressions; API typecheck passes. The original implementation failed five of seven
new cases: future scheduling, stale operator read versus worker claim, simultaneous
operator resets, and a successful signature verdict with the wrong verifier. Tests
observe actual lock blocking and use a controlled application clock. Applied/restored
mutations each killed their intended control: application time for initial scheduling,
application time for replay, removal of the replay row lock, and removal of the eBay
verifier check. Independent review approved. Evidence: `c11d1-replay-red.log`,
`c11d1-replay-final.log`, `c11d1-regressions.log`, `c11d1-typecheck.log`, and
`c11d1-*-mutation.log` under `/private/tmp/cx-completion-20260922/`.

This closes C10's initial-clock caveat. Canonical PostgreSQL registration requires173
cases; the last full runner remains147, with subsequent additions tested separately.
**Do not deploy this as a standalone replay activation:** the legacy route/worker still
need C11d's stored-payload dispatcher integration. The new receipt/claim protocol and
manual reset must ship together with that execution path; no topic activation follows
from this slice alone.

## C11d2 — atomic unresolved-event warnings

**Implemented, tested and independently reviewed locally; not deployed or activated.**

Both eBay dead-letter paths—an exhausted processing attempt and five abandoned claims—
can now persist their required warning inside the receipt transaction. The callback
receives authoritative stored context, and a final disposition guard refuses altered
terminal/lease/trust fields. Warning/audit failure rolls the DLQ change back, keeping
the event recoverable. Retries and explicit auth/rate holds emit no terminal warning.
The account itself is never revoked because processing exhausted its budget.

The dedicated warning writes only to active owners of the receipt's profile, excludes
the ambient actor and provider/error content, and records an `inbound_failed` audit.
Notification identity is per receipt/recipient and remains deduped after manual replay
and read-state changes. A missing or readable foreign account receives no audit FK;
its state is unchanged, and the receipt-profile owners still see the unresolved event.
The Ingress link matches the existing Channels tab.

Final domain suite:25 real PostgreSQL tests pass, zero skips (nine additions since
C11c), plus15 existing claim controls and121 legacy alert/lifecycle/token regressions.
Typecheck passes. Initial warning reproduction: six failed/seventeen passed; old
claim/finish helpers ignored required callbacks. Mutations were applied/restored on
the clean23-case intermediate baseline: omitting final-attempt warning caused4
failures; omitting crash-exhaustion warning2; removing final disposition fencing1;
calling the warning on ordinary retry/holds1. Review approved and suggested the later
replay/read and missing/foreign account controls, all added and passing in the25.

Evidence: `c11d2-warning-red.log`, `c11d2-warning-final.log`,
`c11d2-warning-reviewed.log`, `c11d2-regressions.log`,
`c11d2-typecheck-reviewed.log`, `c11d2-*-mutation.log`, under
`/private/tmp/cx-completion-20260922/`. Canonical registration now requires182 cases;
the last full runner remains147, with later additions run separately.

The dispatcher must supply this strict callback on **both claim and finish paths**.
Current-active/grant-changed uncertainty uses bounded retry, never an auth/rate hold
that refunds the budget. Receiver/worker/manual execution wiring is still next and is
required before a deployment package may activate this protocol.


## C11d3 — verified admission, original ownership and private quarantine

**Implemented, tested and independently reviewed locally.
Not deployed, enabled or production-verified.**

Admission owns a raw-byte snapshot and signature verification. It reads the official
`notification.notificationId` and `notification.data.userId`; mutable username and
legacy eiasToken are never routing fallbacks. The full revocation parser requires
schema1.0, an explicit immutable userId and valid UTC revocation time; publication
is a separate optional transmission time. Requiring userId is a conservative Nexus
automation rule, not a claim that eBay documents it as mandatory.

Known notices bind to exactly one owned OAuth account in the matching environment.
An active account wins over its inactive history. Unknown/ambiguous verified notices
remain encrypted in the application-scoped `EbayNoticeQuarantine`, never a default
business ledger. Invalid signatures retain metadata/digest only: no raw body, header,
ciphertext or KMS operation. RLS denies tenant readers; updates are column-limited,
source proof is immutable and runtime deletion is denied. Production/sandbox public
key caches and delivery namespaces are separate.

Every delivery path serializes on environment/trust/provider ID. A narrow system-only
lookup discovers the original receipt's workspace even when a later signed delivery
changes or omits its subject; ambiguous historical bindings refuse admission. Its
(channel, externalId) index avoids a full ledger scan. No payload crosses that lookup.
An archived business cannot cause a second quarantine/receipt. Archived receipt retries
increment only delivery history, preserving erased payload and terminal scheduling.

Explicit owner adoption decrypts outside database locks, checks cipher/digest binding,
rechecks current owner authority under workspace/user locks, and atomically writes the
business receipt, immutable destination pointer and audit. Original known ownership
survives later account transfer; unknown-first messages require explicit adoption.
The same global delivery lookup also fences historical cross-profile handoff conflicts.
A narrow system-only ownership SHARE-lock function closes first-admission/transfer
races without granting runtime UPDATE rights to the ownership index. Existing bound
receipts already block supported reassignment, including completed/archived receipts.
A global admission-index table was considered and rejected as unnecessary for this
supported transfer model; metadata lookup plus existing transfer guards suffice.

Independent review exposed the changed-subject cross-profile duplicate, archived-
workspace fallthrough and historical handoff conflict; all received regression cases.
Other reproduced defects: invalid identifier control characters/calendar dates,
archived-payload duplicate refusal and shared signing-key cache across environments.
The signature regression uses real EC keys, including a negative cross-environment
signature and a positive sandbox signature. Tests make no live vendor calls.

Evidence in `/private/tmp/cx-completion-20260922/`:
`c11d3-parser-controls-red.log` → `c11d3-parser-controls-green.log` (34 cases),
`c11d3-admission-extension-red.log`, `c11d3-global-identity-red.log`,
`c11d3-signature-environment-red.log` → `c11d3-regressions.log` (86 passing),
and `c11d3-admission-reviewed-final.log` (23 realPG before the final historical-
handoff case/metadata-only rejection amendment). Six applied/restored mutations
were killed: ownership lock, original-profile lookup, cipher binding, owner recheck
first-owner restriction and historical adoption binding. Final canonical result follows below.

Deployment/activation prerequisites remain explicit: receiver/worker/manual replay
wiring; cross-record reconnect fencing; bounded operational recovery and an owner
adoption surface; quarantine key maintenance/archive policy and observable failures.
Immutable ciphertext currently prevents routine re-encryption, so keys needed by
unresolved quarantine must not be retired. The public receiver must return no internal
workspace/receipt/quarantine IDs. No latency/SLO or complete AAA claim is made: current
bounds are1MiB ingress,4 routing retries and30s transaction timeout, with verification
and crypto outside locks; realPG establishes isolation and atomicity, not production
latency. No UI is changed, so accessibility work remains with the operator surface.

The revocation contract remains application-level with base OAuth scope. Sources:
https://developer.ebay.com/updates/newsletter/q3_2021_news
https://www.developer.ebay.com/develop/guides/buy/buy-communication-guide
https://developer.ebay.com/develop/api/buy/notification_events
The deletion topic's ACK/escalation contract is not generalized to revocation.
Activation still needs the approved live catalogue/contract proof.

Final review approved the bounded local foundation with no required source findings.
Typecheck, model-ownership classification (447 models) and exact migration/policy-tail
comparison pass. The first full canonical run used production-equivalent owner rights:
all206 assertions passed, including the final24 admission cases, but the process
correctly failed because assortment/copy-unknown-market teardown reported
`permission denied to terminate process` at `DROP DATABASE ... WITH (FORCE)`.
The isolated3-case suite then passed unchanged. The failing run is retained as
`c11d3-canonical-postgres.log`, with full output under the runner's reported temp path;
this is not relabeled green. PostgreSQL limits FORCE to sessions the current role may
terminate (https://www.postgresql.org/docs/17/sql-dropdatabase.html). The remaining
backend's identity was not captured, so its precise origin is not established.
The unchanged full recheck **passes206 assertions/17files/zero skips**, including
all24 admission cases, in `c11d3-canonical-postgres-recheck.log`. This supersedes the
old147 full-run baseline for local engineering evidence, not the retained failed run.
The unexplained cleanup backend is a test-harness reproducibility limitation, not a
production assertion. Gate diagnostics now also require each file's passed status
and surface failed-suite/hook details before unrelated logs; no timeout, assertion,
role, or hook was weakened. No broader rerun is warranted after the successful gate.


## C11d4 — seller identity fencing across connection rows

**Implemented, tested and independently reviewed locally. Not deployed or enabled.**

Audit found that grantVersion protects only one row. OAuth can reconnect an inactive
same-seller row or create a new connection while a previously bound receipt still
references the old terminal row. The protected live/inactive Xavia rows actually share
one external seller ID in dated read-only census evidence. Partial active uniqueness
includes marketplace and does not establish a permanent canonical connection.

Both eBay grant placement/persistence and receipt completion now share a transaction-
scoped advisory lock keyed by environment and immutable seller ID, independent of
workspace/connection. It covers a row that has not yet been inserted. Lock order is
receipt → seller → account. Fresh ReadCommitted reads after the lock wait check exact
ownership/identity and active siblings. A newer active sibling leaves the old receipt
unresolved; no silent retarget occurs. A reconnect after revocation commits is valid.
The existing per-row grantVersion still fences new grants on the same row.

The token module snapshots inputs and prepares ciphertext/fixed expiries before the
transaction. OAuth performs placement, creation, grant write and metadata together;
standalone eBay storeGrant participates in the same protocol. A private persistence
closure is valid only in its captured workspace/transaction attempt and is invalidated
on success/failure. Nested preparation is refused before encryption. Other channels
retain their original persistence path and Serializable default; the generic context
rejects incompatible explicit nested isolation instead of silently ignoring it.
Required eBay grant audits/related writes commit atomically. No network belongs inside
the database callback. Existing null-identity reconsent preserves stored identity JSON.

The revocation domain re-parses its stored verified contract and checks subject plus
environment/delivery namespace against the locked account. It cannot use a caller-
mutated claim as domain evidence. Independent review caught two additional defects:
Identity API's connector fabricated userId from username, and the first implementation
of null-identity reconsent would replace existing metadata with just userId. Both are
fixed with regression cases. eBay now refuses missing/malformed userId even with business
profiles OFF; username-only HTTP200 does not create/update a grant. This deliberately
strengthens the old profiles-OFF fallback, rather than lowering the test bar. Other
channels' missing-identity rules are unchanged. Mutable/immutable username ambiguity is
documented by eBay (https://developer.ebay.com/api-docs/static/data-handling-update.html);
revocation userId is explicitly immutable in its notification contract.

Three initial realPG tests reproduced the race (all failed). Expanded10-case identity
suite passes: both race orders, newly inserted sibling, cross-marketplace second-grant
refusal, encryption outside locks, immutable input, escaped closure refusal, nested
preparation refusal, stored subject/environment mismatch and metadata preservation.
Existing grant10/domain25/claim15 cases also pass under production-equivalent owner
permissions. A claim regression caught changed refusal wording; original scoped error
was preserved, with no assertion relaxation.190 focused regression tests pass including
OAuth, token, lifecycle, ledger and transaction-context controls. Typecheck passes.
Evidence: `c11d4-identity-red.log`, `c11d4-identity-expanded.log`,
`c11d4-username-identity-red.log`, `c11d4-postgres-reviewed.log` (retained one wording
failure), `c11d4-claims-reviewed.log`, `c11d4-regressions-reviewed.log`,
`c11d4-typecheck-reviewed.log`, all under `/private/tmp/cx-completion-20260922/`.
Final mutation/canonical outcome follows after restoration. Operational receiver,
worker/manual execution, quarantine recovery/maintenance and separate live activation
remain next; this does not claim channel end-to-end completion.

Final C11d4 proof: **216 real PostgreSQL assertions/18files/zero skips pass** with
production-equivalent owner rights (`c11d4-canonical-diagnostic.log`); typecheck passes
(`c11d4-typecheck-final.log`). Five applied/restored critical mutations were killed:
seller lock, active-sibling refusal, stored subject/environment validation, nested
preparation guard and input snapshot. Source review approved after both requested
fixes. `c11d4-*-mutation.log` retain the concrete failures. No vendor call occurred.

The first216-case full run also hit the retained cleanup permission failure, this time
in grant-version afterAll, despite all assertions passing. The diagnostic rerun passed;
the offending backend did not recur. The fixture now logs only code/detail and remaining
PID/user/backend-type/application/state on cleanup failure, preserves the original
error and closes its admin pool in finally. No permission, timeout or assertion was
relaxed. Independent inspection found pg-pool can resolve end() before its backend has
exited, but that does not prove which backend caused the permission error. This local
harness limitation remains recorded instead of inventing a root cause or claiming it
fixed. Future failures should now expose the missing evidence without logging queries
or credentials. `c11d4-canonical-postgres.log` remains a failed run.


## C11d5 — stored receipt execution and route/worker integration

**Implemented, tested and independently reviewed locally. Not deployed or enabled.**
The receiver now acknowledges only durable admission and returns no internal routing
IDs. Verified unresolved topics enter recoverable quarantine; acknowledgement does
not claim erasure or order ingestion. Failed storage/encryption/conflicting ownership
returns503; known signature mismatch returns412; unavailable verification keys/app
credentials return503 for provider redelivery. Failed verification stores metadata
only. Prolonged verification outage can outlast provider redelivery; there is no claim
of lossless recovery from a signature that was never established. Live ACK/retry
contract proof, regular pull coverage and operational quarantine visibility remain.

Worker/manual replay call the one stored-ID processor. Exact
`NEXUS_ENABLE_EBAY_INBOUND_PROCESSING=1` is required and defaults OFF; deployment alone
must not cause introspection/lifecycle writes. Both claim-crash and terminal-attempt
paths use strict owner warnings. Terminal accounts avoid provider reads; supported
current-grant inspection happens outside locks. Current-active/change uncertainty
uses the bounded budget.429 holds restore attempts;503 failures consume an attempt;
both honor valid Retry-After, using DB time for persisted scheduling and provider Date
for HTTP-date clock skew (RFC9110 §10.2.3). Invalid/unrepresentable delays fall back to
normal backoff. No provider body/exception text is persisted as the public error.

The worker selects at most4 verified, unarchived, due/claimable eBay receipts using the
DB clock. These run concurrently with other channels so a slow eBay read cannot delay
existing Shopify handling. Generic finishers cannot complete verified eBay receipts.
Manual replay no longer sweeps every account; it calls the stored receipt processor.
The authenticated detail response omits leaseToken. A separate receipt-handler registry
advertises AUTHORIZATION_REVOCATION only; old eBay wildcard exemption is removed from
the ledger ratchet. Topic setup remains held until operational readiness is complete.

Evidence so far, under `/private/tmp/cx-completion-20260922/`:
- Receiver red→green: `c11d5-receiver-red.log`, `c11d5-receiver-green.log`.
- Longer provider hold red→green: `c11d5-rate-hold-red.log`,
  `c11d5-processing-green.log`;53 inspection unit cases include numeric/three HTTP-date
  forms and invalid delays. Initial processing test had an incorrect expected URL;
  corrected to the existing official `/identity/v1/oauth2/token/introspect` endpoint.
- Legacy completion bypass reproduced in `c11d5-legacy-fence-red.log`, then14 realPG
  cases green. Expanded selection suite15/0skips passes with production-equivalent
  rights (`c11d5-processing-reviewed.log`); later503 case is not yet in that run.
- Slow eBay initially delayed Shopify; `c11d5-shopify-latency-red.log` reproduces it,
  and concurrent group wiring fixes it. `c11d5-wiring-reviewed.log`:132 unit cases pass.
- Core-only review approved, with requested canonical-service OFF and wrong env/ID
  controls added. Full integration review, final mutations/typecheck/canonical gate
  and commit remain pending. No production or vendor call was made.

Final C11d5 proof: **233 real PostgreSQL tests/19files/zero skips pass** under
production-equivalent owner permissions (`c11d5-canonical-postgres.log`).176 focused
regressions/11files pass (`c11d5-regressions-final.log`), including the unchanged
Shopify/Etsy parser paths. Typecheck and inbound-ledger ratchet pass. Nine critical
mutations were applied/restored and killed: processing enablement, crash warning,
terminal warning, identity preflight, provider hold, legacy completion, historical
unverified selection, raw admission and private lease serialization.

Full integration review approved after three concrete fixes: both manual routes now
check canonical readiness before any reset; historical unverified/unleased eBay rows
retain the bounded generic DLQ path (actual PostgreSQL worker proof); malformed JSON
reaches receiver-specific raw admission instead of failing in the shared JSON parser.
Non-JSON bodies may be rejected as body_unparseable by the real verifier; they are not
asserted to be verified merely because the route can retain bytes. Admin/Shopify JSON
semantics are preserved. A later503 case confirms the provider hold with attempts
still consumed. No test assertion, timeout or approval gate was relaxed.

### Observed upstream baseline — 2026-09-23 12:52 UTC

`git ls-remote origin refs/heads/main` now returns
`0a563d6d5700a9aded3a53cf64c9fcf543facb04`; public /api/health returned200, healthy,
build0a563d6d. This is the already-published PES/main merge, not an unpushed shared
worktree branch. Prior439d9e3d business/deployment evidence remains dated; this small
read does not reverify flags, ownership, scopes, Railway status or vendor behavior.
Sanitized artifact: `/private/tmp/cx-completion-20260922/observed-main-20260923.json`.
Before preparing any future release, integrate only this already-published main into
the isolated branch and run applicable gates against it. Never publish unpublished
PES history or touch its working changes. Quarantine recovery/key maintenance/archive,
transactional order/erasure handlers and all other matrix dependencies remain open.


## I1 — integration with published main0a563d6d (local)

The isolated branch merges only the already-published/main-serving0a563d6d snapshot;
no unpublished PES work or shared working change is included. Git reported no conflicts.
Incoming hooks add database/full-API gates and retain existing gates. The lockfile only
records the database package's already-resolved Vitest dependency.

Integration review exposed fresh-bootstrap omissions. The generated baseline is now
regenerated from Prisma (no production dump). Shared `cx-account-integrity.sql`, copied
exactly into new20260923d_cx_bootstrap_parity, installs the existing lease-pair and
nonnegative-grant constraints, exact deployed active-account/workspace-primary partial
indexes, failed-signature index and final Shopify/eBay/Etsy routing functions. These
are existing production semantics; no alias backfill or business-row DML is introduced.
The generator has one route-function source. The previously missed quarantine policy
manifest entry is fixed too: the parity gate first failed on it, and now all13 shared
policy files match their migration bytes. All447 models pass schema/column/ownership
checks. Existing migration files, including deployed20260922a, are unchanged.

Bootstrap now commits schema, migration history and runtime policies together. A
controlled policy failure previously left448 tables and stamped history; rollback
now leaves zero tables/history. The migration-gate fixture's schema includes its PID
so concurrent worktrees do not drop/truncate each other's fixture.23 database-package
tests pass, with six applied/restored mutations killed: both CHECKs, both unique
indexes, alias propagation and atomic BEGIN. Alias fixture setup was corrected to
actually activate the inserted connections; the alias mutation then proved its guard.

The integrated233-case realPG run passed232 and exposed one previously impossible
fixture: two active copies of the same account ID across environments violate the
actual deployed index, which lacks an environment dimension. The corrected24-case
admission suite passes under production-equivalent rights: it explicitly asserts that
restriction, then preserves both same-ID environment-routing/receipt-namespace checks
using legitimate inactive sandbox history. No assertion or production constraint was
weakened, and simultaneous active copies are not claimed supported. Other18 suites
passed unchanged. API typecheck passes. Independent review approves these repairs.
Full pre-push/integrated release gates still remain before any approved push.

Evidence: `c11-upstream-bootstrap-red.log`, `c11-upstream-routing-constraints-red.log`,
`c11-upstream-atomic-bootstrap-red.log`, `c11-upstream-bootstrap-final.log`,
`c11-policy-registration-red.log`, `c11-bootstrap-*-mutation.log`,
`c11-integrated-postgres-first.log`, `c11-integrated-admission-final.log`,
`c11-integrated-typecheck.log`, under `/private/tmp/cx-completion-20260922/`.

### D8 retention defect discovered before C11d6 (historical)

Actual code still dynamically deletes WebhookEvent through data-retention-sweep's
model map. Privacy's GET can create the default90-day policy. The existing source
ratchet misses this dynamic delete, and no archive writer exists. Historical
scripts/data-wipe-2026-05-20-execute.mjs also names the table. This is a release blocker,
not a closed archive criterion. Next: archive completed old receipts in place, retain
all proof/payload/identity, DB DELETE/TRUNCATE protection, race-safe legacy replay,
honest archived/deleted counters and privacy wording. Quarantine resolvedAt means
routing handoff, not successful processing; key maintenance/recovery remain open.


## C11d6 — retain inbound history and fence archival/replay (local)

The default-on retention job dynamically dispatched WebhookEvent to deleteMany;
its privacy GET could create the90-day policy. New archiveCompletedInbound uses the
database clock, completion age, workspace scope,500-row bound and SKIP LOCKED. Only
completed/isProcessed=true, unscheduled, unleased, unarchived rows qualify. It sets
archivedAt and retains all receipt payload/identity/proof/history; archiveUri remains
null. This is logical archival, not cold storage or reclaimed database space.

New shared inbound-history.sql and exact-copy migration20260923e_cx_inbound_archive
block DELETE and TRUNCATE for WebhookEvent and EbayNoticeQuarantine, including owner
SQL, and revoke runtime privileges. Fresh bootstrap and deployed migration have the
same14-file policy manifest. The partial candidate index matches eligibility.
Legacy replay now uses a guarded compare-and-set, so an archive winning after its
initial read cannot be reopened. eBay retains its locked replay protocol. Existing
tests use fresh scoped fixtures instead of bypassing production retention guards.
The historical wipe script no longer names WebhookEvent and was not executed.
The source ratchet now checks dynamic delete maps and2484 operational scripts across
root/API/database directories, plus1659 API source files.

The retention job reports archived/deleted counts separately and never falls back to
delete on archive failure. Privacy wording describes actual behavior; the existing
2555-day order floor is unchanged and the job still does not delete orders. An
unsupported legal assertion was removed; no fiscal-policy decision is implied.
Real-browser testing found native range-step rounding of valid values. All policy
sliders now preserve exact integer days, with associated labels/descriptions and
exact ARIA values. Review found the same bug for2800-day orders, now fixed too.

Evidence under /private/tmp/cx-completion-20260922:
- c11d6-postgres-reviewed.log:14 archive/replay/privileged-delete cases and24 admission
  compatibility cases pass under production-equivalent owner permissions, zero skips.
  Includes both archive/replay race orders for Shopify/eBay,501 rows with concurrent
  archivers, DB-clock skew, cross-profile exclusion and immutable redelivery history.
- c11d6-fixture-regressions.log:78 retention/health/alerts/legacy-replay regressions pass.
- c11d6-api-typecheck.log passes. Independent source review approved except exact-order
  slider precision, corrected and browser-proven. Final91 focused regressions and web
  typecheck pass. Canonical247 realPG/20files/zero skips passes with production-equivalent
  permissions (c11d6-canonical-postgres.log). Full pre-push remains a package gate.
- retention-preview/: actual RetentionCard bundled with app styles; synthetic data,
  system-font fallback and local-only save endpoint. Eight320/768/1024/1440 light/dark
  views have no overflow; visible screenshots inspected. All six sliders and both
  buttons have keyboard focus; text contrast light4.76/dark6.96; no browser errors
  after correcting the test fixture's duplicate-React import. Exact-values.json
  proves2800/730/180/90/365/7 remain exact. This is component proof, not full-app or
  WCAG AAA certification. Agent test tab/server closed; no production privacy GET.

Future deployment approval must explicitly cover policy-based automatic archival,
its candidate census and post-deploy receipt preservation check. No C9+ code has been
pushed/deployed/activated. Quarantine rekey/recovery remains open. A separate rollout
review found the old0a worker can select queued verified eBay rows and DLQ them with
its obsolete handler registry. Next slice must hold new admission/adoption unscheduled
until readiness, atomically claim pristine held receipts, and guard replay scheduling.
Compatible worker retirement/activation/rollback evidence is a release requirement.

Six applied/restored critical mutations were killed: owner DELETE, TRUNCATE, archive
row locking, legacy replay archived CAS, dynamic deletion-map registration, and the
historical operational DELETE. The first one-table TRUNCATE mutation survived because
CASCADE still hit the other protected table; removing both TRUNCATE guards failed the
independent privileged controls. This redundant protection is not counted as a killed
single guard. Removing archive locks caused the deterministic second archiver to take
500 instead of1 and caused expected blocked replay timeouts; the clean247-case rerun
has no failures/skips. Evidence: c11d6-*-mutation.log and c11d6-final-regressions.log.


## C11d7 — mixed-version eBay admission and atomic activation (local)

Review of published0a563d6d proved its old worker selects any due pending/failed row,
finds no eBay handler, and unconditionally dead-letters it. A flag in the new binary
cannot constrain an old process. Admission and owner quarantine adoption now ALWAYS
leave a new receipt pending/attempt0/nextAttemptAt=null, including after redelivery.
The ready new selector includes pristine held protocol receipts within its existing
four-row bound. Activation and claim happen in ONE fenced conditional UPDATE, using
DB time; there is no separately committed due-time exposure. Only verified, bound,
unprocessed, unarchived, unscheduled, unleased, attempt0 protocol-prefixed receipts
qualify. Historical inline, failed/DLQ, attempted and delayed work is not reset.
Existing retries retain leases, backoff and attempt budgets. Replay checks readiness
inside the locked queue function before changing its schedule, as well as route checks.

This simpler ALWAYS-held admission avoids a separate admission/flag branch and also
lets a compatible enabled worker pick up new deliveries normally on its next sweep.
Unsupported topics remain in private quarantine; no new topic activation follows.
The existing real replay/archive/domain fixtures now explicitly enable the processing
prerequisites when exercising successful replay; assertions and safeguards are kept.

Evidence in /private/tmp/cx-completion-20260922/:
- c11d7-rollout-defect-red.log reproduces five failures with a valid grant fixture.
  Earlier c11d7-rollout-red*.log failed on an incomplete synthetic GrantResult and
  is not counted as defect proof; it was corrected to the actual grant contract.
- c11d7-rollout-first.log:69 realPG cases pass across rollout/admission/replay/archive/
  processor suites. Expanded rollout suite9/zero skips passes in
  c11d7-rollout-expanded.log, including direct claim refusal with each prerequisite
  OFF, old-worker positive DLQ control, concurrent one-effect activation, DB clock,
  bounded selection and fourteen ineligible states.
- c11d7-regressions.log:87 focused tests/5files pass; API typecheck passes.
- Five applied/restored mutations killed: queued admission, claim readiness, pristine
  attempt budget, held selection and replay readiness. Source independently approved.
  Whole-package canonical gates remain pending; no deployment or channel call.

Required rollout/rollback order (approval and actual observation still pending):
1. Keep notification setup/processing OFF; no old-version replay during overlap.
2. Deploy the protocol-aware build to every receiver and worker. Logical archival
   and additive DB guards are part of the explicit package approval.
3. Prove all old workers AND in-flight sweeps have exited; prove old replay endpoints
   cannot be reached. If this cannot be established, do not enable processing; use
   a separately reviewed database protocol guard or compatibility rollout instead.
4. Only after operational quarantine recovery/key readiness and approval, enable the
   compatible processors. They activate held receipts without rebinding or resetting.
5. After any activation, roll back only to a protocol-aware build. Turning the flag
   OFF does not make rollback to0a safe: already scheduled retries remain old-visible.


## I2 — faithful account fixtures after full-package verification (local)

C11d7 is committed asf8f87e8af. The first whole-package hook passed23 database tests,
policy/schema/security source gates and4603 web tests (13 skips), then correctly failed
the full API suite:8 failed files,4 failed tests,11452 passed,335 skipped. Six files
failed their setup; two reached four failing test cases. Every failure is the existing
deployed ChannelConnection_active_account_key now faithfully installed by bootstrap:
older fixtures created multiple active same-channel/null-marketplace/null-external-ID
accounts, violating its documented sentinel uniqueness. The valid admission fixture
was fixed in I1; the full suite exposed eight more of the same fixture class.

Only those eight test files receive distinct synthetic externalAccountId values for
their intentionally distinct accounts. All active flags, primary controls, aliases,
account-isolation assertions and production constraints remain intact. The focused
8-file/79-test rerun passes (c11-i2-fixtures.log). No skips, assertions, timeouts or
production behavior changed. Independent fixture review approved. The full hook
rerun is pending. Failed evidence retained as c11d7-prepush-first.log and c11d7-full-api-first.log.


I2 final package gate passes on backend/sourcec65db206b:23 database tests,4603web/
13skips,11504API/287skips, both builds,127security,2725routes/0unmapped,256realPG/
21files/zero skips. Profiles-ON measured922files with41known failing/217tests, none
new or worse. The287 default-suite skips include the realPG cases run separately;
they are not represented as default-suite passes. Full evidence c11-i2-prepush.log,
c11-i2-full-api.log and c11-i2-profiles-on.log. No push followed the manually invoked
hook (its final “pushing” text is generic). All continuation code remains local.

## U1 — shared retention controls and exact day entry (local)

AGENTS.md requires shared design-system controls for changed UI. The retention card
now composes existing Card/Field/Input/Button; no shared DS file changes or factory
mirror are needed. It preserves exact integer days, existing floors/ceilings and
numeric API payloads; label, range hint and invalid state are associated with each
control. Drafts remain text while typing, invalid/empty/fractional/out-of-range values
cannot save, and controls are disabled during a save. Other privacy cards are unchanged.

Review found NumberStepper clamps every keystroke; real typing2800 became3650.
That intermediate choice is rejected, not claimed successful. Existing DS Input now
allows2→28→280→2800 with invalid partial drafts retained and saving disabled. Normal
Audit730 typing, keyboard clearing, invalid2000/2800.5/3651 and valid local91 save are
proven in the actual component browser. The browser client's fill('') did not clear;
Meta+A/Backspace explicitly did and the empty validation proof is recorded separately.
The original raw-slider precision fix remains historical C11d6 evidence, superseded
by this shared-control implementation.

Under retention-preview/: input-metrics.json (320/768/1024/1440,light/dark,nooverflow,
all6 names/hints), input-keyboard.json (6fields+Reset+Save), input-console.json (noerrors),
input-dark-320.png and input-light-1440.png visually inspected. Hint contrast5.32light/
7.38dark. Shared focus styling is visible in screenshots; computed transient shadow
values during rapid tabbing are not a latency/accessibility certification. Synthetic
localhost-only data/save endpoint, actual component/app+DS styles, system-font fallback;
no production privacy read/write. Browser viewport restored, test tab/server closed.
Intermediate stepper artifacts are prefixed ds-*; final artifacts are input-* and
explicit ds-input-* typing/validation proofs. Web typecheck and final production build pass (c11-u1-final-typecheck.log,
c11-u1-final-build.log); independent final review approves. No whole-app or WCAG AAA claim follows.

### Next uncovered UI contract

IngressTab still says “Replayed, and it succeeded” for any2xx replay response, while
the truthful new eBay API can return202/queued:true for deferred/retry/another worker.
Correct that display with response-contract regression/browser proof before release.
Quarantine recovery/operator visibility/key maintenance and all matrix work remain.
