# The full sheet, and a view builder — design for approval

**Status:** 🟢 **APPROVED by the Owner 2026-09-04 22:4x** ("Yes, I'll go with your recommendation"),
with the §7 choices settled as recommended: **V.2a YES** (an explicit, labelled default view per
scope), **V.5 export default = what is on screen**, **V.2 column order comes from the view only**.
The Owner's second word, same minute: *"everything has to be AAA quality, and I do not want it to be
slow or something. It has to be the best."* → §4a below turns "not slow" into budgets a lane can fail.
Written 22:30 from the Owner's direction of the same evening. Every number below was measured on the
local API (`:8091`, GALE-JACKET `cmokmy3a40078pm0p1fvnu523`) or read at the cited file:line; nothing
is relayed. **BUILT 2026-09-04 23:38 → 2026-09-05 00:10 in session `nexus-commerce-45`, on the
Owner's word ("Here, in this session"); §8 below is what was measured on screen. NOT committed.**

---

## 0. The Owner's words

> "Having all the attributes when I reload or when I land on that page sheet tab would be a better
> idea, because we would be importing stuff using the import button. The same goes for the export
> as well. And for the different views that we have in place, we can build a view builder to get
> specific attributes, but everything has to be AAA quality. We do not want any inconsistencies or
> any bugs or glitches at all."

Three asks: (1) the sheet lands on **every attribute**; (2) **export and import** work on every
attribute; (3) a **view builder** for the narrower, task-shaped sets — at a quality bar of zero
inconsistency between scopes and zero hidden-column surprises.

## 1. What is on screen today, measured

| coordinate | declared columns | landed by default | required | axes | contract `views` |
|---|---|---|---|---|---|
| master · IT/it | **102** (Identity 7 · Attributes 61 · Identifiers 6 · Pricing 7 · Inventory 4 · Physical 6 · Amazon 6 · eBay 5) | ~14 (rule #173) | 7 | 2 | `null` |
| Amazon · IT/it | **97** | ~14 | 7 | 2 | `null` |
| eBay · IT/it | **35** | ~8 | 1 | 0 | `null` |

- **Master lands narrow by a rule** (`_studio/sheet/master/views.ts` `defaultViewColumns`, applied
  by `MasterSheet.tsx:937` `landingPreset(…, defaultId: 'narrow')` on a first visit). The rule was
  the Owner's own approval (#173, 2026-09-01) on the measurement "134 of 155 columns are never
  populated". The channel scope applies the **same rule** by hiding the rest once
  (`ChannelSheet.tsx:1200–1208` `setColumnsVisible(hide, false)`).
- **The contract serves no views** — `views` is `null` on all three coordinates, so the rule-built
  fallback in `views.ts` has been the live path since it was written.
- **The channel scope has no Views control at all** — it declares it absent, "No saved views here"
  (`ChannelSheet.tsx:1811`). Master has presets + saved views; channel has Customise only.
  That is a §14.1 divergence the Owner's "no inconsistencies" bar names directly.
- **Column virtualisation is ON** (no `suppressColumnVirtualisation` anywhere under
  `design-system/grid` or `_studio`), so the DOM only ever holds the columns in the viewport.
  Landing on 102 columns is a horizontal-scroll change, not a rendering-cost change; the full
  contract is already fetched and every column already has a colDef (`columns.tsx` header).

### 1.1 The premise is right, and there is a second defect under it

The Owner's reason for the full sheet is import/export. Measured:

- **Export writes what is DISPLAYED** — `exportGrid.ts:117` `api.getAllDisplayedColumns()`. On the
  landed sheet that is ~14 of 102 columns. So an operator cannot get a full file without first
  ticking ~88 boxes in Customise.
- **Export is not importable at all today, at any column count.** The exporter writes ONE header
  row, the English label with ` *` on required columns (`columns.tsx:224`). The import (D15.2,
  `product-studio.routes.ts:311–318`) needs a KEY row and matches rows on a `sku` column. Run
  tonight, pure, against the live master·IT contract (`scratchpad/roundtrip-check.mts`):

  ```
  UI-shaped file : keyRowIndex 0 · 0 of 102 headers recognised · no `sku` header
  control (key row): keyRowIndex 1 · 102 of 102 recognised · `sku` present
  ```
  The `sku` is absent because the identity band absorbed the `sku` column (#714) — the file's first
  column is the band's auto-column, not a key. D15 §2.4 assigned AG.1 "export grows the key row and
  the `key.formula` sibling"; **neither landed** (no `keyRow`/`formula` in `grid/export/*.ts`). The
  ledger's D15.1 acceptance (189/189 unchanged) was produced from a key-row file, not from the
  Export button. The D15.9 template endpoint has not shipped either (ledger line 8351).

### 1.2 Two smaller defects the redesign removes rather than patches

- **Clearing a chip restores nothing when no preset is active** — `MasterSheet.tsx:865–866`
  restores `views.presets.find(p => p.id === viewId)`; after Customise `viewId` is `null`
  (`confirmPrefs` sets it), so Missing-required on → off leaves the operator on the chip's seven
  columns. Latent today; certain under a full-sheet default, where "no preset" is the normal state.
- **Three days of landing/restore machinery** (#772 → #773 → #774 → #786 bucket (b)):
  `hasPersistedArrangement`, `restoredColumnState`, the `landed`/`restored` refs, and the gate's
  Customise-reveal step exist only because the sheet hides most of itself by default and then has
  to remember what was un-hidden. A sheet whose ground state is "everything" has no hidden column
  to lose.

## 2. The design

```
  Views ▾  ──────────────────────────────────────────────────────────────────────
  │ ● All attributes (102)                     ← ground state; landing; not deletable
  │ ─────
  │   Essentials (14)     ← today's #173 rule, kept as a preset (was the landing)
  │   Content (12) · Specs (61) · Logistics (25) · Pricing (9) · Identifiers (11) · Localisation · IT (1)
  │ ─────
  │   Amazon launch (23) · default          ← the operator's saved views (SavedView)
  │   Sizes & stock (6)
  │ ─────
  │   New view…            Rename… · Duplicate · Delete · Make default / Clear default
  ──────────────────────────────────────────────────────────────────────────────
  [⚠ Missing required (7)] [Customise] [Export ▾] [Import] [Reload]
```

**V.1 — The sheet lands FULL, on every scope.** Every declared column of the coordinate, in the
§9.2 order (identity → required → axes → name/status → spine → flagged → the rest grouped in the
contract's group order). "All attributes (N)" is the sheet's ground state: first in the menu,
counted, never deletable, and identical on master and every channel×market. Supersedes the layout
doc's "Default landing view is NARROW (5–8 columns)" and §1b's "curated default view per scope".
§9.1 (required columns fit at 1440) still holds unchanged — it is a rule about ORDER and width, not
about hiding, and the required block keeps its first seven positions.

**V.2 — Reload and re-entry land FULL too.** Visibility is never restored implicitly. The one
exception is explicit: a saved view the operator has marked **default** for that scope, which is
named in the trigger ("Amazon launch · default") so the narrowing is never a mystery. Column widths,
pins and sort persist as today (they are visible and harmless); column membership and order come
from the view. A reorder drag marks the trigger "Custom (edited)"; "Save as view" keeps it.
*(V.2a for the Owner: allow "Make default" at all? Recommend YES — Akeneo and Plytix both do, and
it is the explicit, labelled opt-in that replaces today's silent one.)*

**V.3 — A view is a list of ATTRIBUTE KEYS, not an AG state blob.**
`{ v: 2, kind: 'columns', scope: 'master' | 'channel:<CHANNEL>', columns: key[] (in order),
chip?: id }`. Stored on the existing `SavedView` table (per operator, `userId + surface + name`
unique, `isDefault` already there), surface `product-edit:views:master` /
`product-edit:views:<CHANNEL>`. Resolved against the LIVE contract with `resolvePreset()` (exists,
`grid/views/presets.ts`): columns this product type lacks are REPORTED in the menu item's tooltip
and the builder ("3 of 23 not on this product type: fabric_type, …"), never dropped silently. The
v1 AG-state payload stays readable for `/products/next` (a different surface); the sheet writes only
v2. Why not the blob: AG's `hiddenColIds` is an inverted set — a view saved on OUTERWEAR applied to
a knee slider would show every column the blob never heard of; a key list says exactly what it
means on every product type.

**V.4 — The view builder IS the one Customise dialog, extended in the DS.** No second dialog
(rule: ONE Customize dialog; the Customise modal stays). `PreferencesModal` gains, opt-in so
`/products/next` and the other callers are untouched:
  (a) **group tick** — each group heading gets "tick all / clear" with its count;
  (b) **quick picks** above the list, derived from column FACTS the contract already carries, never
      hardcoded lists: `Required here (7)` · `Axes (2)` · `Editable (89)` · `Has data on this
      family (n)` · `Flagged by readiness (n)` · per coordinate `Required by Amazon·IT (7)` /
      `Required by eBay·IT (1)`. These are the rules `views.ts` already encodes, made visible;
  (c) **name + Save as view / Update "Pricing"** in the footer; the title reads
      "Customise · Amazon launch" when a saved view is active;
  (d) **Reset** = All attributes in §9.2 order (today it resets to the narrow rule,
      `MasterSheet.tsx:2110`);
  (e) a permanent **"23 of 102 in view"** counter and the search that already exists.
The dialog stays a column picker for every other grid; only the sheet passes the new props.

**V.5 — Export follows the sheet, honestly, and becomes importable.**
  - Export writes the **D15.2 header pair** (row 1 label, row 2 `key` / `key@channel:market:locale`)
    and ALWAYS emits `sku` as the first key column from row data, whatever the identity band shows.
    The band's auto-column and the readiness columns carry an EMPTY key cell; the import treats an
    empty key as an informational column and ignores it silently, counting them in the envelope
    ("2 informational columns ignored") — a re-import of an unmodified export must produce ZERO
    noise (D15.1), and reporting "Readiness" as unknown on every file is noise.
  - The Export control offers **"Export view (23 columns)"** and **"Export all attributes (102)"**.
    Default = what is on screen, so on the landed sheet the default IS everything. File names carry
    `-all` or `-view-<name>`, and `-filtered` as today.
  - "All attributes" stays CLIENT-side and uses the grid's own renderer for hidden columns too
    (`api.getCellValue` addresses any column in the model, displayed or not — to be verified as
    the first probe, it is the one assumption here); one renderer, no server formatter, D15.14.3
    intact. A server-side export belongs to D14.5 (rows above 500), not to this design.
  - `key.formula` sibling per D15.8 — only when any exported cell carries a formula.

**V.6 — Import is view-independent and stays as built.** It already matches the file's key row
against the coordinate's FULL contract (`import-diff.service.ts:238/:253` read `sheet.columns`,
never the screen). Changes: accept the empty-key informational columns (V.5), and the drawer's hint
says where a full template comes from ("Export all attributes"). D15.9's template for an EMPTY
family stays open and separate.

**V.7 — Chips stay filters and compose with any view.** A chip narrows to its cells' columns plus
identity; clearing it restores the ACTIVE column set — All attributes, a preset, a saved view, or
Custom — held as one first-class `activeColumns` object rather than re-derived from a preset id.
This closes §1.2's first defect by construction.

**V.8 — One landing function, shared by both scopes.**
`landingColumns({ contract, defaultView, arrangement }) → { columns, order, source: 'all' |
'default-view' }`, pure, tested, imported by master and channel alike (the channel imports
`defaultViewColumns` from master today; this replaces that import). Deleted: `landingPreset` call,
`hasPersistedArrangement`, the `landed`/`restored` refs, the visibility half of
`restoredColumnState`, the channel's `setColumnsVisible(hide)` effect. Persistence keeps widths,
pins, sort: master's `useGridState` grows the allow-list the channel's `persistence.ts` already has
(that file's own note says it collapses into the hook when the hook grows the option), and
`columnVisibility` leaves the list on both.

**V.9 — Product presets stay rule-built and become system views.** Essentials (#173's rule),
Content, Specs, Logistics, Pricing, Identifiers, Localisation — present wherever they match at
least one column, not deletable, **duplicable** into a saved view to edit. When PES.5's contract
`views` ever arrives (§3.1) it wins, exactly as `masterViews()` already does; tonight it is `null`.

**V.10 — Channel parity.** The channel scope gets the SAME `SheetToolbar` views control, the same
menu, the same builder; its `absent: 'views'` entry is deleted. Views are keyed by CHANNEL (the
column set is per channel; markets share it), and a channel view applied on a market that lacks a
column reports it per V.3.

**V.11 — Personal views in v1.** `SavedView.userId` scopes them to the operator, as today.

## 3. Not in v1, and why

- **URL-addressable views (`?view=`)** — would make a reload keep the view, which is the opposite of
  the Owner's ask; revisit when views are shared and links matter.
- **Shared / team views** — one operator today; an additive `shared` flag on `SavedView` when
  there are two.
- **Row filters saved inside a view** beyond the one chip — the chip registry is single-select by
  ruling #34; a filter model in a view needs the D14.3 provenance chips first.
- **XLSX**, the empty-family template (D15.9), server-side export (D14.5).

## 4. Acceptance — mechanical, on GALE-JACKET, before any lane reports done

1. Fresh context, master·IT: rendered/addressable header set == contract keys + identity +
   readiness (SET equality, not a count; #789's rule); first seven = the required set; `npm run
   layout:v2` green (7/7 at 1440 unchanged); same on Amazon·IT (97) and eBay·IT (35).
2. Customise → hide 90 → reload → 102 again. Save as view → Make default → reload → the view, named
   in the trigger. Clear default → reload → 102. Same three steps on a channel scope.
3. Export on All attributes → 2 header rows, `sku` first, 102 keys; re-import unmodified → 0 changes,
   0 unknown, "2 informational columns ignored". Export on Pricing (9) → 9 keys; re-import → 0
   changes; one edited cell → `changed 1`.
4. Chip on → off on All attributes and on Custom: header set identical before and after.
5. `check-editor-open --strict` green on both scopes WITHOUT its Customise-reveal step (the step
   becomes a no-op because nothing is hidden; bucket (b) should stop firing as a consequence and is
   recorded as such, not claimed as a fix).
6. Time-to-interactive master·IT at 1440 measured on the landed sheet against today's, and written
   down; virtualisation says it is flat, the number says whether that is true.
7. Zero raw primitives, zero new dialogs, `PreferencesModal` diff is opt-in props only;
   `/products/next` Customise unchanged on screen.

### 4a. Performance budgets — the Owner's "not slow", as numbers (measured, both scopes, 1440)

Every budget is measured on the FULL sheet against the same reading on today's narrow landing, and
written into the lane's close as a pair (before → after). A budget with no before-reading is not met.

| what | budget | how it is measured |
|---|---|---|
| sheet interactive after load (rows painted, first cell focusable) | **not slower than today** — the data payload is identical (the full contract is already fetched); the only new work is column defs already built | Performance API marks around the sheet mount, 5 runs, median, fresh context |
| horizontal scroll across 102 columns | **no dropped frames** (≥ 55 fps sustained, no long task > 50 ms) | DevTools performance trace of one end-to-end drag; column virtualisation ON is the precondition and is asserted (no `suppressColumnVirtualisation`) |
| applying a view (menu click → columns settled) | **one `applyColumnState` call, settled within 100 ms** | timestamp pair around the call; no second apply, no flash of the previous set (screenshot at +16 ms) |
| Customise dialog open with 102 rows | **< 100 ms to interactive**, search filters per keystroke without lag | same marks; the list is already sectioned by group |
| export "all attributes", 21 rows × 102 columns | **< 1 s** to download; 500 × 150 (the D14.5 ceiling) **< 5 s** | timed in the export note the toolbar already prints |
| import diff of a full export | unchanged from today's D15 figures | server-timed, already in the envelope |
| memory | no growth from mount → apply view × 10 → back to All attributes | heap snapshot pair |

Anything that misses a budget is a defect of THIS design, fixed before the lane reports done — never
"acceptable for now".

## 5. Lanes (the Owner assigns)

- **PES.2** master: V.1/V.2/V.7/V.8, the views menu and payload v2 (engine: `grid/views`,
  `useGridViews`), V.5 in `grid/export` (with AG.1 if it is running).
- **PES.3** channel: V.10 parity — consumes PES.2's engine exports, deletes its own landing effect.
- **DS.2** `PreferencesModal` extensions (V.4) — DS-owned, opt-in.
- **PES.5** import: empty-key informational columns, the envelope count, `sku` detection (V.5/V.6).
- **UX.1** probe witnesses for acceptance 1, 3 and 4.

## 6. Documents this supersedes or amends (once approved)

- `docs/2026-09-01-product-edit-studio-layout.md` "Views" (line 79–83, "Default landing view is
  NARROW") and §1b "Curated default view per scope" → superseded by V.1/V.2.
- Ruling #173 → its rule survives as the Essentials preset (V.9); its landing role ends.
- `docs/2026-09-02-wave4-design.md` §2.4 AG.1 item ("export grows the key row") → V.5, noted as
  never landed.
- `docs/2026-09-01-layout-v2-spec.md` §9.1/§9.2 → unchanged; §9.5a persistence → `columnVisibility`
  removed from what persists (V.8).
- `views.ts` header and `defaultView.vitest.test.ts` ("lands ~14 columns") → re-pointed at the
  Essentials preset; the landing tests flip to V.1/V.2.

## 7. The three choices — DECIDED by the Owner 2026-09-04

- **V.2a** — an operator MAY mark a saved view as the default for a scope. **YES.** Explicit and
  labelled in the trigger; "Clear default" beside it; landing with no default = All attributes.
- **V.5** — Export default = **what is on screen**; "Export all attributes (N)" is the second item
  in the same control. On the landed sheet the default is everything.
- **V.2** — column ORDER **comes from the view only**. Widths, pins and sort persist per scope key;
  membership and order never persist implicitly. A drag marks the trigger "Custom (edited)".

## 8. Built — and measured (2026-09-05 00:00–00:10, GALE-JACKET, Chrome at 1440×900, dev build on :3000 → local API :8091)

**What landed (files, all uncommitted):** engine `design-system/grid/views/{viewPayload,landing}.ts`
(+ tests), `views/presets.ts` (`ALL_VIEW_ID`, `allColumnsPreset`), `hooks/useGridViews.ts` (schema-2
payloads, rename / duplicate / clearDefault / markActive), `hooks/useGridState.ts` (`persistKeys`,
`viewsSurface`), `toolbars/GridViewsMenu.tsx` (New view… · Save as view… · Update · Rename… ·
Duplicate… · Make/Clear default · Delete… with an inline confirm; column counts; a note per saved view),
`export/{gridCsv,exportGrid}.ts` (D15.2 key row, `leading`/`trailing` data columns, `columns: 'all' |
keys[]`, `suffix`); DS `patterns/PreferencesModal.tsx` (opt-in `quickPicks` / `groupToggles` /
`inViewCount` / `viewSave`, mirrored byte-identical into `apps/factory`) + `styles/patterns.css`; studio
`_studio/sheet/useSheetColumns.ts` (ONE hook, both scopes), `sheet/views.ts` (moved from `master/`),
`sheet/sheetExport.ts`, `SheetToolbar.tsx` (Export ▾ two items; views fed on the channel), `MasterSheet.tsx`
+ `ChannelSheet.tsx` rewired (the landing/restore/chip machinery of #772–#786 deleted), `channel/persistence.ts`
allow-list without visibility/order; API `import-diff.service.ts` (`ignoredColumns`, `optionCodeFor`) +
`product-studio.routes.ts` (`labelRow`, `unmatchedColumns` as the objects the web mirror reads); web import
mirror + drawer line.

**§4 acceptance, each witnessed:**
1. Landing — master·IT trigger reads **All attributes (101)** (102 contract columns; `sku` lives in the
   identity band), first columns `brand, bullet_point, country_of_origin, supplier_declared_dg_hz_regulation,
   fabric_type, item_name, product_description` (the 7 required), then `color, size, name`; Amazon·IT
   **All attributes (97)**, eBay·IT **All attributes (35)**; no "no views" note on any scope.
2. Reload — Customise → None → Required here → *Save as view* "VW acceptance" → trigger **VW acceptance (7)**,
   server row `{v:2, kind:'columns', columns:[7]}`; reload → **All attributes (101)**; *Make default* →
   reload → **VW acceptance (7)** with the 7 required + readiness; *Clear default* → reload → All; *Delete…*
   → confirm → server list empty, the sheet reads Custom (7). Same menu and builder on Amazon·IT
   (Customise "In view · 97 of 97", eight quick picks) and eBay·IT.
3. Export → *Export all attributes* → `GALE-JACKET-IT-2026-09-04-all.csv`, note "21 rows · 102 columns ·
   importable": row 1 labels, row 2 keys (`sku` first, 102 keys, 0 empty). Re-imported unmodified through
   `POST /import/diff`: first run **168 refused** — 8 select columns × 21 rows, the export's LABELS
   (`Pakistan`, `Non applicabile`, `No`, `Sì`, `Nuovo`) held against stored CODES: D15.2's "code accepted
   on import too" had never been built. `optionCodeFor` landed (label → code, case-folded, boolean-typed);
   second run **2142 unchanged · 0 changed · 0 refused · 0 unknown · 0 ignored · 0 unmatched rows**. Both
   preview jobs cancelled.
4. Chip — *Missing required (43)* on → `brand, bullet_point, product_description` + readiness; off → the
   landing set back in the same order.
5. `EDITOR_ONLY=parity node scripts/check-editor-open.mjs --strict` → **PASSED, 18 parity readings equal
   to master's across the two channel scopes**, 0 API writes armed (run twice: before and after item 5a).
5a. `npm run layout:v2` (full, 24 states) went **RED on one thing the full sheet exposed**: Amazon·IT
   5 of 7 required at 1440 (+205 px) — the channel had always BUILT the schema's `sku` column and only
   hidden it behind its narrow landing; landing full put a 220 px duplicate of the identity band's SKU
   first in the centre band. Fixed as a RULE, not a hide: `RESERVED_COLUMN_IDS = ['sku']` now lives in
   `_studio/sheet/views.ts` and both scopes build the contract minus it (master imported it; the channel
   gained a `gridColumns` memo every grid-facing site reads). `LAYOUT_ONLY=9.1` after: **7/7 at 1440 with
   15 px spare on master·DE, master·IT and Amazon·IT; 1280 back to the ruled 5/7 at +145 on all three;
   exit 0.** The channel toolbar now reads All attributes (96), not 97.
6. Performance (dev build): `domInteractive` 469 ms · applying a view (menu click → columns settled) **7–30 ms
   synchronous, zero long tasks** (PerformanceObserver) · horizontal scroll across 6,000 px by wheel: **5 long
   tasks (295, 77, 94, 77, 85 ms)** as fresh column bands mount their cells — see §8a.
7. Guards: web tsc 0 · api tsc 0 · web vitest 2000/2000 · api pim 143/143 (+12 import-diff) ·
   raw-primitives / grid-kit / fork-drift / token-guard / token-resolution / css-hex / ds-conformance /
   silent-disabled all green.

8. **Round trip on the AM.1 contract (02:00–02:05, master·IT now 185 columns, 23 of them `key[]` / `key[measure]`).**
   *Export all attributes* → `GALE-JACKET-IT-2026-09-05-all.csv`, "21 rows · 185 columns · importable".
   Re-imported unmodified: **0 unknown · 0 ignored · 0 changed — and 63 refused**, three BOOLEAN columns
   (`skip_offer`, `supplier_declared_has_product_identifier_exemption`, `batteries_required`) × 21 rows, every one
   "Field not editable". Two defects under one number:
   - the export writes what the grid renders (`Yes`/`No`) and a boolean column carries no option list, so
     `optionCodeFor` had nothing to map and `"No"` was held against `false` → "changed";
   - the "change" then went to the write path's dry run under the SHEET key (`skip_offer`), which the bulk
     route only recognises for the core fields — the contract's `writeField` (`attr_skip_offer`) was never
     carried. **Every category attribute an import ever changed would have been refused, at preview and at
     apply**; the zero-change acceptance in item 3 could not see it, because a file with no change never
     reaches the write path (the boolean mismatch was the accident that did).
   Landed: `coerceByKind` (boolean words → the boolean, case-folded; other kinds untouched), `DiffCell.writeField`
   from the column contract (sheet key when none), `validateBatch` and the stored job's `writeCells` told the
   write field and answering with it (a slot write answers as its base; the outcome names the sheet key), and
   the job's "changed since the preview/import" guards compare `canonical()` (a measure object `String()`ed to
   `[object Object]` on both sides — the guard could never fire on a measure). +3 tests (18/18); api tsc 0.
   After: unmodified **3885 unchanged · 0 changed · 0 refused · 0 unknown · 0 ignored · 0 unmatched rows**;
   a copy with ONE `skip_offer` flipped `No`→`Yes` on the parent previews **changed 1 (`false`→`true`, a
   boolean) · refused 0** — the dry run accepted `attr_skip_offer`. Both preview jobs cancelled by id. Not
   exercised: the apply itself (a real write to the production row); the same code path, `dryRun` off.

Observed, not mine: in the dev build a second, hidden studio shell (an `All attributes (0)` toolbar under a
`display:none` sibling of `.h10-shell`) exists for a few seconds after navigation; one grid, one visible
toolbar. Pre-existing frame behaviour, noted for the frame's owner.

### 8a. The one budget with a red reading: horizontal scroll in the dev build
Applying views, landing and the dialog are inside budget. Scrolling 101 columns is where the full sheet pays:
each new band of ~24 columns mounts ~500 React cell renderers (21 rows), and in the DEV build (React
development mode + StrictMode double render) that costs 77–295 ms per band.

**Production build, measured 00:20 (`next build` into a private `.next-vw`, `next start` on :3100, the API
reached through a measurement-only CORS proxy on :8092 → :8091; same tab, same 1440 window, same six
wheel scrolls across the same 6,000 px):** **ONE long task, 121 ms**, against five of 77–295 ms in dev;
applying a view **11 ms synchronous, zero long tasks** (dev: 7–30 ms). `domInteractive` 819 ms through the
proxy on a cold route. So the full sheet costs the operator one ~120 ms hitch the first time a never-
rendered band of columns scrolls into view, and nothing on any other gesture. That residual is the CELL
RENDERER's weight (`renderers/cells.tsx`, b0's file — provenance mark, tooltip composition, class rules per
cell), not the landing rule; if the Owner wants it under 50 ms, that is where it is spent. The build
directory and proxy were removed after the reading.

## 9. The LOCK contract (Owner, 2026-09-05 00:3x: "perfect the mechanism of the lock in the column on both pages … update the customized column component in the design system so it can be reused and tested … select the sets of columns in bulk")

Measured before designing: the padlock in the Customise dialog rendered only where a caller round-tripped `lockedColumns` — master yes, the CHANNEL scope no (parity gap), `/products/next` yes; a lock on master pinned nothing but `product` (the bridge marked only that key `locked`), and on `/products/next` a lock became `lockVisible`/`suppressMovable` colDef flags while the bridge declared no locked column at all; the dialog never learned of a header-menu "Pin left" because `columnStateToPrefs` carried `previous.lockedColumns` through. Three pages, three meanings of one padlock.

ONE meaning, both pages, both studio scopes:
- A LOCKED column is FROZEN at the left of the scrolling band (AG `pinned: 'left'`), always visible, in a
  contiguous block right after the grid's structural lead columns (selection column, the identity /
  tree column). Locking = freezing. Unlocking = releasing it back into the scrolling band at its place.
- The dialog's `PreferencesValue.lockedColumns: string[]` is the operator's lock set IN FROZEN ORDER
  (left → right). It is the ONLY representation. Structural locks (`PrefsColumnMeta.locked` /
  `PreferencesColumnSpec.locked`) are the grid's own and are never in this list.
- Engine (`design-system/grid/columns/columnPrefs.ts`):
  * `prefsToColumnState(prefs, bridge)` emits, for EVERY togglable column, an explicit `pinned`:
    `'left'` for a key in `lockedColumns` (block placed right after the structural lead columns, in
    `lockedColumns` order), `null` for every other togglable column. `hide: false` for locked ones
    even if absent from `visibleColumns` (a lock implies visible). This REPLACES AG.1-c's "omit
    pinned for movable columns" — see the rule for callers below, which is what makes it safe.
  * `columnStateToPrefs(state, previous, bridge)` DERIVES `lockedColumns` from the grid: togglable
    columns whose `pinned === 'left'`, in displayed order (structural lead columns excluded). It never
    carries `previous.lockedColumns` through when the grid has an opinion.
- Rule for callers (studio sheets, /products/next): NEVER apply a `PreferencesValue` whose
  `lockedColumns` was not read from the grid (`columnStateToPrefs(api.getColumnState(), …)`) or
  confirmed by the operator in the dialog moments ago. A view/preset/chip application reads the
  current locks from the grid first, so an operator's header-menu "Pin left" is a lock and survives
  every view change (that is the AG.1-c regression, prevented by construction instead of by omission).
- Dialog (`patterns/PreferencesModal.tsx`): the padlock appears whenever the caller round-trips
  `lockedColumns` (rule unchanged, but EVERY rebuilt caller now does — master, channel, /products/next).
  Locked rows form the top block of "In view" (after immutable locks), cannot be removed (✕ hidden),
  can be reordered only within the block; the tick-list shows a lock glyph on a locked entry and its
  tick is disabled (a lock implies visible). Tooltip: "Lock — frozen at the left while you scroll" /
  "Unlock — back into the scrolling columns". Group "All / Clear" toggles and the "In view · n of N"
  count are ON by default for every caller (Owner: "select the sets of columns in bulk").
- Persistence: the studio persists `columnPinning` per scope key (already) — so locks survive a
  reload through the grid's own pins and read back into the dialog via `columnStateToPrefs`.
  /products/next persists `lockedColumns` in its page state and views (already).
- Reset to default: locks return to the caller's `defaultLocked` set (identity on the studio;
  `product` + `actions` on /products/next), every other column unpinned.


**Status:** engine + dialog LANDED 00:50 (`columnPrefs.ts` 43 tests; `patterns/preferencesLogic.ts` 51 tests; dialog defaults on). Studio + `/products/next` wiring, the factory mirror, the guards and the on-screen pairs are running as parallel lanes; results are appended below when they land.

### 9a. Built and measured (2026-09-05 00:50–02:25; three Opus lanes + this session; GALE-JACKET; Chrome — the window would not leave 1728 CSS px, so every reading below is at 1728×962, not 1440×900)

**Engine / DS (this session):** `grid/columns/columnPrefs.ts` — an operator lock is a `pinned:'left'` block after
the structural lead, in lock order; `pinned` stated for every togglable column; `columnStateToPrefs` derives
`lockedColumns` from the grid's pins (43 tests). `patterns/preferencesLogic.ts` (pure, 57 tests) + `PreferencesModal.tsx`:
frozen block on top of "In view", lock ⇒ visible, unlock lands right after the block, group **All/Clear** and
"In view · n of N" default ON, `quickPicks` / `viewSave` opt-in. Fixed after the DS-QA lane's readings: a locked
column absent from `visibleColumns` no longer vanishes from "In view" (filter on the effective lock, not the
structural flag); "n of N" counts visible-or-locked over every non-structural column, so a lock shrinks neither
side (was "9 of 11" after one lock). Fixed after the two wiring lanes' readings: `lockSide: 'right'` on a spec lists a
right-frozen bookend LAST in "In view" and refuses a drag between the edges (`/products/next`'s `actions` read at
the TOP with the left locks); **Reset to default changes only what the dialog shows** (a caller with no sort
control keeps its sort, no sticky controls keep the flags, no page-size choice keeps the size — Reset had written
`sortBy:'updated'` and `stickyLastColumn:true` into `/products/next`, which had to neutralise them after every
confirm). Factory mirror byte-identical; `.d.ts` regenerated (17).

**Studio (lane):** `useSheetColumns.ts` reads the operator's locks OFF THE GRID one call before every apply
(`gridLocks(api)`; a header-menu "Pin left" is a lock nobody's React state hears about), `applyCustom(keys, locks)`
carries the one set the grid cannot know — an unlock from the dialog; the `lockedColumns` hook argument is GONE (a
copy went stale on the first header pin). Master keeps only the identity padlock in state; the channel gained
`lockedColumns`, Customise + **Reset in the header menu** (it had neither), and its identity row is `locked: true`
(AG's `lockPinned` would refuse the unlock the padlock promised). Measured on master·IT AND Amazon·IT, each pair
before/after: lock `brand` → `[SEL, ID, brand]` frozen through a 3,000 px scroll · reload keeps it (persisted
`columnPinning`) and lands full · header "Pin Left" on `fabric_type` → shows locked in the dialog at index 2 · a
preset (Essentials) leaves the block alone · unlock → the column lands FIRST in the scrolling band · Reset →
`[SEL, ID]`, "All attributes (184 / 185)". This session then fixed the one thing the lane found on the channel: after
Reset `resetColumnState` put the identity band back on its FLOOR width and the SKU clipped until a reload — the
derived width is re-stated after the reset (measured: 404 → Reset → 404, no overflow).

**/products/next (lane):** `STRUCTURAL_COLUMNS` / `composeLocks` / `structuralPinState` / `withStructuralLocks` in
`columns.tsx`; the bridge is built from the lock set it is APPLYING; locks read from the grid on mount and on every
view/last-used restore; `onColumnPinned` syncs; `maintainColumnOrder`. Three defects found under the lock flow and
fixed there: `hide` (a STATE prop AG re-applies on every `columnDefs` update — ticking Brand never stuck) → `initialHide`;
a sort-only `initialState` un-hid everything (`defaultState.hide = null`) → the default state names its hidden
columns; `maintainColumnOrder` was false, so a definition sweep restored declaration order. Measured pairs: lock Price
→ `[selection, product, price]` left + `actions` right, frozen through a 290 px scroll · reload keeps it · a stale
`leftColIds: []` blob reconciles to the identity pinned at 463 with no dead strip · header "Pin Left" on Status →
the dialog learns it · Compact/Spacious and the Owner's pre-contract default view leave the block alone · unlock →
front of the band · Reset → `[selection, product]` + `actions`. Read back here: "In view" now lists
Product (locked) … Last updated, Actions (locked) — 10 of 12.

**Verification (this session, 02:20–02:25):** web tsc **0** · api tsc **0** · vitest studio+grid+patterns **1968 +
57** · api import-diff **18** · guards: fork-drift, raw-primitives (4392 ≤ 4692), token-resolution, p3-token-sweep,
ds-conformance, css-hex/radius/shadow ratchets, css-parse, alias-form, dark-alias-scope, grid-kit, context-boundary,
ds-gaps, tokens:check (web + factory) **green**. **Red, not from this work:** `check-shell-pin-fresh`
(`--nds-grid-ai-draft-bg` unpinned/scoped, `--nds-topbar-bg` pin stale — other lanes' token work in the tree);
`check-route-prisma-ratchet` (5 route files above baseline, incl. `product-studio.routes.ts` 0→2 — the two calls are
the overrides DELETE route already in HEAD, not this session's diff); `check-control-census` refused to start while
b0's parity gate held the lock — re-run 02:28: **green, but taken while the build moved** (b0's `isShaped` fix
landed 02:25:02–02:25:26 in `grid/renderers/index.ts`, `ChannelSheet.tsx`, `CascadeCell.tsx`); re-run on a quiet tree 02:57:06→02:57:24:
**green**, 8 surfaces. **Parity** (b0, run 3, quiet tree 02:43:58→02:55:38): **PASSED, 22/22** channel readings equal to master's on
AMAZON·IT and EBAY·IT. **Contract block** (same run): **PASSED, 240 assertions** across master·DE / AMAZON·IT / EBAY·IT, list and
measure editors measured on all three, 0 API writes armed. `LAYOUT_ONLY=9.1 npm run layout:v2` 02:29: **exit 1 for the predicted
reason** — W-4 on master·DE and Amazon·IT, the gate's hardcoded pre-AM.1 key set (`item_name`, `bullet_point`,
`product_description`) against a contract that serves `name`, `bulletPoints_1`, `description`; the run also reported itself
DISTURBED (a build moved at 02:25 on files not touched by this session). No §9.1 number is readable until the gate
derives its set from the contract. One stray **NUL byte** the studio lane left in a comment of
`useSheetColumns.ts` was found (grep went silent on the file; tsc did not care) and removed.

**Not verified:** 1440×900 (see above) · the import APPLY (a production write; the dry run is the same code) ·
unlocking master's identity padlock · channel "Save as view" with locks (no server rows written, by rule) · eBay
scope and DE market for the lock flow · grouping + locks · `/products/next` with every column visible (AG may omit
`columnVisibility` from the state and `initialHide` would re-hide the two defaults on reload — unmeasured).

**Left open, named:** `useGridState.bind` never applies a schema-1 DEFAULT view's page state on mount (pre-existing;
`/products/next` does not apply `views.defaultView` itself) · `scripts/check-layout-v2.mjs` §9.1 hardcodes the seven
pre-AM.1 required keys and will abstain vacuously until they are derived from the contract · §8's column counts
(101/96) are pre-AM.1; the contract now serves 184 (master·IT) / 185 (Amazon·IT).
