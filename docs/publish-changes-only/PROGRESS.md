# PCO — progress

| Step | Status | Commit |
|---|---|---|
| Plan + automatic-writer audit | ✅ written; §1b completed, production BullMQ startup verified; **Q1(a), Q2(a) approved (Owner: “go”)** | — |
| PCO-0 — interim Publish warning | ✅ built and verified locally; historical differences, unknowns, explicit review-bound confirmation | `6431f5c67` |
| PCO-1 — exact send / acceptance records | ✅ built, reviewed and verified locally; additive migration not applied to production | `302b4d787` |
| PCO-2 — field comparison + accepted history | ✅ 53 tests; 17/17 mutations; fresh API types | local commit below |
| PCO-3 … PCO-6 | ⬜ implementation authorized; follows comparison | — |
| PCO-7 — live channel proofs | ⬜ each run needs the Owner's word after read + preview | — |

## Continuation B — 2026-09-25

- The completed audit is in PLAN §1b. Listing publish gates do not control order actions, advertising or setup.
- Active deployment `674bf97f-fd44-438d-b662-7348a810ccba` logged BullMQ outbound worker startup at
  2026-09-24 20:23:55.111 UTC (concurrency 5); all queue workers started a millisecond later. Read-only Railway evidence.
- No automatic replay of the measured FAILED + dead outbound rows found. PENDING consumers lack an independent dead filter;
  the conclusion depends on the measured status invariant. Shopify automatic-origin unfinished operations can continue separately.
- FBA guards can restore fulfillment automatically; Shopify's linked-family cron can write only for AUTOMATIC listings.
- No product code, channel or production-data write during the audit. No commit/push. Documentation save was delayed by another push.
- Build authorization: “go” on the recommended Q1(a), Q2(a). The interim warning covers studio Publish only.

## PCO-0 verification

- API reader/service/database: 47 passing tests (formulaDatabase for the database arm). Seven new service arms failed before implementation.
- Publication plan/transports/eBay parity/account: 34 passing regression tests. Web model/component: 9 passing tests.
- Initial database proof failed on missing fixture `channelMarket`/`region`; fixed the fixture, not production code. Final database suite 3/3.
- Shared build, fresh private API/web TypeScript checks, DS conformance, web token guard and 92-pair contrast gate passed.
  First types failed on stale shared declarations after fast-forward; rebuilding shared fixed both CFI and PCO declarations.
- 14/14 mutations caught; all SHA-256 restores true. Final proof: `records/pco0-mutations-2026-09-25-final.jsonl`.
  The earlier run stopped on the harness's too-narrow assertion classifier; recognized Vitest's exact promise-assertion stack and reran.
- Real PublishMenu/PublishDialog + DS browser fixture, provider API mocked: desktop/mobile390, light/dark, keyboard tick,
  one correct-review submission, destination/stale-review reset, focus/Escape; no unexpected errors or external requests.
  Minimum sampled text contrast 9.37:1. `records/pco0-browser.json`; screenshots inspected.
- Independent source review: no required findings. No shared DS change, so no Factory mirror/gap needed in this slice.
- Done when: known/unknown historical content is visible and server refuses unconfirmed or stale existing-listing overwrites — met.
  Cost when: extra live reads or payload changes — neither introduced. Gate: tests/mutations/types/DS/browser passed; commit authorized by R-PCO-2.
  Rollback: revert PCO-0; it changes review/confirmation, not provider payloads. No live channel proof or deployment performed.

## R-PCO-2 — continue and deploy when complete

Owner: “okay, then continue and push to production when it's all done”. This authorizes step commits and final push/deployment.
Use the recommended strict eBay boundary: narrow item/picture updates; variation-content updates requiring stock/price are refused by name.
The per-run channel-write approval and Shopify linking/gate restrictions remain. No production migration or live send yet.

PCO-1: helper, tests and additive migration started; generation and integration pending after repeated other-lane pushes.
Three Shopify journal tests failed before its callback; 15 journal/status tests then passed, but importing the gateway classifier
also initialized Redis. Extracting that existing pure classifier removes the unintended dependency.
One combined main tool batch incorrectly applied the Shopify hook after detecting a push; edits were stopped immediately.
Subsequent guarded batches exit before any mutation unless the push check is clear.

## PCO-1 verification

- Captures exact final Amazon messages/header/market, eBay XML including request identity, and ordered Shopify GraphQL mutations.
  Awaited snapshot + audit transaction before the mutation. Existing/manual snapshots default UNACCEPTED; they are never invented baselines.
- Receipt, snapshot outcome and audit settle atomically. Amazon accepts per SKU only from processing report; eBay ACK alone does not accept;
  Shopify accepts after verification. Preserves previous accepted results and uncertainty; request journals cannot be restored as listing-state drafts.
- Review found Shopify effective-SKU attribution and first-journal-failure classification gaps; added real DB tests, observed two failures,
  fixed both. First journal failure is FAILED/retryable; after one mutation it is UNVERIFIED; listing SKU override is recorded exactly.
- Red proofs: 9 transport failures, 3 journal callback failures, 3 receipt integration failures, 1 restore-guard failure, then 2 review regressions.
- Final mutation controls: 94 tests across transports, Shopify callback, service + formulaDatabase, restore and records; **20/20 mutations caught**;
  every source SHA restored. `records/pco1-mutations-2026-09-25.jsonl`. Earlier helper-only mutation attempt ran zero mutants (sandbox EPERM at control);
  the final combined proof ran from the authorized main session and covers eight helper mutations as well.
- Additional gateway/plan/parity/account/native-status regressions: 55 passed. Existing gateway fixtures logged refused local Redis connections;
  no test failure or live channel call. Journal-specific and transport controls isolate the queue boundary.
- Fresh private API + web TypeScript checks pass; shared rebuilt; column drift 447 tables pass. Prisma generated locally; baseline generator
  changed exactly the two snapshot columns. Independent re-review: both findings resolved, no further required changes.
- Done when: every studio send records exact requests, with accepted baseline only on channel confirmation — met under stubbed-provider proofs.
  Cost when: more than one migration or business-payload change — neither. Gate: tests/mutations/types/review passed; no production migration/send.
  Rollback: revert application changes while keeping an applied additive migration/history and unused columns.

## Facts the next session must not re-derive (measured 2026-09-25, production, read only)

PCO-2 verified: pure three-way comparison distinguishes absent/null/unknown, requires explicit first-publish choices,
and rejects forged/nonselectable field IDs. Accepted history folds versioned intentional fields only, across pagination;
raw legacy request records invalidate affected prior knowledge instead of inventing baselines. Required collection companions
do not become local edit baselines. Provider normalizers can supply comparison verdicts without changing exact sent values.
Independent review found an unchanged-local/accepted-only comparison case; its regression failed first, then passed with the guard.
53 control tests passed; 17/17 mutations caught with all source SHA restores. First mutation run stopped on an unasserted
domain throw in the positive selection test; strengthened that assertion without weakening the harness. Fresh API types passed
after replacing Object.hasOwn with the existing target-compatible hasOwnProperty.call. No new production wiring in this step.
Done when: all comparison/accepted-history cases are covered — met. Cost when: drift comparators cannot be shared — not reached;
adapters will supply their verdicts. Gate: tests/mutations/types/review pass. Rollback: revert the isolated helper/contract commit.

- Production gates: **Amazon = live, eBay = live, Shopify = gated** (Railway boot log, deploy `674bf97f`, 2026-09-24 20:23 UTC).
  Local `apps/api/.env` sets none → all `gated` locally.
- Queue: 2,199 FAILED rows, **all dead** → never re-sent automatically. 0 rows would be picked now. Shopify: 0 rows.
- Baselines: `ChannelListingSnapshot` 0 rows. One studio send ever (Amazon IT, 21 products, 2026-09-14, no payload stored).
- KNOWN overwrite exposure today: **GALE-JACKET · Amazon DE, 13 listings** (xracing + xavia-knee-slider DE are fully closed → refused).
  UNKNOWN (never content-read): Amazon IT 183, DE 23, ES 30, FR 36 open listings; eBay content 0 of 332 read (the 231 eBay
  `ChannelDrift` rows are the stock read-back, not content).
- eBay Inventory-model: 208 of 332 listings (8 families) refused by studio Publish.
- The Owner will link Shopify products and listings later (2026-09-25); Shopify stays gated until then.
