# Channel connections — completion matrix

This is the **one status file** for the channel-connections programme. Other documents link here
instead of repeating a status block. Dates and times are UTC. The repository is public: production
figures, hostnames, business names and ids stay in local evidence, never here.

## Status words (used everywhere in these documents)

Each requirement has exactly one state:

| State | Means |
|---|---|
| **implemented** | Code and tests exist on a branch; not on `main`, not running in production. |
| **deployed** | On `main` and running in production (Railway SUCCESS), with its switch OFF or with no switch, and no real production event recorded as proof. |
| **enabled** | Deployed and its switch is ON in production, but no real event is recorded as proof yet. |
| **production-verified** | A real production event or a dated read-only production check proved it. |

A requirement with no code yet is **not implemented**; P5.5 and P6.7 are **not required**; P8 is
**deferred**. "Built", "BUILT" and "done" in older records are implementation-time words, not states.

## Latest checkpoint — 2026-09-26

**PR #4 and three channel releases were deployed today; every new switch is OFF and nothing new is enabled.**
Merges happen by pull request; the Owner decides each merge.

| Release | Merged to `main` (UTC) | What it contains | Migrations | State |
|---|---|---|---|---|
| PR #4 `889f01893` (architecture) | 2026-09-26 09:44 | Prisma 7; migrations in a pre-deploy step; separate API, worker and scheduler processes; restricted runtime database login; generic inbound processing claims | (architecture programme) | deployed |
| PR #14 `578c3756c` (hotfix) | 2026-09-26 09:46 | Amazon FBM stock double deduction: never hold units an order line already took; consume at most ordered − taken | none | deployed |
| PR #15 `c5597f776` (Package A, C9–C11f6c) | 2026-09-26 12:26 | eBay inbound leases and durable receipts, eBay notice admission and encrypted quarantine, archive-never-delete, owner quarantine recovery, operator inventory / cold verify / rewrap tools, KMS-bounded crypto | 8: `20260923a..h_cx_*` | deployed |
| PR #32 `93215463f` (release B+C) | 2026-09-26 18:28 | One stock model for every channel (eBay single-transaction writer, Etsy receipts, cancellations after shipment, R1–R10), eBay price rework, eBay privacy review, contract-check relabel, Amazon Finances A0/A1/A2/A5, listing-issues card | 9: `20260926n..v_cx_*` | deployed |

Production after PR #32: the API, worker and scheduler deployments reached Railway SUCCESS between
18:47 and 19:11; public health at 19:23 reported `healthy` and build `93215463`. The pre-deploy
migration step is part of that deployment. Health still reports existing Amazon Ads integrity
findings (see "Held or not built" below); a healthy response is not a blanket operational verdict.

What is **not** claimed: no B+C behaviour has a recorded real-event proof yet, and the stock repair
for the orders the FBM bug deducted twice has not run (it needs its own Owner yes, after the hotfix is
proven in production). Per-release detail: [RELEASE-C1-C8](RELEASE-C1-C8.md) (2026-09-22),
[RELEASE-C9-C11F6C](RELEASE-C9-C11F6C.md) (Package A), the PR #32 description and
[the stock model](2026-09-26-STOCK-MODEL.md) (B+C).

Recovery branches (deploy only if a release fails after migrating; never downgrade the database, never
revert a migration folder): `recovery/cx-20260925` for Package A and `recovery/cx-bc-20260926` for B+C.
Both carry the release's `packages/database` byte for byte.

### Owner rulings (2026-09-26)

1. Shipped, then cancelled or refunded: the shipped stock stays taken and the owners are told; a
   booked-in return restocks.
2. Etsy holds stock from receipt arrival, also while the payment is processing; the hold is released if
   the payment fails; stock is taken when the whole receipt has shipped. This replaces the earlier S1
   "hold when paid".
3. eBay account deletion: remove personal data now and keep only what tax law needs (option A).
   **Recorded, not built.**
4. Merges happen by pull request; the Owner decides each merge.
5. Also recorded: the FBM stock repair runs only after the hotfix is proven and with a separate yes;
   Package A may use KMS after a KMS test passes. Summary of the day's review:
   [2026-09-26 approach review](2026-09-26-APPROACH-REVIEW.md).

### Held or not built

| Item | State | Where |
|---|---|---|
| Amazon Finances A3/A4 (identity migration, 2024 writer) | implemented (held) | local branch `fix/cx-amazon-finances` (not pushed); waits for the A2 dry run on real data |
| eBay notifications end to end (seller-token subscriptions, handlers marked ready) | not implemented (planning) | every topic is still `handlerMissing`, so setup subscribes nothing |
| Amazon Ads drift fix (drift rows that cannot close) | not implemented (planning) | outside this plan's packages |
| Shopify order webhooks | not implemented (planning) | Shopify stays connected; no order webhook registered |
| eBay privacy option A executor (erase personal data, keep tax records) | not implemented | ruling 3 |
| Switch-on of the deployed features | waiting for the Owner | one switch at a time, each proven by a real event (local switch-on plan) |

## Switch table

Generated on 2026-09-26 from `main` at `074c1cf54`: every `process.env.NEXUS_*` read (and the `envEnabled` helper) in non-test source, then
compared with these documents. "Default" is what the code does when the variable is unset. Values are
exact: `1` and `true` are not interchangeable unless the row says so. "Production" is the last
read-only observation (2026-09-26, inferred from job behaviour; Railway variables are not read by
rule) or "not measured".

### New in the 2026-09-26 releases — all OFF by default

| Switch | Default (code) | Read by | Production |
|---|---|---|---|
| `NEXUS_ENABLE_EBAY_INBOUND_PROCESSING` | OFF unless exactly `1` (also needs `NEXUS_CX_TOKEN_SERVICE` not `0`) | API, worker, scheduler — set identically on all three | OFF |
| `NEXUS_ENABLE_EBAY_ORDER_NOTICES` | OFF unless exactly `1` | worker (retry), API (manual replay) | OFF |
| `NEXUS_ENABLE_EBAY_PRIVACY_REVIEW` | OFF unless exactly `1` | worker (review), scheduler (30-day notice expiry) | OFF (new) |
| `NEXUS_ENABLE_ETSY_ORDER_INGEST` | OFF unless exactly `1` | API (webhook), worker (retry), scheduler (poll) — set on all three together | OFF (new) |
| `NEXUS_ENABLE_ETSY_RECEIPTS_POLL_CRON` | OFF unless exactly `1` | scheduler | OFF (new) |
| `NEXUS_AMAZON_FINANCES_2024_WRITER` | **no reader on `main`** (writer A3/A4 not shipped) | — | — |

### Programme switches from earlier releases

| Switch | Default (code) | Read by | Production |
|---|---|---|---|
| `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP` | OFF unless exactly `1` | scheduler (nightly reconcile) | OFF since 2026-09-23 |
| `NEXUS_ENABLE_AMAZON_ORDERS_2026` | OFF unless exactly `true` | API, worker, scheduler | OFF (scheduled polls use v0) |
| `NEXUS_ENABLE_CHANNEL_CONTRACT_RUN` | OFF unless exactly `true` | scheduler (nightly), API (Run now) | ON since 2026-09-21; every run "not configured" |
| `NEXUS_CONTRACT_ACCOUNT_EBAY` / `_AMAZON_SP` / `_AMAZON_ADS` / `_SHOPIFY`, `NEXUS_CONTRACT_AMAZON_SELLER_ID`, `NEXUS_CONTRACT_EBAY_SANDBOX_*` | unset: that channel is "not configured" (Etsy is not applicable; no `_ETSY` variable is read) | scheduler, API | unset |
| `NEXUS_ENABLE_AMAZON_SUPPRESSION_PULL` | OFF unless exactly `true` | scheduler, API | OFF |
| `NEXUS_AMAZON_SUBSCRIBE_NEW_TYPES` | OFF unless exactly `true` | scheduler, API | OFF (six base types only) |
| `NEXUS_AMAZON_ENV_TOKEN` | env-token fallback allowed unless exactly `off` | API, worker, scheduler | not measured (needs a 24-hour log read) |
| `NEXUS_ENABLE_IMAGE_READBACK_SWEEP` | OFF unless exactly `true` | scheduler | ON since 2026-09-21 |
| `NEXUS_ENABLE_PRICE_READBACK_HEAL` | OFF unless exactly `true` | scheduler, worker | OFF (policy first) |
| `NEXUS_REPRICER_LIVE` | OFF unless exactly `1` | scheduler, API | OFF |
| `NEXUS_ENABLE_PRICING_CRON` | OFF unless exactly `1` | scheduler | OFF |
| `NEXUS_ENABLE_REPRICING_EVALUATOR` | ON unless `0` | scheduler | ON (no enabled rule) |
| `NEXUS_ENABLE_ETSY_PUBLISH` (+ `ETSY_PUBLISH_MODE`, default `dry-run`) | OFF unless `true`, `1` or `yes` | API, worker, scheduler | not measured; no Etsy write observed |
| `NEXUS_ENABLE_AMAZON_PUBLISH` / `_EBAY_PUBLISH` / `_SHOPIFY_PUBLISH` (+ `*_PUBLISH_MODE`) | OFF unless `true`, `1` or `yes` | API, worker | Amazon enabled (public health, 2026-09-26); Amazon and eBay `live`, Shopify gated (read 2026-09-19) |
| `NEXUS_ENABLE_INBOUND_RETRY_CRON` | ON unless `0` | worker | ON |
| `NEXUS_ENABLE_RETENTION_SWEEP` | ON unless `0` | scheduler | not re-measured |
| `NEXUS_ENABLE_AMAZON_NOTIFICATION_RECONCILE` | ON unless `0` | scheduler | ON |
| `NEXUS_ENABLE_AMS_SUBSCRIPTION_CHECK` | ON unless `0` | scheduler | not re-measured |
| `NEXUS_ENABLE_AMAZON_SQS_POLL` | OFF unless exactly `1` | worker | ON (order notices arrive and finish) |
| `NEXUS_ENABLE_AMAZON_ORDERS_CRON` | OFF unless exactly `1` | scheduler | ON |
| `NEXUS_ENABLE_EBAY_ORDERS_CRON` | OFF unless exactly `1` | scheduler | ON (so the eBay order writer is live) |
| `NEXUS_ENABLE_AMAZON_FINANCIAL_CRON` | OFF unless exactly `1` | scheduler | ON (v0 sync) |
| `NEXUS_RESERVATION_RECONCILE` | ON unless `0` | scheduler | ON |
| `NEXUS_ENABLE_RESERVATION_SWEEP_CRON` | ON unless `0` | scheduler | not re-measured |
| `NEXUS_EBAY_READBACK` / `NEXUS_QTY_READBACK` / `NEXUS_SHOPIFY_QTY_READBACK` | ON unless `0` | scheduler | not re-measured |
| `NEXUS_ENABLE_EBAY_TOKEN_REFRESH_CRON` | ON unless `0` | scheduler | not re-measured |
| `NEXUS_ENABLE_EBAY_LABEL_GUARD_CRON` / `_EBAY_IMAGE_READBACK_CRON` | when set, ON for `1` or `true`; unset follows `NEXUS_EBAY_REAL_API` | scheduler | not re-measured |
| `NEXUS_EBAY_REAL_API` | OFF unless exactly `true` | API, worker, scheduler | `true` (read 2026-09-19) |
| `NEXUS_ENABLE_EBAY_STATUS_RECONCILE_CRON` | OFF unless exactly `1` | scheduler | not re-measured |
| `NEXUS_ENABLE_EBAY_RETURNS_POLL` / `_AMAZON_RETURNS_POLL` | OFF unless exactly `1` | scheduler | not re-measured |
| `NEXUS_ENABLE_SHOPIFY_REFUND` / `_SHOPIFY_ORDER_CANCEL` / `_SHOPIFY_SHIP_CONFIRM` | OFF unless exactly `true` | API, worker, scheduler | not measured |
| `NEXUS_CX_TOKEN_SERVICE` / `NEXUS_OAUTH_COOKIE_ENFORCE` | ON unless `0` | all | ON (default) |
| `NEXUS_OVERSELL_CLAMP` / `NEXUS_EU_SHARED_QTY_GUARD` / `NEXUS_SYNC_ORDERING_V2` | ON unless `0` | API, worker | ON (default) |
| `NEXUS_WORKSPACES_ENABLED` | OFF unless exactly `1` | all | `1` (read 2026-09-19; business profiles ON) |
| `NEXUS_KMS_KEY_ID` (value) | unset: new credentials use the environment key | API, worker | set (KMS on since 2026-09-26; `docs/2026-08-29-kms-runbook.md`) |

Related non-`NEXUS_*` settings: `AMAZON_APP_CREDENTIAL_QUEUE_URL` (unset: automatic app-secret rotation
is off — it is unset), `EBAY_NOTIFICATION_ENDPOINT_URL` and `EBAY_NOTIFICATION_VERIFICATION_TOKEN` (eBay
refused the token twice; the Owner fixes it), `ETSY_WEBHOOK_SIGNING_SECRET` (needed before Etsy ingest).

Doc/code comparison (2026-09-26): the table above is the source; these mismatches were found and fixed
in the documents: (1) `PROGRESS.md` §5 said setting the eBay token and URL makes the nightly job
subscribe topics — setup also needs `NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1`, and every topic is
`handlerMissing`, so it subscribes nothing; (2) `PROGRESS.md` §5 said the contract run is off while
§0a-2 said on — it is ON with no sandbox accounts; (3) the structured plan listed
`NEXUS_AMAZON_FINANCES_2024_WRITER` as a switch — nothing on `main` reads it. One code comment still
disagrees with its code: `runtime/scheduler.ts` says eBay notification setup is "opt out via
`=0`", but the job is opt-in (`=== '1'`); a code fix is outside this documentation sweep.
Historical build records also name variables that no code reads any more
(`NEXUS_ENABLE_WOO_SHIP_CONFIRM`, `NEXUS_SHOPIFY_BULK_DRYRUN`, `NEXUS_AMAZON_BATCH_DRYRUN`,
`NEXUS_EBAY_TOKEN_REFRESH_SCHEDULE`); they are history, not settings.

## Acceptance matrix

Scope: Amazon, eBay and Etsy; Shopify stays connected; P8 is deferred. "Baseline" below means the
implementation was already in the deployed commit `7c70556ea` (before 2026-09-22).

| Requirement | State | Implementation / release | Production proof or gap | Remaining acceptance | Dependency |
|---|---|---|---|---|---|
| P0.1 | deployed | Gateway mode guards; baseline; `build/P0.1.md` | No per-operation production proof | Keep zero-call fixtures; audit live enabled operations | Live proof |
| P0.2 | production-verified | Auth, raw-body and timing-safe guards; baseline | Protected diagnostic GET answered 401 (2026-09-20, again 2026-09-22) | Keep negative guards | — |
| P0.3 | deployed | Encrypted operator secrets, private-address refusal; baseline | KMS on since 2026-09-26; storage mode per credential not re-read here | Read boolean encryption evidence; never disclose a secret | Read evidence |
| P0.4 | deployed | Signed eBay refund transport; baseline | No successful refund recorded as proof | A real or EU-sandbox refund | Live call / test account |
| P0.5 | deployed | Expiry UI, 90/30/7-day alerts; baseline | Amazon app-secret expiry date not recorded | Owner records the date; verify the owner notice | Owner portal read |
| P0.6 | deployed | Per-profile Amazon subscriptions and ledger; baseline | Base subscriptions reconciled nightly; per-profile arrival not proven | Read cron and ledger per profile | Observation |
| P0.7 | deployed | Per-row account in the queue; baseline | Second-account end-to-end not proven | Keep isolation guards; inspect live attribution | Live proof |
| P0.8 | deployed | Official deadlines (documentation) | Documentation only | Re-check vendor dates when a flow changes | — |
| P1.1 | deployed | `gateway/gateway.ts`; auth-hold safeguards (C5, 2026-09-22) | No held/resumed row observed | Observe a naturally held and resumed row | Observation |
| P1.2 | deployed | Gateway ratchet at zero for all channels | Ratchet is a CI gate, not a production proof | Keep ratchet and exemptions | — |
| P1.3 | deployed | One outbound row creator; destination column (C5) | Per-account attribution not freshly proven | Observe per-account recovery | Observation |
| P1.4 | deployed | Connected Shopify on GraphQL `2026-07`; baseline | Shopify publishing gated; no stock round trip | Round trip on a development store | Owner test store + live call |
| P1.5 | deployed | Shared eBay marketplace headers; baseline | Fixture coverage only | Keep per-market header regressions | — |
| P1.6 | deployed | Approved groups removed; baseline | — | New deletions only with their own yes | — |
| P1.7 | deployed | Previews and ended-listing guards; baseline | — | Keep the 200-row preview policy | — |
| P1.8 | enabled | Nightly sandbox contract run; relabel and Etsy not-applicable (PR #32) | Switch ON; no sandbox account named, so no check runs | Owner names sandbox accounts; first per-channel result | Accounts |
| P2.1 | deployed | Inbound ledger/retry (2026-09-20); durable eBay receipts, leases, archive-never-delete (PR #15); generic claims (PR #4) | eBay processing switch OFF; no real eBay notice processed | Real delivery and recovery proof after activation | Owner switch-on |
| P2.2 | enabled | Amazon per-type subscriptions and parsing; baseline | Base types subscribed; order notices arrive; new types OFF; FBA inventory notices end as dead letters | New types after a yes; per-type arrival | Owner switch |
| P2.3 | deployed | eBay notification transport and setup (C3/C8); order-notice processing (PR #15/#32) | Setup OFF; every topic `handlerMissing`; eBay refused the verification token; no genuine eBay notice ever stored | Token fix; mark handlers ready; seller-token subscriptions | Code (planning) + Owner portal |
| P2.4 | deployed | Shopify reconciliation and lifecycle; baseline | Store connected; no order webhook registered | Shopify order webhooks | Planning |
| P2.5 | deployed | Etsy routing (C2, 2026-09-22); receipt ingest, holds on arrival, poll, reconciliation (PR #32) | Ingest and poll OFF; no Etsy webhook has ever arrived; no activation row | Webhook, signing secret, T0, switches; first real `order.paid` | Owner (see [ETSY-INGEST-ACTIVATION](ETSY-INGEST-ACTIVATION.md)) |
| P2.6 | deployed | Grant versions, seller fence, atomic revocation, owner warnings (PR #15) | Processing OFF; no real revocation processed | Real revocation/reconnect proof | Activation |
| P2.7 | deployed | AMS dedupe and subscription check; baseline | Hourly arrival per profile not freshly proven | Per-profile dataset read | Observation |
| P2.8 | deployed | Ingress tab; owner quarantine recovery API/UI (PR #15) | No production UI observation | Browser check in production | Observation |
| P3.1 | deployed | Gateway error vocabulary; baseline | — | Keep fixture distinctions | — |
| P3.2 | deployed | Listing-issue recorders; suppression job | Suppression pull OFF | Switch on after a yes; verify attribution | Owner switch |
| P3.3 | deployed | Listing-issues API and Diagnostics card (PR #32) | No production UI observation | Browser check in production; studio pane stays with PES.3 | Observation |
| P3.4 | deployed | Owner notification path (C7) | No production failure induced | Observe owning-profile delivery | Observation |
| P3.5 | deployed | Deprecation-header reader; baseline | No real deprecation observed | — | Observation |
| P3.6 | deployed | Channel health and trace; baseline | No positive SLO evidence | Read per-operation counts against targets | Observation |
| P4.1 | enabled | Per-channel publish lanes; baseline | Amazon and eBay publishing live; no per-operation proof recorded | Keep previews and Presence boundaries | — |
| P4.2 | enabled | Image gateway and read-back sweep; baseline | Sweep ON since 2026-09-21; positive-count proof not recorded | Read sweep counts and issues | Observation |
| P4.3 | deployed | FBM hotfix (PR #14); one stock model R1–R10 for every channel (PR #32) | No real-event proof recorded yet; FBM repair not run | Prove on real orders; repair after its own yes | Observation + Owner |
| P4.4 | deployed | eBay price rework: one market per row, FIXED_PRICE offer, report-only read-back, variation confirmation, FX refusals (PR #32) | Read-back is report-only; heal OFF | Observe read-back findings; heal policy | Owner policy |
| P4.5 | deployed | Regional Ads discovery, disconnect, expiry; baseline | Do not reconnect Ads | Verify daily region repair | Observation |
| P4.6 | deployed | Etsy writers, freshness stamps (PR #32); baseline | Publish switch not measured; no Etsy listing in Nexus | Dry run, then live, after a yes | Owner switch |
| P5.1 | deployed | Orders 2026-01-01 adapter; live probe passed 2026-09-21 | Switch OFF | Re-run the probe after B+C, then switch on | Owner switch |
| P5.2 | deployed | C4 containment; A0 order stamping, A1 attribution, A2 dry run, A5 script (PR #32); A3/A4 implemented only | v0 stays the writer; A2 not yet run on real data; A5 not executed | A2 dry run → decide A3/A4 and A5 | Owner yes per step |
| P5.3 | production-verified | One Shopify version accessor | Every Shopify call measured on `2026-07` (2026-09-21) | Quarterly version maintenance | — |
| P5.4 | production-verified | No buyer-PII / RDT path | Order census found no stored buyer PII (2026-09-21) | Keep data minimisation | — |
| P5.5 | not required | Search Returns is not decommissioned | — | — | — |
| P6.1 | deployed | Amazon app-secret rotation (C7) | Off: no credential queue; expiry date not recorded | Queue, portal, IAM; first rotation | Owner |
| P6.2 | production-verified | eBay signing-key expiry | Expiry recorded from a real read (2026-09-21) | Keep the daily read | — |
| P6.3 | deployed | Rotated Etsy token persistence; baseline | Heartbeat proves the token path only | Inspect failures | Observation |
| P6.4 | deployed | Local revoke and removal hint; baseline | No destructive revoke requested | — | — |
| P6.5 | deployed | Owned-only heartbeat; baseline | Fixture evidence | Real-DB RLS evidence | Observation |
| P6.6 | deployed | Private authorization import; env fallback instrumented | `NEXUS_AMAZON_ENV_TOKEN` not set to `off` | 24-hour log read, then the switch | Owner switch |
| P6.7 | not required | Post-Order needs no extra scope | — | — | — |
| P6.8 | deployed | OAuth callbacks and alerts; baseline | Callback and webhook mode not re-verified | Portal checks | Owner portal |
| P7a | deployed | Dependency census; guarded code removal | — | Justified removal list | Explicit deletion yes |
| P7b | not implemented | Schema drops | — | Green week and a yes per table | Owner |
| P8 | deferred | New channels | Out of scope | — | Scope decision |
| CX cleanup | deployed | Guarded connection delete (2026-09-22) | Exact-ten deletion not executed | Fresh check before an approved delete | Owner yes |
| eBay privacy review | deployed | Acknowledge first, review in the worker, 30-day expiry of unmatched notices, `ErasureRequest` records (PR #32) | Switch OFF; no deletion notice has ever reached Nexus | Token and portal check; first real notice | Owner portal + switch |
| eBay privacy option A executor | not implemented | Ruling 3 | — | Build and review | Engineering |
| Quarantine operator tools | deployed | Inventory, deletion census, cold verify, rewrap (PR #15, #32) | No operator grant; tools never run in production | Grant, then inventory | Owner yes per step ([QUARANTINE-MAINTENANCE](QUARANTINE-MAINTENANCE.md)) |

## Measurable quality obligations (no blanket AAA pass claimed)

| Dimension | Acceptance threshold | Current proof / unresolved evidence |
|---|---|---|
| Correctness | Exact money/currency/quantity semantics; zero duplicate financial effects; no quiet partial reads | C4 containment; eBay price one-market rule and FX refusals; stock model R1–R10 with a forced-interleaving real-PG suite (PR #32). Monetary reconciliation and Finances cutover open. |
| Account isolation | Every write and inbound action names exactly one owner; foreign/missing/ambiguous identity causes zero effects | C2 routing cases; Package A admission and seller-fence real-PG suites; one owner per inbound row type (real-PG, restricted runtime login). Quarantine operator access still ungranted. |
| Security | Invalid/missing verification executes zero handlers; credentials never in diagnostics; no auth bypass | C1 replay trust; Package A encrypted quarantine and pinned definers; new SECURITY DEFINER functions pin `search_path` and revoke PUBLIC (PR #32). Live KMS operator proof open. |
| Resilience | Failed work remains recoverable; sign-in/rate holds spend zero row retries; no premature SUCCESS | C3/C5 guards; durable claims, replay, archive-never-delete (PR #15); R5 partial-order rule and R6 automatic `stock_blocked` retry (PR #32). Production recovery observation open. |
| Performance | Bounded traversal/work, account concurrency preserved; measure real latency/backlog against P3.6 targets | Bounded reads and batches; no production p95 or load claim. |
| Accessibility | Existing DS controls; 7:1 contrast gate; keyboard-only critical paths, 390/1280 widths, light/dark | Contrast gate green at each release; Tag success/danger text changed for 7:1 (PR #32). Production browser checks of the new cards open. |
| Observability | Failed/rejected/unknown events remain visible; healthy only with positive evidence; owning-profile alerts | Rejects stay in the ledger; contract run shows PARTIAL and NOT_CONFIGURED; owner notices for stock problems. Production delivery of alerts not observed. |
| Maintainability | Reviewed PRs, typecheck, canonical ratchets, no weakened gates | PR #15 and PR #32 passed their PR checks and independent reviews (detail in the PR descriptions and release records). |

## History

Older checkpoints (Package A gating and rehearsal on 2026-09-25, the 2026-09-22 C1–C8 release, the
2026-09-23 continuation) are superseded by the checkpoint above. Their evidence stays in
[RELEASE-C9-C11F6C](RELEASE-C9-C11F6C.md), [RELEASE-C1-C8](RELEASE-C1-C8.md),
[CX-REMAINING](build/CX-REMAINING.md), [CX-COMPLETION](build/CX-COMPLETION.md) and git history.
The [structured plan](2026-09-25-STRUCTURED-PLAN.md) records which of its phases are done.
