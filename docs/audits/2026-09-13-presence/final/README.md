# PR.F — W3 NOT VERIFIED

**Closing verification stopped at admission.** At 2026-09-13T19:43:29.744994+00:00, the complete ledger contained **3 canonical AT-WAVE-4 lines for 2 distinct lanes**, PR.3 and PR.6. PR.1, PR.2, PR.4, PR.5, PR.7 and PR.8 had none. The premise that eight lanes had finished does not match this workspace. §C says PR.F starts when all eight are present; the closing brief says to post NOT VERIFIED, route the blockers, and stop when items 1–6 are not green.

This is an admission failure record, **not the requested completed 11-part closing audit**. It does not declare Waves 0–3 or lane P done, revoke PR.3/PR.6's lane receipts, or convert their measurements into PR.F verification.

## What PR.F measured

Machine `Awaiss-MBP.homenet.telecomitalia.it`, repository `/Users/awais/nexus-commerce`, 2026-09-13T19:43:29.744994+00:00; load 4.51/4.12/4.11. The admission instrument exited **1**, captured by redirect. No database was connected to; these are filesystem/ledger measurements. [Raw redirected run](logs/admission-final.log), [machine-readable result](admission.json), [re-runnable instrument](admission.py).

| Check | Measurement | Control / limit |
| --- | --- | --- |
| Distinct completed lanes | 2 of 8; PR.3 has 2 lines, PR.6 has 1 | Full-ledger `/usr/bin/grep`; W0-SEC positive control exits 0. Earlier literal-anywhere searches also found no completion line for the six missing lanes. |
| Required downstream gates | W2-SCHEMA-APPLIED, W2-READ, W3-API, W3-VOCAB, W3-SURFACE absent | Exact gate boundary prevents W2-READ-SHAPE from passing for W2-READ. |
| Required API route source | `/presence` has 0 matches in `apps/api/src/routes/product-studio.routes.ts`, grep exit 1 | Existing studio routes positive control exits 0. This is a source reading, not a HTTP 404 measurement. |
| Required Listings source | `_studio/listings` directory absent; Listings/Presence mount references 0 in StudioTabHost/navigation, grep exit 1 | Matrix/tab host positive control exits 0. This is not a browser measurement. |
| Browser holds | No unmatched canonical STARTING at snapshot; 1 historical overlap detected | PR.8 pr8-toolbar-final began while PR.6 pr6-scope-positive remained open. Later reruns exist; their success is relayed, not rejected because of the earlier overlap. |

The [gate register](gate-register.md) preserves canonical receipts and times, including REOPENED lines. It is not a complete resolution of the ledger's questions/assumptions/requests. Source and ledger hashes pin the reading; later saves require a new reading.

## What is relayed

[PR.1's own interim report](../pr1/README.md) says full reads, verify adapters/persistence/worker, local verbs and recreate/axis gates remain outstanding. It reports the latest whole API suite as 724 files: 693 passed, 25 failed, 6 skipped; 8,728 passed, 197 failed, 28 skipped tests, exit 1. **PR.F did not execute that suite and has not attributed its residual failures.**

[PR.5's migration record](../measurements/migration-record.md) says local `127.0.0.1:55439/nexus_development` applied, 68/68 checks, while production `ep-purple-river-altf6t3y.c-3.eu-central-1.aws.neon.tech/neondb` is **NOT APPLIED**, pending the separately reviewed workspace/backfill/index/RLS prerequisite. These are relayed results, not fresh database inspections. No backfill count is asserted by PR.F.

[PR.8's Listings report](../w3/listings/README.md) says staged, not mounted; 8 passed and 2 failed scratch contract tests; no passing W3 browser gate. It records the unknown timestamp discrepancy and the verify READ/reversal contract conflict. PR.F has not reproduced either contract-test failure. W2-DS, P-A11Y and P-TOOLBAR receipts are present; their test/screen results remain relayed.

## Required closing deliverables and remaining work

| Item | PR.F status at stop | Owner / next evidence |
| --- | --- | --- |
| 1. Tree | NOT RUN: tsc, shared build/tests, full bare pre-push, studio/web/API suites and seeded-red gate controls. No baseline-to-now table established. | PR.1–PR.8 finish their handoffs; PR.F then posts the save hold and waits for eight acknowledgements or the Owner's word before its one clean run. No hold or browser gate was opened here. |
| 2. Measurements | NOT RE-RUN: M1/M3, both-DB schema verification and no-backfill count. Production NOT APPLIED is relayed. | PR.5: resolve the recorded prerequisite through the Owner; complete the both-DB gate under existing authorization rules; M5 still needs an actual setting/account answer. |
| 3. Wire | OPEN: specified read-route source absent; HTTP, live eBay verify, cap/ceiling and impact-unavailable arms NOT RUN. | PR.1: complete W2-READ and verify after the schema/runtime dependencies; then provide the actual local endpoint for PR.F. |
| 4. Writers | OPEN: PR.1 explicitly reports local writers and recreate/axis gate unfinished. No disposable fixture/round trip/actor/drift check run by PR.F. | PR.1 with PR.2/PR.4: complete local writers, recreate/push/enqueue integration and preserve the no-outbound rehearsal. |
| 5. Delist | NOT RE-RUN: all four arms, Woo lifecycle refusal, Amazon gate inversion, narrowing and dry-run close. | PR.2/PR.3/PR.4 retain ownership; existing evidence remains relayed. PR.3's completion is not revoked. |
| 6. Screen | OPEN: Listings source/mount absent. No browser, hydration, screenshots, geometry or accessibility inspection run by PR.F. | PR.8 mounts after W2-READ/W3-API; PR.7 completes vocabulary/meta; PR.6 resolves the requested shared timestamp/read-action contract. Existing P receipts are not full W3 screen acceptance. |
| 7. All 163 audit dispositions | NOT PRODUCED. Full audit not adjudicated; no FIXED count claimed and no automatic conversion of 163 rows to OPEN. | A resumed PR.F must read and independently disposition every VERIFIED finding against the contract. |
| 8. Ledger lines | PARTIAL: canonical gate register captured; no complete answered/applied/open table of every question/assumption/request. | A resumed PR.F must read all eight lanes' full sections and subsequent replies. |
| 9. Honest cost | NOT MEASURED on GALE or two other XAVIA products. | No invented zero and no subtraction of incomparable old/new measurements. |
| 10. Commit attribution | NOT PRODUCED; `commit-groups.md` not generated. | A resumed PR.F must use actual claims, dirty∧listed attribution and current mtimes. This record is not a commit manifest. |
| 11. Wave 4 readiness | NOT READY; action paragraph below. | No Wave 4 approval or source change inferred. |

## Wave 4 action

Finish the current wave before an approval line: the Owner resolves PR.5's separately recorded production prerequisite scope and M5's eBay account/out-of-stock setting; PR.1/2/4/5/7/8 finish their owned dependencies and post their completion receipts; PR.1/6/7/8 settle verify as an explicit channel READ without inventing a reversal; PR.8 mounts Listings. Then PR.F reruns the full closing brief under the acknowledged save hold. D6 still needs both measured numbers on the same eBay family; D8 needs a fresh M2-backed offerScope decision (the ledger relays Offer=0 on both DBs); D11 needs M5's actual answer; D13 needs the second Shopify writer accounted for; D14 needs M8's actual running-process flags and the separate preview-refusal approval after Wave 3 runs in production; D19 retains the §B stateless-HMAC/short-TTL and per-coordinate typed-confirm contract. Current pre-push state, all 163 dispositions and the three-product cost remain unmeasured by PR.F and cannot support Wave 4 approval.

## Scope and changes

PR.F created only this final evidence directory and edited `docs/pes-claims.md` for its claim, routed requests and stop line. **0 app/schema source fixes, 0 DB writes, 0 channel writes, 0 commits.** No server was started, killed or restarted. The probe/read scripts and raw inspection logs are audit tooling, not production source; do not include them in a source commit by default. Bootstrap logs were created before the claim; that sequencing deviation is disclosed in the ledger. Some initial combined tool displays were truncated; raw redirected logs are retained. No whole-contract/whole-audit read is claimed from truncated displays. Full READ FIRST completion remains part of the resumed closing audit.

PR-GATE W3 NOT VERIFIED — Codex prf-closing-20260913 — 2026-09-13T19:45:31.802282+00:00 — admission 2/8; missing W2-SCHEMA-APPLIED/W2-READ/W3-API/W3-VOCAB/W3-SURFACE; items 1/2/5 not run, item3 source absent, item4 unfinished per owner, item6 source/mount absent. Requests routed to owning PR sections. STOP.
