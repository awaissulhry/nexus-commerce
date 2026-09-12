# 33 — Cascade-to-channels propagation + field-link suggestions

## 1. What it is (operator terms)

Two capabilities that both answer "I typed one value; where else should it be?", and that must stay
two verbs because they answer it in opposite directions.

**Cascade to channels (propagation)** is the *edit-once* promise. A merchandiser fixes the master
title, description, brand or a spec attribute on GALE-JACKET and wants it to reach Amazon·IT/DE/ES
and eBay·IT — translated where the market speaks another language, transformed by the mapping rules,
trimmed to each channel's cap, and *pushed*, not just stored. It runs on a whole PRODUCT FAMILY,
fans out over channel × market, produces one marketplace push per coordinate, and is the only path
in the system that turns a master edit into an outbound job with an undo window.

**Field links** are the *standing relationship*. The same operator notices that `name` is byte-
identical on Amazon·IT, Amazon·DE and eBay·IT and declares "these three share one value" — so the
NEXT edit on any of them moves all three, with a per-group translate policy. It writes nothing to a
marketplace; it changes what a future edit does. **Link suggestions** are the discovery half: the
server scans the listings, finds fields already identical on ≥2 coordinates, and offers a one-click
link.

The distinction the Owner needs: the per-cell cascade already in the studio answers **where did this
value come from** (read, one cell, pin/reset). Propagation answers **where does it go** (a run, many
coordinates, a queue). A field link answers **who shares it** (a relationship, forever). Three
questions, three surfaces.

## 2. Old UI — inventory

**Propagation — `CatalogCascadeDrawer` (FM.10), 282 lines, ALIVE, two entry points.**

| what | where |
|---|---|
| "Cascade to channels" button (master editor) | `tabs/MasterDataTab.tsx:473,478` → `openCascade` `:148` |
| "Cascade from master →" button (mapping matrix) | `tabs/MappingTab.tsx:341,345` → `openCascade` `:131` |
| the drawer | `_shared/cockpit-shell/CatalogCascadeDrawer.tsx:92` |
| preview round-trip | `:105` `POST /api/products/:id/mapping/propagate-preview` |
| apply round-trip | `:127` `POST /api/products/:id/mapping/apply`, `reason:'editor-cascade'` |
| counts strip | `:180-188` willUpdate / needsReview / currencyMismatch / unmappedRequired |
| per-entry diff row | `:210-251` `channel/marketplace · fieldKey · lang`, `current` struck → `proposed`, flag icons (transform ✦, translate, scissors=trimmed, currency-skipped, required-unmapped) |
| footer claim | `:258` "Applies on a 30s undo window · price fields go through the pricing engine" |
| apply gate | `:271` disabled unless `plan.counts.willUpdate > 0` |

🔴 **`changes` is a SNAPSHOT of the CURRENT master values, not a diff of what the operator changed**
(`MasterDataTab.tsx:148-159`, `MappingTab.tsx:131-139`: it assembles `{title, brand, manufacturer,
description, bulletPoints, keywords}` from whatever is on screen). So the verb is really *"re-assert
master everywhere"*, not *"push my change"*. The drawer's own header says "Edit-once → propagate";
the code cannot tell the two apart. Nothing browser-local — every decision is server-side.

**Field links — `useFieldLinks` (FL.3b/FL.4/FL.6.2), 423 lines, ALIVE, four consumers.**

- `useFieldLinks.ts:97` — hook. `reload` `:103` (`GET .../field-links`), `loadSuggestions` `:122`
  (`GET .../field-links/suggestions`), `setScope` `:141` (`PUT .../field-links/:fieldKey`),
  `propagatePreview` `:195`, `crossChannelPreview` `:227`, `backTranslate` `:261`,
  `applyPropagation` `:286`, `recordPropagationApplied` `:360`, `linkSuggestion` `:386`,
  `dismissSuggestion` `:401`.
- Consumers: `MasterDataTab.tsx:1008,1206` · `MappingTab.tsx:120` · `amazon-cockpit/AmazonCockpit.tsx:219,595,917,929,947`
  · `ebay-cockpit/EbayCockpit.tsx:169,457,846,856,874` · `variations/VariantCube.tsx:289`
  · `CrossChannelMatrix.tsx:72,127,148,150`.
- `LinkSuggestionsBanner.tsx:17` — amber banner, one row per suggestion, "**Title** is identical
  (*sample*) on 3 markets" + `[Link 3]` + dismiss.
- `PropagationDiffModal.tsx:40` — the "never silent" gate: per-member checkbox, `defaultChecked`
  `:32-38` unticks skip / unchanged / null-proposal, `aiBudgetExceeded` note `:163`, glossary note
  `:168`.
- `FieldScopePopover.tsx:20` — the three-way choice `master | linked | independent` + member picker
  + translate toggle. This is the only surface that CREATES a link by hand.

🔴 **Browser-local state:** `dismissed` is a plain `useState` Set (`useFieldLinks.ts:101,401`) — not
localStorage, not the server. Dismissing a suggestion un-dismisses on reload.

🔴 **The apply is a CLIENT-SIDE LOOP** (`useFieldLinks.ts:329-353`): one sequential `PUT
/api/products/:id/listings/:channel/:marketplace` per member, no batching, no `expectedVersion`, no
transaction; the audit is a separate best-effort `POST .../cross-channel/applied` `:367`. A tab
closed mid-loop leaves half the group written and nothing audited.

**DEAD:** `tabs/_shared/CascadePreviewCard.tsx` — no importer anywhere (verified: no mention outside
its own file; already recorded at `docs/pes-parity-audit.md:276,487`). Its endpoint is alive (§3).

## 3. Backend that exists

**Propagation.** `routes/mapping-propagation.routes.ts`, registered `index.ts:775` with prefix `/api`.

| method + path | line | service |
|---|---|---|
| `POST /api/products/:id/mapping/propagate-preview` | `:28` | `planMappingPropagation` — `services/pim/mapping-propagation.service.ts:159` |
| `POST /api/products/:id/mapping/apply` | `:70` | `applyCatalogCascade` — `services/pim/apply-mapping.service.ts:93` |
| `GET /api/products/:id/mapping/divergence` | `:104` | `scanProductDivergence` |
| `GET /api/products/:id/mapping/matrix` | `:125` | `buildMappingMatrix` |
| `POST /api/products/:id/mapping/adopt-master` | `:148` | `adoptMasterForCoordinate` (row 6.27) |
| `GET /api/products/:id/cascade-preview` | `routes/pim-global.routes.ts:594` | inherit-vs-override counts per tracked field — **route alive, caller dead** |

`planMappingPropagation` is genuinely good work: it runs every coordinate through the FM.2 resolver
**twice** — once on current master attrs, once with the change overlaid — and diffs
(`mapping-propagation.service.ts:195-215`). Cascade semantics are encoded in `applyMasterChanges`
`:75-88`: a change reaches a coordinate **only where the attribute is inherited**; a
`channelOverride`/`channelExplicit` coordinate keeps its value — the `followMaster` contract, stated
once. Flags at `:126-138`: `transformed`, `needsTranslation`, `channelLimitTrimmed`,
`currencyMismatch` (price across currencies → `action:'skip'`), `unmappedRequired`.

`applyCatalogCascade` (`apply-mapping.service.ts:93-334`) does, in order: translate outside the tx
(`:117-164`, `translateProductCopy`, ≤12 languages, brand-scoped `TerminologyPreference` glossary);
then one `$transaction` `:187` writing (1) translations to **both** stores — `Product.localizedContent[lang]`
`:195` and `ProductTranslation` `:202` — (2) one `ChannelListingOverride` audit row per changed field
`:231`, (3) one `OutboundSyncQueue` `ATTRIBUTE_UPDATE` row per coordinate with `holdUntil = now+30s`
`:273`, merging into an existing PENDING row `:262-271`, (4) `ChannelListing.lastSyncStatus='PENDING'`
+ `version: {increment:1}` `:290`; then BullMQ `add` AFTER commit `:301-315` (`delay` 30s, `jobId =
queueId`).

**Prisma.** `FieldLinkGroup` `schema.prisma:1942` — `productId · fieldKey · parentage
(PARENT|CHILD) · variantId? · translatePolicy (TRANSLATE|VERBATIM|NONE) · members Json ·
sourceLanguage`, indexed `[productId]`, `[productId, fieldKey]`, **no unique on the triple**
(the route works around it with `findFirst` + `update`, `field-links.routes.ts:221-230`).
`ChannelListingOverride` `:1898` — `channelListingId · fieldName · previousValue String? ·
newValue String? · isActive · changedBy · reason`. `ChannelListing.followMaster{Title,Description,
Price,Quantity,Images,BulletPoints}` `:1554-1568`.

**Field links.** `routes/field-links.routes.ts` (550 lines), registered `index.ts:676` **with no
prefix** — the handlers declare full paths `/api/products/:id/…`.

| method + path | line |
|---|---|
| `GET /api/products/:id/field-links` | `:157` (tolerant: `unavailable:true` if unmigrated) |
| `PUT /api/products/:id/field-links/:fieldKey` | `:170` (+ `auditLogService.write` `:197,232`) |
| `POST /api/products/:id/field-links/:fieldKey/propagate-preview` | `:266` |
| `POST /api/products/:id/cross-channel/propagate-preview` | `:341` (ad-hoc, explicit targets) |
| `POST /api/products/:id/cross-channel/back-translate` | `:423` |
| `POST /api/products/:id/cross-channel/applied` | `:451` (audit only) |
| `GET /api/products/:id/field-links/suggestions` | `:487` |

`planPropagation` (`services/field-resolution/propagation.ts:72`) is pure: excludes the source
coordinate, `NONE`→skip, `VERBATIM`→copy, `TRANSLATE`→verbatim same-language / `translate`
cross-language, and flags `unchanged`.

**External channel calls + safety gates.** *None of these routes call a marketplace.* Every push is
mediated by `OutboundSyncQueue` → `outbound-sync.service.ts`. Publish modes
(`getAmazonPublishMode`/`getEbayPublishMode`) are not consulted by the cascade at all — see §5.1,
which is the reason that matters.

**Jobs/crons.** BullMQ `outboundSyncQueue` with a 30s delay; a failed enqueue leaves the DB row
PENDING for the next cron drain (`apply-mapping.service.ts:308-314`) — the correct doctrine.

**Permissions.** `RW(F.productsView, F.productsEdit, pfx('/api/products'))`
(`permissions-manifest.ts:412`) catches every route above → `products:view` on GET,
**`products:edit` on POST/PUT**. 🔴 `permissions-manifest.ts:393`
`RW(F.pimManage, F.pimManage, pfx('/api/field-links'))` **matches no route in the codebase** — the
field-link handlers are declared under `/api/products/:id/field-links`. The intended `pim:manage`
gate has never applied; `products:edit` does. And `propagate-preview` is a read-shaped POST that the
manifest's own stated convention (`:15-17`) would map to the view permission — it does not, so
preview needs edit rights.

## 4. Studio today

**Nothing of this feature exists in `_studio/**`.** `grep -niE 'propagate|cascade-to|catalog-cascade|mapping/apply'`
over `_studio/**` returns one unrelated test-name hit. There is no cascade drawer, no link-suggestion
surface, no `field-links` caller.

**What DOES exist, and it is more than the audit credits:**

- **The per-cell cascade.** `sheet/channel/CascadeCell.tsx:56` — mark + one-click pin/reset,
  classified by PES.2's `classifyProvenance` and worded by `provenanceTooltip`, with the mark on a
  master-routed cell but **no button** (`:76-80`). This is *read* + a one-cell write. It does not
  fan out, translate, queue, or push.
- **`linkGroupId` is on the wire.** `services/pim/studio-sheet.service.ts:136` (contract),
  `:909` (the `findMany`), `:1160` (`linkForCoordinate`), `:1254-1256` (`follows`, `linkGroupId`).
  `sheet/channel/types.ts:228`, `sheet/master/types.ts:147`, `drawer/types.ts:229`.
- **`follows` is DERIVED, not a fixed six.** `studio-sheet.service.ts:1179-1183`: the stored
  `followMaster*` column wins where one exists, otherwise the observable fact (`layer` is not
  `channel`/`alias`). Measured note at `:1166-1172`: the old fixed list set it on 6 cells while 63
  columns route to the channel on Amazon·IT, and asserted it on 3 eBay·IT cells where only 2
  columns route to the channel. **This is the honest default field set my verb needs.**
- **The pre-write warning.** `affectsAllChannels` on the contract (`sheet/channel/types.ts:266`),
  gate at `sheet/channel/rows.ts:113` returning `'acknowledge'`, hover sentence at `rows.ts:365`,
  count at `rows.ts:382`, and the acknowledgement flow at `ChannelSheet.tsx:531-551` (ruling #58,
  BINDING). The drawer's twin: `drawer/fields/RecordField.tsx:246-255` — "Writes to the master
  record — this changes every channel, not just this one" (measured 399 of 441 cells on eBay·IT).
- **The drawer already promises link propagation.** `RecordField.tsx:530-534`: *"Linked — editing
  this moves every coordinate in the group, not only this one."* 🔴 **Nothing keeps that promise**
  (§5.4).
- **`broadcast-to-listings`** (`sheet/channel/channelActions.ts:308`) is SELECTION-scoped, typed-
  confirm, and its `run` returns `ok:false` with "Not sent" (`:352-357`) — the studio has no working
  cross-market write verb today.
- **Verb plumbing is ready.** `contextOf('product-family')` (`grid/actions/registry.ts:14-23`),
  `FamilyVerbs` rendered in the master sheet's `leading` slot (`sheet/master/FamilyBar.tsx:52`,
  `MasterSheet.tsx:1809-1811`), `ActionImpact` with `findings[]` + `payload` (the time-of-check /
  time-of-use channel, `registry.ts:65-108`), `useRegisterViewChip` (`_studio/contracts.tsx:236`),
  Errors & Sync console (`channel-ops/ErrorsSyncConsole.tsx:148` → `GET /api/products/:id/sync-queue`).

**Parity audit rows.**

- **6.28 — "Cascade to channels drawer from Mapping too" — 🕳 MISSING and UNCLAIMED**
  (`docs/pes-parity-audit.md:393`). PES.6 explicitly declined it as per-product; the audit's own
  words: *"a live write path with real fan-out, so losing it silently would be the expensive kind of
  gap. Not mine to claim; needs an owner."* **Still unowned as of this read.**
- **7.13 — smart field-link suggestions — 🕳 MISSING (AI half only)** (`:432`). "Display parity yes,
  suggestion parity no. Flagging for PES.5/PES.2 who own the link layer." Correct diagnosis; §5.4
  shows the display half is also wrong.
- **6.27 — adopt-master per cell — 🔁 SUPERSEDED, verified** (`:392`, ruling #91/#96): the per-cell
  reset IS adopt-master, PES.3 owns it, confirmed on screen. **This is the boundary of my feature:
  6.27 is one cell; 6.28 is the family.**

**Hub rulings that bind.**

- **#105 D6 → PES.6 (auto-map + clone-to-markets)** (`docs/pes-claims.md:20552`). D6 is about MAPPING
  RULES moving between markets. 6.28 moves VALUES. Not the same verb, and D6 does not cover it.
- **#105 D7 → PES.8, "AI translate into the enrichment lane, dark per #13"** (`:20553`). 🔴 Binding
  on the translate half of the apply — see §8.
- **#13** no live AI generation. **#58** the `affectsAllChannels` acknowledgement. **#16** the
  `inheritedOverride` state. **#114** a context verb must name its axis. **#118** `payload` carries
  the preflight's snapshot into the run.

## 5. Defects and slowness

**5.1 🔴 THE QUEUED PUSH IS A NO-OP ON BOTH CHANNELS — and it reports SUCCESS. [CODE-READ]**

`applyCatalogCascade` writes its queue payload as
`{ source:'FM_CATALOG_CASCADE', productId, productSku, channel, marketplace, fields: {<fieldKey>: value}, reason }`
(`apply-mapping.service.ts:245-253`). Both consumers read **flat top-level keys and never `fields`**:

- Amazon: `buildAmazonListingPatch` (`outbound-sync.service.ts:281`) reads only `payload.title`
  `:294`, `payload.description` `:297`, `payload.bulletPoints` `:300`, `payload.price` `:304`,
  `payload.quantity` `:311`. With a `fields`-shaped payload `attrs` stays `{}` → `patches: []` →
  `syncToAmazon` `:1028` hits the empty-patch branch and returns
  **`success: true, status: "SKIPPED", "Skipped — empty patch (nothing to push)"`** `:1034-1041`.
  It also never sets `productType`, which the Listings PATCH requires (`payload.productType` at
  `:868` would be `undefined` → `''`).
- eBay: `mergeEbayInventoryItem` (`:220`) reads `payload.quantity/title/description/images` only
  (`:225,233,234`) → `merged === existing`, and that is what `:1415` serialises.

Contrast `masterContentService`, which spreads the fields FLAT and includes `productType`
(`master-content.service.ts:186-196`) and uses `syncType:'CONTENT_UPDATE'` `:183`, which
`outbound-sync.service.ts:1907` handles explicitly. **The FM cascade is the same "wired through dead
code" failure that `master-content.service.ts:4-6` was written to fix — one layer further down.**
So the drawer's toast *"N coordinate(s) queued"* is true, and the marketplace receives nothing.

**5.2 🔴 The apply writes no channel value at all. [CODE-READ]** Inside the transaction
(`apply-mapping.service.ts:187-296`) the only value writes are `Product.localizedContent` /
`ProductTranslation`. `ChannelListing.title/description/platformAttributes/overrideData` are never
touched; only `lastSyncStatus`, `lastSyncedAt`, `version`. Meanwhile a `ChannelListingOverride` row
is created per field with `previousValue → newValue` and `isActive: true` `:231-241` — **an audit
row asserting a change to a store that was not changed.** For genuinely inherited cells that is
arguably fine (master IS the store), but the audit row makes a claim about the listing that the
listing cannot corroborate.

**5.3 🔴 `version: {increment: 1}` is not a CAS. [CODE-READ]** `:199` (Product) and `:290`
(ChannelListing) bump unconditionally, with no `expectedVersion` guard — while the studio's
SheetWriter CASes every cell edit (`grid/editors/sheetWriter.ts:8`). A cascade landing during an
in-flight autosave is exactly the banked trap *"an in-flight autosave UNDID an API revert"*. The
brief's "version CAS" is a **misdescription of the code**.

**5.4 🔴 A field link is DISPLAY-ONLY in the studio, and the drawer says otherwise. [CODE-READ]**
`grep -rn fieldLinkGroup apps/api/src` finds **only readers** — `field-links.routes.ts`,
`studio-sheet.service.ts:909`, `payload-preview.ts:77`, `mapping/resolve-batch.service.ts:94`. No
write path consults it. `resolve-channel-field.ts:33` states it outright: the link layer *"only
enriches provenance + needsTranslation"* — `linkForCoordinate` `:459` returns membership metadata,
never a canonical value. The old cockpit did the fan-out in the browser
(`useFieldLinks.ts:329-353`); the studio has no such loop. So `RecordField.tsx:530-534`'s
"editing this moves every coordinate in the group" is **a promise no code keeps** — a 100%-honest-UI
violation, not a gap.

**5.5 🔴 The 🔗 mark cannot tell a LINK from plain inheritance. [CODE-READ]**
`grid/renderers/provenance.ts:226`: `if (explicit === 'linked' || cell.linkGroupId != null) return 'inherited'`.
`provenanceMark.tsx:17` renders `inherited` as `Link2` labelled "Inherited", and
`provenanceTooltip` `:128-131` says *"Inherited from the parent — edit to give this row its own
value"*. For a linked cell that sentence is **backwards**: editing it should move the group, not
give this row its own value. The vocabulary has ten members and `inheritedOverride` earned its own
glyph under ruling #16 for exactly this reason (`provenanceMark.tsx:18-20`) — `linked` did not, and
the brief's "🔗 mappedShared" is also wrong: `mappedShared` is `productLevelOnly` on the mapping
engine (`provenance.ts:44-47`), an unrelated member.

**5.6 Suggestions cover THREE fields, hardcoded. [CODE-READ]** `field-links.routes.ts:504-507`:
`title`, `description`, `price`, read from `ChannelListing` columns. Nothing from
`platformAttributes`, nothing from `ChannelFieldSpec`. Three further bugs in ~50 lines: the
`linked` suppression set is keyed on `fieldKey` alone `:497` so a per-variant CHILD group hides the
PARENT suggestion; only the **largest** equal-value cluster per field is returned `:527-532`, so a
field identical on two separate pairs yields one suggestion; and the whole handler is `catch →
{suggestions: []}` `:545-548`, so a DB error and "nothing is identical" are the same answer — the
banked *"could not measure vs measured empty"* trap.

**5.7 `linkSuggestion` always links with `translate: true`. [CODE-READ]**
`useFieldLinks.ts:388-392` hardcodes it, so accepting a **price** suggestion creates a group with
`translatePolicy: 'TRANSLATE'`. `translatableField` `:21-26` will refuse to translate it later, so
the damage is a wrong stored policy rather than a translated number — but the stored intent is false.

**5.8 N+1 in the planner. [CODE-READ]** `mapping-propagation.service.ts:189-215` loops coordinates
and calls `getResolvedRules(channel, marketplace, productType)` `:192` and `loadValueMapLookup`
`:194` **inside the loop**. `docs/pes-claims.md:7057` measured this class of cost on the mapping
side: "re-parsing all 17 cached DE schemas every time — a 50-row cascade ≈ 5235/4305/3921/3737 ms".

**5.9 The plan ignores child SKUs. [CODE-READ]** `:179` `prisma.channelListing.findMany({ where: {
productId: input.productId } })`. A cascade from the parent never sees the 20 children's listings.
The studio's master sheet is parent + child rows, so a family verb built on this endpoint as-is
would silently address 1/21 of what the operator sees.

**5.10 FM.8 auto-cascade is env-gated and off. [CODE-READ]** `pim-global.routes.ts:393-408`:
`if (process.env.FM_CASCADE_ON_SAVE === 'on')` then fire-and-forget `void applyCatalogCascade(...)`.
Default OFF, and it hangs off the OLD Global tab's PATCH, not the studio's writer.

**5.11 The intended `pim:manage` gate on field links has never applied.** §3, `permissions-manifest.ts:393`
vs `:412`. Note also `permissions-manifest-order.vitest.test.ts:50` includes `/api/field-links` in
its sample set — a shadowing assertion over a prefix no route uses, i.e. a check that cannot fail
for the reason it was written (`reference_a_scanner_passing_for_the_wrong_reason`).

**5.12 A fresh cascade's jobs are not visible in Errors & Sync. [CODE-READ]**
`channel-ops/syncQueue.ts:145` — the filters are `dead | retrying | stuck`, and `stuck` requires
`> 24h` (`:148,157-158`) with `holdUntil` null-or-past (`sync-queue.service.ts:211-214`). A row
enqueued 5 seconds ago with `holdUntil = +30s` matches none of them; it is inside `counts.all` and
nothing else. A run whose jobs cannot be watched is a run that cannot be trusted.

**5.13 Minor: `linkGroupId` is looked up without its variant key. [CODE-READ]**
`studio-sheet.service.ts:1256` `linkGroups.find(g => g.fieldKey === col.key)?.id` — the membership
test one line up (`:1160`) filters on `variantId`, this does not, so on a child row a PARENT group's
id can be attributed to a cell whose membership came from a CHILD group.

**5.14 No dry-run on apply. [CODE-READ]** `mapping-propagation.routes.ts:59-100` accepts only
`applyGrace`. Preview and apply are two different computations of the same plan (the apply
re-computes at `apply-mapping.service.ts:104`), which is the right instinct — but it means the
operator's approved snapshot and the applied snapshot are never proven equal.

Tests do exist: `services/__tests__/pim-mapping-propagation.test.ts`, `pim-apply-mapping.test.ts`,
`propagation.test.ts`. **None of them assert the queue payload against a consumer** — which is
precisely why 5.1 survived.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**Propagation — primary: H5 `CONTEXT(product-family)` verb `push-master-to-channels`, labelled
"Push master changes to channels…", rendered by the existing `FamilyVerbs` bar in the MASTER sheet's
`SheetToolbar` `leading` slot and by the family bar's `⋯`.**

`product-family`, not `alias-group`, and not H6, for a measured reason. The thing being pushed is a
MASTER value; the master scope's context *is* the family (`FamilyBar.tsx:50`), and every target
coordinate is by definition **outside the sheet on screen** — the scope rail switches coordinates,
so no single sheet can hold Amazon·IT and eBay·DE at once. A scope-wide H6 verb would bind the run
to the coordinate the operator happens to be looking at, which is the opposite of what edit-once
means. `contextOf` was split into two axes to stop exactly this one-level-off mistake
(`registry.ts:8-14`), and the `leading` slot on master is where family verbs already live
(`MasterSheet.tsx:1809`). The band `⋯` mirror keeps it out of drawer-only territory (channel-ops §3.2).

**Mirror A — H4 SELECTION verb, same id, field set pre-filled from the selection.** An operator who
has just fixed `brand` and `bullet_point_1` on four rows should not re-pick those fields in a
stepper. AG's cell-range selection gives us `{rows × columns}`; the verb collects
`fieldKeys = selected columns ∩ (columns with a `masterKey`)` and `productIds = selected rows`, then
enters the same stepper at step 2 with step 1 answered. **Same verb, two entry points, one
`preflight`/`run`** — never a second implementation, or the two drift the way the old
`propagate-preview` and `cross-channel/propagate-preview` did.

**Mirror B — H9 Errors & Sync.** The run's product is N queued jobs against coordinates that are
not on screen. Reporting them inline would be a claim about rows the operator cannot see; the
console is queue-shaped, groups by cause, and its rows jump. It needs a fourth filter, `in flight`
(§7) — without it the run is unobservable for its first 24 hours (5.12).

**Field links — primary: H4 SELECTION verb `link-across-markets`, labelled "Link identical values
across markets…", offered when the selection is inside ONE column.**

A link is a statement about a FIELD across COORDINATES. The row axis is irrelevant to it, and the
coordinate axis is not on the sheet — so the only sheet gesture that expresses it is *"this column"*,
which is a single-column cell range. Offering it on a multi-column selection would need the operator
to accept N groups from one click, so `available()` returns
`disabled('Select cells in one column — a link is per field')` there. On the channel scope the same
verb targets that field's coordinate set; on master it targets the master field's channel twins.

**Mirror A — H2, the 🔗 mark, which needs FIXING before it can be a mirror.** `linked` must become
its own member of `CellProvenance` with its own glyph and its own sentence (5.5). At rest that is
the whole of the field-link surface: no column, no chip, one glyph.

**Mirror B — H6 view chip "Link suggestions (n)"** via `useRegisterViewChip`
(`contracts.tsx:236`), filtering the sheet to the columns that carry a suggestion, with the
`link-across-markets` verb one click away and the suggestion's cluster pre-ticked. A chip, not the
old banner: a banner above a 101-column grid is the dead-space pattern the studio spent rulings
removing, and the chip registry already owns "here are n cells worth looking at". `count: null` when
the suggestions call has not answered, per the honest-count rule (`viewChips.ts:8-16`) — **never
`0`, which would claim we checked.**

**Explicitly NOT here.** No H1 cell (neither a push nor a link is a value you type). No H7-only
home for either verb (a verb must never live only in the drawer). No H11 page — this is per-product
by construction, which is why PES.6 correctly declined 6.28. No H12: 6.28 is the only path in the
system that turns a master edit into a per-coordinate marketplace push with an undo window.

### 6.2 What the sheet shows at rest, per scope

- **master scope:** nothing new. `follows` is already on every cell
  (`studio-sheet.service.ts:1179`); the existing 🔗/✎ marks already answer "does this cell reach the
  channels". The verb is a button in `leading`; the sheet is unchanged until it runs.
- **channel × market:** the `push-master-to-channels` verb is **HIDDEN** (`registry.ts:46`), not
  disabled. A channel scope's context axis is `alias-group`, so the family verb is not offered there
  at all — the axis split does this for free, and a greyed control here would teach something false.
  What the channel scope shows instead is the **existing** `affectsAllChannels` acknowledgement
  (`rows.ts:113,365`): the honest per-cell statement of the same fan-out.
- **link mark, both scopes:** 🔗 on a cell whose `linkGroupId` is set, with the *linked* sentence,
  hoverable to the member list. This is where a corrected `classifyProvenance` pays for itself.
- **after a propagation run:** on master, nothing repaints (the master value was already there —
  that is the point). Translations landing means the **locale** projection's cells repaint and the
  readiness pills recompute from the server's one definition. On the coordinate the operator later
  visits, the cell shows its resolved value and the sync state column shows PENDING.
- **`unmappedRequired` findings** get a `[Cascade gaps (n)]` chip on the *master* scope only while
  the run's report is fresh — a real cell-level destination, since the gap names a master field.

### 6.3 The interaction, step by step

1. **Open.** Master scope. `[Push master changes to channels…]` in `leading`, or the family bar's
   `⋯`, or (mirror A) a cell selection's `[Push to channels…]` in the selection bar.
   `available()`: `disabled('Save in progress — wait for autosave to settle')` while
   `writer.pending > 0` (5.3 is why); `disabled('This product has no channel listings')` when the
   family has none.
2. **COLLECT** — DS **`Stepper`** in a DS `Modal`, three steps, because the choices are ordered and
   each narrows the next:
   - *① Where.* DS `MultiSelect` over the family's coordinates, grouped by channel, each row showing
     `channel · market · listing status · readiness`. Default: every coordinate. Single-store
     channels (Shopify) appear as one `GLOBAL` row.
   - *② What.* DS `Checkbox` groups over columns **that have a `masterKey`**
     (`docs/2026-09-04-channel-attribute-model-design.md:117`), grouped by the spec's own `group`.
     🔴 **Default = the fields that `follow`** — the cell's own derived `follows`
     (`studio-sheet.service.ts:1179`), not the fixed six, because the fixed six was measured wrong
     on both channels. Price fields render **present and disabled** with the reason "handled by the
     pricing engine" (the old drawer's `:258` claim, now visible instead of footnoted).
     Quantity is absent (Amazon EU shares it; §8).
   - *③ Language.* A DS `Toggle` "Translate for markets in another language (n)", **OFF and
     disabled per ruling #13/#105 D7**, with the honest sentence naming what would happen. The
     cross-language coordinates are still listed, marked "will be pushed in the source language".
3. **PREFLIGHT.** One call to the existing `propagate-preview`, adapted into `ActionImpact`:
   `findings[]` = one row per (coordinate × field) with `previous → next` and severity —
   `error` for `unmappedRequired`, `warn` for `channelLimitTrimmed` / `currencyMismatch` /
   `needsTranslation`, `info` otherwise. `payload` carries the plan the run will apply
   (`registry.ts:90-103`, the time-of-check/time-of-use channel). `unavailable` is set with the
   server's reason when the preview fails — **never a run on a guess**.
4. **CONFIRM.** `ActionConfirm` renders the impact; `level` comes FROM the preflight
   (`registry.ts:49`). Plain `confirm` when no target coordinate has an `externalListingId`;
   **`type-to-confirm` with `confirmPhrase` = the channel** the moment any does — the rule
   `broadcast-to-listings` already set (`channelActions.ts:340-342`). The consequences list names
   the marketplaces, never "N listings".
5. **RUN.** One `POST` to a corrected apply (§7). Returns `{batchId, results[]}`. `invalidates`
   repaints the master sheet's locale projection + the scope-rail readiness. A toast: *"Queued 7
   coordinates · 2 will be pushed in the source language · undo for 30s"* with `[Undo]` and
   `[Open Errors & Sync]`.
6. **UNDO.** Within the hold window, delete the PENDING queue rows for the `batchId` and deactivate
   the audit rows. After it, the entry point is the console's row, which can already jump.

**Keyboard.** The toolbar button is in tab order; `useActionPress` owns the press sequence; the
`Modal` traps focus and returns it to the invoker. The sheet keeps its arrow keys because the
stepper is a centred `Modal`, not a second grid.

**With the drawer open.** The drawer is non-modal, 520px; the stepper overlays both. On close, a
drawer open on any family row repaints from the same invalidation, and its History pane gains the
run's rows.

**Field links** are shorter: select cells in one column → `[Link identical values across markets…]`
→ a `Modal` listing the field's coordinates with their current values, the identical cluster
pre-ticked, a translate-policy `Select` (`TRANSLATE | VERBATIM | NONE` — the group's real field),
and the count line *"3 coordinates will share one value"*. `preflight` returns `level:'confirm'`
plus a `warn` finding naming each coordinate whose value **differs** and would therefore be
overwritten by the next edit. `run` = one `PUT .../field-links/:fieldKey`. Accepting a chip's
suggestion is the same verb, pre-filled.

### 6.4 Per-scope rules

- **master:** both verbs available. Propagation is the family verb; links target the master field's
  channel twins.
- **channel × market:** propagation HIDDEN by axis. `link-across-markets` available and targets that
  field's coordinate set — the natural home, since coordinates are what a link is made of.
- **alias band:** neither verb. An alias is one listing's layout; a master push is not about one
  listing, and report 12's `copy-listing-setup` owns the alias axis. Keeping them apart is what
  stops two verbs writing the same cells under different rules.
- **single-store channels (Shopify/Etsy/Woo):** propagation includes them — `CONTENT_CHANNELS`
  already covers Shopify (`master-content.service.ts:31`) and `buildShopifyProductUpdate` `:83`
  handles title/body_html. They appear as one `GLOBAL` coordinate. `link-across-markets` is HIDDEN
  there: a single store has no second market to link to, and saying so is better than a group of one.
- **children:** the family verb addresses **parent + every child** (5.9 is why this must be stated).
  The stepper's step-① count says "21 SKUs × 4 coordinates".
- **a coordinate that overrides the field:** listed, unticked, with the reason "pinned on this
  coordinate — a master change does not reach it" — which is `applyMasterChanges`'s own semantics
  (`mapping-propagation.service.ts:82-84`) shown rather than hidden.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance.** Propagation creates no new provenance state: an inherited cell stays 🔗 because
  master is still its source. A LINK needs the new `linked` member (5.5) — and it is the one honest
  addition this feature makes to the vocabulary, because it changes what the next edit does, which
  is §9.6b's own test for earning a member.
- **Autosave.** The run is NOT autosave: a deliberate, confirmed, batched write on its own endpoint,
  `disabled` while `writer.pending > 0`, and it must CAS on the same tokens the sheet holds (5.3).
- **Readiness.** Never recomputed client-side. `unmappedRequired` findings are the preflight's, and
  the pills move only because the server said so after the run.
- **Publish.** 🔴 **The run enqueues; it does not publish.** But unlike every other studio verb the
  queue row IS a marketplace push, so the preflight must consult
  `getAmazonPublishMode()`/`getEbayPublishMode()` and say which coordinates would actually transmit —
  eBay is preview-only today. A cascade that queues a live Amazon push while the operator believes
  the studio "sends nothing yet" is the worst outcome available here.

### 6.6 ASCII mockup

```
 21 rows · 4 selected  [Push master changes to channels…] [Link identical values across markets…]
                       [View ▾][Missing required (7)][Link suggestions (3)]  Find…  [Customise]
┌─ MASTER · GALE-JACKET ───────────────────────────────────────────────────────────────────────┐
│ ▾ P  GALE-KAN-PRO       🔗 GALE Pro Racing Suit   🔗 Kandui   ✎ 149,00  ⚠ …                  │
│   ▸  GALE-KAN-PRO-NE-S  🔗 GALE Pro Racing Suit   🔗 Kandui   🔗 149,00                       │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
   ┌── Push master changes to channels ────────────────── ①Where ─②What─ ③Language ──┐
   │ WHERE   ☑ Amazon · IT  ACTIVE 92%    ☑ Amazon · DE  ACTIVE 88%                  │
   │         ☑ Amazon · ES  ACTIVE 71%    ☑ eBay · IT    ACTIVE 84%  preview-only    │
   │         ☐ Shopify · GLOBAL  no listing yet                                      │
   │ WHAT    ☑ Title  ☑ Description  ☑ Bullet points  ☑ Brand  ☐ Category ⚠          │
   │         ⊘ Price — handled by the pricing engine    (quantity not offered)       │
   │         defaults = the 4 fields these coordinates FOLLOW                        │
   │ LANG    ☐ Translate for DE, ES (AI off — ruling #13). Both get Italian copy.     │
   │ → 27 changes across 4 coordinates · 21 SKUs · 2 required fields still empty ⚠   │
   │                                            [Cancel]  [Preview the fan-out]      │
   └─────────────────────────────────────────────────────────────────────────────────┘
```

## 7. Contracts and data

**Reused unchanged.**
- `POST /api/products/:id/mapping/propagate-preview` (`mapping-propagation.routes.ts:28`) — the
  preflight, already accepting `channels[]`, `markets[]`, `locale`, `sourceMarketplace`.
- `PUT /api/products/:id/field-links/:fieldKey` (`field-links.routes.ts:170`) — the link write, with
  its `AuditLog` rows already correct.
- `GET /api/products/:id/field-links` (`:157`) and `linkGroupId` on the studio contract
  (`studio-sheet.service.ts:136,1256`) — the mark's data is already on the wire.
- `GET /api/products/:id/cascade-preview` (`pim-global.routes.ts:594`) — the **dead card's live
  endpoint**, which already answers inherit-vs-override counts per tracked field. It is the cheap
  "what changes where" summary for the stepper's step-② hint, and it needs a caller, not a rewrite.

**Server changes — PES.5 owns every one.**
1. 🔴 **Fix the queue payload (5.1).** Emit the cascade's fields FLAT plus `productType`, exactly as
   `master-content.service.ts:186-196` does, or teach both consumers to read `payload.fields`.
   Whichever way, **land the producer and the consumer in ONE write** and add the test that was
   missing: a queue row built by `applyCatalogCascade` fed to `buildAmazonListingPatch` must produce
   a non-empty `patches[]`, and to `mergeEbayInventoryItem` a `merged !== existing`.
2. 🔴 **CAS, not increment (5.3).** Accept `expectedVersion` per touched entity and 409 on mismatch,
   the same contract `PATCH /api/products/bulk` already honours.
3. **Include the family (5.9).** `planMappingPropagation` takes `productIds[]` (or resolves the
   family from the root) instead of one id.
4. **Hoist the per-coordinate loads (5.8).** `getResolvedRules` / `loadValueMapLookup` batched by
   `(channel, marketplace, productType)` before the loop.
5. **`dryRun` on apply (5.14)** so the confirm and the run describe one computation, and `batchId`
   in the response so undo is one call.
6. **`POST /api/products/:id/mapping/apply/:batchId/undo`** — delete the still-PENDING rows of the
   batch and set `ChannelListingOverride.isActive = false`.
7. **Suggestions from the adapters (5.6).** Compare over `ChannelFieldSpec` keys, key the `linked`
   suppression on `(fieldKey, variantId)`, return **every** ≥2 cluster, and distinguish "scan
   failed" from "nothing identical" instead of returning `[]` for both.
8. **Fix `permissions-manifest.ts:393`** to `pfx('/api/products')` + `has('/field-links')` above
   `:412` if `pim:manage` is the intended gate — or delete the rule and record that `products:edit`
   is the decision. Either way the manifest must stop asserting a mapping it does not make.

**Additive schema (pre-approved class), all nullable.**
- `ChannelListingOverride.batchId String?` — so an undo is one query. (`reason` is already free text,
  so `'fm-catalog-cascade'` needs nothing.)
- `OutboundSyncQueue` needs nothing — `holdUntil` is the window and `payload.source` is the tag.
- `@@unique([productId, fieldKey, variantId])` on `FieldLinkGroup` — the identity the route already
  enforces by hand (`field-links.routes.ts:221-230`). Strictly a constraint, not a column.

**Read-contract additions (PES.5, mirrored by PES.3 per the wire→UI rule).**
`StudioCellValue` gains nothing — `linkGroupId` and `follows` are already there. What it needs is the
group's **members** so the 🔗 tooltip can name them: `linkGroup: { id, memberCount, translatePolicy } | null`
replacing the bare id, and `linkGroupId` kept as an alias for one release.

**Lane ownership.**

| piece | lane |
|---|---|
| payload fix · CAS · family scope · N+1 · dryRun/batchId · undo · suggestion rewrite · manifest | **PES.5** |
| `linked` as its own `CellProvenance` member + glyph + sentence; the `payload`→`run` channel | **PES.2** |
| `push-master-to-channels` (family + selection adapters), the Stepper dialog, `link-across-markets`, the "Link suggestions (n)" chip | **PES.2** (master sheet) with **PES.3** for the channel-scope link verb |
| the group's member list + link history in the Record/History panes | **PES.4** |
| an `in flight` filter + the batch's per-coordinate results and undo entry | **PES.9 / Errors & Sync** |
| the translate step staying dark, and the honest sentence on it | **PES.8** |
| `masterKey` on `ChannelFieldSpec` (the field set's source of truth) | **PES.6** |

## 8. Risks and traps

1. 🔴 **The apply is a REAL PUSH PATH and local dev writes the production database.** The queue row
   is durable and the BullMQ delay is 30 seconds. Exercising this verb from a local studio enqueues
   against live Amazon·IT/DE/ES listings and the live eBay fixture family. Nobody may run the apply
   until the payload fix (§7.1) is landed **and** the preflight reports the publish mode — because
   today's no-op (5.1) is the only thing that has kept it harmless.
2. 🔴 **Fixing 5.1 ARMS a path that has never transmitted.** The moment the payload is correct, a
   verb that has silently done nothing starts pushing to marketplaces. The fix and the publish-mode
   gate are inseparable and must land together, with the first exercise on a coordinate that has no
   `externalListingId`.
3. 🔴 **AI translation runs on APPLY (`apply-mapping.service.ts:147`) and on PREVIEW
   (`field-links.routes.ts:109,431`).** Ruling #13 forbids live generation and #105 D7 puts translate
   in PES.8's dark lane. The stepper's translate step must be built and OFF, and the apply must not
   call `translateProductCopy` while it is. A "preview" that spends AI budget is also not a preview.
4. **Amazon EU shares quantity across markets**; **images are global per ASIN**. Both stay out of the
   field set — the allow-list is `masterKey`-bearing content and attribute columns, never the
   `attributes` blob wholesale.
5. **Price is the pricing engine's.** The planner already skips it on a currency mismatch
   (`mapping-propagation.service.ts:135`) and the apply skips all price keys (`:114`). Render it
   disabled-with-a-reason rather than absent, so the operator learns where price lives.
6. **eBay DRAFT rows are LIVE** — a coordinate's `listingStatus` is not a safety signal; only
   "verified no push path" is. The preflight must derive live-ness from `externalListingId`.
7. **The 30s undo window is a promise about a queue, not about a marketplace.** Once the job leaves,
   undo is a second push. The toast must say "undo for 30s", never "undo".
8. **Untouchables:** the flat-file editors, FBA quantity, the existing import flows. Nothing here
   touches them; the propagation planner reads mapping rules and the resolver only.
9. **Two propagation planners already exist** — `pim/mapping-propagation.service.ts` (master →
   coordinates, mapping-aware) and `field-resolution/propagation.ts` (link group, pure). They are
   genuinely different computations and should stay two. The trap is a third one appearing for the
   selection-scoped mirror; that mirror must call the same endpoint.
10. **Concurrency.** A cascade landing during an in-flight autosave is the banked "in-flight autosave
    UNDID an API revert". `disabled` while pending + CAS is the answer, and a delayed re-read is the
    only honest way to verify a run.

## 9. Open questions for the Owner (max 3)

1. **Do we fix the dead push (5.1), or ship the verb honestly inert until you say so?**
   *Recommendation: fix it, and gate it.* Land the payload fix, the CAS and the publish-mode
   preflight in one write; ship the verb with the run refusing any coordinate that has an
   `externalListingId` until you have watched one dry coordinate go through end to end. The
   alternative — a "Push to channels" button that queues nothing — is the honesty violation the
   studio exists to end, and 6.28's own audit line calls this "the expensive kind of gap".
2. **Does `linked` get its own glyph, making the provenance vocabulary eleven members?**
   *Recommendation: yes.* It passes §9.6b's own test — it changes what the next edit does — and today
   the mark tells an operator the literal opposite of the truth (5.5). If you'd rather cap the
   vocabulary, the fallback is to **remove** `RecordField.tsx:530-534`'s promise and treat links as a
   read-only fact until the write path honours them; what cannot stand is the current pair.
3. **Is "push master changes to channels" a family verb, or should it live on the header `Publish ▾`
   (H10)?** *Recommendation: family verb.* It is not a publish — it writes local records and enqueues
   — and `Publish ▾` is per channel while this is deliberately across channels. But it is the one
   verb in the studio that turns an edit into an outbound job, so if you want every transmit-shaped
   action under one menu, this is the one that would move.

## 10. Effort and dependencies

| piece | size |
|---|---|
| Queue payload fix + the producer/consumer test (§7.1) | **S** — the correct shape already exists in `master-content.service.ts:186` |
| CAS on apply (§7.2) | **S** |
| Family scope + N+1 hoist (§7.3, §7.4) | **M** |
| `dryRun` + `batchId` + undo endpoint (§7.5, §7.6) | **M** |
| `push-master-to-channels` verb: family + selection adapters, 3-step Stepper, preflight adapter | **L** |
| `linked` provenance member + glyph + sentence (PES.2) | **S** |
| `link-across-markets` verb + dialog (both scopes) | **M** |
| Suggestions rewrite over `ChannelFieldSpec` (§7.7) | **M** |
| "Link suggestions (n)" chip | **S** |
| `in flight` filter in Errors & Sync | **S** |
| Manifest fix (§7.8) | **S** |

**Dependencies.** `masterKey` on `ChannelFieldSpec` (PES.6, the approved channel-attribute model) is
the field set's source of truth — without it step ② falls back to the derived `follows`, which is
honest but narrower. The `payload`→`run` channel in `ActionImpact` already exists (`registry.ts:103`).
Report **12**'s `copy-listing-setup` shares the "pick a field set, pick targets, preflight, batched
write, undo the batch" skeleton and the promotion of a `collect` hook into the registry — **build the
skeleton once**. Report **26**'s replicate/broadcast is the third consumer; note that
`broadcast-to-listings` today is `ok:false` (`channelActions.ts:352`), so all three verbs are
waiting on the same first real cross-coordinate write. Coordinate with report **07**
(field-source/lock/undo) on the `followMaster*` flags — the cascade READS them, 07 WRITES them.
