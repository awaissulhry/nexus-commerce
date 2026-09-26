# Channel connections — completion matrix

## Latest checkpoint — 2026-09-25 11:38 UTC

**Package A code/recovery APPROVED, fully gated and locally rehearsed. No package or
recovery ref has been pushed by this session; nothing new is deployed or enabled.**
Final documentation signoff/publication remain pending. The Owner has approved reviewed,
gated, rehearsed deployment with every new switch OFF. The existing CI eBay consent-page
GET probes still need the separate narrow exception already requested; no yes received.

Published main is `2459bf52fe85e1ffe0b5f0c510994e019cb3eed4` (refetched11:37Z; docs after
bc39). Public readiness re-read before that fetch reports healthy serving **bc39f98d**.
Release source is **`3be0a62e1344626db7f8adf4e49351880cae6725`**; recovery branch
`recovery/cx-20260925` is **`34c376113380f4c803d4f91190f94c06126c56a2`**. Metadata commits
may follow the reviewed source. Recovery preserves published main and the exact release
DB tree; application differences are C11f6a/b/c only. Its PCO fixture correction has an
independent APPROVE; no assertion, timeout, ratchet or hook was weakened.

Clean source full hook: DB33, **API12220/359 existing skips**, **web4887/13**, both builds,
security127, RBAC2728/zero unmapped, **realPG328 in25 suites/zero skips**; profiles977 files,
41 known-failing/217 tests, none new or worse. Clean recovery full hook: **API12129/340**,
web4887/13, DB33/security127/builds, **realPG309 in23 suites/zero skips**; profiles971 files,
same41/217 unchanged baseline. Contrast at these heads: web92/factory106 pairs, zero below7:1.
Logs: release `package-a-gate-3be0a62e1-clean.log`, recovery
`package-a-recovery-gate-34c376113.log`; archived sublogs under their helpers' build/evidence
`package-a-3be0a62e1/` and `recovery-34c376113/`.

HTTP rehearsal passed **10:52:36Z**; background-jobs rehearsal **11:06:55Z**. Base **bc39**
bootstrap→release adds exactly eight CX migrations (**473→481**); old base refuses;
recovery34→release3be→recovery34 each returns ready200 with its exact build, unchanged
migration history/checksums and role/object invariants. Jobs initialized with processing
held. Current rehearsal folders contain these heads; earlier4e/77 proof is archived.
Both code/recovery reviews APPROVE. A first PCO-fixture gate failure and the source-equivalent
pre-checkout pass are preserved but are not substituted for the clean3be gate.

Latest private read-only census: **08:54:05Z**, `production-census-20260925-085405.json` (kept locally; not in the public repo):
473 applied migrations, zero unresolved failures, two rolled-back historical rows; all332
eBay listings IT (232 follow master), two active sellers with default warehouses; no v0
finance duplicates, **73 finance rows/62 orders unattributed**,39 recent Amazon orders
unattributed; exact Etsy shop57783036 active Motovento route; one active connected Shopify.
No non-IT master-price exception is triggered by this snapshot. Refresh before Package B
shipping. Last private switch evidence remains01:00:45Z: all six new switches unset/OFF,
with positive DB-source match. Refresh before publication; no newer switch verification is
claimed. Public health at06:54:44Z reported15 quantity mismatches and existing critical Ads
findings; healthy readiness is not a blanket operational verdict.

Package B remains unintegrated: contract a6b5fefaa, price3fa33094f, Finances3f493f5ff and
eBay orders68fcc9f36 APPROVED. Etsy ingest c621418e and SKU identity da1de249 APPROVED;
pooled line foundation61cbe88bc is under review and terminal writer integration remains open.
Its offset-ceiling history limit remains an explicit hold, not unrestricted completeness.
Package C: listing issues16945532a and Tag contrast e738e4531 APPROVED; privacy census
6e6687952 APPROVED, candidate records in verification; cancellation parity b77db1bd3 APPROVED,
terminal follow-up b382fb7ba required fixes (recovery65bda8b72 committed, atomic-state fix in
progress). Contract follow-up330395766 and teardown87406ac23 await independent review.
The latter proves/fixes a setup-client shutdown race consistent with the original57P01;
it does not explain recoveryf9's separate PGlite socket loss. Remaining engineering,
activation preparations and Phase5 audit remain open under the structured plan.


Last fully verified release (2026-09-22): `0f89aa53-ce89-4518-91b6-76a5c2d68507`, **SUCCESS**,
commit `439d9e3d34ed79a09d76981da08de5d2ca0190e2`. Both GitHub jobs and the deployment
smoke test are **SUCCESS**. Final public/database verification repeated at **21:58 UTC**.
Sanitized release evidence: `build/RELEASE-2026-09-22-EVIDENCE.json` (kept locally; not in the public repo). This supersedes
older pending-deployment notes; the full channel plan remains open.

Updated 2026-09-25 (production evidence uses UTC). **Open working audit; not a completion declaration.**

“Baseline” means the implementation is present in the previously verified deployed
commit `7c70556ea`; it does not mean enabled or production-verified. Historical test
records remain dated evidence. New findings override “all built” summaries. Active
scope: Amazon, eBay, Etsy. Shopify stays connected; P8 stays deferred.

## Historical checkpoint — source77/recoverya5 before published main moved

Follow [the structured plan](2026-09-25-STRUCTURED-PLAN.md), Phase 1 before Phase 2.
The Owner approves each reviewed, fully gated and rehearsed package pushed to `main`
and deployed with every new switch OFF. Activation, live vendor calls/probes, operator
grants, KMS/rewrap/key retirement, credentials/environment changes, deletions,
`prisma migrate resolve`, Finances cutover and P7 drops still need separate explicit approval.

- **Published/serving baseline:** fetched main `a22f2fc361488c3620d6c8110344e8200c46ebb2`;
  public health HTTP 200/healthy/build `a22f2fc3` at **2026-09-24T23:49:30.532Z**.
  Five quantity mismatches and critical Ads integrity alerts remain. This public read
  does not refresh private business, migration, runtime or switch evidence.
  A 2026-09-25 Railway CLI read (MCP unavailable) confirms base deployment
  `674bf97f-fd44-438d-b662-7348a810ccba` SUCCESS at the same GitHub SHA; remote main
  was rechecked unchanged at 2026-09-25 00:15Z. This is baseline evidence, not Package A deployment proof.
- **Package A, implemented locally:** C9–C11f6c merged cleanly with that main at
  `77c787559d95dc394df358a9fea7b10179b6d5a0`. Independent whole-package source review
  APPROVE. The exact-head normal full hook **passed, exit 0**: 33 database; 4,850 web /
  13 existing skips; 11,883 API / 359 existing skips; both builds; 127 security; RBAC
  2,727 routes / zero unmapped; 328 realPG tests in 25 suites / zero skips, NOSUPERUSER.
  Profiles-ON: 961 files, 41 known failing files / 217 tests, none new or worse.
  AAA contrast gate: 106 pairs, zero below 7:1. Package A is **not pushed or deployed**.
  Logs and limits of this proof are in [the release record](RELEASE-C9-C11F6C.md).
- **Recovery:** `recovery/cx-20260925` at `a5efa0dd9`, from `38c99a7af` + the same
  published main + the release database tree + the two prescribed test-support files.
  Exact `packages/database` diff and independent source review pass. Recovery normal full hook
  **passed, exit 0**: 33 database; 11,792 API / 340 existing skips; 4,850 web / 13 existing
  skips; both builds; 127 security; RBAC 2,727 / zero unmapped; 309 realPG / 23 suites /
  zero skips; profiles-ON 955 files / 41 known failing files / 217 tests, none worse.
  Earlier recovery branches are historical only.
- **Source rehearsal passed:** HTTP at **2026-09-25 00:12:13Z**, jobs at **00:15:11Z**,
  for source `77c787559` / recovery `a5efa0dd9`, PostgreSQL 17.11, NOSUPERUSER owner.
  History 471 → 479, exactly eight CX migrations; `a22` refuses those exact eight;
  recovery → release → recovery returns 200 with exact builds, unchanged full history,
  checksums, roles/attributes/objects and pinned definers. Each jobs boot stays alive
  45 seconds, initializes once and reports `ebayProcessingEnabled:false`.
- **Final commit checks remain:** docs/tools follow the source head; application/database/
  hook/workflow trees are unchanged. Source/tool/docs reviews APPROVE. The rehearsal guard
  fix `44604ff9d` is reviewed. Expanded proof passes 29/29 synthetic tests and 39/39
  assertion-killed mutations (13 original + 26 additional), with zero unresolved survivors.
  Runtime guard scripts are restored byte-for-byte to `44604ff9d`.
  The final release commit's normal hook and both exact-build rehearsals are pending.
  Set `CX_RELEASE_SHA=<final-release-sha>` for both rehearsal scripts; defaults pin source77.
  No package or recovery ref has been pushed. See the release record for the reviewed
  sequence that publishes the separately gated recovery SHA from the clean final release tree.
- **Separate scope confirmation before main push:** the existing `deploy-api.yml` workflow
  runs `apps/api/scripts/check-ebay-consent-scopes.mts`, which GETs `auth.ebay.com` consent
  pages for base/fake/full scopes, without sign-in, token exchange or writes. These are
  live vendor probes, excluded from the deployment approval. Finish package preparation,
  then obtain one narrow Owner yes for this automatic deploy gate. Do not skip or weaken it.
- **Package B, local and unmerged:** contract coverage `a6b5fefaa` is approved;
  eBay price read-back `915b0b4fa`, Amazon Finances `509d8af99`, eBay order writer
  `9e4380c12`, and Etsy receipts `cf032a270` still need independent re-review.
  Integrate in that order after Package A production verification and the required census.
- **Production census:** the Bash permission rule for `build/tools/prod-census.mjs` (kept locally; not in the public repo)
  is saved. The script stopped before querying because the isolated root `.env` URL
  has no username/password. The Owner has been asked for an existing approved credential
  source path; no credentials or environment variables were changed. Do not repeat the
  permission request or infer empty results. If any non-IT eBay listing follows the
  master price, ask the Owner before shipping the per-market currency change.
- **Etsy decisions are settled:** S1 hold on paid / deduct on shipment; H1 from activation.
  C11f6b cold verify and C11f6c audited rewrap are implemented locally; no operator grant,
  live KMS use, rewrap or key retirement has occurred. Phase 3 engineering and Phase 4
  activation actions remain open; Phase 5 has not passed.

## Dated implementation and production evidence — through 2026-09-23

Current source audit: three independent reviewers plus main-session source/contract
inspection. Fresh production evidence and new slices: [CX-COMPLETION](build/CX-COMPLETION.md).
New local continuation: [CX-REMAINING](build/CX-REMAINING.md). C9–C11d7 implement
atomic receipt identity, durable claims, grant generations, current-refresh inspection,
transactional revocation/owner warnings, private admission and same-/cross-record
seller fences, stored receipt execution, archive-never-delete, and rolling-deployment
holds. They are independently reviewed locally and remain undeployed/default-OFF.
I1/I2 integrate only published main and make bootstrap/test fixtures match deployed
constraints. The full local package gate passes on c65db206b (256 realPG/zero skips,
11504 API,4603 web,both builds,127 security; detailed skips/ratchet in build record).
U1 adds reviewed shared retention fields with real-browser/typecheck/build proof.
U2 corrects Ingress queued/completed feedback and preserves keyboard focus; see its
current build record. C11e1/e2 add reviewed owner-only recovery APIs/UI and profile
read-race guards (264 realPG and full local API/web/build gates in their record).
C11f1/f2 add owned-only maintenance, strict pinned/cold/lossless encryption and cache
race fixes (11543 full API tests,44 targeted realPG,7 mutations for f2). C11f3 adds
quarantine integrity separate from adoptability (79 focused,32 realPG,6 mutations).
C11f4 adds private database CAS/mandatory audit (26maintenance+32adoption realPG);
full gate passes11569API,4640web,bothbuilds,291realPG/zero skips,127security;
profiles ratchet unchanged. These are local only. Global quarantine inventory/
cold verify/rewrap entry point and actual maintenance proof,
transactional order/erasure work and channel operational dependencies remain open.
The Owner approved deployment. Final commit `439d9e3d3` (C1–C8 plus two verification
repairs) is pushed to main and serving in production. At 21:54Z: native Railway
SUCCESS, exact health/readiness build, protected diagnostic GET401, migration
checksum/finished state and all 18 pre-existing connections preserved. GitHub CI
passed 1,904 API regressions (four existing skips) and 3,093 web regressions. The
Deploy API workflow and final smoke test are also SUCCESS. This is release
verification, not a completion declaration for every channel flow. The additive Etsy
alias migration is the approved data change. Separately prepared vendor probes,
connection deletion, new channel activation and P7 drops have not been executed.

C11d3 private eBay admission is local only; original-profile and quarantine race
proofs are in [CX-REMAINING](build/CX-REMAINING.md). C11d4 adds the locally reviewed
cross-record seller fence (10 realPG/190 regressions); C11d5 wires execution locally (233 realPG/176 regressions); operational
recovery/key maintenance/archive and activation remain open.

Reobserved at2026-09-23 16:27Z: published main and public health remain0a563d6d, healthy200; five quantity mismatches and critical Ads integrity persist.
This supersedes the old serving-build observation only; the dated439 business/flag
proof remains dated. New continuation slices are still unpushed/undeployed.

## Acceptance matrix — current release status is recorded above

| Requirement | Implementation / test evidence | Deployed | Enabled / production proof | Remaining acceptance | Dependency |
|---|---|---|---|---|---|
| P0.1 | Gateway mode guards; build/P0.1.md | Baseline | Production modes need fresh read; no per-operation proof | Preserve zero-call fixtures; audit live enabled operations | Live proof |
| P0.2 | Auth/raw-body/timing-safe guards; build/P0.2.md | Baseline | Fresh protected diagnostic GET401 with health/readiness200,21:20Z | Local negative verification guards pass; retain channel-specific live-proof boundaries | Further live proofs separately |
| P0.3 | Encrypted operator secrets/private-address refusal; build/P0.3.md | Baseline | Storage encryption mode not freshly checked | Read boolean encryption evidence; no secret disclosure | Read evidence |
| P0.4 | Signed eBay refund transport; build/P0.4.md | Baseline | No successful sandbox/live refund proof | Authorized EU sandbox refund contract | Live call/test account |
| P0.5 | Expiry UI/90-30-7 alerts; build/P0.5.md | Baseline | Actual LWA expiry date outstanding | Record real date and verify owner notification | Owner portal + production write |
| P0.6 | Per-profile Amazon subscriptions/ledger; build/P0.6.md | Baseline | Current subscriptions/arrival evidence incomplete | Read current cron/ledger by profile | Live subscriptions separately |
| P0.7 | Account refusal replaced in queue by destination; build/P0.7.md | Baseline | Second-account end-to-end proof incomplete | Retain isolation guards; inspect live destination attribution | Live proof |
| P0.8 | Official deadlines; build/P0.8.md | Baseline | Documentation proof, not live feature | Current vendor checks used for amended flows | None for docs |
| P1.1 | gateway/gateway.ts; zero gateway ratchet | C5 deployed 439d9e3d3 | Auth-hold safeguards deployed; no held/resumed production row observed | Observe a naturally held/resumed row;20:38Z preflight found zero holds | Observation |
| P1.2 | Gateway ratchet freshly passes all five channels at zero | Baseline | Not per-operation production proof | Keep ratchet and documented exemptions unchanged | None for local gate |
| P1.3 | outbound-rows.ts; zero external creators; destination column | C5 deployed 439d9e3d3 | Per-account production attribution not freshly proved | Both drains deployed; per-account recovery production observation remains | Observation/live proof |
| P1.4 | Connected Shopify GraphQL; build/P1.4.md | Baseline | Connected Shopify preserved; stock round-trip not established | Preserve existing store; no activation as part of this scope | Owner test store/live call |
| P1.5 | Shared eBay marketplace headers; build/P1.5.md | Baseline | Fixture coverage; no new live proof | Retain per-market header regressions | Deployment if changed |
| P1.6 | Approved groups removed; build/P1.6-delete-list.md | Baseline | Remaining live dependencies retained | Do not equate zero traffic with unneeded fallback | New deletions separately |
| P1.7 | Preview and ended-listing guards; build/P1.7.md | Baseline | Historical fixtures; partial flat-file cap amendment | Keep approved 200-row preview policy and guard mutations | Live proof |
| P1.8 | Baseline four checks; contract lane `a6b5fefaa` adds coverage/status fixes locally, reviewed | Baseline only; lane unmerged | Switch/account state not freshly verified | Integrate Package B; Phase 3 eBay notification reads and Amazon getListingsItem; approved test accounts/live proof | Package B/C + accounts/channel-call approval |
| P2.1 | C9–C11d7 local durable protocol, archive and rolling holds; package256 realPG/zero skips | C1 in published baseline; new protocol local only | New processing defaults OFF; no live signal proof | C11d6 local archive14 realPG/91 regressions and DB guards; C11d7 rollout9 realPG/5 mutations. Owner recovery API/UI is locally reviewed; operator maintenance is locally implemented through C11f6c; live delivery/recovery proof remains | Package A gate/rehearsal/deployment + separate activation |
| P2.2 | Amazon per-type subscriptions and parsing; build/P2.2.md | Baseline | New types gated; every type arrival not proven | Actual subscription inventory and per-type real arrivals | Live calls/subscriptions |
| P2.3 | eBay notifications.ts/routes/handlers independently audited | C3/C8 deployed 439d9e3d3 | Startup log proves automatic setup disabled; no new subscription provisioned | C3 transport/status fixed; C8 readiness/explicit activation hold (83 tests); revocation processor now locally wired; operational quarantine, account-token topic coverage and real delivery remain open | Implementation + approved catalogue/activation |
| P2.4 | Shopify reconciliation/lifecycle; build/P2.4.md | Baseline | Store connected; no fresh uninstall/privacy proof | Preserve connection and regression coverage | Any test uninstall/write |
| P2.5 | C2 routing deployed; Etsy receipts lane `cf032a270` implements normalization/holds/ingest/poll locally, re-review pending | C2 deployed 439d9e3d3; lane unmerged | Dated C2 checksum/Motovento routing/12-scope proof; ingest/poll remain OFF | Review/integrate Package B; register four actual events and prove freshness | S1/H1 settled; separate registration/activation/live-call approval |
| P2.6 | C11a–d5 local: current-grant and seller fences; atomic revocation/owner warnings; receiver/worker/manual wiring;25 domain/10 seller/17 processor realPG | Legacy baseline only | Production still has the old path; new processing remains undeployed/OFF | Operational quarantine readiness and real signal/reconnect proof | Implementation + approved deployment/activation/live event |
| P2.7 | AMS dedupe and subscription check; build/P2.7.md | Baseline | Every live profile hourly arrival not freshly proved | Per-profile dataset/read controls | Live read if needed |
| P2.8 | Ingress DS tab; C11d5 local stored-ID replay/readiness preflight and private lease omission | C1 in published baseline; new routes/UI local | U2 synthetic actual-Ingress browser proof; no new production UI observation | C11e1 API32 realPG/44 route regressions and C11e2 UI54 tests/6 mutations/browser proof are local; C11f5/f6b/f6c add operator inventory/verify/rewrap locally; provisioned access and production proof remain | Implementation + browser observation |
| P3.1 | Gateway error vocabulary; build/P3.1.md real/shape fixtures | Baseline | No new outgoing call measured | Preserve channel codes/messages and fixture distinctions | None local |
| P3.2 | ListingIssue recorders and suppression job; build/P3.2.md | Baseline | Suppression pull defaults off; one-minute live rejection proof missing | Verify switch, listing attribution and rejected-change timing | Production enablement/live call |
| P3.3 | Baseline partial; own listing-issues API and Diagnostics card remain | Baseline partial | No new UI production proof | Phase 3 API + DS card, real-browser 390/1280 light/dark/keyboard; hand studio pane to PES.3, do not edit _studio/ | Package C + UI proof |
| P3.4 | Channel owner Notification path; build/P3.4.md | C7 deployed 439d9e3d3 | Owner notification behavior proved locally56tests; no production failure induced | Observe owning-profile delivery/dedupe | Observation or approved controlled test |
| P3.5 | Success-response deprecation headers; build/P3.5.md | Baseline | Synthetic header proof; no real deprecation observed | Fixture is valid local acceptance; retain production observation distinction | Observation |
| P3.6 | Channel health/trace service; build/P3.6.md | Baseline | No-data is not green; positive operational SLO evidence incomplete | Read current per-operation counts, latency/backlog/DLQ targets | Production observation |
| P4.1 | Per-channel publish lanes; build/P4.1.md | Baseline | Per-operation live publication proof incomplete | Keep previews, account policy and Presence boundaries | Live publish approval |
| P4.2 | Image gateway/readback; build/P4.2.md | Baseline | Sweep historically on; positive-count proof required | Read current sweep counts/issues, preserve channels out of scope | Observation/live calls |
| P4.3 | Baseline stock guards; local order-writer and Etsy holds lanes await re-review/integration | Baseline only | S1 hold on paid/deduct on shipment and H1 from activation are decided; new ingest OFF | Integrate lanes together; stock concurrency/pool/hold/cancel proof; Phase 3 retry parity | Package B/C + separate activation |
| P4.4 | eBay price read-back lane `915b0b4fa` implemented locally, final re-review pending | Baseline partial; lane unmerged | No new vendor read proof; 00:40:32Z census:332IT listings/232followmaster, no non-IT exception | Rerun census before Package B; ask Owner if any non-IT listing then follows master price; Phase 3 variation confirmation/quantity offers lookup | Census + conditional currency approval + live read proof |
| P4.5 | Regional Ads discovery/disconnect/expiry; build/P4.5a-h.md | Baseline partial | No reconnect needed; Manual Collection wire value unresolved | Verify daily region repair and accepted SB contract | No reconnect; live probe only approved |
| P4.6 | Baseline writers; Etsy lane cf032a270 adds listing freshness stamps/read-error wording locally | Baseline partial; lane unmerged | Mode not freshly verified; zero stored listings is dated evidence | Re-review/integrate Package B; demonstrate supported writes | First write/mode approval |
| P5.1 | Orders 2026 adapter + quantity-4 live money proof; build/P5.1.md | Baseline | Enablement still gated | Set switch only approved; production quantities/totals/pagination verify | Production config approval |
| P5.2 | C4 containment deployed; lane 509d8af99 implements finance identity/single-writer/attribution locally, re-review pending | C4 deployed 439d9e3d3; lane unmerged | v0 retained; new-API writer held; 00:40:32Z census:zero duplicate groups,70finance rows/59orders lack account,39recentAmazonorders unattributed | Re-review/integrate Package B; Phase 4 corrected dry run, attribution backfill and boundary flip | Separate dry-run/backfill/cutover approval |
| P5.3 | One Shopify version accessor; build/P5.3.md | Baseline | 2026-07 historical traffic; preserve connected store | Quarterly version maintenance remains operational | None current scope |
| P5.4 | No buyer-PII/RDT path; build/P5.4.md | Baseline | Historical 4,464 order census; privacy ratchet | Keep data-minimization choice; no RDT invented | None |
| P5.5 | Search Returns not on official decommission list | Not required | Supported read retained | No speculative replacement | None |
| P6.1 | cx/amazon-secret-rotation.service.ts | C7 deployed 439d9e3d3 | Startup at 21:51Z proves rotation OFF: credential queue URL absent | Queue/portal/effective IAM setup, recovery serialization and end-to-end rotation proof | Queue registration + live rotation |
| P6.2 | Signing-key expiry parsing; build/P6.2b.md | Baseline | eBay expiry 2029-08-28 historical live proof | Fresh heartbeat/expiry read; no rotation needed now | Read/observation |
| P6.3 | Rotated Etsy token persistence; build/P6.3.md | Baseline | Connected Motovento heartbeat proves token path only | Retain persistence retry/race guards; inspect failures | Observation |
| P6.4 | Local revoke/channel removal hint; build/P6.4.md | Baseline | No destructive production revoke requested | Preserve honest per-channel outcomes | Any disconnect separately |
| P6.5 | Owned-only heartbeat; build/P6.5.md | Baseline | Guest-account write isolation fixture evidence | Real DB RLS coverage, owner/guest runtime evidence | Observation |
| P6.6 | Private authorization/import; env fallback instrumentation | Baseline | Only ~32-minute prior zero, not one full day | Observe full cron cycle; retire env fallback after evidence | Production switch approval |
| P6.7 | Post-Order auth documented; no extra scopes required | Resolved amendment | No reconnect required | Optional actual keyset portal confirmation | Portal read |
| P6.8 | OAuth callbacks/apps; actual Etsy and Shopify connections read | Baseline plus current release | Etsy Motovento + Shopify Xavia ownership/state/scopes preserved at 21:54Z | Verify callback URLs/webhook mode separately | Portal changes separately |
| P7a | Dependency census; channel-sync inert worker and producer remain | Partial | No deletion authorized by continuation | Justified code removal list; retain live Ads fallback | Explicit deletion boundary |
| P7b | Schema dependency inventory | Not started | Green week not elapsed/proven | Each table requires dependency retirement + green week + individual approval | One yes per drop |
| P8 | New channels | Deferred | Explicitly out of scope | Preserve connected Shopify; no new channel work | New scope decision |
| CX cleanup | 4abb1a371 guarded deletion; prior 59 tests/101 PostgreSQL gate | Deployed 439d9e3d3 | All18 connections preserved; exact-ten candidates untouched | Fresh exact-ID/dependent check immediately before any approved deletion | Exact-ten approval separately |

## Measurable quality obligations (no blanket AAA pass claimed)

| Dimension | Acceptance threshold | Current proof / unresolved evidence |
|---|---|---|
| Correctness | Exact money/currency/quantity semantics; zero duplicate financial effects; no quiet partial reads | C4 correct identifiers, rejects partial pagination, performs zero money writes. Monetary reconciliation/cutover still open. |
| Account isolation | Every write and inbound action names exactly one owner; foreign/missing/ambiguous identity causes zero effects | C2 five realPG routing cases; C11d3 admission24 and C11d4 seller10 realPG cases, stored processor17 and rollout9 cases. Quarantine operator access and transactional order/stock isolation remain. |
| Security | Invalid/missing verification executes zero handlers; credentials never in diagnostics; no auth bypass | C1 38 tests/two killed mutations; existing boolean-only credential report retained. C11f1 locally fences maintenance targets/owned scope and truthful failure state; C11f5/f6b/f6c operator inventory/verify/rewrap is local; actual cold recovery and live KMS/Neon proof remain. |
| Resilience | Failed work remains recoverable; sign-in/rate holds spend zero row retries; no premature SUCCESS | C3/C5 deployed guards; C9–C11d7 local durable claims/replay/warnings and archive races, including five rollout and six archive mutations. Production delivery/recovery observation remains. |
| Performance | Bounded traversal/work, account concurrency preserved; measure real latency/backlog against P3.6 targets | Notification reads max20 pages/collection, finances max50 pages, retry drain max200 rows. No production p95/positive-load claim yet. |
| Accessibility | Existing DS controls; 7:1 contrast gate; keyboard-only critical paths, responsive 390/1280 widths, light/dark; no serious/critical accessible-name/focus violations | U1 actual retention component uses shared DS Card/Field/Input/Button: key-by-key typing, validation, keyboard/focus,320–1440 widths and light/dark checked with synthetic local data; hint contrast5.32/7.38. U2/C11e2 browser evidence is local. Current exact-head AAA gate passes 106 pairs / zero below 7:1; full-app Diagnostics and remaining Phase 5 obligations remain open. Historical component contrast values are separate dated evidence. |
| Observability | Failed/rejected/unknown events remain visible; complete=true/healthy only with positive evidence; owning-profile alerts | C1 rejects remain in ledger; C3 failed cron persists FAILED; empty/partial compare explicit. C7 persists rotation owner alerts; production delivery still unobserved. |
| Maintainability | Named slice commits, independent review, typecheck, canonical ratchets, no new suppressions/skips/weakened hooks | Package A review APPROVE and exact-head hook exit0 at 77c787559: 33 database, 11883 API/359 existing skips, 4850 web/13 existing skips, both builds, 127 security, RBAC2727/0unmapped, 328realPG/25suites/zero skips; profiles961files/41known failing/217tests none worse. Recovery hook and source77/recoverya5 rehearsals pass; final docs/tools commit hook/rehearsals pending; see release log. |

P7's green week and each destructive-drop approval remain mandatory. The C1–C8 deployment and additive Etsy alias migration were verified on 2026-09-22. No
connection deletion, manual credential change, channel activation or P7 drop was performed.

Historical source77 finalization plan (superseded by the latest checkpoint): run the normal hook against
the final docs/tools commit and both rehearsals with `CX_RELEASE_SHA=<final-release-sha>`.
Source77 and recoverya5 are already gated/rehearsed locally. Publish the separately gated recovery
SHA from the clean final release checkout so its normal hook gates the final release HEAD; record
both SHAs explicitly. No refs are pushed yet. Automatic deploy eBay probes still need narrow Owner
approval before main push. See the release record for exact evidence and commands.
The operator inventory/cold-verify/rewrap
commands are implemented locally through C11f6c. Metadata visibility never establishes recovery
or key-retirement readiness; actual operator/KMS/recovery/activation proof remains separately gated.
