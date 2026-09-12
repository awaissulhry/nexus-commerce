# 21 — Amazon APPLY-TO-SIBLINGS (template-apply + undo snapshot) + the Amazon TEMPLATE VAULT / family workbook

## 1. What it is (operator terms)

Two separate capabilities that the pointers bundle because both are "copy an Amazon setup".

**Apply-to-siblings** is the catalogue operator's fan-out: *"I finished configuring GALE-KAN-PRO for
Amazon·IT — put the same attribute set, condition and (optionally) product type onto the 40 other
racing suits."* Used once per new category or after a schema change, by whoever owns Amazon listings.
Today it is a modal launched from the Amazon cockpit: pick N same-`productType` products from a flat
checkbox list, tick which of three layers to copy, press Apply, get a per-target ✓/✗ list. Each
target is "snapshotted for undo" first.

**The template vault / family workbook** is the Amazon workbook machinery: every official Amazon
`.xlsm` Custom Listings Template the operator imports is captured verbatim (bytes) into
`AmazonTemplateVault`, and a *filled* single-family workbook is additionally captured as
`AmazonFamilyWorkbook` keyed `(familyKey, marketplace)`. "Export for Amazon (.xlsm)" then clones
those bytes and rewrites **only** the Template sheet's data rows from the grid, so Amazon's own
valid-values sheets, localized dropdowns, macros and named ranges survive byte-for-byte and the file
re-uploads to Seller Central like a hand-edited original. It is account/market-level asset plumbing,
not per-product state — and it lives entirely inside the untouchable flat-file page today.

## 2. Old UI — inventory

**Entry point.** `AmazonCockpit.tsx:86` imports it, `:890` renders it. Sibling: the eBay copy at
`tabs/ebay-cockpit/EbayCockpit.tsx:70,812`.

**Component.** `tabs/amazon-cockpit/templates/ApplyToSiblingsModal.tsx` (311 lines; eBay's is 404,
a near-duplicate with six layer flags instead of three — two forks of one modal).

- Hand-rolled modal: `fixed inset-0 z-50 … bg-slate-900/50` with its own `role="dialog"`
  (`:142-149`) and its own Escape listener (`:84-91`). No DS Modal.
- COLLECT: `GET /api/amazon/cockpit/template-candidates?productId&marketplace` on open
  (`:69-72`), rendered as a checkbox list (`CandidateRow`, `:284`) with a "Select all N" toggle
  (`:198`). No search, no filter, no paging — whatever the server's first 50 rows are.
- Layer chooser: three `ScopeChip` toggles — Attributes / Condition / Category (`:169-171`),
  `DEFAULT_SCOPE = { attributes: true, condition: true, category: false }` (`:49`). Category
  carries an inline amber warning (`:173-178`).
- No PREFLIGHT and no CONFIRM: the footer is a single blue "Apply to N" button (`:248-256`).
  Nothing tells the operator which cells change on which target before the write.
- RUN: `POST /api/amazon/cockpit/template-apply` (`:115`), then `router.refresh()` (`:129`) —
  which refreshes the **donor's** page, the one page whose data did not change.
- Result: per-target ✓/✗ list showing a truncated product **id**, not a SKU (`:226`), plus the
  claim *"Each target got a 'pre-template-apply' snapshot — undo per target via version history"*
  (`:232`).

**Server round-trips vs browser-local:** everything round-trips (two calls). No localStorage. Layer
selection is not remembered between opens.

**What is DEAD:** the modal itself is reachable. The **undo it advertises is dead on Amazon** — see
§5.1. Nothing else in the Amazon tree reads a `_versionHistory` entry.

**Vault side (READ-ONLY context, untouchable).**
`AmazonFlatFileClient.tsx:3321-3331` fetches `GET /api/amazon/flat-file/template-vault?marketplace=…`
to gate the menu item; `:3339-3375` posts `export-template`; the menu items are at `:3756-3763`
("Export for Amazon (.xlsm) — <filename>" / "… — import an Amazon template first" / "… WITH
quantities"). `ImportWizardModal.tsx:741` tells the operator a just-imported filled workbook became
that family's export base.

## 3. Backend that exists

**Apply-to-siblings.** `apps/api/src/routes/amazon-cockpit.routes.ts` (285 lines, whole file), FM.11,
registered `apps/api/src/index.ts:776` under `/api`:

- `GET /amazon/cockpit/template-candidates` (`:22-84`). Products with the same `productType`,
  `deletedAt: null`, `id != donor`, plus `parentId: donor.parentId ?? { not: productId }` (`:40`);
  `limit` default 50, max 200 (`:26`). Then one `channelListing.findMany` for AMAZON×marketplace
  (`:51-58`) to attach `hasListing` / `listingStatus` / an `attributeCount`.
- `POST /amazon/cockpit/template-apply` (`:94-216`). Builds `layout` from the donor's
  `platformAttributes` — `attributes`, `condition_type`, and on opt-in `productType` +
  `browseNodeId` (`:128-139`); max 200 targets (`:111`). Per target: read the listing, push a
  `{id, ts, reason:'pre-template-apply', snapshot:{platformAttributes, priceOverride, quantity}}`
  entry onto `platformAttributes._versionHistory` capped at 10 (`:161-171`), then **create** a
  `DRAFT`/`isPublished:false` ChannelListing if none exists (`:177-189`) or
  `casUpdateChannelListing(prisma, id, undefined, …)` if one does (`:193`).
- `POST /amazon/cockpit/promote-to-master` (`:222-282`) — adjacent, not this feature.

eBay counterpart: `apps/api/src/routes/ebay-cockpit.routes.ts:1706-1830`, six layer flags
(aspects/policies/bestOffer/variations/compatibility/category), same `_versionHistory` shape, but a
plain `prisma.channelListing.update` (`:1824`) — **no version bump at all**.

**Prisma.** `ChannelListing.platformAttributes` (Json) is the store on both sides;
`ChannelListing.overrideData` is the store the *studio* writes (§5.12). The undo lives inside
`platformAttributes._versionHistory`, not in a table. The modern mechanism is
`ChannelListingSnapshot` (`packages/database/prisma/schema.prisma:1800-1830`) with
`reason: 'pre-publish' | 'pre-restore' | 'manual'`, denormalised coordinate, `payload`, `label`.

**Vault.** `packages/database/prisma/schema.prisma:16111-16128` `AmazonTemplateVault`
(`templateIdentifier @unique`, `marketplace`, `productTypes[]`, `headerLanguageTag`, `filename`,
`bytes Bytes`) and `:16130-16147` `AmazonFamilyWorkbook` (`@@unique([familyKey, marketplace])`,
`templateIdentifier`, `filename`, `bytes`, `rowCount`).

Service `apps/api/src/services/amazon/template-vault.service.ts` (335 lines):
`vaultKeyFor` (`:40`), `captureTemplateToVault` (`:52`), `detectWorkbookFamilyKey` (`:85`),
`deriveFamilyKeyFromGridRows` (`:111`), `captureFamilyWorkbook` (`:127`), `resolveExportBase`
(`:156` — explicit id → family workbook on the exact market → most-recent market template),
`listVaultEntries` (`:189`, bytes excluded), `buildTemplateDataRows` (`:213`, pure, tested),
`buildAmazonTemplateExport` (`:283`). Byte rewrite is `./template-workbook.js`
`rewriteTemplateDataRows` (671 lines). Reverse header→column mapping reuses the import wizard's own
`suggestFlatFileMapping` (`flat-file-mapping.ts`), so import and export are symmetric by
construction.

Routes (all under the untouchable flat-file file `apps/api/src/routes/amazon-flat-file.routes.ts`):
capture is fire-and-forget inside `POST /amazon/flat-file/parse` (`:1000` template, `:1007` family);
`GET /amazon/flat-file/template-vault` (`:1316`); `POST /amazon/flat-file/export-template` (`:1337`),
which replies `.xlsm` bytes plus `X-Export-Rows`, `X-Export-Mapped-Headers`, `X-Export-Base`,
`X-Export-Family`, `X-Export-Source-File`.

**Safety gates that are already correct and must survive any rebuild** (`template-vault.service.ts`
`:19-23`, `:240-244`): `::record_action` is **always** exported blank; **FBA quantity is never
exported** (`FBA_CHANNEL_RE` on the row's fulfillment channel); FBM quantity is blank by default too
(RT.6 / owner decision D8 — the real-time sync owns quantities), opt-in only.

**External channel calls:** none. Both features are database-only. Nothing here calls SP-API, so
there is no publish-mode gate — but `template-apply` **creates listing rows**, which the outbound
paths later read.

**Jobs/crons:** none. `template-apply` runs the whole 200-target loop inside the request.

**Permissions.** `apps/api/src/lib/auth/permissions-manifest.ts:353`
`RW(F.listingsView, F.channelsSync, pfx('/api/amazon'))` catches `/api/amazon/cockpit/*` — so
GET candidates needs `listings.view`, POST template-apply needs `channels.sync`. `:338`
`P(F.listingsFlatfileEdit, pfx('/api/amazon/flat-file'))` covers the vault and export.
**But the gate is not on:** `apps/api/src/lib/auth/rbac-hook.ts:29-30` — `mode()` returns
`'enforce'` only when `NEXUS_RBAC_MODE === 'enforce'`, default `'shadow'` (log-only,
`index.ts:630-633`).

## 4. Studio today

- **Nothing.** Parity audit **row 3.31**: *"🕳 — no apply-to-siblings, and no undo snapshot. Bulk-fill
  exists on the master sheet (PES.2), not per channel."* (`docs/pes-parity-audit.md:153`). eBay's
  equivalent is **row 3.52**, also 🕳 (`:178`).
- The closest built thing is `broadcastToListings` in
  `_studio/sheet/channel/channelActions.ts:304-358` — a `SELECTION` verb, "Broadcast to other
  markets…", full COLLECT→PREFLIGHT→CONFIRM→RUN shape, `type-to-confirm` with the channel name as
  the phrase, and a `run` that deliberately returns `ok: false, "Not sent."` (`:352`). It is the
  cross-**market** twin of apply-to-siblings' cross-**product** fan-out.
- The family verbs are declared: `_studio/sheet/master/familyActions.ts:109+` — `attach-existing`
  is a `contextOf('product-family')` verb whose targets are products **not in the sheet**, collected
  by a picker (`:121-140`). That is exactly apply-to-siblings' shape, and the precedent for it.
- Export ▾ is a two-item menu today: `_studio/sheet/SheetToolbar.tsx:217-241`
  (`export-view` / `export-all`), fed by `_studio/sheet/sheetExport.ts:84` `exportSheet`, wired in
  `MasterSheet.tsx:1671,1800` and `ChannelSheet.tsx:1391,1955`. Format is CSV with D15.2's key row.
- Import accepts **`.csv` only** — `_studio/import/ImportDrawer.tsx:350` `accept=".csv"`; its
  "Download template" is absent and says so (`:385`, D15.9 unshipped, ledger line 8365).
- Snapshot/restore that a rebuilt undo should use already exists: `product-studio.routes.ts:705`
  list, `:716` capture, `:741` restore-to-draft (auto-snapshots the current state first and returns
  `undoSnapshotId`); `:669` `GET /products/:id/restore-points`. Drawer surface:
  `_studio/drawer/panes/HistoryPane.tsx` + `RestoreMode.tsx`.

**Hub rulings that bind this feature**

- **#85 / #86** — apply-to-siblings is one of "the 22": per-LISTING channel operations the sheet has
  none of; *"a sheet is the wrong shape for them"*. Owner disposition taken, build deferred:
  apply-to-siblings is explicitly **WAVE 2, queued, not dispatched**
  (`docs/pes-claims.md:20452`, `:21046-21047`, `:25264-25265`).
- **#110** — one action registry; every surface renders the same rules. A second verb system for
  this would be a fork.
- **#118** — COLLECT before PREFLIGHT: the picker runs first, then the preflight describes those
  particular targets.
- **#357** — a page must not report itself as a total (bears on `total: candidates.length`).
- **D15.13 / #495 / #600** — the diff and job contract: `verdict` + `pins` flag, server-stated
  counts, `partial` its own state.
- **D15.14.2 / #501** — the job record is `BulkOperation`, extended additively; *"One store for
  imports AND §3's bulk verbs"*. That is the restore point this verb should write.
- **D15.10 / V.3** — CSV first; **XLSX explicitly not in v1**
  (`docs/2026-09-04-sheet-views-and-full-attributes-design.md:201`).
- **A.4, approved 2026-09-05** — one store per shape, readers follow the writer; channel store is the
  typed column where one exists, else `overrideData[key]`
  (`docs/2026-09-04-channel-attribute-model-design.md:171-186`).

## 5. Defects and slowness

1. **The advertised undo does not exist on Amazon.** `template-apply` writes
   `_versionHistory` entries (`amazon-cockpit.routes.ts:161-175`) and **no Amazon endpoint reads
   them**: `grep -rn "_versionHistory"` finds readers only in `ebay-cockpit.routes.ts:895-1011`
   (snapshot/restore) and `EbayCockpit.tsx:184`. `AmazonCockpit.tsx` has zero matches for
   `versionHistory|snapshot`. So `ApplyToSiblingsModal.tsx:232`'s *"undo per target via version
   history"* is a false claim to the operator on the Amazon side — a 100%-honest-UI violation.
   **CODE-READ.**
2. **The copy REPLACES rather than merges.** `nextPlatform = { ...prevPlatform, ...layout }`
   (`:172-176`) is a shallow spread, so `layout.attributes` overwrites the target's **entire**
   attribute map. The UI says "Copy … attributes" and never says the target's own attributes are
   discarded. **CODE-READ.**
3. **The undo is capped at 10 and stores whole bags inline.** `.slice(0, 10)` (`:171`) silently
   evicts the oldest entry, and each entry embeds the full `platformAttributes` — so the row grows
   and the earliest restore point vanishes without notice. **CODE-READ.**
4. **No preflight, no diff, no impact.** The modal's confirm is a button with a count
   (`:248-256`); nothing states cells changed / targets whose category differs / listings that
   would be created. This is the exact inversion of `registry.ts:221`
   `PARAMETERISED_VERB_ORDER = ['collect','preflight','confirm','run']`. **CODE-READ.**
5. **Concurrency is inconsistent and, on eBay, absent.** Amazon calls
   `casUpdateChannelListing(prisma, id, undefined, …)` (`:193`) — bumps the version, guards nothing;
   eBay uses a bare `channelListing.update` (`ebay-cockpit.routes.ts:1824`) — no bump, so the
   flat-file editor cannot detect the change at all. Two behaviours from one feature. **CODE-READ.**
6. **Serial N+1 in-request.** The loop (`:147-205`) does one `findFirst` + one write per target, up
   to 200 targets — ~400-600 sequential round trips inside a single HTTP request, no batching, no
   job, no progress, no timeout. **CODE-READ.**
7. **A silent catalogue-wide side effect.** Targets with no listing get a ChannelListing **created**
   (`:177-189`). Applying to 200 products can mint 200 `DRAFT` Amazon listing rows; the modal
   discloses only a small "no listing yet" chip (`:295`). **CODE-READ.**
8. **The candidate set means two different things.** `parentId: donor.parentId ?? { not: productId }`
   (`:40`): for a **child** donor it is that donor's true siblings; for a **parent/standalone** donor
   it is *every product in the catalogue* with that `productType`. Same button, same "siblings"
   label. **CODE-READ.**
9. **`total` is the page, not the total.** `total: candidates.length` (`:82`) after a `take: limit`
   (default 50) — #357's trap verbatim. **CODE-READ.**
10. **The write is effectively ungated today.** RBAC default is shadow/log-only
    (`rbac-hook.ts:29-30`); the manifest's `channels.sync` on `/api/amazon` (`:353`) only bites at
    `NEXUS_RBAC_MODE=enforce`. A 200-listing mutation is reachable by curl. **CODE-READ.**
11. **`router.refresh()` refreshes the wrong page** (`ApplyToSiblingsModal.tsx:129`) — the donor,
    whose data did not change; the targets are elsewhere. **CODE-READ.**
12. **🔴 The store split — the biggest one.** The old endpoint writes
    `platformAttributes.attributes`. The studio's channel writer merges into
    `ChannelListing.overrideData` (`products.routes.ts:2471-2480`, `:2565`;
    `studio-sheet.service.ts:508-527` route 2 / #169). The approved channel-attribute design measured
    both: `platformAttributes.attributes` holds **107 keys on 725 of 725** GALE listings, while a
    sheet write to `attr_bullet_point` lands in `overrideData` which is **`{}` on every GALE
    listing** — *"A write nothing reads"*
    (`docs/2026-09-04-channel-attribute-model-design.md:42,46`). The read side already follows the
    declared store (`studio-sheet.service.ts:1133-1143`, `store.kind === 'platformAttributes'`), the
    write side does not. Any studio apply-to-siblings built on the studio writer today would copy
    107 attributes into a bag the feed, the resolver and the flat-file editor never read.
    **MEASURED-IN-DOC + CODE-READ.**
13. **The studio has two verbs whose COLLECT step cannot be reached, and no picker anywhere.**
    `ChannelSheet.tsx:727` passes `pickMarkets: async () => null`, so `broadcast-to-listings` always
    resolves "No markets chosen"; `MasterSheet.tsx:446` passes
    `pending: newVariation ? { newVariation } : undefined`, so `attach-existing` is permanently
    disabled on "Pick the products to attach first" — and there is no `attach-existing` UI in
    `_studio/**` at all. `grep -rn "ProductPicker|searchProducts|/api/products/search"` over
    `design-system/` returns nothing. **The missing picker is the shared blocker for three verbs.**
    **CODE-READ.**
14. **`/products/next` runs a second, parallel verb system.** `next/useBulkActions.ts` is bespoke
    fetch-and-toast (`BULK_MAX = 200`, `:15`), not the action registry. Putting a copy verb there
    would fork the implementation #110 forbids. **CODE-READ.**
15. **`AmazonFamilyWorkbook` is write-only from the operator's side.** Only `resolveExportBase`
    (`template-vault.service.ts:164-169`) reads it; there is no list, no delete, no replace, no
    surface that says which base a family is on. The only disclosure is the `X-Export-Base` /
    `X-Export-Family` response headers of a download that already happened. **CODE-READ.**
16. **Untouchable-side observation, report-only:** the flat-file client sends **0 of 38** fetches
    with `credentials: 'include'` (`grep -c` on `AmazonFlatFileClient.tsx`), the vault list and
    `export-template` among them. Under `NEXUS_RBAC_MODE=enforce` those become 403s and the vault
    menu would silently degrade to "import an Amazon template first" (`:3757`) because the catch
    sets `[]` (`:3329`). **CODE-READ.**
17. Giant components in the neighbourhood, for the record: `AmazonFlatFileClient.tsx` 6862 lines,
    `AmazonCockpit.tsx` 989, the two ApplyToSiblings modals 311 + 404 (near-duplicates).
    **CODE-READ.**
18. **Missing tests.** `apps/api/src/routes/amazon-cockpit.routes.ts` has no test file
    (no `amazon-cockpit*.test.ts` anywhere); the vault service has two
    (`template-vault-family.vitest.test.ts`, `template-workbook.vitest.test.ts:472-517`). The
    untested half is the one that writes 200 listings. **CODE-READ.**

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**PRIMARY: H5 — a `CONTEXT(alias-group)` verb, `copy-channel-setup`, "Copy this Amazon setup to…",
declared once in `channelActions.ts` and rendered on the alias band's ⋯.**
What is being copied is one **coordinate's** configuration (Amazon·IT), not the family's master
data — and the alias band is the only surface in the studio that already stands for exactly that:
one listing, one channel, one market. The donor is therefore never ambiguous (it is the band you
pressed), which is what makes a "copy" verb safe; a selection of N rows has no donor. `attach-existing`
(`familyActions.ts:121`) is the standing precedent that a CONTEXT verb may act on products that are
not in the sheet, collected by a picker before the preflight (#118). Declared once, the registry
mirrors it onto the row context menu, the ⋯ column, the selection bar and the drawer for free
(#110) — so it is never drawer-only, which channel-ops research §3.2 forbids.

**MIRROR: H4 — the same verb on a SELECTION of variant rows**, meaning "copy only these SKUs' setup".
Free from the registry; the preflight simply reports fewer source rows.

**MIRROR: H7 — the drawer's History pane** gets the resulting restore point, via the existing
`GET /products/:id/restore-points` + `RestoreMode` (`HistoryPane.tsx:52-81`). This is where the undo
that Amazon never had actually lands, and it is the same control an operator already uses for a
publish restore — one restore doctrine, not a second "version history" nobody reads (§5.1).

**MIRROR: H9 — Errors & Sync** receives the per-target outcomes. This verb is unique among the 22 in
that **its effects are invisible in the sheet it was launched from** — the targets are other
products. A toast listing truncated product ids (today's `:226`) is not an audit trail for 200
writes; a queue row per failed target, grouped by cause, jumping to that product's studio, is.

**NOT on `/products/next` in v1 (H12 for that half).** Two reasons, both measured: a multi-row
selection there has no donor, and `next/useBulkActions.ts` is a separate verb system (§5.14) — adding
the verb there would fork it. If the Owner later wants cross-family fan-out from the catalogue, the
correct shape is an **H3 ROW verb** on `/products/next` ("Use this product as the Amazon template…")
that opens the *same* picker inverted — and it should wait until `/products/next` consumes
`grid/actions/registry`.

**Template vault / family workbook: H11 — stays entirely outside the studio, plus one link-out.**
The vault is keyed by `templateIdentifier` and `(familyKey, marketplace)`: an account-and-market
asset library, which is H11's definition. Three concrete reasons not to move it:
(a) `buildAmazonTemplateExport` consumes a **flat-file manifest** (`FlatFileMappableColumn =
{id, labelEn?, labelLocal?, fieldRef?}`, `flat-file-mapping.ts:21-27`) plus rows keyed by flat-file
column ids, and the studio's slot columns are `<base>_<n>` where Amazon's are `bullet_point#N`
(`sheet-columns.service.ts:93-97` vs `channel-attribute-model-design.md:152`) — an adapter, not a
menu item; (b) the studio import accepts `.csv` only (`ImportDrawer.tsx:350`), so an `.xlsm` export
would be a file the studio cannot take back, breaking D15.1's round-trip promise and contradicting
D15.10 / V.3 (XLSX not in v1); (c) the byte-rewrite path and its two non-negotiable rails
(`::record_action` blank, FBA quantity never exported) are tested and untouchable — re-implementing
them is the worst trade in this report.

So the studio's **Export ▾ gains a third item, `Export for Amazon (workbook)…`, visible only on an
Amazon channel scope**, which (i) names the base that would be used — the family's own workbook if
`AmazonFamilyWorkbook` has `(familyKey, marketplace)`, else the market template, else a stated
reason — and (ii) **links out** to the flat-file page pre-scoped to this family × market. That makes
the vault discoverable from the studio (today nothing outside the flat-file page mentions it exists)
without duplicating a line of byte logic, and it honours "extend, don't add pages" and the
untouchable rule at once. The in-studio variant is §9's open question 3.

The vault also needs a **manager** eventually — H11 at `/channels/amazon/templates`: which template
is the base per market, which families have their own workbook, replace/delete one (§5.15: none of
that exists). Name it now, build it when the Owner asks.

### 6.2 What the sheet shows at rest, per scope

- **master scope:** nothing. The verb is `HIDDEN` here (§6.4).
- **channel scope (Amazon·IT):** nothing new in the grid — this is a verb, not a value. The only
  at-rest change is one item in the alias band's ⋯ menu. No column, no mark, no chip: adding a
  "copied from" column would be a claim the store cannot back (a copied value is
  indistinguishable from a typed one once written, and inventing a provenance class for it would
  break §9.6's four marks).
- **After a run, on the DONOR's sheet:** nothing repaints, because nothing on the donor changed.
  That fact is why the result belongs in Errors & Sync (H9) and why the confirm must be
  `type-to-confirm`.
- **On a TARGET's sheet, next time it is opened:** the copied cells carry the ordinary **✎ pinned**
  provenance mark, because a channel-targeted write pins (§6.5). The preflight must say so up front
  using D15.13.1's `pins` flag.

### 6.3 The interaction, step by step

1. **Open.** Alias band ⋯ → "Copy this Amazon setup to…". (Mirrored: right-click a variant row →
   same verb, scoped to that row; selection bar when ≥2 rows are selected.)
2. **COLLECT** (#118) — one dialog, two halves, in a **new DS `EntityPicker`** (§6.3 note):
   - *What to copy*: a `MultiSelect` over the **sheet's own groups** (`SheetGroup`) plus "the active
     view (23 columns)" and "all attributes (97)". This deliberately replaces the old modal's three
     hardcoded Amazon layers (`ApplyToSiblingsModal.tsx:169-171`) — reusing V.9's presets means the
     same control works for eBay and Shopify with no per-channel code, and the operator picks in the
     vocabulary the sheet already taught them.
   - *Where to copy it*: a searchable, server-paged product list (`Combobox` for search +
     `PressableRow` rows + `Checkbox`), defaulting the filter to "same product type" but **not
     restricting to it**, with each row stating `hasListing`, `listingStatus`, and `≠ type` when it
     differs. Footer: `N of M selected · max 200`.
3. **PREFLIGHT** — `POST /api/products/:id/studio/copy-setup/preflight`, returning **D15.13's diff
   shape** so the operator sees the same diff UI as an import: per target, per cell,
   `verdict: unchanged | changed | refused` + `pins: boolean`, `beforeLabel`/`afterLabel`,
   server-stated `counts`. The `ActionImpact` level comes from the preflight, never a flag: any live
   target ⇒ `type-to-confirm` with the channel name as the phrase (broadcast's rule,
   `channelActions.ts:344`); listings that would be **created** are listed under `sideEffects`, never
   inferred.
4. **CONFIRM** — the existing `grid/actions/ActionConfirm.tsx`, unchanged. Counts come from the
   preflight, not the selection (`useBulkActions.ts:68-71`'s rule).
5. **RUN** — one `PATCH /api/products/bulk` per batch with `changes[].target: 'channel'` +
   `marketplaceContexts` (R.1 fan-out, `products.routes.ts:1037-1044`). Server writes one
   `BulkOperation` row = **the restore point**, revertible through the existing import-revert path
   (D15.14.2). Response repaints: the toast reports the **server's** counts; Errors & Sync gains a
   group; the drawer's History pane gains a restore point on each target.
6. **Keyboard:** the picker is a DS Modal — Escape cancels (not during run), Enter on the footer
   button advances, `⌘/Ctrl+A` selects the visible page only (never the unloaded remainder).
7. **With the drawer open:** the drawer is non-modal and the sheet stays live
   (layout-v2-spec §5), but the picker is a Modal and takes focus. The drawer must not be
   force-closed — on completion it refetches its own restore points if the open record is one of
   the targets.

*The ONE new DS component:* **`EntityPicker`** — Modal + Combobox search + virtualised
`PressableRow` list + multi-select + a "N of M · max K" footer, with a server-paged datasource. No
current export covers it (`MultiSelect`/`Listbox` are option lists over a known set, not a
server-searched entity set). Building it once unblocks **three** stalled verbs:
`copy-channel-setup`, `attach-existing` (§5.13) and `broadcast-to-listings`' market picker.

### 6.4 Per-scope rules

- **master scope: `HIDDEN`.** Copying master attributes across products is a different operation
  (that is bulk edit on `/products/next`), and a master-scoped copy would change *every* channel —
  the trap `CHANNEL_FIELD_MAP` creates. Hidden, not disabled: the verb is meaningless here, and
  #114's rule is that a greyed control which cannot explain itself is worse than no control.
- **channel scope:** available. The donor is the alias band's coordinate.
- **alias band vs row:** the band copies the whole alias's setup for every variant under it; a row
  selection copies only those SKUs. Same verb, different `rows` argument — no second declaration.
- **Single-store channels (Shopify / Woo / Etsy): `disabled`, with the real reason.**
  `marketplaceContexts[].channel` is typed `'AMAZON' | 'EBAY'` on the write endpoint, so those
  coordinates have **no channel write route at all** (`studio-sheet.service.ts:520-527`). The verb
  must say that, not hide it — the reason is a platform fact the operator should know.
- **eBay:** identical verb, same declaration, eBay's own layer names come from its groups. Wave-1
  channel verbs are preview-only against live listings — and the refusal must test **every target**,
  not only the donor (today's `broadcastToListings` only tests source rows,
  `channelActions.ts:341-343`).
- **Amazon EU:** a target on a different EU market shares its quantity with its siblings
  (`reference_amazon_shared_eu_quantity`). Quantity must never be in a copyable group. Follow the
  export's own precedent: quantity is excluded by default and by rail, not by operator care.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance:** a copied cell on the target is an ordinary channel write, so it renders **✎ pinned**
  by the existing rules (D15.7's logic: the value is the operator's, delivered in bulk). No new mark.
  The preflight's `pins` count is the honest disclosure of that — "412 change (38 of them pin)".
- **Autosave:** this verb does **not** go through `SheetWriter`. It is a deliberate, confirmed bulk
  operation, not a cell edit; it must not be batched with pending autosaves. It should, however,
  refuse to run while the donor sheet has un-flushed writes — otherwise it copies a state the
  operator can still see on screen but the server does not have yet
  (`reference_autosave_still_needs_a_nav_guard`, and the in-flight-autosave-undid-a-revert trap).
- **Readiness:** each target's readiness recomputes from the one server definition
  (`services/pim/readiness.service.ts`) — no client-side recompute, no optimistic chip.
- **Publish:** copying **never** publishes. Targets become drafts-with-changes; publish stays
  explicit, per channel, preflight-first (`getAmazonPublishMode`, never env). Targets that had no
  listing get one created **as a draft** — and unlike today that must be a stated `sideEffect`, not
  a chip in a list.

### 6.6 ASCII mockup — the COLLECT step

```
┌─ Copy Amazon · IT setup from GALE-KAN-PRO ──────────────────────────── ✕ ─┐
│ WHAT TO COPY                                                              │
│  [▾ 4 groups · 41 columns]   ⟨ Product identity · Content · Specs ·       │
│                                Compliance ⟩                               │
│  ○ The active view (23)   ○ All attributes (97)   ● Groups…               │
│  ⚠ Product type is in "Product identity" — targets in another category    │
│    will be re-typed. Quantity and images are never copied.                │
├───────────────────────────────────────────────────────────────────────────┤
│ WHERE TO COPY IT            Search  [ racing suit▌            ]           │
│  Filter: ●same product type  ○any    Only with an Amazon·IT listing ☐     │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │ ☑ GALE Kanto Pro Suit      GALE-KAN-PRO-2   ● live   97 attrs     │    │
│  │ ☑ GALE Sento Suit          GALE-SEN         ○ draft  41 attrs     │    │
│  │ ☐ AIREON Track Suit        AIR-TRK          — no listing  ≠ type  │    │
│  │ ☑ GALE Junior Suit         GALE-JR          ○ draft   0 attrs     │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│  3 of 41 selected · max 200 · 1 has no listing (one would be created)     │
├───────────────────────────────────────────────────────────────────────────┤
│                                        [ Cancel ]  [ Preview changes → ]  │
└───────────────────────────────────────────────────────────────────────────┘
```

## 7. Contracts and data

**Reused as-is**

- `PATCH /api/products/bulk` with `changes[].target: 'channel'` + `marketplaceContexts` — the R.1
  fan-out (`products.routes.ts:1037-1044`, `:2469-2485`). One writer means CAS, `BulkOperation`,
  formula re-evaluation, read-cache refresh and the financial filter all apply for free.
- `BulkOperation` as the restore point + its revert path (D15.14.2, `import-jobs.service.ts`).
- D15.13's diff/job shape, so the preflight renders in the **existing** import-diff UI.
- `ChannelListingSnapshot` + `POST …/snapshots/:id/restore` for a per-target listing-level
  checkpoint where one is wanted (`product-studio.routes.ts:716,741`).
- `grid/actions/registry.ts`, `ActionConfirm.tsx`, `runAction.ts` — no engine change.
- The entire vault/workbook stack, untouched, reached by link-out.

**New server pieces (PES.5)**

1. `GET /api/products/:id/studio/copy-targets?channel&market&q&cursor` — the fixed candidate query:
   server-paged with a real `hasMore`/`next` (never `total = page.length`, §5.9); the
   same-product-type filter is a **parameter**, not a hidden branch on whether the donor is a parent
   (§5.8); returns `{ productId, sku, name, productType, hasListing, listingStatus, live }`.
2. `POST /api/products/:id/studio/copy-setup/preflight` — body `{ channel, marketplace, columnKeys[],
   targetProductIds[] }`, returns D15.13's diff. Should reuse `import-diff.service.ts`'s own
   comparison rather than re-deriving one (`reference_write_predicate_must_match_its_readers`).
3. `POST /api/products/:id/studio/copy-setup/apply` — thin: expands to `PATCH /products/bulk`
   batches, writes one `BulkOperation`, returns `{ jobId }` and polls in D15.13.5's shape. Above
   ~20 targets it must be a **job**, not an in-request loop (§5.6).
4. **The store predicate must be fixed first** (A.4's own requirement, §5.12): `attr_* +
   target:'channel'` must route to the column's **declared** store — the typed column, else
   `platformAttributes` path, else `overrideData` — one place, the same predicate the readers use.
   Without this, apply-to-siblings is a 107-key write nothing reads.
5. Additive schema only: **nothing new needed.** `BulkOperation` already carries `changes`,
   `status`, `errors`, `expiresAt`, counts; `ChannelListingSnapshot.reason` is a free `String`, so a
   `'pre-bulk-apply'` reason needs no migration. `AmazonTemplateVault` / `AmazonFamilyWorkbook` are
   untouched.
6. At swap: **retire** `POST /api/amazon/cockpit/template-apply`, `GET
   …/template-candidates` and `POST /api/ebay/cockpit/template-apply` with the cockpits.

**Lane ownership**

| piece | lane | note |
|---|---|---|
| `EntityPicker` DS component | **PES.2** (grid substrate / DS) | shared by 3 verbs |
| `copy-channel-setup` verb + collect/preflight wiring | **PES.3** | declared in `channelActions.ts` |
| the three endpoints + the store predicate fix | **PES.5** | (4) is a prerequisite, not a nice-to-have |
| restore point + revert reuse | **PES.5** | `BulkOperation`, no new store |
| History-pane restore point surfacing | **PES.4** | already built; just needs the new reason |
| Errors & Sync result group | **PES.3** | queue rows, grouped by cause |
| Export ▾ third item + the link-out | **PES.1** (frame) with PES.3 | toolbar item + base disclosure |
| in-studio workbook export (if approved) | **PES.5** | `SheetColumnChannelFacts` → `FlatFileMappableColumn` adapter |

## 8. Risks and traps

- **🔴 The store split (§5.12) is the whole feature's correctness.** Writing 41 copied columns into
  `overrideData` when the feed, the resolver and the flat-file editor read
  `platformAttributes.attributes` produces a perfect green run that changed nothing observable — the
  `reference_api_accepts_a_flag_it_ignores` / "a write nothing reads" shape, at 200× scale. Fix the
  predicate before the verb.
- **Live listings.** Every eBay listing in the GALE fixture family is LIVE, and Amazon targets can be
  ACTIVE. The refusal must test **targets**, not just the donor. `reference_ebay_draft_still_live`:
  a DRAFT row is not proof of safety — safe means a verified absence of a push path.
- **Local dev writes PROD.** `getBackendUrl()` defaults to the Railway API
  (`lib/backend-url.ts:11-17`) and local handlers write the prod DB. This verb creates listings and
  overwrites attributes on up to 200 real products: **no rehearsal outside a named fixture family**,
  and probes stay inside it (`reference_transport_failure_write_is_unknown_outcome`).
- **RBAC is shadow-mode (§5.10).** The current endpoint is an ungated 200-listing write; the
  replacement should be gated by the manifest the day it lands, and the new studio paths need their
  own manifest entries (deny-by-default + the rbac-coverage CI test means an unmapped route fails
  the build — that is the safety net, use it).
- **Untouchables.** `apps/web/src/app/products/amazon-flat-file/**` and
  `apps/api/src/routes/amazon-flat-file.routes.ts` — the vault's capture, list and export live
  there; the studio must reach them, never edit them. The existing import flows are frozen; the
  studio import is separate by ruling (D15.14.1: `ImportJob`/`ImportJobRow` untouchable).
- **FBA quantity + Amazon EU shared quantity.** Quantity must be excluded from every copyable group
  by a **rail**, matching the export's own rule (`template-vault.service.ts:240-244`), not by the
  operator remembering to untick it.
- **Images are global per ASIN.** Image locators are excluded from the sheet by A.3a and must stay
  out of any copyable group — a copied image locator would change the shared ASIN's media.
- **AI stays dark.** Nothing in this feature generates; the verb copies existing values only.
- **A copy is not a publish.** The confirm must not read as though anything reaches Amazon;
  everything it writes stays a draft until an explicit, per-channel publish.
- **Verification trap specific to this verb:** the donor's sheet shows **no change** after a
  successful run, so "nothing happened" and "it worked" look identical from the launching screen
  (`reference_could_not_measure_vs_measured_empty`). Acceptance must read a TARGET back, after a
  delay, with a prediction written before the write.

## 9. Open questions for the Owner (3)

1. **Which store does a channel-scope copy write — `overrideData` or the store the column declares
   (`platformAttributes.attributes` for Amazon's 107 keys)?** The approved A.4 says "readers follow
   the writer", but today the read side honours the declared store and the write side always uses
   `overrideData`, which is `{}` on all 725 GALE listings. *Recommendation:* PES.5 makes
   `attr_* + target:'channel'` honour the column's declared store, in one predicate, **before** this
   verb ships. Otherwise apply-to-siblings is a write nothing reads.
2. **Is the donor always the open product (studio-only verb), or does `/products/next` also get
   "use this row as the Amazon template for the other N selected"?** *Recommendation:* studio-only
   in v1. A multi-row selection has no donor, and `/products/next` runs its own bulk layer
   (`useBulkActions.ts`) rather than the action registry — adding it there forks the verb #110 says
   must exist once. Revisit when `/products/next` consumes the registry.
3. **"Export for Amazon (workbook)" — link-out (S) or in-studio download (M)?**
   *Recommendation:* link-out in v1. The studio import takes `.csv` only, D15.10/V.3 put XLSX out of
   v1, and the byte-rewrite path with its two rails is tested and untouchable. If you want the
   download in-studio, the honest cost is one server adapter
   (`SheetColumnChannelFacts{attribute, path[]}` → `FlatFileMappableColumn{id, fieldRef}`, plus the
   `<base>_<n>` → `bullet_point#N` slot translation) calling the existing
   `buildAmazonTemplateExport` — no new byte logic. Either way, the studio should **name the base**
   it would use, because nothing outside the flat-file page currently reveals the vault exists.

## 10. Effort and dependencies

| piece | effort | depends on |
|---|---|---|
| **Store predicate fix** (`attr_*` + `target:'channel'` → declared store) | **M** | A.4 approved; blocks everything below |
| `EntityPicker` DS component (server-paged entity multi-select) | **M** | DS Modal/Combobox/PressableRow exist |
| `GET copy-targets` (fixed candidate query, real paging) | **S** | — |
| `POST copy-setup/preflight` (reuses `import-diff.service.ts`) | **M** | D15.13 shape; import diff shipped |
| `POST copy-setup/apply` as a **job** + `BulkOperation` restore point | **M** | D15.14.2; import-revert path |
| `copy-channel-setup` verb + collect/confirm wiring (both channels) | **S–M** | registry + EntityPicker |
| Errors & Sync result group | **S** | Errors & Sync console exists |
| History-pane restore point (new reason string) | **S** | `RestoreMode` shipped |
| Export ▾ "Export for Amazon (workbook)…" link-out + base disclosure | **S** | vault list endpoint exists |
| *(optional)* in-studio workbook export endpoint + column adapter | **M** | Q3 |
| *(deferred)* vault manager at `/channels/amazon/templates` | **M** | not blocking |

**Cross-feature dependencies.** The `EntityPicker` is shared with **`attach-existing`** (dark since
it was declared, §5.13) and with **`broadcast-to-listings`**' market picker — build it once and three
verbs come alive; costing it against this feature alone overstates it. The preflight shares the
import diff renderer with feature IO.1. The store-predicate fix is shared with the whole channel
attribute model (AM.1) and is the single highest-leverage item on this list.
