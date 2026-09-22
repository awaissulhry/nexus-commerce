# Completion audit and implementation — 2026-09-22

## Authority and baseline

Continuation starts at `d34dc1239`, isolated branch `fix/channel-connections-20260922`.
Both worktrees inspected first. Only the preserved `cx-production-*.mts` probes were
untracked here. The other session's `pes/phase-0` tree was not modified.
Remote main re-read: `7c70556ea631be3bcca0fcbd25d9397b719eca9e`.
No deployment, production mutation or channel call is authorized by this continuation.

## Fresh production read — 17:00:39 UTC

Evidence: `/private/tmp/cx-completion-20260922/profiles.json`; prepared probe enforces
`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, verifies `readOnly=on`, prints the
Neon target host first, bounds statement time, and selects credential presence only.
No channel calls, credential decryption or production writes.

- Etsy belongs to **Motovento**, workspace `bf0047bf-e1d9-48d0-8cc6-20e94bb734dd`,
  connection `cmubtwtad00ctmu01w4qsruxt`, active/connected, all twelve stored OAuth
  scopes, encrypted credentials present. Last heartbeat `2026-09-22T15:00:03.911Z`.
  Its account route has external ID `1051233836` and no aliases/destination IDs.
  These are stored grant/heartbeat observations, not a fresh channel permission test.
- Motovento has zero ChannelListing rows and zero Etsy WebhookEvent rows. This does
  not establish portal webhook registrations, remote listing count or publishing mode.
- Shopify remains active/connected in Xavia Racing; no change made.
- Xavia Racing has thirteen eBay database rows. Exactly one,
  `cmt142bli01vcp4010fjo2k13`, has `managedBy=transferred` (Motovento tombstone).
  `listManagedConnections(true)` deliberately includes only `oauth` and `env`, so
  its predicate yields twelve. This reconciles the reported count from fresh database
  evidence and current code; the browser screen was not remeasured. Do not expose a
  transferred account as reconnectable merely to equalize the numbers.

## Slice C1 — replay cannot promote an unverified delivery

Exact change: `services/cx/ingress/ledger.ts` stores/reads verification in replay
selection and refuses manual queueing without proof; `jobs/inbound-retry.job.ts`
dead-letters already queued unverified records before loading any handler;
`routes/sync-logs.routes.ts` gives the explicit refusal reason. Positive verification
or an explicitly identified Amazon SQS IAM transport is required. This protects
connected Shopify as well as Etsy/eBay without changing their connections.

Acceptance: rejected and missing-verification records execute zero handlers through
both routes; signed deliveries and null-signature Amazon SQS records remain eligible;
persisted workspace/account attribution survives. No weakening of signature gates.

Regression: **8 failed / 14 passed** before implementation, **34 passed / zero skips**
afterward (retry lifecycle, worker trust and ledger suites). Two applied-and-restored
mutations removed the manual and worker guards independently; both were killed by
assertions, original bytes restored. Logs in `/private/tmp/cx-completion-20260922/`.
Independent review approved (also independently ran the original 34 tests). Its
suggestions added select-aware mocks, verification-selection assertions and transport
negative/Ads positive controls: **38 tests now pass**. API typecheck passed. Broader
release checks and deployment approval remain.

## Material findings still being implemented

- Etsy's actual webhook contract uses `event_type`, `resource_url`, `shop_id` and
  `order.paid`, `order.canceled`, `order.shipped`, `order.delivered`. The previous
  synthetic fixtures used different fields/names. Receiver also declares success
  after receipt read-back despite no order ingest. Official evidence:
  https://developers.etsy.com/documentation/essentials/webhooks/ .
- eBay catalogue payload formats are arrays; subscription format is scalar. Existing
  fixtures conceal the mismatch. Revocation dispatch sits after an order-ID guard;
  real ORDER_CONFIRMATION nests its order ID. Ledger success precedes async work,
  replay is not account-specific, and subscriptions can bypass handler readiness.
- Finances dry-run uses the wrong related identifier (`AMAZON_ORDER_ID` versus
  documented `ORDER_ID`), invented transaction identity, incomplete pagination and
  nonrecursive money parsing. Existing overlap counts cannot justify cutover.
  Source: Amazon's official `finances_2024-06-19.json` model and listTransactions
  reference. No new-API money write or overlap channel call was performed.

The historical “built” labels do not close these criteria. No P7 drop is approved;
the required green week cannot be proved on its second calendar day.

## Slice C2 — Etsy's documented envelope and shop routing

Fresh scoped read at **17:12:06 UTC** identifies ItalianHideCraft's verified shop ID
as `57783036`; its connection external ID `1051233836` is the **user**. The active
shop scope exists, but the route had no shop alias. Signed-in portal read at ~17:14
UTC: **zero endpoints**, with all four official event types visible in Event Catalog.
No portal change or test delivery was made. The raw census file was refreshed at
17:12; the earlier 17:00 result also remains in the session tool record.

Changed the receiver to read signed `event_type`, extract receipt IDs from the exact
HTTPS Etsy receipt URL and reject mismatching shop/foreign URLs, and pass the persisted
connection separately from the payload. It reconstructs requests through the existing
account reader; no arbitrary resource URL is fetched. The reader also checks the
webhook shop against that account. Four documented event names are replayable; two
historical synthetic names remain replay aliases only.

`20260922a_cx_etsy_shop_alias` extends the existing alias function and backfills only
Etsy routing rows from verified identity. It does not touch credentials, ownership,
Shopify or eBay rows. Etsy ingress matches shop aliases exclusively, avoiding numeric
collisions between unrelated user/shop IDs. The migration is prepared locally only;
deployment approval includes its routing-row backfill. Rollback requires the prior
alias function and removal of only the added Etsy aliases; no table/column is dropped.

Proof: documented-payload tests **10 failed / 9 passed** before correction; **35
focused tests pass** now. Real PostgreSQL tests **3 failed / 2 passed** before the
migration/fix; **5 passed, zero skips** afterward, including existing-row backfill,
identity updates, ambiguity, user/shop collisions, and eBay/Shopify controls. This
suite is added to the canonical PostgreSQL gate. Shop-match mutation applied once,
killed by assertion, restored. API typecheck passed. Independent review approved;
its extra tests assert shop-ID propagation and signed-body precedence.

**This does not close receipt ingestion.** The existing read-back-only handler is
still being replaced by transactional order ingestion before operational activation.

## Slice C3 — eBay catalogue/subscription transport and truthful reconciliation

Official `PayloadDetail.format` is an array; `deliveryProtocol` is a string, and the
subscription payload uses scalar values. Select advertised nondeprecated JSON/HTTPS
support, without inventing a format/version when metadata is missing. Existing
subscriptions must advertise a compatible payload before reuse or enablement.
Handler readiness cannot be bypassed by the old false override or a direct subscribe.

All three collections now follow bounded, same-origin/resource pagination, refuse
loops/incomplete results, and handle absolute next URLs. Disabled/unknown matching
destinations refuse setup instead of being declared ready. Configuration presence
is separate from remote success: failed/refused topics or failed GETs set `ok:false`
and the scheduled callback throws into **the real CronRun recorder**, recording FAILED.

Proof: first contract reproductions **10 failed / 7 passed**; reporting **2 failed /
18 passed**; independent review found and reproduced the cron-history bug (**4 failed /
2 passed**) and incompatible existing subscriptions (**2 failed / 30 passed**).
Final **73 passed, zero skips**, independently rerun and approved. API typecheck and
diff checks pass. Two mutations removed handler readiness and pagination origin
checks: each applied exactly once, killed, and restored. No eBay call was made.

Remaining separate eBay work: awaited account-scoped processors/replay, deletion
erasure, USER-token subscriptions and actual application catalogue/delivery proof.
This slice does not clear any `handlerMissing` flag or authorize live subscriptions.

## Slice C4 — correct and contain the Finances comparison

The official Amazon model uses **ORDER_ID** and **transactionId**. The old fixtures
repeated an invented identifier and therefore hid a false-zero comparison. Removed
the unproved 2024 money writer: it used invented identity, misread recursive amounts,
and lacked atomic dedupe. Requests now explicitly require `dryRun:true`; the existing
v0 writer remains operational. This is containment and measurement, **not cutover**.

The corrected comparison matches orders only within the resolved account, counts
distinct provider identities, validates every related identifier, rejects conflicting
duplicate identities, retains date/account/market filters on every page, accepts
Amazon's documented null terminal token, and refuses incomplete traversal. Output
records accountId, marketplaceId and `identity_and_order_overlap_only`. Legacy
`txWouldCreate` means identity candidates; `txWouldDuplicateV0` means same-order/type
overlap risk, **not proved duplicate money**. No currency or fee inference is made.
Explicit `marketplaceId:null` with a named account supports account-wide comparison
(required to include US MFN); omitted marketplace selection is refused for the full
comparison. The single-page probe also preserves an explicit account-wide choice.

Extracted only `/financials/sync` into `amazon-financials.routes.ts` so real Fastify
tests can verify malformed JSON bodies/flags never fall through to v0 writes and
accountId cannot be silently ignored. The URL and authorization boundary are unchanged.
All earlier test cases remain. Wrong official fixtures and unsafe real-write
expectations were corrected to the documented schema/explicit cutover hold. A static
assertion demanding the now-false phrase “0 calls ever” was replaced by guard wiring;
runtime tests independently verify the valid v0 default and new-path refusal.

Proof: **20/20 new contract cases failed** before fixes. Review's further input defects
reproduced **8 failed / 33 passed** after correcting Vitest table-driven array inputs.
Now **87 tests pass / zero skips** across four suites. Four verified mutations (write
hold, account binding, official ID, 50-page boundary) were killed and bytes restored.
Independent review approved this safety scope. API typecheck passed before final
comment cleanup; canonical release gate still required.

Read-only production aggregate at **17:55:53 UTC**: 2026-09-20 has one financial row
whose order is attributed to `cmothu9bo0000nz01asw6wx8j` and four with null account
attribution; 2026-09-21 has three null-attributed rows. Proposed first comparison:
Xavia Racing, that account, IT marketplace `APJ6JRA9NG5V4`, **2026-09-20T00:00:00Z
through 2026-09-21T00:00:00Z**, `useV0:false,dryRun:true`. Live calls are not approved.
Null historical attribution, a validated money mapping, durable provider uniqueness,
legacy/new race tests, cutover boundary and rollback remain mandatory before writing.

## Slice C5 — account sign-in holds preserve retry budget and resume correctly

Token-service and gateway holds (`CONNECTION_NEEDS_REAUTH`, `ACCOUNT_NEEDS_SIGNIN`,
`TOKEN_UNAVAILABLE`) defer without spending row/BullMQ retries, including an exhausted
ordinary retry budget. Etsy and both Shopify lanes retain typed codes; thrown errors
retain them in both cron drains and the BullMQ worker. Narrow canonical-message
matching protects older callers that dropped codes; ordinary 500 and transient eBay
401 controls keep their previous retry behavior.

The FAILED retry loader now includes non-dead AUTH_REQUIRED rows independently of
ordinary retry count, reads at most 200 oldest-due rows, and reloads channelListing.
Independent review found that missing relation would resume a native Shopify family
through the linked lane; the behavioral regression reproduces that error and proves
the recovered row uses its original native mapping. No connection/token was changed.

Proof: initial **7 failed / 39 passed**, thrown worker hold **1 failed / 3 passed**,
review's Shopify native/resume gaps **3 failed / 13 passed**. Final **77 tests passed,
zero skips** across six suites; API typecheck passed; independent review approved.
Applied/restored mutations remove the auth-hold code and retry listing rehydration;
both are killed by assertion failures. Production behavior still awaits deployment
and an observed held/resumed row.

## First canonical gate and runner diagnosis

Gate on `192de90dd` stopped with all **124 security assertions passing** and one
unhandled `EnvironmentTeardownError: Closing rpc while onUserConsoleLog was pending`
attributed to `auth.vitest.test.ts`. Log: `/private/tmp/cx-completion-20260922/release-gate.log`.
This is not a passing gate. An unchanged focused security rerun passed all 124 without
the error (`security-repro.log`). The auth sources/tests, test config/setup, API
dependency manifest and lockfile have no diff from `7c70556ea`.

Installed Vitest's console sender does not await `rpc.onUserConsoleLog`; worker
cleanup rejects pending RPC calls. The same symptom is documented in the open upstream
issue https://github.com/vitest-dev/vitest/issues/11153 and already appears in the
pre-continuation full API log. This supports a runner teardown race; this session has
not proved a deterministic trigger or repaired Vitest. No suppression, timeout,
dependency change or hook bypass is introduced. Retain the failed run and rerun the
canonical gate unchanged after this diagnostic; do not hide any repeat failure.

The bounded live-read runner was independently reviewed and approved for presenting
to the Owner. It describes its exact action without loading credentials unless
`--execute-approved` is supplied, pins the measured database, sanitizes failures and
limits execution to 120 seconds. Both live actions were requested via the approval
question; **no answer/approval has arrived and neither was executed**.
