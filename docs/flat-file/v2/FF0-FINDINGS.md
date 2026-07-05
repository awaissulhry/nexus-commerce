# FF0-FINDINGS — Discovered defects, scope changes & risks

> Phase FF0 (read-only). Per the working protocol, **any defect discovered anywhere is flagged here, never silently fixed out of scope.** Severity: 🔴 blocks or reshapes FF v2 · 🟡 must be addressed within FF v2 · 🟢 note / cleanup. Each finding gives location, impact, and a recommended disposition. Nothing here has been changed.

---

## 🔴 F1 — The spec's canonical data model is wrong (scope-changing)

**Location:** `packages/database/prisma/schema.prisma` — `Product` L83, `ProductVariation` L1223 (comment L1261-1265), `VariantChannelListing` L1357, `ChannelListing` L1413.

**What the spec says (Part II):** *"`ProductVariation` is canonical; `VariantChannelListing` holds per-variant, per-channel, per-marketplace listing state."* It also references `MasterProduct → ProductVariation → VariantChannelListing`.

**Reality proven by schema + write-op census:**
- **`MasterProduct` does not exist.** The de-facto master is **`model Product`** (`isMaster`/`isMasterProduct` flags + self-relation `parentId`/`masterProductId`); **variants are child `Product` rows**.
- **`ProductVariation` is deprecated** — schema comment L1261: *"a deprecated empty table — variants live as child Product rows."* Only **3** `productVariation.*` writes exist in `apps/api/src`, all reconciliation.
- **`VariantChannelListing` is eBay-only residue** — only **4** writes, all on the eBay sync path.
- **The live per-market listing model is `ChannelListing`** (keyed `productId × channel × marketplace`, `@@unique` L1616) — **~70+** writes across routes/workers/services.

**Impact:** building the workbook on the named chain would bind it to dead tables; exports would be empty/stale and imports would write to models nothing reads.

**Recommended disposition:** **Build the workbook on `Product` (parent + child rows) for SHARED data + `ChannelListing` for MARKET-SCOPED data.** Treat `ProductVariation`/`VariantChannelListing` as read-only legacy unless the Owner confirms a live eBay-variation dependency that must round-trip. This is reflected throughout `FF0-FIELD-CENSUS.md` and `FF0-WORKBOOK-SPEC.md`. **Owner decision requested (see FFD9 in FF0-DECISIONS.md).**

---

## 🔴 F2 — Per-market value resolution is a multi-layer resolver, not a column

**Location:** `ChannelListing` L1413-1626 (SSOT block, `followMaster*` toggles L1516+, `*Override` columns, `overrideData` JSON L1496; FieldLink comment L1713-1725).

**What it is:** the effective value of a per-market field is the *output* of a resolver that walks: pinned `ChannelListingOverride` → `FieldLinkGroup` linked group → `*Override` column (only when `followMaster*=false`) → `overrideData` JSON → master `Product` value → schema default.

**Impact — the single biggest threat to "one cell = one field":** a cell showing "price@IT" is a computed projection. Writing that cell back to the wrong layer **silently no-ops** — e.g. setting `ChannelListing.price` while `followMasterPrice=true` changes nothing, because the resolver still returns the master value.

**Recommended disposition:** the workbook must (a) export the **effective** value for readability **and** enough state to know which layer owns it, and (b) on import, write to the correct layer — typically the `*Override` column **and** flip `followMaster*=false` atomically. `FF0-WORKBOOK-SPEC.md` proposes a per-market `follows_master@MKT` control column + override columns so the round trip is explicit. **Owner decision requested (FFD10).**

---

## 🔴 F3 — Market lists are hardcoded in ~20 places; a real BE/PL ID conflict exists

**Hardcoded market lists (drift risks — dynamic discovery must supersede all of these):** 20 sites catalogued in `FF0-MARKET-DISCOVERY.md §3`. The flat-file-specific ones:
- `apps/api/src/services/amazon/flat-file.service.ts:1432` `COVERAGE_MARKETS = IT,DE,FR,ES,UK`
- `apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx:692,7177,8700` `ALL_MARKETS`/`COVERAGE_MARKETS`
- `apps/web/src/app/products/ebay-flat-file/ebay-columns.ts:122` `EBAY_MARKETPLACES`; `MARKET_COLUMN_GROUPS` L497-558

The flat-file editors are **absent** from the list of `/api/marketplaces` consumers — they never query live data, so a newly activated market never auto-appears.

**BE/PL marketplace-ID conflict (genuine bug):** the same SP-API IDs map to opposite countries.
- Backend (`seed-marketplaces.ts:25`, `marketplaces.routes.ts:19`, `amazon.service.ts:18`, `amazon-orders.service.ts:180-181`): `A1C3SOZRARQ6R3` → **PL**, `AMEN7PMS3EDWL` → **BE**.
- Frontend (`apps/web/src/lib/marketplace-code.ts:25-26`): `A1C3SOZRARQ6R3` → **BE**, `AMEN7PMS3EDWL` → **PL**. The file's own comment L11-13 flags this as incorrect.

**Impact:** any market discovery keyed on SP-API IDs inherits the collision (a PL listing mislabelled BE and vice-versa).

**Recommended disposition:** discover markets dynamically from live data (`DISTINCT marketplace` on `ChannelListing`, unioned with active `Marketplace` rows) — see `FF0-MARKET-DISCOVERY.md §2`. Reconcile the BE/PL map as a standalone fix (out of FF v2 scope, but flagged). Prefer discovery keyed on the **code** (`Marketplace.code`), not the raw SP-API ID, to sidestep the collision.

---

## 🔴 F4 — eBay create-logic can silently DETACH a child from its parent

**Location:** `apps/api/src/services/ebay-flat-file-create.logic.ts:679-690` (`classifyRow`).

**What happens:** for an **existing** child row, when `parentage` is absent `classifyRow` falls back to a `platformProductId` heuristic. If `platformProductId` is empty → `isChild=false`; if `existing.parentId != null` the planner emits `reparents.push({ newParentId: null })` — a **detach to standalone**. The code comment even says *"ppid cleared (back-compat)."*

**Impact:** a hand-edited CSV (or any path) that omits `platformProductId`/`parentage` for a child row **silently detaches every such child from its parent** — structural data loss. Currently suppressed only for shared families.

**Recommended disposition:** FF v2's importer must **never infer structural detach from a blank/absent cell.** Reparenting/detach must be explicit (via the `Action` column or an explicit parent-SKU change), consistent with Fidelity Contract §4 ("a missing/blank cell never means destructive change"). Flag the existing heuristic for a guarded fix.

---

## 🟡 F5 — `ebay-import.importEbayCatalog` clobbers content on every run

**Location:** `apps/api/src/services/ebay-import.service.ts:125,131,141`.

**What happens:** on **update** of an existing product, it unconditionally writes `bulletPoints: []` (`:131`) and `productType: 'APPAREL'` (`:125`), and always overwrites `name`. `findUnique where:{sku}` ignores `deletedAt`.

**Impact:** a repeated eBay catalog pull **silently wipes Amazon bullet content** and forces every touched product to `APPAREL`.

**Recommended disposition:** out-of-scope for FF v2's file pipeline but a live data-loss bug — flag for a guarded fix (merge, don't clobber). FF v2 itself must not reuse this write path.

---

## 🟡 F6 — `import-wizard.apply()` "abort" does not roll back (docstring is wrong)

**Location:** `apps/api/src/services/import-wizard.service.ts:16-17` (docstring) vs `:226-231` (code).

**What happens:** docstring says *"'abort' rolls everything back on the first failure."* Code just sets `aborted=true; break`. Already-succeeded rows were committed via individual `product.update` with **no surrounding transaction**, so they persist; the job ends `PARTIAL`. The only "rollback" (`:393`) is a best-effort compensating re-apply of `beforeState` as a new job — **not** a DB rollback.

**Impact:** operators believe an aborted import left no trace; it actually left partial writes.

**Recommended disposition:** FF v2 apply must be **truly transactional in batches** with a real inverse-diff rollback (Fidelity Contract §9). Correct or remove the misleading docstring.

---

## 🟡 F7 — Blank-cell overwrite hazards in the eBay flat-file route

**Location:** `apps/api/src/routes/ebay-flat-file.routes.ts:390,411-417`; `ebay-variation-push.service.ts:1628-1633` (`packSharedFields`).

**What happens:**
- `:390` `price: newPrice ?? undefined` where `newPrice = Number(cell)` — `Number('') === 0`, so a **blank price cell writes 0** (only omission is safe).
- `packSharedFields` returns `title:(row.title)??''`, `description:??''`, written **unconditionally** to every market's `ChannelListing` when any market cell is present → **blank title/description blanks the listing**; blank `listing_status` → `'DRAFT'` + `offerActive:false` (silently un-publishes).

**Impact:** direct silent data loss on the live eBay write path from empty cells.

**Recommended disposition:** the FF v2 diff engine must implement the **explicit blank policy** (blank = no change; `__CLEAR__` = clear) symmetrically, so a blank cell can never overwrite. This is core to the fidelity contract; these route paths are replaced by the audited apply.

---

## 🟡 F8 — Every export >1 MB silently becomes undownloadable (data-loss)

**Location:** `apps/api/src/services/export-wizard.service.ts:177` (`artifactUrl: inline ? null : null` — a no-op that always writes null), `:205-206` (download `else → null`), route `export-wizard.routes.ts:93-96`.

**What happens:** artifacts are stored as base64 in the Postgres row only when `bytes ≤ 1_000_000`. Above that, both `artifactBase64` and `artifactUrl` are null yet `status='COMPLETED'`. Download 404s "Artifact not available." With the 50k-row cap a ~14-column CSV crosses 1 MB easily; scheduled webhook delivery silently no-ops too (`scheduled-export.service.ts:299`).

**Impact:** "Completed" exports that cannot be downloaded — and FF v2's multi-market workbooks will routinely exceed 1 MB.

**Recommended disposition:** **mandatory before FF1 ships multi-market workbooks** — wire real object storage for `artifactUrl` (S3/Cloudinary), or stream the artifact. Highest-priority infra dependency.

---

## 🟡 F9 — `renderXlsx` ignores `format` and mishandles Decimal/dates

**Location:** `apps/api/src/services/export/renderers.ts:126` (raw `readPath` bypasses `formatCell`).

**What happens:** the XLSX renderer writes raw values, so `ColumnSpec.format` (currency/date/number) is dead in XLSX only. The same ExportJob yields `12.34` / `2026-07-05` in CSV but a stringified Prisma `Decimal` object and a native Excel date serial in XLSX.

**Impact:** silent value divergence between formats; identifiers unprotected.

**Recommended disposition:** FF v2's workbook writer replaces this with a **typed cell writer** — forced-text identifiers (`numFmt='@'`), ISO or explicit date policy, locale-safe decimals (Fidelity Contract §5).

---

## 🟡 F10 — No importer wraps its apply in a full transaction

**Location:** `import.service.ts` (none), `import-wizard` apply loop (`:226-231`, none), `stock-import` apply loop (none), `ebay-flat-file.routes.ts:388-449` (per-row, none). Only per-family (create) and per-target (delete) use `$transaction`.

**Impact:** mid-run failure leaves partial writes with no atomic rollback.

**Recommended disposition:** FF v2 apply in **batched transactions** with progress + a recorded inverse diff (Contract §9).

---

## 🟡 F11 — `import.service.ts` is dead code *and* a create-only landmine

**Location:** `apps/api/src/services/import.service.ts:159,167,194,235`.

**What happens:** zero callers. If ever wired: `product.upsert where:{sku}` has **no `deletedAt` filter** → resurrects soft-deleted products and forces `status:'ACTIVE'`; `bulletPoints: row.bulletPoints || []` blank-clears bullets; child models forced `ACTIVE`/`SUCCESS`; no transaction, no diff.

**Recommended disposition:** **delete it**, don't extend it. FF v2's importer supersedes it entirely.

---

## 🟡 F12 — `scheduled-import.fireOnce` auto-applies with no preview/diff gate

**Location:** `apps/api/src/services/scheduled-import.service.ts:238`.

**What happens:** URL fetch → parse → applyMapping → `create()` then immediately `.apply()`. Safe **only** because it inherits the wizard's update-only + blank-skip behavior today.

**Impact:** the moment the underlying importer gains create/delete, scheduled imports become an unreviewed create/delete firehose.

**Recommended disposition:** scheduled imports in FF v2 must run the diff and apply **only auto-approvable, non-destructive** changes (never `DELETE`, never conflicts); anything else parks for manual review.

---

## 🟡 F13 — `delete-family` cascade blast radius

**Location:** `apps/api/src/services/ebay-flat-file-delete.service.ts:396-425`.

**What happens:** soft-deletes the parent **plus every non-deleted child** (`updateMany where:{parentId}`) regardless of which children the operator named; all memberships hard-deleted.

**Impact:** one mis-aimed `delete-family` retires an entire variant family.

**Recommended disposition:** FF v2's `DELETE` action requires typed confirmation ("DELETE N PRODUCTS", Contract/Part V FF2) and the dry-run must show the **full cascade set** (every child that will be soft-deleted), not just the named row.

---

## 🟢 F14 — `/bulk-operations` is largely a graveyard, but the shared grid back-imports from it

**Location:** dead: `BulkOperationsClient.tsx` (4,377 ln, unrendered), `UnifiedFlatFileClient.tsx`, `UnifiedFilterExtras.tsx`, `QueueStatsBanner.tsx`, most of `bulk-operations/_operations|components|lib`. **But** `components/flat-file/FlatFileGrid.tsx:18-21` imports `FindReplaceBar`, `ConditionalFormatBar`, `conditional-format`, `find-replace` **from `app/bulk-operations/`**, and `amazon-flat-file/FFSavedViews.tsx:7` imports `bulk-operations/lib/conditional-format`.

**Impact:** 5 files inside the "dead" tree are **load-bearing** for the live untouchable editors; naive deletion breaks them. Identical copies already exist in `_shared/bulk-edit/`.

**Recommended disposition:** before any cleanup, repoint those 5 imports at `_shared/bulk-edit/`. Not required for FF v2 but a trap for anyone consolidating.

---

## 🟢 F15 — Duplicate/competing columns on the live models (integrity trap)

**Location:** `schema.prisma` — `Product.amazonAsin` vs `parentAsin`; `fulfillmentMethod` vs `fulfillmentChannel`; `isMaster` vs `isMasterProduct` vs `isParent`; `VariantChannelListing.channelPrice` (NOT NULL) vs `currentPrice` (nullable), `channelQuantity` vs `quantity`; `ChannelListing.channelMarket`/`region` vs clean `marketplace` (two unique constraints coexist).

**Impact:** ambiguous which column is authoritative → easy to double-write inconsistently.

**Recommended disposition:** the field census (`FF0-FIELD-CENSUS.md`) picks **one authoritative column per concept** for the workbook and marks the legacy twins excluded/readonly. Documented per field there.

---

## 🟢 F16 — Inconsistent sentinels, nullability, and enum illusion

- `ChannelListing.marketplace` defaults `"DEFAULT"` while `VariantChannelListing.marketplace` defaults `"GLOBAL"` — different sentinels for the same idea.
- `ChannelListing.price` is nullable (falls back to master `basePrice`); `VariantChannelListing.channelPrice` is NOT NULL.
- Only **two** real DB enums touch these models (`FulfillmentMethod`, `PricingRuleType`); channel/marketplace/status/PPE-class/variation-theme are **free strings** — DB enforces nothing, so **all enum validation must live in the import layer**.
- `version` optimistic-concurrency counters (`Product` L409, `ChannelListing` L1610) and `flatFileSnapshot` (JSON) are round-trip traps — see `FF0-FIELD-CENSUS.md §Round-trip risks`.

**Recommended disposition:** census + workbook spec handle each explicitly (strip `version` on import; forced-text/normalized enums; documented blank policy; `flatFileSnapshot` excluded from cells).

---

## Summary table

| # | Sev | One-liner | Disposition |
|---|---|---|---|
| F1 | 🔴 | Named data chain is deprecated; live chain is Product→ChannelListing | Build workbook on Product+ChannelListing (FFD9) |
| F2 | 🔴 | Per-market value is a multi-layer resolver, not a column | Export effective value + layer state; write override + flip follow flag (FFD10) |
| F3 | 🔴 | ~20 hardcoded market lists + BE/PL ID conflict | Dynamic discovery by code; flag BE/PL fix |
| F4 | 🔴 | Blank cell can silently detach a child (structural loss) | Never infer detach from blank; explicit Action only |
| F5 | 🟡 | eBay import wipes bulletPoints / forces APPAREL every run | Flag guarded fix; don't reuse path |
| F6 | 🟡 | import-wizard "abort" doesn't roll back | Transactional apply + real inverse-diff rollback |
| F7 | 🟡 | Blank price→0, blank title/desc blanks listing | Explicit blank/`__CLEAR__` policy |
| F8 | 🟡 | Exports >1 MB silently undownloadable | Wire real artifact storage before FF1 |
| F9 | 🟡 | renderXlsx ignores format, mangles Decimal/dates | Typed cell writer (forced text, ISO, locale) |
| F10 | 🟡 | No full-transaction apply anywhere | Batched transactional apply |
| F11 | 🟡 | Dead Rithum importer is a create-only landmine | Delete it |
| F12 | 🟡 | Scheduled import auto-applies with no gate | Auto-apply only non-destructive diffs |
| F13 | 🟡 | delete-family retires whole family | Typed confirm + show full cascade in dry-run |
| F14 | 🟢 | bulk-operations graveyard back-imported by live grid | Repoint 5 imports before cleanup |
| F15 | 🟢 | Duplicate/competing columns | Census picks one authoritative column each |
| F16 | 🟢 | Sentinel/nullability/enum-illusion + version/snapshot traps | Handled in census + spec |
