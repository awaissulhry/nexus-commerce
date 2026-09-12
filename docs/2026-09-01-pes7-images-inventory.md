# PES.7 Phase 0 — capability inventory: Images tab + ancillary tabs

**Lane:** PES.7 (images tab rebuild + Analytics·Ads + Activity thin tabs)
**Date:** 2026-09-01 · **Status:** Phase 0 study complete, awaiting Owner approval
**Owned paths (post-approval):** `apps/web/src/app/products/[id]/edit/_studio/images/**`, `.../_studio/ancillary/**`
**Read-only for this lane:** `tabs/images/**`, `tabs/ImagesTab.tsx`, `tabs/AnalyticsTab.tsx`, `tabs/AdsTab.tsx`, `tabs/TimelineTab.tsx`, `tabs/ActivityTab.tsx`

---

## §1 Shape of the thing

| | |
|---|---|
| Files in `tabs/images/**` | 64 (58 source + 6 vitest) |
| Lines (incl. `ImagesTab.tsx`) | **17,977** |
| Modals | **19** |
| Tailwind utility tokens (images tree + 4 ancillary tabs, 63 files) | **~10,313** |
| DS imports today | 6 (all `design-system/components/Listbox`) |
| Legacy `@/components/ui` imports | 50 (Button ×32, IconButton ×11, Badge ×2, Toast/Input/EmptyState/ConfirmProvider/Card ×1) |
| i18n keys already defined (`products.edit.images.*`) | 140 distinct |
| Backend endpoints consumed | 34 distinct |
| Dead files inside `tabs/images/**` | **0** — every non-test file is reachable from `ImagesTab.tsx` |

Ancillary: `AnalyticsTab.tsx` 369 · `AdsTab.tsx` 523 · `TimelineTab.tsx` 466 · `ActivityTab.tsx` 826.

---

## §2 Capability inventory — Images

Composition tree from `ImagesTab.tsx` (channel tab strip → one panel + QualityChecklist sidebar → action bar → 19 modals).

### 2.1 Master scope
| Capability | Component | Round-trips to | Verdict |
|---|---|---|---|
| Gallery: upload, DnD reorder, delete, type/alt inline edit, per-image context menu | `MasterPanel` (1,492 L) | `POST/PATCH/DELETE /products/:id/images`, `/images/reorder` | REAL, persists immediately |
| Multi-select + "apply selection to channel" | `MasterPanel` | staged → `bulk-save` | REAL |
| Primary/hero flag (PG.4, DB partial-unique) | `MasterPanel` | `PATCH /images/:id/primary` | REAL |
| Apply to child SKUs | `MasterPanel` | `POST /images/apply-to-children` | REAL |
| Scoped upload (master vs variant-targeted, per-channel slot defaults) | `ScopeUploadModal` (IE.10) | upload + staged upserts | REAL |
| Smart bulk apply (axis values × slot × market, live overwrite preview) | `BulkApplyModal` (IE.12) | staged upserts | REAL — **Amazon-only** today (IE.12b = eBay/Shopify, KEEP as roadmap) |
| Duplicate review (contentHash + perceptualHash clusters) | `FindDuplicatesModal` (IE.16) | `GET /images/duplicate-groups` | REAL |
| In-app editor: crop (Free/1:1/4:3/4:5) · rotate ±90° · flip | `ImageEditorModal` (IR.4.3) | `POST /images/:id/derive` (Cloudinary transform, new row + `derivedFromImageId`) | REAL |
| Auto-enhance | `LightboxModal` | `POST /images/:id/auto-enhance` | REAL |
| Gemini Vision analysis (white bg, frame fill, text overlay, off-centre) | `LightboxModal` | `POST /images/:id/analyze` | REAL |
| Imagen 3 lifestyle generation | `LifestyleGenerationModal` (IR.14.2) | `POST /images/generate-lifestyle` | REAL (needs paid Gemini key; error path says so) |
| DAM library picker (search/folder/tag filters, brand + product-type pre-scope) | `DamPickerModal` (IR.7.4) | `/assets/library`, `/asset-folders`, `/asset-tags`, `POST /images/import-from-dam` | REAL — no re-upload, shares Cloudinary publicId |
| Push master image → DAM | `LightboxModal` | `POST /images/:id/push-to-dam` | REAL |
| DAM drift notice (linked asset URL changed) | `ImagesTab` banner (MM.8) | `damDrift[]` from workspace | REAL |
| Lightbox: full-screen + 320px detail drawer, ←/→ siblings, metadata, back-refs, inline alt/type edit | `LightboxModal` (735 L, IR.3.1–3.5) | `PATCH /images/:id` | REAL |
| Video: upload, poster, inline playback, duration, per-tile validation warnings | `VideoSection` + `videoValidation.ts` (MM.1–4) | `POST /products/:id/videos`, shared DELETE | REAL |
| Per-channel completeness checklist (thresholds from `@nexus/shared`) | `QualityChecklist` | computed client-side | REAL |

### 2.2 Amazon scope
| Capability | Component | Round-trips to | Verdict |
|---|---|---|---|
| Marketplace tabs (All / IT / DE / FR / ES) | `AmazonPanel` | scope=MARKETPLACE rows | REAL rows — **but see §4 finding A** |
| Colour × Slot matrix (MAIN, PT01–PT08, PS01–PS06, SWCH), cell drop targets, column-header fill, keyboard nav, drag-reorder | `AmazonMatrix` (936 L) + `ChannelImageGrid` | staged → `bulk-save` | REAL |
| Cascade resolution per cell (variation override > group override > product fallback) | `useAmazonImages.resolveCell` | client-side over workspace payload | REAL |
| Bulk ops on cell range: delete, clear override, fill, set MAIN, lock, upload | `bulkSelection.ts` (pure, tested) | `bulk-save` + `/images-workspace/lock` | REAL |
| Filter bar: axis-value multi-select + cell-status (all/empty/inherited/override), URL-persisted, localStorage presets | `MatrixFilterBar` (IE.11/IE.13) | URL + **localStorage** | Filter REAL; presets browser-only |
| Column show/hide + reorder | `MatrixColumnsModal` + `useMatrixColumnPrefs` (MM.5) | **localStorage** | browser-only |
| Named cross-device view layouts | `MediaViewsMenu` (MM.7) | `/api/saved-views` (`surface='product-media'`) | REAL, server-persisted |
| Slot-group completion (Main/Gallery/Safety/Swatch, "Safety 6/6 ✓") | `groupCoverage.ts` (pure, tested) | client-side | REAL |
| Copy to markets | `CopyToMarketsModal` + `crossMarketCopy.ts` (pure, tested) | staged upserts | REAL — **see §4 finding A** |
| Copy to variants | `CopyToVariantsModal` + `variantCopy.ts` (pure, tested) | staged upserts | REAL |
| Pre-publish preview: per-ASIN × per-slot table + cascade chip + coverage | `PublishPreviewModal` (IA.2) | `GET /amazon-images/preview`, `/validate` | REAL |
| Publish + feed poll | `AmazonPublishBar` + `useAmazonImages` | `POST /amazon-images/publish`, `GET /feed-status/:jobId` | REAL |
| Amazon Mirror: fill-from-gallery · mirror-diff preview (adds/replaces/**removes**) · exact-mirror publish | `AmazonMirrorControls` (M6) | `/fill-from-gallery`, `/mirror-diff` | REAL |
| Stale detection + "re-publish stale only" (variantIds filter) | `StaleBanner` (IA.5) | `GET /amazon-images/stale` | REAL |
| Live channel strip (SP-API read-back) + drift modal + adopt-to-master | `LiveChannelStrip`, `LiveImageDriftModal` (IE.5) | `POST /live-channel-images/refresh` | REAL. Shopify read-back **not wired** → muted "not yet wired" notice = **KEEP (roadmap)**. Drift modal's "Republish to fix" CTA deferred to IE.5b = **KEEP** |
| Export ZIP + pre-generation manifest (ASINs, image counts, skipped-no-ASIN, validation-blocked) | `ExportPreviewModal` | `/export-zip`, `/export-zip/manifest` | REAL |
| Storefront preview mockup (Amazon/eBay/Shopify layouts) | `ChannelPreview` (IR.5.3/5.4) | client-side | REAL — intentionally stylised; disabled variant buttons are decoration, not a placeholder control |

### 2.3 eBay scope
Rows = "Default (cover & common)" + one per colour; columns = photo positions 1..12. Every photo lives in **exactly one** bucket (eBay does not de-dupe); publish de-dupes per-colour against Default as a safety net. eBay is IT-only. 12-image cap is eBay's real per-variation limit (Inventory API "Managing images"). Renders the shared `ChannelImageGrid`. Its edits live in the **panel's own bucket state**, not the shared `pendingUpserts` registry — it reports a dirty count and hands `ImagesTab` an imperative `flush()`/`discard()` so ONE action bar drives Save/Discard/Publish. Publish → `POST /ebay-images/publish` (fired from `ImagesTab`).

### 2.4 Shopify scope
Pool (up to 250, position 0 = featured, DnD reorder) + per-colour variant image assignment (→ `variant.image_id` / `productVariantsBulkUpdate mediaId`). All staged → action bar. Publish → `POST /shopify-images/publish`.

### 2.5 Publish machinery (cross-channel)
| Capability | Component | Backing | Verdict |
|---|---|---|---|
| Global Save/Discard + Publish dropdown (all channels + Amazon's 5 markets) | `ImageActionBar` (PB.1) | — | REAL |
| Cmd+S save from any channel tab | `ImagesTab` | — | REAL |
| Cross-tab pre-save before every publish (`onPreSaveAll`) | `ImagesTab` (DSP.4) | tab registry | REAL |
| Client-side validation banner (hard-fail/soft-warn) for eBay+Shopify | `ChannelValidationBanner` (PB.3a) | `@nexus/shared/image-validation` | REAL |
| Pre-publish preview for eBay+Shopify | `ChannelPublishPreviewModal` (PB.3b) | client-side resolution | REAL |
| Stale banner for eBay+Shopify (`master.updatedAt > publishedAt`) | `ChannelStaleBanner` (PB.3d) | client-side from workspace | REAL |
| Recent jobs strip (last 3) | `RecentChannelJobsStrip` (PB.3c) | `GET /image-publish-jobs` | REAL |
| Cross-channel publish planner (Amazon ×5 + eBay + Shopify, per-card coverage + validation, sequential fire) | `CrossChannelPublishModal` (PB.5) | delegates to `handlePublish` | REAL |
| Unified publish history (Amazon feed jobs + channel jobs merged) + Retry | `ImagePublishHistory` (IR.9.4) | `GET /image-publish-jobs`, `POST /image-publish-jobs/:id/retry` | REAL |
| Per-channel health cards (last published, 30d count, success rate, avg duration, recent errors) | `PublishHealthCards` (PB.13) | same UnifiedJob data | REAL |
| Publish audit log accordion | `PublishAuditLog` (PB.16) | `GET /audit-log/search` (`action LIKE imagePublish*`) | REAL |
| Scheduled publish (create + pending list + cancel) | `SchedulePublishModal` (PB.10) | `POST/GET/DELETE /scheduled-image-publishes` | Rows REAL — **see §4 finding C** |
| Rollback to last published snapshot (diff + restore as pending upserts) | `RollbackModal` (PB.9) | **localStorage** snapshots | browser-only (PB.9b queued = **KEEP**) |
| Auto-publish after save, per channel | `AutoPublishSettings` (PB.11) | **localStorage** | browser-only by design (per-operator choice) |
| Approval gate: defer publish → queue → Approve/Reject | `ApprovalModal` + `approvalPrefs` (PB.12) | **localStorage** | browser-only (PB.12b server model queued = **KEEP**) |
| Browser notifications on publish complete/failed | `ImagesTab` (PB.15) | Notification API | REAL |
| Cross-channel quick-sync strip (one-click copy between channels) | `CrossChannelSyncBar` (IM.7) | staged upserts | REAL |

### 2.6 What does NOT round-trip (browser-local only)
`publishSnapshotStorage` (PB.9 rollback snapshots) · `approvalPrefs` (PB.12 approval flag + queue) · `autoPublishPrefs` (PB.11) · `useMatrixColumnPrefs`/`matrixColumnPrefs` (MM.5 column layout) · `MatrixFilterBar` presets (IE.13) · `LiveChannelStrip` + `ImageActionBar` collapse/UI state.
Each is *documented as intentional* with a named server-side successor (PB.9b/PB.11b/PB.12b). None is a lie — but under the **100% honest UI** rule the rebuilt surfaces must keep saying "this browser only" where they say it today.

---

## §3 Capability inventory — ancillary tabs

### Analytics (`AnalyticsTab.tsx`, 369 L)
`GET /products/:id/analytics?days=` + `/analytics/trend?days=` — both exist and return real data. Renders: 30/60/90d window switch, sales totals + per-channel table (units/revenue/orders/conversion/buy-box/sessions), hand-rolled CSS sparkline (no chart lib), quality score + per-channel dimensions, inventory (available, days-of-inventory, stockout risk HIGH/MED/LOW), pricing (current + latest buy-box + latest repricing decision), reviews (avg rating, count, recent spike). **419 Tailwind tokens, zero DS, zero i18n.**

### Ads (`AdsTab.tsx`, 523 L)
`GET /advertising/product-ads` — exists, real. Walks AdProductAd → AdGroup → Campaign → AmazonAdsDailyPerformance + AmazonAdsSearchTerm. Lazy-loaded on first render. Renders: summary tiles, **Campaigns table** (Campaign/Market/Status/Impressions/Clicks/Orders/Spend/Ad Sales/ACOS + open-link), **Top Search Terms table** (Query/Match/Clicks/Orders/Spend/ACOS), **Ad Creatives list** (with multi-product annotation), quick links to `/marketing/ads/*`. Empty state names the fix ("run a campaign report cycle from …"). **491 Tailwind tokens, zero DS, zero i18n.**

### Activity
🔴 **`tabs/ActivityTab.tsx` (826 L) is DEAD CODE.** `ProductEditClient.tsx:1429` mounts **`TimelineTab`** for `topTab === 'activity'`; nothing anywhere imports `tabs/ActivityTab`. (The other `ActivityTab` symbols in the repo are unrelated local components in ProductDrawer, ListingsWorkspace, CarrierConfigDrawer, control-room, ebay campaigns.)

The **live** Activity tab is `TimelineTab.tsx` (466 L, ES.4): ProductEvent log with source-aware rendering — flat-file imports grouped as batch rows expandable to per-field delta; operator edits, bulk ops and AI events each get their own icon + badge colour; **falls back to the legacy AuditLog feed** when a product has no ProductEvents (pre-ES.2). Endpoints `GET /products/:id/events` + `GET /audit-log/search` — both exist.

The dead `ActivityTab.tsx` is the *AuditLog-only* W2.2 predecessor: cursor pagination, action + time-window filters, per-row expand-to-diff, and a **revert-a-field action** (`/api/products/bulk` + `emitInvalidation`) that `TimelineTab` does not have.
→ **Decision needed (D3).** It is dead code, not a placeholder control — but it holds one capability the live tab lost.

---

## §4 Findings that affect honesty

**A · 🔴 The Amazon per-marketplace image model contradicts Amazon.**
Amazon maps image attributes to the **ASIN globally**, "even if you specify the marketplace_id selector" (SP-API Listings FAQ). Xavia is Pan-EU: one ASIN + SKU across IT/DE/FR/ES/UK ⇒ **one image set, shown on every marketplace**; per-market MAIN/gallery images are impossible. Yet the tab presents 5 marketplace tabs, `scope=MARKETPLACE` ListingImage rows, a Copy-to-markets tool, a 5-iteration publish loop, and per-market drift/stale. Updating any one market re-sets the global ASIN images. Recorded in memory as "flagged 2026-06-09, not yet refactored (needs approval)".
The rebuild inherits this. I will **not** silently change it. → **Decision needed (D1).**

**B · FOUR server-computed fields are fetched and dropped.**
`/images-workspace` returns `resolvedAxes` (theme-authoritative axes: declared order, synonym+fingerprint-deduped, ghost axes removed), `axisValueCounts` (distinct values per axis), `resolvedAxisSuppressed`, and — the significant one — **`amazonSlotTaxonomy`**. **Nothing in the images tree reads any of them**; `amazonSlotTaxonomy` is not even declared on the client's `WorkspaceData` type.

`amazonSlotTaxonomy` is the schema-discovered set of image-locator slots Amazon actually exposes for this (marketplace, productType), resolved server-side from the cached product-type schema (`amazon-slot-taxonomy.service.ts`, route line 347). It uncaps the additional-image slots beyond PT08 where the product type allows more, and surfaces the Product-Safety / GPSR locators — which matter for Xavia's EU PPE. The old UI instead renders a **hardcoded `ALL_SLOTS`** constant in `useAmazonImages.ts`. So the matrix can show the wrong slot set for a product type while the correct one sits unread in the same response. The axis picker is instead a free-text `<input list>` whose datalist is a hardcoded guess (`'ASIN','SKU','Colore','Taglia','Color','Size','Colour','Material','Style','Gender'`). Fixing this is pure consumption of data already on the wire — no API work. (`resolvedAxisWarnings` *is* read, and only since a recent pass.)

**C · Scheduled publishes may never fire.**
`jobs/scheduled-image-publish.job.ts:144` returns early unless `NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH === '1'`. `SchedulePublishModal` writes real DB rows and shows a real pending badge either way. I could not confirm the prod flag — the Railway variable read was blocked by the sandbox classifier and the latest deployment is `SKIPPED`, so no boot log. **To verify before implementing:** if the flag is off on prod, the modal is promising an outcome that never happens, and the rebuilt surface must say so.

**D · 19 modals.** Under "the grid IS the page", the images tab is a modal maze: preview, publish-preview, cross-channel, schedule, approvals, rollback, editor, DAM picker, lifestyle, duplicates, drift, bulk-apply, scope-upload, columns, copy-to-markets, copy-to-variants, export, picker, lightbox. Consolidation is the single biggest UX win available — and the biggest risk of losing a capability. My plan consolidates *containers*, never capabilities.

**E · No image/thumbnail cell renderer exists in `design-system/grid/renderers/`.** The DS has a `Thumbnail` component but the grid has no media cell. → cross-lane request to **PES.2** (substrate owner).

**F · Adjacent, not mine:** `apps/web/src/app/products/[id]/images/ImagesClient.tsx` is a separate legacy page on the older `listing-images` CRUD routes. Out of lane; flagging only so no one assumes PES.7 covers it. The flat-file image modal (`ebay-flat-file/EbayFlatFileImageModal.tsx`) is **untouchable** and calls `/ebay-images/publish` + `/products/bulk-image-publish` directly — the rebuild must not change those route contracts.

---

## §5 Where a grid fits (and where it does not)

| Surface | Substrate | Why |
|---|---|---|
| Amazon Colour × Slot matrix | **NexusGrid** (needs media cell + a DnD spike) | Rows × named columns is literally a grid. Buys column customise via the ONE DS `PreferencesModal`, server-persisted layout via `useGridState`→`SavedView`, range selection for bulk ops, real filters — replacing `MatrixColumnsModal` + `matrixColumnPrefs` localStorage + `MediaViewsMenu` + `MatrixFilterBar` + `bulkSelection.ts`. **Risk: HTML5 drag-drop of image tiles inside a virtualised grid. Spike first (P1), fall back to a DS-styled non-AG matrix if it does not hold.** |
| eBay bucket × position grid | same (shared component, as today) | identical shape |
| Shopify variant assignments | same, small | colour → image |
| Publish history · audit log · recent jobs · scheduled list | **NexusGrid** | plain row data, wants sort/filter |
| Ads: Campaigns · Search Terms | **NexusGrid** | real tables |
| Analytics: per-channel breakdown | **NexusGrid** | real table |
| Activity/Timeline feed | **NexusGrid** (tree rows for batch-expand) | batch row → per-field delta children is a grid tree |
| Master gallery · Shopify pool | **NOT a grid** — DS gallery of DnD tiles | ordering by drag is the interaction |
| DAM picker · duplicates · lightbox · editor · previews | **NOT a grid** — DS Modal/Drawer | browsing and compositing, not tabular |
| Per-image detail (metadata, alt, back-refs, publish status, history) | **PES.4 Drawer pattern** | full-bleed viewing stays a lightbox; the *detail* panel should be the shared drawer |

---

## §6 Proposed phase plan

Implementation of P1+ starts when **PES.1's `_studio/` frame lands** (it does not exist yet). P0 and the P1 spike need no frame.

| Phase | Scope | Gate |
|---|---|---|
| **P0** ✅ | This inventory. | Owner approval |
| **P1 · Spike + substrate contract** | Prove image-tile DnD + desktop file-drop inside NexusGrid cells against the real workspace payload. Decide grid vs DS-matrix on evidence. File the PES.2 request for a media/thumbnail cell renderer + the PES.4 request for an image-detail drawer slot. No product code. | Report the spike result before P2 |
| **P2 · `_studio/images/` skeleton + master scope** | Scope-aware images frame inside PES.1's tabs. Master gallery written fresh on DS (upload, DnD, delete, inline edit, multi-select, primary, apply-to-children, scoped upload, bulk-apply, duplicates) + video section. Image viewer as a DS Modal; its detail pane on PES.4's drawer. Editor, DAM picker, lifestyle generation as DS Modals. | Verify on XAVIA (GALE) |
| **P3 · Amazon scope** | Matrix on the P1-chosen substrate. Cascade resolution re-derived from the rules in §2.2 and re-tested from scratch. Filter/columns/views consolidated into the ONE DS `PreferencesModal` + `useGridState`. Preview, publish bar, mirror controls, stale banner, live strip + drift, export. **Consume `resolvedAxes` + `axisValueCounts` (finding B).** Amazon-global honesty per D1. | Verify on XAVIA |
| **P4 · eBay + Shopify scopes** | One new channel grid on the same substrate; eBay bucket semantics + 12-cap preserved; Shopify pool gallery + assignments. Validation/stale/preview/jobs banners on DS `Banner`. | Verify on XAVIA |
| **P5 · Publish machinery** | Action bar → DS pattern. Cross-channel planner, schedule, approvals, rollback, auto-publish, health cards, history, audit log. Every browser-local surface keeps saying so (§2.6). Schedule surface reflects the finding-C answer. | Verify on XAVIA |
| **P6 · `_studio/ancillary/`: Analytics · Ads** | Written fresh on the DS. Tables → NexusGrid. Sparkline → DS (`PerformanceGraph`/`BenchmarkBar` if they fit; otherwise a DS-tokened sparkline — **no new chart dependency**). Metric tiles → DS `MetricStrip`. Same endpoints, same fields, no new features. | Verify on XAVIA |
| **P7 · `_studio/ancillary/`: Activity** | Written fresh on the DS against **TimelineTab's** capabilities (the live one); batch rows as grid tree. Disposition of dead `ActivityTab.tsx` per D3. | Verify on XAVIA |
| **P8 · Parity audit** | Capability-by-capability diff of this document against the built surface; numeric chrome parity vs `/products/next`; both themes; i18n key coverage (140 existing keys reused, new strings added to the same namespace). | Report |

Constraints held throughout: nothing committed · placeholder/KEEP surfaces preserved and labelled · old `tabs/images/**` untouched until the Owner's swap · verification writes only to the XAVIA test family · stay inside `_studio/images/` and `_studio/ancillary/`.

---

## §7 Decisions — RESOLVED (Owner + PES.0 hub, 2026-09-01)

- **D1 — OVERRIDDEN, and better than my recommendation.** The per-market Amazon image model
  **STAYS in full** (5 market tabs, per-market rows, copy-to-markets, per-market publish loop).
  Owner's reason, which I did not have: **image TEXT is localized per EU market**, so a single
  global image set would lose real content. The hub then established the mechanism landscape:
  (a) SP-API Listings image attributes **are** ASIN-global even with a marketplace_id selector,
  so the honest **cross-market publish preview is mandatory** on that path; (b) Amazon's
  **Country-Specific Upload** now exists for exactly this case — localized images on the SAME
  ASIN, filename convention `<ASIN>.main` / `<ASIN>.pt01…`, Seller Central self-service;
  (c) **A+ Content** is per-marketplace/language and is the sanctioned home for embedded
  localized text. Global-collapse (my option c) is DROPPED.
  → **P3 gains a sub-study:** is (b) automatable via feed/API, or operator-assisted? If
  operator-assisted, the rebuilt Export-ZIP emits the country-specific naming convention with a
  guided flow, **and the per-market publish UI must say which mechanism each market's set rides**
  (global SP-API · country-specific upload · A+). That last clause is the honesty requirement
  that replaces my advisory.
- **D2 — approved.** Substrate decided by spike, not assumption. §10 is the result.
- **D3 — approved as recommended.** `tabs/ActivityTab.tsx` stays dead and untouched now;
  revert-a-field is ported later.
- **D4 — answered by the hub:** the prod scheduled-image-publish cron is **disabled**, and the
  table holds **zero rows**. So the schedule surface must say, on screen, that a scheduled publish
  will not fire until the cron is enabled — it cannot present a pending badge as a promise.

## §8 Frame integration (PES.1 contract, read 2026-09-01 from docs/pes-claims.md)

PES.1 publishes `_studio/contracts.ts` (not yet written on disk — only `_studio/sheet/channel/types.ts`
exists so far). PES.7 fills three `<StudioTabHost>` slots: **`images`**, **`analytics`** (= Analytics·Ads)
and **`activity`**, and consumes `useStudioScope()`.

Consequence for the images rebuild: **the tab's own channel strip disappears.** Today `ImagesTab`
renders its own Master/Amazon/eBay/Shopify tabs with completeness pills, needs-publish pills and
unsaved dots — a second tab strip competing with the frame's scope bar. Under PES.1's frame, scope
comes from `useStudioScope()` and the images panel renders the ACTIVE scope only. The three signals
those pills carried (per-channel completeness %, unpublished count, unsaved count) must not be lost:
completeness belongs on the frame's readiness chips, and unpublished/unsaved belong in the images
panel's own header. Called out here so the capability survives the container change.

The axis selector ("Group by") is images-specific and stays in the panel — it is not a scope.

---

## §9 Build rule (Owner, 2026-09-01, mid-P1)

> *"We are actually building everything from scratch. We must not make use of anything that already
> exists in the UI, especially the UI."*

**How PES.7 applies it:**
- **Nothing under `tabs/images/**` or the ancillary tabs is imported, copied, reskinned or wrapped.**
  Not the components, not the hooks, not the pure modules (`bulkSelection`, `crossMarketCopy`,
  `variantCopy`, `groupCoverage`, `videoValidation`, `matrixColumnPrefs`, `useAmazonImages`), not
  `types.ts`, not `api.ts`. `_studio/images/` and `_studio/ancillary/` import from `design-system/**`,
  PES.1's `_studio/contracts`, and the API — and from nothing in the old tree.
- **The old tree is READ as specification, never as source.** §2/§3 of this document is that
  specification: every capability, every rule (eBay's 12-image per-variation cap, the one-bucket
  no-de-dupe rule, the Amazon cascade order variation > group > product, Shopify's 250 pool /
  position-0-featured, the slot taxonomy MAIN→PT→PS→SWCH) is written down here so it can be
  re-derived and re-tested from scratch without a single import. Behaviour is preserved; code is not.
- **The DS is not "existing UI" — it is the substrate.** The rebuild programme's whole premise is
  Nexus DS + AG Grid Enterprise, so `design-system/primitives|components|patterns|grid` is what
  PES.7 builds FROM. `@/components/ui/**` (the legacy Tailwind kit) is existing UI and is out.
- **Every rule gets its own new test.** Re-deriving pure logic without the old tests would drop the
  correctness those tests encode, so each rule listed above lands with a fresh vitest of its own.

**Consequence for the ancillary tabs:** the original brief said "port, DS-align — surgical, no
feature invention". Under this rule that becomes: *write fresh on the DS, same endpoints, same
fields, same capabilities, no feature invention.* The restraint was never about copying markup — it
was about not inventing scope. That still holds.

---

## §10 P1 spike result — the media-matrix substrate (measured 2026-09-01)

Harness: `apps/web/src/app/design/grid-lab/media-spike/` (temporary, deleted after P3 starts).
16 slot columns × 7 rows on `NexusGrid`, three interaction models built side by side, every
gesture logged and every verdict READ from the DOM rather than judged from a screenshot.

### Verdicts

| Q | Question | Verdict |
|---|---|---|
| Q1 | `dragstart` fires on a cell's own child inside an AG cell | **Yes** — `dragstart:Giallo/SWCH` logged; HTML5 DnD initiates normally |
| Q2 | AG's cell-range selection stays out of the gesture | **No** — a range is created on the same drag, in BOTH the HTML5 and pointer models. React's `stopPropagation()` on `pointerdown` does not stop it: **AG listens on `mousedown`**. Fix: `cellSelection: false` on the matrix — re-measured with it off, `.ag-cell-range-selected` count is **0** and the drag is clean |
| Q3 | a desktop file dropped on a cell reaches the cell | **Yes** — `dragover` + `drop` both handled, `dataTransfer.files` arrives intact |
| Q4 | a far-right column is reachable | **Yes** — columns are horizontally virtualised and the window updates correctly on a real scroll |
| Q5 | a column header can take a drop | **Yes** — a custom `headerComponent` receives `dragover` + `drop`, so column-fill works |

### 🔴 The finding that shapes P3: a picture cell needs an explicit refresh contract

A cell whose content is an image has **no value**, so AG's change detection has nothing to compare
and **never repaints it**. Measured: a file dropped on `Blu/PT07` ran the handler and updated React
state, and the cell still showed empty — `filled="0"`, `origin="empty"`. A forced
`api.refreshCells({ force: true })` alone painted it (`filled 0 → 1`, `origin empty → own`), proving
the state had been correct all along and only the repaint was missing.

Worse, the drags in the same session *did* repaint — accidentally. Picking a tile changes `picked`,
which changes the `ctx` object, which rebuilds `columnDefs`, which makes AG re-run the whole column
model. That is exactly the anti-pattern `reference_ag_react_inline_options_rerun_column_model`
warns about: it looks like it works, and it is re-running the column model on every gesture.

**So the media matrix needs a deliberate contract, not a default:** the cell's value must encode the
picture (url + origin + pending), so AG's own change detection drives the repaint, and
`columnDefs`/`cellRendererParams` must be genuinely stable — handlers reached through a ref or
context, never through a freshly-built params object.

### Two more measured traps
- **An absolutely-positioned cell overlay escapes its cell.** `position:absolute; inset:2` inside an
  AG 36 cell resolves against an ancestor, not the cell: cells stacked **diagonally**, each 84px (one
  row height) below the last. A picture cell fills its cell as a normal flex child.
- **Writing `scrollLeft` on the grid's viewport does not inform AG.** It scrolls the DOM and moves the
  headers, but AG never recomputes its rendered column range, so far-right columns appear to "never
  render". I nearly recorded that as an AG defect. A real user scroll renders them correctly. Probes
  must scroll the grid the way a person does (`reference_browser_probe_lies`).

### Substrate decision (D2)

**NexusGrid is the right substrate for the media matrix — with three non-negotiable conditions**,
all of them cheap and all of them now known before a line of P3 is written:

1. `cellSelection: false` on the matrix. Multi-cell selection for bulk ops is the matrix's own
   (click / shift-click on tiles), which also makes it keyboard-reachable.
2. The cell value encodes the picture, and the column model is stable across gestures.
3. **Pointer-drag, not HTML5 drag**, as the primary model — it was the only one whose round trip
   completed under measurement, and it carries the click-to-place fallback for keyboard users.
   Desktop file-drop keeps the HTML5 `drop` path, which works independently.

The PES.2 request in `docs/pes-claims.md` stands and is now specific: `MediaCell` must take its
picture from the cell VALUE and must not need a params rebuild to repaint.

---

## §11 P2 progress — master scope on the DS (2026-09-01)

Built at `_studio/images/`, mounted in PES.1's `StudioTabHost` images branch (one line inside their
file, which is the contract that file states). Nothing from the old tree is imported.

`types.ts` · `api.ts` · `useImageWorkspace.ts` · `images.module.css` · `master/MasterGallery.tsx` ·
`master/GalleryTile.tsx` · `ImagesTab.tsx` · `ImagesTabRoute.tsx`

**Verified on prod data** (GALE-JACKET `cmokmy3a40078pm0p1fvnu523`, the XAVIA test family):
24 master images render with real type / dimensions / size; "No alt text" is flagged; the axis
warnings the old tab dropped now surface at the top of the tab; selection, shift-range select and
the contextual action bar all work; tile heights are uniform (one distinct value, 221px).

Master writes report through the frame's `useSaveReporter()`, so the studio header's autosave state
speaks for image work exactly as it does for sheet edits — one indicator, one truth.

### Measured while building
- 🔴 **A bare Cloudinary URL serves the ORIGINAL.** 2250×2250 / 1.6 MB into a 165px tile, 24 of 24
  stuck downloading. The DS had the fix but kept it private inside `Thumbnail`, which is
  density-sized (max 56px) and unusable at gallery size. Extracted to
  `design-system/lib/cdn-image.ts` (`cdnSquare` / `cdnFit`); `Thumbnail` now imports it, unchanged.
  Sized rendition: **18 KB — 87× smaller.** Disclosed in the claims file for objection.
- ⚠ **`--nds-space-N` is literally N pixels**, not a t-shirt step. `space-5` is 5px. My first pass
  used the token names as a scale and came out cramped; the frame and sibling lanes use plain px.
- **A truncated number is worse than an absent one.** File size on the tile meta line clipped to
  "1." on narrow tiles. Size moved to the tile title; type + dimensions stay on the line.
- **The DS checkbox is 15px** — right for a form row, too small for a picture tile picked at speed.
  The control keeps its DS size; padding around it makes the hit area 29px. No fork.
- **Screenshots lied twice.** Product images on light grounds read as blank tiles in a downscaled
  page screenshot while the DOM said `naturalWidth: 2250`. Zoom or read the DOM; never conclude
  "not rendering" from a full-page capture (reference_browser_probe_lies).

### The viewer — BUILT and round-trip verified
`viewer/ImageViewer.tsx` + `viewer/viewer.module.css`. A picture is inspected near its own size, so
this needed a surface the DS did not have: `Modal` capped at `xxl` = 1040px x 82vh, which showed a
2250x2250 photo **smaller than the tile it was opened from**. Rather than hand-roll a lightbox
page-locally, `Modal` gained a `size="full"` step (`min(1680px, 96vw)` x 94vh, body unpadded and
non-scrolling so the media pane owns its own overflow) - additive, so all existing consumers render
byte-for-byte as before. Disclosed alongside the `cdn-image` extraction.

Measured on GALE-JACKET: the viewer opens at 1288x897 in a 1342x954 viewport, walks siblings with
arrow keys, and its detail pane carries alt text (editable, first field - 23 of 24 images had none),
type (the five values the API actually accepts, with a legacy value still selectable-as-current),
asset facts, analysis, and real channel back-references. The CE information sheet correctly reports
`AMAZON . PS01 . Giallo` and `. Nero` - a GPSR safety slot, which is exactly where it is used.

**The honest-UI test passed end to end:** typed an alt text, saved, then asked the SERVER what it
stored - `"CE user information sheet EN 17092-2:2020"`, matching the screen, the modal title, and
the gallery tile behind it; the Save button correctly went un-dirty; and the studio header showed
**"Saved 03:24"**, because the write reported through the frame's `useSaveReporter()`. The tab's
missing-alt count went 23 -> 22.

### Two more measured while building
- 🔴 **`aspect-ratio` is a preferred size, not a cap.** A portrait image (360x517) pushed an
  `aspect-ratio: 1/1` thumb to 234px against its 163px square and the gallery's rows went ragged a
  second time. `overflow: hidden` + `min-height: 0` make the square hold and give the image's
  `max-height: 100%` a definite height to resolve against. Verified: one distinct tile height.
- **A verification write left real data on prod**, deliberately: the alt text above is accurate and
  useful, on the sanctioned XAVIA test family. Said here rather than left for someone to find.

### Video — BUILT and round-trip verified
`master/VideoSection.tsx` + `master/videoChecks.ts` (+ 12 fresh vitest cases). The channel limits
were re-derived, not imported: container per Amazon A+/eBay/Shopify, >= 1280x720, 16:9 within
tolerance, <= 5 min, <= 150 MB (eBay's Vault ceiling, the lowest of the three, so the one that
binds).

**One deliberate improvement over the old rule:** a check whose input is missing returns `unknown`,
never `pass`. Dimensions and duration are NULL on rows predating the metadata backfill, and the old
module's `if (m.width && m.height)` silently skipped them — reporting a video as clean against a
resolution nobody measured. Four states now, and "unverified" renders as neutral chrome rather than
a warning, because an absence is not a problem the operator caused.

**Verified end to end on prod** by uploading a real 3s 1920x1080 H.264 clip to GALE-JACKET through
the actual UI: Cloudinary stored it, the API generated the `so_0` first-frame poster, the tile
rendered with poster + play + duration, and the checks read container MP4 / 1920x1080 / 16:9 / 3s /
71 KB -> pass. Then deleted it through the tile's own button and confirmed **server-side** that the
row was gone (videos 0) and the 24 images untouched. No test artefact left behind.

Caught in that pass: **a 71 KB clip printed as "0 MB"** — a size fixed to MB reads as an empty file,
not a small one. The formatter now scales B/KB/MB, with a test.

### Duplicate review — BUILT, real finding on real data
`master/DuplicatesModal.tsx`. The server clusters by two rules and names which applied: `exact`
(identical contentHash) vs `near` (both perceptual hashes within threshold). That distinction is the
operator's whole decision, so the modal states it in words — an exact pair is a re-upload and one
copy is safe to drop; a near pair may be two legitimately different shots. Nothing is pre-selected
and nothing is auto-deleted; each member carries the metadata needed to choose (type, dimensions,
size, added date, and a warning when it is the hero).

**On GALE-JACKET this found 3 near groups covering 7 of the 24 images** — three near-identical size
charts, and two jacket shots that on inspection genuinely differ. "Looks alike, not identical" was
the right framing for both. "Locate" verified: closes the modal, scrolls the right tile into view
(`z3uh3w`) and flashes it.

### Apply-to-children — BUILT, deliberately NOT executed
`master/ApplyToChildrenModal.tsx`. 🔴 The API's own default is the destructive one:
`POST /images/apply-to-children` falls back to `mode: 'replace'`, which DELETES every image on every
child before copying. On GALE-JACKET that is 20 children.

This surface does three things the endpoint does not: it **always sends an explicit `mode`** so the
server's destructive fallback can never be reached by omission; it defaults the operator's CHOICE to
`append` and states in words what each mode does to what the children already have; and it names the
blast radius before commit. Verified: the button reads "Apply to 20 SKUs", `append` is pre-selected,
and choosing `replace` puts a `role="alert"` in front of a second, specifically-labelled
"Replace images on 20 SKUs" button.

**The write was deliberately not executed.** Appending 24 images to 20 children creates ~480 rows on
a live product, and running that to prove a button works is disproportionate to what it would tell
me. The gating is verified; the cascade itself is not, and this says so rather than implying it is.

### In-app editor — BUILT (crop / rotate / flip)
`editor/ImageEditor.tsx`. The result is a NEW row (`derivedFromImageId` -> source), a Cloudinary
transformation over the original bytes — nothing is re-uploaded and nothing is destroyed, which is
why it needs no confirmation. Crop is dragged on the image with aspect presets (Free / 1:1 / 4:3 /
4:5), stored as FRACTIONS of the source and converted to source pixels only on save.

Two refusals the surface states up front instead of collecting a 400 from the API:
- **A derivative cannot be derived from.** The server needs the source's Cloudinary `publicId`, and
  a derived row's is NULL by design. Save is disabled with the reason in words.
- **A crop needs recorded dimensions** to convert fractions into pixels. Where they are NULL the
  crop control is replaced by a sentence saying so; rotate and flip still work.

🔴 **The preview is GEOMETRIC (CSS), deliberately not a reproduction of the server's Cloudinary
URL.** `buildDerivedUrl` lives in `cloudinary.service.ts`; a client-side copy would be a second
implementation of the same rule, and the day they drift the preview starts lying about what will be
saved. Geometry — the rectangle, the quarter-turn, the mirror — is what the operator is choosing,
and CSS shows that exactly; the pixels come from the CDN over the original.

### 🔴 A load-state bug found by verifying, not by reading
The tab could sit in "Loading images…" **forever** — no error, no retry, no explanation. The
resource timeline showed exactly one request, status 0 after 5ms, and nothing after it.

Cause: the hook aborted the previous request on every effect run, and the aborted branch returned
early WITHOUT setting state. If the run that was meant to replace it never landed its own fetch,
nothing ever wrote state again. A permanent silent spinner is the worst failure this tab can have —
it is indistinguishable from a page that is about to finish.

Fixed by removing the abort entirely: a **generation counter** now decides which response may write
state, so a superseded response is IGNORED while its request still completes (and warms the cache
for the run that replaced it). There is no longer a path where every load is cancelled and nothing
lands. Two honesty additions alongside it: after 4s the loading state says it is still waiting and
offers **Retry**, and the error state carries **Try again** — a dead end is never acceptable.

### Verification environment note (shared tree)
Mid-session the dev server on :3000 became a SIBLING session's, built with
`NEXT_PUBLIC_API_URL=http://localhost:8091` — their local API. My earlier verifications (24 images,
the alt-text round trip, the video upload/delete, the duplicate groups) all ran against PROD and
stand. Later checks did not: that local API is currently hanging on most routes — `/auth/csrf`,
`/connections`, `/sidebar/counts`, `/readiness` and `/images-workspace` all pending, app-wide, not
just this tab. Next refuses a second dev server for the same directory, so I could not stand up my
own on another port without killing a sibling's, which I did not do.

**Consequence, stated rather than glossed:** the load ERROR state is typechecked and reasoned but
not exercised against a live API; the slow-path retry affordance was observed rendering. The
editor's save path was later verified in full — see below.

⚠ The local API on :8091 is on the **PROD database** (it returns GALE-JACKET's 24 images, 81
listing rows, and the alt text written earlier through the prod API). Writes through it carry the
same weight as writes to prod — reference_local_handler_writes_prod_db, confirmed again here.

### 🔴 The crop was measuring the wrong rectangle — three spaces, not one
A SQUARE drag on a SQUARE photo reported **866×1401**. Three attempts to fix it by rearranging CSS
produced three different wrong answers, because the bug was arithmetic, not layout. There are THREE
rectangles in the editor and they are all different:

| | measured on a 2250×2250 photo |
|---|---|
| frame — the positioned container the overlay draws in | 1319×742 |
| element — the `<img>` box inside it, offset 288px from the frame's left edge | 742×742 |
| picture — what `object-fit: contain` painted inside that element | 742×742 |

The first attempt measured the element box (letterboxed, so horizontal fractions were wrong); the
second made the element fit the picture and it overflowed the frame instead (a percentage
`max-height` against an auto-height parent does not constrain); the third computed the letterbox but
subtracted element-relative offsets from the frame's origin.

**Fixed by extracting the arithmetic into `editor/cropGeometry.ts` and PROVING it** — 14 vitest
cases including a regression test that replays the exact drag which produced 866×1401 and asserts a
square result. Dragging at a browser to check geometry was the wrong tool; the loop was slow, flaky
(the modal dismissed itself twice) and never told me *which* of three rectangles was wrong. The
component now only wires DOM rects into the tested functions.

Confirmed in the browser afterwards: the same drag reports **1213×1213**, square, matching
`round(400/742 × 2250)` exactly, with the crop box landing precisely where it was dragged.

### Editor save path — VERIFIED end to end
Cropped, saved, then asked the server what it stored: a new row at **1213×1213** — the number the UI
showed — with `derivedFromImageId` set, `publicId` NULL by design, and the CDN URL carrying
`c_crop,h_1213,w_1213,x_303,y_305`. The gallery went 24 → 25 tiles and the new tile carried its `✎`
derived mark.

The stated refusal was then verified on that very row: opening the editor on a derivative shows
*"This image is itself an edit of another one, so it has no stored original to transform"* with Save
disabled — the 400 the API would have returned, said before the work instead of after it.

Cleaned up: the derivative was deleted through the gallery's own control and the server confirmed
back to 24 images, 0 derived rows, 0 videos. No test artefact left.

### DAM picker — BUILT, and it found a LIVE production defect
`dam/DamPicker.tsx` + `dam/assetId.ts` (+ 5 vitest cases).

🔴 **`Import from DAM` is broken in the shipped UI.** `GET /assets/library` returns a MERGED view of
two tables and PREFIXES the ids to say which — `da_<id>` for a `DigitalAsset`, `pi_<id>` for another
product's `ProductImage` (assets.routes.ts:574,605). `POST /images/import-from-dam` takes a RAW
`DigitalAsset.id` and does a plain `findUnique`, with no prefix handling. The shipped
`tabs/images/DamPickerModal.tsx:189` posts `asset.id` unmodified.

Proven on prod, both directions: the prefixed id returns **404 ASSET_NOT_FOUND**; the same id with
`da_` stripped returns **201 Created**. So importing from the DAM fails every time in the live UI.
Reported to the hub. The rebuild strips the prefix, and `assetId.ts` exists so the rule has a test
rather than a comment.

The picker asks the server for `sources=digital_asset` (verified honoured — 0 `pi_` rows leak),
because a `pi_` row cannot be imported through that route and offering it would be an affordance
that cannot work. On GALE-JACKET: 4,626 DAM-side images, scoped by brand (Xavia) and product type
(OUTERWEAR), each card showing where the asset is already used — the reason to reuse rather than
re-upload.

### 🔴 Three routes, three different response shapes — and the bug that cost
The first import SUCCEEDED on the server and the UI silently ignored it: 25 images stored, button
still reading "Add", gallery still showing 24. The write landed and the screen said nothing, which
is the same failure class as the permanent spinner — a lie by omission rather than by statement.

Cause: `import-from-dam` NESTS the row (`{ ok, image, reused }`) while `POST /images` and
`POST /videos` return it at the TOP level. My code read `data.id` on a payload whose id lives at
`data.image.id`, so the success branch never ran. I had actually hedged for this shape in a
throwaway probe an hour earlier and then did not carry it into the component — assuming a shape
instead of reading the route.

Fixed by transcribing all three shapes into `types.ts` from the routes themselves, once, with the
non-uniformity called out. Two honesty improvements fell out of doing it properly:
- a 2xx in a shape the client cannot read now SAYS so ("accepted, but the response could not be
  read — reload to see it") instead of discarding the write silently;
- `reused` is respected — a byte-identical re-upload or an already-linked asset reports "already on
  this product" rather than painting a tile the product does not have.

Re-verified after the fix: button reads **Added**, server 25, gallery 25, count line "25 images",
header **"Saved 05:36"** through `useSaveReporter()`. Every test row was then deleted through the
UI's own controls — server confirmed back to 24 images, 0 videos, 0 derived rows, 0 artefacts.

### Lifestyle generation — BUILT, and it found a second live defect
`ai/LifestyleGenerator.tsx`. Every bound the route enforces is enforced first in the client — prompt
10-2000 chars, the five aspect ratios Imagen actually accepts — so a 400 is never how an operator
learns a rule the client already knew. Verified: empty and 5-char prompts disable Generate ("5 of at
least 10"), 58 chars enables it, 2050 disables with "50 over the limit", and all five ratios are
offered. The result is saved as a LIFESTYLE master image with its provenance recorded in the alt
text, so a generated scene stays identifiable from the DATA and not only from the surface that made
it.

🔴 **Lifestyle generation is broken on prod.** The configured model is unavailable to this key:
*"models/imagen-3.0-generate-002 is not found for API version v1beta, or is not supported for
predict."* Every attempt 502s and nothing is created. The old tab has the same modal, so this is a
live product defect, not a rebuild one. Reported.

### 🔴 The API client was hiding every server explanation
Finding that defect only worked because the surface showed the server's sentence. On the first
attempt it did not — it showed **"GENERATION_FAILED"**, the machine code, because `readError`
preferred `error` over `message`. These routes answer with BOTH, and preferring the code discarded
the one sentence that says what is actually wrong and who can fix it.

This was not a lifestyle-only bug: it silently degraded **every** error in the tab — the DAM 404
would have read "ASSET_NOT_FOUND", the upload dedup gate a bare code. A code is a token for a log; a
message is for the person reading the screen. Now `message` wins, with the code appended in
parentheses when it adds something the sentence does not already carry, because that pairing is what
someone filing a bug needs. Verified: the refusal now reads the full Imagen sentence followed by
"(GENERATION_FAILED)".

### P2 master scope — COMPLETE
Gallery (upload, DnD reorder, delete, hero, shift-range select, drag-drop from desktop) · full-bleed
viewer with editable alt text and channel back-references · video with its own channel checks ·
duplicate review · apply-to-children · crop/rotate/flip editor · DAM picker · lifestyle generation.
All verified against prod data on GALE-JACKET, with every test artefact removed afterwards.

### Proposed re-scope: the last two P2 items belong to P3
`scoped upload` and `bulk-apply` are both CHANNEL-TARGETING surfaces — they choose Amazon slots and
axis values and fan out into the channel layer. Building them now would mean inventing a slot picker
that P3's matrix is about to make redundant, and the honest version of either needs
`amazonSlotTaxonomy` (inventory §4 finding B) rendered as a real column set. Recommend they move
into P3 alongside the matrix, where the targeting UI actually exists. Master scope stands complete
without them.

### DS fork mirror (hub ruling #34)
The two DS changes broke `check-ds-fork-drift`: `apps/factory` carries a byte-identical copy of the
DS, so a fix applied to web only is not applied to the platform — the exact mechanism that once left
46 factory modals without an accessible name. Mirrored `components/Modal.tsx`,
`components/Thumbnail.tsx`, `lib/index.ts` and the new `lib/cdn-image.ts` into
`apps/factory/src/design-system/`, plus the `.nds-modal.full` block into factory's
`styles/components.css` — that file diverges by token namespace between the apps and is NOT in the
drift set, but without the block factory would have had a `size="full"` prop with no styles behind
it. Guard: **106 shared files, 9 differing (was 12), no new drift.** Web typecheck 0 errors.

🔴 **A gap the guard does not cover, found while mirroring:** factory's DS copy does not COMPILE,
independently of drift. `components/Thumbnail.tsx` imports `../grid/hooks/useGridDensity` and
factory has no `grid/` folder at all; `components/index.ts` re-exports `BurnDownChart`,
`AccountSwitcher` and `AccountsPanel`, none of which exist there. Six pre-existing errors, none
introduced by this mirror (verified: zero mention `cdn-image` or `Modal.tsx`). The guard checks
byte-identity of shared files and would stay green while the factory copy did not build. Reported
to the hub; not PES.7's to fix.

**Dock constraint for the detail pane (PES.0 ruling #26, from PES.4's measurement):** inside the
dock, `position:absolute` popups are CLIPPED by the track — a DS Tooltip painted 47px past the edge,
visible but not hit-testable, with no error anywhere. `position:fixed` escapes cleanly. So the
detail pane uses only portalled+fixed DS components (Menu, Listbox, InfoTip qualify; **Tooltip and
HoverCard do not**), gives itself explicit `height: 100%` (the track is a flex item —
`align-self: stretch` does nothing), and is verified against the REAL track, not a replica.

---

## §12 P3 — the Amazon matrix, on the real substrate (2026-09-01)

`channel/amazon/` — `cascade.ts`, `matrixModel.ts`, `AmazonMatrix.tsx` (+ 34 vitest cases).
Logic first, wiring second: the crop-geometry lesson is that a wrong cascade and a wrong rectangle
look identical on screen, and neither is diagnosable by clicking at it.

**Live on GALE-JACKET . Amazon . IT:** 2 colore rows + the shared bucket, **16 slot columns from the
server's own taxonomy**, 65 rows resolved, 29 pictures rendered. The three spike conditions verified
in the shipped surface rather than assumed: a mousedown-drag across cells produces **0** range
highlights (`cellSelection` off), **0** cells contain an absolutely-positioned child (the
escapes-the-cell trap), and every picture requests a sized rendition (`/upload/w_168,c_fit,...`) —
no tile can pull an original, which in a matrix would multiply by rows x columns.

### The slot set is finally the server's
`amazonSlotTaxonomy` — the fourth dropped field from §4B — is now the column set. GALE-JACKET
(OUTERWEAR) renders its real **16** slots including the GPSR safety locators; the eBay listing
shells resolve **10**. A hardcoded list cannot be right for both. When the server omits the field
the legacy 10 are used and the matrix SAYS so, because an operator deciding whether a slot exists
should know when the answer is a guess.

### 🔴 16 rows claim PUBLISHED and hold no image
Measured on prod: 16 of GALE-JACKET's 65 Amazon rows have an empty `url` **and no
`sourceProductImageId`** — they point at nothing — and the shared MAIN row among them says
`publishStatus: PUBLISHED`.

The cascade STOPS at such a row rather than falling through. Inheriting past it would paint the
shared picture into a slot that publishes nothing, which is precisely the lie the matrix exists to
prevent: what the matrix shows must be what a publish would send. The count is surfaced as a
matrix-level notice — *"16 slots are marked published on Amazon but hold no image"* — with the
reason attached.

### The axis names the rows; the rows keep their own key
`resolvedAxes` calls the axis **"Colore"** while every stored row buckets under
`variantGroupKey: 'Color'` — exactly what the server's own axis warning says. Matching on the
display name finds nothing and paints an empty matrix over 50 real rows, so the join is on the
VALUE. A stored bucket the axis no longer declares is surfaced as an orphan row rather than dropped:
a picture that exists on the channel must appear somewhere.

### A DS gap, reported not forked
The media cell resolves `empty` before `warned` (and `mediaCellTitle` does the same), so a `warn` on
a cell with no `src` is unreachable — the tile reads "No image yet" and the contradiction vanishes.
That precedence is right for the case it was written for (an empty locked slot should read "nothing
here"), so PES.7 did not fork it. The count is surfaced at the MATRIX level instead, where one
sentence beats the same fact spread across sixteen tooltips.

### Cell editing — placement round-tripped on prod
`edits.ts` (19 cases), `useMatrixEdits.ts`, `SlotPicker.tsx`. `bulk-save` has two edges that are
invisible from the call site, and both are now pinned by tests:

- 🔴 **An upsert WITHOUT `id` CREATES.** The route does not reconcile by coordinate. Writing to a
  cell that already owns a row without carrying that row's id silently produces a SECOND row at the
  same (bucket, slot, market), and the cascade then picks between them arbitrarily.
- 🔴 **Every upsert resets `publishStatus` to DRAFT and clears `publishError`.** Editing a live cell
  un-publishes it — correct, because the picture on Amazon is no longer the picture here, and the
  tile must be seen to leave `live` rather than keep a green tick over changed bytes.

The rule between them: **pinning is not editing.** A cell showing an INHERITED picture owns no row,
so writing to it CREATES one for that bucket — updating the row it inherits from would repaint every
bucket that shares it. One drop on Nero must not repaint Giallo.

**Verified end to end on GALE-JACKET · Amazon · IT.** Placing into Nero/PT07 (a *pictureless* slot
whose only row was the all-markets phantom) pinned a NEW `MARKETPLACE`/IT row rather than editing the
`PLATFORM` row — because an edit made while viewing IT must not change every market. Rows 65 → 66,
no duplicate at the same layer. The tile read *"Pinned on this row — it no longer follows · Amazon ·
IT · Queued to publish"*, **Giallo/PT07 stayed untouched**, and the phantom notice recounted 16 → 15.
Clearing through the picker took it back: 66 → 65, notice back to 16, no artefact left.

⚠ Honestly stated: the **inherited-cell refusal** ("clearing here would remove it from every
bucket") is covered by unit tests but was NOT reachable in the browser on this product — every
bucket owns its rows wherever pictures exist, so no cell currently resolves as inherited. It wants a
live pass on a product that does.

### Pointer-drag and file drop — BUILT
`useTileDrag.ts` + the matrix's `onFileDrop`. Drag feedback is applied by TOGGLING CLASSES ON DOM
NODES rather than through React state, and that is deliberate: a pointermove fires dozens of times a
second, and routing each through state would re-render the matrix and rebuild `columnDefs` — the AG
column-model churn the spike exists to avoid. The grid stays completely still during a drag; two
class names move. Listeners live on `window` so a pointer released outside the grid still ends the
session, and `pointercancel` is handled so a browser gesture cannot leave a tile dimmed forever.

The drop feedback is an INSET ring on the AG cell, never an outline or a positioned overlay — an
absolutely positioned child escapes an AG cell entirely, and an outline is clipped by the cell's
bounds.

A desktop file dropped on a cell uploads to the MASTER gallery first, then places it. A channel row
REFERENCES a picture rather than owning bytes, so there has to be a master row to point at; the
other order would leave a listing row pointing at nothing if the upload failed.

**Verified:** the drag session marks the source, tracks and marks the target across cells, clears
both on release, and fires the write. ⚠ Verified with DISPATCHED pointer events — a CDP
`left_click_drag` did not reach these listeners, which is a probe limitation rather than a product
one (the same listeners serve a real pointer), but it means the human gesture itself is unproven
and wants a manual pass.

### 🔴 The shared API went down mid-verification — and that turned out to be the useful test
`127.0.0.1:8091` (a sibling's, hub-owned) stopped answering partway through. The write could not be
round-tripped, but it proved something better: with the server gone the matrix SAID so rather than
failing silently — the refusal surfaced in place, next to the cell.

It surfaced as **"Failed to fetch"**, which is the browser's words and tells an operator nothing.
Fixed by the same rule the hub ratified one level down: a network failure now reads *"The server
could not be reached — the request was not sent, so nothing changed."* with the raw cause in
parentheses for a bug report. Saying "nothing changed" matters — after a failed write the operator's
first question is whether it half-landed.

### Publish gating — the logic, built while the API was down
`publishPlan.ts` (+ 12 vitest cases). This is the only surface in the tab that reaches a real
marketplace, so the gating is pure and tested rather than assembled inside a component. Contracts
transcribed from the routes, not assumed:
`GET /amazon-images/validate` -> `{ hardFails, softWarnings, blockedAsins, summary }`,
`GET /listings/publish-readiness` -> `{ amazon: { enabled, mode, liveReady }, ... }`.

Three rules, each from programme law rather than invented:
1. **Preflight first.** Validation runs before publish is offered. Hard fails (MAIN_MISSING,
   IMAGE_TOO_SMALL, URL_INVALID) block the ASINs they name; the publisher already skips those, so a
   partial submission is legitimate and is described AS partial — "Queue 3 of 4 ASINs".
2. **Dry run is the default.** A live submission is an explicit, separate choice.
3. 🔴 **The mode comes from the SERVER** (`getAmazonPublishMode()` via publish-readiness), never
   re-derived in the browser and never assumed live. `null` readiness is treated as UNKNOWN — not
   live, not gated — and refuses to offer a submission it cannot describe, because guessing either
   way is wrong in a different direction.

Two wording rules are enforced by test. **Nothing ever says "published"** — an Amazon feed is
asynchronous, so the verb is "queue" and whether Amazon accepted it is what the feed-status poll
answers later. And **the gate and dry-run are separate facts**: an operator who has turned dry-run
off must still be told the server gate is closed, rather than having the important message silenced
by the less important one.

### Still to build in P3
The publish UI on top of `publishPlan` · preview / mirror / stale / live-strip · the two items moved
from P2 (scoped upload, bulk-apply).

**Blocked on the shared API (ruling #84), not on me:** the drag WRITE round trip, the file-drop
upload-then-place path, and a manual pointer-gesture pass. Per the standing constraint a live
Amazon submission will NOT be exercised at all — the gating is verified by test, and the dry-run
path is the most that should ever run from here.

---

## §13 🔴 Browser verification is blocked app-wide — measured 2026-09-01

The API came back, and browser verification still does not work. It is **not the server**.

**The measurement.** One tab, freshly loaded on the images matrix. Network after ~30s: **18 requests
to `127.0.0.1:8091`, 17 still `pending`.** Only the first `/notifications` returned 200. Among the
stuck ones: three `images-workspace` and three `readiness` — this tab's and PES.1's frame's.

**The negative control.** curl to the same endpoint from the shell: **200 in 0.84s / 1.0s / 1.6s.**

**The cause.** The API speaks HTTP/1.1 (`http_version: 1.1`), so Chrome allows ~6 connections per
origin. The app shell holds two permanently-open SSE streams (`/api/orders/events`,
`/api/listings/events`) and then polls `/api/sidebar/counts` (5 queued) and `/api/notifications` (3)
plus `/auth/csrf` and `/connections`. The pool is exhausted by streams that never close and polls
that never drain, so everything later queues without ever getting a socket. It also explains the
one-off 23.8s response earlier: that request was waiting for a CONNECTION, not for the server.

"Close other tabs" does not help — one tab does this to itself. This is not specific to this lane:
it hits PES.2's sheet, PES.4's drawer and PES.6's mapping equally, and any lane reporting "verified
in the browser" right now should check WHEN its request completed rather than that the page
eventually rendered.

**Not fixed here.** The candidate fixes — HTTP/2 on the dev API (cleanest; the per-origin cap
effectively disappears), suppressing the dev SSE streams, or slowing the shell's polls — all sit
outside this lane, and two of them change behaviour other lanes are testing against. Reported to the
hub, which holds environment authority.

**One thing this validates.** The tab behaved correctly throughout: "Loading images…", then after 4s
"Still waiting on the server" with a Retry, and never a claim of success. The honest-loading work
from §11 is what made this diagnosable instead of looking like a hang — which is the argument for
that work better than anything written at the time.

### Re-verification queue — two of three CLEARED (after PES.1's stream gate)

**Drag WRITE round trip — VERIFIED.** Dispatched pointer session from Nero/MAIN to Nero/PT07:
Amazon rows 65 -> 66, the target gained a `MARKETPLACE`/IT row with a url and status **DRAFT** (the
publish reset, as documented), the pre-existing PLATFORM phantom untouched, and the SOURCE left in
place — correctly a COPY rather than a move, because the source's picture belongs to the all-markets
layer and deleting it would strip every market. Cleared back to 65 through the picker.

**File-drop upload-then-place — VERIFIED.** A generated 1200×1200 PNG dropped on Giallo/PT08:
master images 24 -> 25 with the dimensions captured, Amazon rows 65 -> 66, and the new listing row
carries **`sourceProductImageId` = the master row just uploaded**. That reference is the whole point
of the dependency order — the channel row points at a master row that exists, rather than at bytes
that might not have landed.

**Manual pointer gesture — NOT verifiable with this harness, now MEASURED rather than inferred.**
Instrumented `window` during a CDP `left_click_drag`: **5 pointermove and 5 mousemove, but ZERO
pointerdown and ZERO pointerup.** The harness's drag never presses or releases the button, so
`onTilePointerDown` is never reached. That is a probe limitation, not a product one — the same
listeners serve a real pointer, and the full session is verified through dispatched events — but a
human drag remains genuinely unexercised and wants one manual pass.

### ⚠ The pool is still degraded, and the UI went stale because of it
Workspace request durations in one session: 3.9s, 12.9s, 2.9s, 0.6s, 1.2s, **103.8s**, 17.9s, 1.0s,
0.1s, 1.2s, 0.5s, 4.9s. After the file drop the matrix header still read "65 placed" while the
server held 66 — the post-write refetch was in flight behind the queue. Per ruling #96 the remaining
legacy eaters (orders stream, sidebar/notification polls) are still being gated by PES.1, so this is
reported and left alone rather than re-diagnosed.

Nothing was mis-stated by the UI: it showed the last state it had actually received. Refetch-over-
optimistic-patch means a slow pool makes the screen LATE, never wrong.

**Prod confirmed back to baseline after every test:** 24 master images, 0 videos, 0 derived rows,
65 Amazon listing rows, 0 leftover MARKETPLACE rows, and the one disclosed alt-text keep intact.

---

## §14 Publish panel — built, preflight verified against prod (2026-09-01)

`PublishPanel.tsx` + `usePublishGate.ts` on top of `publishPlan.ts`. The panel renders the pure
plan's decision and adds no judgement of its own.

Preflight runs on OPEN, not on tab load — it walks every ASIN's resolved plan, and most visits to
this tab are not about publishing. Readiness and preflight are fetched as SEPARATE calls and held
separately, so one failing cannot hide the other's answer, and the error says WHICH refused
("Preflight: ..." vs "Publish settings: ...") — sending an operator to the wrong place is its own
kind of wrong answer.

**Verified on GALE-JACKET . Amazon . IT with real preflight:**
- gate pill: **"publishing disabled on the server"** — the server's own `getAmazonPublishMode()`
  answer, not a browser guess
- **18 blocked**, **40 warnings**, action label **"Dry run for 2 of 20 ASINs"** — the partial
  correctly described, and "Dry run" rather than "Queue" because the gate is shut
- both facts stated separately in one advisory: the blocked count, the closed gate, and that the
  warnings do not block
- blocking issues name real ASINs and real reasons: *"B0BMS6ZZ4H . MAIN — Amazon requires a MAIN
  image on every listing. Add one before publishing."*

**Not submitted.** Per the standing constraint no Amazon submission was made — not even a dry run.
The gate being shut means one could not reach Amazon anyway, but "it would have been safe" is not
the same as "it was authorised", and the button is left unexercised deliberately.

### ⚠️ RETRACTED — see §16. This finding is not reproducible.
### 🔴 A third data finding: 18 of 20 ASINs have no MAIN image for Amazon IT
Preflight is unambiguous — 18 of GALE-JACKET's 20 ASINs would be REFUSED by Amazon for a missing
MAIN. That is the downstream consequence of the 16 phantom rows in §12: the shared MAIN row holds no
picture, so almost nothing inherits one. The 40 warnings are the same story a layer down ("Only 0
images resolved", "no SWCH").

This is not a UI defect and not something the rebuild introduced — it is what the data says, and the
old tab had no surface that would have told anyone. Queued for the Owner's data-quality list with
the other two.

---

## §15 Channel truth — stale vs drift (2026-09-01)

`channelTruth.ts` (+ 16 vitest cases). Two questions kept deliberately apart:

- **STALE** — a row Nexus published whose master picture has changed since. Nexus serves new bytes;
  Amazon still has the old ones. The server answers it.
- **DRIFT** — what Amazon's API says is live at a (sku, slot) against what this matrix resolves.

A row can be stale without drifting (nobody has looked at Amazon lately) and can drift without being
stale (someone edited the listing in Seller Central). One "out of sync" number would lose which it
is, and they have different remedies.

### 🔴 The comparison that would have broken everything silently
Every URL the matrix renders goes through `cdnFit`, so a naive string compare between the live URL
and the resolved one reports **drift on every single cell** against a perfectly in-sync channel.
`imageIdentity()` compares the stable identity instead: for Cloudinary the path after the transform
and version segments, for Amazon the asset id with its `._SL500_` modifier stripped.

The first implementation used one regex with lazy quantifiers and captured the transform block INTO
the identity — exactly the failure above. The tests caught it; the regex would never have announced
itself. It is now written by walking SEGMENTS, which cannot be misread.

### 🔴 Two more findings from the real data
- **The live read-back cache is EMPTY** — `GET /live-channel-images?channel=AMAZON` returns 0 rows.
  Nothing has ever been read back from Amazon for this product, so there is no drift answer to give
  until someone refreshes. The surface must say "not checked", never "no drift" — those are
  different statements and only one of them is true.
- **Stale reports 23 rows and names ZERO targets.** `{ totalStaleRows: 23, staleAsins: [],
  staleVariantIds: [] }`. A re-publish-stale action scopes its feed by variant ids, so with an empty
  list there is nothing to target. `staleActionability()` therefore shows the COUNT but refuses the
  ACTION, with the reason in words — offering the button anyway would be a control that cannot do
  what it says.

### The panel — verified on prod
`ChannelTruthPanel.tsx`. On GALE-JACKET . Amazon . IT it renders, verbatim:

> **What Amazon has** · `23 stale` · `not checked` · [Check Amazon]
> 23 published rows have a master image that changed after it was sent. Amazon still has the older
> picture. These rows are family-level, so there are no per-variant targets to re-publish. A full
> channel publish is the way to refresh them.
> Nobody has read this listing back from Amazon yet, so there is nothing to compare against. This is
> **not** the same as saying the images match — checking asks Amazon what it is actually serving.

Both refusals are the point: a `not checked` chip where a green "in sync" would have been the easy
lie, and a withheld re-publish button whose absence is explained rather than silent.

**"Check Amazon" was NOT clicked.** It is a read (`getListingsItem`) and changes nothing on the
listing, but it spends a real SP-API call against the live seller account and no such authorisation
has been given to this lane. By the standard the programme adopted from this lane's own words —
*"it would have been safe" is not "it was authorised"* — it stays unexercised, and the drift
comparison therefore remains verified by test only, not against a live read-back.

---

## §16 🔴 RETRACTION — the 18-of-20 MAIN finding does not reproduce

The §14 finding is **withdrawn as stated**. It was escalated to the Owner's data-quality queue as
the headline item, on this lane's word, and it must come off in that form.

**Observed ~17:51, evidenced:** the publish panel rendered "18 blocked / 40 warnings", the action
label "Dry run for 2 of 20 ASINs" (publishable = 20 − 18), and a blocking list naming real ASINs
with real messages — *"B0BMS6ZZ4H · MAIN — Amazon requires a MAIN image on every listing."* All of
it from `validate`'s `summary.asinsBlocked` and `hardFails`.

**Observed ~18:52:** `{ totalAsins: 20, asinsWithIssues: 18, asinsBlocked: 0 }`, **zero hardFails**,
20 `SWCH_MISSING_ON_COLOR` warnings. Stable across three consecutive runs and across IT, DE and ES.
`mirror-diff` independently agrees — all 20 ASINs have a MAIN in their plan, 0 skipped.

**Not explained.** The workspace counts are identical at both times (24 master images, 65 Amazon
rows), so the coarse shape of the data did not move. Between the readings this lane made test writes
and fully reverted them, each confirmed back to baseline; other lanes share the same prod database.
Unconfirmed candidates: the 24h `resolveSlotTaxonomy` cache warming, `buildAmazonImagePreview`
resolving differently warm vs cold, or a change another lane made that two counts do not capture.
Guessing in a ruling is how the first version of this got onto the Owner's queue.

**The residue, offered as inference from two data points rather than as a finding:** the preflight's
verdict changed for the same product without the image counts changing. If that holds, it matters
more than the original claim — a gate that says 18 blocked and later 0 blocked is one an operator
cannot act on. It belongs to whoever owns `amazon-publish-validator.service.ts` /
`amazon-image-preview.service.ts`; PES.7 has touched neither.

**Unaffected and re-confirmed against the API since:** the 16 phantom rows (§12) and the 23 stale
rows with zero nameable targets (§15). Both still true.

**The lesson worth keeping.** The panel was not wrong at either moment — it rendered exactly what
the server said, which is what it is for. The mistake was mine: I escalated a single reading as a
durable property of the data without re-confirming it. A number read once from a shared, live
database is an observation, not a finding.

---

## §17 Mirror diff — the trap it exists to prevent

`mirrorPlan.ts` (+ 8 vitest cases). An exact-mirror publish makes Amazon match Nexus, which means it
REMOVES slots Amazon has that Nexus does not fill. `deletes` is therefore the most consequential
number on the surface.

🔴 **`buildMirrorDiff` compares against the CACHED live rows — the cache that is empty until someone
reads the listing back.** Measured on GALE-JACKET: the raw endpoint returns
**`240 adds · 0 replaces · 0 deletes`**. A naive surface renders that as "this publish adds 240
images and removes nothing", which is false: the cache is empty, so nothing is known about what
Amazon has and the true removal count is unknown.

So the totals are **withheld entirely** when the cache is empty, replaced by the sentence: *"Amazon
has not been read back for this market, so there is nothing to compare against. A mirror publish
REMOVES any slot Amazon has that Nexus does not fill — and right now we do not know what Amazon has,
so we cannot say what would be removed. Check Amazon first."* Verified on screen.

When the cache does hold rows, the surface names removal in the clear ("N REMOVED from Amazon") and
lists the ASINs that would lose images, because that is the decision the operator is actually making.

---

## §18 Bulk apply + scoped upload — the last two P3 items (2026-09-01)

`bulkApply.ts` (16 tests) + `BulkApplyModal.tsx`. One operation, two entry points: pick a picture
from the gallery, or upload one, then choose the rows and slots it goes into. A wizard would only
put steps between the operator and a decision they can see whole.

**Nothing is overwritten silently.** Every target is classified before anything is written, and the
classes are genuinely different acts: `fill` (empty), `pin` (a picture is there but this coordinate
does not own it — writing makes it explicit), `overwrite` (this coordinate's own picture is
REPLACED), `skip` (read-only slot or locked row, with the reason). The sentence above the button
always LEADS with what would be replaced — burying that after two happier numbers is how it gets
missed.

**Verified on prod:** selecting two genuinely empty slots wrote 2 rows in one transaction, both
DRAFT with urls, then cleared back to the 65-row baseline.

### 🔴 A bug found by using it, not by reading it
Adding Nero/MAIN — a cell with a picture — reported *"fill 3 empty slots"*. It is not empty. The
first classifier only treated `shared` and `master` origins as pins, which missed the commonest
case: viewing market IT while the picture comes from the all-markets row. `ownRowAt` correctly
refuses that row (editing IT must not change every market), so it fell through to `fill`. Now the
test is simply *is there a picture here*, not which origin produced it — which stays right as
origins are added. Two regression tests pin it.

---

## §19 🔴 The falsely-clean slot set — including in this lane's own code

PES.5 found that `resolveSlotTaxonomy` wraps its schema lookup in a bare `catch` **and caches the
fallback for 24 hours**. One transient blip silently pins the legacy 10-slot set for a day, with no
log. MAIN survives it; PS01–PS06 do not, and they are populated — eighteen ListingImage rows sit in
PS slots on GALE-JACKET. For those 24 hours those images are invisible to preview, validation and
publish, and the validator returns a CLEAN verdict for a listing whose safety images are not going
out. Verified at source before touching anything.

**Fixed** (`amazon-slot-taxonomy.service.ts`): both silent fallback paths now log — the failure AND
the "schema answered but carried no MAIN" case, which were indistinguishable before — and a
FALLBACK is cached for 60s while a schema result keeps its 24h. Short enough that a blip costs a
minute rather than a day; long enough that an unavailable schema cannot turn every request into a
fresh lookup.

### The same bug was in this lane's own matrix
`matrixColumns` inferred `fromSchema: taxonomy.length > 0` — but a FALLBACK also arrives as a
perfectly good non-empty list of ten slots. So the matrix would have called the legacy set
authoritative and never shown its own warning: the identical falsely-clean shape, in the code
written to guard against it.

Fixed properly by making the server say so. `images-workspace.routes.ts` already had
`taxonomy.source` on the object and dropped it; it now returns `amazonSlotTaxonomySource`, threaded
through to a three-state `slotSetSource` (`schema` / `fallback` / `unknown` — an older API that did
not say is its own state, not an assumption either way). Confirmed live: `"schema"` with 16 slots.

### One premise that did not survive checking
The third proposed fix — "surface `taxonomy.source` in the validator's verdict, it is already on the
object and the validator drops it" — rests on something that is not true. `amazon-publish-validator.
service.ts` never calls `resolveSlotTaxonomy`, and neither does the `buildAmazonImagePreview` it
depends on. The validator has no access to the taxonomy at all, so surfacing `source` there means
ADDING a dependency and an extra lookup per validate. That is a real decision, not an approval, and
it was not made here. The genuine "already there and dropped" instance was the workspace route, and
that is the one that got fixed.

---

## §20 P4 — eBay, on the same substrate (2026-09-01)

`channel/ebay/buckets.ts` (17 tests) + `EbayGrid.tsx` + `useEbayEdits.ts`. Same engine as the Amazon
matrix, different meaning — and the differences are the whole design:

- **Columns are an ORDER, not named slots.** Position 1 is the cover a buyer sees in search results,
  so the header names it rather than leaving it to be inferred. Positions are ZERO-based in storage
  and ONE-based on screen; nobody calls the first photo "position 0", and the conversion happens
  once, at the column definition.
- 🔴 **Every photo lives in EXACTLY ONE bucket.** eBay does not reliably de-duplicate, so the same
  picture in Default and in a colour can surface twice in one gallery. Placing a photo into a bucket
  therefore MOVES it — the upsert that adds it and the delete that removes its old row travel in one
  transaction, because splitting them leaves a window where the duplicate exists.
- **Twelve per variation** is eBay's real cap on this path; a thirteenth is refused with the limit
  named, not silently dropped.
- Removing a photo **renumbers** what is left. eBay reads position as an order and a gap makes the
  cover ambiguous; only the rows that actually moved are rewritten.

**Verified on prod** (GALE-JACKET . eBay): 3 buckets, 16 photos, exactly matching the stored rows —
Default 2, Nero 7, Giallo 7. Header reads *"3 buckets . 16 photos . max 12 per variation"* with a
"one bucket per photo" chip explaining the invariant.

### Shopify — not built, and now MEASURED across the whole catalogue (ruling #125)
The question was whether real Shopify data exists anywhere. It does not, and the catalogue is small
enough to say so exhaustively rather than by sample:

| measurement | result |
|---|---|
| `publish-readiness` → shopify | `{ enabled: false, mode: 'gated', **configured: false** }` |
| products in the catalogue | **37 — all scanned, not sampled** |
| products with `SHOPIFY` in `syncChannels` | **0** (AMAZON 10, EBAY 22) |
| products with a `shopifyProductId` | **0** |
| products with any `ListingImage` row on platform SHOPIFY | **0 of 37** |

So Shopify is not configured on the account, no product is linked to it, and not one image row
exists for it anywhere. There is nothing to build against and nothing to verify against.

**This is an Owner decision, not a lane one:** a deliberate XAVIA Shopify fixture, or defer the
surface until after the swap. Either is defensible; guessing is not. Meanwhile the scope renders an
honest statement of what the surface will be (pool + per-colour assignment, per §2.4) rather than an
empty grid implying data exists.

### Screenshots misled me a third time
The rendered grid appeared to show Nero and Giallo starting at position 2 with position 1 empty. The
DOM says otherwise: both buckets are filled at indexes 0-6, 16 photos total, matching the API
exactly. Light product images on light tiles read as empty in a downscaled capture. Three times now
in this session the picture has been wrong and the DOM right — the structural read is the one to
trust.

---

## §21 🔴 SECOND RETRACTION — and the method fault common to both

**The claim:** "24 images on the parent, 0 on every one of its 20 children" (§ the 4.12 handoff, and
quoted into two lanes' design decisions).

**The truth, measured across the whole set this time:** all 20 children have images of their own —
7, 8 or 10 each. **Zero have none.** PES.4 checked it against the same endpoint my hook reads and
was right.

### What I actually did
I ran ONE request against ONE child, got `0`, and wrote "0 on every one of its 20 children." I never
checked the other nineteen. The single reading does not reproduce either, and I am not going to
guess why — but that hardly matters, because even if it had been accurate at that moment,
generalising it to twenty was never justified by it.

### 🔴 The fault is the same one that produced the first retraction
Both retractions this session are **a single reading generalised into a general claim**:

| | what I read | what I wrote |
|---|---|---|
| §16 (retracted) | `validate` once | "18 of 20 ASINs would be refused" — as a durable property |
| §21 (this one) | ONE child's images | "0 on every one of its 20 children" |

In both cases the single reading appeared to confirm a model I already held — for §21, "children
inherit from the parent, so they will not have their own rows", which is a plausible reading of the
cascade and is what made one number feel like enough. That is confirmation bias with a sample of
one, and checking cost seconds in both cases.

**The rule that follows, and it is checkable rather than a resolution to be careful:** a claim about
a SET must be measured across the set. If a sentence contains *every*, *all*, *none*, or *N of M*,
the measurement must have covered M. A claim that something is a durable property must survive a
second reading at a different time.

### Which findings this does and does not touch
Applying that rule honestly to everything filed tonight:

| finding | how it was measured | status |
|---|---|---|
| 16 phantom rows (empty `url`, no source) | filtered ALL 65 Amazon rows in one payload; re-confirmed later | **stands** |
| Shopify: nothing anywhere | scanned ALL 37 products explicitly | **stands** |
| `amazonSlotTaxonomy` 16 vs 10 per product type | two products' payloads, verified twice | **stands** |
| mirror "0 deletes" over an empty cache | the claim is STRUCTURAL — an empty cache makes the number meaningless whatever it reads | **stands** |
| 23 stale rows / zero targets | the endpoint's own aggregate, not an extrapolation; the UI reads it live | **stands as UI behaviour**; the number is whatever the server says |
| 18 of 20 ASINs missing MAIN | one reading of `validate` | **retracted (§16)** |
| children have no images | one reading of one child | **retracted (§21)** |

The two that failed are exactly the two that generalised from a single reading. The ones that hold
are the ones where the set was scanned or the claim was structural. That is a specific fault with a
specific fix, not a reason to distrust the rest — but the rest is listed here so anyone can check
the reasoning rather than take my word for it.

### The contract itself is unchanged, but its justification is
`resolveRecordImages` inheriting when a record has none of its own is still right — a child with no
images should show the family's rather than announce that every channel will refuse the listing.
What changes is the evidence: that is a property of the MODEL (children may have no rows of their
own), **not something observed on GALE-JACKET**. On this product the inheritance branch is
unreachable, which is precisely why PES.4 cannot verify the inherited render — and they were right
to refuse to manufacture an image-less child on a prod-backed database to make their own
verification convenient.

---

## §22 P5 — the publish history, read honestly (2026-09-01)

`publish/jobs.ts` (10 tests) + `PublishHistory.tsx`. Every channel's attempts in one list, because
an operator asking "did the images go out?" does not think about which service recorded the attempt.

### 🔴 A job's `status` cannot be trusted on its own — SET-measured
Scanned the FULL set of **78 jobs** on GALE-JACKET (limit 200, 78 returned — this is a set claim and
the set was covered):

| | |
|---|---|
| total attempts | 78 (AMAZON 43, EBAY 35) |
| `IN_PROGRESS` | **37** |
| ...of those, older than a day | **37 of 37** — 82 to 87 days |
| ...of those, carrying a `completedAt` | **37 of 37** |
| `FATAL` | 13, across 6 distinct messages |

Every stuck job finished months ago and had its status left behind. Rendering the field verbatim
would show **47% of this product's publish history as permanently in flight** — a spinner that never
resolves for work that ended in June.

So the two fields are read TOGETHER and the contradiction is named rather than resolved silently in
either direction. `Ended · "This job recorded a finish time but its status was never updated, so
whether it succeeded is not recorded."` Promoting it to "Completed" would be the same dishonesty
inverted: we know it stopped, not that it worked. A job claiming to run with no completion and more
than a day old reads `No result · never reported back — it is not still running.`

The count is surfaced in the header (`37 with no recorded outcome`) rather than left to be noticed
row by row, and repeated failures are grouped — the same error twenty times is one problem, not
twenty. Verified on screen: *"78 attempts · 13 failed · 37 with no recorded outcome"*, and
*"4× inventory_item PUT 400 (we sent quantity=12)"* under "Why publishes failed".

This is a finding about the JOB LOG, not about the images: nothing here says a publish failed, only
that the record cannot say whether it succeeded.

## §23 🔴 The publish record — and a correction to §22 (2026-09-01)

§22 shipped the job list saying **"37 with no recorded outcome"**, on the reading that a row marked
`IN_PROGRESS` while carrying a `completedAt` had ended without anyone recording how. I went looking
for the missing outcomes in the audit log. They were not there — but the outcome *was*, on the job
rows themselves, in a field §22 never read. **The 37 all carry Amazon's per-SKU processing report.**
That claim in §22 was wrong and the surface now says something different.

### What the two logs actually contain

Measured over the complete set for GALE-JACKET — all 78 job rows, and all 71 `imagePublish*` audit
entries (one unpaginated page, 83 entries total for the product, so nothing was sampled):

| audit action | n | channel | carries `jobId` | carries `feedId` |
|---|---|---|---|---|
| `imagePublishStarted` | 38 | AMAZON (all) | **38** | 38 |
| `imagePublishCompleted` | 14 | EBAY (all) | **0** | 0 |
| `imagePublishFailed` | 10 | EBAY (all) | **0** | 0 |
| `imagePublishBulk` | 9 | EBAY (all) | 0 | 0 |

| job rows | status | `completedAt` | per-SKU receipt |
|---|---|---|---|
| 37 Amazon | `IN_PROGRESS` | **set** (written in bursts: 8 in one minute on 06-21) | **present** — 666 lines |
| 6 Amazon | `DONE` | **null** | absent |
| 22 eBay | `DONE` | set | n/a |
| 13 eBay | `FATAL` | set | n/a |

**The status column is close to inverted.** The rows that claim to be running are the ones that
finished; the rows that claim to be finished never recorded finishing. 43 of 78 rows contradict
themselves, and that is now stated on the surface as a number the operator can click into.

### Why the two logs cannot be joined — and the half that can

Two publishers, two disjoint conventions:

- **Amazon** writes a start, with `jobId` and `feedId`, and **never writes an outcome**. This is
  structural, not a data accident: `amazon-images.routes.ts` has no `imagePublishCompleted` call at
  all, and its own comment says the terminal status would be written *"from `pollAndUpdateFeedJob`
  if/when we wire that"*. It was never wired. Its `imagePublishFailed` covers only a throw from the
  *submission*, which is why 0 of the 38 Amazon entries are failures.
- **eBay** writes outcomes with real error text, never writes a start, and its outcome rows carry
  **no job reference** — so an eBay outcome cannot be attributed to any eBay job row.

So the surface shows them as **two lists, unmerged**, and says why once at the top. Correlating on
timestamp-and-channel would look tidy and would attribute outcomes to named jobs on a guess; a wrong
outcome against a named job is worse than an honest gap.

The Amazon half *is* joinable, and the UI now makes that visible: the audit start's `feedId` is the
same value the job row stores as `vendorEntityId`, so both lists show a reference column and the
same feed id appears in both, a second apart. That column also fills what was otherwise dead space
on every row, and it is the value an operator quotes to Seller Central.

### ⚠ The receipt is evidence of completion, NOT proof of success

All 37 receipts read 666 SKU lines, **666 accepted, 0 rejected**. That is exactly the falsely-clean
shape §19 was written about, so it was checked before being believed:

```ts
accepted: errors.length === 0        // buildPerSkuReceipt
const issues = report?.processingReport?.issues ?? []
```

and `applyPublishResults` says in terms: *"A DONE feed often returns an empty/absent processing
report when every message was accepted. Do NOT bail on a null report — treat it as '0 issues'"*.
An all-accepted receipt is therefore consistent with **both** "Amazon accepted every SKU" and "no
report ever came back", and the field that separates them — `resultSummary.processingReport` — is
not exposed by the API (the route narrows `resultSummary` to `perSku` only).

`jobs.ts` therefore reports three different things and never collapses them:

| the record says | the surface says |
|---|---|
| a named rejection | **Failed** — it is the one directly-evidenced fact here |
| a receipt naming no rejection | **Ended** · "18 SKUs, none rejected", + a note that this is evidence it finished, not proof it published |
| a finish time, no receipt | **Ended, no report** — the outcome is not recorded, and it is not guessed |

The positive confirmation an operator actually wants is elsewhere and already on screen: the listing
rows' own `publishStatus` in the matrix. The job log is a record of *attempts*.

### Two defects for the service owner (not this lane)

1. **The Amazon image publisher never records an outcome.** No `imagePublishCompleted` on the route,
   and the job row's `status` is left at `IN_PROGRESS` even when `completedAt` and the full per-SKU
   report have been written to the same row. A 3-minute reconcile cron (`image-publish-reconcile`,
   registered at `index.ts:1716`) exists and advances `amazonImageFeedJob`, yet these 37 rows sat
   from June to September — so whatever wrote the receipt did not advance the status, and the sweep
   has not corrected it since.
2. **eBay's outcome audit entries carry no `jobId`**, so 24 recorded outcomes cannot be attributed
   to any of the 35 eBay job rows. Adding `jobId` to the two `recordImagePublishAudit` calls in
   `channel-image-publish.routes.ts` would close it.

Neither is touched from this lane — both are read-only findings on someone else's service.

### Also fixed here

- **Ruling #156 swept.** All six of this lane's hooks returned fresh object literals; two also minted
  a fresh arrow (`dismiss: () => setRefusal(null)`) and `useImageWorkspace` returned a fresh `[]` for
  two absent fields. All memoised, the arrows lifted to `useCallback`, and `AmazonMatrix`'s two
  memos now depend on `placeEdit`/`moveEdit` rather than the whole `edits` object — belt and braces,
  so they keep working if a future edit forgets the first half.
- **The 25-row cap was hiding the evidence.** Both logs are newest-first and the newest 25 attempts
  are all eBay, so every one of the 43 self-contradicting Amazon rows sat behind a truncation with
  no way to reach it. A count an operator cannot click into is an assertion they have to take on
  trust; both lists now expand.
- **A CSS edit silently no-op'd** — a blank line I had not accounted for meant the `.jobRow` template
  never changed, and the new column wrapped every row onto two lines. The screenshot showed it; the
  computed style named it. `.replace()` without an assertion is the same silent-failure class as
  everything else in this file, and the retry asserted on both blocks.

**Verification:** 202 tests across 14 files in this lane, repo `tsc --noEmit` exit 0, 13 DS/grid
guards exit 0. On screen: all 78 attempts and all 71 audit entries render, every row 31px (no
wrapping), feed `105489020614` visible in both lists. No writes of any kind were made — this whole
section is read-only measurement.

## §24 P5 — the schedule surface, and a queue that accepts work it will not run (2026-09-01)

The scheduling CRUD works: `POST /products/:id/scheduled-image-publishes` stores a row and returns
`PENDING`. **The cron that fires those rows does not run.** It is gated on
`NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH=1` (`scheduled-image-publish.job.ts:144`), which is off on
production (D4, hub-measured from the boot log). So an operator could pick a time, get a
confirmation, and have nothing at all happen — with the row still reading "Pending" a week later.

**The empty list is the trap.** `GET …/scheduled-image-publishes` returns `{"rows":[]}` — and an
empty list looks exactly the same whether the queue is idle or dead. A surface that renders "No
schedules yet" there is inviting the operator into the failure.

So the route now also reports the fact (additive, disclosed):

```ts
// Read at request time, not at boot: the same flag the cron itself checks, so the two can never
// drift apart.
const executionEnabled = process.env.NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH === '1'
return reply.send({ rows, executionEnabled })
```

Measured live: `{"rows":[],"executionEnabled":false}`. The UI states it from that answer and never
from a constant — the moment the flag is set, the surface becomes a working form with no code
change. Until the server answers, `enabled` is `undefined` and **nothing is claimed either way**;
defaulting it to `true` would have been the one guess that manufactures a silent broken promise.

`schedule.ts` therefore never labels a stranded row in a way that implies it is waiting — a future
row reads **"Will not run"**, not "Scheduled"; a past one reads **"Never ran"**, not "Overdue"
(a test asserts exactly that, across both). Settled rows (`FIRED`/`FAILED`/`CANCELLED`) read the
same either way, because their outcome is already recorded and the flag cannot change it.

The form stays **visible and disabled, with the reason in visible text beside it** — "Disabled
because nothing on this deployment would fire the schedule." Two rules meet: a placeholder surface
is a roadmap and stays, and a disabled control cannot explain itself through a tooltip it never
fires. Hiding the form would delete the only place the capability is described.

**Verified on screen:** all three controls disabled, notice and reason both rendered.
**Green:** 218 tests / 15 files, web tsc 0, api tsc 0, 15 guards 0. No writes.

## §25 P5 — health cards, and the two statistics that cannot be computed (2026-09-01)

PB.13 offered five figures per channel: last published, 30-day count, **success rate**, **average
duration**, recent errors. Two of the five are uncomputable from this data, and computing them
anyway is worse than omitting them.

**Success rate.** A rate needs a denominator of attempts whose outcome is recorded. Amazon records
an outcome for **6 of 43**. A rate over those 6 reads **100%** — arithmetically true, completely
false, and it silently drops the 37 attempts that are the actual story. So there are **no
percentages anywhere on this surface**; everything is `X of Y` with the remainder named, because a
fraction that carries its own denominator cannot mislead the way a percentage can. A test asserts
no output ever contains a `%`.

**Average duration.** Measured across both channels:

| | eBay | Amazon |
|---|---|---|
| durations (completedAt − submittedAt) | 1s – 153s, median **61s** | 1,178,413s – 2,409,392s, i.e. **13.6 – 27.9 days** |
| within an hour | 35 of 35 | **0 of 37** |

eBay's publisher records its own finish, so its durations are real. Amazon's `completedAt` was
written by a reconcile sweep weeks after the fact, so "average duration" would report a publish
taking a fortnight. The rule applied is **provenance, not a magic threshold**: a duration is
measured only from a row with a *recorded terminal status* AND a completion time — a finish time
nobody recorded at the finish is not a measurement of how long anything took. Amazon's card
therefore reads **"Typical time — Not recorded"** and says why underneath.

On screen, the two cards tell genuinely different stories from the same code path:

- **AMAZON · 43 attempts** — "all 6 recorded outcomes succeeded — the other 37 of 43 attempts record
  no outcome at all." · Typical time **Not recorded** · 666 SKU lines · plus the sweep note.
- **EBAY · 35 attempts · 13 failed** — "22 of 35 recorded outcomes succeeded, 13 failed." · Typical
  time **61s** · Slowest **3 min** · the three real rejection reasons.

Fed from the jobs the surrounding record already loaded — no second fetch, so the cards and the list
below them cannot disagree about the same data.

**Green:** 238 tests / 16 files, web tsc 0, api tsc 0, 13 guards 0. Verified on screen, `%` absent
from the whole section. No writes.

## §26 P5 — the three browser-local surfaces, and a restore that would have unpublished (2026-09-01)

Auto-publish (PB.11), the approval gate (PB.12) and rollback restore points (PB.9). All three were
localStorage in the old tab with named server-side successors that were never built (§2.6), so all
three keep saying "this browser only" — **once at the top of the panel**, with the restore control
carrying its own, stronger warning. The distinction is deliberate: a *preference* that does not
travel is inconvenient; a *safety net* that does not travel is a trap you discover at the moment you
reach for it.

### The store

Every access is wrapped. `localStorage` does not merely go missing under SSR — it **throws** in a
browser configured to block site data, and a write throws on a full quota. Availability is
**probed** (write, read back, remove) rather than assumed, and the panel renders an explanation
instead of controls when the probe fails: a toggle that silently fails to save is worse than an
absent one. Stored data is parsed as untrusted input, exactly like a wire payload — it was written
by an older version of this code on a machine we know nothing about. `asEnum` returns `null` for an
unrecognised member rather than defaulting to the first, because a preference restored as something
the operator never chose is worse than one that reverts and says nothing.

### 🔴 Three defects found by building it, two of them mine

**1. A restore would have unpublished rows it did not change.** `bulk-save` resets `publishStatus`
to DRAFT on every upsert (`edits.ts`), and a snapshot carries no publish state. The first version
re-wrote every row in the snapshot — so restoring an *unchanged* AMAZON·IT layer would have demoted
both of its `PUBLISHED` rows to DRAFT for nothing, with no way to put it back except publishing
again. Now the plan **skips any row that already matches**, and counts the live rows a real change
would demote (`unpublishes`) so the consequence is stated on the control itself, not only after a
Compare.

**2. A phantom "moved", caught on screen and not by a test.** `currentRows` used each row's *index
in the array* as its position, so inserting one unrelated row shifted every later row and the
compare reported `Moved in PT02 (1 → 2)` on a row nothing had touched. The wire carries a real
`position` field; I had not looked. Moved into `publishPrefs.layerRows`, where it is now pure and
tested — **an array index is a fact about the array, not about the data.**

**3. The empty-state text was a lie.** It read "Snapshots are taken when you publish from here."
Nothing takes them; the button does. Now: "One is recorded only when you press the button below."

### The duplicate-row trap

`restorePlan` matches the snapshot against what is on the channel *now*, coordinate by coordinate,
and carries the existing row's id. Upserting without one **creates** — so a naive restore would
leave a second row at every coordinate that already had one, and the cascade would then pick between
them arbitrarily. A rollback that doubles every row is worse than none, because it looks like it
worked. The plan is also layer-scoped: restoring IT touches neither DE nor the all-markets rows it
inherits from.

That scoping is stated rather than left to be discovered — the panel says *"Records the 2 pictures
pinned to AMAZON · IT. The 45 shown here from the all-markets layer belong to that layer and are not
part of this restore point."* Measured: 65 Amazon rows = 45 PLATFORM + 20 MARKETPLACE, of which IT
holds exactly 2.

### Verified end-to-end against the production database

Baseline recorded first: 2 AMAZON·IT rows, ids `cmq3ksnd2…` / `cmq3ksncu…`, both `PUBLISHED`,
positions 0 and 2; 65 Amazon rows, 81 listing rows.

1. Restore point taken through the UI — stored positions 0 and 2, matching the DB (the fix working).
2. One extra DRAFT row created at PT03 · Nero.
3. Compare read exactly **"Added to PT03 (Nero)"** — no phantom move — and **"1 added since
   removed."**
4. **Restore pressed in the UI.** The studio header showed "✓ Saved 23:03", so the write reported
   through the frame's save reporter like every other write on this tab.
5. Re-measured at source: **same two ids, both still `PUBLISHED`, 65 Amazon / 81 listing** — exact
   baseline. The restore deleted only the added row and left the live rows untouched, which is
   precisely what defect 1's fix bought.

Net effect on production: zero. The test snapshot was cleared from browser storage afterwards.

**Green:** 298 tests / 19 files, web tsc 0, api tsc 0, 15 guards 0.

## §27 P5 closed — the cross-channel planner, and a "dry run" that isn't (2026-09-01)

### 🔴 The safety defect, found while wiring the planner's fire path

`POST /amazon-images/publish` accepts `dryRun`, records it in the audit log, and **does not use it**:

```ts
feedResult = await submitAmazonListingsBatch({
  marketplaceIds: [marketplaceId], sellerId, operations,
  // Pass dryRun flag — the batch service checks NEXUS_AMAZON_BATCH_DRYRUN env or this override
  ...(dryRun ? {} : {}),  // env-based; dryRun param passed via env in test context
})
```

`...(dryRun ? {} : {})` spreads an empty object in **both** branches, and `AmazonBatchSubmission`
has no `dryRun` field — so the "override" the comment describes does not exist. This is a
**structural** claim: line 399 is the only path the flag could take, and it goes nowhere.

What actually decides submission is `isDryRunEnv()` → `getAmazonPublishMode() !== 'live'`, which is
the correct single gate (PD.2 unified it deliberately). So the consequences are:

| publish mode | request says | what happens | what the audit log records |
|---|---|---|---|
| not `live` | anything | dry run — safe | the request's flag |
| **`live`** | **`dryRun: true`** | **a real feed is submitted** | **`dryRun: true`** |

Measured today: all three channels report `"mode":"gated"`, so this is **latent, not currently
firing**. It bites the moment the gate is opened.

The *response* is honest (`dryRun: feedResult.dryRun`, the truth from the batch service). The audit
log is not — it stores the request's flag (route line 118). **This retracts an inference I drew
earlier:** the 38 audit starts reading `dryRun: false` tell us what was *asked for*, not that a feed
reached Amazon; whether one did depended on the publish mode at the time, which the audit does not
record.

### 🔴 And I had shipped the same lie in the UI

My own `PublishPanel` offered *"Dry run — build and check the feed without submitting it"*, sent
`dryRun: true`, and reported the outcome as:

```ts
res.data?.dryRun || dryRun || plan.rehearsalOnly ? 'nothing was submitted to Amazon' : …
```

The **request flag wins that OR**. With the gate live, ticking the box would have submitted a real
feed and the panel would have said *"nothing was submitted to Amazon"*. Fixed on both halves:

- The outcome now comes from the **server's answer alone**, with `undefined` treated as its own
  state — "the server did not say whether the feed was submitted" rather than a guess either way.
- The checkbox is no longer a choice, because the endpoint cannot honour one. It is shown, disabled,
  reflecting the gate, with the reason in visible text beside it: *"Dry run — the publish gate is
  closed on this deployment…"* / *"Live — … This endpoint has no rehearsal mode of its own."*

Verified on screen: `checked: true, disabled: true, readOnly: true`, and the panel reads
*"publishing disabled on the server … nothing will reach Amazon."*

### The planner

D1 required that "the per-market publish UI must say which mechanism each market's set rides". The
planner leads with **destinations, not targets** — and it takes its target list from the marketplace
table via `options.channels`, which turned out to declare **11 Amazon markets** (BE DE ES FR IE IT NL
PL SE TR UK) and 5 eBay, not the 5 I had assumed from the audit log. Per-market pinned counts match
the earlier measurement exactly: DE 2, ES 14, FR 2, IT 2, rest 0.

Selecting Amazon IT + DE + ES and eBay IT renders:

> **4 targets, but only 2 destinations — some of them overwrite each other.**
> DE, ES, IT all write the same set of pictures on AMAZON. Publishing them together does not give
> each one its own images — they run in order and whichever finishes last is what Amazon keeps.
> *Sends through the Listings API, which stores images against the ASIN … Genuinely per-country
> images need Amazon's Country-Specific Upload, and localized text belongs in A+ Content; neither is
> automated from this screen.*

The button reads **"Rehearse 4 targets"** because every gate is closed — taken from the server, never
from a flag on this screen. **Not pressed:** per the standing constraint, no publish was fired from
the planner, so its sequential-fire path is built and typechecked but unexercised. That is stated
rather than implied.

One UI fix on measurement: "gate closed" appeared on all 16 cards and squeezed the coverage text to
"45 fro…". A chip that distinguishes nothing is noise, so it now shows only when gate states
actually differ, and the footer says it once.

**Green:** 318 tests / 20 files, web tsc 0, api tsc 0, 15 guards 0. **P5 complete.**

## §28 The `dryRun` fix — and why the guard must never be "simplified" (2026-09-01)

Authorised by hub ruling #176 under the unclaimed-territory pattern. **Three files, all disclosed.**

### What changed

1. **`services/channel-batch/amazon-batch-feed.service.ts`** — `AmazonBatchSubmission` gains
   `dryRun?: boolean`, and the guard becomes:

   ```ts
   const callerRequestedRehearsal = input.dryRun === true
   if (isDryRunEnv() || callerRequestedRehearsal) { … }
   ```

   **One-way by construction:** `true` forces a rehearsal, `false`/`undefined` defer to the gate. A
   caller can never *cause* a submission the gate would have prevented. Left optional so the two
   `bulk-action.service.ts` callers — which legitimately have no per-call opinion — are untouched.

2. **`services/images/amazon-image-feed.service.ts`** — `...(dryRun ? {} : {})` becomes `dryRun,`.
   Also: the no-SKU early return now reports `dryRun: true` rather than echoing the request, because
   that path never calls Amazon at all — reporting the caller's wish there would claim a live
   submission on a path that cannot make one.

3. **`routes/images/amazon-images.routes.ts`** — the audit log records `result.dryRun` (what
   happened) and keeps `requestedDryRun` (what was asked) as a separate field. Reading those entries
   back previously told you about intent while looking exactly like a record of outcome.

### 🔴 The invariant is written into the code, because it looks redundant

With the gate closed — every environment today — `isDryRunEnv()` is always true, so
`|| callerRequestedRehearsal` never changes an outcome and reads like dead code. **That is precisely
how it was lost the first time.** The comment at the guard says so, and names the consequence of
deleting either half.

### Proven load-bearing by mutation, not by passing

A green test proves nothing until it fails on the thing it claims to protect. All three mutations
were run and caught:

| mutation | caught by |
|---|---|
| guard reduced to `if (isDryRunEnv())` | `honours an explicit dryRun:true and does NOT submit` |
| forward `dryRun,` deleted | `passes dryRun to the batch service` |
| original `...(dryRun ? {} : {})` restored | both source assertions |

The behavioural tests deliberately run with the gate **LIVE**, because that is the only
configuration in which the caller's flag is load-bearing — a test with the gate closed passes
whether or not the fix exists. `amazon-sp-api` is mocked to **throw on construction**, so a
regression fails loudly instead of reaching Amazon from a test run; one test asserts that the live
path *is* entered when nothing asks for a rehearsal, so the dry-run branch cannot quietly swallow
everything and make the others vacuous.

⚠ **A type check cannot catch the forward's removal** — `dryRun` is optional, so deleting `dryRun,`
compiles cleanly (verified: `tsc --noEmit` exit 0 with it removed). That is why the source
assertions exist alongside the behavioural ones.

### The trap I walked into writing the guard

Both source assertions failed on their first run. The fix's own comment **quotes** the bad pattern to
explain it — so "must not contain `...(x ? {} : {})`" matched the explanation, and the `})` inside
that quote truncated the extracted call. The test now strips comments first. A source guard that
reads comments is testing the prose, not the code — the same class as
`reference_ds_guard_greps_comments`.

### Verified as a no-op today

Gate re-read at the moment of the change: `amazon`, `ebay`, `shopify` all `"mode":"gated"`, so every
submission was already a rehearsal and nothing changes until the gate opens. Prod data re-measured
after: **65 Amazon rows, 81 listing rows, 2 IT rows still `PUBLISHED`, 24 master images** — the
standing baseline. No publish was fired.

**Green:** api 5500 tests / 411 files, api tsc 0, web 318 tests, web tsc 0, 15 guards 0.

## §29 P6 + P7 — the ancillary tabs, and a parent that reads zero while the family sells (2026-09-01)

Both written fresh on the DS against the old tabs' capability lists (`AnalyticsTab` 369 L +
`AdsTab` 523 L + `TimelineTab` 466 L, 910 Tailwind tokens between the first two, zero DS). Types
transcribed from the LIVE responses, not from the old components' local interfaces.

### 🔴 The finding that shaped both tabs: a parent row has no figures of its own

Measured across the **full set** of 20 children, not a sample:

| | parent | children |
|---|---|---|
| `analytics.sales.byChannel` | `[]` at 30, 60 **and** 90 days | 3 channels on the first child alone |
| units (90d) | **0** | **427, across 17 of 20** |
| `product-ads` | **0 ads** for `productId`, `sku` **and** its own ASIN `B0F7J163XJ` | **93–107 ads, 70–76 campaigns** on every child sampled |

`totalUnits` is `byChannel.reduce(...)` — the sum of an empty list. So "0 units · £0 revenue" on a
parent is not a measured zero, it is the opposite of the truth stated confidently. Same for
"No ads are running against this product": true of the row, false about the family, and an operator
reads it as the family.

Both halves now name where the figures live instead:

> Sales are recorded against each variant, and this parent row has none of its own. Its variants
> hold the figures for the last 30 days — open one to see them. **Nothing here is a measurement of
> zero.**

> Advertising is recorded against each variant, and this parent row has none of its own. Open a
> variant to see the campaigns running for it. **This is not a statement that nothing is being
> advertised.**

Aggregating the children would be feature invention (this lane is a port), so the surface names the
situation rather than inventing a total nobody computed.

**A related trap, avoided:** the ad rows reference ASIN `B0BMSH19GY`, which belongs to one child
(GALE-JACKET-BLACK-MEN-XL) — *not* to the parent, whose own `amazonAsin` is `B0F7J163XJ`. The query
therefore sends every identifier the product has, because on a child it is the ASIN that matches and
neither `productId` nor `sku` would. (The old `AdsTab` already did this; no bug there.)

### Other honesty rules encoded, each with a test

- **ACOS `null` is not 0%.** Measured: `spendCents: 759, adSalesCents: 0, acos: null` — money spent,
  nothing back. "0%" reads as perfectly efficient and "—" reads as missing; both are wrong. It reads
  **"No sales"**, as a warning, because it is the worst outcome on the table and must not look like
  the best. It also sorts as `+Infinity`, so it cannot sort to the top as though it were the best row.
- **`daysOfInventory: null` is "Not calculable", never 0 days**; `stockoutRisk: 'UNKNOWN'` is
  "Not known" and never folds into LOW — "we don't know" and "you're fine" are opposite messages to
  someone deciding whether to reorder.
- **A £0.00 price stays visible** as a real reading. Hiding it behind "not set" would silently repair
  a data problem on screen.
- **An all-zero sparkline draws along the bottom, not through the middle** — dividing by a zero max
  would put a flat line at half height and imply activity.
- **Activity: only `BULK_OP_APPLIED` carries a per-field delta.** Measured across all 157 events:
  `IMAGES_UPDATED` (76) and `FLAT_FILE_IMPORTED` (72) carry none. The old framing was "flat-file
  imports expandable to per-field delta"; expanding one here would open an **empty drawer and imply
  the detail had been lost**, so a row is expandable only when something is behind it — 9 expanders
  for 9 bulk edits, verified on screen. A `null` value renders as **"cleared"**, not the string
  "null".
- **A group states its own size.** 72 flat-file events arrive in pairs; a list showing one row per
  pair has hidden half the record, a row saying "2 events" has summarised it.
- **No raw enum reaches the screen** — `FLAT_FILE_IMPORTED` is not a sentence; an unrecognised
  image `source` reads as "Image changed (teleported)" rather than being folded into "uploaded".
- **The AuditLog fallback is labelled** as the older, less detailed record rather than silently
  substituted.

### Three defects caught by guards and the hub, all mine

1. **`check-grid-option-identity`** — two inline `defaultColDef={{…}}` literals on `<NexusGrid>`.
   A new identity every render makes AG re-run its whole column model (GDS decision 12). Hoisted to
   module scope, which is the strongest form of the fix: nothing left to forget to memoise.
2. **`--nds-danger-border` does not exist** (PES.3's sweep). It resolved to `rgba(0,0,0,0)` and drew
   no border at all, silently — `var()` has no strict mode. Now `--nds-danger`, matching the DS
   strong-line + soft-fill + text pattern. A sweep of all three of my stylesheets found no others.
3. **A 74-row grid under `domLayout="autoHeight"` measured 3675px** — the grid became the page and
   pushed every section below it out of reach. Given a height so it scrolls in its own box; the
   10-row search-term grid keeps `autoHeight`. Also: a `width: auto` table inside a flex-column card
   still stretched to 1584px until `align-self: flex-start` — `align-self` matters as much as width.

**Frame change, disclosed:** `StudioTabHost`'s local `Placeholder` helper had zero callers once
`analytics` and `activity` became real components, and `noUnusedLocals` failed the build. Removed,
with a comment saying why.

**Verified on screen:** parent shows the two absence sentences and no zeros; child
`GALE-JACKET-BLACK-MEN-XL` shows 29 units across 4 markets, cover 13 days, stockout risk High, real
prices, and an ads headline reading *"1718.97 EUR spent over 30 days · 14 campaigns returned nothing
· 40 had no impressions at all."* Activity shows 157 events since 23/05/2026 with 9 expanders.
No grid header truncates.

**Green:** 752 tests (web `_studio`), web tsc 0 for my files, 16 guards 0. No writes.

## §30 P8 — the parity audit (2026-09-02)

Every line below is measured, not recalled. Where a first-pass grep said "built" I re-checked it,
because **a false positive in an audit is worse than a false negative** — it retires a capability
nobody rebuilt. Four of my own first-pass ✓s turned out to be grep artefacts and are corrected here.

**Built:** 9,225 lines across 66 source files and 22 test files, 5 of the frame's 5 tab slots.

### 30.1 🔴 Capabilities NOT rebuilt

Verified mechanically: for each of the 21 routes declared in `api.ts`, whether any component calls
it (`routes.<name>(`), plus a targeted grep per capability with each positive re-verified by hand.

**Declared but never called — three routes, all of them actions that lived on the old LightboxModal
which my `ImageViewer` replaced:**

| capability | route | state |
|---|---|---|
| Auto-enhance | `POST /images/:id/auto-enhance` | 🔴 route wired, **no UI calls it** |
| Gemini Vision analysis | `POST /images/:id/analyze` | 🔴 route wired, **no UI calls it** |
| Push master image → DAM | `POST /images/:id/push-to-dam` | 🔴 route wired, **no UI calls it** |

**Not built at all:**

- §2.1 — per-image **context menu**; **scoped upload** (master vs variant-targeted, per-channel slot
  defaults); "apply selection **to channel**" (multi-select itself IS built — primary, move,
  delete, apply-to-children — the apply-to-channel action is not).
- §2.2 — **filter bar** (axis multi-select + cell status, URL-persisted, presets); **column
  show/hide + reorder**; **named cross-device view layouts** (`SavedView`); **slot-group
  completion** ("Safety 6/6 ✓"); **copy to markets**; **copy to variants**; **adopt-to-master**;
  **export ZIP + manifest**; **storefront preview mockup**; **feed-status poll UI**.
- §2.5 — **retry a job** (`POST /image-publish-jobs/:id/retry`); **browser notifications**;
  **cross-channel quick-sync strip**; and the eBay/Shopify **validation banner · publish preview ·
  stale banner · recent-jobs strip** (PB.3a–d). Amazon has equivalents of the last four via
  `ChannelTruthPanel` + `PublishHistory`; eBay and Shopify do not.
- §2.4 — **the entire Shopify scope**, still blocked on the Owner (measured: zero Shopify image rows
  anywhere).

**Corrections to my own first pass:** "export ZIP", "column show/hide", "feed poll" and "retry"
each matched a grep and none is real — `export` matched the keyword, `retry` matched the *load-error*
Retry button, `feed poll` matched two prose comments. The per-channel completeness checklist matched
only a comment recording that completeness moved to the frame's readiness chips (PES.1's), so it is
covered but not by me.

### 30.2 §5 substrate audit — where I diverged from my own plan

| §5 said | built as | verdict |
|---|---|---|
| Amazon matrix → NexusGrid | **NexusGrid** | ✅ |
| eBay bucket grid → NexusGrid | **NexusGrid** | ✅ |
| Ads campaigns · search terms → NexusGrid | **NexusGrid** | ✅ |
| Publish history · audit log · jobs · scheduled list → NexusGrid | plain DS rows | ⚠️ **diverged** |
| Analytics per-channel breakdown → NexusGrid | plain `<table>` (3–5 rows) | ⚠️ diverged, deliberately |
| Activity feed → NexusGrid **tree** (batch → per-field children) | plain list with expanders | ⚠️ **diverged** |
| Master gallery, DAM picker, editor, viewer → NOT a grid | not a grid | ✅ |

Two of these are honest judgement calls and one is a gap:

- **Per-channel breakdown**: 3–5 rows. A virtualised grid for four rows is overhead with no return.
  Standing by it.
- **Activity as a grid tree**: the tree was predicated on "batch row → per-field delta children",
  and the measurement dissolved that premise — only 9 of 157 events carry a delta. A tree whose
  children exist for 6% of rows is the wrong shape. Standing by the list.
- **Publish history · audit · jobs · schedule**: 78 + 71 rows, and §5's reason was "wants
  sort/filter" — which they genuinely do and currently do not have. They are newest-first only.
  **This one is a real gap, not a judgement call**, and it is recorded as such rather than
  rationalised.

### 30.3 Numeric chrome parity vs `/products/next` — measured, holds

| | `/products/next` | studio ads grid | |
|---|---|---|---|
| header height | 46px | **46px** | ✅ |
| cell padding-left | 13px | **13px** | ✅ |
| font size | 13px | **13px** | ✅ |
| row height | 85px | 49px | ✅ correct — `/products/next` is a **media** row tier, mine are **text** rows; both from `tokens/grid.ts` |

### 30.4 Themes — light-locked by design, and that is not my gap

My stylesheets use DS tokens throughout: **zero undefined tokens** after the `--nds-danger-border`
fix, and the only raw hex is `#fff` over an always-dark scrim.

But "both themes" **cannot be demonstrated on this page**, and the reason is deliberate. Measured:
`.dark` on `<html>` (the app's real mechanism — `lib/theme/use-theme.ts` toggles
`document.documentElement`) moves `--nds-surface` from `#fff` to `#18263b` **at `<html>`**, and the
value is still light at every level below `<body>`. Walking the ancestor chain found the cause:
**`.h10-shell` re-declares 117 `--nds-*` tokens with the light palette**, and `shared-shell.css`
says why in terms — on `.dark` those pages "drew slate-900 cards and slate-50 text", so the shell
pins light "for everything inside". `/products/next` states it in its own class name:
`h10-shell productsNextLight`.

So this is an **intentional, documented, app-wide decision**, not a defect and not PES.7's. I nearly
filed it as a finding; the source comment is what stopped me.

**Contrast in the shell's actual (light) rendering — all sampled text clears AA:**
body text 14.67:1 · grid cells 15.48:1 · grid headers 9.35:1 · muted "unknown" tier 5.91:1 ·
card titles 5.60:1. **Nothing below 4.5:1.**

### 30.5 i18n — not done, and not a regression

No string in my tree goes through i18n. Neither does any other `_studio` lane (zero
`useTranslation` imports across the whole frame), and **none of the three tabs I replaced used it
either** — `AnalyticsTab`, `AdsTab` and the live `TimelineTab` all have zero. So the P8 line
"140 existing keys reused" was not met, this is parity with the source rather than a regression, and
it is a **programme-wide** item for the hub rather than a PES.7 one.

*(A first grep suggested three of my files used i18n. It matched `setAspect('1:1')`. Re-checked.)*

### 30.6 Summary

What was rebuilt is the core of the tab and is honest about what it knows: the cascade and matrix,
eBay buckets, the master gallery, viewer, editor, DAM picker, publish gate and record, health,
schedule, planner, the browser-local trio, and both ancillary tabs. What is missing is listed above
without softening — **17 capabilities plus the whole Shopify scope**, three of them with a live
route and no caller.

**Green at audit time:** 752 `_studio` tests, web tsc 0 for my files, api tsc 0, 16 guards 0.

## §31 The grid-kit ratchet — and a fix that traded one failure for another (2026-09-02)

`check-grid-kit-ratchet` blocked the push on my two ancillary tabs. Fixing it took two attempts, and
the first was wrong in an instructive way.

**Attempt 1 — the DS `DataGrid`.** Both tabs had hand-rolled `<table>`s (raw-table row 193 → 195).
`DataGrid` is a real DS table primitive with density tiers, sortable headers and `tabular-nums`, so
I migrated to it. The raw-table row went green — and the **`DS DataGrid` row went 71 → 73**. The
guard's own message said why: *"a retiring grid kit gained an importer. New grids are built on
design-system/grid (NexusGrid)."* I had traded one arm of the ratchet for the other.

**How I nearly missed it:** the script exits 0 without `--check`, so my first two readings — both
showing "❌ ROSE" beside `exit=0` — looked green. `pre-push` runs it as
`check-grid-kit-ratchet.mjs --check`. Reading the hook is what settled it.

**Attempt 2 — the right substrates, which are not the same for both.**

- **The analytics tables → `NexusGrid`.** Genuinely tabular, 4–5 rows, and §5 specified NexusGrid for
  the per-channel breakdown in the first place. **Verified sortable on screen:** clicking *Units*
  reorders 3→4→9→13, again for descending, then back to insertion order.
- **The activity delta → `<dl>`.** One or two field→value pairs inside an expanded row is a
  *property list*, not a grid: nothing to sort, filter or virtualise, and an AG instance per
  expanded row would put several on screen to render four words. It counts against **neither** arm
  of the ratchet, so this is not a route around the gate — the gate is green either way.

**A probe that lied, again.** My first sort check clicked the whole `.ag-header-cell` and nothing
moved, which read as "sorting is broken". `aria-sort` was still `none`, so the click never landed —
AG listens on `.ag-header-cell-label`. Clicking that flipped `none → ascending` and the rows
reordered. I was one step from filing a defect against a working feature.

**Result, read once at the end of the edit** (three lanes read it mid-edit and got three different
answers, because the files were changing under them):

```
DS DataGrid (<table>)   71  baseline 71
raw <table> (non-exempt) 193  baseline 193
✓ grid-kit ratchet: no retiring kit gained an importer     --check exit 0
```

**This also closes half of §30.2's conceded gap.** The per-channel and pricing tables now sort. The
other half stands: **publish history · audit log · jobs · schedule are still plain lists with no
sort or filter**, and they were the part §5 was actually right about.

**Green:** 759 `_studio` tests, web tsc 0 for my files, **17 guards 0** (16 + the ratchet under
`--check`). Verified on screen: zero raw tables on either tab, 4 AG grids on Analytics, 0 on
Activity, delta reads "manufacturer → cleared".

## §32 The inventory card — the same confident zero, in my own code (2026-09-02)

Caught by PES.3 (ruling #259): `inventory?.totalAvailable ?? 0` renders **"Available 0"** when the
analytics read returned nothing — reporting *out of stock*, the most actionable number on the page,
at the exact moment the tab knew least. This is the class §29 was written about, applied to my own
work and missed there. I had put the honest shape on the Sales card 30 lines above and not on its
neighbours: I applied it to the number I had been thinking about.

**It was wider than the reported line.** With `analytics` null and the state `ready` — a request
that succeeded and returned no payload — every card in that row fell through to its non-null branch:

| field | rendered | should be |
|---|---|---|
| Available | **`0`** | not known |
| Cover | *(empty `<dd>`)* | not known |
| Stockout risk | *(empty `<dd>`)* | not known |
| Quality score | *(empty `<dd>`)* | the "no score" sentence |
| Reviews ×3 | *(empty `<dd>`)* | the "no reviews" sentence |

Optional chaining made all six typecheck while producing a blank or a lie. `analytics?.quality
.latestScore === null` is `false` when `analytics` is null, so the guard that existed for the null
score did not fire for the null *payload*.

**Fixed at the row, not the line.** The whole card row is gated on `analytics`, with a single
honest sentence in its place; each remaining `?.` inside it is now a real optional. And
`readAvailable()` is pure and tested:

- a **measured** `0` shows as `0` — out of stock is a fact, and hiding it would be the opposite error
- `null`/`undefined`/`NaN`/`Infinity` read **"Not known"**

4 new tests (64 in the ancillary suite). ⚠ **Not yet verified on screen**: the web app is 500ing on
an unrelated CSS parse error in `design-system/grid/theme/grid.css`, reported to the hub — a comment
containing `--nds-note-*/--nds-tonal-*` closes itself on the embedded `*/` (79 `/*` vs 80 `*/`), and
postcss then dies on the following word. The on-screen check is outstanding, not passed.

### §32.1 A4 — the fifth figure, and the verification

`stockoutDays` was the one figure in the Sales `<dl>` still read straight off the raw payload
(`analytics?.sales.stockoutDays ?? 0`) while its four siblings came through the reading. Same shape
as Available: `?? 0` prints **"0 stockout days" — a clean bill of health — for a field the server
never sent.** It now travels in the `measured` reading with the others, `null` when absent, rendered
"Not known". (A6, `publishPlan.ts:82`, was withdrawn by FE.1 as unreachable — `:94` returns early on
`!validation`. Confirmed and left alone.)

**Verified on screen, on both paths.** The web app had been 500ing on an unrelated `grid.css` parse
error (§32), so this check was outstanding until PES.2 fixed it; it is now done, not assumed.

| | real payload | `{}` — a 200 that carried nothing |
|---|---|---|
| Available | `13` | *(card row replaced)* |
| Stockout days | **`0`** — a measured zero, correctly shown | *(card row replaced)* |
| Cover / risk / quality / reviews | real values | *(card row replaced)* |
| empty `<dd>`s | **0** | **0** |
| in place of the cards | — | *"The server returned no figures for this product, so nothing here is known — including stock. That is an absence of data, not a reading of zero."* |

The failure path was reproduced by intercepting only the analytics read and returning `{}` — the
"succeeded and returned nothing" case. The Ads half still rendered throughout, which is correct:
it is a separate read that succeeded, and one absent payload must not blank the other.

**Green:** 65 ancillary tests, web tsc 0 for my files.

## §33 P2-3 / P2-4 — the casts that disabled the checks (2026-09-02)

### P2-3 — three declarations of one wire row, two of them entered by cast

`ListingAsset` (29 fields) had two hand-written subsets — `CascadeRow` (12) and `EbayRow` (11) —
each reached through `as unknown as`. Two mistakes compounding: **the cast disabled the check, and
the copy was then free to drift from the type it claimed to be a view of.** Both are now `Pick`s.

**Proven, not assumed.** Renaming `ListingAsset.amazonSlot` → `amazonSlotRENAMED`:

- *before*: compiled clean, and the matrix would have read `undefined` at runtime
- *after*: `cascade.ts(62,5): error TS2344: Type '… | "amazonSlot" | …' does not satisfy the
  constraint 'keyof ListingAsset'`

The four members that are optional on `CascadeRow` and required on the wire stay optional via
`Partial<Pick<…>>` — fixtures build rows without them, and widening in that direction is safe:
every real payload still satisfies it. **Both casts are gone**, because a `Pick` of `ListingAsset`
accepts a `ListingAsset` with no help.

### P2-4 — an open union makes `=== 'PUBLISHED'` unchecked

`PublishState` is deliberately open (`| (string & {})`) so a status the server adds tomorrow
survives the parse instead of being coerced — the degrade-don't-drop rule. The cost is that
TypeScript checks nothing about the literal: `=== 'PUBLISHD'` compiles exactly as well, and each of
the three call sites was one typo from silently deciding no row was ever live.

Closing the union would buy the check and lose the degrade, so the comparison is centralised
instead — `isPublished()` in `types.ts`, used at all three sites. One spelling, in one place:
wrong everywhere or right everywhere. A grep confirms no raw `=== 'PUBLISHED'` remains outside the
definition.

### The third cast, found while removing the other two

`CrossChannelPlanner` typed the whole `/listings/publish-readiness` response as a single
`PublishReadiness` — **which is one channel's gate, not the response** — and then reached the
per-channel gates through `as unknown as Record<string, …>`. The type was simply wrong and the cast
is what let it compile. Meanwhile `usePublishGate` had its own private, correct `RawReadiness`
envelope: two declarations of one wire shape, only one of them true.

Now one exported `PublishReadinessByChannel` beside the gate it wraps, shared by both consumers,
indexed by known key with no cast. An unrecognised channel returns `null` — *the server did not
report on it* — which is deliberately not the same as a closed gate.

**Verified on screen** (this one touches behaviour): the planner still reads
*"Every gate is closed on this deployment, so nothing here reaches a channel"*, the button still
says *"Rehearse 2 targets"*, and Amazon IT + eBay IT still resolve to 2 destinations.

**`as unknown as` remaining in this lane: none.**

**Green:** 785 `_studio` tests / 49 files, web tsc 0 for my files, 17 guards 0.

## §34 P4-1 · P4-3 · buy-box honesty · the reorder affordance (2026-09-02)

### P4-1 — a join by array index, in a second place

`currentPrices[i]` was paired with `latestBuyBoxPrices[i]` while both sides carry
`(channel, marketplace)`. BE.1 read the route: **`currentPrices` is one entry per LISTING ROW,
`latestBuyBoxPrices` one per DISTINCT COORDINATE** — parallel only while every listing has a unique
coordinate, which GALE-JACKET satisfies by fixture, not by design. The first second alias an
operator creates puts another coordinate's buy-box price against every row after it, and the result
looks entirely plausible: real prices, real markets, silently mismatched.

**This is the second instance of the same fault in this lane** — the first produced a phantom
"moved" in the snapshot diff. Both hid in an untested helper inside a component, so `joinPriceRows`
now lives in `readAnalytics.ts` with 6 tests, and the join **fans out one-to-many**: a buy box is a
property of the coordinate (per ASIN × marketplace), so several listings on one coordinate all show
that coordinate's price, which is the true answer.

**Proven by mutation:** reverting to the index join fails 4 of the 6, including BE.1's exact case
(a duplicate coordinate, asserting the row *after* it reads its own price).

Identity and join key are now separate: the join uses the coordinate, the row `key` carries an
ordinal, so two aliases on one coordinate cannot be merged by a future `getRowId`. (Nothing consumes
`key` today — this is a trap closed, not a bug fixed.) BE.1's residual — two rows identical in
channel and marketplace with different prices and nothing to tell them apart — is a product question
for the Owner, not a client fix.

### Buy-box honesty — "No observation", not "Not set"

`BuyBoxHistory` holds zero rows, so `buyBoxPrice` is null for every product on every channel today
(PES.5). Verified on screen: no dash, no `0.00`, nothing that reads as a price. But the label was
**"Not set"**, and that is the wrong claim: an unset PRICE is a configuration the seller has not
made; an absent BUY BOX is a reading **we** have never taken. It now reads **"No observation"** — on
screen, all five rows, with the real prices unaffected.

### P4-3 — two `PublishMode`s for one concept

The server says `'gated' | 'dry-run' | 'sandbox' | 'live'`. This lane's copy was **open but
three-membered, missing `sandbox`** — never unsafe, because only `'live'` submits and everything
else degrades to a rehearsal, but unable to say the word. PES.3's had four and was **closed**, so a
mode the server adds tomorrow would not typecheck. Each type's weakness was masked by the other
file's behaviour.

Canonical type now in `_studio/types.ts` — **all four members, still open** — and this lane imports
it. A property test asserts the safety rule across `gated`, `dry-run`, `sandbox` **and a member the
file has never seen**: every non-`live` mode is a rehearsal, and `enabled: false` outranks the mode.

### #327 — the reorder affordance, and what SR.1's evidence did and did not show

SR.1 found no `draggable` attribute and concluded drag was undiscoverable. The first half needed
correcting: **the drag is pointer-based** (`onPointerDown` on the tile → `onPointerMove`/`onPointerUp`
on the gallery, driving `dragId`/`dropTarget`), so `draggable` was never the mechanism and its
absence proves nothing. The conclusion was right anyway — nothing on screen said a drag was
possible.

A 20×20 grip now sits in each tile's top row: `cursor: grab` / `grabbing`, never `help`. It carries
no handler, because pointerdown on the tile already starts the drag and the event bubbles — the
handle is purely the signal. The image keeps `zoom-in`, which is what clicking it does. The title
names the keyboard route as well (`← Move` / `Move →`), because reordering must not be drag-only.

Verified on screen across all 24 tiles: grip present, `grab`, 20×20; image still `zoom-in`.

**Green:** 51 test files, web tsc 0, 17 guards 0.

## §35 Does the images surface hold at hundreds of variations? (2026-09-02)

I told the hub this was untested when D11 raised the Owner's "design for hundreds, not 21"
constraint. Measured now, read-only, while D11 waits on the Owner.

**It holds, for a structural reason rather than a lucky one: nothing in these surfaces iterates
variations.**

- **The grids are per AXIS VALUE, not per variation.** GALE-JACKET has 20 variations and renders
  **3 rows** on both Amazon (shared + Nero + Giallo) and eBay (Default + Nero + Giallo) — measured
  on screen. A 300-variation family with 12 colours renders 13 rows. Both are `NexusGrid`, so they
  virtualise on top of that.
- **`picturelessCoordinates` is rows × columns** — axis values × slots, so 12 colours × 16 slots =
  192 iterations regardless of how many variations sit underneath.
- **No render loop is unbounded.** Every list that could grow is sliced for display: preflight
  errors 12, warnings 8, `usedIn` 12, mirror-losing 8, live strip 24, health-card errors 3. A
  300-variation family cannot produce an unbounded DOM here.
- **The only `variants` use in the whole lane is `variants.length`** — a count for the
  apply-to-children copy. Everything else matching that word is prose in comments.

**The preflight payload, measured rather than guessed:** `/amazon-images/validate?marketplace=IT`
returns **4,691 bytes for 20 ASINs** in 0.4s — **235 bytes per ASIN**, so ~**69 KB at 300**. Not a
scale problem.

**Still untested, and stated as such:** `apply-to-children` is server-side and fans out across every
child, so its cost at 300 is not something the client can measure. Exercising it would mean a
destructive cascade across a real family, which this lane has refused all session. It stays an open
question for whoever owns that route, not a claim of mine either way.
