# 09 — eBay AI-IMPROVE (title/description/aspects rewrite with a selective per-field apply diff)

## 1. What it is

An eBay listing operator, working one (product × marketplace) coordinate, asks the machine to rewrite
the listing's *copy* (title + description) or to *fill the empty item specifics* for the picked
category, in the marketplace's own language. What comes back is not applied: it is shown as a
per-field diff — current on the left, proposal on the right, one checkbox per field — and the
operator ticks the subset they want. It is used at listing-creation time (an eBay category has just
been picked and 20 aspects are empty) and at optimisation time (a listing exists, ranks badly, and
the title is the master's name with no eBay keyword front-loading). Under Owner ruling #13 nothing
generates today; the *review and apply* half of the capability is already built for the master scope
and this report is about giving it an eBay-shaped home, honestly dark.

## 2. Old UI — inventory

**Entry points (two, both in the eBay cockpit tab):**

- `tabs/ebay-cockpit/cards/ListingEssentialsCard.tsx:100-107` — an amber `✦ AI improve` button in the
  card header (`setAiOpen(true)`), opening `operation="essentials"`.
- `tabs/ebay-cockpit/cards/AspectsCard.tsx:38,360` — the same modal with `operation="aspects"`.
- Third operation, different consumer: `cards/CompatibilityCard.tsx:146` calls the SAME endpoint with
  `operation: 'compatibility'` and renders its own diff (parity row 7.7 — out of scope here).

**The component:** `tabs/ebay-cockpit/ai/AiImproveModal.tsx` (342 lines, hand-rolled Tailwind, no DS
import at all).

- `:72-110` — fetch on open, `POST /api/ebay/cockpit/ai-improve`, body `{ operation, productId,
  marketplace }`.
- `:92-101` — default keep-set: essentials keeps whatever *differs*; aspects keeps *everything*.
- `:113-120` / `:147` — hand-rolled ESC handler and backdrop click; no focus trap, no DS `Modal`.
- `:124-138` — `handleApply` builds the ticked subset and hands it to the parent; the modal never
  writes anything itself.
- `:295-341` — `DiffRow`: label + checkbox + `Current` / `AI suggestion` panes, `grid-cols-2` for the
  title, one column for the description. `disabled` when unchanged.
- `:189-195` — a green `projectedUplift` banner ("+12% est. CTR") with the model's own `rationale`.

**Where "apply" actually lands — browser-local, both operations:**

- essentials → `ListingEssentialsCard.tsx:216-232` → `fsCtx.applySwitch(\`${marketplace}.title\`,
  'ai', next.title)`. The Field Source store persists to **localStorage**
  (`field-source/FieldSourceProvider.tsx:51,63`; its own header comment at `:10` says "Persistence:
  localStorage during EC.2"). Nothing round-trips.
- aspects → `AspectsCard.tsx:372-375` → `setDirtyValues((d) => ({...d, ...next}))`, a dirty buffer
  that needs a second explicit **Save aspects** press (`AspectsCard.tsx:349-356`) before any server
  sees it.

**Dead / dishonest in the old tree:**

- `ListingEssentialsCard.tsx:69,119,126` — the per-field source picker offers an `'ai'` source whose
  resolver is `fakeAiTitle()`, a deterministic string stub. The card's own footnote (`:250-253`)
  admits it: *"Per-field AI source is stubbed (deterministic); card-level AI improve calls the real
  Claude assistant."* Two things called "AI" in one card, one of them fake.
- The route's contract block (`ebay-cockpit.routes.ts:1305-1310`) documents a body field
  `current: { title, description, … }`. **Neither caller sends it** and the handler re-reads from
  Prisma (`:1350-1354`) — a doc describing code that never shipped.
- No tests: `find apps/web/src -name '*AiImprove*'` returns the component and nothing else.

## 3. Backend that exists

**Route:** `POST /api/ebay/cockpit/ai-improve` — `apps/api/src/routes/ebay-cockpit.routes.ts:1275`
(handler to `:1558`), registered `apps/api/src/index.ts:694` with prefix `/api`.
`config.rateLimit: { max: 12, timeWindow: '1 minute' }` (`:1276`).

Three operations in one handler:

- **essentials** `:1332-1370` — prompt built inline (`:1355-1379` of the block: 80-char title rule,
  200–1500-char description, per-marketplace language map `LANG` at `:1326`, and a hardcoded brand
  voice — *"Match Italian motorcycle gear ecommerce voice (the brand is Xavia)"*). Returns
  `{ operation, title, description, rationale, projectedUplift, usage }`.
- **compatibility** `:1384-1434` — motors fitments, gated on a regex over category/type/name.
- **aspects** `:1436-1508` — needs a picked category (`409` at `:1437` otherwise), reads
  `ebayCategoryService.getCategoryAspectsRich(categoryId, marketplace, { throwOnError: false })`,
  builds ids as **`aspect_${a.name.replace(/\s+/g,'_')}`** — i.e. the *localised* name (`:1247` of
  the block) — with `englishName` only in the human label.

**Gates on it:** `isAiKillSwitchOn()` → 503 (`:1288`); `getProvider('anthropic')` → 500 (`:1291`);
`resolveModelForFeature('ebay-cockpit', provider)` (`:1295`), whose catalog entry is
`services/ai/ai-features.ts:99`. There is **no** `checkBudget`, **no** `dryRun`, **no** cost
estimate, **no** persistence and **no** audit row (`grep -n 'checkBudget|budget' ebay-cockpit.routes.ts`
→ empty).

**Permission — the defect:** `permissions-manifest.ts` resolves by first matching prefix. The eBay
entries are `:142 pfx('/api/ebay/auth')`, `:276 pfx('/api/ebay/orders')`,
`:339 pfx('/api/ebay/flat-file')`, then `:354 RW(F.listingsView, F.channelsSync, pfx('/api/ebay'))`.
Nothing matches `/api/ebay/cockpit`, so a POST resolves **`channels.sync`** — a money-spending AI
route gated on a catalogue/sync permission, the same family as the manifest's own warning at
`:405-415` about `/api/products-ai/bulk-generate`.

**What the studio lane uses instead (all live, registered `index.ts:785-786`):**

| method + path | file:line | permission |
|---|---|---|
| `POST /api/ai/product-enrichment/estimate` | `routes/product-enrichment.routes.ts:76` | `ai.run` (POST under `:157 pfx('/api/ai/')`) |
| `POST /api/ai/product-enrichment/generate` | `product-enrichment.routes.ts:104` | `ai.run` |
| `GET /api/products/ai/drafts` | `product-enrichment.routes.ts:135` | `products.view` |
| `POST /api/products/ai/drafts/approve` | `product-enrichment.routes.ts:189` | `products.edit` |
| `POST /api/products/ai/drafts/reject` | `product-enrichment.routes.ts:205` | `products.edit` |
| `GET /api/ai/providers` → `{ killSwitch, providers[] }` | `routes/ai-usage.routes.ts:416,588` | `ai.view` |

Services: `services/ai/enrichment/{generate,draft}.service.ts`, `constraints.ts` (caps from ONE
source, `SheetColumn`), `cell-key.ts`, `validate.ts`, `prompt.ts`, `response.ts`.
Prisma: **`ProductAiDraft`** `packages/database/prisma/schema.prisma:11986-12086` — `cellKey`,
`channel`, `marketplace`, `aliasId` (`@map("aliasLabel")`), `locale`, `market`, `writeField`,
`columnKey`, `draftValue`, `baseValue`, `status`, `confidence`, `rationale`, `capsUsed`,
`violations`, `lastApplyError`, `appliedAuditId`. Plus `AiFeatureModelPref` `:11958`.
No crons touch either path. Zero spend today: no `AiFeatureModelPref` row exists (ruling #13).

## 4. Studio today

**Built and mounted (master scope only):**

- `_studio/ai/useAiDraftLayer.ts:34-88` — one fetch feeds both the cell overlay (`draftFor`,
  ref-reading, stable identity so AG never rebuilds 100 columns) and the View-bar chip.
- `_studio/ai/AiDraftReview.tsx:263-353` — the review surface, grouped by column, per-cell and
  per-column approve/reject, caps and byte counts, staleness, `Approve anyway`.
- `_studio/ai/api.ts:1-12` — **generation is deliberately not exported**: *"a UI that cannot call it
  is a stronger guarantee than a UI that chooses not to."* Same in `index.ts:8-9`.
- Mount: `sheet/master/MasterSheet.tsx:768` (`useAiDraftLayer({ productIds, channel: null, … })`),
  `:830` (`buildMasterColumns({ …, draftFor })`), `:1914`
  (`{chipBar.activeId === 'ai-drafts' && <AiDraftReview … onApplied={reload} />}`).
- Cell substrate: `design-system/grid/renderers/provenance.ts:61-62,170` (`ai`/`aiStale` members),
  `:296-300` (tooltips), `:336-337` (`nds-cell-is-ai-draft`, `-ai-draft-stale`);
  `provenanceMark.tsx:27-28` (`Sparkles` / `SparkleIcon`); tint
  `grid/theme/grid.css:609,612`. Precedence `ai`/`aiStale` above everything but `refused` —
  `docs/2026-09-01-layout-v2-spec.md` §9.6b (`:2145-2175`), implemented `provenance.ts:169-170`.
- 18 unit tests in `_studio/ai/drafts.vitest.test.ts`.

**Not built — the eBay-shaped half:**

- **No AI wiring on any channel scope.** `sheet/channel/ChannelSheet.tsx:1097-1104` classifies with
  `classifyProvenance({ ...withMappingRun(d.values?.[colId], productLevelOnly), refusedReason }, 'channel')`
  — no `aiDrafted`, no `aiStale`. Those two members are structurally unreachable on eBay·IT. The
  channel sheet builds its 97 `columnDefs` inline (`:899`) rather than through a shared factory, so
  this is the *two column builders drift* trap with a name on it.
  `grep -rni 'aiDraft|draftFor' sheet/channel/` → one hit, in a test's list of expected states.
- **No trigger anywhere**, by design (#13).
- **No aspects columns to draft.** `docs/2026-09-04-channel-attribute-model-design.md:57` measured
  *"aspect columns on the eBay·IT sheet: **0**. The 35 columns are 30 master columns + the 5 static
  `ebay_*` registry fields (2 dead)"*, while `:58` measured *23 Italian-keyed aspects per GALE child*
  sitting in `platformAttributes.itemSpecifics`, invisible and uneditable. That doc is APPROVED
  (2026-09-05) and `:196` rules aspect columns keyed by **English** name (`aspect_Brand`), values
  read through `localizedName`, an edit landing in `overrideData.aspect_Features` (`:226`).

**Parity audit:** row **7.6** (`docs/pes-parity-audit.md:426`) — 🔁 SUPERSEDED, *"the per-field
diff-with-selective-apply pattern is exactly what `AiDraftReview` does, generalised … strictly
better on two counts"*, with the ⚠ trigger caveat. Rows **7.1** (`:421`) and **7.3** (`:423`) carry
the same caveat; 7.3 records that the old Amazon AutoFill wrote AI copy straight to `Product`.
Row **7.7** (`:427`) — 🕳 MISSING (compatibility/fitments, needs an Owner decision).

**Rulings that bind:** **#13** (`docs/pes-claims.md:132-139`) — no live generation, no
`AiFeatureModelPref` row, zero spend, *"the generation endpoints stay dark until the Owner asks; the
estimate endpoint's pricing display remains (it spends nothing)"*. **#75** (`:21290-21306`) — the
mount decision: PES.2 hosts `<AiDraftReview/>` in the sheet tab under the active ✦ chip. **#82**
(`:21154-21173`) — the ✦ feature is end-to-end done on the master scope, walked with approve and
reject, `onApplied` declared load-bearing, and *"the wrap temptation, named for every future
mount"*. **#67** (`:21497`) and **#34** (chip registry, `:24670`).

## 5. Defects and slowness

1. **The old route spends money behind `channels.sync`.** `permissions-manifest.ts:354` is the first
   prefix that matches `/api/ebay/cockpit/ai-improve`; there is no `/api/ebay/cockpit` entry.
   — CODE-READ.
2. **No budget gate, no estimate, no audit, no persistence** on the old route
   (`ebay-cockpit.routes.ts:1275-1558`; compare `generate.service.ts:408` `checkBudget` and
   `:24` `estimateCallCostUSD`). A retry loop inside the 12/min limit is unbounded real spend.
   — CODE-READ.
3. **"Apply" means "in this browser".** Essentials land in a localStorage field-source store
   (`FieldSourceProvider.tsx:51,63`); aspects land in a dirty buffer needing a second Save
   (`AspectsCard.tsx:372`). Nothing is audited and nothing survives a different machine.
   — CODE-READ.
4. **A latent double-spend in the modal's effect deps:** `AiImproveModal.tsx:110` lists
   `currentEssentials?.title` and `currentEssentials?.description`, which are the card's live
   `titleState.value` / `descState.value`. Any change to either while `open` re-fires the paid call.
   — CODE-READ (the dependency); HYPOTHESIS (whether it fires in practice).
5. **Aspect keys are the wrong vocabulary for the studio.** The route keys on the *localised* name
   (`aspect_${a.name…}`); the approved channel model keys columns by **English** name
   (`channel-attribute-model-design.md:196`). Old keys cannot be reused as column ids.
   — CODE-READ.
6. **`ai`/`aiStale` unreachable on every channel scope** — `ChannelSheet.tsx:1097-1104` supplies
   neither flag. An eBay draft would exist in the DB and be invisible in the sheet. — CODE-READ.
7. **An eBay channel-scope draft can only ever be title / description / variationTheme.**
   `generate.service.ts:176-182` keeps a channel-scope field only when it starts `amazon_`/`ebay_`;
   `draft.service.ts:94-101,136-144` allows only its own six `CHANNEL_FIELD_TARGET` entries. Aspects
   (`attr_*`) are dropped on a channel scope. — CODE-READ.
8. **🔴 The approve path never sends `target: 'channel'`.** `draft.service.ts:694-703` builds
   `changes: [{ id, field, value }]` plus `marketplaceContexts`, and nothing else.
   `products.routes.ts:1352-1354` routes an `attr_*` change on TARGET, not on the context:
   `isChannelChange = (v) => isCategoryAttrField(v.field) ? v.target === 'channel' : isChannelField(v.field)`.
   So the *first* aspect draft that ever reaches approve will write the **product's** category
   attribute, not the eBay listing's `overrideData` — a wrong-store write that returns 200. It is
   unreachable today only because of item 7; item 7 is the thing this feature has to lift.
   — CODE-READ.
9. **`aliasKey` is never sent either.** `marketplaceContexts[].aliasKey` exists
   (`products.routes.ts:1045-1051`, `''` = primary) and `draft.service.ts:703` omits it; generation
   never sets `aliasId` at all (schema note `:12009`: *"it has never held a value"*). On eBay, where
   the sheet's shape IS the alias band, every draft is silently a draft against the primary listing.
   — CODE-READ.
10. **`AiImproveModal` has zero tests** and no DS usage (342 lines of raw Tailwind incl.
    `text-tertiary`, `border-default`). — CODE-READ.
11. **A channel-scope draft carrying a locale is refused outright** (`draft.service.ts:625-631`) —
    correct, but it means an eBay·IT draft is IT-by-coordinate, never IT-by-locale, and the trigger
    must not offer a locale picker. — CODE-READ.
12. **🔴 The enrichment lane's mirror of `CHANNEL_FIELD_MAP` went out of step DURING this research
    session.** A concurrent lane added `amazon_bulletPoints: 'bulletPointsOverride'` (AM.1) to
    `services/pim/channel-field-map.ts:35` plus a new `FOLLOW_FLAG_FOR_COLUMN` at `:44`.
    `draft.service.ts:89-101` is a hand-written copy whose own comment says *"Kept in step with
    CHANNEL_FIELD_MAP … a field missing here reads as 'no current value', so the staleness check
    would pass a cell it cannot actually see"* — and it now has 6 entries against the map's 7, and
    a value type (`'title' | 'description' | 'variationTheme'`) that cannot express the new target.
    Consequence today is a refusal rather than a wrong write (`isDraftableField:136-144` drops
    `amazon_bulletPoints`, so no such draft can exist), but the mirror is exactly the drift its own
    comment warns about, and the fix is to import the map rather than restate it — it is already a
    dependency-free leaf built for that (`channel-field-map.ts:13-14`). Not eBay-specific; reported
    because it is this feature's contract. — CODE-READ (2026-09-05, mid-session).

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**PRIMARY: H4 — a `SELECTION` verb `Draft with AI…` in the channel lane's action registry**
(`sheet/channel/channelActions.ts`, beside `broadcastToListings` at `:304`). The unit of this feature
is *these rows × these columns*, which is exactly what a selection is; and a selection verb is
declared once and rendered by every adapter, so the trigger cannot drift between the selection bar
and the row menu (`design-system/grid/actions/registry.ts:230-245`). It is declared with a real
`available()` that returns `disabled('Generation is switched off — nothing will be drafted')` from
`GET /api/ai/providers`, so the control explains itself instead of being a grey rectangle
(`registry.ts:50-62`, the disabled-control rule).

**MIRROR 1: H6 — `SheetToolbar` `leading` entry, scope-wide.** `SheetToolbar` already takes
`leading`/`trailing` (`sheet/SheetToolbar.tsx:92-94`, rendered `:150`/`:215`) and the channel scope
already uses `trailing` for `AliasPublishControl` (`ChannelSheet.tsx:1904-1917`). The H6 entry is the
*only* place the capability is described when nothing is selected — the precedent is
`images/publish/ScheduleSurface.tsx:104-107`: *"The form stays visible when execution is off. Hiding
it would remove the only place the capability is described, and an operator would have no way to
learn it exists at all."* Put it in `leading`, left of the chips, because `trailing` is publish.

**MIRROR 2: the review surface stays the H-free **filtered view chip**, NOT a new H7 pane.**
`✦ AI drafts (n)` + `<AiDraftReview/>` under the active chip is already hub-ruled (#75, #82) and
already the right shape: a review reads *down a column* across rows (`drafts.ts:105-151`
`groupByColumn` — *"an operator judging thirty titles judges them against each other"*), and the
drawer is per-record, 520px, and would give the diff a third of the width the description needs.
Wiring it on the channel scope is a mount, not a build.

**MIRROR 3 (thin): H7 — one read-only line in the drawer's Record pane** on a drafted field: the ✦
mark, the proposal, and "Review in the sheet". No approve control there. Approve/reject stay in ONE
place; a decision duplicated in the drawer is the fork the registry exists to prevent.

**NOT H1.** No in-cell "improve this cell" affordance. Double-click EDITS
(`layout-v2-spec.md` §5.5) and AG's fill handle already swallows the double-click
(`reference_ag_fill_handle_swallows_dblclick`); adding a third meaning to a cell gesture on eBay's
description column is how the editor-open gate gets broken again.

### 6.2 What the sheet shows at rest

**Master scope** — unchanged, live today. A drafted cell shows the **proposal**, not the stored
value: `sheet/master/columns.tsx:174-175` — *"A drafted cell SHOWS the proposal; the value underneath
is untouched and still what saves"* — italic on `--nds-grid-ai-draft-bg` (`grid.css:609`) with the
`✦ Sparkles` mark (`provenanceMark.tsx:27`). A **stale** draft swaps to `SparkleIcon` plus a
`--nds-warning` corner triangle (`grid.css:612`, `provenanceMark.tsx:28`). Tooltip is composed
(`columns.tsx:288-297`): the provenance sentence, then `Now: <current value>` or *"The cell is empty
now"*, then `⚠ <violations>`, then *"Not verified against the channel"*. A **failed** draft shows
**nothing at all** in the cell — `drafts.ts:89-98` `toSheetDraft` returns `null` for a non-pending
status, because the server refuses to apply it and a tinted cell would invite an approving click on
a value that cannot land. It appears only in the review list, with the cap it broke.

**eBay·IT channel scope (to build)** — the same three states, on the alias-band rows and the child
SKU rows, over the columns that exist: `ebay_title`, `ebay_description`, plus `aspect_*` once the
approved adapter lands. **At rest with no drafts: nothing.** No extra column, no permanent mark, no
"AI" chip — the chip reports `count: null` while uncounted and hides at a real 0
(`useAiDraftLayer.ts:63-83`; the honesty rule ratified in #67). A **Shopify / WooCommerce / Etsy**
scope shows nothing and the trigger is `hidden`, not `disabled` — those channels have no content
layer, and `generate.service.ts:266-281` already writes the sentence for it.

### 6.3 The interaction, step by step

1. **Open.** Operator ticks rows (or a column header, or a range) on eBay·IT. The selection bar
   shows `Draft with AI…`. With no selection, the H6 toolbar button carries it. Both render
   `disabled` with the reason from `GET /api/ai/providers` → `{ killSwitch, providers[] }`. Keyboard:
   the existing selection-bar traversal; no new shortcut (a shortcut for a dark verb is noise).
2. **Collect** (`PARAMETERISED_VERB_ORDER`, `registry.ts:221`). A DS `Modal` + `MultiSelect` over the
   scope's *draftable* columns — derived, never hardcoded, from the same `SheetColumn` set the
   sheet validates against (`constraints.ts:4-9`). It states the coordinate ("eBay · IT · listing ①")
   and the excluded set with its reason (`constraints.ts:64-79` — identifiers, tax codes, safety
   attestations are never offered).
3. **Preflight.** `POST /api/ai/product-enrichment/estimate` (`dryRun: true`). This is the whole
   reason the dark surface is worth building: it builds every prompt for real and spends nothing
   (`generate.service.ts:374-383` returns before any provider call; ruling #13 explicitly keeps it).
   The `ActionImpact` names the coordinate, the column count, the call count, and the estimated cost.
4. **Confirm.** DS `ActionConfirm` at the level the preflight chose (`registry.ts:68-104` — the
   confirm level comes from the impact, never a flag). Below the buttons, a DS `Banner tone="info"`:
   *"Generation is switched off on this deployment. Nothing will be sent to a model and nothing will
   be drafted."*
5. **Run.** **Refused, honestly, and the refusal is a 200 with its reason** — `generate.service.ts:191-207`
   already returns `{ refusedReason }` rather than an error, precisely so a refusal is a state the UI
   can render. The confirm stays open showing the reason and the estimate it would have cost. The
   sheet does not repaint. Nothing is written.
6. **When the hold lifts** (one component, no re-architecture): `run` calls
   `POST /api/ai/product-enrichment/generate`, the ✦ chip's count moves, cells tint, and the operator
   proceeds through the existing review → approve path.
7. **With the drawer open**: unaffected. The drawer is non-modal and portals into the frame's
   reserved track (`layout-v2-spec.md` §5, `MasterSheet.tsx:1916-1920`); the selection bar and the
   chip-filtered review both live in the sheet column.

### 6.4 Per-scope rules

- **Master**: `channel: null`, `marketplace: 'master'` on the wire (`_studio/ai/api.ts:53-56` — an
  ABSENT channel means "any scope" and a null one means "the master scope", two different questions).
  Drafts master columns and `attr_*`. Live today.
- **eBay × market**: `channel: 'EBAY'`, the market code, `locale` NOT sent (a channel-scope draft
  with a locale is refused server-side, `draft.service.ts:625-631`). The trigger offers no locale.
- **Alias band**: `CONTEXT(alias-group)` is the natural axis for "draft this listing", but
  **aliasId is unbuilt end to end** (never set on generate, never sent on approve). Recommendation:
  v1 declares the verb `SELECTION` only, and the collect step **states which listing it targets**
  ("the primary listing") rather than implying per-alias drafting it cannot do. Per-alias drafting is
  a PES.5 + PES.8 pair (`aliasId` on the run, `aliasKey` on the approve), not a UI change.
- **Amazon × market**: identical mechanics, different columns. Nothing eBay-specific in the trigger.
- **Single-store channels (Shopify / Woo / Etsy)**: verb `hidden`; the server's own sentence is the
  copy.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance.** ONE vocabulary, extended not forked (ruling #11). PES.3 supplies `aiDrafted` /
  `aiStale` into the object it already hands `classifyProvenance` at `ChannelSheet.tsx:1101`; PES.2's
  classifier, marks, tints and precedence are untouched. `ai` outranks `mapped` / `mappedShared` /
  `inherited` / `pinned` and is outranked only by `refused` (§9.6b; `provenance.ts:169-170`) — on
  eBay·IT, where 33 of 35 columns are the shared master's (`ChannelSheet.tsx:1860-1874`), a drafted
  cell must read as *awaiting a decision* first and *inherited* second.
- **Autosave.** A draft is NOT a save. It is a `ProductAiDraft` row; the stored cell is untouched and
  the sheet's own `SheetWriter` is uninvolved. Approve replays through `PATCH /api/products/bulk`
  server-side (`draft.service.ts:724-732`, `app.inject` so the RBAC preHandler and the audit row are
  the same as a typed edit). **`onApplied` must reload the rows** — `MasterSheet.tsx:1908-1912` and
  ruling #82 both spell out why: without it the tint clears over the pre-approval value.
- **Readiness.** Unchanged. A pending draft must never count toward readiness — the cell is still
  empty as far as the channel is concerned, and `readiness.service.ts` is the ONE definition. The
  overlay's `stale`/`unverified` states come from the server (`draft.service.ts:647-661`), never
  re-derived client-side.
- **Publish.** Untouched. Approve writes to `ChannelListing`; publishing it is the existing explicit,
  preflight-first, per-channel path with the mode from `getEbayPublishMode()`
  (`services/ebay-publish-gate.service.ts`, `index.ts:1780`). Nothing in this feature can reach eBay.
- **Wrong-store fix (must land with the aspects half, ruling: producer + consumer in ONE write):**
  `draft.service.ts:694-703` must send `target: 'channel'` for an `attr_*` draft whose address has a
  channel, and `aliasKey` when the address names an alias. Without it the first aspect approval
  writes the master's category attribute and returns 200 (defect 8).

### 6.6 ASCII mockup — the primary surface

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ 21 rows · 3 selected  [View ▾][⚠ Missing required (7)][✦ AI drafts (—)]  Find…       │
│ ⟨leading⟩ [✦ Draft with AI…]                        [Customise][Export ▾][Reload]   │  H6, disabled
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ▾ ★ Listing ① · GALE Pro Racing Suit · eBay·IT · Active            [Publish ▾]       │
│   SKU              ebay_title                    ebay_description      Marca         │
│ ☑ GALE-KAN-PRO-M   🔗 GALE Pro Racing Suit       🔗 Tuta racing…       🔗 Xavia      │
│ ☑ GALE-KAN-PRO-L   ✎ Tuta Racing GALE Pro …      ✎ Protezione CE…      🔗 Xavia      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ▸ 3 selected   [✦ Draft with AI…]  [Broadcast to other markets…]  [Open record]      │  H4 selection bar
│                 └─ disabled: "Generation is switched off — nothing will be drafted"  │
└──────────────────────────────────────────────────────────────────────────────────────┘

Collect + preflight (DS Modal), on press:                    Once drafts exist (chip active):
┌────────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
│ ✦ Draft with AI — eBay · IT · listing ★    │   │ ✦ AI drafts   2 awaiting review          │
│ Columns  [ebay_title ×][ebay_description ×]│   │ ── ebay_title · 80 chars · eBay·IT ──────│
│ Excluded  GTIN, country_of_origin — claims │   │  Current            │ ✦ AI draft         │
│           of record, never drafted         │   │  GALE Pro Racing …  │ Tuta Racing GALE…  │
│ 3 rows × 2 columns = 6 calls · ~$0.04 est. │   │  78/80 chars · high confidence           │
│ ⓘ Generation is switched off on this       │   │            [Approve]  [Reject]           │
│   deployment. Nothing will be sent to a    │   │  [Approve 1]  [Reject all]               │
│   model and nothing will be drafted.       │   └──────────────────────────────────────────┘
│                     [Cancel] [Draft ▸]     │      (AiDraftReview, unchanged, mounted
└────────────────────────────────────────────┘       under the active chip — ruling #75)
```

## 7. Contracts and data

**Reused unchanged:** `GET /api/products/ai/drafts`, `POST …/approve`, `POST …/reject`,
`POST /api/ai/product-enrichment/estimate`, `GET /api/ai/providers`, `ProductAiDraft`,
`_studio/ai/**` in its entirety, `classifyProvenance` + `ProvenanceMark` + the two cell classes.

**Server changes (all additive):**

| change | file | lane |
|---|---|---|
| send `target: 'channel'` for a channel-scope `attr_*` draft; send `aliasKey` when the address names an alias | `draft.service.ts:694-703` | **PES.8** |
| widen `applicableConstraints` so a channel scope keeps `attr_*` whose column is channel-owned (currently `startsWith('ebay_')` only) | `generate.service.ts:176-182` | **PES.8** |
| widen `isDraftableField` in step with it | `draft.service.ts:136-144` | **PES.8** |
| replace the hand-written `CHANNEL_FIELD_TARGET` copy with an import of `channel-field-map.ts` (defect 12) | `draft.service.ts:94-101` | **PES.8** |
| add a `/api/ebay/cockpit` manifest entry so the OLD route resolves `ai.run`, not `channels.sync` (or retire the route with the old tab) | `permissions-manifest.ts` ~`:354` | **PES.5** |
| eBay aspect columns (`aspect_<English>`, `channelLabel` = localised, `overrideData.aspect_*`) | the approved `ChannelFieldSpec` adapter | **PES.6 / PES.3** |

**Client changes:** the `useAiDraftLayer` mount + `aiDrafted`/`aiStale` into the classifier call
(**PES.3**, `ChannelSheet.tsx:1097-1104` and the cell renderer beside it); the `Draft with AI…` verb
declaration (**PES.3**, `channelActions.ts`); the collect/preflight modal (**PES.8**); the H6
`leading` slot entry (**PES.3**); the drawer's read-only ✦ line (**PES.4**). No new DS component is
needed — `Modal`, `MultiSelect`, `Banner`, `Button`, `ActionConfirm` and the registry adapters cover
it. **No schema change** for the eBay path: `ProductAiDraft` already carries `channel`,
`marketplace`, `aliasId`, `market`, `capsUsed` and `violations`.

## 8. Risks and traps

- **AI DARK is the constraint, not a caveat (#13).** Nothing in the proposal calls
  `.../generate`; `_studio/ai/api.ts` must keep not exporting it. No `AiFeatureModelPref` row, no
  model choice, no `NEXUS_AI_KILL_SWITCH` change.
- **The old route is live and reachable right now**, at 12 requests/minute, with no budget gate and
  the wrong permission. Any local dev session hitting it spends real Anthropic money against the
  production key (`reference_local_dev_hits_prod_api`).
- **Every eBay listing in the fixture family is LIVE.** Approve writes `ChannelListing.title` /
  `.description` through the audited bulk PATCH; that is a real catalogue value even though it
  publishes nothing (`reference_ebay_draft_still_live` — a draft/unpublished row is still live).
  Verification must use seeded fixtures and tear them down, as #82 did.
- **The wrong-store write (defect 8) is a silent 200.** It must land in the same write as the aspects
  columns, never after them (`feedback_producer_and_consumer_land_together`).
- **33 of 35 eBay·IT columns write the shared master record** (`ChannelSheet.tsx:1860-1874`). A
  draft on one of those is a draft on every channel's value, and the collect step must say so in the
  same words the toolbar already uses.
- **`aspect_*` keys are not `attr_*` keys.** The old localised ids and the approved English ids are
  different vocabularies; nothing may be carried across.
- **Untouchable:** the eBay flat-file editors. The eBay cockpit tab is old-tree *specification* — do
  not wrap `AiImproveModal`, and resist wrapping `AiDraftReview` in the channel sheet's chrome
  (ruling #82's named "wrap temptation").
- Not in play: per-channel oversell, Amazon shared-EU quantity, global-per-ASIN images.

## 9. Open questions for the Owner (3)

1. **Do the eBay ASPECTS get a draftable surface in v1, or only title + description?** Aspects need
   the approved channel-attribute adapter (PES.6), the `target: 'channel'` fix (PES.8) and the
   widened filter — three lanes — while title/description work the moment the mount lands.
   **Recommendation: ship title + description with the eBay scope's AI wiring now, and let aspects
   arrive with the aspect columns.** Half of 7.6 with an honest boundary beats a trigger that offers
   20 aspect columns which do not exist yet.
2. **Does the dark trigger show a COST ESTIMATE?** Ruling #13 kept the estimate endpoint explicitly
   because it spends nothing. **Recommendation: yes.** It is the only thing that makes the dark
   surface worth building — the operator sees exactly what a run would cost, and the refusal sits
   under a real number rather than under a placeholder.
3. **Is `POST /api/ebay/cockpit/ai-improve` retired with the old tab, or re-gated to `ai.run` now?**
   It is live, reachable, unbudgeted and gated on `channels.sync`. **Recommendation: re-gate it now**
   (one manifest line, PES.5) rather than wait for the swap — the studio's rebuild does not close a
   hole in a route the old tab still calls.

## 10. Effort and dependencies

| piece | effort | depends on |
|---|---|---|
| `useAiDraftLayer` mount + `aiDrafted`/`aiStale` into `ChannelSheet`'s classifier and renderer | **S** | nothing — PES.3, ~2 sites |
| `<AiDraftReview/>` under the channel scope's ✦ chip (+ `onApplied={reload}`) | **S** | the mount above |
| `Draft with AI…` SELECTION verb, dark, with the availability reason from `GET /api/ai/providers` | **S** | the action registry (built) |
| H6 `leading` toolbar entry | **S** | `SheetToolbar.leading` (built) |
| collect + preflight modal (column picker, estimate, honest-off banner) | **M** | `POST …/estimate` (built) |
| `permissions-manifest` entry for `/api/ebay/cockpit` | **S** | PES.5 |
| `target: 'channel'` + `aliasKey` on approve; widened channel filter | **M** | PES.8, and must ship WITH the aspect columns |
| eBay `aspect_<English>` columns end to end | **L** | PES.6 adapter + PES.3 shapes — the approved 2026-09-04 design |
| per-alias drafting (`aliasId` on run, `aliasKey` on approve) | **M** | PES.5 alias contract + PES.8 |
| drawer's read-only ✦ line | **S** | PES.4 |
| compatibility / fitments (row 7.7) | — | **out of scope**, needs an Owner decision at swap |
