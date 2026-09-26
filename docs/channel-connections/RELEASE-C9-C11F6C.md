# Release package — C9 through C11f6c (eBay inbound protocol and quarantine operations)

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
bootstrap→release adds exactly eight CX migrations to the base history; old base refuses;
recovery34→release3be→recovery34 each returns ready200 with its exact build, unchanged
migration history/checksums and role/object invariants. Jobs initialized with processing
held. Current rehearsal folders contain these heads; earlier4e/77 proof is archived.
Both code/recovery reviews APPROVE. A first PCO-fixture gate failure and the source-equivalent
pre-checkout pass are preserved but are not substituted for the clean3be gate.

Latest private read-only census: **08:54:05Z**, `production-census-20260925-085405.json` (kept locally; not in the public repo):
zero unresolved migration failures (historical rolled-back rows only); every eBay listing is
on the IT market (some follow the master price); the active eBay sellers have default
warehouses; no v0 finance duplicates; some finance rows/orders and recent Amazon orders are
unattributed (measured; figures kept in the local evidence); exact Etsy shop57783036 active Motovento route; the Shopify connection is active.
No non-IT master-price exception is triggered by this snapshot. Refresh before Package B
shipping. Last private switch evidence remains01:00:45Z: all six new switches unset/OFF,
with positive DB-source match. Refresh before publication; no newer switch verification is
claimed. Public health at06:54:44Z reported quantity mismatches and existing critical Ads
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


## Historical source4e gate and early census evidence — 2026-09-25

Release source `4e9302e43` passing hook log:
`/private/tmp/cx-release-20260923/package-a-gate-4e9302e43-r2.log`;
sublogs in `/private/tmp/cx-release-20260923/docs/channel-connections/build/evidence/package-a-4e9302e43/`.
The first attempt failed with stale shared declarations, which were rebuilt before the green rerun.
Its failure remains in `package-a-gate-4e9302e43.log` and
`/private/tmp/cx-release-20260923/docs/channel-connections/build/evidence/package-a-4e9302e43-stale-shared/`.
No assertion, timeout, ratchet or hook was weakened.

Recovery `f9a577ac8` API build passes; full hook failed in the PGlite stock-pool-rules suite.
The first connection closed, followed by 17 cascading failures. Root cause remains unproven. This first failed attempt is retained alongside the later unchanged passing rerun. Log:
`/private/tmp/cx-recovery-20260923/package-a-recovery-gate-f9a577ac8.log`; preserved sublogs:
`/private/tmp/cx-recovery-20260923/docs/channel-connections/build/evidence/recovery-f9a577ac8-socket-failure/`.
The unchanged full recovery rerun subsequently passed in `package-a-recovery-gate-f9a577ac8-r2.log`; HTTP/jobs rehearsals passed at01:05:28Z/01:09:17Z. At that historical checkpoint, the new final-head gates and rehearsals were still required; the current3be/34 proof is recorded above.

Read-only aggregate census ran at 00:37:30Z and 00:40:32Z. Primary corrected evidence:
`docs/channel-connections/build/evidence/production-census-20260925-004032.json` (kept locally; not in the public repo) in the isolated
worktree. The first metric counted historical rolled-back rows as unfinished; the corrected query
separates them. No production write, vendor call, credential or environment change occurred.

| Aggregate | Corrected 00:40:32Z result |
|---|---|
| Migration history | Zero unresolved; historical rolled-back rows only |
| eBay listing market / master price | All IT; some follow the master price, some do not (figures kept in the local evidence) |
| Pending eBay prices | Zero |
| Active eBay connections | All have seller IDs and resolvable default warehouses |
| Recent eBay orders / seven-day notices | Zero / zero |
| Finance duplicate groups | Zero |
| Missing finance account attribution | Present (figures kept in the local evidence) |
| Recent Amazon orders without attribution | Present (figures kept in the local evidence) |
| Active Etsy connections | Present; no new shop-route or Shopify ownership proof from this census |

The non-IT master-price exception is not triggered by this snapshot. Rerun the census before
Package B shipping. The subsequent01:01:54Z census verified the exact active Etsy shop57783036→Motovento route and the connected Shopify; see the latest checkpoint and production-census-20260925-010154.json (kept locally; not in the public repo).

**Historical source checkpoint: source `77c787559` and recovery `a5efa0dd9` are independently reviewed, fully gated and
locally rehearsed. Final docs/tools commit hook and exact-build rehearsals remain pending. No package
or recovery ref is pushed; nothing new is deployed. The Owner approved gated/rehearsed deployment
with new switches OFF on 2026-09-25; the automatic eBay consent-page probes still need separate
narrow scope confirmation before main push.** Follow
[the structured plan](2026-09-25-STRUCTURED-PLAN.md).

| Item | Value |
|---|---|
| Base (published main, serving) | `a22f2fc361488c3620d6c8110344e8200c46ebb2` — public health HTTP 200/healthy/`a22f2fc3` at 2026-09-24T23:49:30.532Z |
| Release code | `77c787559d95dc394df358a9fea7b10179b6d5a0` on `fix/channel-connections-20260922`, clean merge of the published base; docs/tools commits follow, with application/database/hook/workflow trees unchanged |
| Recovery artifact | `a5efa0dd9` on `recovery/cx-20260925`: `38c99a7af` + the same published main + release database tree + prescribed maintenance/concurrent-database test files; database tree is byte-identical |
| New migrations at startup | Rehearsed: exactly `20260923a..h_cx_*` added, all additive; base includes main's later-named `20260924a_a53`. Production migration proof remains pending |
| Current proof | Source/recovery/tool/docs reviews APPROVE; source and recovery full hooks exit 0; HTTP/jobs rehearsals pass for source77/recoverya5. Final docs/tools commit hook and exact-build rehearsals pending |

The public health response still reports quantity mismatches and critical Ads integrity alerts.
It does not refresh private runtime, switch, migration or business-state evidence.
A 2026-09-25 Railway CLI read (fallback because MCP is unavailable) confirms deployment
`674bf97f-fd44-438d-b662-7348a810ccba` SUCCESS at GitHub SHA
`a22f2fc361488c3620d6c8110344e8200c46ebb2`; remote main was rechecked unchanged at 2026-09-25 00:15Z.
This confirms the base deployment only.

## What changes in production when this deploys

1. **Eight additive migrations** run from the existing start command (`migrate-direct` → `prisma migrate deploy`):
   inbound receipt leases and archive columns plus database deletion guards; eBay grant versions;
   the private `EbayNoticeQuarantine` table with RLS and system-only lookup functions; bootstrap
   account-integrity functions; three **NOLOGIN** roles (`nexus_ebay_quarantine_writer`,
   `…_maintenance`, `…_custodian`), an append-only maintenance audit table and restricted
   definer functions (all pinned `search_path=pg_catalog, pg_temp`). Production's owner has the
   CREATEROLE/BYPASSRLS/NOSUPERUSER rights these were tested with (read-only check 2026-09-23 18:14Z).
   No operator login is granted anything.
2. **eBay notification receiver:** acknowledges only after durable storage. Verified notices whose
   owner or topic cannot be resolved (including MARKETPLACE_ACCOUNT_DELETION, whose handler is still
   missing) are stored **encrypted** in the quarantine and retained; storage/encryption failure answers
   503 so eBay redelivers; bad signatures answer 412 and keep metadata only. The challenge GET is unchanged.
3. **Stored eBay processing must stay held:** keep `NEXUS_ENABLE_EBAY_INBOUND_PROCESSING` other than `1`, so no
   token introspection or lifecycle writes run. A revocation notice is stored, not acted on, until
   activation (production measured zero eBay Notification API subscriptions on 2026-09-22).
4. **Manual replay** runs only the stored receipt, fenced by readiness; it never sweeps accounts.
5. **Automatic logical archival** of eligible completed inbound receipts (never deletion), with the
   retention controls in Channels settings.
6. **Owner-only quarantine recovery** API/UI and Ingress replay feedback (U1/U2, C11e1/e2).
7. **eBay reconnect** writes grant versions and applies the seller fence across connection rows.
8. **Credential maintenance** refuses changed/fallback targets, stays within owned credentials, uses
   pinned cold lossless crypto and reports partial failure; crypto failures are logged by static
   class only (no provider text).
9. Operator commands `cx-quarantine-inventory`, `cx-quarantine-verify`, `cx-quarantine-rewrap`
   ship in the build but need a separately approved operator login; nothing runs them.

**Still needs separate approval:** operator grants, KMS use, rewrap, key retirement,
enabling eBay processing or topic setup, vendor probes (including the automatic consent-page gate
below), the exact-ten deletion, Finances cutover, Etsy ingest activation and any P7 drop.
The eBay order writer, Amazon Finances, eBay price read-back, contract coverage and Etsy receipts
lanes belong to Package B; its reviewed/gated/rehearsed deployment with new switches OFF is already
approved, subject to the plan's census and conditional currency decision.

**Known watch item:** eBay may send account-deletion notices for many users. Each is now stored
encrypted and retained. Measure quarantine growth daily after deploy (read-only inventory counts).

## Coordination with the inbound-claims work (#4, merged first)

#4 (`889f01893`) landed before Package A, so Package A adapted (merge of `578c3756c`). One owner per row type:
verified eBay receipts (`ebay_ecdsa`) are leased only by `ebay-claims.ts`; every other trusted row is claimed only by
`claims.ts`; other eBay rows are dead-lettered by the sweep while no lease is held. Proof:
`inbound-ownership-postgres` (13 real-PG tests, restricted runtime login; 11 guard removals each fail by assertion).
- **Schema:** both column sets, lease columns first (the order a fresh database applies them); `baseline.sql`
  regenerated byte-identical. Production applies `20260923a..h` after `20260925c/d`; the migration upgrade check
  confirms the result equals a fresh bootstrap (policies, RLS flags and runtime grants identical).
- **Generic claimant:** `claimInbound` refuses any eBay row (early return and in its conditional update, plus
  `leaseToken IS NULL`); `finishInboundClaim` cannot finish a token planted on an eBay row.
- **eBay lease:** `claimEbayInbound` and the held-receipt filter require `processingToken IS NULL`.
- **Scheduling:** #4's due-at-once rule excludes eBay; admitted eBay receipts stay unscheduled while processing is
  held. The retry sweep selects generic rows with `excludeVerifiedEbay` and runs verified eBay only via its processor.
- **Writers:** `completeInbound`, `deadLetterInbound` and `replayInbound` keep both guards (`channel <> 'EBAY'` or
  the eBay path, and `processingToken IS NULL`). Manual replay sends eBay to its processor before the generic claim.
- **Retention:** `WebhookEvent` is archived, never deleted; archive eligibility also requires no processing claim.
  #4's `deleteMany` of webhook rows is removed (the DELETE trigger would refuse it). Rejected and stranded rows are
  therefore retained, not expired: a growth follow-up for the Owner, not a deletion.
- **Receipt identity:** Package A's rule is kept: a delivery ID bound to another account or trust verdict is refused
  (`identity_mismatch`), where #4 counted it as a redelivery. Review point: a reconnected Shopify shop's retries.
- **Processes:** eBay processing runs inside inbound-retry in the **worker**; archival runs in the retention sweep in
  the **scheduler**; the receiver and sealing run in the **API**. Set `NEXUS_ENABLE_EBAY_INBOUND_PROCESSING`
  identically on all three services (unset/`0` now). Package A's suites pass under the restricted runtime login.

## Historical source77/recoverya5 gate evidence — 2026-09-25

Normal full hook on exact release `77c787559d95dc394df358a9fea7b10179b6d5a0` **passed, exit 0**.
Log: `/private/tmp/cx-release-20260923/package-a-gate-77c787559.log`.
Archived sublogs: `/private/tmp/cx-release-20260923/docs/channel-connections/build/evidence/package-a-77c787559/`.

| Gate | Result |
|---|---|
| Database | Four static database gates; 33 database tests pass |
| Web | 4,850 passed / 13 existing skips |
| API | 11,883 passed / 359 existing skips |
| Builds | Both pass |
| Security / RBAC | 127 security tests; 2,727 routes / zero unmapped |
| Real PostgreSQL | 328 tests in 25 suites / zero skips, NOSUPERUSER owner |
| Profiles-ON ratchet | 961 files; 41 known failing files / 217 tests; none new or worse |
| AAA contrast gate | 106 pairs; zero below 7:1 |

Recovery `a5efa0dd9`: independent source review APPROVE and exact database parity pass;
normal full hook **passed, exit 0**. Log:
`/private/tmp/cx-recovery-20260923/package-a-recovery-gate-a5efa0dd9.log`.
Sublogs: `/private/tmp/cx-recovery-20260923/docs/channel-connections/build/evidence/recovery-a5efa0dd9/`.

| Recovery gate | Result |
|---|---|
| Database | 33 tests pass |
| API / web | 11,792 API / 340 existing skips; 4,850 web / 13 existing skips |
| Builds / security / RBAC | Both builds; 127 security; 2,727 routes / zero unmapped |
| Real PostgreSQL | 309 tests / 23 suites / zero skips, NOSUPERUSER owner |
| Profiles-ON ratchet | 955 files; 41 known failing files / 217 tests; none new or worse |

Rehearsal guard fix `44604ff9d` independently APPROVED. Expanded proof passes **29/29 synthetic
tests and 39/39 assertion-killed mutations** (13 original + 26 additional), with zero unresolved
survivors. A refusal-count mutation initially survived; a precise wrong-count regression was added
and the rerun killed it. The initial survivor evidence is retained. Runtime guard scripts are
restored byte-for-byte unchanged from `44604ff9d`; the extra coverage lives in
`rehearsal-shell.test.mjs` and `rehearsal-verifier-boundaries.test.mjs`.
Evidence: `/private/tmp/cx-release-20260923/docs/channel-connections/build/evidence/rehearsal-guards-20260925/`,
including `expanded-green-restored.log` and `expanded-mutations-final.json`.
The source, tools and committed docs have independent APPROVE reviews. Later docs/tools commits
preserve source77 application/database/hook/workflow trees; the final commit's normal hook and
exact-build rehearsals remain pending. A green contrast gate is one Phase 5 obligation, not a
blanket AAA or production-proof claim.

## Historical source77/recoverya5 rehearsal — 2026-09-25

**HTTP PASS at 00:12:13Z; jobs PASS at 00:15:11Z**, source `77c787559` / recovery `a5efa0dd9`.
Throwaway PostgreSQL 17.11 with a NOSUPERUSER owner; no production data or real vendor credentials.
Evidence under `/private/tmp/cx-release-20260923/docs/channel-connections/build/evidence/`:
`rehearsal-20260925-source-77c787559/` and `rehearsal-jobs-20260925-source-77c787559/`.

1. Serving-base `a22` bootstrap history is complete. Source77 applies exactly the eight
   `20260923a..h_cx_*` migrations on top of it; no unfinished migrations.
2. Negative control: `a22` refuses exactly those eight applied-but-missing migrations.
3. Recovery → release → recovery each returns HTTP 200 with its expected exact build.
4. Full migration history/checksums remain identical; maintenance roles, role attributes,
   required objects and pinned definer search paths pass throughout.
5. Each jobs-on boot survives 45 seconds, initializes once, and reports
   `ebayProcessingEnabled:false`; processing stays held.

These archived directories preserve the source77 proof while final runs reuse the default
`rehearsal-20260925/` and `rehearsal-jobs-20260925/` paths.
These are dated runtime proofs for source77 and recoverya5. The final release commit includes
later docs/tools and must pass its own hook and both rehearsals. For each final run explicitly set
`CX_RELEASE_SHA=<final-release-sha>`; the scripts intentionally default to source77.


## Separate approval scope: automatic eBay consent-page probes

The existing `.github/workflows/deploy-api.yml` invokes
`apps/api/scripts/check-ebay-consent-scopes.mts`. It GETs `auth.ebay.com` OAuth consent pages
for base/fake/full scope cases; it performs no sign-in, token exchange or writes. These are live
vendor probes and are excluded by the Owner's 2026-09-25 boundary despite the approved deployment.
Finish the final commit's normal hook, both exact-build rehearsals and review first, then obtain
one narrow Owner yes covering this existing automatic deploy gate before pushing main. This is a separate
scope confirmation, not a request to reapprove deployment. Do not weaken or skip the workflow.

## Historical local evidence — 2026-09-23/24 (not proof for the current merged head)

Logs under `/private/tmp/cx-completion-20260922`; new evidence must cover the current release and recovery.

- Full normal pre-push gate on `d72abc2fd` in a clean worktree (`release-gate-d72abc2fd.log`):
  11,685 API passed / 348 existing skips; 4,640 web / 13 skips; both builds; 127 security;
  RBAC deny-by-default; **317 real PostgreSQL tests in 24 suites, zero skips**, production-equivalent
  owner; profiles-ON ratchet 934 files, 41 known failing / 217 tests, none new or worse.
  Earlier attempts retained: no root env (1 guard test needs a non-local root `.env`; a synthetic
  one was supplied), and one autovacuum teardown flake (reproduced, fixed in `d72abc2fd`).
- C11f6b/c independent reviews (CHANGES REQUIRED → fixed), 43 guard mutations all killed after
  test fixes (`c11-f6bc-mutations-summary.json`), including a reproduced privilege-escalation blocker.
- Recovery gate on `fdd368e0c` (`recovery-gate-fdd368e0c.log`): 11,594 API / 329 skips, 4,640 web,
  both builds, 127 security, 298 real PostgreSQL / 22 suites / zero skips, ratchet unchanged.

## Historical rehearsal — 2026-09-23/24 (throwaway PostgreSQL 17.11, no real secrets)

This old `0a` proof is superseded by the source77/recoverya5 rehearsal above. Final-commit checks remain pending.

`rehearsal/rehearsal.log` and `rehearsal-jobs/rehearsal-jobs.log`:
1. Published `0a` bootstrap history is complete; its gate passes.
2. Release `migrate-direct` applies exactly `20260923a..h` (eight more rows), zero unfinished.
3. Negative control: `0a` then refuses ("8 migrations applied with no folder"), exit 1.
4. Recovery boots on the migrated database: ready 200, build `fdd368e0`, "No pending migrations".
5. Release boots on the same database: ready 200, build `d72abc2f`. Recovery boots again afterwards.
6. Database checksums of `20260923a..h` equal the recovery files before and after every boot; roles,
   audit table and pinned definers present throughout; history never goes down.
7. With background jobs ON (production mode, no credentials): both builds initialize, stay up 45 s,
   log `inbound-retry cron started … ebayProcessingEnabled:false`; the only errors are the
   deliberately dead Redis address.
Held-processing behaviour itself is proven by the rollout (9) and processing (17) realPG suites in both trees.

## Approved release action (new main requires new proof)

1. Retain the source3be/recovery34 reviews, both clean full hooks and HTTP/jobs rehearsals.
   Finalize reviewed metadata, then check out the final release SHA detached in
   `/private/tmp/cx-release-20260923`. Verify its application/database/hook/tool trees
   still match source3be; any source change requires refreshed evidence.
2. Recheck serving provenance. Base helper must stay at actual serving
   `bc39f98d96ceaddcf0990cb9b9d5b29bc62c7f70`, recovery helper at
   `34c376113380f4c803d4f91190f94c06126c56a2`. Rehearse any final metadata head with all
   three explicit overrides; script defaults intentionally pin old heads:

   ```sh
   cd /private/tmp/cx-release-20260923
   CX_BASE_SHA=bc39f98d96ceaddcf0990cb9b9d5b29bc62c7f70 CX_RELEASE_SHA=<final-release-sha> CX_RECOVERY_SHA=34c376113380f4c803d4f91190f94c06126c56a2 bash docs/channel-connections/build/tools/rehearse.sh
   CX_BASE_SHA=bc39f98d96ceaddcf0990cb9b9d5b29bc62c7f70 CX_RELEASE_SHA=<final-release-sha> CX_RECOVERY_SHA=34c376113380f4c803d4f91190f94c06126c56a2 bash docs/channel-connections/build/tools/rehearse-jobs.sh
   ```

   Replace the release placeholder before execution. Expected history: the base plus
   exactly eight CX additions after the published PCO baseline. Preserve earlier proof.
3. Publish the already gated recovery SHA from the **clean final release checkout**,
   letting the unmodified push hook gate that final release HEAD:
   `git push origin 34c376113380f4c803d4f91190f94c06126c56a2:refs/heads/recovery/cx-20260925`.
   Record tested final release HEAD and pushed recovery34 separately. No skipped hooks.
4. Before main push, the exact package must have final review and the separately requested
   yes for existing CI consent-page probes. General deployment approval remains in force.
5. Recheck `git ls-remote origin main` equals `2459bf52fe85e1ffe0b5f0c510994e019cb3eed4`.
   If it moved, merge published main and refresh proof. Refresh switch evidence, retaining
   every new switch OFF. From the clean release tree push
   `git push origin <final-release-sha>:refs/heads/main`, with normal hooks.
6. Verify Railway SUCCESS, health/ready200 at the exact release build, protected diagnostic401,
   finished/checksummed eight CX migrations, exact Etsy shop57783036→Motovento route and
   Shopify connected. Record bounded production-log findings and unavailable proof honestly.

The approved census source is read only from the isolated cwd. The08:54:05Z snapshot
contains no non-IT eBay master-price followers; rerun before Package B ships. No credential,
environment, KMS, grants, erasure, cutover or activation changes are authorized by this release.

## Recovery (only if the release fails after migrating)

The pre-package serving image lacks `20260923a..h_cx_*` and its startup gate will refuse the
expanded history. Deploy the gated/rehearsed recovery branch instead:
`gh workflow run deploy-api.yml --ref recovery/cx-20260925`, then verify ready 200 with the
exact recovery build `34c37611`, after verifying its approved ref was published.
Freeze pushes to main while recovering. Never downgrade the database, add empty migration
folders or edit the start command. This recovery preserves published main and the release's
complete database tree but omits C11f6a/b/c application changes, including crypto cancellation,
static crypto-error reporting and operator verify/rewrap commands. Keep processing held.
`recovery/cx-20260923` (`fdd368e0c`) and `recovery/cx-20260924` (`64bf38e48`) are superseded
historical artifacts; the old `a5efa0dd9` head is also superseded. Do not deploy them for this package.
If a migration fails part-way, Prisma records the failure (P3009) and blocks every build: that needs
its own approved `prisma migrate resolve` decision, never a manual schema edit.
