# Paste-ready prompt — 2026-09-25 (supersedes the older prompt kept below as history)

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


Resume and finish the Nexus channel-connections work ASAP, strictly following
docs/channel-connections/2026-09-25-STRUCTURED-PLAN.md, and push every reviewed, fully gated
package to `main`. When everything is done, run the plan's Phase 5 AAA quality and
zero-inconsistency audit and fix every mismatch.

Work only in the isolated worktree /private/tmp/nexus-channel-connections-20260922 (branch
fix/channel-connections-20260922) and its helper worktrees (/private/tmp/cx-release-20260923,
/private/tmp/cx-recovery-20260923, /private/tmp/cx-0a-20260923, /private/tmp/cx-lane-*).
/Users/awais/nexus-commerce belongs to another session: never edit, stash, stage from, run scripts
in or push its history. Always cd explicitly. Stage files by name; commit per slice; never bypass
hooks; never overlap Prisma generation/builds with tests sharing that client. Preserve the untracked
cx-production-*.mts files.

Start: git status in both trees; read the structured plan, RELEASE-C9-C11F6C.md,
build/CX-REMAINING.md (C11f6b, C11f6c, R1), COMPLETION-MATRIX.md "Latest state" and
build/tools/lane-rules.md; fetch origin/main and read public /api/health.

Approval scope (Owner, 2026-09-25): pushing each reviewed, gated, rehearsed package to main and
deploying it with every new switch OFF is approved. NOT approved without a separate explicit yes:
turning any switch on, live vendor/channel calls or probes, operator grants, KMS/rewrap/key
retirement, credential or env-var changes, deletions, prisma migrate resolve, Finances cutover, P7
drops. The Bash permission rule for docs/channel-connections/build/tools/prod-census.mjs (kept locally; not in the public repo) is already
saved; do not ask again. The credential-source blocker is resolved: both preserved readers already
reference /Users/awais/nexus-commerce/.env; the approved tool reads that existing file from the
isolated cwd without editing/copying it or executing scripts in the shared tree. Config review
APPROVE; census00:40:32Z shows332eBaylistings allIT,232followmaster, so no currency exception now.
Rerun before Package B ships; if any non-IT eBay listing then follows master price, ask me first.

Historical source77 checkpoint (superseded by the latest checkpoint above): Package A merged the newest fetched published main
(a22f2fc361488c3620d6c8110344e8200c46ebb2) at 77c787559d95dc394df358a9fea7b10179b6d5a0.
Whole-source review APPROVE; exact-head full hook PASSED exit0: 33 database, 4,850 web/13 existing
skips, 11,883 API/359 existing skips, both builds, 127 security, RBAC2727/0unmapped,
328realPG/25suites/zero skips NOSUPERUSER; profiles961files/41known failures217tests none worse;
AAA106pairs/zero below7:1. Logs are in RELEASE-C9-C11F6C.md. recovery/cx-20260925 at a5efa0dd9
has exact database parity, source APPROVE and full hook PASS: 33 DB; 11,792 API/340 existing skips;
4,850 web/13; both builds;127 security;RBAC2727/0;309realPG/23suites/zero skips;
profiles955files/41known217tests none worse. HTTP rehearsal passed00:12:13Z, jobs00:15:11Z on
2026-09-25, source77/recoverya5: PG17.11/NOSUPERUSER,471→479exact8CX,a22 refuses exactly8,
recovery-release-recovery200expectedbuilds,fullhistory/checksums/roles/objects unchanged;
each jobs boot alive45s,initialized once,ebayProcessingEnabledfalse. No package/ref is pushed/deployed.
Tools44604ff9d source/tool/docs reviews APPROVE; expanded29/29synthetic tests and39/39assertion-killed
mutations pass (13original+26additional),zero unresolved survivors. An initial refusal-count survivor
was killed after a precise wrong-count regression; evidence retained. Runtime guards restored
byte-for-byte to44604ff9d. Final docs/tools commit hook and both
exact-build rehearsals remain pending; application/database/hook/workflow trees still match source77. Public health was healthy200,
build a22f2fc3, at 2026-09-24T23:49:30.532Z, with existing five quantity mismatches/critical Ads
alerts. Railway CLI read fallback confirms base deployment 674bf97f-fd44-438d-b662-7348a810ccba
SUCCESS at the same GitHub SHA; remote main rechecked unchanged at2026-09-25 00:15Z. Read current RELEASE-C9-C11F6C.md
commands; old recovery branches are history only.
All five lane branches remain local/unmerged; contract a6b5fefaa is approved, while price 915b0b4fa,
finances 509d8af99, order-writer 9e4380c12 and Etsy cf032a270 need independent re-review.

Current final sequence: source3be and recovery34 are fully gated/rehearsed and code-reviewed.
Finish metadata signoff, keep the final release checkout clean, and retain the normal push hook.
Publish explicit recovery34 from that checkout; record tested HEAD and pushed ref separately.
Basebc39 is serving; metadata-head rehearsal uses explicit basebc39/release-final/recovery34
full SHAs. Defaults pin old heads. Refresh switch evidence and recheck remote main2459bf52f.
The CI consent-probe exception remains pending; do not treat general “ASAP” as that separate yes.
See RELEASE-C9-C11F6C.md for executable commands and current evidence.

Separate narrow scope confirmation is needed before main push: existing deploy-api.yml calls
apps/api/scripts/check-ebay-consent-scopes.mts, which GETs auth.ebay.com consent pages for
base/fake/full scopes without sign-in, token exchange or writes. This automatic live vendor probe
is excluded from the deployment approval. Finish exact package preparation first, then ask me once
for this probe scope; do not skip or weaken the existing workflow and do not re-ask for deployment.

Order: Phase 1 Package A (merge newest published main, gate, new recovery from 38c99a7af + main +
the release database tree, rehearse against the serving build, push, verify production) → Phase 2
Package B (re-review, census, integrate the five lanes in the plan's order, gate, recovery,
rehearse, push, verify) → Phase 3 Package C (remaining engineering) → Phase 4 prepare exact
activation actions for my approval → Phase 5 audit.

Quality: red first; real PostgreSQL for locks/races/RLS; applied-and-restored guard mutations killed
by assertions; independent review APPROVE per slice plus a final whole-package review; design
system + real-browser checks for UI; never weaken assertions, timeouts, ratchets or hooks; keep the
matrix/handover current and distinguish implemented, deployed, enabled and production-verified. Etsy
decisions: S1 hold on paid / deduct on shipment, H1 from activation. Post a one-line note per
sub-agent report and keep going unless I say slow down. Report to me in plain, short sentences.

---

## Previous prompt (history)

Continue the remaining Nexus channel-connections work. Scope: Amazon, eBay and Etsy. Preserve connected Shopify. P8/new channels remain deferred. Implement and prove the remaining requirements; do not restart another planning-only exercise or trust historical “all built” labels.

1. Start with git status in both worktrees:
   - Work only in /private/tmp/nexus-channel-connections-20260922, branch fix/channel-connections-20260922.
   - /Users/awais/nexus-commerce belongs to another session on pes/phase-0. Never push its history, stash its changes, use git add -A, or bypass hooks.
   - Preserve the two original untracked cx-production-*.mts scripts; do not blindly stage or execute them.
   - Stage files by name, commit per slice and push once per reviewed, approved package. Inspect actual history and remote main before integrating.

2. Current continuation state (verify actual git status/history before editing):
   - 2026-09-24: C11f6b (a333c131f) and C11f6c (4f3c10d4f) are committed and reviewed; the
     release package is d72abc2fd (+docs), gated in a clean worktree and rehearsed with recovery
     fdd368e0c (recovery/cx-20260923). Read RELEASE-C9-C11F6C.md first. Five lane branches
     (fix/cx-ebay-order-writer, fix/cx-amazon-finances, fix/cx-ebay-price-readback,
     fix/cx-contract-coverage, fix/cx-etsy-receipts) hold later work; each needs its review
     fixes, integration, a new gate and a new recovery artifact before any push. Etsy answers:
     S1 hold-on-paid/deduct-on-ship, H1 from activation. Production reads were blocked by the
     session permission classifier; ask the Owner before retrying.
   - C11f4 is16a6e7e48; C11f5 is38c99a7af. C11f6a is reviewed/tested;
     inspect its commit. Nothing from C9 onward has been pushed/deployed/activated.
   - C9–C11d7 implement receipt identity/leases, grant versions/current-refresh checks,
     transactional revocation/warnings, private encrypted admission, seller fences,
     stored-ID execution, archive-never-delete and safe mixed-version holds. Admission
     and adoption remain unscheduled. Retire old APIs/workers and in-flight sweeps
     before activation; afterwards only protocol-aware recovery builds are allowed.
   - U1/U2 correct shared retention controls and queued/completed replay feedback/focus.
     C11e1/e2 add owner-only quarantine recovery APIs/UI and parent profile-read fencing.
     Actual-component/parent browser evidence and independent reviews are retained.
   - C11f1 owns credential maintenance scope and reports refusal/partial failure.
     C11f2(396469275) pins/cold-verifies lossless encryption and fixes DEK-buffer races.
     C11f3(e67d8c85e) validates quarantine binding/digest/key metadata independently of
     adoptability; verified unsupported/malformed bodies remain recoverable.
   - C11f4(16a6e7e48) adds restricted global maintenance authority, two-column CAS and
     mandatory append-only audit. Full normal hook passes11569API/322skips,4640web/13,
     bothbuilds,127security,2727routes/0unmapped,291realPG/22files/zero skips. Profiles-ON
     measures927files:41known failing/217tests,none new/worse. Canonical realPG now
     defaults to production-equivalent NOSUPERUSER ownership; keep that stronger gate.
   - C11f5 adds restricted global metadata inventory/CLI with a dedicated connection,
     read-only repeatable-read snapshots and honest bounded completeness.63regressions,
     65targeted realPG,9mutations,API build/typecheck and11594fullAPI/329skips pass.
     First fullAPI failed because the agent overlapped Prisma generation and tests;
     sequential repeat passed. Never overlap generation/build with tests sharing that
     client. Canonical runner now expects298realPG/22files; full canonical F5 repeat
     has not yet been run. Metadata census never certifies recovery/key retirement.
   - C11f6a adds cooperative signal propagation through every crypto stage and static
     cancellation/errors without provider-message leakage.125focused,11608fullAPI/329,
     45realPG/zero skips,8mutations,typecheck/APIbuild pass; independent review approved.
     Real SDK cancellation uses loopback-only endpoints/synthetic credentials. SDK
     backoff is not a hard deadline; close DB snapshots/locks before KMS and reconcile
     any uncertain write. Operator coldverify/rewrap entry point is still unimplemented.
   - Published main was integrated locally through reviewed I1/I2; only published
     0a563d6d5700a9aded3a53cf64c9fcf543facb04, never the shared tree's unpublished history.
     Fresh public18:08Z observation remains0a563d6d/healthy200. Private read-only18:14Z
     confirms PG17.11, owner NOSUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE, no PUBLIC schema
     CREATE, maintenance roles absent and no20260923 migrations applied. It does not
     reverify flags, credentials, businesses or vendor state. Existing five quantity
     mismatches/critical Ads integrity remain dated16:27Z observations.
   - Release prerequisite: old0a refuses startup after new migrations because of its
     applied-but-missing gate. Build/review/rehearse an exact protocol-aware recovery
     artifact with complete applied history. Unmodifiedc65 restores known safety
     defects; nearere67 application plus final database tree is the preferred candidate,
     not yet an artifact or proof. Carry F4's restricted-owner runner/26-case maintenance
     test and admission fixture policy reinstall for normal-hook coverage; F5's33-case
     test imports its new inventory service/CLI and must not be copied alone. Use a
     separate Git root (a plain nested fixture's hook would test the parent tree).
   - Next: finish the operator cold-verify/rewrap entry point and safe traversal,
     then build/rehearse the migration-complete recovery artifact before deployment
     approval. Prepare exact action/package; no operator grant, KMS use, rewrap,
     key retirement, live channel probe or activation is implied by deployment.
   - Read build/CX-REMAINING.md for failures, amendments, exact evidence and completed
     slice details, and QUARANTINE-MAINTENANCE.md for operator boundaries. Keep future
     deployment/activation proofs separate. Privacy GET can CREATE its90-day policy,
     so it is not an authorized read-only production inspection endpoint.

   Prior approved439d9e3d release is DEPLOYED AND VERIFIED historical evidence, not pending approval:
   - Main/code release: 439d9e3d34ed79a09d76981da08de5d2ca0190e2.
   - Final Railway deployment: 0f89aa53-ce89-4518-91b6-76a5c2d68507, SUCCESS.
   - At 2026-09-22 21:58 UTC, /api/health and /api/health/ready returned 200 and build439d9e3d. Protected diagnostic GET returned401.
   - GitHub CI35788316974 and Deploy API35788316766, including its smoke test, are SUCCESS.
   - The Owner explicitly instructed “Deploy it all and push to production.” This covered C1–C8 and necessary release repairs. Do not ask for that approval again or redeploy unchanged code.
   - Local evidence commit542f881db follows the release. New unshipped implementation is tracked in build/CX-REMAINING.md: C9 atomic receipt identity29de2d2ce and C10 durable claims29148190f are tested/reviewed/committed. C11a grant versions plus credential-maintenance fencing is tested and independently reviewed locally (18 realPG,118 regressions,5 killed mutations); inspect current status/history and its record. C11b adds reviewed current-refresh-grant inspection (42 focused tests,10 realPG grant cases); no production caller. C11c adds reviewed atomic revocation/audit/inbox/receipt completion (16 realPG,121 regressions,5 killed mutations); old inline receiver/legacy lifecycle wrapper remains until C11d wiring. C11d1 adds reviewed DB-clock scheduling/fenced manual replay resets (7 realPG,33 regressions,4 killed mutations). Do not deploy reset independently from the pending stored-payload execution wiring. C11d2 adds reviewed atomic unresolved warnings (domain suite25realPG,121regressions,4killed mutations); dispatcher mustprovide callbacks onclaim+finish. C11d3 adds private admission/quarantine and original-profile delivery binding; reviewed locally with24 admission realPG cases,86 regressions,6 killed mutations and the206-case canonical realPG gate passing; original cleanup failure retained. C11d4 adds the shared seller fence for grants on different connection rows; reviewed with10 new realPG/190 regressions/5 killed mutations and216 canonical realPG passing (zero skips); retained cleanup failure details in CX-REMAINING. Check current commit/status before continuing receiver wiring. Quarantine maintenance/recovery remains an explicit activation prerequisite. No new receiver activation follows from these foundations.
   - Evidence: docs/channel-connections/build/RELEASE-2026-09-22-EVIDENCE.json (kept locally; not in the public repo). Current origin: https://nexusapi-production-b7bb.up.railway.app. api.xavia.it was not serving.

3. Read PROGRESS.md §0, 2026-09-22-HANDOVER.md, COMPLETION-MATRIX.md, FINAL-PLAN.md and build/CX-COMPLETION.md. Then the relevant original build records. All paths are under docs/channel-connections in the isolated worktree. The matrix distinguishes implementation, deployment, enablement and production proof. Keep it current.

4. Do not reconnect or relocate Etsy:
   - ItalianHideCraft, shop57783036, belongs to Motovento workspacebf0047bf-e1d9-48d0-8cc6-20e94bb734dd, connectioncmubtwtad00ctmu01w4qsruxt.
   - Its externalAccountId1051233836 is a USER identifier, not the shop identifier.
   - Production migration20260922a_cx_etsy_shop_alias finished with its exact committed checksum. The shop alias resolves exclusively to Motovento; this is production-proven.
   - All18 pre-existing connections retain compared owner/state/scopes/key-ID/credential-presence fields; non-Etsy aliases are unchanged. Xavia Shopify remains connected (93 stored scopes); Etsy retains12 scopes.
   - Credential presence is not proof of unchanged credential contents or validity. Never decrypt/expose credentials for diagnostics.
   - Earlier signed-in Etsy portal inspection showed zero endpoints and four actual events: order.paid, order.canceled, order.shipped, order.delivered. The census showed zero local listings/events and37 successful account-attributed calls in24h. These are dated observations; publishing mode and signing-secret configuration still lack proof. Browser access later became unavailable; do not infer absence from that.

5. Completed safety slices—do not rebuild them:
   - C1 rejects unverified manual/worker replay.
   - C2 uses the official Etsy event/resource URL contract, binds receipt reads to the account/shop and adds the verified shop alias.
   - C3 repairs eBay payload selection, bounded pagination, destination/subscription contracts and truthful reconciliation status.
   - C4 corrects Amazon ORDER_ID/provider transaction identity and account/window traversal; comparison measures identity/order overlap only. Unsafe Finances2024 writes are held; v0 remains operational.
   - C5 preserves auth-hold retry budgets and the original Shopify dispatch mapping.
   - C6 fixes Amazon test fixtures and Vitest console-RPC transport while retaining real unhandled-error failure.
   - C7 adds private rotation-failure owner notifications and conservative static queue-policy checks.
   - C8 honestly holds every currently incomplete eBay topic before any setup call and requires exact NEXUS_ENABLE_EBAY_NOTIFICATION_SETUP=1 for scheduling. Startup proves setup OFF. Rotation startup proves OFF because no credential queue is configured.
   - Release repairs: compiler-only4GiB old-space limit; CPU-aware file workers, capped1–4. Runtime, tests, assertions, timeouts and hooks were not weakened. Local18CPUs→4workers; actual CI2CPUs→1worker.

6. Remaining engineering is substantial and still authorized locally:
   - eBay: C9/C10 implement the local durable receipt/claim foundation; integration remains. C11d3–d5 now implement scoped stored-receipt dispatch/replay, preserved ownership, bounded revocation and same-/cross-record newer-grant fences locally. Do not rebuild these. Finish the quarantine operator recovery surface, key maintenance and archive support before activation. Use current-refresh-token introspection fenced by grantVersion; access-token validity or local save-time comparisons do not resolve a delayed revocation. Keep introspection outside receipt/account locks; the implemented dispatcher re-evaluates if the grant changes. Scheduling and eBay selection now use database time; the new processing flag remains OFF until approved activation. Current order ingestion inserts lines before stock and swallows stock failures; merely awaiting it is unsafe. Build one transactional writer shared by polling and webhook replay. Parse notification.data.order.orderId. Never sweep every account for one replay. Erasure remains unimplemented; preserve authoritative buyer identifiers and settle fiscal-retention policy before destructive anonymization. Keep handlerMissing until actual behavior is proved.
   - Etsy: transactional receipt normalization/ingestion/polling is still missing; the current receiver reads a receipt then logs the missing ingester. Use exact money/divisors, validated quantities, stable line identities, monotonic state, account/shop checks and atomic stock effects. Owner questions about reserve/consume timing and historical opening boundary remain unanswered. Finish freshness accounting and supported publishing proof before activation.
   - Finances: approved overlap measurement, exact monetary mapping, durable identity uniqueness, historical null account attribution, legacy/new race proof and safe cutover remain. Never double-write production money to compare.
   - Contract coverage is partial, eBay price readback is missing, the studio error pane remains unfinished, and Orders/secret/KMS/security/portal/environment-token operational items still need their individual proof and approvals. Respect other programmes’ ownership.

7. Approval boundaries still apply to remaining actions:
   - Local investigation, implementation, tests, independent review and justified reversible amendments are authorized.
   - Separate vendor probes, live channel activation/writes, exact-ten deletion, future deployment packages and each P7 drop need their existing approvals. The completed release approval is not blanket approval for these.
   - scripts/channel-connections-read-probe.mts describes two reviewed reads; neither was executed. Amazon: Xavia accountcmothu9bo0000nz01asw6wx8j, IT/APJ6JRA9NG5V4, Sep20 00:00Z–Sep21 00:00Z, dryRun only; four legacy rows lack account attribution. eBay: application topics/destinations/subscriptions; USER subscriptions remain separate. Execution needs approval including ordinary OAuth/gateway bookkeeping.
   - Exact-ten deletion list is build/CX-DELETE-LIST.md. Preserve cmr4aaqb00025nz016k18rup9, cmt0ksbbs01r4mo01c9diw1qp and cmt142bli01vcp4010fjo2k13. Shared eligibility, encrypted-presence checks, locked fresh dependent counts and isSafeToDelete must remain. Never clear credentials or detach dependents to pass guards.
   - The13/12 eBay discrepancy is explained by the retained transferred Motovento tombstone and the Accounts query. Browser count was not freshly re-measured.
   - Each P7 drop needs a green week after dependency retirement and its own approval. P8 is deferred. Do not reconnect Amazon Ads/eBay because an old note asks for it.
   - Prepare concrete reviewed actions before asking, and continue independent authorized work while waiting.

8. Verification discipline:
   - Full API on C1–C8:11215 passed,137 existing skips,zero failures/unhandled errors. Canonical gates on every push passed both builds,4591web,124security,106realPostgreSQL/zero skips,RBAC2724/zero unmapped. Profiles-ON ratchet:41 known failing files/217tests,none new/worse—not an all-green profiles-mode suite.
   - Final actual CI:1904 API regressions/4 existing skips and3093web regressions, all passing. Retain the earlier failed runs and documented repairs; do not relabel them green.
   - Reproduce defects, retain positive/negative controls, use real PostgreSQL for RLS/locks/races, apply-and-restore critical guard mutations, and obtain independent review. Never weaken assertions, timeouts, ratchets, tests or hooks.
   - Tests/migrations stay local. Run API tests from apps/api, print the target host and honor database guards. Shared-root .env is production. Authorized production inspection uses pinned targets and read-only transactions; no credential disclosure.
   - pg’s default parser previously subtracted two hours from UTC timestamp-without-time-zone columns. The probe now parses UTC explicitly and checks the database clock. Old counts/identities were unaffected; do not infer a scheduler outage from those old serialized timestamps.
   - Existing Ads integrity alerts and five quantity mismatches remain. No zero-error, full SLO, credential-validity or channel end-to-end claim follows from public health. Runtime log samples are bounded, not a complete error census.
   - For UI changes read DESIGN.md/AGENTS.md, use the shared design system, mirror required factory changes, and verify keyboard/responsive/light-dark behavior in a real browser.

9. Finish each next package with specific evidence, a current matrix/handover and precise remaining approval/observation dependencies. After an approved future deployment, verify Railway SUCCESS, exact serving build, protected routes and the affected business profiles before calling it deployed. Do not claim the whole plan complete or “best in industry” without proof.
