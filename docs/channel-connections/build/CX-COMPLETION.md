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
