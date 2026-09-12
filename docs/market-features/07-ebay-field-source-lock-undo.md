# 07 — eBay FIELD-SOURCE system: per-field source / LOCK / UNDO / diff-before-apply / PROMOTE-TO-MASTER

## 1. What it is (operator terms)

An eBay listing operator opens the eBay cockpit on one marketplace and, for each field (Title,
Description, Price, and every eBay aspect), decides **where that field's value comes from**: they
typed it (Manual), it follows the master product (From Master), it came from the Locales tab (From
Translations), an AI drafted it (AI suggested), or it was copied off another marketplace's listing
(From Sibling). A badge always shows which. A `Source ▾` dropdown offers the alternatives with a
preview of what each would yield; picking one opens a **diff modal** — current value beside the
candidate — and applies only on confirm. A **padlock** freezes the field so a re-resolve cannot
overwrite it. An **undo** arrow pops the last of five remembered values back. Separately, a violet
**MasterDivergenceBanner** notices when a locally-authored Title/Description/Price differs from the
master and offers to **promote it upward** so every other channel benefits.

The audience is the person doing per-market listing content — the one who writes an Italian title by
hand on eBay·IT while Amazon·DE still follows the master, and who wants a guarantee that tomorrow's
master edit will not silently take it back.

## 2. Old UI — inventory

**Entry points.** `FieldSourceProvider` wraps the whole eBay cockpit at
`tabs/ebay-cockpit/EbayCockpit.tsx:310`; the single diff-modal slot is mounted at
`EbayCockpit.tsx:756`; `MasterDivergenceBanner` at `EbayCockpit.tsx:477`; the adjacent per-field
scope dialog `FieldScopePopover` at `EbayCockpit.tsx:827`.

**Components (all Tailwind, all hand-rolled, no DS):**

| file:line | what it is |
|---|---|
| `field-source/types.ts:14` | `FieldSource = manual \| master \| translations \| ai \| sibling \| default`; `FieldSourceState { source, value, locked, history[] }`; `MAX_HISTORY = 5` |
| `field-source/FieldSourceProvider.tsx:78` | one React context per `(productId, marketplace)`; `read / setValue / applySwitch / lock / undo / requestDiff` |
| `field-source/useFieldSource.ts:54` | card-facing facade; `switchSource` resolves → diffs → applies |
| `field-source/SourceSwitcher.tsx:30` | the `Source ▾` dropdown with per-source hint + preview line |
| `field-source/FieldLock.tsx:18` | the padlock toggle |
| `field-source/UndoFieldButton.tsx:25` | one-click revert to `history[0]`, `title` naming the prior source+value |
| `field-source/FieldSourceBadge.tsx:37` | the always-visible chip (six icons, six colour pairs) |
| `field-source/FieldSourceRow.tsx:30` | glue: label + badge + switcher + lock + undo over a render-prop input |
| `field-source/SourceDiffModal.tsx:20` | the cockpit-wide diff dialog; ESC cancels, ⌘/Ctrl+Enter applies |
| `backwrite/MasterDivergenceBanner.tsx:69` | detects divergence on title/description/price, per-field tick, one **Update Master** button |

**Consumers.** Only four fields plus aspects: `ListingEssentialsCard.tsx:113/145/176`
(`{mkt}.title`, `{mkt}.description`, `{mkt}.price`), `PricingPoliciesCard.tsx:245`
(`{mkt}.price-override`), and one `FieldSourceRow` per eBay aspect at `AspectsCard.tsx:469`
(`{mkt}.aspect.{id}`).

**What round-trips vs what is browser-local — this is the headline.**
Nothing round-trips. The whole store is `localStorage`, keyed
`nx.ebay-cockpit.field-sources.{productId}.{marketplace}` (`FieldSourceProvider.tsx:45-70`),
hydrated in an effect and persisted on a 250 ms debounce. The header at `types.ts:8-12` promises
"EC.10 hoists the same shape into `ChannelListing.platformAttributes._fieldSources`". **It never
landed** — `_fieldSources` appears in four comments and nowhere else in `apps/api/src` (grep, 0
hits). `ListingEssentialsCard.tsx:12-15` says it plainly: *"This card does NOT yet drive the actual
ChannelListing payload."*

**What is DEAD.** Everything except the promote button. The source choice, the lock and the history
are per-browser, per-device, never validated, and have **no effect on what publishes**. The AI
source is a deterministic string stub (`ListingEssentialsCard.tsx:68-79` `fakeAiTitle` /
`fakeAiDesc`), not a model call. There are **zero tests** in the directory. The one live path is
`MasterDivergenceBanner` → `POST /api/ebay/cockpit/promote-to-master`
(`MasterDivergenceBanner.tsx:153`), which reads that localStorage store and writes the **master
record**.

## 3. Backend that exists

- **`POST /api/ebay/cockpit/promote-to-master`** — `apps/api/src/routes/ebay-cockpit.routes.ts:1867`.
  Body `{ productId, fields: { name?, description?, basePrice? } }` → one `prisma.product.update`.
  No audit write, no event, no version CAS, no `expectedVersion`. Returns the updated slice +
  `promotedFields`.
- **`POST /api/amazon/cockpit/promote-to-master`** — `apps/api/src/routes/amazon-cockpit.routes.ts:227`.
  A byte-for-byte twin of the eBay handler (same three fields, same validation, same update). Two
  copies of one write.
- **Permissions.** `apps/api/src/lib/auth/permissions-manifest.ts:354` —
  `RW(listingsView, channelsSync, pfx('/api/ebay'))`, so a POST to the eBay promote route requires
  **`channels.sync`**, while the studio's own write (`PATCH /api/products/bulk`) requires
  **`products.edit`** (`permissions-manifest.ts:412`). The route that rewrites the master for every
  channel is gated on the weaker, wrong-namespace permission.
- **The cascade the studio uses instead.** `GET /api/products/:id/studio/sheet?scope=channel`
  (`services/pim/studio-sheet.service.ts`) sends per-cell `layer / pinned / follows / linkGroupId /
  writeTarget / affectsAllChannels / editable / writable / writeBlockedReason`
  (`_studio/sheet/channel/types.ts:168-233`). Writes go to `PATCH /api/products/bulk`
  (`useChannelSheet.ts:250`), which is **the one write path both sheets use** and which carries
  `expectedVersion`, `marketplaceContexts` fan-out and a **structural `dryRun`**
  (`products.routes.ts:1119-1136`).
- **Follow flags (the nearest thing to a lock that exists).** `ChannelListing.followMasterTitle /
  Description / Price / Quantity / Images / BulletPoints` (`schema.prisma:1552-1556`); the service
  `services/pim/channel-follows.service.ts:25` (six fields only — *"JSONB attributes have none"*);
  the route `PATCH /api/products/:id/channel-follows`
  (`routes/product-channel-data.routes.ts:727`). Reached today only by the legacy
  `products/_sheet/useMasterSheet.ts:275`, **not by the studio**.
- **A dead `locked` provenance.** `services/pim/resolve-channel-field.ts:408` declares
  `ChannelFieldSource = 'locked' | …` and `:499` an input `locked?: boolean` meaning *"identity
  field pinned to master (GTIN/SKU/brand)"*, applied at `:599`. **No production caller passes it** —
  seven call sites (`payload-preview.ts:139`, `mapping/resolve-batch.service.ts:257`,
  `reconcile-divergence.service.ts:111/113`, `mapping-propagation.service.ts:119/120`,
  `mapping-simulate.service.ts:45/46`) all omit it; only
  `__tests__/pim-resolve-channel-field.test.ts:176` sets it. An API that accepts a flag nothing sets.
- **History, and it is real.** `GET /api/products/:id/studio/history`
  (`routes/product-studio.routes.ts:229`) → `services/pim/cell-history.service.ts`. Reads
  `AuditLog` for `entityType: 'Product'` and returns per entry `{ at, by, layer, fieldKey, previous,
  next, source, previousRecorded }` filtered by `channel / marketplace / aliasId`, plus
  `coverageSince` and `coverageNote`. Its header records the measurement:
  `ChannelListingOverride` has **0 rows** and only the pricing routes write it
  (`routes/pricing.routes.ts:1285`, `services/pricing-outbound.service.ts:181`) — it is a price
  trail, not a general one.
- **Restore, master-only.** `POST /api/products/:id/restore` (`products.routes.ts:766`) filters
  through `RESTORABLE_MASTER_FIELDS` (`services/pim/restorable-fields.ts:15`) — 24 master scalar
  columns, no `attr_*`, no channel field. `expectedVersion` CAS at `:783`.
- **The CAS-on-value pattern to copy.** `POST /api/products/:id/import/jobs/:jobId/revert`
  (`product-studio.routes.ts:574`): *"Per-cell CAS on the stored `after`: a cell edited since the
  import is SKIPPED and recorded, never overwritten."*
- **Lock precedent that already ships.** `ListingImage.locked` (`schema.prisma:8059`, BE.1) — *"When
  true, bulk Delete / Clear-override skip this image and cross-market Copy won't overwrite it. A UI
  safety only; does NOT affect Publish"* — with a bulk endpoint
  `POST /api/products/:productId/images-workspace/lock { ids[], locked }`
  (`routes/images/images-workspace.routes.ts:588-604`).
- **A second, half-dead lock.** `ProductVariation.lockedAttributes Json?` (`schema.prisma:1246`,
  "Phase 30 Reactive Attribute Inheritance") — per-attribute inheritance lock, **read by one legacy
  component only** (`app/catalog/[id]/edit/tabs/VariationMatrixTable.tsx:15,195`), never by the API.
- **Jobs/crons.** None specific to field-source.

## 4. Studio today

**Superseded, plainly.** Three of the five halves are gone because the studio answers them better:

1. **Per-field SOURCE (Master / Manual / AI / Sibling) → superseded by per-cell provenance.**
   `design-system/grid/renderers/provenance.ts:61` defines ten server-resolved states
   (`own / inherited / inheritedOverride / pinned / ai / aiStale / mapped / mappedShared / formula /
   refused`), classified at `:153` from the server's `layer`, `pinned`, `linkGroupId`, `mapped`,
   `aiDrafted`, `formula`, `refusedReason`; drawn by `provenanceMark.tsx:57`; worded once by
   `provenanceTooltip` at `:254`. This is strictly better than EC.2: server-authoritative rather
   than a browser opinion, ten states rather than six, and it covers **every** column rather than
   four fields plus aspects. `_studio/sheet/channel/CascadeCell.tsx:103` renders it; the drawer's
   `ProvenanceChip.tsx:64` speaks the same vocabulary. Parity row **3.38** grades this 🔁 and calls
   provenance *"the core of this lane"*.
2. **The SourceSwitcher → superseded by the cascade click.**
   `_studio/sheet/channel/provenance.ts:187` `cascadeIntent()` — one click pins, one click resets,
   routed by layer onto alias vs alias×variant. `channelActions.ts` + the row/⋯/selection adapters
   mean the same operation is reachable four ways. The "sibling" source is now a verb:
   `broadcastToListings` (`channelActions.ts:304`, `SELECTION` scope, `marketplaceContexts` fan-out).
3. **The diff-before-apply modal → superseded twice over.** A cascade pin **cannot change the
   value** by construction (`provenance.ts:180-183`: *"pinning never changes what the channel shows
   — it only stops the value tracking"*), so there is nothing to diff. Where a write genuinely
   changes something, the studio has stronger machinery: the `affectsAllChannels` acknowledgement
   before a master-routed write (`_studio/sheet/channel/rows.ts:113`,
   `ChannelSheet.tsx:518-583`, ruling **#58**, BINDING), the registry's
   COLLECT → PREFLIGHT → CONFIRM → RUN with `ActionImpact` (`grid/actions/registry.ts:84`), and the
   bulk endpoint's structural `dryRun`. Parity **3.11**/**3.12** grade the inheritance and
   diff-vs-master panels 🔁 for the same reason (cascade + drawer `ComparePane`).

**Genuinely lost — parity note 3.38n** (`docs/pes-parity-audit.md:214-217`):
> *"per-field **Undo** and per-field **Lock** are genuinely lost. Undo partly survives via AG's own
> undo through the write path (`source: 'undo'` is allowed by the write gate, by design), but there
> is no per-field undo affordance and no lock at all. Lock's need — 'stop this field changing' — is
> real and unserved."*

- AG session undo: `design-system/grid/hosts/GridSheet.tsx:124-125` sets
  `undoRedoCellEditing: true`, `undoRedoCellEditingLimit: 200`; the deny-list gate
  (`grid/editors/writeGate.ts:32`, `NON_EDIT_SOURCES = ['data']`) lets `'undo'` through, and
  `ChannelSheet.tsx:568-571` states the consequence: *"undo/redo need no code."*
- History: `_studio/drawer/panes/HistoryPane.tsx` renders per-field rows with
  `previous → next`, author and layer (`HistoryRow` at `:216`) — **and offers no verb on a row**.
- `RestoreMode` (`_studio/drawer/panes/RestoreMode.tsx`) does **not** cover this. It is
  record-level, master-only: `notRestorableReason` (`drawer/useRecordState.ts:116`) rejects
  anything outside a 24-name scalar list with *"Schema attribute — restore covers the master
  record's own fields only."* A channel cell and an `attr_*` cell are both refused.

**Rulings that bind.**
- **#105 D8** (`docs/pes-claims.md:20554`): *"D8 ALL FIVE SIGNED OFF (… promote-to-master
  inversion)."* Restated at `:20999`: *"3.49 promote-to-master inverted into pre-write
  `affectsAllChannels` warning."* Promote-to-master is **decided out**.
- **Per-field lock: Owner-deferred, not dropped** (`docs/pes-claims.md:20247-20249`): *"per-field
  lock DEFERRED to wave 2 (real need, wholly unserved today, so nothing regresses; storage gets
  designed properly with PES.5 next wave)."*
- **Triage order** (`docs/pes-claims.md:21061`, audit `:222-223`): 3.47 snapshot/restore → 3.4
  pull-from-channel → 3.13n broadcast → **3.38n per-field lock**.
- **#58** binds any new pre-write gate to the acknowledgement pattern; **#118** binds verb order;
  **#110/#141** bind one declaration, four surfaces; **#11/#16** bind provenance to one definition.

## 5. Defects and slowness

1. **CODE-READ — the whole EC.2 store is browser-local and drives nothing.**
   `FieldSourceProvider.tsx:45-70` + `ListingEssentialsCard.tsx:12-15`. Two operators on the same
   listing see different "sources"; clearing site data erases every lock and every history entry;
   nothing the operator chose reaches a publish.
2. **CODE-READ — a localStorage opinion is the sole input to a master write.**
   `MasterDivergenceBanner.tsx:80-128` reads `ctx.read()` for three field keys and posts the result
   to `promote-to-master`, which does one `product.update` (`ebay-cockpit.routes.ts:1905`) with **no
   audit row, no `ProductEvent`, no version CAS**. So a master change that affects every channel is
   invisible to `cell-history.service.ts` (which reads `AuditLog`) and to `restore-points.service.ts`
   — the change cannot be seen afterwards and cannot be restored.
3. **CODE-READ — wrong permission namespace on that write.** `permissions-manifest.ts:354` puts
   `/api/ebay/*` writes on `channels.sync`; the equivalent master write on `/api/products/bulk`
   needs `products.edit` (`:412`). An account with channel-sync rights and no catalogue-edit rights
   can rewrite `Product.name/description/basePrice`.
4. **CODE-READ — duplicated handler.** `ebay-cockpit.routes.ts:1867` and
   `amazon-cockpit.routes.ts:227` are the same 60 lines twice.
5. **CODE-READ — `resolveChannelField`'s `locked` input is unreachable** (see §3). A precedence rule
   documented at `resolve-channel-field.ts:21` as rank 2 of 7 has never fired in production.
6. **CODE-READ — four different things are called "locked".** `ChannelFieldSource = 'locked'`
   (identity field pinned to master, `resolve-channel-field.ts:408`), the drawer's
   `Layer = 'locked'` with glyph **🔒** and hint *"An identity field pinned to master. It cannot
   diverge per channel."* (`_studio/drawer/types.ts:306,395`, `ProvenanceChip.tsx:34`),
   `ChannelListing.syncLocked` (`schema.prisma:1540`), and `ListingImage.locked`
   (`schema.prisma:8059`). A fifth meaning under the same word and the same padlock would be the
   `nds-cell-is-refused` collision (`grid/renderers/provenance.ts:322-334`) repeated in the
   operator-facing vocabulary.
7. **CODE-READ — mirrored constant that will drift.** `useRecordState.ts:107`
   `RESTORABLE_FIELDS` is a hand-copy of the server's `restorable-fields.ts:15`
   `RESTORABLE_MASTER_FIELDS`. Identical today (24 names, compared); nothing asserts that.
8. **CODE-READ — the registry has no CELL scope.** `GridAction<T>` takes only rows
   (`registry.ts:173-204`); `actionContextMenu` receives AG's `GetContextMenuItemsParams` (which
   carries `column`) and drops it — `offered(o, row)` at `menuAdapters.tsx:58` passes the row alone.
   A per-field verb is not expressible today.
9. **HYPOTHESIS — AG's undo stack does not survive the channel scope's own refetch.**
   `ChannelSheet.tsx:557-560` says the lane *"refetches after every cascade pin/reset"*, and AG
   documents clearing the undo stack on new row data. If so, one pin destroys the 200-edit undo
   history — the very mechanism 3.38n leans on. **Not measured; needs a browser pass.**
10. **CODE-READ — no tests anywhere in `field-source/`**; nine files, zero specs.
11. **MEASURED-IN-DOC — the history the pane shows is thin by construction.**
    `cell-history.service.ts:9-20`: `PATCH /products/bulk` recorded only `after`, with `before`
    JSON-null and `userId` hardcoded null, for 27 rows since 2026-05-06; enriched from PES.5
    onward, so `coverageSince` is genuinely recent and older rows carry no previous value.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**Per-field LOCK → H1 (a cell STATE) + H3 (row-scoped verb, once the registry gains a cell axis) +
H4 (selection form) + H2 (a filter chip, not a column).**

The lock is a fact about a **cell**, so it must be visible in the cell at rest — a lock an operator
has to open a drawer to see is a lock they will forget they set, and the first thing it will do is
refuse a write with no explanation on screen (`reference_disabled_control_cannot_explain`). It is
also a **verb**, and #110 forbids a verb that lives in one place; so it is declared once in
`channelActions.ts` / `familyActions.ts` and rendered by the row context menu, the `⋯` column, the
selection bar and `RecordActions` — the four adapters that already exist. Because the registry's
`GridAction` is row-scoped (§5.8), this needs **one substrate addition**: a `CELL` axis carrying
`{ row, colId }`, plus `p.column` forwarded through `menuAdapters`. That is a PES.2 change of a few
lines and it is the only new primitive the design needs. Filtering is a **view chip**
(`_studio/sheet/channel/viewChips.ts:113`), never a column: a `locked` column would spend width
§9.1 is already fighting for to restate a mark that is already in the cell.

**Per-field UNDO → H7 (History pane row verb) + H1 (nothing new in the cell).**

The undo the studio lacks is not "one more step back" — that is ⌘Z, which already works
(`GridSheet.tsx:124`) and which #105 D8 accepted as the studio's undo. What is missing is **"put
*that* value back"**, chosen from a list, days later, on a cell ⌘Z cannot reach. That list already
exists and already carries the value: `HistoryPane`'s rows render `entry.previous → entry.next`
from `/studio/history`, which returns them per cell per coordinate with `previousRecorded`
(`cell-history.service.ts:37-48`). So the whole feature is a button on a row that already holds its
own payload. It belongs in the drawer because it is a *structured sub-editor over one field's
timeline*, which is H7's definition — and it does not need a mirror, because unlike a lock it is not
an operation on a row the operator selected; it is an operation on a **history entry**, and the
history entry exists in exactly one place.

**PROMOTE-TO-MASTER → H12 (stay dropped), with one addition. See §9 Q3.**

### 6.2 What the sheet shows at rest, per scope

| scope | at rest | detail |
|---|---|---|
| **channel × market** | a **frost tint** on the cell plus a small **snowflake/pin glyph** at the trailing edge, beside (never replacing) the provenance mark | provenance says *where the value came from*; the lock says *that it will not move*. Two independent facts, so two marks. Tooltip appends one clause to the existing composed title in `CascadeCell.tsx:131-134`: "Frozen by *name* on *date* — imports, broadcasts and AI drafts skip it." |
| **master** | the same mark on the same cell | a master lock is the broader promise: it also protects every channel that inherits |
| **alias band row** | the mark if the alias-level cell is locked; a **count badge** on the band when N variant rows under it are locked | the band is a group header, so it summarises rather than asserts |
| **both** | a `Frozen (n)` view chip in the SheetToolbar's chip row | `viewChips.ts` pattern; absent when n = 0 rather than rendering "Frozen (0)" |
| **History pane** | a `Restore` button on every row whose `previousWasRecorded(entry)` is true | rows without a recorded previous keep the existing "previous value not recorded" text and get **no** button — offering one would write a value nobody has, which is the rule `RestoreMode`'s header already sets for `uncertain` fields |

**No new column, on either.** The mark is in the cell; the filter is a chip.

### 6.3 The interaction, step by step

**Locking one cell (H3).** Right-click a cell → the row menu now carries a CELL-axis group at the
top: **"Freeze *Brand* on this row"** (label from `column.label`, resolved through `actionLabel`).
`available()` returns `disabled('This cell is not writable here — ' + writeBlockedReason)` when
`affordanceOf(cell) === 'blocked'`, and `HIDDEN` on a band row. No preflight — freezing writes no
value and touches no channel, so a confirmation would be the noise `openRecordAction` already
refuses (`channelActions.ts:391`). `run()` PATCHes the lock, and the cell repaints from the
response; the drawer, if open, repaints from the same read because both go through the scope's
refetch. **Unfreezing** is the same verb with the label following state, exactly as
`offerToggle` does (`channelActions.ts:174-183`) — one entry, not a Freeze/Unfreeze pair.

**Locking many (H4).** Select rows → the selection bar (`FamilySelectionBar` → DS `BulkActionBar`)
offers **"Freeze fields…"**. COLLECT first (#118): a DS `Modal` holding a `MultiSelect` of this
scope's columns (grouped by the same view rules `views.ts:133-170` uses) and a `Textarea` for an
optional reason. Then PREFLIGHT — `level: 'confirm'`, `findings[]` one per row naming the SKU and
how many of the chosen fields are already frozen, `consequences` naming exactly what a freeze
refuses (§6.5), `sideEffects` naming nothing outward-facing. Then CONFIRM through `ActionConfirm`,
then RUN. Keyboard: the registry's `useActionPress` already owns this; the modal is the DS Modal's
focus trap; Esc cancels the COLLECT step without arming anything.

**Restoring one value (H7).** Open the record drawer on the identity cell → **History** pane →
choose the field in the existing `FieldPicker` (`HistoryPane.tsx:101`) → each row grows a
`Button size="xs" variant="quiet"` **Restore**. Pressing it opens `DrawerConfirm` (the pane's own
confirm api, already threaded into `RestoreMode`) showing `current → entry.previous`, the entry's
author and timestamp, and one sentence about scope: *"This writes the **channel** value on eBay·IT
only"* or *"This writes the **master** record, so every channel that inherits this field changes"*
— chosen from the entry's own `layer`, never guessed. On confirm the value goes through the **normal
`SheetWriter`** with `intent: 'set'` and the row's current `expectedVersion` — no new endpoint, and
therefore the restore lands in `AuditLog` and appears in this same list, which is the property
`RestoreMode`'s confirm already promises ("can itself be undone"). The sheet repaints the one cell
through `CellSaveTracker`; the drawer is non-modal so the operator watches it happen.

**Guard rails on Restore.** Two, both borrowed rather than invented: (a) **CAS on the value**, the
import-revert rule (`product-studio.routes.ts:567-572`) — if the cell has moved since the history
entry was written, the confirm says so and offers to proceed explicitly rather than silently
overwriting later work; (b) a **frozen cell refuses Restore** with its own reason, because a freeze
that a history button walks past is not a freeze.

### 6.4 Per-scope rules

- **Master scope.** A lock here is inherited-in-effect: a channel cell reading `layer: 'master'`
  shows the master's frost mark with a tooltip naming where the lock lives, and cannot be
  unfrozen from the channel scope (the verb is `disabled('Frozen on the master record — unfreeze it
  there')`). This is the `mappedShared` rule reused: a mark that redirects rather than lying about
  what the next click does.
- **Channel scope, master-routed cell.** 399 of 441 eBay·IT cells route to master
  (`ChannelSheet.tsx:520`). Freezing one from a channel scope would freeze it for every channel —
  so the verb is offered but its preflight is a **`level: 'confirm'` with the `affectsAllChannels`
  sentence**, the same acknowledgement #58 binds for the write itself. Never silently scoped down.
- **Alias band (CONTEXT(alias-group)).** Freeze on the band = freeze the alias-level cell, which
  every variant under it inherits; the band's own `⋯` gets the verb, the variant rows keep theirs.
- **Single-store channels (Shopify).** No marketplace axis, so the lock key's `marketplace` is the
  channel's single store and the "other markets are unaffected" clause is dropped from the
  consequences rather than printed as a vacuous truth.
- **Market channels (Amazon, eBay).** Lock is per `(channel, marketplace)`. Two traps to state in
  the copy, not to solve: **Amazon EU quantity is shared** across EU marketplaces, so a quantity
  freeze on Amazon·IT does not stop Amazon·DE moving it; **images are global per ASIN**, so an image
  freeze is not per-market either. Both should be `disabled()` with those sentences on a channel
  scope rather than offered and quietly ineffective.

### 6.5 Provenance / autosave / readiness / publish integration

**What a locked cell refuses — the question the Owner asked, answered explicitly.**

| path | frozen cell behaviour | why |
|---|---|---|
| **manual edit in the cell** | **REFUSED** at `channelWriteGate`, with the reason painted on the cell and stated in the footer | this is the whole point of the feature; a lock that yields to typing protects nothing. Escape hatch: the row menu's Unfreeze, one right-click away — never a modal that offers "freeze anyway" |
| **cascade pin / reset** | **REFUSED**. `offersCascade()` (`rows.ts:57`) returns false, so `CascadeCell` renders the mark and **no button** — the existing rule at `CascadeCell.tsx:76-86` | pin/reset changes the *routing*, which is exactly what a freeze exists to hold |
| **import apply** | **SKIPPED and REPORTED** in the diff drawer as a distinct outcome row | the import-revert precedent: *"a cell edited since the import is SKIPPED and recorded, never overwritten"*. Refusing the whole job for one frozen cell would punish a reasonable request |
| **broadcast to siblings** | **SKIPPED per target coordinate and REPORTED** in `ActionImpact.findings[]` | same rule; and the operator must see which of N markets did not receive it |
| **AI draft** | **NOT generated for that cell**, and if a draft already exists it is left visible and un-approvable, with the refusal on the Approve button | drafting is a read; *approving* is the write. And #13 keeps AI dark anyway, so this is a built-and-honest surface, never a live one |
| **formula recalculation** | **the formula is REFUSED at creation on a frozen cell**, and an existing formula on a cell that is then frozen has its **recalc suppressed with the freeze as its `lastError`** | a formula is a standing instruction to change the value, so allowing one is allowing the freeze to be bypassed on a schedule. `refusedReason` is already the wire field for exactly this, and `classifyProvenance` already ranks `refused` above everything (`provenance.ts:169`) |
| **mapping-engine derivation** | **UNAFFECTED** — a derived value is computed at read time and stored nowhere, so there is nothing to freeze; the cell keeps its `mapped` mark and the freeze verb is `disabled('Derived by a mapping rule — change the rule, not this cell')` | the `mapped` tooltip already says this |
| **channel sync / pull-from-channel / the 124 other writers** | **UNAFFECTED, and the copy must say so** | `Product.version` is CAS-maintained by the studio path alone (`sheetWriter.ts:28-38`: 124 other write sites never bump it). A freeze enforced in `PATCH /products/bulk` is an **editor-side** guarantee, exactly like `ListingImage.locked`'s *"A UI safety only; does NOT affect Publish"*. Promising more would be the dishonesty this programme is removing |
| **publish** | **UNAFFECTED.** A freeze is not a publish gate | same reason |

**Provenance.** The lock is a **second, orthogonal mark**, never an eleventh `CellProvenance`
member. §9.6b's test for minting a member is *"does it change where the next click lands"* — a
freeze does not change *where*, it changes *whether*, and every one of the ten members remains true
of a frozen cell. Folding it in would force `locked × pinned`, `locked × mapped`, `locked × ai` and
lose the origin fact the vocabulary exists to carry.

**Autosave.** No change to the writer. A refusal is a refusal the operator already understands: the
save reporter counts it, the footer names it, the cell reverts. **Server-side enforcement in
`PATCH /api/products/bulk` is mandatory** — a client-only check is a suggestion, and this whole
feature's history is a client-only store that meant nothing.

**Readiness.** Unchanged and deliberately so: a frozen cell that is missing a required value is
still missing it. Readiness has ONE server definition
(`services/pim/readiness.service.ts`) and a lock must not become a second way to look green.

### 6.6 ASCII mockup

```
 SCOPE [Master 96%][Amazon ●92%][eBay ⚠71%]        Market [IT ▾] Locale [it ▾]
 21 rows · 3 selected  [View ▾][Missing required (7)][Frozen (4)]  Find…  [Customise]
┌──────────────┬─────────────────────────────┬───────────┬──────────────┬─────────┐
│ SKU          │ Title                       │ Brand     │ Price        │ Colour  │
├──────────────┼─────────────────────────────┼───────────┼──────────────┼─────────┤
│ ① eBay·IT ★  │ Tuta GALE Pro           ✎   │ Xavia  🔗 │  249,00   🔗 │  —      │
│  GALE-…-S    │ Tuta GALE Pro Nero S ❄✎ ▓▓▓ │ Xavia  🔗 │  249,00   🔗 │ Nero    │
│  GALE-…-M    │ Tuta GALE Pro Nero M    🔗  │ Xavia  🔗 │  259,00   ✎  │ Nero    │
│  GALE-…-L    │ ⚠ required                  │ Xavia  🔗 │  259,00  ❄✎▓ │ Nero    │
└──────────────┴─────────────────────────────┴───────────┴──────────────┴─────────┘
   ▓ frost tint + ❄  = frozen.  ✎ pinned · 🔗 inherited — unchanged, and shown together.

   right-click GALE-…-S / Title ──▶ ┌──────────────────────────────────────────┐
                                    │ Unfreeze Title on GALE-…-S               │
                                    │ Open record                              │
                                    │ Activate offer on eBay · IT              │
                                    │ ──────────────────────────────────────── │
                                    │ Copy   ·   Copy with headers             │
                                    └──────────────────────────────────────────┘
   RECORD DRAWER · History · field [Title ▾]
   ── 3 Sep 14:22 · a.sulhry · alias → alias                        [ Restore ]
      "Tuta GALE Pro Nero S"  →  "Tuta GALE Pro Nero S · Spedizione EU"
   ── 1 Sep 09:04 · author not recorded · master
      previous value not recorded  →  "Tuta GALE Pro"          (no Restore — see §6.2)
```

## 7. Contracts and data

**Reused unchanged:** `PATCH /api/products/bulk` (the restore write, and the enforcement point);
`GET /api/products/:id/studio/history` (the restore's payload — `previous` is already on the wire);
`GET /api/products/:id/studio/sheet` (carries the new per-cell flag); the action registry, its four
adapters, `ActionConfirm`, `DrawerConfirm`, `SheetWriter`, `CellSaveTracker`.

**New — additive only:**

| piece | shape | lane |
|---|---|---|
| `CellLock` model | `productId · variantId? · scope('master'\|'channel') · channel? · marketplace? · aliasId? · fieldKey · lockedBy · lockedAt · reason?`, `@@unique` on the coordinate | **PES.5** |
| `PATCH /api/products/:id/cell-locks` | `{ locks: [{ …coordinate, locked, reason? }] }` → per-lock results, a missing coordinate a RESULT not an error (the `applyChannelFollows` shape at `channel-follows.service.ts:96-132`) | **PES.5** |
| enforcement in `PATCH /products/bulk` | reject a change whose coordinate is locked, with a per-change reason in the existing refusal shape; **and honour `dryRun`** so the import diff reports skips without writing | **PES.5** |
| `StudioCellValue.locked?: { by, at, reason?, scope }` | added to `studio-sheet.service.ts`'s cell and mirrored in `_studio/sheet/channel/types.ts` + `drawer/types.ts` | **PES.5** + **PES.3/PES.4** |
| `ActionScope` gains `{ kind: 'cell' }`; `MenuAdapterOptions` forwards `p.column` | `registry.ts`, `menuAdapters.tsx` (+ tests, + mutants) | **PES.2** |
| lock MARK + `.nds-cell-is-frozen` class rule | beside `ProvenanceMark`, never inside `CellProvenance` | **PES.2** |
| `Frozen (n)` view chip | `viewChips.ts` / `views.ts` | **PES.3** |
| `Restore` on a history row + its confirm | `HistoryPane.tsx`, reusing `DrawerConfirm` | **PES.4** |
| freeze verbs (`cell-freeze`, `bulk-freeze`) | `channelActions.ts`, `familyActions.ts` | **PES.3** |
| import/broadcast skip reporting | `import-diff.service.ts` outcome row; `broadcastToListings` findings | **PES.5** + **PES.3** |
| AI draft + formula refusals | draft suppression; `CellFormula.lastError` on a frozen cell | **PES.8** + **PES.6** |

**Not needed:** a new history endpoint, a new restore endpoint, a `_fieldSources` blob, any
`FieldSource` enum, any diff modal.

**Recommended cleanups (separate, small):** delete `resolveChannelField`'s unreachable `locked`
input or wire it (§5.5); collapse the two `promote-to-master` twins if either survives; assert
`RESTORABLE_FIELDS` against the server's set (§5.7).

## 8. Risks and traps

1. **The naming collision is the biggest design risk, not the biggest engineering one.** 🔒 and the
   word "Locked" already mean *"identity field pinned to master, cannot diverge per channel"* in a
   live vocabulary (`drawer/types.ts:306,395`, `ProvenanceChip.tsx:34`), and `syncLocked` /
   `ListingImage.locked` are two more. **Recommendation: call it FROZEN, mark it ❄, name the model
   `CellLock` and nothing operator-facing.** A fifth "locked" is `nds-cell-is-refused` again.
2. **Live listings.** Every eBay·IT listing in the fixture family is ACTIVE with a real ItemID
   (`channelActions.ts:16-19`, measured 40 of 40). A freeze sends nothing outward, so it is one of
   the few verbs that is safe to ship live — but the copy must not imply it protects the *listing*.
3. **Local dev writes PROD.** Any exercise of the freeze verb from local dev writes the production
   database. The verb is cheap to test and that makes it easy to forget.
4. **A lock that lies is worse than no lock.** Enforced only in `PATCH /products/bulk`, it does not
   stop the sync jobs, the pricing engine, the flat-file paths or the other 121 writers
   (`sheetWriter.ts:28-38`). §6.5's table must survive into the confirm copy verbatim; a freeze
   advertised as absolute is the exact failure mode this feature replaces.
5. **Restore's CAS.** Without the value-CAS, "restore this value" silently discards whatever
   happened since — the failure `product-studio.routes.ts:567-572` calls *"the failure an operator
   is least equipped to notice, because the value simply looks older than they remember."*
6. **Coverage honesty.** `coverageSince` must gate the Restore button's absence exactly as
   `HistoryPane.tsx:177-195` gates its wording. A greyed Restore with no sentence is
   `reference_disabled_control_cannot_explain`.
7. **Untouchables.** The eBay/Amazon flat-file editors, FBA quantity and the existing import flows
   are out of scope — the *studio* import drawer is in scope, the legacy import flows are not.
8. **AI stays dark** (#13): the draft-suppression half is built and honest, never enabled.
9. **Amazon EU shared quantity** and **images global per ASIN** make a per-market freeze on those
   fields ineffective; `disabled()` with the reason, not silence (§6.4).
10. **The registry change is shared.** A `CELL` axis touches `registry.ts` and `menuAdapters.tsx`,
    which every lane reads. It needs its own tests and mutants before any lane builds on it, and it
    should land producer-and-consumer together
    (`feedback_producer_and_consumer_land_together`).

## 9. Open questions for the Owner (max 3)

**Q1. Is a frozen cell's own manual edit refused, or refused-with-an-override?**
*Recommendation: REFUSED, full stop, with Unfreeze one right-click away.* An "edit anyway" affirmation
becomes muscle memory in a week and the freeze degrades into a speed bump; the old `FieldLock` made
exactly this compromise (`FieldSourceRow.tsx:66`: *"value is always editable; lock only freezes
source"*), and it is why the padlock protected nothing.

**Q2. Does a freeze scope to a coordinate, or to a field across every coordinate?**
*Recommendation: per coordinate, with a "freeze on the master" that is inherited-in-effect.*
Per-coordinate matches the cascade the sheet already draws and the alias axis it already carries; a
field-wide freeze is expressible as one master freeze without a second storage model. A "freeze
everywhere" verb can be added later over the same rows if the need appears.

**Q3. Promote-to-master is signed off as dropped (#105 D8). Should the *inversion* gain a small
retroactive half — a `Adopt this value as master` verb on a pinned cell?**
*Recommendation: NO for wave 1, and not as promote-to-master.* The pre-write `affectsAllChannels`
warning already puts the decision at the right moment (before the divergence, not after), and the
old promote path is the source of three of §5's defects — an unaudited master write, gated on
`channels.sync`, fed by localStorage. If the Owner still wants the retroactive move, the honest
shape is **`Copy this value to the master`** on a `pinned` cell — an ordinary
`PATCH /products/bulk` master write, audited, version-checked, `products.edit`-gated, with the
`affectsAllChannels` confirm the studio already shows — and it costs no new endpoint. Say the word
and it is an S.

## 10. Effort and dependencies

| piece | size | depends on |
|---|---|---|
| `CellLock` model + `PATCH /cell-locks` + `dryRun`-aware enforcement in `/products/bulk` | **M** | PES.5; additive migration is pre-approved |
| `StudioCellValue.locked` on the wire + both client mirrors | **S** | the model |
| `ActionScope` `CELL` axis + `p.column` through `menuAdapters` (+ tests, + mutants) | **S–M** | PES.2 only; **blocks the H3/H4 half of the lock** |
| frost mark + class rule beside `ProvenanceMark` | **S** | PES.2 |
| freeze verbs (row + selection, COLLECT modal, preflight copy) | **M** | the CELL axis, the endpoint |
| `Frozen (n)` chip | **S** | PES.3 |
| refusals: cascade, import skip-and-report, broadcast skip, AI draft, formula | **M** total | PES.3 · PES.5 · PES.6 · PES.8 |
| **Restore-this-value on a History row** (button + confirm + value-CAS) | **S** | nothing new — the endpoint, the payload and the writer all exist. **Highest value per unit of work in this feature** |
| cleanups (dead `locked` input, twin routes, mirrored constant) | **S** | — |

**Sequence.** Restore-this-value first (S, no dependencies, closes half of 3.38n on its own), then
the PES.2 cell axis, then the lock model + enforcement, then the verbs and marks, then the refusal
paths one lane at a time. Per #105 the lock is wave 2 and the Owner has already deferred it; the
Restore half is not covered by that deferral and is available now.
