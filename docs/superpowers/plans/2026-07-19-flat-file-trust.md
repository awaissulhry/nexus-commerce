# Flat-File Trust (FFT) — zero data loss, platform-true grids, Amazon-workbook-per-product base

**Date:** 2026-07-19 · **Status:** PROPOSAL — AWAITING OWNER GATE
**Owner directive:** flat-file data loss on reload (even frontend-only) "creates mistrust and wastes a lot of time … it must not ever happen again, at any cost." Save errors must go to zero. Nexus is the single source of truth; everything real-time; best in class; full operator control. Amazon listing continues via Amazon's own spreadsheets — the platform should accept those files as-is as the per-product, market-specific base.

> **Progress:** GATED 2026-07-19 ("proceed with your recommendations" — D1-D8 as recommended, order 0→1→2→3a→5→3b/3c→4→6→7). **FFT.0 ✅**: prod 413s live-confirmed on all three save/push endpoints (anonymous oversized probe: 413 fires before auth → post-fix the same probe must return 401); battery `apps/api/scripts/_fft-roundtrip-probe.mts` committed — baseline **7/14 GREEN**, RED = 5×413 (local mirror), Amazon create over-count (created=4 for 2 rows — the "N products created" toast lies), E-ACCT-DELETED-SKU **silent loss proven end-to-end** (re-import of a soft-deleted SKU: HTTP 200, saved=0, processed=0, no error, row vanished). Amazon server round-trip + CAS contract GREEN (A-RT/A-VER/A-VER-STALE); eBay per-market round-trip GREEN (E-RT/E-MKT). R1c corrected (see table). Vercel currency self-resolves at first FFT.1 web push.
> **FFT.1 ✅ SHIPPED + PROD-VERIFIED 2026-07-19** (api `999436f13`, web `f92054f34`): 32 MB limit on all 5 save/publish routes — prod probes flipped **413 → 401** on Amazon sync-rows, eBay rows PATCH, eBay push; eBay unresolved rows are per-row errors (deleted-SKU twin named precisely; root cause = P2002 recovery resolving only alive products — both branches now report every unrecovered SKU); Amazon `created` counts rows; CAS conflicts carry `currentVersion`; web: 25-row parents-first chunked Amazon saves w/ retry+classification, synchronous version merge, conflict-version adoption; eBay client folds route errors into failed-row protection. Battery **15/15 GREEN** (was 7/14).
> **FFT.2 ✅ SHIPPED 2026-07-19** (web, one commit): eBay save→**read-back verification** before draft clear (same GET a reload issues; pure `saveVerify.pure.ts` diff — aspect keys folded canonically, live/system/tree fields excluded, Action rows skipped; mismatch keeps draft + names rows; network-skip keeps draft); verify GET re-seeds SWR on clean; Amazon `_swr` invalidated on save (C5 parity); `pagehide` draft flush both grids (Z1). R2c corrected (fence already re-keys). **FFT.2 E2E ✅ PASSED ON PROD 2026-07-20** (owner's Chrome, FFT-SCRATCH family, cleaned after): eBay edit→Save (read-back verified; draft key confirmed cleared ONLY post-verify)→hard reload→value identical; Amazon edit→chunked Save ("Saved 1 rows")→hard reload→value identical + `Submit to Amazon (1)` stayed armed (FFP.2 invariant held); deployed bundle verified to contain the FFT.2 verify code (marker string found in chunk). Battery re-run 15/15 GREEN post-deploy. Cross-tab invalidation probe deferred to FFT.4's pending-chips work (guard analysis stands; no reproduced clobber post-#32).
> **FFT.3a ✅ SHIPPED 2026-07-20** (battery **18/18 GREEN**): `listing-content-write.service.ts` choke point (partial snapshot spread-merge over EXISTING snapshots only — never creates a partial one; LIVE-overlay keys refused loudly; CAS preserved; UK→GB normalized; upsert support). Writers migrated: **unified grid** (Amazon+eBay branches through the choke point w/ per-channel row-key maps; master+listing edits emit events — battery: U-UNIFIED-AMZ/EBAY GREEN, the masking class dead); **import-apply** (snapshot patch folded into the SAME updateMany write — atomic, zero extra queries; post-tx FLAT_FILE_IMPORTED emits — U-APPLY-AMZ GREEN); **pull** (adopts Amazon truth: `getExistingRows(..., {skipSnapshotOverlay})` rebuilds every pulled listing's snapshot from the fresh live row + events — "Pull visibly does nothing" dead by construction); **hydrate** (events only, BY DESIGN — absent snapshot keys already read from live attrs; present ones are operator-saved values legitimately winning). 5 new choke-point unit tests; 333 flat-file api tests green.
> **FFT.5a ✅ SHIPPED 2026-07-20** (74e6edb65; battery 18/18): **the operator's own uploaded Amazon workbook IS the family's export base, market-specific.** `AmazonFamilyWorkbook` (additive migration, applied to Neon) captures the FILLED single-family .xlsm per (familyKey, marketplace) at import — familyKey auto-detected from the file's single dominant parent SKU (multi-family files stay template-only); Export-for-Amazon resolves explicit-id → **the family's OWN file (exact market)** → market-template fallback, zero-config (family derived from the exported rows); provenance headers `X-Export-Base/Family/Source-File`. Blank-template vault + all A7 rails untouched (same row builder: record_action blank, FBA qty never). *Remaining FFT.5b:* wizard provenance banner + File-menu "based on" line + AMX.1 family review + AMX.2 per-cell issue locations + AMX.4 post-apply report.
> **FFT.5b ✅ SHIPPED 2026-07-20** (44354127f provenance · b97924aa9 AMX.1 · 75f11562f AMX.2+4): import banner announces the captured family base; export toast names the producing base; **Review-families step** (upload→map→families→preview) with per-family Import/Skip + reparent/orphan/type-mismatch/theme-mismatch/incomplete badges (scenario-ledger 1-5 badged at import; skips excluded from every plan build); flagged values expand to exact cells; duplicates + FBA-qty-ignored named with SKUs (scenarios 6/8/10); durable per-market post-apply report banner + "Import: {file}" version-history label (scenario 14). **FFT.5 COMPLETE** — deferred by owner decision D5: AMX.3 localized-value canonicalization, AMX.5 multi-file queue; deferred small: flagged-cell tint inside expanded plan rows, one-click filter-to-changed, policy-group generalization (qty/price toggles stay).

This program is the approval vehicle for touching the flat-file editors (same pattern as FFP/EFX/UFX engagements): each phase is built, tested, live-verified, committed+pushed as a unit.

---

## 0. Baseline honesty — what is already fixed vs. what this proposal fixes

- Prod API (Railway) is running today's latest api commit (`/api/health` build `6e36e539`). A large wave of "values vanish / reverts" fixes shipped in the last 48h on the eBay side (incidents #24 membership snapshots, #27 draft generation fence, #28/#28b save retry + 25-row chunking, #32 value-lifecycle hardening ×23 findings, #34 aspect-key casing, #35–#42 labels/stability). Part of the operator's experience predates these. **Web (Vercel) deploy currency vs HEAD is unverified** — turbo-ignore skips web builds on api-only commits; FFT.0 confirms it.
- Everything below was **re-verified against today's working tree** (not taken from memory). All file:line citations checked 2026-07-19.

## 1. Verified root causes

### R1 — Save integrity: saves that fail loudly, or worse, lie (the operator's "several errors while saving")

| # | Cause | Evidence |
|---|-------|----------|
| R1a | **Save/publish endpoints run on Fastify's default 1 MB body limit.** `FX_BODY_LIMIT` (32 MB) was applied only to parse/export/coerce routes. Rows carry the full 80+ col snapshot ⇒ a few hundred rows = **HTTP 413** before any handler runs. | No `bodyLimit` on `amazon-flat-file.routes.ts:1401` (`/sync-rows`), `:351` (`/submit`), `ebay-flat-file.routes.ts:653` (PATCH `/rows`), `:1297` (`/push`), `:2945` (`/publish`); contrast `:857/:881/:2651/:2894` which all pass `{ bodyLimit: FX_BODY_LIMIT }`. Comments at `amazon-flat-file.routes.ts:848` + `ebay-flat-file.routes.ts:2642` acknowledge the 1 MB default — the fix never reached save/publish. |
| R1b | **Amazon Save sends ONE un-chunked POST of every dirty row** — the 413 trigger, plus total loss of the request on any network blip (eBay got 25-row chunked, retrying saves in #28b; Amazon never did). | `AmazonFlatFileClient.tsx:2459` single `fetch(...sync-rows, body: JSON.stringify({rows: rowsToSync ...}))`. |
| R1c | **Amazon CAS conflicts** ("Changed elsewhere since you pulled") keep OLD data in the DB while localStorage shows new. *FFT.0 correction:* the follow/buffer applies deliberately do NOT bump version (`follow-master.service.ts:200-206,399` — designed for exactly this), and the battery proves the server contract healthy (save→returned-version→re-save = no conflict). Remaining real sources: cross-surface CAS writers (cockpit etc.), multi-tab, and the client's **deferred `_version` merge** (`setTimeout` at `AmazonFlatFileClient.tsx:2513`) racing grid row replacement (SSE reload/market switch) so fresh versions never land. | Conflict throw `flat-file.service.ts:3476`; versions returned `AmazonFlatFileClient.tsx:2485`; deferred merge `:2513-2531`. Battery: A-VER GREEN, A-VER-STALE GREEN. |
| R1d | **eBay save silently drops rows:** a row whose product can't be resolved hits a bare `continue` (log-only, `product not found, skipping`) — neither saved nor errored; response reads as success; client then **clears the draft** ⇒ hard data loss. Extra shared occurrences are also skipped by design but counted `processed`. | `ebay-flat-file.routes.ts:786` (bare `continue`), `:768-772`. |
| R1e | **Post-save outbound enqueues can silently no-op** when the circuit is open (`addJobSafely` returns `{skipped:true}`, never throws) — qty/price sync quietly deferred while Save reports success. | `lib/queue.ts:196-224`; follow-master apply path `flat-file.service.ts:3419-3421`. |

### R2 — Reload truth: paths where a successful Save/Publish still shows old data after reload

| # | Cause | Evidence |
|---|-------|----------|
| R2a | **eBay clears its local draft on save** — reload then depends 100 % on the server round-trip; combined with R1d (or any marketplace-scope miss) the edit is unrecoverable. No save→read-back verification exists. | Draft cleared `EbayFlatFileClient.tsx:1625`; snapshot overlay is active-market-only `ebay-flat-file.routes.ts:346-361`. |
| R2b | **Amazon cross-tab invalidation clobbers the draft after a clean Save:** `channel-pricing.updated` from any other tab/page force-reloads server rows and **overwrites localStorage**; the protective guard only holds while `_dirty`/`localDiverged` — both cleared by a clean Save. The code comment itself says this overwrote the grid "with the DB representation (the 'previous version') — worst after Publish." | `AmazonFlatFileClient.tsx:1383-1398` (guard), `:1641` (server rows overwrite localStorage), `:2473/2513-2525` (flags cleared on save). |
| R2c | **Publish identity flip** — *FFT.2 correction:* the fence already re-keys by family+sku with a FIELD-LEVEL merge (Audits C6/C9, `draftStore.ts:170-181`) and drops only truly twin-less rows. No further fence work needed; the read-back verify (FFT.2) covers the residual. | `draftStore.ts:156-206`. |
| R2d | **Amazon `_swr` module cache is never invalidated on save** (eBay deletes its twin — Audit C5) ⇒ up to 5 min of pre-save repaint on market switch-back. | eBay `_ebay_swr.delete` `EbayFlatFileClient.tsx:1586`; no Amazon equivalent (`AmazonFlatFileClient.tsx:306,1550`). |
| R2e | **No `pagehide`/`beforeunload` flush** of the debounced autosave (Amazon 1 s, eBay 400 ms) ⇒ the last sub-second of edits can miss the draft on a fast reload/close. | Debounce `AmazonFlatFileClient.tsx:1281`, `EbayFlatFileClient.tsx:3308`; `unsaved-guard.ts` confirms-but-doesn't-persist. |
| R2f | **Amazon feed rejection is invisible after the success `feedId`:** submit saves + returns a feedId; if Amazon later rejects the feed, nothing re-arms `_needsPublish` or marks the rows — the UI keeps looking published. | Submit flow `amazon-flat-file.routes.ts:466→645`; poll `jobs/amazon-flat-file-feed-poll.job.ts`. |

### R3 — One snapshot truth: ~20 write paths mutate listing content WITHOUT rewriting the `flatFileSnapshot` the grids read

The grids read back `ChannelListing.flatFileSnapshot` (Amazon overlay `flat-file.service.ts:2416/1317`; eBay `ebay-flat-file.routes.ts:346-361`) + `SharedListingMembership.flatFileSnapshot`. Snapshot is written at only **10 sites**; every other content writer bypasses it, so its edits are *masked* in the grid (and grid content can mask live truth) — the operator's "not consistent with the actual platforms":

- **Amazon bypass writers (A1–A14):** pull-from-Amazon (`flat-file-pull.service.ts:279/284` — **a Pull visibly does nothing** because the old snapshot still wins), attribute-hydrate cron (`flat-file-hydrate.service.ts:55`), unified grid save (`flat-file-unified.routes.ts:545`), `/products` bulk PATCH channel fields (`products.routes.ts:2627` via `:1994` map), product-channel-data routes (`:167/194/404`), Amazon cockpit publish/create (`amazon-cockpit-publish.routes.ts:325/490`), `amazon.routes.ts:1246/1430`, browse-node predictor (`feed/browse-node-predictor.service.ts:253`), marketplaces routes (9 sites), listings-syndication (8 sites), PIM overrides/reconcile, bulk-action service (`:3207`), listing-wizard (`:1438/1478`), catalog routes (`:1300/1876`).
- **eBay bypass writers (E1–E6):** cockpit editor (15 write sites in `ebay-cockpit.routes.ts`), variation-publish write-back creates **snapshot-less** ChannelListings (`ebay-variation-push.service.ts:1950/1974`) while the shared lane DOES write snapshots (`ebay-shared-listing-push.service.ts:502`) — Lane A/Lane B inconsistency; unified save (`flat-file-unified.routes.ts:584`); **catalog re-parent never rewrites children's `snapshot.parent_sku`** (`catalog-organize.routes.ts:112-157`) — the known trap class, still alive outside the editors.
- **Round-trip import engine (FF2.6a):** `services/flat-file/import/apply.ts` writes `product.updateMany:283` / `channelListing.updateMany:418` / `create:405` with **no snapshot write, no read-cache refresh, no product events** — an applied import reverts in BOTH grids on reload.

### R4 — Platform truth: no verified content round-trip

Qty/status have reconcile crons; **content** (title/aspects/description/images) has no read-back compare, feed rejections don't surface on rows (R2f), and outbound queue lag (RT baseline: p50 4–6 min, p90 35+ min) renders as "my price/qty reverted" because live-overlay fields show DB truth with **no pending-sync indicator**.

### R5 — Read model (/products): the parallel staleness

`product-event → readCacheQueue.add` is raw fire-and-forget (NOT `addJobSafely`) — a Redis stall silently drops refreshes (`product-event.service.ts:130`); the 15-min reconcile heals only `totalStock/status/name` (`read-cache-reconcile.job.ts:59`); the Amazon save's refresh emit filters to `isPublished && offerActive` (`amazon-flat-file.routes.ts:1422-1428`) so **draft saves never refresh /products**; all R3 bypass writers also skip events.

### R6 — Amazon official workbook: vault is market-specific but not per-product

`AmazonTemplateVault` (schema `:14199`) keys by `templateIdentifier` (or `legacy:{marketplace}:{types}:{filename}`), stores the **blank category template bytes**, and export resolves **most-recent-per-marketplace** (`template-vault.service.ts:40/52/177-181`). There is no `productId/familyKey`; the filled data rows of the uploaded file are discarded (rows are regenerated from grid truth at export). So "my uploaded AIREON IT file is THE base for AIREON on IT" is not yet true — four concrete gaps: per-family key, filled-workbook capture, per-family export resolution, family auto-binding at import.

---

## 2. The Zero-Data-Loss Invariant (the contract every phase serves)

1. **Z1** Every edit is durably drafted locally *before* any network call, and flushed on `pagehide`.
2. **Z2** A draft is cleared **only after a server read-back confirms** the row persisted verbatim.
3. **Z3** A save response never counts an unwritten row as success — per-row typed status, no silent skips, no silent circuit deferrals.
4. **Z4** Nothing overwrites unsaved local edits silently — every merge is field-level and surfaced.
5. **Z5** Every content write, from any surface, rewrites the snapshot the grids read (one choke point).
6. **Z6** Identity transitions (publish/adopt/relabel) re-key and carry edits — never drop them.
7. **Z7** Continuous automated round-trip proof (regression battery) + visible drift/pending-sync state in the grid.

## 3. Phases

**FFT.0 — Ground truth & the battery (read-only + test scaffolding).** Verify Vercel deploy currency vs HEAD; reproduce both symptoms on prod (read-only + scratch family); pin the operator's exact save errors from server logs (413 vs CAS vs other); commit `apps/api/scripts/_fft-roundtrip-probe.mts` — edit→save→GET→field-compare per grid per market on a scratch family, the program's regression battery (baselined RED where broken). *Exit: live symptom→cause map; battery in repo.*

**FFT.1 — Save integrity (kills R1).** `FX_BODY_LIMIT` on all 5 save/publish routes; Amazon client saves chunked 25/parents-first with retry + honest classification (parity with eBay #28/#28b); eBay PATCH returns per-row errors for unresolved rows (bare `continue` abolished); save response contract = per-row `{rowId, sku, status: saved|error, version}`; client keeps failed rows dirty + drafted; CAS self-stale closed (follow/buffer apply folded into the save transaction, or versions re-issued after apply); circuit-open deferrals surfaced as response warnings. *Tests: 1000-row save via battery; forced conflict; forced unresolvable row; 413 regression.*

**FFT.2 — Reload truth (kills R2).** eBay: save→read-back verify→only then clear draft; mismatch keeps draft + names rows in a banner. Amazon: invalidation reload becomes field-level merge that can never clobber (re-arm protection until verified read-back), `_swr` invalidated on save. Generation fence upgraded to identity **re-key merge** (map `planned::→shared::` by family+sku, carry edits). `pagehide` flush both grids. Draft semantics documented in `docs/edit-ux.md`. *Tests: battery gains reload-after-save, publish-then-reload, cross-tab-invalidation scenarios; browser E2E on prod scratch family.*

**FFT.3 — One snapshot truth (kills R3).** New `listing-content-write` choke point (CL content write + snapshot key rewrite + product event, atomic). Migrate writers in gated batches: **3a** pull + hydrate + unified-save + import-apply (highest operator impact — Pull finally *shows* what it pulled); **3b** cockpits + `/products` bulk PATCH + marketplaces + syndication + PIM + wizard + catalog; **3c** eBay Lane-A publish write-back gains snapshot parity with Lane B; catalog re-parent rewrites children's `snapshot.parent_sku` (trap class dead forever). *Tests per batch: write via migrated path → GET rows shows it; snapshot-diff regressions; battery.*

**FFT.4 — Platform truth (kills R4).** Feed rejections re-arm `_needsPublish` + per-row error chips (extend feed-poll reconcile); on-demand **"Verify against live"** per family (Amazon listings-items GET, eBay GetItem — extend the existing verify-item to content compare) → drift chips + one-click *adopt live* / *re-push mine*; **pending-sync chips** on price/qty cells reading outbound-queue state (read-only consumer of the RT lane — no queue work here). *Tests: rejected-feed fixture; live drift check on scratch; chip-state units.*

**FFT.5 — Amazon official workbook as the per-product, market-specific base (delivers R6).** Vault v2: capture the FILLED workbook bound to `(familyKey, marketplace)` (blank-template dedupe kept); import auto-binds file→family+market (market detection exists; add family detection from parent_sku/SKU census with operator confirm); Export-for-Amazon resolves the family+market file first, market template as fallback; File menu shows "based on: {filename} ({MP})". Invariants locked by tests: `record_action` blank, **FBA qty never exported**, per-market isolation absolute. Folds in **AMX.1** (family review step), **AMX.2** (visible belts + per-cell issue locations), **AMX.4** (post-apply report); AMX.3/.5 stay deferred. *Tests: per-family round-trip identity battery (AIREON IT+DE, X-RACING IT); wrong-market/wrong-family resolution regressions.*

**FFT.6 — Read-model integrity (kills R5).** `addJobSafely` for read-cache enqueue; reconcile compares a full projection hash (not 3 fields); Amazon save emit unfiltered (draft saves refresh); remaining writers covered via FFT.3 choke point. *Tests: Redis-down chaos → reconcile heals ≤15 min; battery.*

**FFT.7 — Proof, runbook, close-out.** Battery in pre-push or nightly cron; zero-data-loss section in `docs/edit-ux.md`; `docs/flat-file-trust-runbook.md`; owner E2E script; sweep of any incidents raised during the program.

*Recommended order: 0 → 1 → 2 → 3a → 5 → 3b/3c → 4 → 6 → 7 (1+2 kill the operator's two symptoms; 5 early because the owner lists via Amazon files daily).*

## 4. Decision points

- **D1** Amazon chunked saves (25/parents-first, retry+classify)? **Rec: yes.**
- **D2** Generation fence: re-key merge vs today's drop+toast? **Rec: merge.**
- **D3** Route cockpit/bulk/PIM writers through the snapshot choke point (their edits then appear in the grids)? **Rec: yes — one truth everywhere.**
- **D4** Platform content read-back cadence? **Rec: on-demand button + nightly sampled cron (API-quota-safe); no 30-min hammering.**
- **D5** Fold AMX.1/.2/.4 into FFT.5, defer AMX.3/.5? **Rec: yes.**
- **D6** FF v2 dormant workbook engine (`docs/flat-file/v2`): formally retire (archive docs, gate off `flat-file-import` routes if unused) or keep dormant? **Rec: retire; FFT.3 wires its apply path through the choke point either way (D7).**
- **D7** `flat-file/import/apply.ts` (FF2.6a): wire through choke point vs gate off? **Rec: wire through — it's reachable today and bypasses everything.**
- **D8** RT interface: FFT consumes RT events read-only; FFT.4 chips visualize queue state; only FFT.3a touches `flat-file.service.ts` where RT.0 landed — sequenced after RT.0 (already merged). **Rec: acknowledge.**

## 5. Boundaries

- **FBA quantity untouchable** — never written/pinned/exported; guards never weakened (locked by tests here).
- **Legacy import-wizard untouchable** — FFT touches only the flat-file pipelines.
- **RT program owns** queue latency, ingestion, dispatch, Redis (RT.1+); FFT never modifies queue timing — it makes the grids *honest* about it.
- **eBay EI import pipeline is complete** — consumed, not rebuilt.
- All UI additions (chips/banners/menus) from the design system; density per the visibility-over-minimalism standard.
