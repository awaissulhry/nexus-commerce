# 08 — eBay COMPATIBILITY / motors fitments

## 1. What it is (operator terms)

eBay Motors lets a buyer filter parts and gear by their bike ("show me what fits my 2020 Ducati
Panigale V4"). To appear in that filter a listing must declare either **universal fit** ("fits every
motorcycle") or an explicit **fitment list** — one row per vehicle: year / make / model / submodel
(cars add trim + engine). The operator who touches this is the person filing a motors listing: they
pick the eBay category, then decide "is this gear universal, or does it only fit these bikes?", and
if the latter they type or paste tens to hundreds of vehicle rows. It is a **per-listing** decision
made once and revisited rarely — but when it is wrong the listing is invisible to the entire
vehicle-search funnel, which is how most motors buyers shop. Today the surface is one card in the
eBay cockpit; in the studio it has no surface at all (parity 3.46 / 7.7 both 🕳).

## 2. Old UI — inventory

**Entry point.** `tabs/ebay-cockpit/EbayCockpit.tsx:69` (import) → `:652` mount, inside
`CockpitCardGrid`, after `FulfillmentMethodCard`. Initial value derived inline at
`EbayCockpit.tsx:660-679` from `listing.platformAttributes.compatibility`, defaulting to
`{universal: true, fitments: [], updatedAt: null}`. **Not dead** — the importer is real.

**Component.** `tabs/ebay-cockpit/cards/CompatibilityCard.tsx` (478 lines, one file, three
components).

| interaction | file:line | round-trip? |
|---|---|---|
| motors gate — card collapses to a "not motors" hint unless a keyword matches | `:63-67`, `:206-219` | browser-local (regex over category name/path + product name/type) |
| `Universal fit` checkbox | `:252-262` | local state until Save |
| Add fitment row | `:97-99`, `:274-281` | local |
| Per-row year/make/model/submodel inputs + delete | `FitmentRow` `:367-425` | local |
| Bulk paste (CSV or "2020 Ducati Panigale V4" whitespace lines) | `handleBulkApply :109-139`, `BulkPasteModal :427-478` | local, parsed in the browser |
| **AI suggest** → `POST /api/ebay/cockpit/ai-improve {operation:'compatibility'}` | `:141-174` (fetch `:146`) | **server, LIVE Anthropic call** |
| **Save** → `PATCH /api/ebay/cockpit/compatibility` then `router.refresh()` | `:176-203` (fetch `:181`, refresh `:197`) | server |
| 1000-row cap + "near cap" hint | `FITMENT_CAP :35`, slice `:136`, hint `:231-235` | local |

No localStorage anywhere. No autosave — an explicit `Save` button gated on `isDirty` (`:87-95`).
Nothing else in the old tree carries fitment: **neither flat-file editor mentions it** (grepped
`apps/web/src/app/products/{ebay,amazon}-flat-file/**` — zero hits), so there is no untouchable
overlap. The Amazon cockpit's `fit/FitCompatibilityCard.tsx:1-58` has a *read-only* `fitment` mode
over `compatible_vehicle / make / model / vehicle_year / part_finder` — parity row 3.28, a
different agent's row, but see §7 for why it matters.

## 3. Backend that exists

**Routes** (all `apps/api/src/routes/ebay-cockpit.routes.ts`):

- `PATCH /api/ebay/cockpit/compatibility` — declared `:1516`, path `:1528`. Loads the listing with
  `prisma.channelListing.findFirst({productId, channel:'EBAY', marketplace})` `:1538-1540`; 409s if
  none ("pick a category first"); cleans rows `:1546-1557` (requires year **and** make **and**
  model, `.slice(0, 1000)`); merges `platformAttributes.compatibility = {universal, fitments,
  updatedAt}` `:1558-1571`; returns `{listingId, universal, fitmentCount}`.
- `POST /api/ebay/cockpit/ai-improve` — declared `:1269`, path `:1275`, rate-limited 12/min.
  `operation:'compatibility'` branch `:1373-1421`: a *second* motors regex `:1374`, then a real
  `provider.generate()` against Anthropic (`feature:'ebay-cockpit-ai-improve-compatibility'`
  `:1408`). Gated only by `isAiKillSwitchOn()` `:1291`. **This spends money today.**
- `POST /api/ebay/cockpit/publish` — `:1171` builds `EbayPublishAdapter`, passing
  `compatibility: platform.compatibility` `:1196-1199` (comment: "B1 — send the captured eBay Motors
  fitment (was persisted but dropped)").
- `GET /api/ebay/cockpit/template-candidates` — reports `hasCompatibility: !!p.compatibility &&
  typeof p.compatibility === 'object'` `:1669-1670`.
- `POST /api/ebay/cockpit/template-apply` — `:1692`, path `:1706`. Flags at `:1719-1725`:
  **`compatibility: scope.compatibility !== false` — opt-OUT, ON by default**; copies the donor's
  object onto up to 200 targets `:1761-1763`.

**Service.** `services/listing-wizard/ebay-publish.adapter.ts`:
- `EbayPayload.compatibility` `:140-148`; `EbayPublishResult.compatibilityWarning` `:105-107`.
- `buildEbayCompatibilityBody()` `:217-241` — pure, unit-tested
  (`ebay-publish.adapter.vitest.test.ts:13-59`). Returns `null` for universal or empty. Property
  names **hardcoded** `Year / Make / Model / Submodel` `:229-233`; needs make+model (looser than the
  PATCH route's year+make+model).
- Publish step 1b `:481-510`: `PUT {apiBase}/sell/inventory/v1/inventory_item/{sku}/product_compatibility`
  `:492-494`. Soft-fail: sets `compatibilityWarning` and `logger.warn`s, never blocks.

**Prisma.** No fitment table. Storage is `ChannelListing.platformAttributes` (Json,
`schema.prisma:1493`) at key `compatibility`. `ChannelListing` is unique on
`[productId, channel, marketplace, channelConnectionId, aliasKey]` (`:1700`, `aliasKey` `:1685`), and
`ProductListingAlias` (`:1732`) means **one ChannelListing row per family member × alias × account** —
see §5.1.

**External calls / gates.** Only the Inventory API `product_compatibility` PUT above, reached from
the cockpit publish path, which is itself behind `getEbayPublishMode()`
(`ebay-publish-gate.service.ts:40-46`: `gated` → `dry-run` default → `sandbox` → `live`).
`getEbayApiBaseForMode` returns `''` for gated/dry-run so a stray fetch fails loudly (`:58-62`).
**No jobs or crons touch fitment.**

**Permissions** (`lib/auth/permissions-manifest.ts`): both compatibility endpoints fall through to
`RW(F.listingsView, F.channelsSync, pfx('/api/ebay'))` `:354` → a write needs **`channels.sync`**.
The studio's own writes go through `/api/products/**` → `RW(F.productsView, F.productsEdit)` `:412`
→ **`products.edit`**. Moving fitment onto a studio endpoint therefore *changes which role can edit
it*; that is a decision, not an implementation detail (§7).

## 4. Studio today

**Nothing.** `grep -rniE 'compatib|fitment' _studio/**` returns one unrelated hit
(`sheet/master/columns.tsx:477`, a comment about the DS Listbox). Parity audit:

- **3.46** — `| 3.46 | [W] CompatibilityCard (motors fitments, AI improve) → POST
  /api/ebay/cockpit/compatibility | cards/CompatibilityCard.tsx:146,181 | 🕳 — no motors
  fitment/compatibility surface. |` (`docs/pes-parity-audit.md:172`). *The audit says POST; the code
  is PATCH (`:1516`) — a small doc error worth fixing when the row is claimed.*
- **7.7** — 🕳 MISSING, `docs/pes-parity-audit.md:427`: *"compatibility/fitments is a distinct data
  domain (vehicle fitment rows), not a sheet cell; nothing in `_studio/**` covers it … Out of the
  enrichment lane's shape. Needs an owner decision at swap time."*

**Hub rulings that bind it:**
- **#110** (D1 DECIDED, `docs/pes-claims.md:20431-20456`) — the three-legged hybrid. Drawer panes =
  depth **"full-screen escalation for fitment/aspects"** `:20434`; and fitment is explicitly
  **WAVE 2, queued not dispatched** `:20450-20452`. So the *shape* is already ruled; only the
  detail is open.
- **#109** (`:20466`) and `docs/2026-09-01-channel-ops-research.md:72-74` — structured sub-editors
  (incl. fitment) are drawer panes with full-screen escalation *per Carbon's majority-of-fields
  rule* (`:48-49`: side panel when main-view context helps and fields overflow a modal; full page
  when the majority of fields are needed at once).
- **#13** (`docs/pes-claims.md:132-139`) — no live AI generation. `_studio/ai/api.ts` exports
  `loadDrafts/approveDrafts/rejectDrafts` and deliberately no generate (`:6`).
- **#85** — an AI row is ✅ only when *"the control is built and dark"*
  (`docs/pes-parity-audit.md:22-23`).
- **AM.1 approved 2026-09-05** (`docs/2026-09-04-channel-attribute-model-design.md`) — four shapes,
  `FieldShape = 'scalar' | 'list' | 'measure'` + compound flattened to leaves
  (`services/pim/channel-specs/types.ts:32`), and **no exclusions** (§A.3a, doc `:168-176`).
  A repeating table of objects has **no shape**: the doc's own census counts **178
  multi-sub-property** Amazon properties as unmodelled (`:50`).

Substrate that already exists and matters:
- `design-system/grid/hosts/GridCard.tsx:10-13` — **`GridPanel`, "a MODAL / DRAWER host: the same
  card, but the grid inside is bounded (the caller passes `height`) … The inventory editor is the
  reference … capped at 480."** Already used inside a studio drawer:
  `_studio/import/ImportDrawer.tsx:35,463-472` hosts a `NexusGrid` in a `GridPanel` in a DS `Drawer`.
  **A grid-in-a-drawer-pane is a proven pattern, not a new one.**
- `drawer/RecordDrawer.tsx:471-480` — four panes declared as a plain array fed to DS `Tabs`; a fifth
  is additive.
- `sheet/channel/ChannelSheet.tsx:1093` — a band row (`rowKind:'parent'`) already resolves cells at
  `layer:'alias'`, variants at `aliasVariant`. **A listing-level column already has a home.**
- `design-system/grid/actions/registry.ts:33-42` — `ContextAxis = 'product-family' | 'alias-group'`.
  `channelActions.ts` declares only `offer-toggle` (ROW), `broadcast-to-listings` (SELECTION),
  `open-record` (ROW) — **no `alias-group` verb exists yet**, and `AliasBandCell.tsx:57-60` says a
  declared one "appears here without touching this file".
- `components/Modal.tsx:26` — `size?: Size | 'xxl' | 'full'`; CSS `styles/components.css:355-387`:
  `xl` 920px, **`xxl` 1040px, commented "for modals holding a table"**, `full`
  `min(1680px,96vw)/94vh` but commented **"A MEDIA surface, not a dialog … the body … must not add
  padding"** with `padding:0; overflow:hidden`.

## 5. Defects and slowness

**5.1 — the write picks an arbitrary listing among N (CODE-READ, worst one).**
`routes/ebay-cockpit.routes.ts:1538-1540` does `findFirst({productId, channel:'EBAY', marketplace})`
with no `aliasKey` and no `channelConnectionId`, while the DB unique is
`[productId, channel, marketplace, channelConnectionId, aliasKey]` (`schema.prisma:1700`) and
`ProductListingAlias` exists precisely so one product can hold several eBay listings per market
(`:1732-1745`). A product with two eBay·IT aliases, or one child row plus one parent row, gets its
fitment written to whichever row Postgres returns first — and read back by
`EbayCockpit.tsx:660` from a `listing` the page resolved separately. `template-apply` repeats the
same `findFirst` for the donor (`:1728-1730`).

**5.2 — the motors gate is a keyword regex, duplicated, and the two copies have drifted (CODE-READ).**
Card `:66`: `/\b(helmet|casco|jacket|giacca|giubbotto|glove|guanto|guanti|boot|stivali|stivale|motor|moto)\b/`.
Route `:1374`: `/helmet|casco|jacket|giacca|giubbotto|glove|guanto|boot|stivali|motor|moto/i`.
The card has `guanti`/`stivale` extra **and word boundaries the route lacks** — so `\bglove\b` fails
on "Gloves" and `\bmotor\b` fails on "Motorcycle", while the route matches both as substrings. On an
English plural category name the card hides itself and the AI endpoint still suggests fitment. The
inputs differ too: the card also reads `categoryPath` (`:75`), the route does not (`:1374`). Nothing
in either copy asks eBay whether the category supports fitment at all.

**5.3 — silent truncation + a permanently-dirty card (CODE-READ).** The route drops any row missing
year/make/model and slices at 1000 (`:1546-1557`) and reports only `fitmentCount`. The card keeps its
own state (`useState(props.initial.fitments)` `:80` — initialised once, never re-synced) but
recomputes `initialJson` from the *new* props (`:87-90`). After a save that dropped rows, `initialJson`
(server-cleaned) ≠ `currentJson` (stale local) → **the footer reads "unsaved changes" forever** and
the operator cannot tell which rows were discarded.

**5.4 — `compatibilityWarning` has zero consumers (CODE-READ).** Set at
`ebay-publish.adapter.ts:500,507`, returned at `:741`, and
`grep -rn 'compatibilityWarning' --include='*.ts*' .` finds **no reader outside the adapter**. When
eBay rejects the fitment PUT the listing publishes silently without fitment; the operator is never
told, and nothing reaches the sync queue the Errors & Sync console reads.

**5.5 — fitment reaches only ONE of the eBay push paths (CODE-READ).** Only the cockpit publish
route passes it. `services/ebay-variation-push.service.ts`, `ebay-shared-listing-push.service.ts`,
`ebay-feed.service.ts`, `ebay-flat-file-create.service.ts` and `listing-wizard/channel-publish.service.ts`
contain **no occurrence of `compat`/`fitment`** (grepped). The studio's own
`POST /products/sheet/publish-preview` (`routes/products-sheet.routes.ts:113`) and
`services/pim/payload-preview.ts` likewise. So the family-aware/shared-SKU path — the one
`ebay-push-mode.ts:1-18` says is forced for every shared row — drops fitment entirely.

**5.6 — the property names are hardcoded and there is no `Engine`/`Trim` (CODE-READ).**
`buildEbayCompatibilityBody` emits exactly `Year/Make/Model/Submodel` (`:229-233`). eBay's Taxonomy
`get_compatibility_properties` (which returns the per-category property set — cars need Trim +
Engine) is **not implemented anywhere**: `grep -rniE 'compatibility_propert|compatibility-propert|get_compatibility'`
over the whole repo returns nothing. `CategorySchema` (`schema.prisma:7241-7267`) has no
compatibility field. So today the model cannot express a car fitment at all, and cannot know whether
a category wants one.

**5.7 — `hasCompatibility` is a presence-of-object check (CODE-READ).**
`routes:1669-1670` reports `true` for `{universal:false, fitments:[]}` — the empty state. Any UI
built on it would state "has fitment" about a listing with none, which is exactly what
`feedback_100_percent_honest_ui` and the studio's own chip rule forbid.

**5.8 — the AI suggest destroys operator work with no review (CODE-READ).** `:157-168`
`setUniversal(json.universal)` and `setFitments(cleaned.slice(...))` — a wholesale replacement of
whatever the operator typed, with no diff, no draft layer, no undo. Under #13 this endpoint must not
be wired to anything in the studio.

**5.9 — the row `key` includes the row's own values (CODE-READ, React semantics; not exercised in a
browser under this brief's read-only rule).** `:315`
`key={`${f.year}-${f.make}-${f.model}-${i}`}` — every keystroke changes the key, so React unmounts
and remounts the row and the focused `<input>` is replaced. Typing "Kawasaki" would need a click per
character.

**5.10 — `router.refresh()` on save (CODE-READ).** `:197` re-runs the whole product-edit server
component (every cockpit card's data) to refresh one JSON blob.

**5.11 — the AM.1 eBay adapter omits the store, and its conformance witness cannot see it
(CODE-READ).** `services/pim/channel-specs/ebay.ts:82-116` hand-writes 24 listing-level specs, each
`channelStore: pa(key)` → `platformAttributes.<key>`; **`compatibility` is not among them.** Because
`coverage[f.key] = [f.key]` (`:117-119`) is self-referential for those fields, the conformance test's
`expect(ebay.unrecognised).toEqual([])`
(`channel-specs/__tests__/channel-specs.test.ts:246`) passes while a real store is missing — the
§A.3a "no exclusions" guarantee is only as strong as the source the adapter walks, and for eBay's
listing-level fields the source *is* the hand-written list. (Family:
`reference_a_scanner_passing_for_the_wrong_reason`, `reference_a_list_of_members_is_a_set_claim`.)

**5.12 — no tests at all on the persistence path** (the pure builder is tested; the route, the
cleaning, the cap, the card are not).

**HYPOTHESIS (unmeasurable here — read-only, prod DB):** how many eBay listings actually carry
`platformAttributes.compatibility`, and how many carry `{universal:true}` by default versus by
decision. `channel-specs/ebay.ts:19` records that listing-level fields sit at
`platformAttributes.<key>` on **247 of 252 IT listings** (MEASURED-IN-DOC 2026-09-04) but says
nothing about this key.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**PRIMARY: H7 — a fifth record-drawer pane, "Compatibility", hosting a bounded NexusGrid sub-table,
with a full-screen escalation to DS `Modal size="xxl"`.**
This is what ruling #110 already decided (`pes-claims.md:20434` names fitment by name) and it is the
only home the data's shape permits: a fitment list is *rows of leaves*, and AM.1 has no shape for
that (`channel-specs/types.ts:32`; the design doc's own census, `:57`, counts 178 unmodelled
multi-sub-property Amazon fields). The substrate is already proven inside this exact frame —
`GridPanel` is documented as the modal/drawer grid host (`GridCard.tsx:10-13`) and
`ImportDrawer.tsx:463-472` already runs a `NexusGrid` in a `GridPanel` in a studio `Drawer`. So the
pane costs a component, not an architecture.

**MIRROR 1: H2 — one read-only derived status column, `Compatibility`, on the eBay channel scope,
rendered on the ALIAS BAND row.** Not decoration: it is what makes the fact *reachable*.
`sheet/channel/viewChips.ts:20-24` states the rule — *"A readiness issue names a field key. If that
key is not one of the scope's columns, the operator cannot be taken to it, so counting it would
promise a destination that does not exist"* — and excludes such issues from every chip count. So
without a column, a fitment readiness issue can never appear in `Missing required (n)`; it would be
noted as unreachable and effectively invisible. The column is the hook readiness, chips, filters and
the ⋯ verb all hang from.

**MIRROR 2: H5 — `CONTEXT(alias-group)` verbs on the band's ⋯**: `Edit compatibility…` (the pane
opener), `Import fitments (CSV)…`, `Copy fitments to another listing…`, `Clear fitments`. Required by
channel-ops research §3.2 / ruling #110 — *a verb must never live only in the drawer*. These would be
the studio's first `contextOf('alias-group')` verbs; `AliasBandCell.tsx:57-60` says the band renders
them with no change to that file.

**MIRROR 3: H4 — `Apply fitments to selected listings…`** on the selection bar, the honest
replacement for `template-apply`'s opt-OUT flag (`routes:1723`). Preflight-first, opt-IN, naming
every target and the row count it will overwrite.

**MIRROR 4: H9 — an Errors & Sync console row** whenever eBay rejects the compatibility PUT. That is
today's dead `compatibilityWarning` (§5.4) given a destination; the console already groups by cause
(`channel-ops/syncQueue.ts`, tests `:23-71`).

**Rejected homes, with reasons.** **H1 (a cell)** — a fitment list in one cell means a composed
string, and `reference_composed_string_invisible_separator` plus AM.1 §A.6's re-import-as-zero-changes
acceptance both fail on it: `2020|Ducati|Panigale V4` cannot round-trip back into four typed columns.
**H8 (Images)** — unrelated. **H11 (a fitment library page)** — genuinely attractive once two products
share a set, but not v1; see Q3. **H12 (drop)** — no: it is the difference between being in eBay's
vehicle-search funnel and not.

### 6.2 What the sheet shows at rest

| scope | at rest |
|---|---|
| **master** | **nothing.** There is no master fitment store; inventing one is a separate decision (§7). A `Compatibility` column on master would have to read empty on every row, which is the "confidently wrong" shape `scope-readiness.service.ts:184-190` was written to avoid. |
| **eBay × market** | ONE column `Compatibility`, ~150px, read-only, in the `Listing` group. Value on the **band row** (`rowKind:'parent'`, `layer:'alias'`): `Universal fit` · `42 vehicles` · `—` (unset). Variant rows show a dimmed `↳ from listing` inherit mark, never a number of their own. Tooltip: the mode, the row count, `updatedAt`, and the sentence "read-only here — edit with Compatibility on the ⋯ menu" (`reference_disabled_control_cannot_explain`). |
| **Amazon / Shopify / Woo / Etsy** | no column. eBay's adapter declares it; nobody else's does. |

**The ⚠ mark is BLOCKED until the category signal is real.** The brief's "⚠ when the category
requires fitment and none exist" is right in principle and unbuildable today: nothing asks eBay
(§5.6), and the only available substitute is the keyword regex that has already drifted into two
disagreeing copies (§5.2). Guessing here reproduces
`reference_could_not_measure_vs_measured_empty` — an unwitnessed "this category needs fitment" would
convict a listing on nothing. So: **v1 ships the count with no ⚠ and a tooltip that says eBay has
not been asked**; the ⚠ turns on in the same change that lands the cached
`compatibilityEnabled` / `compatibilityProperties` (§7), and then it is derived, not inferred.

### 6.3 The interaction

1. **OPEN.** `Edit compatibility…` on the band ⋯ (or `Enter` on the band's Compatibility cell, which
   fires the same verb — layout-v2 §5.5 keeps *record* opening on the identity cell, so this is a
   declared verb, not a second opening gesture). Drawer slides in non-modal at 520px on the
   **Compatibility** pane; the sheet stays live behind it.
2. **PANE.** DS `SegmentedControl` `Universal fit | Specific vehicles`. Under it, `GridPanel` with a
   `GridToolbar` (`+ Add row`, `Import CSV…`, `Clear`, a row counter `42 / 1000`) and a bounded
   `NexusGrid` (height 480, the inventory-editor reference in `GridCard.tsx:12-13`) whose columns come
   from the cached compatibility properties — `Year · Make · Model · Submodel` today, `Trim · Engine`
   when eBay declares them. `Universal fit` hides the grid and says what that means, rather than
   greying rows.
3. **COLLECT (import).** `Import CSV…` opens DS `FileDropzone` + a paste `Textarea`, parses to a
   **preview** (`n rows will be added, m rejected — Year missing`), and **names every rejected row**
   rather than slicing quietly (§5.3). Apply only after the preview.
4. **PREFLIGHT / CONFIRM.** Only the fan-out and destructive verbs need one: `Copy fitments to…`
   preflights per `ActionImpact` (`registry.ts:84-124`) and confirms with the target count;
   `Clear fitments` on a list of 40+ rows earns `type-to-confirm` with the *listing's* label as the
   phrase (`:123` — "A SKU, never 'DELETE'"). Cell edits and single-row add/delete need no confirm.
5. **RUN / autosave.** Edits autosave through a **fitment writer** — debounced, whole-list
   idempotent `PUT`, `expectedVersion` echoed back. Per
   `reference_autosave_still_needs_a_nav_guard` the pane installs a nav guard, and per the in-flight
   autosave/revert trap the read-back is **delayed**, not immediate.
6. **WHAT REPAINTS.** The band's Compatibility cell (count/mode), the band's readiness pill, the
   scope chip, and the `Missing required` chip count. Nothing else — no `router.refresh()`.
7. **ESCALATION.** `⤢ Full screen` in the pane header re-hosts the *same* grid component in DS
   `Modal size="xxl"` (1040px — `components.css:358-360`, the DS's own declared size for "modals
   holding a table"). **Not `full`**: that variant is documented as a media surface with
   `padding:0; overflow:hidden` (`:371-387`) and is wrong for a table. State the cost plainly: the
   modal *is* modal, so the escalation trades "sheet stays live" for width. The pane stays the
   default; the modal is for the 200-row paste session.
8. **KEYBOARD, and the AG traps that bite here.** Inside the sub-table: `Enter`/type to edit,
   `Tab`/arrows to move, `⌘Z` undo. Three known traps apply and must be designed around, not
   discovered: the **fill handle swallows the double-click and fills the column down**
   (`reference_ag_fill_handle_swallows_dblclick`) — disable `enableFillHandle` on this grid, a
   4-column table has no use for it; a **React editor must call `props.onValueChange`** or the edit is
   silently discarded (`reference_ag36_react_editor_onvaluechange`); and **a popup editor owns
   Enter/Tab/Esc** (`reference_ag_popup_editor_owns_keys`) — so `Esc` with an editor open must not
   close the modal or the drawer.

### 6.4 Per-scope rules

- **master** — absent (§6.2). Not "empty": the column is not declared, so no rule can call the row
  unready for a store that does not exist.
- **eBay channel scope** — the column and the verbs live on the **alias band**. Every variant row
  under the band shows the inherit mark; none is independently editable in v1.
- **multi-alias products** — each band its own value, each its own pane. This is exactly what §5.1's
  `findFirst` cannot express, and why the new endpoint is addressed by `listingId`.
- **single-store channels (Shopify/Woo/Etsy) and Amazon** — no column, no verb, no pane tab. The
  drawer's pane array is per-scope; the fifth tab simply is not offered off eBay.
- **markets** — per (channel, marketplace) exactly like the alias
  (`ProductListingAlias` "an alias belongs to exactly one (channel, marketplace) pair",
  `schema.prisma:1739-1741`). eBay·IT and eBay·DE fitments are separate values; nothing is shared or
  summed across markets. And per `reference_contract_field_varies_by_market`, the *property set*
  itself may differ by market — which is why it is cached per (marketplace, category), never global.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance.** The cell is `✎ alias` when the listing carries a value, `—` when it does not.
  **Never `🔗 inherited`** — there is no master fitment layer to inherit from, and painting 🔗 would
  claim a master store that does not exist. `sheet/channel/types.ts:152` already gives the vocabulary
  (`aliasVariant | alias | master | unset`), so a future per-variant override has a name waiting.
- **Autosave.** The sub-table does **not** go through `SheetWriter` — that writer's unit is a cell in
  `PATCH /api/products/bulk` `changes[]`, and `reference_bulk_patch_routes_six_channel_fields` plus the
  `attr_*`→`overrideData` path (`routes/products.routes.ts:2418-2456`) both address scalars in a JSONB
  bag. A whole-list replace is a different write with a different conflict rule. It reuses the
  *discipline* (debounce, `expectedVersion`, per-cell outcome, nav guard), not the pipe.
- **Readiness.** `readiness.service.ts` is entirely column-driven: `buildCoordinateValidators`
  filters `SheetColumn[]` and `evaluateRow` reads a flat `key → value` row. So the derived status
  column is the *whole* integration: give the spec a `requirement` and `columnRequiredHere` puts it in
  `required`, `findMissingRequired` emits "Compatibility is required by eBay · IT", the band pill and
  the scope chip pick it up via `scope-readiness.service.ts:150-206`, and the chip can *reach* the
  cell (§6.1 mirror 1). **Zero readiness code changes.** The pane's individual rows are never
  validated by readiness — a fitment row is not a column and must not pretend to be one.
- **Publish.** The value must appear in `POST /products/sheet/publish-preview` before it can honestly
  be sent (today it appears in no preview, §5.5). At send: the Inventory API resource is
  `inventory_item/{sku}/product_compatibility` (adapter `:492-494`) — **per SKU** — so one
  listing-level value **fans out to every member SKU of the alias**, and the fan-out is the server's
  job, not the operator's. eBay publish stays preview-only (`getEbayPublishMode` default `dry-run`),
  so this is built and exercised against the preview, never against a live ItemID.

### 6.6 ASCII mockup

```
eBay · IT ── channel scope ───────────────────────────────────────────────────────────────
 ▾ ① GALE Pro Racing Suit  ●Active  ▓▓▓▓▓▓▓░░ 71%  ⋯     │ Compatibility │ Condition │ …
     GALE-KAN-PRO-NERO-48                    ↳from listing│  ↳            │ NEW       │
     GALE-KAN-PRO-NERO-50                    ↳from listing│  ↳            │ NEW       │
 ▾ ② GALE Pro Suit (photo set B)  ○Draft  ▓▓░░ 34%  ⋯    │ ✎ 42 vehicles │ NEW       │
                                                          └── read-only; ⋯ → Compatibility

RECORD DRAWER (520px, non-modal, sheet still live) ─────────────────── ⤢ Full screen ─┐
 ① GALE Pro Racing Suit · eBay · IT                                                   │
 [Record][History][Compare][Listings][Compatibility]                                  │
                                                                                      │
 ( ) Universal fit   (•) Specific vehicles          eBay has not been asked whether    │
                                                    this category uses fitment ⓘ       │
 ┌ + Add row │ Import CSV… │ Clear ─────────────────────────── 42 / 1000 ─┐            │
 │ Year │ Make      │ Model         │ Submodel │                          │            │
 │ 2020 │ Ducati    │ Panigale V4   │ S        │ ✕                        │            │
 │ 2019 │ Yamaha    │ MT-09         │          │ ✕                        │            │
 │ …                                                                      │            │
 └────────────────────────────────────────────────── autosave ✓ 12:04 ────┘            │
 [✦ Suggest fitments]  AI generation is off (ruling #13)                               │
 Sent to eBay per member SKU at publish · last sent: never                             │
```

## 7. Contracts and data

**Reused unchanged:** `GET /products/:id/studio/columns` + `/studio/sheet`
(`routes/product-studio.routes.ts:150,179`) — the status column arrives as an ordinary column;
`GET/POST /products/:id/listings/:listingId/snapshots` (`:705,716`) — fitment rides inside
`platformAttributes`, so publish snapshot/restore already covers it; the action registry; `GridPanel`;
DS `Drawer`/`Modal`/`SegmentedControl`/`FileDropzone`/`Banner`.

**New — PES.5 (backend):**
1. `GET /api/products/:id/listings/:listingId/compatibility` → `{universal, rows[], updatedAt,
   version, properties[]}` and `PUT` the same (whole-list replace, `expectedVersion`, **reports
   rejected rows instead of slicing**). Addressed by `listingId` so §5.1's alias-blind `findFirst`
   cannot recur. Sits under `/api/products` → `F.productsEdit` (manifest `:412`), **not** the current
   `F.channelsSync` (`:354`) — flag the permission move to the Owner rather than letting it happen.
2. A cached **category compatibility signal** per (EBAY, marketplace, categoryId):
   `compatibilityEnabled` + `compatibilityProperties[]` from eBay's Taxonomy
   `get_compatibility_properties`. **Zero migration** — it nests inside
   `CategorySchema.schemaDefinition` (Json, `schema.prisma:7254`) beside the aspects the eBay adapter
   already reads. This is what turns the ⚠ and the pane's column set from a guess into a fact, and
   retires both motors regexes (§5.2).
3. Fitment into the publish **preview** payload + the per-SKU **fan-out** at send + route
   `compatibilityWarning` into the sync queue (§5.4/§5.5). Additive; no schema change.
4. Retire `template-apply`'s opt-OUT `compatibility` flag in favour of the opt-IN H4 verb.

**New — PES.6 / PES.5 (AM.1 adapter):** one `ChannelFieldSpec` in
`services/pim/channel-specs/ebay.ts` for `compatibility` —
`channelStore: {kind:'platformAttributes', path:['compatibility']}`, `shape:'scalar'`, derived +
read-only, `requirement` from (2). This closes §5.11 and satisfies §A.3a for a store the adapter
currently cannot see. **Do NOT add a fifth `FieldShape` for this feature** — the repeating-table
shape is real (178 Amazon `vehicle_fitment`-class properties, doc `:57`; Amazon's is even *nested*,
`flat-file.service.ts:396,1175`: `vehicle_fitment.items.properties.standard.items…`) but it is an
AM.1-scale decision and this feature does not need it (Q3).

**New — PES.4 (drawer):** the fifth pane + the fitment grid component + the `Modal size="xxl"`
escalation host (one component, two hosts).
**New — PES.3 (channel sheet):** the four `alias-group` verbs and the selection verb, plus the
band's ⋯ becoming non-empty for the first time.
**New — PES.2 (grid substrate):** nothing new is *required* — `GridPanel` + `NexusGrid` already do
this. If the sub-table pattern is wanted engine-side ("a bounded editable sub-table with add/remove"),
that is one shared component and belongs to PES.2, not to eBay.
**New — PES.8 (AI):** a **disabled** `✦ Suggest fitments` button with a two-part honest tooltip:
generation is off under #13, *and* a table-shaped draft has no approve path — `ProductAiDraft` is keyed
per cell (`cellKey`, `writeField`, `draftValue`, `schema.prisma:11986-12030`) and the approve path
passes `writeField` verbatim into `PATCH /api/products/bulk`, which cannot write a fitment list. Both
sentences are true; saying only the first would overstate readiness.

**No new Prisma model.** Fitment stays at `ChannelListing.platformAttributes.compatibility` (the store
the publish adapter already reads), so nothing that exists breaks and the pane can be built against
real data with no migration. A first-class `Fitment` table is the right answer *if* fitment sets ever
become shareable across products (Q3) — not before.

## 8. Risks and traps

1. **Every eBay listing in the fixture family is LIVE and local dev writes the PROD database**
   (`reference_local_dev_hits_prod_api`, `reference_local_handler_writes_prod_db`). A fitment write is
   a real write to a real listing's record. Probes stay inside the fixture family
   (`reference_transport_failure_write_is_unknown_outcome`), and the pane must be exercised against
   the preview, never against a publish.
2. **Blur commits.** `reference_endpoint_safety_is_not_interaction_safety`: a grid cell's own blur
   committed to prod once already. A fitment cell in an editor left open when the drawer closes must
   not commit — the AG `destroy()`-commits trap.
3. **`template-apply` copies fitment to up to 200 products by default** (`routes:1719-1725`). Until
   the H4 verb replaces it, anyone using apply-to-siblings is fanning fitment out unknowingly.
4. **Publish gates.** eBay is `dry-run` by default and the mode comes from the **server**
   (`getEbayPublishMode`, never env in the client — the GDS-4 rule). The fitment PUT lives inside the
   publish flow, so it inherits the gate; nothing about this feature may open a second path to eBay.
5. **AI dark (#13).** The endpoint at `routes:1275` is live and spends money *today*. The studio must
   not call it. The dark control is the parity answer (#85).
6. **Untouchables** — neither flat-file editor carries fitment (verified §2), so no overlap. FBA
   quantity and the import flows are unrelated.
7. **Oversell / shared quantity** — not touched: fitment carries no quantity. But the alias rule that
   *does* apply is `reference_oversell_is_per_channel_not_summed`'s sibling: fitment is **per alias**
   and must never be summed or merged across the aliases of one product.
8. **Images global per ASIN** — not applicable (eBay, and fitment is not media).
9. **The mirrored-type trap.** `sheet/channel/types.ts` mirrors the server's `SheetColumn` and has
   already drifted four times (`:76-100`, `reference_wire_parse_boundary_rules`). The fitment row type
   must live in ONE place both sides import, or it becomes the fifth.
10. **A doc can describe code that never shipped.** `routes:1509-1515` and
    `CompatibilityCard.tsx:18-22` both describe a Trading-API `ItemCompatibilityList` round-trip
    ("EC.13b … ships separately") that **does not exist** — the shipped call is the Inventory API PUT.
    Do not plan against the comment (`reference_docs_describe_deleted_code`).

## 9. Open questions for the Owner (3)

**Q1 — Is fitment a LISTING value (alias band) or a per-variant value?**
*Recommendation: listing-level, edited on the alias band, fanned out to every member SKU at publish;
a per-variant override deferred until someone asks.* Evidence both ways, stated honestly: eBay's own
buyer-facing fitment is on the **item**, motors gear fits the same bikes in every size, the band row
already resolves at `layer:'alias'` (`ChannelSheet.tsx:1093`), and 21 variants × 42 vehicles would be
882 sub-tables to keep in sync. **Against:** the resource the adapter actually calls is keyed by
**SKU** (`ebay-publish.adapter.ts:492-494`), so eBay *can* hold a different list per variant. That
makes per-variant a publish-time capability we choose not to expose, not a limitation — and the
cascade vocabulary (`aliasVariant`) already has a name for it if the answer changes.

**Q2 — May the ⚠ fire before we have asked eBay whether the category uses fitment?**
*Recommendation: no.* Ship the count with no ⚠ and a tooltip saying eBay has not been asked; turn the
⚠ on in the same change that caches `compatibilityEnabled`/`compatibilityProperties` (§7 item 2, no
migration). The alternative is the keyword regex, which has already produced two disagreeing copies
that differ on English plurals (§5.2) — a ⚠ derived from it would be confidently wrong on exactly the
categories it matters for.

**Q3 — Do we take the fifth AM.1 shape (a repeating sub-table) now, or ship fitment as a derived
status column + a drawer sub-table outside the shape system?**
*Recommendation: the latter.* It is surgical, needs no AM.1 change, and lands the operator capability
now. The fifth shape is genuinely owed — 178 Amazon multi-sub-property fields have no shape today
(design doc `:57`), Amazon's `vehicle_fitment` is nested (`flat-file.service.ts:396,1175`), and a
shared *fitment library* at `/channels/…` (H11) is the natural next step once two products share a
set — but that is an AM.1-scale ruling of its own, not a rider on this feature.

## 10. Effort and dependencies

| piece | lane | size |
|---|---|---|
| Derived status column + eBay adapter spec + honest tooltip | PES.5 (spec) + PES.3 (column) | **S** |
| Category compatibility signal cached in `schemaDefinition` (turns the ⚠ on, retires both regexes) | PES.5 | **S** |
| `GET/PUT …/listings/:listingId/compatibility` (alias-addressed, reports rejected rows) | PES.5 | **M** |
| Drawer pane + `GridPanel` fitment grid + CSV preview/import + autosave + nav guard | PES.4 | **M** |
| `Modal size="xxl"` escalation (same component, second host) | PES.4 | **S** |
| Four `alias-group` verbs + the selection fan-out verb (first `contextOf('alias-group')` verbs) | PES.3 | **M** |
| Publish preview payload + per-SKU fan-out + `compatibilityWarning` → sync queue | PES.5 | **M** |
| Dark `✦ Suggest fitments` control | PES.8 | **S** |
| *(deferred)* fifth AM.1 shape / fitment library page | AM.1 + Owner | **L** |

**Dependencies.** (a) AM.1's spec/column pipeline is landing right now — `readiness.service.ts` and
`sheet-columns.service.ts` gained `shape`/`slot`/`cardinality` mid-session — so the adapter spec must
be written against the merged shape, not against a snapshot. (b) The band's ⋯ has never rendered a
verb; the first `alias-group` verb exercises that path (`AliasBandCell.tsx:57-60` claims it needs no
change — worth verifying on screen, not on the comment). (c) Feature **07 (eBay aspects)** shares the
escalation pattern and the same drawer-pane real estate — the two should agree on the pane's
grammar once, not twice. (d) Feature **3.28 (Amazon fit/fitment)** shares the data shape; if the
fifth AM.1 shape is ever taken, both collapse into it.
