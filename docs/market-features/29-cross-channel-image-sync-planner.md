# 29 — Cross-channel image sync bar + cross-channel publish planner

## 1. What it is (operator terms)

Two capabilities that the old Images tab put side by side, and they answer different questions.
The **sync bar** ("Quick sync") is for the merchandiser who has curated pictures in ONE place and
wants them in another without re-picking: one click stages "Amazon's gallery → eBay's gallery",
"Amazon's colour sets → Shopify's variant assignments", "Master gallery → this channel". Nothing
leaves Nexus; it stages rows the operator then saves. The **publish planner** is for the same person
five minutes later, when the pictures are right in Nexus and have to reach the marketplaces: tick
the channels/markets, read coverage and validation per channel, fire them one at a time, watch each
one report. Used at the end of a photo-shoot ingest, at a seasonal refresh, and whenever an ASIN's
MAIN image is replaced — i.e. rarely per product but always across many channels at once.

## 2. Old UI — inventory

**Sync bar — `tabs/images/CrossChannelSyncBar.tsx` (140 L).** Three discriminated-union branches:
`amazon` (:82-102, four PUSH buttons), `ebay` (:104-121, three PULL buttons), `shopify` (:124-138,
three PULL buttons). Buttons are `@/components/ui/Button` ghosts; the toast text is composed by
`toastMsg()` (:48-55) from a `{copied, skipped}` pair.

Mounts — and this is the first correction to the parity row:
- `amazon/AmazonPanel.tsx:967-976` — LIVE (4 buttons).
- `shopify/ShopifyPanel.tsx:600-609` — LIVE (3 buttons).
- **eBay: no mount anywhere.** `grep CrossChannelSyncBar` over `tabs/images/**` returns only the
  two panels above. `ebay/EbayPanel.tsx:79-81` *declares* `onCopyFromMaster`,
  `onCopyFromAmazonGallery`, `onCopyFromAmazonColorSets` and **never reads them** (3 occurrences in
  the file, all three in the props interface), while `tabs/ImagesTab.tsx:769-771` dutifully passes
  all three. **So "Amazon→eBay gallery / colourSets" as a PULL is DEAD**, and the only live path to
  eBay is the Amazon panel's two PUSH buttons (`ImagesTab.tsx:739-740`). CODE-READ.

**The copy engine — `useImagesWorkspace.ts:226-308`, browser-local.** `copyChannelImages({fromPlatform, toPlatform, type: 'gallery'|'colorSets'|'all', activeAxis, overwrite})`
reads the already-fetched workspace (`data.master` / `data.listing`), builds `addPendingUpsert()`
rows and returns `{copied, skipped}`. **No server call** — the copy only reaches the database via
`savePending()` → `POST /images-workspace/bulk-save` (:187). Dedupe is by
`(platform, variantGroupKey, variantGroupValue)` against both server rows and pending rows
(:280-290).

**Planner — `tabs/images/CrossChannelPublishModal.tsx` (397 L), opened from
`ImageActionBar.tsx:370-378` (`onOpenCrossChannel`), mounted `ImagesTab.tsx:944-957`.** Three
`ChannelCard`s with a checkbox, a status badge and 3-4 bullets. Coverage/validation is entirely
client-side: `useChannelValidation()` (:79-80) → `packages/shared/image-validation.ts:128`
`validateImageList` against `PLATFORM_RULES` (:43-82: Amazon min 1/max 9/1000px, eBay max 24/500px,
Shopify max 250/800px); staleness from `findStaleListingImages` (:82-83); Amazon gets only a coarse
summary (:86-97) because "server-side IA.4 owns full validation" (:85). Default selection = every
channel with content and no blocking issue (:101-107). `run()` (:128-148) iterates the selected set
**sequentially**, delegating each to `ImagesTab.handlePublish` (:378), and paints a per-channel
progress line (pending/in-progress/done/error, :269-294).

`handlePublish` is the shared pre-publish contract the modal inherits: cross-tab pre-save
(`onPreSaveAll`, :422-429), eBay bucket flush (:432-435), `savePending()` (:436-442), an approval
gate that can queue instead of firing (:384-415), then per-channel POST. For Amazon it loops
`['IT','DE','FR','ES','UK']` (:445-473) — five POSTs, one per market.

Browser-local only: the approval queue (`approvalPrefs.ts`), publish snapshots
(`publishSnapshotStorage.ts`), auto-publish arming (`autoPublishPrefs.ts`), the remembered publish
target (`ImageActionBar.tsx:83-114`). All of it is per-browser.

## 3. Backend that exists

| method + path | file:line | notes |
|---|---|---|
| `POST /api/products/:productId/amazon-images/publish` | `routes/images/amazon-images.routes.ts:64` | IA.4 gate (:87-110): 422 only when EVERY variant is blocked; `force=true` skips. Accepts + now forwards `dryRun` (:118). Audit records `result.dryRun` AND `requestedDryRun` (:132-137). |
| `POST /api/products/:productId/ebay-images/publish` | `routes/images/channel-image-publish.routes.ts:58` | marketplace comes from the **QUERYSTRING** (:61), not the body. No `dryRun` in or out. |
| `POST /api/products/:productId/shopify-images/publish` | same file :102 | body `{activeAxis}` only. No `dryRun`. |
| `POST /api/products/:productId/images-workspace/bulk-save` | `images-workspace.routes.ts:432` | transactional; deletes first. |
| `POST /api/products/:productId/images-workspace/copy-scope` | `images-workspace.routes.ts:512` | **server-side cross-scope copy — ZERO callers** (grep over `apps/web` + `apps/api`: only its own definition and doc comment). |
| `POST /api/products/:productId/amazon-images/fill-from-gallery` | `amazon-images.routes.ts:295` | live; called by `AmazonMirrorControls.tsx:49`, `AmazonPanel.tsx:421`. |
| `GET /api/products/:productId/amazon-images/validate` | `amazon-images.routes.ts:320` | `validateAmazonPublish`. |
| `GET /api/products/:productId/image-publish-jobs` | `channel-image-publish.routes.ts:146` | unified Amazon+eBay+Shopify, newest first. |
| `POST /api/image-publish-jobs/:jobId/retry` | same :233` | |
| `PATCH /api/products/:id/channel-follows` | `routes/product-channel-data.routes.ts:727` | flips `followMasterImages` per coordinate (`services/pim/channel-follows.service.ts:25,41`). |
| `GET /api/listings/publish-readiness` | `routes/listings-syndication.routes.ts:2639` | `{amazon,ebay,shopify}: {enabled, mode}` (:2667). |

Prisma: `ListingImage` (schema:8001-8078) — `scope GLOBAL|PLATFORM|MARKETPLACE`, `platform`,
`marketplace`, `amazonSlot`, `variantGroupKey/Value`, `role`, `position`, `sourceProductImageId`,
`publishStatus`, `locked` (:8059), `altOverride`. `ChannelImagePublishJob` (:8201-8226, has a
`marketplace` column). `ChannelListing.followMasterImages Boolean @default(true)` (:1567).

Safety gates: **Amazon only.** `amazon-batch-feed.service.ts:217` `isDryRunEnv()` =
`getAmazonPublishMode() !== 'live'`, and :242-257 is the one-way guard (`isDryRunEnv() || input.dryRun === true`).
`amazon-image-feed.service.ts:409` forwards `dryRun`.

Permissions (`lib/auth/permissions-manifest.ts`, first-match): `has('/images')` at :380 →
`productsImagesEdit` catches `/images-workspace/**` and `/images/**`. It does **not** catch
`/amazon-images/`, `/ebay-images/`, `/shopify-images/` (the substring is `/amazon-images`, not
`/images`), so all three publish routes fall through to `RW(productsView, productsEdit, pfx('/api/products'))`
at :412. Net: **firing a channel image publish needs only `productsEdit`; staging the copy needs
`productsImagesEdit`. Two disjoint permissions on the two halves of one workflow.** CODE-READ.

## 4. Studio today

- **Planner: BUILT.** `_studio/images/plan/crossChannel.ts` (167 L, pure + 164 L of tests) +
  `plan/CrossChannelPlanner.tsx` (223 L). Mounted `_studio/images/ImagesTab.tsx:170-178`, **only
  when `scope !== MASTER_SCOPE`**. Targets come from `useStudioScope().options.channels` (the
  marketplace table — measured 11 Amazon markets, inventory §27). It leads with DESTINATIONS not
  targets (`planHeadline`, crossChannel.ts:159-167), collapses Amazon's markets to one destination
  (`destinationOf`, :96-98) and names the mechanism per family (`mechanismNote`, :111-125) — D1's
  mandatory honesty clause (inventory §7). Fire path `CrossChannelPlanner.tsx:94-118`, sequential,
  reporting the SERVER's `dryRun` (:104-113).
- **Sync bar: NOT BUILT.** Inventory §30.1 lists "cross-channel quick-sync strip" under "Not built
  at all" (§2.5). Confirmed by grep: zero `copy`/`mirror`/`crossChannel`-copy code in
  `_studio/images/**`; `_studio/images/api.ts:100-128` has no `copyScope` entry.
  (`channel/amazon/mirrorPlan.ts` is a *publish* diff — Amazon vs its live cache — not a copy.)
- **Parity audit rows 5.12 / 5.55** (`docs/pes-parity-audit.md:294`, `:353`): **Status column is
  EMPTY — 0 of 57 rows in section 5 (lines 278-357) carry any status**, against protocol #85 which
  requires the owning lane to fill every row. The lane's findings live only in its own inventory
  §30. So 5.12 ≈ built-with-gaps and 5.55 = MISSING, neither of which is *recorded* where the
  programme reads it.
- Rulings that bind: **D1** (inventory §7 — per-market model stays, honest mechanism preview
  mandatory). **#176** (`dryRun` never forwarded — the latent safety defect). **#179** (`dryRun`
  FIXED, one-way by construction, proven by mutation). **#247 / BE-11** (eBay + Shopify BATCH
  submits are live-by-default → OWNER QUEUE; no lane touches those two files until the Owner
  rules). **#110/#113/#114/#118** (one action registry, `ContextAxis`, disabled-must-explain,
  COLLECT→PREFLIGHT→CONFIRM→RUN). **#127** (Errors & Sync is sync-queue-first). **#169** (layout v2,
  full-bleed sheet).

## 5. Defects and slowness

1. 🔴 **The planner's own safety sentence is false for two of three channels.** CODE-READ.
   `CrossChannelPlanner.tsx:205` prints *"Every gate is closed on this deployment, so nothing here
   reaches a channel"* and :198 labels the button *"Rehearse N targets"* — both derived from
   `/listings/publish-readiness`. But a set-scan for `dryrun|publishmode|publishgate|isEbayPublishEnabled|isShopifyPublishEnabled`
   over the whole eBay/Shopify image path returns **0 in all four files**:
   `routes/images/channel-image-publish.routes.ts`, `services/images/ebay-inventory-image-publish.service.ts`,
   `services/images/ebay-shared-image-publish.service.ts`, `services/images/shopify-image-publish.service.ts`.
   The eBay path hardcodes `const EBAY_API_BASE = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'`
   (`ebay-inventory-image-publish.service.ts:48`) and hands it to `pushVariationGroup` (:310-330),
   which raw-`fetch`es `/sell/inventory/v1/...` (`ebay-variation-push.service.ts:477,1827,1841,…`);
   `getEbayPublishMode()` exists (`ebay-publish-gate.service.ts:40`) and is never called on this
   path. Shopify PUTs `https://${SHOPIFY_SHOP_NAME}.myshopify.com/admin/api/2024-01/products/...`
   (`shopify-image-publish.service.ts:125-135`) with the same absence. This **extends #247/BE-11
   from the two batch services to the image publish path**, which is exactly the path the planner
   fires. Pressing "Rehearse" would reach live eBay if a connection resolves.
2. 🔴 **The planner cannot honour a rehearsal it could now have.** `CrossChannelPlanner.tsx:101`
   sends `{ marketplace }` for Amazon and `{}` otherwise — **no `dryRun`** — so it always defers to
   the deployment gate, even though #179 made a caller-forced rehearsal one-way-safe. Its docblock
   (:10-13) still asserts *"The `dryRun` body field is inert (`submitAmazonImageFeed` never forwards
   it)"*. Mtimes: the fix landed `amazon-image-feed.service.ts` at 2026-09-01 23:28; the planner was
   edited later, 2026-09-02 15:42, and the stale claim survived the edit. `PublishPanel.tsx:141`
   carries the same dead sentence (though :67 does send the flag). CODE-READ + MEASURED-IN-DOC (§28).
3. 🔴 **eBay per-market targets all fire the same market-less endpoint, and the collision detector
   cannot see it.** `_studio/images/api.ts:124` `ebayPublish` has no `?marketplace=`, while the
   route reads marketplace from the querystring (`channel-image-publish.routes.ts:61`). The planner
   builds one target per declared eBay market (`buildTargets`, crossChannel.ts:71-80) and
   `destinationOf` (:96-98) returns `t.key` for `ebay-inventory` — so `EBAY:IT` and `EBAY:DE` are
   "different destinations", `collisionGroups` returns nothing, and `planHeadline` says *"2 targets,
   each writing somewhere different."* while both POST the identical URL. **The exact illusion the
   module was written to prevent, reproduced on eBay.** CODE-READ.
4. 🔴 **eBay and Shopify can never report an outcome in the planner's log.** :104-113 branches on
   `res.data?.dryRun`; neither route returns that field (`channel-image-publish.routes.ts:6,10`), so
   both channels permanently render *"Completed, but the server did not say whether it was
   submitted."* — on success and on a real live submission alike. CODE-READ.
5. 🔴 **`copy-scope` is a dead server endpoint whose semantics would be wrong if wired.** CODE-READ.
   (a) It never overwrites: `overwrite: true` merely skips the existence check and then `create`s
   (`images-workspace.routes.ts:540-576`), so it **duplicates** rather than replaces. (b) Its
   existence check keys on `(variationId, scope, platform, marketplace, amazonSlot)` (:541-550) —
   `amazonSlot` is NULL for every eBay/Shopify row, so the first target row matches every source and
   the whole copy is `skipped`. (c) It cannot read master at all (`prisma.listingImage.findMany`
   only), so "Master→X" is outside it. (d) N+1: a `findFirst` + `create` per source image, **not in
   a transaction** — a partial copy is reachable. (e) It ignores `ListingImage.locked` although
   `:584-587` states *"cross-market Copy won't overwrite it"* — a comment asserting a property the
   code lacks.
6. 🔴 **The old copy picks the channel MAIN by array index, not by primacy.** `useImagesWorkspace.ts:246-256`
   maps master rows with `position: idx`, then :301 sets
   `role: variantGroupKey ? 'GALLERY' : (position === 0 ? 'MAIN' : 'GALLERY')`. The workspace
   fetches master `orderBy: { sortOrder: 'asc' }` (`images-workspace.routes.ts:114`), while the
   studio's own face-image rule is `isPrimary → first MAIN → lowest sortOrder`
   (`studio-sheet.service.ts:200-204`). A product whose primary image is not lowest-sortOrder gets
   the **wrong image as the channel's MAIN**. `m.type`/`m.isPrimary` are available on the same rows
   (:32-41) and are ignored. CODE-READ.
7. **Two of the Amazon panel's four sync buttons are gated on the wrong source.**
   `CrossChannelSyncBar.tsx:88` gates "→ eBay gallery" and "→ Shopify pool" on `hasMasterImages`
   (`AmazonPanel.tsx:969`), but the handlers copy `fromPlatform: 'AMAZON'`
   (`ImagesTab.tsx:739,741`). With master images and zero Amazon rows both buttons are offered and
   copy nothing. CODE-READ.
8. **`followMasterImages` is a reporting artefact, not a publish mechanism.** `grep -c followMasterImages`
   over all 28 `services/images/*.ts` → **0 in every one**. It drives `deriveSyncStatus` → `OVERRIDE`
   (`sync-status.service.ts:19-38`) and the sheet's `FOLLOW_FLAGS` (`studio-sheet.service.ts:432`),
   and nothing else. `reference_api_accepts_a_flag_it_ignores`. CODE-READ.
9. **`services/images/effective-listing-image.service.ts` is DEAD** — its docblock says *"The
   publisher, cascade-republisher, and any other reader uses this helper instead of reading
   `ListingImage.url` directly"*; grep for `resolveEffectiveListingImage` across `apps/` +
   `packages/` finds only its own compiled `dist/*.d.ts`. So the `sourceProductImageId` link the
   copy writes resolves nowhere. CODE-READ.
10. **`amazon-images/validate` accepts fewer markets than `amazon-images/publish`.**
    `amazon-images.routes.ts:41` `VALID_MARKETPLACES = {IT,DE,FR,ES,UK}` gates validate (:324);
    publish uses `marketplaceCodeToId(mkt)` (:71, "M6 — all configured EU markets"). Adding a
    preflight to the planner on the 11 declared Amazon markets would 400 on six of them. CODE-READ.
11. **The sheet knows nothing about channel images.** `grep -c listingImage studio-sheet.service.ts`
    → 0; `photoCount` (:207, :1353) counts master `ProductImage` only. There is no per-channel image
    coverage anywhere in the sheet read, and `readiness.service.ts` mentions `image` **zero** times.
12. **The planner hides on master scope** (`_studio/images/ImagesTab.tsx:170`), so a cross-channel
    control requires first choosing one channel. Its "possible targets" count and headline are also
    unreachable from the header. CODE-READ.
13. Not exercised: inventory §27 states the planner's sequential-fire path is "built and typechecked
    but unexercised" — no publish was ever fired from it. MEASURED-IN-DOC.

## 6. Proposed home in the studio

### 6.1 Primary + mirrors

**PLANNER — primary H8 (Images tab), mirrored H10 (header `Publish ▾` → "Images → channels…") and
H5 (alias-band CONTEXT verb "Publish images").** The planner is a media surface with per-channel
coverage, mechanism prose and a run log — not tabular, so it belongs on the Images tab (tabs are for
non-tabular surfaces, layout §1). But it is *about all channels*, and today it is only reachable
after choosing one, which is backwards (defect 12). The header is where a product-level publish
entry belongs (H10), so `Publish ▾` gains one **live** item, `Images → channels…`, that opens the
SAME component — a Modal over the sheet on the Sheet tab, the in-place panel on the Images tab.
That is honest even beside the menu's dark channel items (`PublishMenu.tsx:67`, every item
`disabled: true`): the entry *opens a planner*, it does not publish, so it is a navigation item, not
an armed control. The third entry is the alias band, because an operator working one listing's row
group should not have to leave the sheet: a `contextOf('alias-group')` verb (`registry.ts:33-42`)
named `publish-images` opens the planner **pre-ticked to that alias's coordinate**. One component,
three doors, one verb declaration — which is the registry's whole reason (#110/#113): a verb offered
in two places must not become two behaviours.

**SYNC (copy) — primary H5 CONTEXT(alias-group) verb "Copy images from…", mirrored H4 (selection
bar over N child rows), H3 (row menu / ⋯) and H8 (the same verb rendered as the Images tab's own
bar via `menuAdapters`); with H1 carrying the resting state.** A copy is a *verb*, not a surface:
it collects a source, preflights how many rows it would add/skip/overwrite, asks at a weight the
preflight chooses, and runs. That is precisely `GridAction` + `ActionImpact` (`registry.ts:84-90`),
and the confirm level must come from the preflight — "copy 3 gallery images into an empty eBay
alias" is a plain confirm, "copy over 14 pinned Amazon·ES rows" is type-to-confirm. Putting it in
the registry also fixes the old bar's shape problem: eight fixed buttons whose availability was
hand-gated per branch (and got it wrong, defect 7) become one verb whose `availability` returns
`disabled(reason)` naming the empty source (#114). It must NOT live only on the Images tab, because
a copy is the natural thing to want while looking at an empty Images column in the sheet.

### 6.2 What the sheet shows at rest, per scope

**New H2 status column `Images`, channel scopes only.** Read-only, derived, filterable, one per
channel×market coordinate:

| cell | meaning |
|---|---|
| `6/7` | pinned+inherited images resolved for this row against what the channel requires (`PLATFORM_RULES` min/max, `packages/shared/image-validation.ts:43-82`) |
| `MAIN missing` (danger) | no `role: MAIN` / `amazonSlot: MAIN` resolves — the one hard fail that refuses a publish (`amazon-publish-validator`) |
| `⚠ drift` | the channel's live read-back cache disagrees with Nexus's plan for this coordinate |
| `—` | this row has no listing on the channel (`unlisted`, never `0/7`) |

Provenance mark uses the **existing** cell vocabulary (`renderers/provenance.ts`), no second
vocabulary: `🔗 inherited` when the row resolves from master (`followMasterImages` true and no
pinned `ListingImage` rows for the coordinate) with `inheritedFrom: "master"`; `✎ pinned` when the
coordinate carries its own rows. The alias band's own `Images` cell is the roll-up over its
children. **Master scope shows no Images column** — `photoCount` already exists on the row
(`studio-sheet.service.ts:207`) and the identity cell already carries the thumbnail; a second
master image column would be the duplicate the frame exists to remove.

The column is **not editable** (H2), and double-click on it opens the Images tab at that coordinate
rather than an editor — the gesture map's "double-click EDITS" is honoured by having nothing to
edit, and the verb is the way to change it. The follow half IS editable, as the existing
`images` follow cell (H1) backed by `PATCH /channel-follows` — with the caveat of defect 8 fixed
first, or the cell must say what the flag does and does not do.

### 6.3 The interaction

**Planner.** Open (any of the three doors) → the panel reads `/listings/publish-readiness` once
(already done, `CrossChannelPlanner.tsx:67-73`) and builds targets from `options.channels`. It
states the destination count **before** anything can be ticked. COLLECT: `Checkbox` per target card
with `n pinned · m from all-markets`; PREFLIGHT: per-target coverage from the new server preflight
(§7) — `n/required`, `MAIN missing`, blocking/warning counts, and eBay/Shopify's `PLATFORM_RULES`
verdicts that the old modal had and the built planner lost; CONFIRM: a DS `ActionConfirm` naming
each destination and the mechanism, and **type-to-confirm whenever any selected target's gate is
open**; RUN: sequential, one target at a time, each row updating to sent/failed. Repaints: the run
log, the Images tab's `PublishHistory`, and — the change that matters — the sheet's `Images` column
for the affected coordinates, plus the scope chips. Keyboard: `Space` toggles a card, `Enter` on the
footer button, `Esc` closes (blocked while running, as today). With the drawer open the planner is
unaffected — it lives in the tab or in a Modal above the sheet, and the drawer is non-modal and
keeps its own scroll.
DS components: `Modal` (header door), `Card`, `Checkbox`, `Pill`, `Badge`, `Banner` (the gate
sentence), `Button`, `Stepper` is *not* used (the three phases are one screen, not a wizard).

**Copy verb.** Select rows (or open the alias band's `⋯`) → "Copy images from…" → a `Listbox`
of legal sources for the active coordinate (Master · Amazon·IT · Amazon (all markets) · eBay·IT …),
plus a `SegmentedControl` for `gallery / colour sets / both` — the old `type` parameter, named in
operator words. PREFLIGHT calls the server (§7) and returns `{wouldAdd, wouldSkip, wouldOverwrite,
lockedSkipped}` per target row; the `ActionImpact` title names them ("adds 12, leaves 3 alone,
replaces 2 pinned"). RUN writes through the server in one transaction, then the sheet repaints the
`Images` column and the Errors & Sync count. **Autosave applies**: the copy is a server write filed
through the studio's `SaveReporter` under a subject (`imageWrites.ts`'s `surface:` vocabulary), so
the header's autosave indicator covers it and there is no staged-and-unsaved limbo — which retires
the old model's `pendingUpserts` map entirely.

### 6.4 Per-scope rules

- **Master scope**: no planner, no Images column. The copy verb is offered in one direction only —
  *"Send master images to…"* — because master is a source, never a target of a channel copy. This is
  the one thing master scope adds, and it is a `contextOf('product-family')` verb.
- **Channel × market (Amazon, eBay)**: the planner offers every declared market for the channel; the
  copy verb's source list includes the channel's own all-markets layer, and `pinned`/`inherited` are
  distinct (`crossChannel.ts:28-32` already models this correctly).
- **Alias band**: a `contextOf('alias-group')` verb acts on the alias's coordinate only; the band's
  `Images` cell is the roll-up. A family with N aliases gets N independent verbs, never one.
- **Single-store channel (Shopify)**: `markets: []` → `buildTargets` already emits one market-less
  target (`crossChannel.ts:64-69`). The Images column exists on the Shopify scope, but the scope
  itself is still unbuilt (`_studio/images/ImagesTab.tsx:157-166`, blocked on the Owner, zero
  Shopify image rows platform-wide per inventory §20) — so the column renders `—` honestly there.
- **Amazon's markets are ONE destination.** `destinationOf` already collapses them; the planner must
  keep saying so, and (see §9 Q3) should offer them as one card by default.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance**: reuses `renderers/provenance.ts` — no image-specific vocabulary. A copy turns a
  cell from `🔗 inherited` to `✎ pinned`, which is the same transition a pinned attribute makes.
- **Autosave**: every copy is a server write reported through `useSaveReporter`; nothing is staged
  in the browser. The old `discardPending` has no counterpart and needs none — the undo is the
  restore point (`useRestorePoints`), which is where the studio already puts reversal.
- **Readiness**: the `Images` column must feed **one** definition. `readiness.service.ts` has zero
  image signals today; adding a `channel-images` validator there (rather than a second rule in the
  images lane) is the only way the scope chip, the sheet column and the planner can agree. Row
  vocabulary stays `ready|missing|errors|live|unlisted` (`renderers/readiness.ts:31`) — a missing
  MAIN is `errors`, a thin gallery is `missing`.
- **Publish**: the planner is the only image-publish door and it is preflight-first. The mode comes
  from the server (`/listings/publish-readiness`), never from the browser. **Until the eBay and
  Shopify image paths honour their gates (defect 1), the planner must refuse those targets outright
  with the reason on screen** — not label them "Rehearse".

### 6.6 Mockup — the planner on the Images tab (H8), same body in the H10 modal

```
┌ Publish images to several places ─────────────────── 16 possible targets ─ [Hide] ┐
│ 6 targets, but only 3 destinations — some of them overwrite each other.           │
│ ⚠ IT, DE, ES all write the same set of pictures on AMAZON. They run in order and  │
│   whichever finishes last is what Amazon keeps.                                   │
│                                                                                   │
│ ☑ AMAZON · IT   6/7 · MAIN ✓ · 2 pinned            [ready]                        │
│ ☑ AMAZON · DE   6/7 · MAIN ✓ · 2 from all-markets  [ready]                        │
│ ☑ AMAZON · ES   7/7 · MAIN ✓ · 14 pinned           [ready]                        │
│ ☐ AMAZON · PL   0/7 · no pictures at all           [not offered]                  │
│ ☑ EBAY   · IT   4/24 · MAIN ✓                      [gate not honoured — refused]  │
│ ☐ SHOPIFY       — no image rows                    [scope not built]              │
│                                                                                   │
│ Amazon: the Listings API stores images against the ASIN, so choosing a market      │
│ here does not give that market its own pictures. Country-specific images need      │
│ Amazon's Country-Specific Upload; localized text belongs in A+ Content.            │
│ eBay: the image publish path does not read the eBay publish gate, so it cannot be  │
│ rehearsed. Refused here until that is closed (#247).                              │
│                                                                                   │
│ [Send to 3 targets]   The Amazon gate is closed — these 3 are a rehearsal.        │
│ ───────────────────────────────────────────────────────────────────────────────── │
│ AMAZON:IT ✓ Dry run — the channel was not contacted.                             │
│ AMAZON:DE ✓ Dry run — the channel was not contacted.                             │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### The fire path into Errors & Sync (H9)

Today it does not report there at all. `ErrorsSyncConsole.tsx:120,148` reads exactly two endpoints —
`/listings/publish-readiness` and `/api/products/:id/sync-queue` — and the console is
sync-queue-first by ruling #127 because `OutboundSyncQueue` was the only table with data (37,846
rows, 2,553 dead). Image publishes land in **different tables**: `AmazonImageFeedJob` and
`ChannelImagePublishJob` (schema:8201), surfaced by `GET /products/:id/image-publish-jobs`. So the
planner's failures are invisible to the queue console and visible only in the Images tab's own
`PublishHistory.tsx:54`.

**Recommendation:** the console gains a **second source, not a second console** — a `source:
'sync-queue' | 'image-publish'` axis over the same grouping machinery. `syncQueue.ts`'s `causeOf` /
message normaliser (:193-221) is source-agnostic and is the piece worth reusing: an image feed that
retried eleven times must group as one problem, exactly as a queue row does. Each image-publish
group's row action jumps to the Images tab at the failing coordinate (channel + market), the way
queue rows jump to the sheet. The planner's run log stays as the immediate receipt; the console is
where it is still readable tomorrow. A queue must never be inline-only, and right now the image
publish queue is.

## 7. Contracts and data

**Reused unchanged:** the three publish routes; `bulk-save`; `channel-follows`; `publish-readiness`;
`image-publish-jobs` (+ retry); `amazon-images/validate`; `PLATFORM_RULES` in `@nexus/shared`;
`registry.ts` + `menuAdapters` + `ActionConfirm`; `renderers/provenance.ts`, `readiness.ts`,
`mediaCell.ts`.

**Server changes (PES.5, with PES.7 as consumer):**
1. **`ebayPublish` must take a marketplace.** Either accept it in the body or have the studio send
   `?marketplace=`; and `destinationOf` must then key eBay per market truthfully. Until then the
   planner must offer eBay as **one** market-less target (defect 3). *No schema change.*
2. **Return `dryRun` from the eBay and Shopify publish routes**, and accept a caller `dryRun` with
   the Amazon one-way shape (`amazon-batch-feed.service.ts:242-257`) — the #247 remedy, applied to
   the image path. **Owner-gated** (#247 froze those files): the *image* services are not the two
   files #247 named, but the decision is the same one and should ride the same ruling.
3. **`GET /api/products/:id/image-coverage?channel=&market=`** — per-row `{resolved, required,
   hasMain, drift, source: 'master'|'channel'}`, computed server-side from `ListingImage` +
   `ProductImage` + `PLATFORM_RULES`, so the sheet column, the planner cards and the scope chip read
   ONE number. This is the only genuinely new read. Alternatively fold it into
   `studio-sheet.service.ts` as a derived cell on the channel scope — preferable, because a separate
   endpoint is a second definition waiting to drift.
4. **A real copy endpoint.** `copy-scope` needs: a `MASTER` source, a transaction, true overwrite
   semantics, a dedupe key that includes `variantGroupKey/Value` for non-Amazon channels, `locked`
   respected, `role`/MAIN chosen by `isPrimary → type MAIN → sortOrder` (aligning with
   `pickFaceImage`), and a `dryRun` that returns `{wouldAdd, wouldSkip, wouldOverwrite,
   lockedSkipped}` for the verb's preflight. Fixing the existing dead route is cheaper than a new
   one and removes a live footgun.
5. **Image signals in `readiness.service.ts`** so the chip cannot disagree with the column.
6. **Permissions:** put the three publish routes under a matcher that precedes
   `pfx('/api/products')` — `productsImagesEdit` for the copy, and a publish permission for the
   fire. Today `productsEdit` alone fires a marketplace image publish (§3).

**Additive schema only, and probably none is needed** — `ListingImage` already carries `locked`,
`sourceProductImageId`, `publishStatus`; `ChannelImagePublishJob.marketplace` already exists and is
simply never populated for eBay because the planner sends no market.

**Lane ownership:** PES.7 the planner + Images tab + the copy verb's picker · PES.3 the alias-band
CONTEXT verb, the `Images` H2 column and the follow cell · PES.2 the grid substrate if the column
needs a new renderer (it should not — a status cell plus a provenance mark) · PES.1 the header
`Publish ▾` item and the Errors & Sync tab's second source · PES.5 every server item above ·
PES.4 nothing (the drawer's Listings pane may show the coverage read-only).

## 8. Risks and traps

- 🔴 **Live eBay.** Defect 1 means a "rehearsal" from the planner can write production eBay. Every
  eBay listing in the fixture family is live (`reference_ebay_draft_still_live`), local dev hits the
  prod API, and no lane may fire the planner at eBay until #247's remedy reaches the image path.
- 🔴 **Amazon EU is one ASIN.** The five/eleven market targets write one picture set
  (`crossChannel.ts:93-98`, D1). Any UI that lets a market look like its own image destination
  re-creates the defect the module exists to prevent.
- 🔴 **The gate sentence is the surface's most dangerous string.** It is the one place a false green
  is produced by having nothing to look at: `gateOf` returns `null` for an unreported channel
  (`CrossChannelPlanner.tsx:44-56`, deliberately "not reported on" ≠ "closed"), but `anyGateOpen`
  (:120) then reads `false` and the footer prints the reassuring branch. A channel the readiness
  endpoint omits currently reads as safe.
- **Publish modes come from the server, never env, never the browser** (`project_master_sheet_gds4`
  §MS.5). The planner does this correctly and must keep doing it.
- **Untouchables**: the flat-file editors; FBA quantity; the existing import flows. The eBay
  description theme is reached by `ebay-inventory-image-publish.service.ts:302` — an image publish
  re-renders the description. Worth naming on the planner card, and a reason not to fire eBay
  casually.
- **AI stays dark** (#13): `LifestyleGenerator` is adjacent in the Images tab; the planner must
  never trigger generation.
- **No `dryRun` on the copy path either** — a copy is a Nexus-only write, but it writes to the prod
  database from local dev, so the preflight must be a real server `dryRun`, not a client estimate.
- **Approval queue and publish snapshots are localStorage-only** in the old tab. If the planner is
  the only publish door, the approval gate (`ImagesTab.tsx:384-415`) disappears with it unless it is
  re-homed server-side. Triage the FEATURE, not the storage (audit protocol).

## 9. Open questions for the Owner (3)

1. **The planner's fire path is currently a false rehearsal for eBay and Shopify (defect 1, extends
   ruling #247 to the image publish routes). Do we close those gates now, or does the planner refuse
   both channels until then?**
   *Recommended:* refuse them on screen with the reason **now** (PES.7, one edit, no server change),
   and close the gates as the #247 remedy in PES.5's session once you rule. Refusing is reversible;
   a live eBay write is not.
2. **Is "Master images → a channel" an inheritance flag or a copy?**
   *Recommended:* the flag is the resting state (`followMasterImages`, already on every listing and
   already on the sheet's follow flags), and the copy exists only to DIVERGE. But the flag is read
   by zero image services today (defect 8), so it must be made load-bearing in the publish path
   before the cell can claim it means anything — otherwise the honest choice is to hide the flag and
   offer only the copy.
3. **Amazon's eleven declared markets are one destination. Should the planner offer them as ONE
   card by default?**
   *Recommended:* yes — one "Amazon · ASIN (11 markets)" card, expandable to the market list, with
   the per-market model kept for TEXT (D1's real requirement). Sixteen cards that collapse to three
   destinations makes the operator do the arithmetic the module already did.

## 10. Effort and dependencies

| piece | lane | effort |
|---|---|---|
| Refuse ungated eBay/Shopify targets + delete the stale `dryRun` docblocks + send `dryRun` for Amazon | PES.7 | **S** |
| eBay marketplace on the publish call + honest `destinationOf` for eBay | PES.5 + PES.7 | **S** |
| `dryRun` in/out on eBay + Shopify image publish, one-way shape | PES.5 | **M** (Owner-gated, #247) |
| Collapse Amazon markets to one card; preflight coverage on the cards | PES.7 | **M** |
| `Images` H2 column + provenance + follow cell | PES.3 (+PES.5 for the read) | **M** |
| Image signals in `readiness.service.ts` | PES.5 | **M** |
| Copy verb in the registry (preflight + confirm + run), all four surfaces | PES.7 + PES.3 | **M** |
| Fix / revive `copy-scope` (transaction, master source, real overwrite, dedupe key, `locked`, MAIN rule, `dryRun`) | PES.5 | **M** |
| `Publish ▾` → "Images → channels…" | PES.1 | **S** |
| Errors & Sync second source (image-publish jobs through `causeOf`) | PES.1 (+PES.3's `syncQueue.ts`) | **M** |
| Permission matchers for the three publish routes | PES.5 | **S** |
| Re-home the approval gate server-side (if kept) | PES.5 | **L** |

Dependencies: the `Images` column needs the coverage read before it can render anything but `—`;
the planner's per-card validation needs the same read; the copy verb needs the fixed `copy-scope`;
the Shopify column is honest but empty until the Shopify image scope is unblocked (Owner). Nothing
here depends on the Shopify scope being built first. Feature 5.55's parity status and 5.12's should
be written into `docs/pes-parity-audit.md` (currently 0 of 57 rows in section 5 carry a status).
