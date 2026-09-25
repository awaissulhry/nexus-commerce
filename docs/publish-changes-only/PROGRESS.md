# PCO — progress

| Step | Status | Commit |
|---|---|---|
| Plan + automatic-writer audit | ✅ written; §1b completed, production BullMQ startup verified; **Q1(a), Q2(a) approved (Owner: “go”)** | — |
| PCO-0 — interim Publish warning | ✅ built and verified locally; historical differences, unknowns, explicit review-bound confirmation | `6431f5c67` |
| PCO-1 — exact send / acceptance records | ✅ built, reviewed and verified locally; additive migration not applied to production | `302b4d787` |
| PCO-2 — field comparison + accepted history | ✅ 53 tests; 17/17 mutations; fresh API types | `62c42c428` |
| PCO-3 — fresh channel evidence | ✅ built and locally verified; 21/21 live reads in7.958s at5concurrent | `ba1ee4957` |
| PCO-4 — Amazon sparse request | ✅ one child/root330bytes,8unchanged skipped; language-scoped accepted history; confirmed-404 create | `ba1ee4957` |
| PCO-5 — eBay sparse request | ✅ supported narrow fields/collections; explicit authored clears; strict variation boundary | `ba1ee4957` |
| PCO-6 — selection review | ✅ durable selection/CAS + UI/DSmirror; browser,53mutations, fresh API/web/Factory types | `949a1e574` |
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

## PCO-3 through PCO-6 implementation / measured checks (not released)

- Durable private change plan and pure selection endpoint; changing checkbox choices performs no fresh channel read.
  Explicit selection token and JSON compare-and-set both at preview persistence and submission claim; legacy unsent reviews refuse.
  Fresh submit rebuilds facts/live evidence/accepted history and recompiles the exact selected request; only actual participants get drafts/receipts.
  Request journal carries versioned intentional fields, separately from unchanged provider-required collection companions.
- Selection/database review exposed JSONB object-key ordering in the embedded JSON request string. Canonical rendering fixed the real DB
  reproduction. Service, selection, disposable-DB tests59/59; new selection tests23. Shopify existing-product detection checks native remote
  identity too and refuses the full publisher, even if its environment gate is opened. Shopify change-only remains deferred until linking.
- Main read-only probe: GALE-JACKET Amazon IT21/21 exact seller SKUs with attributes. Four concurrent requests11.541s exceeded the10s target;
  five concurrent7.958s passed. eBay GetItem matched item257646289420 with parsed content in1.372s. Listing gates disabled only in the local
  probe process; no channel mutation. Normal OAuth/gateway logs may be written. Production Redis DNS failed in existing imported queue code;
  reads themselves all succeeded. Records `pco3-live-reads.json`, `pco3-live-reads-c5.json`. Five matches the documented default rate/burst5.
- Local rollback-only payload probe: xavia-knee-slider IT, childblack part_number addition. Accepted-field fixture contains only roots previously
  sent, so this new root correctly remains unticked initially; explicit selection produces1PATCH/1root,330feedbytes vs8662fullfeedbytes,
 8 unchanged products skipped. No network attempts; rollback true. Records `pco4-payload-{initial,selected}.json` retain both first diagnostic
  and successful explicit-selection run. Live reads are separately measured; this probe is a compiler fixture, not provider acceptance.
- New ChangeReview DS component (Checkbox+KeyValue) mirrored to Factory, catalog/changelog/gap recorded. Browser real dialog with mock API:
  nine scenarios incl stale/destination/late-selection/legacy/double-submit; desktop1280/mobile390, light/dark, keyboard and focus pass.
  Initial sampled text minimum9.37:1; final expanded request preview minimum8.02:1; no unexpected console/network failures. Final labels use changes and compiled-product counts for atomic creates.
  Main inspected desktop/mobile screenshots.12 UI contract tests pass; fresh web types, DS conformance, token guard and both7:1 contrast gates pass.
- All required reviews resolved: scoped Amazon content intent keys preserve each language's accepted history; confirmed remote404 required
  before any atomic UPDATE; create metadata root order canonical across JSONB. eBay absent XML aspects remain unknown unless a correctly mapped,
  error-free authored override proves a clear. Empty omitted create fields never become deletion baselines. Parsed ItemID/status rejects foreign
  items and description CDATA; real GetItem projection retains required SKU tracking identity. Existing-listing price/stock validation errors
  stay outside content sends while creation requirements remain. Frontend validates selected owners/SKUs and current product/destination.
- Final mutations:21integration/UI/planner +16Amazon/selector/history +14eBay/parser/receipt +1realDBlanguagefold +1browser focus = **53/53**, every source SHA restored.
  Controls83 +76 +91 (overlapping suites); separate browser green/mutant/restored-control proof. Records `pco3-6-integration-mutations-final.jsonl`, `pco3-6-amazon-mutations.jsonl`,
  `pco3-6-ebay-mutations-final.jsonl`, `pco6-focus-mutation.json`. Earlier runs stopped on Vitest rejection-stack classification or an outdated expected test name;
  assertions were strengthened to explicit refusal status/message, never relaxed. Harness infrastructure/restore guards unchanged.
- Final broader publication/comparator/serializer regression run: **304API tests in16files passed;18web tests in5files passed**.
  Existing reader fixtures log localhost Redis refusals; disposable-DB refusal tests intentionally log CHECK constraint errors.
  Fresh private API, web and Factory TypeScript checks all passed; API/web repeated after the final variation warning and preview-focus additions. No test suppression or production service code changed during mutation proof.
  The additional live variation-theme warning regression failed first and then passed, including its mutation. Final request preview receives keyboard focus and its payload can be scrolled by keyboard. Latest main production API readiness read: healthy build7103b0ad; current main's Railway and Vercel status checks both success.
- Done when: fresh unknown-safe comparisons, sparse requests and exact selection review work — met under local/provider-stub validation.
  Cost when:21-SKU live reads>10s — measured4workers11.541s, adjusted5workers7.958s; supported provider collection requirements preserved explicitly.
  Gate: tests, mutations, types, DS/browser and independent review pass; actual first channel acceptance remains PCO-7 on the Owner's per-run word.
  Rollback: revert these application/UI changes, retaining PCO-1's additive migration/history; the interim overwrite-confirmation path returns.
- No production migration, push or live channel write yet. PCO-7 proof tools are being prepared read-only; synthetic proof snapshots must use
  reason `publish-proof` before sending so a temporary canary and its restoration never seed normal Nexus accepted-field baselines.

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

## Earlier production measurements (2026-09-25, retained as historical)

- Production gates: **Amazon = live, eBay = live, Shopify = gated** (Railway boot log, deploy `674bf97f`, 2026-09-24 20:23 UTC).
  Local `apps/api/.env` sets none → all `gated` locally.
- Queue: 2,199 FAILED rows, **all dead** → never re-sent automatically. 0 rows would be picked now. Shopify: 0 rows.
- Baselines: `ChannelListingSnapshot` 0 rows. One studio send ever (Amazon IT, 21 products, 2026-09-14, no payload stored).
- KNOWN overwrite exposure today: **GALE-JACKET · Amazon DE, 13 listings** (xracing + xavia-knee-slider DE are fully closed → refused).
  UNKNOWN (never content-read): Amazon IT 183, DE 23, ES 30, FR 36 open listings; eBay content 0 of 332 read (the 231 eBay
  `ChannelDrift` rows are the stock read-back, not content).
- eBay Inventory-model: 208 of 332 listings (8 families) refused by studio Publish.
- The Owner will link Shopify products and listings later (2026-09-25); Shopify stays gated until then.

## PCO-7 preparation status

- Amazon IT GALE-JACKET-BLACK-MEN-S: original Italian backend search terms read; proposed append `nexuspco202609251dab4448`; Amazon validated both the sparse send and exact restore. Proposal digest `15e10266ce67ec88dd6f8f386ca02e75305ac4d0e3382ca55b509c2444dbd48d`, prepared2026-09-25T03:42Z. Per-run approval requested asynchronously; **no answer/approval yet**. No channel write.
- Initial eBay standalone discovery found0 eligible items. Preparing one normal Trading family ItemID instead, retaining exact account/alias/participant boundaries, title-only XML and provider revision restrictions. No approval requested for eBay until its exact preview exists.
- Core backend commit `ba1ee4957`; review UI/DS commit `949a1e574`. Release push remains authorized. Proof execution requires the receipt migration after deployment, and separate per-run word; proof tools never migrate.

## Final follow-up and release preparation — 2026-09-25T04:38Z

- Production family-size read found xracing50, VENTRA/REGAL/AIREON25 and MOSS22 Amazon IT listings. The fixed9.5s budget starved healthy later SKUs (new test made only35of50 reads). Scaled the finite budget by21-product groups, retaining five workers and the existing21-SKU target. Red→green fake-time regression; no quota or send expansion.
- Accepted Amazon creation history now survives a missing local ASIN. Subsequent edits use PATCH; a propagating404 cannot authorize another full create. A matched accepted field record is evidence of prior publication, independently of local presence reconciliation. The public review labels it existing. Three regressions failed first, then passed. Foreign journal identity no longer perturbs the baseline revision.
- Final affected mutations:29/29 in `records/pco3-6-final-transition-mutations.jsonl`, all source SHA restored; the other earlier final groups complete53 distinct source/browser mutations. Fresh API types and the full304-test publication/comparator/serializer suite passed after these changes.
- eBay preparation initially found no standalone candidates. Read-only diagnostics corrected proof-only overfilters: product-master FBA is not eBay listing FBA; normal same-family stock memberships are allowed; membership parentSku is an operator-facing alias label. Four correctly scoped GALE Trading aliases then reached GetItem, but all failed title-test eligibility. No title write was sent.
- Description-only eBay proposal is now concrete: item256566101420 (GALE-JACKET,21linked products), append one HTML comment `<!-- nexuspco20260925b28c8268dbeb44e48c1150d9045eb469 -->`, then restore the exact30394-byte original description (SHA256 fd8965ec403ced2b7191064801427832ed5888a4c3d588774045cb8ac3627851). No buyer-visible text change intended. Local compiled preview only; no eBay revision-validation operation exists. Proposal digest3f769bec7032aa2ce518089df88c96a5bf545419c166140426c5ab593d1ab724, prepared04:15Z, expires06:15Z. Separate per-run approval requested; **no answer/approval yet**.
- Amazon proposal remains the validated keyword append/restore noted above. Both tools default to plan/read-only preparation, require exact proposal/digest for execution, journal before sending as publish-proof, and preserve recovery references. No probe changes Nexus content or the queue. No channel write or gate opening has occurred.
- Owner already authorized final push/deployment. Application changes and verification are complete. Full repository pre-push checks and production deployment verification remain; live proofs stay pending their separate per-run word. Shopify stays gated and existing Shopify change-only remains deferred as approved.
