# 01 — eBay description THEMES / templates (the "Description Studio")

## 1. What it is (operator terms)

eBay listing descriptions are **static HTML**: whatever you send at push time is what buyers see
forever — it never re-renders. So the operator writes only the **body copy** per market (the
Italian prose for the IT listing, the German for DE) and a reusable **theme** — owner-authored HTML
with `{{tokens}}` — wraps that body at push time, injecting the auto-generated gallery, the
specifics table and the policy blocks. One theme serves hundreds of listings; a theme edit is a
brand change across the shop. Two people use it: the listing operator, who picks *which* theme a
family uses on a market and edits the body; and whoever owns the shop's look, who authors the theme
HTML itself. The nasty part is drift — because the HTML is static, curating new images or editing
the theme leaves every live description behind, silently, until someone re-pushes. That is what the
staleness stamp exists for.

## 2. Old UI — inventory

Entry points, all on the (untouchable) eBay flat file `apps/web/src/app/products/ebay-flat-file/`:

| # | surface | file:line | round-trips |
|---|---|---|---|
| a | **`description` column** — the BODY, per market, `kind: 'longtext'`, 4000-char cap | `ebay-columns.ts:290-299` | grid save → `ChannelListing.description` |
| b | **`DescriptionModal`** — the cell's editor: Edit / Preview / **"Themed (as pushed)"** tabs | `EbayFlatFileClient.tsx:251-350` | `POST /api/ebay/description-preview` (:265) |
| c | **`description_theme` column** — the ASSIGNMENT, `kind: 'enum'`, strict, options `['', 'none', …themeIds]` labelled by theme name | `ebay-columns.ts:300-308`; options patched at runtime by `patchDescTheme` `EbayFlatFileClient.tsx:1313-1332` | grid save → `platformAttributes.descriptionThemeId` via `ebay-variation-push.service.ts:2787` |
| d | **`ThemeBulkModal`** (ED.5b) — set the theme on N selected rows, DS `Listbox` | `EbayFlatFileClient.tsx:607-643`, mounted :3922 | none (local row patch + Save) |
| e | **description-sync dot** — 6px amber/green on family-parent + standalone rows, View-menu opt-in, reason-aware tooltip | `EbayFlatFileClient.tsx:4521-4540`; predicate `isDescSyncEligible` :171; fetch :1071-1107 (chunked at 200) | `GET /ebay/description-themes/staleness` |
| f | **`EbayDescriptionStudio`** — the theme MANAGER: one DS `Drawer` at `min(1440px, 96vw)`, 3 panes (theme rail 240px \| HTML editor + token palette \| always-mounted live preview) + `StatusStrip` + collapsible push dock | `DescriptionStudio/EbayDescriptionStudio.tsx` (**1189 lines / 63.9 KB, one component**), mounted `EbayFlatFileClient.tsx:3955` | theme CRUD, usage, staleness, preview, push |

Sub-components: `ProductLookup.tsx` (113), `PushResults.tsx` (193, verbatim per-ItemID outcomes),
`StalenessPill.tsx` (90, incl. a **gray "unknown — check failed"** state deliberately distinct from
green), `StatusStrip.tsx` (149, four sections: render state / verbatim warnings / truth echo /
staleness), `StudioConfirm.tsx` (212, confirms render INSIDE the drawer because the app-wide z-50
Modal was covered by the z-61 panel), `ThemeNote.tsx`, `noteSplit.ts` (draft-copy flag), `tokens.ts`
(the client mirror of the renderer's token map), `types.ts` (mirror of the server result types).

Browser-local / not persisted: the chip set (preview seed **and** push selection, star = previewing),
market select, Desktop(920px)/Mobile(375px) width toggle, editor draft. Nothing in localStorage.

Preview is a **sandboxed iframe** — `sandbox=""` + `srcDoc` wrapper so theme CSS cannot leak into
the app (`EbayDescriptionStudio.tsx:578-582`); debounced 500 ms with `AbortController`, and a failed
render keeps the **last good frame dimmed** rather than blanking (:530-566).

DEAD: `EbayDescriptionThemesModal` — superseded by the Studio at DS-2 and no longer imported
(`DescriptionStudio/index.ts:4`, `EbayFlatFileClient.tsx:35`).

## 3. Backend that exists

**Prisma** — `model EbayDescriptionTheme` `packages/database/prisma/schema.prisma:16091` (`name`
unique, `html`, `isDefault`, `active`, `builtIn`, `version`). The comment above it at :16084-16090
is the contract: body stays on `ChannelListing.description`, assignment lives on
`ChannelListing.platformAttributes.descriptionThemeId` **per market row**, `'none'` opts out.
Stamp: `platformAttributes.descriptionPush = { at, themeId, themeVersion, galleryHash }`.

**Routes** (both registered `apps/api/src/index.ts:692-693`, prefix `/api`):

| method + path | file:line |
|---|---|
| `GET /api/ebay/description-themes` (seeds built-ins on first call) | `ebay-description-themes.routes.ts:44` |
| `GET /api/ebay/description-themes/usage?marketplace=` | :60 |
| `GET /api/ebay/description-themes/staleness?productIds=&marketplace=` (MAX 200 ids) | :143 |
| `POST /api/ebay/description-themes` · `PUT :id` (opt-in `expectedVersion` → 409) · `DELETE :id` (built-ins undeletable) · `POST :id/default` | :239 / :258 / :286 / :297 |
| `POST /api/ebay/description-preview` — renders exactly what a push would send; no eBay, no writes; accepts `themeId` **or** unsaved `themeHtml` | :308-357 |
| `POST /api/ebay/description-push` `{productIds ≤50, marketplace, themeId?}` | `ebay-description-push.routes.ts:101` |
| `POST /api/ebay/relink-item-id` (dry-run unless `apply`) · `GET /api/ebay/inventory-drift` (read-only) | :32 / :72 |

**Services** — `ebay-description-theme.service.ts` (608): `renderListingDescriptionSafe` (:348, the
ONE entry point every push site calls; never throws — falls back to the raw body with a warning),
theme resolution incl. **D7** inactive→default fallback (:401-409), `descriptionModeFor` (:157) /
`resolveDescriptionMode` (:169, the ONE mode derivation shared by preview and push — a childless
pool shell with curated colour buckets is `group`), `galleryHashOfRows` (:462, sorted so DB order
cannot change it), `stampDescriptionPush` (:484, **merge-only** so `__offerIds` survives) /
`stampDescriptionPushSafe` (:524, never rejects), `evaluateDescriptionStaleness` (:579, pure).
`ebay-description-render.ts` (2705 lines / **165 KB**) is the pure renderer: `renderDescriptionTheme`
(:316), `renderDescriptionBodyOnly` (:423), 17 tokens, an eBay active-content guard (script/iframe/
form strip, `on*` strip, `javascript:` neutralise, http→https media), plus every built-in theme's
HTML *and* frozen historical copies (`BUILT_IN_THEMES`, `BUILT_IN_PREVIOUS`) inlined as constants.
`ebay-description-push.service.ts` (494): `pushDescriptions` (:199) — Lane B Trading listings get a
minimal `ReviseFixedPriceItem` carrying **only** `ItemID` + `Description` (:56), a **GetItem parity
read-back** with a normalised hash comparison (:397-412), and an empty rendered body is REFUSED;
**Lane A** (Inventory-managed primary, detected by `__offerIds`) returns an honest per-listing skip
pointing at Full Publish (:330-347).

**Other render call sites** (all read the same store): `ebay-flat-file.routes.ts:2256` (family Full
Publish, stamps :2302) and `:2624` (single-SKU, stamps :2727); `images/ebay-inventory-image-publish.service.ts:302`
(Lane A's safe path, stamps :340); `ebay-shared-listing-push.service.ts:387` (**does NOT stamp**).

**Safety gates** — every write goes through `callTradingApi`
(`ebay-trading-api.service.ts:235-246`): without `NEXUS_EBAY_REAL_API=true` it **dry-runs in dev and
throws in production** ("Refusing to fake-success"). There is **no per-request dry-run parameter**.
A typo'd `themeId` is rejected at the route (`ebay-description-push.routes.ts:127-131`) precisely
because the renderer would silently fall back to the raw body and look like success.

**Permissions** — `/api/ebay/*` → read `listings.view`, write `channels.sync`
(`permissions-manifest.ts:354`). The assignment write goes through `PATCH /api/products/bulk` →
**`products.edit`** (`channelActions.ts:52`, ruling #123). So this one feature spans **two
permission namespaces**.

**Jobs/crons** — none for descriptions. Staleness is read-only, on demand, and never auto-pushes.

## 4. Studio today

**The theme column already exists and is READ-ONLY.** `apps/api/src/services/pim/channel-specs/ebay.ts:111`
declares `listing('descriptionThemeId', 'Tema della descrizione', 'Description theme', { kind: 'text',
channelStore: pa('descriptionThemeId') })`. Because it has a `channelStore` and no `masterKey` it is
`listingOnly` (`sheet-columns.service.ts:458`), which sets `storage: 'listing'`, `writeField:
attr_descriptionThemeId` (:469) and **`editable: !listingOnly` → false** (:485). The per-cell reason
the server sends is `studio-sheet.service.ts:1184-1189`: *"Read from the listing — editing this
channel field lands with the next build; the value shown is what the listing holds today."* And with
`kind: 'text'` and no `optionLabels`, the cell paints the raw **CUID**, not a theme name.

**The body column is already fully wired.** `ebay.ts:85` declares `description` as `kind: 'longtext'`,
`requirement: 'required'`, `masterKey: 'description'`, `channelStore: { kind: 'listingColumn', column:
'description', followFlag: 'followMasterDescription' }`. On an eBay scope it routes
`ebay_description` → `CHANNEL_FIELD_MAP` (`channel-field-map.ts:26`) → the `ChannelListing.description`
COLUMN — **exactly the store `renderListingDescriptionSafe` and `resolvePerMarketContent`
(`ebay-variation-push.service.ts:2462`) read**. Verified end to end. The sheet edits it in an
`agLargeTextCellEditor` popup (`ChannelSheet.tsx:962-965`), the drawer in `HtmlField`
(`RecordField.tsx:382`), and the cell carries a `longTextState` mark + composed tooltip (:1048).

Also present: `select` columns already get the DS listbox from the CONTRACT's `options` +
`optionLabels` (`ChannelSheet.tsx:966`, `optionLabels` flows `ebay.ts` → `sheet-columns.service.ts:558,701`
→ cell); the eBay bucket × position image grid (`_studio/images/channel/ebay/EbayGrid.tsx`) is the
curated gallery the theme render reads, so an edit there is what flips staleness; the drawer's
read-only `ListingsPane` (`drawer/panes/ListingsPane.tsx:1-19`) is the per-listing status surface;
`PublishMenu.tsx:11-19` sends nothing and says so.

**Parity audit** — there is **no row** for the Description Studio or description themes (grepped
`description`, `theme`, `flat.?file`, `staleness`). Rows 8.2/8.3 dropped the link-outs to the flat
files under **D9** with the Owner's *"everything would be deriving from the grid we just built"* —
which is exactly why this capability has to land in the studio. Row 3.39 grades eBay
title/description as ✅ PARITY.

**Hub rulings** — grepped `docs/pes-claims.md` for `description theme|descriptionTheme|Description
Studio|description-theme|description push`: **zero hits**. Nothing binds this feature directly. What
binds it indirectly: layout §2 decision **6** (*"mapping is global, not per-product"* — the H11
precedent), decision **7** (autosave per cell, Publish explicit), layout §1 (*eBay publish stays
preview-only; mode from `getEbayPublishMode()`, never env*), **#669/D18/D11** (closed lists get the
DS dropdown on channel scopes too), **#118** (COLLECT → PREFLIGHT → CONFIRM → RUN), **#58/#513/#522**
(a non-writable cell must say why), **#123** (a channel verb's permission follows the ROUTE),
channel-ops §3.2 (*no researched product houses one-shot operations only inside a panel*), and
AM.1 §A.4 — approved 2026-09-05 — *"the write route needs one addition: `attr_*` with
`target:'channel'` routes to the typed column when the spec names one, else the bag"*.

## 5. Defects and slowness

1. **🔴 The drawer's `HtmlField` sanitiser will DESTROY an eBay body on blur, with no edit.**
   `HtmlField.tsx:38` allows only `P BR B STRONG I EM U S UL OL LI A H3 H4 H5 SPAN DIV`, and only
   `href/title/target/rel` on `<A>` — so **every `style=` attribute, every `<img>`, every `<table>`
   is unwrapped or dropped**. Real eBay bodies carry all three (the built-in themes are wall-to-wall
   inline styles). `onBlur={(e) => commit(e.currentTarget.innerHTML)}` (:313) → `sanitize` → *"if
   clean !== value → onCommit"*, so focusing the field and leaving it commits the stripped value
   through the studio's autosave. The sheet's `agLargeTextCellEditor` does **not** sanitise, so the
   two surfaces disagree about one value. **CODE-READ** (not measured — local dev writes prod).
2. **🔴 A generic write for `descriptionThemeId` lands where nothing reads.** `writeField` is
   `attr_descriptionThemeId`, so `isChannelChange` (`products.routes.ts:1291`) routes it on TARGET to
   the `attr_*` arm, which merges into `ChannelListing.overrideData` (:2450). Every reader —
   `renderListingDescriptionSafe:360`, the push's persist (:267), staleness (:215), usage (:72), the
   flat-file round-trip (:2787) — reads `platformAttributes.descriptionThemeId`. This is exactly the
   #758 wrong-store shape and it would be **silent**. **CODE-READ.**
3. **🔴 Staleness does not track the BODY.** `DescriptionPushStamp` (`theme.service.ts:438-447`) holds
   `at / themeId / themeVersion / galleryHash` and nothing else; `evaluateDescriptionStaleness:579`
   takes no body input; `grep -rn 'bodyHash|descriptionHash' apps/api/src` returns **nothing**. So the
   operator edits the description cell — the one thing they actually author — and the dot stays
   **green**. **CODE-READ.**
4. **The assignment can only be persisted by pushing to live eBay, or via the untouchable flat file.**
   There is no assignment-only endpoint: `pushDescriptions` writes `descriptionThemeId` **before
   rendering** (`push.service.ts:260-272`) as a side effect of a live `ReviseFixedPriceItem`.
   **CODE-READ.**
5. **`ebay-shared-listing-push.service.ts:387` renders and pushes a themed description but never
   stamps** — so after a successful shared-listing push, staleness still reports "never pushed".
   False-stale is the safe direction but it invites a needless LIVE re-push. **CODE-READ.**
6. **Three copies of the mode derivation, two of them stale.** DS-6 routed the preview and
   `description-push` through `resolveDescriptionMode`, but `ebay-flat-file.routes.ts:2626` still
   hardcodes `'single'` and `ebay-shared-listing-push.service.ts:390` hardcodes `'group'`. A
   childless-but-curated product previews one way and flat-file-publishes another. **CODE-READ.**
7. **The description cell's own "Themed (as pushed)" preview lies.** `EbayFlatFileClient.tsx:268`
   sends `mode: 'group'` hardcoded — the exact defect DS-6 removed from the Studio. A standalone
   product's cell preview shows per-colour gallery sections its push would never send. **CODE-READ.**
8. **Duplicated read per preview.** The route fetches the ChannelListing (`themes.routes.ts:336`) and
   then `renderListingDescriptionSafe:353` fetches the same row again — plus `resolveFamilyRootId`
   (1-4 sequential product queries, :19-39) and `resolveDescriptionMode`. Every 500 ms keystroke
   burst pays all of it. **CODE-READ.**
9. **`GET /usage` with no `marketplace` scans every eBay ChannelListing** and its whole
   `platformAttributes` JSON, grouping in JS (`themes.routes.ts:80-88`). **CODE-READ.**
10. **The staleness endpoint re-derives the theme resolution** rather than calling it —
    `themes.routes.ts:211-220` is a hand-written *"Mirror of `renderListingDescriptionSafe`'s theme
    resolution (incl. D7)"*. Two implementations of one rule. **CODE-READ.**
11. **Two mirrored client types.** `DescriptionStudio/types.ts` mirrors the server's push/preview
    result types by hand; `tokens.ts` mirrors the renderer's token map. Both currently agree (I
    counted the token sets: 17 = 17), but nothing enforces it and an unknown token is **stripped**
    at render. **CODE-READ.**
12. **Giants.** `EbayDescriptionStudio.tsx` is 1189 lines in one component with ~20 `useState`;
    `ebay-description-render.ts` is 165 KB of inlined theme HTML on the API's import graph.
13. **The read-only theme column explains nothing.** `cellHoverNote` (`channel/rows.ts:363`) returns
    `null` when `editable === false`, so the server's reason string never reaches the tooltip — the
    cell just silently refuses the editor. **CODE-READ.**

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**H1 (the assignment cell) + H11 (the theme manager outside the studio) + H7 (a preview pane in the
drawer) + H3/H5 (a "Push description only" verb) + H2 (a derived staleness column).** The prompt's
hypothesis is right, and the data model is what makes it right — but two corrections.

**H1 — primary.** The assignment is one string on one row: `platformAttributes.descriptionThemeId`
on the family root's eBay `ChannelListing` for that market. That is *definitionally* a cell — and
the column **already exists** (`ebay.ts:111`), read-only, painting a CUID. The old flat file had
already reached the same answer independently (`description_theme`, a strict enum labelled by name).
Nothing is being invented; two things are being finished: `kind: 'text'` → `kind: 'select'` with
`options: ['', 'none', …ids]` + `optionLabels` (which the substrate already renders,
`ChannelSheet.tsx:966`), and the write route. **Reject the hover-preview half of H1**: a rendered
preview needs a server round-trip that costs a family-root walk, a listing read, a gallery load and
a theme render — a hover that fires that per row is a hover that publishes load. Previews stay
deliberate (see H7).

**H11 — the theme MANAGER lives outside the studio, at `/channels/description-themes`.** A theme is
account-level config: 1 row serves N listings across every market, editing it changes every live
listing's *next* push, and its CRUD sits under `channels.sync` while the studio's writes are
`products.edit`. Layout §2 decision 6 already settled the shape for exactly this class of thing —
*"mapping is global, not per-product"* — and the manager needs the surfaces the studio deliberately
does not have: the HTML source editor, the token palette, the built-in/default/active lifecycle, the
`usage` counts across the catalogue, and `POST :id/default`. Rebuilding all of that inside a
per-product page would be D9's mistake in reverse. The studio holds the **assignment only**.

**H7 — the drawer's Listings pane grows a "Description on eBay" section.** This is the *"as eBay will
render it"* pane: theme name + version, `bodySource`, last-pushed stamp with `ago()`, the staleness
reasons verbatim, the render's `warnings[]` verbatim, and a **Preview** button opening the sandboxed
frame with a Desktop/Mobile `SegmentedControl`. The drawer is the right home because the pane is
depth-in-context (non-modal, sheet stays live) and because `ListingsPane` already states the doctrine
this must obey: *"a 'Publish' button inside a record drawer is exactly how a preview-only channel
gets published by reflex."* So the pane previews and reports; it never sends.

**H3 + H5 — "Push description only" is a registry verb, never drawer-only.** Channel-ops §3.2:
*no researched product houses one-shot operations only inside a panel.* It is declared once in
`channelActions.ts` with `CONTEXT(alias-group)` scope (the assignment and the stamp are family-root ×
market facts, so the alias band is the honest subject), mirrored on the row menu, the `⋯` column, the
selection bar and the drawer's actions — and in wave 1 it **preflights truthfully and refuses the
outward half**, exactly as every other channel verb there does.

**H2 — one derived, filterable status column: "Description sync".** The old dot was a 6px mark
hidden behind a View-menu toggle; the studio has a real place for it. Read-only, `⚠ stale` / `✓ in
sync` / `? unknown` (never green on a failed check), tooltip = the server's `reasons[]` verbatim,
filterable so `Warnings (n)` can name it.

### 6.2 What the sheet shows at rest

| scope | Description (body) | Description theme | Description sync |
|---|---|---|---|
| **master** | the master `description`, `longtext` mark | **absent** — `listingOnly` fields are skipped on master (`sheet-columns.service.ts:459`) | absent |
| **eBay · IT, alias band / parent row** | this market's body, truncated, `longTextState` mark, provenance ✎ pinned when the listing holds its own | the theme **NAME** (`optionLabels`), `Default (Xavia Pro Clean)` when blank, `None — raw body` for `'none'`, `⚠ Theme deleted — the default renders` when the id resolves to nothing (D7) | `⚠`/`✓`/`?` + reasons tooltip |
| **eBay · IT, child SKU rows** | editable (the child's own listing body) | **blank and non-editable** with the reason *"the description theme is set on the family — edit it on the alias band"* | blank |
| **Amazon / Shopify scopes** | their own description | **absent** — the spec is eBay's | absent |

The child-row rule is not cosmetic. The renderer, the push and the stamp all resolve to the **family
root** (`push.service.ts:218-232`, `themes.routes.ts:19-39`, `stampDescriptionPush:501`), so a
theme id written on a child's `platformAttributes` is read by nothing. Left editable, AG's fill
handle would drag one theme down twenty child rows and every one of them would be a silent no-op
that *looks* applied (`reference_ag_fill_handle_swallows_dblclick`).

### 6.3 The interaction, step by step

**Assigning a theme** — click the cell, type or Enter (`openGesture`) → `SelectPanelEditor` (the DS
listbox panel, `cellEditorPopup: true`) lists `Default (name)` · `None — raw body` · every active
theme by name, with inactive ones shown struck and labelled *"inactive — the default renders"* →
pick → `props.onValueChange` (**mandatory**, `reference_ag36_react_editor_onvaluechange`) → the ONE
`SheetWriter` coalesces per row and sends `PATCH /api/products/bulk` with `expectedVersion` →
`CellSaveTracker` paints saving/saved on the cell → the Description-sync cell for that alias
**repaints to `⚠ theme assignment changed since last push`** from a refetch, not a local guess. No
confirm: this writes our DB only, changes nothing live, and is undoable by picking the old value.
Keyboard: ↑↓ Enter Esc inside the panel (the popup owns those keys —
`reference_ag_popup_editor_owns_keys`).

**Previewing** — `open-record` on the identity cell → drawer → Listings pane → **Preview** →
`POST /api/ebay/description-preview { productId, marketplace }` with **no `mode`** (so the server
derives it the way the push does) → sandboxed frame; Desktop/Mobile toggle; the render's `warnings[]`
render verbatim as amber rows, red-tinted for *unknown token* / *raw body*; a failed render keeps the
last good frame **dimmed** and states the status + body. The sheet stays live behind it.

**Pushing (wave 1)** — select the alias band → `Push description only` → **COLLECT** (nothing to
collect; the theme is already assigned) → **PREFLIGHT**: one `description-preview` per selected
family plus one `staleness` call, answering *how many listings would be revised, how many are Lane A
skips, which bodies are empty, which are already in sync* → **CONFIRM** at the level the preflight's
`ActionImpact` returns (danger, with the draft-copy acknowledge when the theme's note is flagged) →
**RUN** refuses the outward half and says which half it refused. Repaints: the Description-sync
column, the drawer pane's stamp, nothing else.

### 6.4 Per-scope rules

- **master**: the feature does not appear. Correct — a theme is an eBay listing fact.
- **eBay per market**: the assignment is per market row (`region`, with `UK → GB`), so IT can use one
  theme and DE another. The market picker changes the value in the cell.
- **alias bands**: the assignment is a **`CONTEXT(alias-group)`** fact. Each alias is its own
  `ChannelListing` with its own `platformAttributes`, so alias ② can carry a different theme from
  alias ①. Lane B adopted listings additionally render their **own** body copy from their membership
  snapshot when they have one (operator decision D5, `push.service.ts:116-137`) — the pane must say
  `bodySource: membership` when it does, or the operator reads the parent's copy and believes it is
  what went live.
- **single-store channels (Shopify)**: no spec, no columns, and no channel write route at all
  (`studio-sheet.service.ts:496-503` — `marketplaceContexts[].channel` is typed `'AMAZON' | 'EBAY'`).
- **Lane A vs Lane B**: a family whose CLs carry `__offerIds` is Inventory-managed; the verb must
  preflight that as *"N listings cannot take a description-only revise — Full Publish is the safe
  path"* rather than letting the operator discover it in the results.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance**: the theme cell is a `layer: 'channel'` value → ✎ pinned when the row holds its own
  id, and *nothing* when it inherits the global default — the default is not a cascade layer, so the
  cell must render `Default (name)` as text and **not** a 🔗 glyph, or it claims an inheritance
  relationship the resolver does not have.
- **Autosave**: through the ONE `SheetWriter` like every other cell. Needs a nav guard
  (`reference_autosave_still_needs_a_nav_guard`) and a `409` repaint-and-refetch.
- **Readiness**: the theme is **optional** (`ebay.ts:111` sets no `requirement`), so it must never
  count toward missing-required. Staleness is likewise **not** a readiness error — the listing is
  live and valid, it is just behind. It belongs in `Warnings (n)`.
- **Publish**: nothing here sends. The header `Publish ▾` gains no item; `sheet-publish.service.ts:141`
  keeps saying *"eBay is preview-only from the sheet"* and it stays true. `getEbayPublishMode()`
  remains the only source of the mode.

### 6.6 Mockup

```
 eBay · IT   [View ▾ Content] [Missing required (7)] [Warnings (42)]        [⋯]
┌──────────────────────┬────────────────────────────┬──────────────────┬──────────┐
│ SKU / IDENTITY       │ Description                │ Description theme│ Desc sync│
├──────────────────────┼────────────────────────────┼──────────────────┼──────────┤
│▾ ① 3054…21 · ACTIVE  │ Tuta racing in pelle bo… ✎ │ Xavia Modernist ▾│ ⚠ stale  │
│    GALE-KAN-PRO      │                            │                  │  ↳ images│
│      · GALE-…-52     │ Tuta racing in pelle bo… 🔗 │ ·  (set on ①)    │          │
│      · GALE-…-54     │ Tuta racing in pelle bo… 🔗 │ ·  (set on ①)    │          │
│▾ ② 3054…88 · ACTIVE  │ Rennanzug aus Rindsl…    ✎ │ Default (Xavia P…│ ✓ in sync│
└──────────────────────┴────────────────────────────┴──────────────────┴──────────┘
  ⚠ tooltip: "images changed since last push — the curated eBay gallery differs
     from what the live description was rendered with · theme "Xavia Modernist"
     edited since last push (v3 → v4)"

 Drawer ▸ Listings ▸ Description on eBay · IT
   theme    Xavia Modernist v4      body   this listing's own (membership)
   pushed   2026-09-02 14:07 (3d)   live   ⚠ behind — 2 reasons
   ⚠ hero gallery shows the first 8 of 14 images — add {{gallery_groups}}…
   [ Preview as eBay renders it ]  [ Desktop | Mobile ]
```

## 7. Contracts and data

**Reused unchanged**: `POST /api/ebay/description-preview`, `GET …/staleness`, `GET
…/description-themes`, `GET …/usage`, `POST /api/ebay/description-push`, and every service in §3.
This feature is unusually well served on the server; almost all the work is routing and UI.

| piece | lane | change |
|---|---|---|
| `descriptionThemeId` spec → `kind: 'select'`, `mode: 'strict'`, `options`/`optionLabels` from the theme table; add `descriptionThemes` to `EbaySpecInput`; load them in `loadEbaySpec` | **PES.5** | `channel-specs/ebay.ts:111`, `channel-specs/index.ts:206` |
| 🔴 include `max(EbayDescriptionTheme.updatedAt) + count` in the eBay spec cache **stamp** | **PES.5** | `channel-specs/index.ts:130-134` — the stamp is CategorySchema-only today, so a rename or a new theme would serve stale options indefinitely |
| 🔴 **the write route**: `channelStore.kind === 'platformAttributes'` → **merge** into `ChannelListing.platformAttributes` at the declared path, never `overrideData`; merge-only so `__offerIds` / `descriptionPush` survive; flip `editable` for those fields | **PES.5** | `products.routes.ts` (the `attr_*` arm, :2310-2460), `sheet-columns.service.ts:485`. This is AM.1 §A.4's pre-approved one addition, and it unlocks every other `pa()` field on the eBay scope, not just this one |
| 🔴 add a **`bodyHash`** to `DescriptionPushStamp` + a `currentBodyHash` input to `evaluateDescriptionStaleness` (additive; an absent `bodyHash` on an old stamp means "unknown", never "in sync") | **PES.5** | `theme.service.ts:438,579`. Without this the description cell is the one edit staleness cannot see |
| stamp the shared-listing push | **PES.5** | `ebay-shared-listing-push.service.ts:387` |
| have staleness **call** the theme resolution instead of mirroring it | **PES.5** | `themes.routes.ts:211-220` |
| the theme cell (select renderer, name-not-CUID, deleted/inactive marks, parent-only rule), the Description-sync column, `descriptionThemeId` into `CONTENT_KEYS` so it sits beside the body in the Content view | **PES.3** | `channel/ChannelSheet.tsx`, `sheet/views.ts:113` |
| the `push-description` verb (COLLECT→PREFLIGHT→CONFIRM→RUN, `CONTEXT(alias-group)`, wave-1 refusal) | **PES.3** | `channel/channelActions.ts` |
| the drawer's "Description on eBay" section + the preview opener | **PES.4** | `drawer/panes/ListingsPane.tsx` |
| 🔴 **`HtmlField`'s allowlist must become per-channel, or the eBay body must not use it** | **PES.4 + PES.2** | `drawer/fields/HtmlField.tsx:38,313` — see §5.1 |
| **ONE new DS component: `HtmlPreviewFrame`** — sandboxed `srcDoc` iframe, width preset + scale-to-fit, `ResizeObserver`, "last good frame dimmed" failure state. Nothing in the DS renders untrusted HTML today (`grep srcDoc\|sandbox=` over `design-system/**` → 0 hits) | **PES.2** | new, in `design-system/components/` |
| the theme MANAGER page at `/channels/description-themes` (rail · HTML editor + token palette · preview · usage · default/active lifecycle) | **PES.6** (owns `/channels/*`) | new page; the token palette must be **derived from the renderer**, not a second hand-written list |
| **no schema change at all** | — | `EbayDescriptionTheme` and both `platformAttributes` keys already exist |

## 8. Risks and traps

- **🔴 Every eBay listing in the fixture family is LIVE, and local dev writes the production DB.**
  A description body committed from a local studio is a real change to what the next push sends.
- **🔴 §5.1 is the top risk: the drawer's rich-text field can destroy a live body on blur with no
  edit.** Fix it before the drawer's description field is exercised on an eBay scope at all.
- **🔴 §5.2: an assignment routed to `overrideData` would look perfect and change nothing.** The
  acceptance test must be a **DB read-back of `platformAttributes.descriptionThemeId`** after ≥8 s
  (`reference_read_before_the_write_arrived`), plus a `description-preview` showing the new theme —
  the write's 200 response is not evidence (`reference_claims_must_match_their_measurement`).
- **No per-request dry run exists for the push.** `callTradingApi` gates on `NEXUS_EBAY_REAL_API`
  only, so on production the push is either refused or **real** (`ebay-trading-api.service.ts:238-246`).
  The `description-preview` endpoint is the honest rehearsal — it renders through the *same*
  `renderListingDescriptionSafe` and the *same* `resolveDescriptionMode` — but it is a rehearsal of
  the CONTENT, not of the transport. Do not present it as a dry run of the send.
- **A transport failure is an UNKNOWN outcome.** A `000`/timeout on a revise may still commit; the
  parity read-back is the discriminator, and a failed read-back must read *"verify the listing
  manually"*, never "failed".
- **Lane A cannot take a description-only revise.** Offering the verb on an Inventory-managed family
  without saying so sends the operator to Full Publish, which rewrites the whole
  `inventory_item_group` — a much larger blast radius than they asked for.
- **The theme is a fan-out.** Editing one theme changes what *every* assigned listing's next push
  sends. That belongs behind the manager's `expectedVersion` guard and its usage count, and it is a
  second reason the editor does not live in a per-product page.
- **Fill handle.** See §6.2 — the theme column must be non-editable on child rows.
- **Untouchable**: the eBay flat file keeps its `description_theme` column and its dots. Both
  surfaces will write the same store, so the studio must never assume it is the only writer — read
  the value back, do not cache it.
- **Images global per ASIN / curated galleries**: the theme's `{{gallery}}` reads the curated
  `ListingImage` rows PES.7 owns, so a bucket edit in the Images tab silently makes every eBay
  description on that family stale. The staleness column is the only thing that will say so.
- **Permission split** (`channels.sync` for themes, `products.edit` for the assignment) means an
  operator can legitimately be able to assign a theme and unable to create one. The refusal must
  name the right permission and must distinguish `no-session` from `denied`
  (`channelActions.ts:60-70`).

## 9. Open questions for the Owner (max 3)

1. **Does the theme manager live outside the studio at `/channels/description-themes` (H11), with the
   studio holding only the per-listing assignment?** *Recommended: yes.* It is account-level config
   with catalogue-wide fan-out, its own permission namespace, and a surface (HTML source + token
   palette) that has nothing to do with one product — the same argument decision 6 already accepted
   for mapping. The studio keeps the assignment cell, the preview and the verb.
2. **Should staleness include a body hash — i.e. should editing the description cell turn the row
   amber?** *Recommended: yes.* Today it does not (§5.3), which means the studio's most-edited cell
   is invisible to the only signal that says the live listing is behind. The cost is honest: many
   rows will go amber the day it ships, because many bodies genuinely have been edited since their
   last push. That is information, not noise.
3. **In wave 1, does the eBay description push stay refused like every other channel verb, or is
   "push description only" the one exception?** *Recommended: keep it refused, and say so.* The
   argument for an exception is real — it is the narrowest eBay write in the codebase (ItemID +
   Description, nothing else can move) and the only one with a parity read-back. But it still has no
   request-level dry run, so on production it is either refused or live, and `notSendableReason`
   would have to be rewritten to carve out one verb. If you do want the exception, the honest way in
   is a `dryRun` **parameter** on `POST /api/ebay/description-push` that stops before
   `callTradingApi` and returns the rendered HTML per ItemID — then the studio can rehearse it for
   real, and the carve-out is earned rather than asserted.

## 10. Effort and dependencies

| piece | lane | size |
|---|---|---|
| spec → `select` + theme options + cache stamp | PES.5 | **S** |
| 🔴 `platformAttributes` write route (+ `editable` flip) | PES.5 | **M** — unlocks every `pa()` eBay field; needs a DB read-back acceptance |
| 🔴 `bodyHash` in the stamp + staleness input | PES.5 | **S** |
| shared-listing stamp; staleness calls the resolution | PES.5 | **S** |
| theme cell + Description-sync column + Content view | PES.3 | **S** |
| `push-description` verb (preflight, wave-1 refusal) | PES.3 | **M** |
| drawer "Description on eBay" section | PES.4 | **S** |
| 🔴 `HtmlField` per-channel allowlist | PES.4 + PES.2 | **M** — a correctness fix, not a feature |
| `HtmlPreviewFrame` DS component | PES.2 | **S** |
| theme manager page | PES.6 | **L** — the old 1189-line component's whole capability set, rebuilt on the DS |

**Dependencies**: the assignment cell is blocked on the `platformAttributes` write route (PES.5) —
without it the cell must stay read-only and *say why*, which is a legitimate wave-1 state. The
Description-sync column is blocked on nothing (the endpoint exists). The preview pane is blocked on
`HtmlPreviewFrame`. Cross-feature: the **eBay images / bucket curation** feature (PES.7) is what
makes descriptions stale, so its lane and this one share the staleness signal and must not each
invent one; the **Errors & Sync console** is *not* the home for one family's staleness (a single
fact, not a queue) but the catalogue-wide "N families stale" view belongs with the theme manager's
existing `usage` endpoint at H11.
