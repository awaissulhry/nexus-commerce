## Listbox: a held option with its reason in a form picker — 2026-10-07

- **`ListboxProps.options`** is typed `ListboxPanelOption[]` (was `ListboxOption[]`): a picker can list a held option (`heldReason`: reachable, announced, never chosen) with its reason as the `note` line under the label, which the panel already drew; every `ListboxOption[]` still fits and nothing renders differently. First use: the Matrix bulk Edit's field list. Mirrored between Web and Factory (`Listbox.tsx`).

## LockGlyph: a locked cell's lock is an outline icon, not the 🔒 emoji — 2026-10-07

- **`LockGlyph`** (`grid/renderers/cells.tsx`): the outline `Lock` (11px, the held Status and Action cells' icon) in the
  muted grid ink (`--nds-grid-muted-fg`); its accessible name is the reason. `LockedCell` (every `lockedColumn`: the FBA
  qty on the Matrix and the Information page) and the inventory grid's read-only stock cell draw it. The Owner found the
  emoji out of place. Mirrored between Web and Factory (cells.tsx, renderers/index.ts, grid.css).

## ActionConfirm: a button that names the action; an inline question with a title's room — 2026-10-06

- **`ActionImpact.confirmLabel`** (`grid/actions/registry.ts`): the primary button's words ("Raise to Auto", "Stop now",
  "Save 3 changes"); "Confirm" when absent, so every existing caller is unchanged. Asked by the Control Room rebuild's
  review: every confirmation there said only "Confirm". Mirrored between Web and Factory (registry.ts, ActionConfirm.tsx).
- **Inline `ActionConfirm`** (a drawer's `overlay`): the question line gets the size of a title and room under it; it ran
  into "What this changes". Web and Factory components.css.

## StepUpModal joins the patterns; EditModeBar can hold Apply alone — 2026-10-06

Ads autonomy W1-4 (the Control Room's Strategy tab, the Approvals page's code box for a request that raises).

- **`StepUpModal`** (`patterns`, promoted from `app/settings/ai/claude/StepUpModal.tsx`, its third user): the one
  question before a raise — a sentence naming what rises, the 6-digit authenticator code, the API's answer. Same props
  as before plus `confirmLabel` (say what happens: "Approve", "Save"). New: after a refused code the field takes the
  focus again with the wrong code selected (the input is disabled while the code is checked, which dropped the focus;
  found in the W1-4 keyboard check). Styles `.nds-stepup` / `.nds-stepup-note` in `patterns.css`. Settings › AI › Claude
  and the Approvals page's "Automate this kind…" import it from here; nothing else changed for them. Catalog
  `#step-up-modal-example`.
- **`EditModeBar applyDisabled`**: holds Apply alone while a check runs or a problem is open; Discard stays. Mirrored
  in Factory (the file is identical there).
- **`.nds-actionbar` wraps** (EditModeBar, BulkActionBar): on a narrow screen the buttons go on a line under the
  sentence instead of running past the edge (measured at 390 px: "Review 1 change…" sat 40 px off-screen and the
  sentence squeezed to a 60 px column). Unchanged wherever the bar fits on one line.

## Scrolling strips: the scrollbar gets a band below the tabs, never over them — 2026-10-05

Owner (the Publish window's market tabs): "the scrollbar appears above or is layered above the text or the tab buttons". A macOS overlay scrollbar takes no room and is drawn over the bottom of the scroll box — the labels, the active underline, the focus ring. Mirrored in Factory (`Tabs.tsx`, `ScopeBar.tsx`, `GridToolbar.tsx`, `MediaBoard.tsx`, `components/index.ts`, `grid.css`, the new hook and `lib/horizontal-overflow.ts`, the tab / scope / media-board rules, the catalog example).

- **`useHorizontalOverflow(ref, { enabled?, settleMs? })`** (`components`, new; rule in `lib/horizontal-overflow.ts`, tested): marks a strip `data-overflows="overlay" | "classic"` ONLY while it scrolls sideways (a scroll box, scrollbar not hidden, content wider); a classic bar also gets its measured height in `--nds-scrollbar-size`. Direct DOM writes, only on a change — no state, no re-render; follows the strip and its children (ResizeObserver + MutationObserver); first mark before paint. `settleMs` waits for a strip whose children fold after they render (the sheet toolbar: marking at once made it jump 14px and back on every load).
- **The band: 14px (`--nds-space-14`), measured** in Chromium on macOS: a thin overlay thumb is 6px, 1px off the edge, and widens under the pointer to a 14px track. Every scrolling strip uses `scrollbar-width: thin`. A classic bar takes its own room, so it gets no band — only a fixed-height host grows by it.
- **`Tabs`** — every strip (a host may scroll it: the subheader tabs, a page's `overflow-x`): 4px focus room + the 14px band below the tabs. md / lg keep the hairline where the active underline meets it (the border turns transparent, the same line is drawn above the band); `sm` has no hairline. A host that fixes its height around an `sm` strip must grow with it (`:has(> .nds-tabs[data-overflows])`) — none scrolls today.
- **`ScopeBar` chips** (fixed 44px / the workspace scope's 40px floor): the band hangs below the chips and the bar grows at its bottom — chips, label and controls stay exactly where they were (with a classic bar they no longer squash upward). Wrapped (≤ 760px, ≤ 719px in the subheader): the chips' line grows instead and the label keeps to the chips.
- **Sheet toolbar** (`.nds-grid-sheet .nds-toolbar`, 40px, scrolls at ≥ 1280px): grows by the band (overlay) or the bar's height (classic); controls stay centred in the same 40px.
- **`MediaBoard slots`**: the band sits under the last row, off its frame and captions.
- Unchanged when a strip fits: same boxes, measured before/after on every strip. Catalog: `#scrolling-tabs-example` (md + sm scrolling, sm fitting).

## Accounts panel: a scope chip shows the state the server sends — 2026-10-05

Ads wave 4d (Settings → Channels → Accounts showed every Amazon Ads profile as active). Mirrored in Factory (`accounts-panel.ts`, its test, `AccountSwitcher.tsx`).

- **`ScopeRow.state`** (`lib/accounts-panel.ts`, and `AccountRow.scopes[].state` in `AccountSwitcher.tsx`): optional text the server sends when it knows better than the scope's `isActive` — an Amazon Ads profile's "Live · writes on", "Reading only" or "Not read". `scopeChipLabel` draws `label · state` in place of the "· inactive" mark; absent or blank = unchanged.

## Grid: the empty state's action can be clicked — 2026-10-05

- **`GridNoRowsOverlay` `action`** (`grid/theme/grid.css`): AG sets `pointer-events: none` on `.ag-overlay` and re-enables it only for its own loading and export overlays, so the no-rows action ("Clear filters") was drawn but never reachable by pointer — the rows layer took the click (found by the approvals grid's browser check). `.nds-grid-noRows` takes pointer events again; the rest of the overlay stays click-through. Mirrored in Factory (`grid.css` is identical there).

## Approvals grid parts: before → after, two row verbs, a live countdown, grid shortcuts — 2026-10-05

`docs/approvals-grid/PLAN.md` §8 C (gaps G1, G2, G7, G8 of `docs/approvals-grid/research/03-design-system-grid.md`). Mirrored in Factory: `cells.tsx`, `rowVerbs.ts` (new), `menuAdapters.tsx`, `components/index.ts`, `Countdown.tsx` and `countdownTicker.ts` (new). Web only: `ChangeCell.tsx`, `changeValue.ts`, `presets.ts`, the shortcut hook, the grid barrel, the `.nds-change*` / `.nds-countdown` styles (`components.css` already differs), the catalog and the tests.

- **`ChangeValue` / `ChangeCell` / `changeColumn`** (`grid/renderers`, G1): before → after — the old value muted (`--nds-text-muted`), an arrow, the new value strong; `from: null` draws "→ €44.90" (a new value), `to: null` "€49.90 → removed". `compact` is the grid row: the first change on one line that ellipsizes inside its column, then "+N more". The drawn lines are `aria-hidden`; a screen reader hears one sentence per line ("Price: from €49.90 to €44.90; and 2 more changes"), every known line even in a compact cell. `changeColumn(field)` sets the tooltip (all lines), the CSV / clipboard text and the quick-filter text from the same words (`changeValue.ts`); never `[object Object]`, not sortable.
- **`actionsColumn({ primary })` takes one verb, two, or a function of the row** (G2): `RowVerb { label, tone: 'primary' | 'default' | 'danger', href?, onClick?, disabled?(row) → reason, ariaLabel?(row) }`. `danger` is the red outline (`danger-outline`), never the fill. A held verb stays focusable (`aria-disabled`, the reason as a portal tooltip and `aria-description`) and does nothing on click. A click anywhere in the actions cell is flagged for AG (`keepFromGrid`, capture phase) so it never fires `rowClicked` / opens the row's drawer; the button's own handler still runs. Two verbs or a function: width 200 and `suppressKeyboardEvent: rendererOwnsKeyboard`, so Tab walks Approve → Reject → ⋯. The single-object form is unchanged — same markup (tested byte-for-byte against the previous cell), width 120, no keyboard change; the `⋯`-only form stays 56. `actionVerbs({ actions, onSelect, show: ['approve', 'reject'] })` draws the buttons from the action registry (held with the registry's reason, hidden skipped); `actionMenuItems({ …, omit })` keeps the `⋯` from repeating them. `rendererOwnsKeyboard` is now exported from `@/design-system/grid`.
- **`Countdown`** (`components`, G7): "Runs in 14 s" — seconds under a minute, then minutes, hours, days, stepping every 30 s; ONE shared timer for the whole page (`countdownTicker.ts`), armed for the soonest change and none while the tab is hidden (it catches up on return); an instance re-renders only when its words change. `onDone` once, when it reaches zero on screen (not for a moment already past at mount). Polite screen-reader updates at 60, 30, 10 s and zero, cleared after 4 s; `announce={false}` for a page with its own live region. A component of its own rather than an `AsOf` mode: `AsOf` is an observation stamp ("checked 5 min ago"), a countdown is a deadline with an end the page acts on.
- **`useGridShortcuts(containerRef, shortcuts)`** (`grid/hooks`, G8): single keys (A, R, Enter, Escape, X…) bound only while focus is inside that grid; never with Ctrl/⌘/Alt, while typing (inputs, selects, contenteditable, comboboxes), in an open cell editor, in a menu inside the grid or while a modal outside it is open; Enter/Space stay a focused button's; an auto-repeat runs only shortcuts that ask for it. Returns the hint list (`key`, `keyLabel`, `label`, `disabled`, `reason`) for a `Kbd` legend. The filter is `matchGridShortcut` (pure, tested in node).
- Catalog: `#change-value-example`, `#countdown-example` (Components › Countdown), `#row-verbs-example` with `#grid-shortcuts-example` (a small approvals grid: two verbs, a held verb, a countdown status, a click that opens the row, the A/R/Enter/Esc legend).
## Paste: a list member is found by its accepted spellings too — 2026-10-05

Product sheet consistency wave 3, W3-2 (Amazon in English). Mirrored in Factory (`shapeValue.ts` and its `.d.ts`).

- **`parseShape`** (`grid/editors/shapeValue.ts`): the column may carry `optionAliases` (code → other spellings, never shown), and a list member pasted or typed under one becomes its code through `optionCode`, as a select does. Amazon's columns now name their options in English ("Black") and keep the market's words ("Nero") as accepted spellings. Absent = unchanged.

## Paste: a select code is also found by its accepted spellings — 2026-10-05

Product sheet consistency wave 3, W3-4 (eBay, Shopify in plain English). Mirrored in Factory (`scalarValue.ts` and its `.d.ts`).

- **`scalarValue.ts`**: `ScalarColumnLike.optionAliases` (optional, code → other spellings) — never shown; `optionCode` (paste, typing, lists through `parseShape`) matches a label OR an accepted spelling, and a text two codes answer to still selects none. The eBay condition column now shows English names ("New with tags") and keeps the market's words ("Nuovo con etichette") as accepted spellings. Absent = unchanged.

## Words: one off-list sentence for every sheet cell — 2026-10-05

Product sheet consistency wave 3, E3 (`docs/product-sheet-consistency/wave3/plan-W3-names.md` item 5). Mirrored in Factory (`sheet.ts`, `sheetColumn.ts`), except the tests and `GRID.md`.

- **`offListSentence`** (`grid/editors/sheet.ts`, new): THE off-list sentence, the same words as `@nexus/shared/off-list-message` (the server's readiness, publish checks, formula warnings and AI drafts say it too; `sheet.vitest.test.ts` pins the two equal). Channel list: `Season: "Tutte le stagioni" is not on eBay's list. eBay may refuse it. Allowed: Estate, Inverno, … (12 in all)`; the column's own list: `Season: "X" is not one of this column's options. Allowed: …`. At most 8 allowed values, then how many in all. No final full stop (the DS punctuation rule).
- **`selectValidation`**: new optional fourth argument `words` (`OffListWords`: `field`, `channel`, `optionLabels`). Its off-list warning was `"X" is not in the channel's list — it may be rejected at publish`, on Shared lists too.
- **`sheetValidationFor`**: a select column's warning names the column (`label`) and its options in the cell's words (`optionLabels`); new optional third argument `{ channelList: true }` says the options are a channel's list, named from the column's coordinates (`listChannelOf`, new: the one channel every key of `channels` shares). Without it (the Shared scope, Cell details) the sentence speaks of the column's own options. `SheetColumnLike` gains optional `label`, `optionLabels`, `channels`.
## Words: unit symbols in the measure picker; a list header may carry the required mark — 2026-10-05

Product sheet consistency wave 3, "One name for one thing" (W3-6). Mirrored in Factory (`shapeFormat.ts`, `MeasureEditor.tsx`, `slotListColumn.ts`).

- **`unitChoiceLabels(units)`** (`grid/renderers/shapeFormat.ts`, new): a channel's unit codes as people choose them — `KILOGRAM` reads "kg", `CENTIMETER` "cm"; the value stays the code, stored and sent unchanged. Two codes with one symbol keep their code beside it ("kg (KILOGRAM)"). **`MeasureEditor`**'s unit list, **`shapeTooltipLine`** ("1.2 kg · units: kg, g, lb, oz") and **`shapeValidation`**'s unit warning ("\"lbs\" is not one of the channel's units (kg, g)") show the symbols; they showed the codes.
- **`slotListColumnDef`**: optional `headerName` — the header when it says more than the list's name (the sheets' required mark, "Bullet points *"). Absent = `label`, as before; the editor and the tooltip keep `label`.

## Sheet footer start slot and the unsaved row — 2026-10-05

Add rows R1 (`docs/sheet-ids-sku-rows/PLAN.md`, C-add-rows.md). `grid.css` mirrored in Factory; `GridSheet.tsx` is web only (Factory has no grid hosts).

- **`GridSheetStatus start`** (optional): the status strip's START slot, bottom left before the row count — the product sheet's "Rows to add" count and its "Add rows" button or menu. It never shrinks and a hairline sets it apart from the tallies. Absent = the strip's markup is unchanged.
- **`GRID_SHEET_STATUS_WIDE`** (`nds-grid-sheet-status-wide`): marks a part of the start slot that leaves the 36 px footer at phone width (≤ 760 px), so only the action shows.
- **`UNSAVED_ROW_CLASS`** (`nds-row-unsaved`, apply with `rowClassRules`; `grid/hosts/unsavedRow.ts`): a row the person added and has not saved — a DASHED `--nds-warning-strong` bar at the row's start edge (the inactive row's solid bar means "does not sell"), its other cells muted (`nds-cell-full-strength` opts a cell out). Never a whole-row tint. The words ("Not saved") are the host's, in the row's identity cell.
- **`isUnsavedRowData(data)`**: such a row's data carries `unsaved: true`. **`isExportedRow`** (`grid/export`): the CSV export leaves an unsaved row out, as it leaves out pinned rows and footers (it is not a record). Every other row exports as before.
- Catalog: `#sheet-footer-start-example` (web).
- **Live region** (browser check, same day): with a `start` slot the strip is no longer the live region itself — the start slot sits beside a `.nds-grid-sheet-status-live` (`role="status"`, `aria-live="polite"`) that holds the tallies, the note and "Saved", so a screen reader never announces the Add rows controls as status text. Without a `start` slot the strip is unchanged (it stays the live region). CSS mirrored in Factory.

## Cell editor: a host's line about what the edit reaches — 2026-10-05

Sheet Item IDs + per-channel SKU (S11, the product sheet's editable first column). Mirrored in Factory (`FormulaCellEditor.tsx`, its test, `grid.css`).

- **`CellEditorContext.notice`** (optional `{ text, tone?: 'info' | 'warning' }`): one line under the value editor's field while typing, naming what the edit reaches — the product sheet's SKU column says "This SKU is for Amazon · DE only. Other channels and markets keep GALE-M. To change it everywhere, edit it in the Shared view." in a channel scope, and what a rename does on the Shared scope. An icon carries the tone (AlertTriangle / Info, never the colour alone); the line is part of the field's `aria-describedby`, so it is heard with the field. Absent = no line; every existing editor is unchanged. CSS: `.nds-formula-notice` (`--nds-text-2`), `.warn` (`--nds-warning-text`), both themes. Catalog: `#formula-editor-example` (Gloves' Title).

## Words: an unlinked row is never listed as new — 2026-10-05

Sheet Item IDs + per-channel SKU, step S10 item 6 (`docs/sheet-ids-sku-rows/PLAN.md`, I1's unlink trap). Mirrored in Factory (`sellingStatus.ts`, `publishAction.ts`, `renderers/index.ts` and their tests), except `sellingStatus.shared.vitest.test.ts`.

- **`sellingStatus.ts`**: `NewListingCellFacts.deleted.unlinked` (optional) — a row Nexus UNLINKED (the listing may still be live on the channel; Nexus no longer updates it) reads "unlinked 5 Oct" (`UNLINKED_MARK`) beside whatever it holds, never "lists again"; its screen-reader head is the word alone (never "Lists again: Active"); its editor's current choice notes `NEW_CHOICE_UNLINKED`. Absent = unchanged.
- **`publishAction.ts`**: `PublishActionValue.unlinked` (optional) — such a row is drawn quiet (left out whatever its Status says) with `UNLINKED_ROW_LEFT_OUT_HINT`, never "Set Status to Active to list it again". Absent = unchanged.

## Words: Partial update says when Publish sends no field — 2026-10-05

Product sheet consistency wave 2, "Shopify + Etsy honest words" (D5, D13). Mirrored in Factory (`publishAction.ts` and its test).

- **`publishAction.ts`**: `PublishActionValue.partialNote` (optional) — on a row where Publish sends none of the fields (a product already on Shopify, Etsy) the Partial update cell's tooltip and screen-reader sentence say that note instead of "Publish sends only the fields you changed." Absent = unchanged. `sendModeEditorOptions`: a Partial update choice with a `warning` notes "The default. <warning>" (`sendModeDefaultNote`, exported from `grid/renderers` for the Shared scope's editor); without one it keeps `SEND_MODE_DEFAULT_NOTE`.

## Words: the translation marks say the fact, not an action the sheet cannot do — 2026-10-04

Shared Cell details (`docs/shared-cell-details/PLAN.md`, "Words fixed in the same PR"). One change in `provenanceTooltip` for both sheet scopes — the Shared scope's per-page `tooltip` override is gone. Mirrored in Factory (`provenance.ts`), except the tests and the `/design/language-axis` page.

- **`outdated`**: "Out of date — {from} changed after this translation was written" (dropped "Compare with the source; translate again or mark reviewed": no sheet scope has a per-cell translate-again or mark-reviewed).
- **`ai` / `aiStale` with a `from`** (a machine translation; the sheets pass "the source text"): "Translated by machine and not reviewed yet" / "Translated by machine from an older value — {from} has changed since" (were "Drafted by AI and not yet approved — review …" / "… Compare with it before approving": the AI drafts review approves AI drafts, not translations). **Without a `from`** (a PES.8 AI draft of the cell) both keep their sentences.
- `/design/language-axis`: the legend's `ai`, `aiStale` and `outdated` rows read the machine-translation words and name what an edit does instead of the old advice.

## Words: a channel refusal names the Shared product, not "the master sheet" — 2026-10-04

Shared Cell details (`docs/shared-cell-details/PLAN.md`). Web only (Factory has no `refusalWords.ts`).

- **`refusalWords`** `channel-not-writable`: "… is not writable on this channel — edit it on the Shared product." (was "on the master sheet"; the UI calls it the Shared product since PR #250).

## Channel cell marks: one mark for both sheet scopes, four channel members, a full accessible name, AAA mark inks — 2026-10-04

`docs/channel-cell-marks/PLAN.md` (approved 2026-10-04). The product sheet's channel scopes (eBay, Amazon, Shopify, Etsy) draw their cells with the same part and the same rule as the Shared scope: no mark on a cell that simply follows Shared, a small mark only where the value differs or the next action does. Mirrored in Factory (`provenance.ts`, `provenanceMark.tsx`, `MarkedValue.tsx`, `SlotListEditor.tsx`, `slotListColumn.ts`, `variationTheme.tsx`, `shapeColumn.ts`, `renderers/index.ts`, `grid.css`, the mark tokens), except the catalog example and the tests.

- **`MarkedValue`** (`grid/renderers`, new): the one marked-cell layout — mark (nothing for `own`) · value text (the ellipsizing box) · `trail` (the select chevron) · `after` (cell action, save marks), the last two as siblings of the text. The Shared scope's `withMark` and the channel scopes' `CascadeCell` both draw it; channel cells no longer draw `SourceIndicator`.
- **Four `CellProvenance` members** (`@nexus/shared/cell-provenance`), each with its own glyph (ruling #16): `pending` Clock "Waits for Publish" (the same clock the Status and Action pills use), `attention` AlertCircle "Needs attention", `listingValue` Store "Listing value" (the listing still holds its own older text), `listingLevel` Layers "One value for the whole listing" (an eBay item specific on a variation row). `classifyProvenance` does not produce them — the Shared scope and the Variants tab keep their verdicts (a sweep pins main's verdict counts); the product sheet's channel verdict does.
- **`provenanceTooltip`**: a sentence for each new member. `pending` and `attention` return the server's sentence verbatim, like `refused`. User words say "the Shared product", never "the master" (`inheritedOverride`; `describeCellSource`'s fallback names the layer in words instead of "master tier"). One punctuation rule: no DS sentence ends with a full stop (the `refused` fallback, `outdated`, `aiStale` and the language pin sentence lost theirs); a server sentence stays verbatim. `listingValue` uses the typographic ’, as Cell details does. Labels: `mappedShared` "Derived per product, shared by every alias", `aiStale` "AI-drafted, out of date" (no second dash or a `·` inside a label, so "label — source" reads as one dash). New optional third argument `by` (`mapped`, `mappedShared`): the rule that derives the value when it has a name — "Derived by the reusable rule “Racing theme” from the Shared product"; absent = "a mapping rule", so every existing sentence is unchanged.
- **`provenanceClassRules`**: `nds-cell-is-awaiting-publish` (no tint — never the save tracker's `nds-cell-is-pending`), `nds-cell-is-attention` (the warning wash `outdated` wears), `nds-cell-is-listing-value` (the pinned wash), `nds-cell-is-listing-level` (no tint, like `mappedShared`).
- **`provenanceLabel`, `PROVENANCE_PRECEDENCE`, `strongestProvenance`** (new exports): the mark's words in one typed table, and the one order for picking a mark from several facts — refused › attention › pending › aiStale › ai › outdated › formula › listingLevel › listingValue › mappedShared › mapped › inheritedOverride › inherited › pinned › own.
- **`ProvenanceMark` — one SENTENCE for `title` AND `aria-label`** (both scopes): `tooltip` when a host gives one, else `provenanceTooltip(member, from)` for EVERY member, else the label (only when that sentence is empty). A screen reader used to hear only the word ("Inherited"), never the source or a formula's refusal reason; and the interim "label — from" read two ways — on the Shared scope the word after the dash named what the value follows ("Inherited — GALE-JACKET"), on a channel scope where the pin lives ("Pinned — Primary"). `from` now means one thing everywhere: the layer or source the value follows, came from or no longer follows ("Pinned on this row — it no longer follows GALE-JACKET" / "…the Shared product"; "Inherited from the Primary listing, which itself overrides the Shared product — …"). A refusal keeps the server's reason verbatim as its whole text. `aiStale` with a source (a machine translation of an older source text) says "Compare with it before approving" — approving it overwrites nothing; without one (an AI draft of this cell) it keeps "Approving this overwrites that change". Hosts whose `from` was a whole sentence pass `tooltip` instead (the family picture marks, the axes editor), and the `/design/language-axis` page names sources as the sheet does ("the Italian text", not "Italian · source").
- **Bullets (`slotListProvenance`, `SlotListValue`)**: the one bullets cell draws `MarkedValue` (not a hand copy; the cell-only `gap` rule `.nds-slotlist-cell` is gone, so its spacing is every other cell's) and now carries the provenance tint and the mark text on both scopes. A mixed list wears the strongest member instead of no mark, and `slotListMarkText` names the positions ("Bullet 2: Pinned · Bullets 4 and 5: Inherited"). A uniform list keeps that member's full words: `slotListColumnDef`'s new optional `markOf(row, key)` gives one position's `{ from, tooltip }`, and the cell reads the first filled position's (a refusal's server reason, a pending or attention sentence, the sentence that names what a pin no longer follows) — `slotListMark` (new export).
- **`variationThemeColumnDef`**: an optional `provenanceOf(row)` (the host's verdict for the theme's mark and tint) and `markOf(row)` → `{ from, tooltip }`, read only when that verdict names a cause (`refused`, `attention`, `pending`), so the icon and its words agree; every other member keeps the theme's server-stated tooltip. The Variants tab passes neither: unchanged.
- **The Shared scope no longer draws "Inherited" on a cell whose source is the row itself** (a parent row's field nobody filled: 61 marks on GALE-JACKET in Italian); a variation that follows an empty parent keeps the muted 🔗 (2026-09-26), named by its parent.
- **AAA mark inks**: every mark is ≥7:1 on every resting ground — the five row grounds, with and without its own cell wash, with and without the selected row's wash — in light and dark. `--nds-prov-inherited-fg` `#0f366f` / `#cae3fe` (was 3.68 / 5.33 worst), `--nds-prov-ai-fg` `#45198a` / `#d6ccfe` (4.36 / 5.96), dark `--nds-prov-formula-fg` `#6de2f4` (6.42); new `--nds-prov-warning-fg` `#522f0c` / `#f7d5aa` (outdated, aiStale, attention, refused — were `--nds-warning-strong` 3.18–3.79 and `--nds-warning-text` 6.32) and `--nds-prov-muted-fg` `#383f47` / `#d1d8e0` (mapped, mappedShared, listingLevel, the link mark over an empty parent — were `--nds-grid-muted-fg` 5.97 and `--nds-text-3` 5.34). Shared tokens other parts read did not move. Of the media-cell provenance borders only `inherited` and `ai` read these tokens; the pinned and via borders keep `--nds-primary` and the aiStale border `--nds-warning-strong`. Each ink's light value lives in a `--nds-prov-*-fg-light` twin that `.dark` never redefines, and the ink points at it: the light-pinned shell (`app/_shared/shared-shell.css`, `body:has(.h10-shell)`) pins every mark ink to its twin. It used to pin `--nds-purple-700` / `--nds-blue-700`, which dragged the product sheet (`.h10-shell nds-theme-responsive`) back to 4.36 / 3.68:1 in light mode; dark mode still takes the `.dark` values there.
- **`grid.css`**: a 4px minimum between the value's ellipsis and a select chevron (`.nds-cell-value-text:has(+ .nds-ag-chev)`); the Shared scope measured 0px. A cell with room to spare looks as before. The cell's hover action (`CellAction`, `[data-nds-cell-action]`) sits at the right edge with the same 4px minimum gap after the text (it sat flush after a short value mid-cell); after a chevron it keeps a fixed 4px, so the chevron stays right and the two never overlap.
- Catalog: `PresenceExample` shows the four new marks; `/design/language-axis` legend lists them, and its `outdated` cells and legend row draw `ProvenanceMark` (History) like the sheet instead of a `SourceIndicator` triangle. The `SourceIndicator` examples say "Follows Shared", not "Follows Master"; `/design/formula-lab` counts fifteen members.

## Simplify: Status is the one control for "is it on this market"; one set of selling words — 2026-10-04

Sheet publish parity, "SIMPLIFY BEFORE ONE-CLICK" items 1–2 (`docs/sheet-publish-parity/PLAN.md`). Mirrored in Factory except the catalog example and `sellingStatus.shared.vitest.test.ts`.

- **`publishAction.ts` / `PublishActionCell`**: the Action words are Partial update · Full update · Delete only — `create`, Deleted, Keep deleted, Lists again and their constants are gone (`DELETED_WORD`, `KEEP_DELETED_*`, `RELIST_*`, `SEND_MODE_DELETED_GROUP`, `DELETED_HINT`, `CREATE_LEFT_OUT_HINT`, `PublishActionDeleted`). A row not on the channel (new, or deleted by Nexus: `PublishActionValue.newRow`) reads **Full update** — kind `new`, an info Pill without a glyph (a create is always sent whole: `NEW_ROW_SENT_WHOLE`), quiet when `leftOut` (`NEW_ROW_LEFT_OUT_HINT`, or `DELETED_ROW_LEFT_OUT_HINT` with `deleted`). `sendModeEditorOptions(…, newRow)`: Full update is the value it holds (`NEW_ROW_FULL_NOTE`), Partial update and Delete held with the caller's reasons, never "waiting". The dot glyph is gone from the Action cell.
- **`sellingStatus.ts`**: one set of selling words — `mixed` reads **Mixed** (was "Partly inactive"), `draft` reads **Not listed**. `NewListingCellFacts.deleted` (`{ on: '4 Oct' }`): a row Nexus deleted is a new row — "deleted 4 Oct" beside Not listed, `RELIST_MARK` "lists again" beside Active / Inactive, the delete's own words alone in the tooltip; `NEW_CHOICE_DELETED` in its editor.
- **`SelectPanelEditor`**: closing without a pick never writes — an untouched or unchanged edit ends as a cancel (`useGridCellEditor` `isCancelAfterEnd`), so a click elsewhere no longer hands AG the value the editor opened on (a column whose cell value is an object, such as the sheet's Status and Action, saw it as a change and wrote it).
- **`projection.ts`**: `partly-inactive` reads **Mixed** (key kept); new state `not-listed` ("Not listed", neutral from `unlisted`, hollow dot) is the Matrix's word for a draft or a listing Nexus deleted. Every tone is still read from `readinessMeta`.
- **`matrixCells.ts`**: the Listing cell shows Not listed for selling `draft` / `not_listed` and for a wire `draft`; the Matrix never says "Draft". The chip rule is documented as the "Inactive" chip (id kept).
- **`presence.ts`**: channel facts read **Active** / **Inactive** (were "Selling" / "Not selling").
- Catalog (`SellingStatusExample`, web): Mixed, Not listed (a draft), Not listed (deleted on Amazon · IT), and Full update on a row not on the channel (sent whole; left out and deleted).

## New listings: the Status and Action of a row not on the channel yet — 2026-10-04

Sheet publish parity, new listings (`docs/sheet-publish-parity/PLAN.md`, "NEW LISTINGS", Owner picks ND1–ND4). Mirrored in Factory except the catalog example and `sellingStatus.shared.vitest.test.ts`.

- **`sellingStatus.ts`**: `StatusTarget` gains `not_listed` — `STATUS_TARGET_WORD` "Not listed", `STATUS_TARGET_TONE` neutral, `STATUS_TARGET_SELLING_STATE` `not_listed`. `SellingStatusValue.create` (`NewListingCellFacts`: target, source own / main / default, sentence, note): a row not on the channel yet is a NEW row — kind `new`, never locked by its state; the pill is the effective choice (Active info, Inactive warning, Not listed neutral) with a CLOCK when chosen on the row and no glyph otherwise (`SellingPillMeta.glyph` `none`), a small muted mark beside it ("new", "new · as main"; none on Not listed); the tooltip and the one sentence say what Publish does and where the choice comes from. `newListingEditorOptions`: Active · Inactive · Not listed, each with its sentence, warning and "checked when sending" line; a refused one HELD with its reason; the current choice says "Waiting for Publish, set by …" / "Now: it follows the main product's choice." / "Now: the default for a new listing here.". `sentence()` treats ".)" as a sentence end.
- **`publishAction.ts`**: `SendMode` gains `create` — `SEND_MODE_WORD` "Create", `SEND_MODE_HINT.create` (= the shared `CREATE_SENTENCE`), tone info, group Send. A new row's Action is kind `create`: an info Pill without a glyph (what Publish does, not a waiting value), editable (its editor lists Partial / Full / Delete held); `PublishActionValue.leftOut` draws it quiet with `CREATE_LEFT_OUT_HINT`. Never "waiting" in the editor.
- **`SellingStatePill` / `PublishActionView`**: draw a `none` glyph as a plain Pill.
- **`listingStatus.ts`**: `NOT_LISTED` ("Not listed", neutral) — the Status read's stand-in for a family member with no listing record (never stored); the writer-vocabulary test found it in the API source.
- Catalog (`SellingStatusExample`, web): new-row Status samples (default, chosen, follows the main, Not listed) and Create / Create left out.

## Status and Action cells, held options with notes, ConfirmPhraseField, a wrapping selection bar on phones — 2026-10-04

Sheet publish parity, build shape v2 (`docs/sheet-publish-parity/PLAN.md`, phase P5). Mirrored in Factory except the catalog example (Factory has no NexusGrid) and `sellingStatus.shared.vitest.test.ts`.

- **`SellingStatusCell` / `SellingStatusView` / `SellingStatePill` + `sellingStatus.ts`** (`grid/renderers/`): the Status column. The live selling state as a dotted Pill — Active success; Inactive and Partly inactive warning; Ended, Draft, Not listed, Unknown neutral. A change waiting for Publish is the target as a Pill with a CLOCK glyph (Active info, Inactive warning, Ended danger) with the live state beside it in small muted text ("now Active"); who and when go in the tooltip line and the one screen-reader sentence ("Status: Active. Inactive is waiting for Publish, set by Awais today 10:42."). Draft and Not listed (or a caller's `lockedReason`) are read-only with a lock glyph and the reason; a target the listing already reached says "No longer applies". `statusEditorOptions` turns the shared `statusOptionsFor` output into editor options (refused targets held with their reason). `rowCarriesInactiveMark` + `SELLING_ROW_MARK_CLASS` (`nds-row-inactive`): the ROW-START MARK, a 3 px `--nds-warning-strong` bar at the row's start edge for a live Inactive or Partly inactive row — never a whole-row tint (Owner).
- **`PublishActionCell` / `PublishActionView` + `publishAction.ts`**: the Action column. Partial update, the default, is QUIET (muted text at the cell's size, no pill); a waiting Full update is an info clock Pill, a waiting Delete a danger one; who and when in the tooltip and the sentence. `sendModeEditorOptions` groups Send (Partial, Full) · Remove (Delete), refused values held with their reason.
- Words are spelled in the DS (Factory has no runtime dependency on `@nexus/shared`; only types are imported) and held equal to `SELLING_STATE_LABEL`, `STATUS_TARGET_LABEL` and `SEND_MODE_LABEL` by a web-only test. Cells never claim `title`: the column composes `model.tooltip`.
- **`SelectPanelEditor`**: `options` is now `SelectPanelOption[]` (= `ListboxPanelOption`), so a refused value stays reachable with `aria-disabled` and its reason (`heldReason`). A plain `ListboxOption[]` is still valid; no caller changed.
- **`ListboxPanel` `note`**: one short line under an option's label ("Waiting for Publish, set by …", a warning, why a held option is refused), `--nds-text-2` at the hint size, italic on a held option. Read as the option's description (`aria-description`), not its name; a note equal to `heldReason` is read once. Options without a note render exactly as before.
- **`ConfirmPhraseField`** (`components/`): the typed confirmation, extracted from `ActionConfirm` (which now uses it; arming unchanged). Exact match only (`phraseMatches`: no trimming, no case folding); under the field a polite live line says where the typing stands — "Capital letters and spaces count." → "Keep typing." → "Does not match …" → "Matches." with a check glyph — and describes the input.
- **Selection bar at phone width** (`grid/theme/grid.css`): in a `GridCard` page card of 640 px or less the toolbar wraps and `.nds-grid-selbar` takes its own line and wraps its buttons. Measured on /products at 390 px (card 216 px, two rows ticked): before, the bar was 0 px wide and its seven buttons lay from x=264 to x=584, under Customise and past the card's clipped edge, none hit-testable, and Views, Export and the Live pill were clipped too; after, every control is on screen and hit-testable (two lines of selection buttons). At 1280 px the toolbar measures identically with and without the rule.
- Catalog: `SellingStatusExample` (`#selling-status-example`, web) — every Status state, the Action values, a live NexusGrid with the row-start mark and both editors (a refused option by keyboard), the editor panel as it opens on an Amazon FBA row, and ConfirmPhraseField arming a danger button.

## Matrix cells: a coordinate per row, and a "waits for Publish" tooltip line — 2026-10-02

Amazon sheet gaps (`docs/amazon-sheet-gaps/PLAN.md`), mirrored in Factory:

- **`matrixColumnDef` `coordinateOf?(row)`** (`grid/editors/matrixColumn.ts`): the coordinate a row's tooltip, classes and text read, when it differs per row — the product sheet draws Matrix cells where an EU row carries "Shared by IT DE …" and an alias row on the same column does not. Absent (the Matrix page) = the column's coordinate, so the Matrix looks and behaves exactly as before. Header, editors and renderer params stay column-level.
- **`PriceCell.waiting` / `SaleCell.waiting`** (`grid/matrix/contract.ts`, equal to the shared wire contract) and **`matrixWaitingLine`** (`grid/renderers/MatrixCellViews.tsx`): a product sheet offer change that goes to Amazon only on Publish adds ONE line to the cell's tooltip — "Product sheet change waits for Publish: €44.90" (a removed sale: "—"; back to the base price: the copy table's "Follows the base price"). The cell keeps drawing the live value. Words from the copy table (`MatrixCopy.waitingForPublish`).
- **`MatrixWriteCell.expectedListingId`**: the listing the caller saw on the coordinate; another listing there now answers `conflict`.
- **`SourceIndicator` kind `pending`** (`components/SourceIndicator.tsx`, Clock icon, full text colour — not a routine source): a value saved in Nexus that reaches the channel only on Publish. Before, a waiting Amazon price on a pinned listing drew the Pin of a live "Listing override". Catalog: "Value sources".
- `MatrixCopy.waitingForPublish` is now required: the engine default `MATRIX_CELL_COPY` carries it.
- **Matrix Mode / Fulfilment chevrons open the list** (`renderers/MatrixCellViews.tsx`, mirrored): one click on a writable cell's chevron starts editing (`openCellEditor`), on the Matrix tab and the product sheet alike — before, it only selected the cell (the 2026-09-29 rule).
- **`matrixCoerceValue`** (`renderers/matrixCells.ts`, mirrored): a pasted or typed word is its code — "Pinned" → `PINNED`, "follow" → `FOLLOW`, "fbm" → `FBM`. Copying a Mode cell gives the word it shows, so pasting it now writes.
- **`EDITOR_MODE_BY_KIND.stockControl = 'inline'`** (`editors/openGesture.ts`, mirrored): the product sheet's Mode / Qty / Buffer columns; Qty and Buffer edit inline, Mode opens its list as a popup (per-cell modes: `MATRIX-CONTRACT-TABLE`).

## Publish status: "Waiting its turn" and "Cancelled" — 2026-10-02

Sheet publish parity T1 (`docs/sheet-publish-parity/PLAN.md`). The publication table (`grid/renderers/publishStatus.ts`, mirrored in Factory) gains two batch words, so a publish batch's rows never name a status outside the one table:

- **`QUEUED` → "Waiting its turn"** (neutral, not final): a destination of a publish batch that has not had its turn yet. Nothing has left Nexus.
- **`CANCELLED` → "Cancelled"** (neutral, final): the person cancelled the batch before this destination's turn. Nothing was sent to it.

Both are neutral because nothing happened on a channel. The Publish window's batch rows (`_publication/dialog/destinations.ts` `batchChildMeta`) now read these words from the table instead of naming them locally.

## Drawer questions get a card; a DataGrid column can start hidden — 2026-10-02

Sheet publish parity, history follow-ups.

- **`DrawerOverlayCard`** (`components/`, mirrored in Factory): the surface for a question in `Drawer`'s `overlay` slot (the slot is only a scrim). `dialog` or `alertdialog`, named by its heading (`labelledBy`) or `label`; while up it owns the keyboard in the capture phase — Esc cancels the card only (swallowed while busy, so it never closes the drawer behind a pending question), Tab and Shift+Tab cycle inside, also when focus starts outside the card. Styles `.nds-drawer-ovcard`: surface, subtle border, `--nds-radius-xl`, `--nds-shadow-modal`, at most 460px wide. The publish history's "Mark as checked…" uses it (its local copy is gone).
- **`Column.defaultHidden`** (`grid/datagrid`, type shared with the retiring `components/DataGrid`, mirrored in Factory): in a `customizable` grid the column starts hidden, stays listed in Customise, is left out by Reset, and is not switched on in a saved layout that never knew it; a layout where the operator switched it on keeps it. The publish history list offers "Channel reference" this way.
- **`Drawer` docs**: the dock is described as it is built — fixed to the viewport's right edge under the top bar (`.nds-drawer-dock`, layout-v2 §5), covering what is under it; the old text said it sat in the normal flow and should be laid out in a flex row, which reserves nothing.

## Last publish: a family total on the main row, and "Go to field" moves keyboard focus — 2026-10-02

Sheet publish parity, step 3 design review (measured on :3660, light and dark, 1280 and 390 px).

- **`publishFamilyMeta` / `PublishStatusValue.family`** (`grid/renderers/publishStatus.ts`, mirrored in Factory): a family's main row shows "2 of 11 failed" ("All 11 failed" when none went through) in the publication's tone, instead of its own row result — a collapsed family no longer reads "Accepted" over sizes that failed. Spoken name: "2 of 11 products in this family failed". The card keeps the publication word, uses the count as its sentence and still shows "This row: …". Given only when more than one product was sent.
- **`landOnCell`** (`grid/landOnCell.ts`, web only — Factory has no grid): AG focuses only a drawn cell, and the scroll draws the target a frame or more later, so keyboard focus stayed on `<body>`. It now waits up to 10 frames for the cell, then focuses it — never taking focus the user moved elsewhere (only nothing, `<body>` or a grid cell counts as free). A cell never drawn keeps the grid cursor only. The progress card's "Go to field" benefits too.

## Sheet status marks: a danger mark never folds — 2026-10-02

`SheetStatuses` (grid/toolbars/SheetStatus.tsx, mirrored in Factory) now orders by severity: a `danger` mark never folds into "+N" — not under the three-mark cap and not on the host's compact tier (`useToolbarStatusCompaction`). Only the other tones fold, original order kept (`partitionSheetStatuses`). Measured on the studio sheet at 1280px (step 2 design review, sheet publish parity): the compact tier latched while "Amazon · IT is processing 21 products" was on the bar (18px over) and the "2 rejected on Amazon · IT" that replaced it sat in a neutral "+2" — visible to a screen reader only. Kept on the bar it costs ≈170px; at 1280 the bar still fits (scrollWidth 1212 = clientWidth, nothing clipped), and 1440, 1600 and 390 (wrapping) were measured the same. With no danger mark the behaviour is unchanged. The hidden `role="alert"` for folded danger marks is gone because none fold; each kept danger mark still carries its own `role="alert"`.

## Publish status: one vocabulary, a "Last publish" cell, a toolbar mark that filters, and a Timeline — 2026-10-02

Sheet publish parity, step 0 (`docs/sheet-publish-parity/PLAN.md`). Four additions, each in the catalog at `/design-system#publish-status-example`, mirrored in Factory:

- **`grid/renderers/publishStatus.ts`** — the ONE table of publish statuses: publication level (`PUBLISHING` Sending · `SUBMITTED` Waiting for channel · `ACCEPTED` Accepted · `VERIFIED` Verified · `PARTIAL` Partly failed · `FAILED` Failed · `NOT_SENT` Not sent · `UNVERIFIED` Result unknown) and per-SKU level (Accepted, Verified, Failed, Waiting, Not sent, Skipped, Result unknown). Only Verified uses the success tone (the DS success pill is blue, so Verified also carries a check glyph — see the design review below). `publishCellModel` / `publishCardModel` are the pure rules the cell and its card draw.
- **`PublishStatusCell`** (+ `PublishStatusView`, `PublishStatusCard`) — Pill with dot, status word and short time; the card opens like the progress card (hover, click, Enter, Space; Esc back to the cell) and lists the facts, what was sent, the channel message and each refused field with "Go to field". The cell is never painted red.
- **`SheetStatus.onSelect` / `actionLabel` / `selected`** — a toolbar mark can be a filter toggle (real button, `aria-pressed`). Unchanged without `onSelect`.
- **`Timeline`** (`components/`) — a read-only `<ol>` of steps with tone dots in the tone's text colour, `AsOf` times and "not yet" for a step that has not happened. Not a Stepper.

Styles: `styles/components.css` (`.nds-publish-*`, `.nds-timeline*`), tokens only; text in `--nds-text` / `--nds-text-strong` and the tone text tokens (7:1, light and dark).

Design review (same day, measured on :3660, light and dark, 1280 and 390 px): **`PublishStatusPill`** is now the only way to draw a publish status — Verified carries a check glyph instead of the dot, because the DS success and info pills are both blue and the shade alone did not tell Verified from Accepted; both shapes are centred on the text line (`.nds-publish-pill`, the glyph had lifted the pill 2 px). One time shape across cell, card and aria name (`publishFullTime`: "1 Oct, 22:19"; "1 Oct 2025" in another year) plus the relative words `AsOf` uses; the card's `When` no longer follows the browser locale ("Oct 01, 10:07 PM"). The card says `detailHint` ("The channel refused this publish.") instead of "Open the details to see why"; its head and foot are vertically centred (10/10, 8/8) and issue rows line up with their heading whether clickable or not; sent fields read as one wrapped line. A filter mark that is ON shows an inset ring without focus. A Timeline success dot uses the success pill's ink so a Verified step and a Verified pill are one colour.

## Product journey, step 4: one wording, a quiet page behind dialogs, the header fold in the DS — 2026-10-01

- **`readinessMeta('unlisted', 'row')`** and presence **`NONE`** read **"Not listed yet"** (was "No listing here"), with the hint "Nexus has no listing here yet, so nothing has been checked against the channel." The studio's sheet notice, media tabs and scope chip say the same fact as "Not listed on eBay · IT yet". Mirrored in Factory.
- **`Modal`** locks the page behind it: `.nds-modal-b` has `overscroll-behavior: contain`, and `html:has(> body > .nds-backdrop)` has `overscroll-behavior: none`, so a wheel past the end of a long dialog (the Import review) no longer moves the page. `styles/components.css`.
- **`DetailHeader`** owns its fold: **`DETAIL_HEADER_FOLD`** (`{ host: 'nds-detailhdr-fold', folded: 'is-folded' }`) — a page puts `host` on an element that holds a `dense` header but not the scrolling body and toggles `folded` there; the 48 → 32 strip, the dropped identity pills and the smaller title are `styles/patterns.css` rules (small-screen height at the DS `sm` breakpoint, 760px). It replaces the studio's local restyle of the header. `DetailHeader.tsx` and the barrel mirrored in Factory (patterns.css is not shared).
- **`FormulaCellEditor`** / **`FormulaComposer`**: a retry button says **"Try again"** (was "Retry" / "Retry preview"). Mirrored in Factory.

## Field shows what is wrong with a value — 2026-10-01

**`Field`** takes **`error`**: a sentence under the control in `--nds-danger-text` (7.36:1, the required marker's colour), read with the control through `aria-describedby` (before the hint). While it is set the control gets `aria-invalid` (unless it states its own) and an `Input` inside gets a `--nds-danger` border (`.nds-field-error`, `.nds-field-w.invalid`, `styles/components.css`). Unset, the field renders exactly as before. First user: the Products page's "New product" dialog. Catalog: the SKU example under Input. Mirrored in Factory (`Field.tsx`, `components.css`).

## The accent identity chip reads in light mode again — 2026-10-01

Older pages' dark-mode audit (`fix/dark-mode-older-pages`). **`.nds-cell-chip-accent`** (the "P" parent pill in the product sheet's identity band, `grid/theme/grid.css`) filled with `--nds-rail-text`. Since the rail joined the dark chrome (TB, 2026-08-31) that token is the chrome's LIGHT ink in light mode, so the white "P" sat on #aab6c2 at 2.06:1. It now fills with **`--nds-text-2`**: white on #3a4452 is 9.9:1 light, and the dark-mode inverse ink on #c3ccd6 is 9.8:1. Mirrored in Factory.

In **`grid/workspace/workspace.css`** the group-row count (`.gc`) and the market tag (`.mk`) read **`--nds-wsgrid-text-secondary`** instead of `--nds-wsgrid-text-muted` (grey-500, 2.74:1 on the group row's grey-100): 5.22:1. No token value changes. Web only (no Factory copy).

Also, outside the DS: Tailwind gains one semantic text colour, **`text-placeholder`** (`--nds-placeholder`, 5.9:1 light and dark), for placeholder-style hints that are not a real `<input>` placeholder (the legacy flat-file grid's empty-cell "e.g. …"); and the shared light pin in `app/_shared/shared-shell.css` now also covers the ads console (`.az-root`) and the fleet (`.fleet-surface`, `.fleet-portal`), so DS components inside those light-pinned surfaces stop drawing their dark values.

## Field placeholders get their own token, at 4.5:1 — 2026-10-01

Dark-mode token clash (`fix/dark-mode-token-clash`), lead browser audit. DS placeholders used **`--nds-text-disabled`**: 2.04:1 on a white field, 2.78:1 on the dark one. New **`--nds-placeholder`**: `var(--nds-grey-600)` light (#5b6573, 5.91 on `--nds-surface`, worst 5.22 on sunken) and #97a3b1 dark (5.94, worst 5.51). Read by `.nds-field > input`, `.nds-textarea`, `.nds-combo-in`, `.nds-combo-search input` and `.nds-range-in input` placeholders. Pinned light on `body:has(.h10-shell)` and the fleet surface. `scripts/check-nds-contrast.mjs` measures it on every surface (group `placeholder`, AA bar). Mirrored in Factory: `tokens/css-vars.ts` (+ `npm run tokens:gen:factory`), `styles/primitives.css`, `styles/components.css`, `styles/patterns.css`.

## Tailwind's semantic colours read the design-system tokens — 2026-10-01

Dark-mode token clash (`fix/dark-mode-token-clash`). In `apps/web/tailwind.config.ts`, `text-{primary,secondary,tertiary,disabled,link}`, `bg-{canvas,card,sunken}`, `border-{subtle,default,strong}` and `surface.{background,card,border,border-strong}` now read **`--nds-text`**, **`--nds-text-2`**, **`--nds-text-3`**, **`--nds-text-disabled`**, **`--nds-text-link`**, **`--nds-bg`**, **`--nds-surface`**, **`--nds-surface-sunken`**, **`--nds-border-subtle`**, **`--nds-border`**, **`--nds-border-strong`** through `color-mix` (`ds()`), so `/NN`, `*-opacity-*` and variants keep working. They read `rgb(var(--text-primary) / 1)` over globals.css channels, and `tokens.css` redefines those eleven names at `:root` as whole colours: on almost every route the value was invalid (inherited black text on the dark page, transparent cards, borders in the text colour). globals.css no longer defines the eleven; `body` reads `--nds-bg` / `--nds-text`. Light mode changes too: borders are the DS's light-grey lines and muted text its greys. Held by `src/app/tailwind-token-form.vitest.test.ts` and `scripts/check-alias-form.mjs` (`--self-test` is a static gate). `scripts/check-contrast.mjs` (the old globals palette) is retired; `check-nds-contrast.mjs` measures these tokens, and now also the Tailwind status pairs it held (`text-X-strong` on `bg-X-soft`, globals.css channels, light and dark, at AA). The ads console's `reporting.css`, `trust.css`, `launch-receipt.css` and four `rules-automation.css` rules read `--nds-*` instead of the aliases, so their dialogs (which portal to `<body>`, outside `.h10-shell`) get real colours. Not in Factory (no Tailwind).

## Closed editors leave no pending attachment work — 2026-09-30

The pinned AG React patch checks that its cell is alive and still owns the same editor before a delayed attachment runs. Closing an editor, removing its row, or destroying the grid cannot attach a stale tooltip or cancel a replacement editor. Both published module formats have direct regression tests. Mirrored in Factory.

## Fast typing keeps the whole value — 2026-09-30

**`FormulaCellEditor`** finishes opening a typed edit inside the first native key event, so later keys reach the input. Shortcuts, composition, locked cells, and editor-owned keys keep their existing handling. The pinned AG React patch creates the popup in layout, retains the same wrapper through StrictMode replay, and keeps its original cleanup lifetime. Mirrored in Factory.

## Saved views can share one initial read — 2026-09-30

## 2026-09-30 — Cancel pending save retries on discard or exit

SheetWriter exposes a retry-only signal tied to its lifetime. Discard and exit cancel pending retry waits. Re-arming starts a fresh lifetime without reviving old retries or canceling an in-flight save.

## 2026-09-30 — Preserve unsafe whole-number input

Numeric cells and lists keep unsafe whole-number text intact so the API can refuse it by name without storing a rounded value. Safe values and text IDs keep their existing types.

**`useGridViews`** and **`useGridState`** accept an optional keyed initial reader. A sheet can load its named views and working layouts in one bounded request. Explicit refresh stays a fresh read. Scope and request guards reject old replies. **`parseWorkingLayout`** applies the same checks to either transport. These files exist only in the web app; there is no Factory counterpart.

## Sheet save progress stays in the status strip — 2026-09-30

**`GridSheetStatus`** can read an optional live status source. Save progress updates the existing strip without a host render. Plain props and rendered markup stay the same. This host exists only in the web app; there is no Factory counterpart.

## Save replies reconcile replacement rows — 2026-09-30

**`SheetWriter`** reconciles the captured request row's confirmed metadata onto the current row before the next edit, through the existing optional `mergeRow` hook. This covers single-row and batch saves. Current cell values stay with the current row. Mirrored in Factory.

## Numeric list editors keep the declared value type — 2026-09-30

**`ListPanelEditor`** uses the column parser for chips and pending text, as paste and whole-column edits do. Number lists send JSON numbers. Text IDs, invalid number text, and formula drafts keep their meaning. Mirrored in Factory.

## Replacement rows keep confirmed write versions — 2026-09-30

**`SheetWriter`** accepts an optional `mergeRow(previous, incoming, knownVersion)` function on row seeds and edits. Product sheets use it to retain confirmed content and listing versions without replacing edited values. Ownership rules stay in the sheet. Mirrored in Factory.

## Batch replies keep newer version numbers — 2026-09-30

**`SheetWriter`** keeps the highest confirmed row version when a save finishes. An older reply cannot undo a newer version learned from another alias, so the next edit uses the right number. Uses the existing seed rule. Mirrored in Factory.

## Clear is reachable with the arrow keys — 2026-09-30

**`ListboxPanel`** lets ArrowUp reach Clear from the first option. Enter and Tab report an empty value before a grid ends the edit. Focusing Clear also updates the keyboard choice. A missing stored value still stays unchanged until the operator chooses. Mirrored in Factory.

## A short list takes the keyboard before it is painted — 2026-09-30

Product sheet P2 (`fix/product-sheet-editing`). **`ListboxPanel`** without a search field focuses its container in a layout effect (it was a passive effect, after the paint): an Enter-then-↓ on a busy page reached the grid cell under the list, and Tab then committed nothing (the product sheet's list suite failed 2–3 times in 8 runs). The search field's `autoFocus` already took focus in the commit. Mirrored in Factory: `ListboxPanel.tsx`.

## A source mark in a grid without hints mounts no tooltip — 2026-09-30

Product sheet P2 (`fix/product-sheet-editing`, speed: a horizontal scroll of a 209-column channel sheet rendered 254 components per frame). **`SourceIndicator`** no longer mounts its **`Tooltip`** inside a host that turned hints off (`TooltipPortalProvider disabled`, the channel grid): the Tooltip rendered only its trigger there, so the markup is unchanged and one component per cell is gone. **`useTooltipsDisabled()`** (primitives `Tooltip.tsx`) tells a component it sits in such a host. Mirrored in Factory: `SourceIndicator.tsx`, `primitives/Tooltip.tsx`.

## A save that answers with a warning says so on its cell — 2026-09-30

Product sheet P1 review (3): a save the server accepts with a warning (eBay's 55-character subtitle, a list value the channel may not take) showed as a plain green save and the sentence was lost. **`CellSaveEntry`** carries **`warning`**; **`CellSaveTracker.setSavedWithWarning`** keeps a saved-with-warning cell (it does not fade, **`warnedCount`** counts them); **`saveNote(entry)`** gives the cell's note: the refusal's reason, or "Saved with a warning: <the server's sentence>". **`SheetWriter`**: a result cell may carry **`warning`** (`{ ok: true, warning }`), and settle marks it. **`roundTripClassRules`**: **`nds-cell-is-saved-warned`** (the warning corner and a 1 px `--nds-warning` ring, `grid.css`). **`GridSheetStatus`** takes **`warned`**: "Saved HH:MM with N warnings". Mirrored in Factory: `roundTrip.ts`, `sheetWriter.ts`, `editors/index.ts`, `theme/grid.css` (Factory has no `GridSheet`).

## Long text is never cut at 200 characters — 2026-09-30

Product sheet P1. **`longTextEditor`** always passes a browser limit far above any channel cap (**`NO_TEXT_LIMIT`**, **`textLimitFor(cap)`**): AG's `agLargeTextCellEditor` sets `maxLength || 200`, so a long-text cell with no limit stopped typing at 200 characters and a capped one at its cap. A channel's cap is a warning (the counter and the cell's tint), never a browser stop. Mirrored in Factory.

## refusalWords: a variation axis says so — 2026-09-30

Product sheet P1 (`fix/product-sheet-editing`, report 2 I-11: the family row was locked on every per-variant column with the claim "this is a variation axis"). **`refusalWords`**' `per-variant-on-parent` takes **`axis`**: a real axis reads "… is a variation axis — each variation has its own value, so the parent has none. Open a variation row to edit it."; any other per-variant column keeps "… is set per variation — open a variation row to edit it, not the parent." (Not in Factory.)

## SourceIndicator `quiet` — 2026-09-30

Product sheet P1 (`fix/product-sheet-editing`: the source of every cell is visible on every channel; eBay, Amazon and Shopify hid it). **`SourceIndicator`** takes **`quiet`**: a routine source (a value that follows somewhere else) is drawn in `--nds-text-muted`, full colour on hover and keyboard focus (`.nds-source-indicator--quiet`, `components.css`). The icon, its name and its action stay; nothing is hidden. Catalog: the value-source row shows it. Mirrored in Factory: `SourceIndicator.tsx`, `styles/components.css`.

## Card: no blank band under a head with an empty body — 2026-09-30

Team & Access (`fix/team-access-phone-width`). A headed **`Card`** with nothing in its body (a list row: title, sub-line, `headerAction`) now ends at its head: `.nds-card-body:empty` is not drawn and the head drops its bottom border. The empty body kept its 16 px padding, so every such card showed a blank band (Team & Access members, invitations and roles; the studio's Readiness loading card). A body with content is unchanged. Specimen: "Card with a long sub-line" has a body; the new "Card without a body" under Components on `/design-system` has none. Mirrored between Web and Factory (styles).

## Card: a long word in the head breaks; at phone width the action moves under the text — 2026-09-30

Team & Access at 390 px (`fix/team-access-phone-width`). **`Card`**'s title and description (`.nds-card-head .t`, `.d`) break a long unbreakable word (an email, a URL, a SKU) at the card's edge instead of running past it; `overflow-wrap: break-word` keeps each card's min-content width, so no layout that fits today moves. Under 600 px a **stacked** head (a card with a `description`) wraps its `headerAction` onto its own line when the title and sub-line cannot keep 12rem beside it. Specimen: "Card with a long sub-line" under Components on `/design-system`. Mirrored between Web and Factory (styles).

## Lists in the grid: Enter and Tab choose, one click opens, the first typed key counts — 2026-09-30

Product sheet P0 (`fix/product-sheet-editing`; measured in production 2026-09-29: Enter and Tab closed every list with its old value). **`ListboxPanel`** gains **`onKeyChoice`** (Enter/Tab report the highlighted option in the CAPTURE phase, before AG's popup listener ends the edit; the owner then lets the grid commit and move, and the panel does not also commit Enter), **`initialQuery`** (the search starts with AG's `eventKey`, so the key that opened the cell by typing is not lost), and **`allowCustom`** (the typed text is offered LAST as `Use "…"`, the only row when nothing matches). A stored value the list does not hold now highlights NOTHING until the operator moves or types, so Enter keeps it instead of committing row 1. A searching panel keeps its keyboard highlight in view; its search field is sticky (`components.css`). **`AsyncListboxPanel`**: the same rule (no highlight on a stored value the loaded page lacks; Enter keeps it), **`onKeyChoice`** for Tab, **`currentLabel`** ("Current: …"). **`OptionList`**: **`initialQuery`**. Grid: **`SelectPanelEditor`** reports on Enter/Tab, shows a stored off-list value first ("current"), takes **`allowCustom`** and the typed key; **`SelectChevron`** takes **`onOpen`** (one click opens the list; `.nds-ag-chev.is-action`) with **`openCellEditor`**; **`SELECT_CLEAR_LABEL`**; **`ListPanelEditor`** walks its boxes with ↑/↓ and shows stored off-list values; **`MeasureEditor`** keeps a typed digit and Tabs from the number to the units. New helpers in `selectPanelModel.ts`: **`withStoredValue`**, **`typedStart`**. Mirrored in Factory: the same files, and the sticky search rule in its `components.css`.

## Sheet writer batch mode: one operation, one save — 2026-09-29

Sheet bulk autosave (`fix/sheet-bulk-autosave`). **`SheetWriter`** gains an opt-in batch mode: **`commitBatch`** sends every queued row of one operation (a fill, a paste, an undo) as ONE call and keeps one call in flight for the whole sheet (edits made meanwhile go next, with the versions the first call returned); **`readBackBatch`** resolves every unknown row with ONE read; **`beginOperation` / `endOperation`** fence an operation (a fence holds an edit at most `FENCE_MAX_MS`, counted from the first held edit); **`failedCount` / `retryFailed()`** resend exactly the refused cells. Without `commitBatch` a writer is unchanged (one call per row). `pending` now counts cells in flight, not rows. **`GridSheetStatus`** says "Saving N cells…" while a multi-cell save is on the wire. `grid.css`: a note slot's action keeps its size, and **`.nds-grid-sheet-noteslot.is-urgent`** (a refusal with its Retry) never shrinks, so the footer stays readable at phone width.

## MediaBoard: a row's mark wraps — 2026-09-29

Media page, Amazon photos per market. A row's `source` (its mark and its button: "Own for all Amazon markets", "Reset all
markets to shared", "Own for ② Outlet (Inventory)") now wraps inside the row head instead of running over the photos:
`.nds-media-board-source` keeps to the head's width, and a Tag or Button directly inside it may break its words.

## Photo grid: MediaBoard `slots` — 2026-09-29

Media page redesign (Owner: "one photo grid: rows = sets, columns = slots (MAIN, PT01…)"). **`MediaBoard`** takes an opt-in **`slots`** (the column names) and **`onAddRequest`**: the rows line up under ONE header of slot names, each position is a fixed slot, and a row shows its empty slots up to its **`capacity`** (row prop; default its slot count) as places to drop on — the first one is a button, "Add photos to <row>, <slot>", that calls `onAddRequest`. No ★ badge in this mode (the MAIN column says it); a row may name its own slots (**`slots`** row prop, e.g. PS01…PS06), which then show on its tiles. The board scrolls sideways as one, the set names sticky on the left; it stays a two-column grid on a phone (96 px names). Tiles 76 px. Keyboard, drag, Alt-copy and the ⋯ menu unchanged; screen readers hear the slot name ("Common 1, MAIN in Common"). Off by default, so the sheet's Product media pop-up is unchanged. Styles: `.nds-media-board.slots`, `.nds-media-board-columns*`, `.nds-media-board-slot`, `.nds-media-board-add`. Catalog: `MediaGalleryExample` ("MediaBoard slots"). Mirrored in Factory: `MediaBoard.tsx`, `catalog/MediaGalleryExample.tsx`, `styles/components.css`.

## Live photo drag: MediaBoard `liveDrag`, `useSortableDrag` layout `grid` — 2026-09-28

Sheet pop-up rebuild, Lane C (the Product media cell; Owner: "The UI of the drag-and-drop has to be better"). **`lib/sortable.ts`** gains **`gridDropIndex`** (the slot nearest the dragged tile's centre; its own slot wins while its centre is inside it) and **`gridShift`** (each tile between slides into its neighbour's slot, across line breaks). **`useSortableDrag`** takes **`layout: 'grid'`** (list and wrap unchanged). **`MediaBoard`** takes an opt-in **`liveDrag`**: a ONE-row board drags live — the tile lifts and follows the pointer, the others slide, Esc cancels, touch works; keyboard (Space, arrows, M, Delete) and the ⋯ menu unchanged. Off by default, so the Media page (several rows, drag between rows) is unchanged.

## Variation theme pop-up on Shopify: the channel layout with free option names — 2026-09-28

Sheet pop-up rebuild P3 A4 (`docs/sheet-popup-editor/QUALITY-PLAN-2026-09-28.md` §4.11). **`AxesPanel`**'s channel layout now opens on Shopify too (`usesChannelAxesLayout`): every option — Shared or the operator's own — has a free name box (≤ the server's limit, 255), says where it comes from and shows its values; "+ Add" offers the Shared options not sent yet and "Your own name" (with A3's "New attribute"); a name that is empty or used by another option is said under its row (new `freeNameRefusal`). A product already on Shopify holds every name box, × and the order with the server's sentence. The Shopify cell no longer has include checkboxes (the Amazon cell keeps them). Two `grid.css` lines (`.nds-axes-chead > .nds-field` and its input shrink, so ↑ / ↓ stay visible in a narrow pop-up). A cell-host panel shown outside AG's popup layer no longer takes the page's focus on load (both focus rules now need AG's popup as an ancestor; the sheet is unchanged). Catalog: **`ShopifyOptionsExample`** (made-up data; the local copy cannot open the Shopify scope).

## Variation theme pop-up on a channel: "New attribute" from "Your own name" — 2026-09-28

Sheet pop-up rebuild P3 A3 (`docs/sheet-popup-editor/QUALITY-PLAN-2026-09-28.md` §4.10). **`NewOwnAttribute`** in the channel layout's "Your own name": when no attribute fits, the typed name becomes a per-variant attribute in the product's family. The first press only says what happens (the family, how many products get the empty column, and that Esc does not remove it — it is written at once, outside the draft); **Create** writes; the new attribute is chosen in "Values from" with focus on **Add**. An existing attribute of that name is offered (**Use it**); a held button keeps its reason on screen (no family, no permission, a name the channel refuses). The host makes the call (`AxesPanelEditorParams.createOwnAxisAttribute`); `OwnAxisSourcesLoader` now answers `{ sources, newAttribute }`. New helpers in `channelAxes.ts`: `newAttributeHeld`, `withOwnAxisSource`, `newAttributeDoneLine`; one `grid.css` block (`.nds-axes-newattr`).

## Variation theme pop-up on a channel (eBay, Etsy): axes from Shared, from the channel's list, or under your own name — 2026-09-28

Sheet pop-up rebuild P3 A2 (`docs/sheet-popup-editor/QUALITY-PLAN-2026-09-28.md` §4.4). **`AxesPanel`** (cell host, an eBay or Etsy coordinate; Amazon keeps its theme list, Shopify waits for P3b) opens a channel layout in the `media` box: each row shows the channel's name, where the axis comes from ("from Shared: Color" / "only on eBay" / "your name · values from Fit"), its values as chips, how many variants are empty and where to fill them, and the server's refusal when the axis is unbound. **"+ Add"** opens three groups — Shared axes not delivered here, the channel's own variation aspects with their fill counts, and a typed name with "Values from" a Shared per-variant attribute (read by the host: `AxesPanelEditorParams.loadOwnAxisSources`) — checked before anything is saved in the save's own words; a live listing holds every set change with the server's sentence; "Reset to Shared" waits for ⏎ with a status line. Rows lift and slide while dragged. New **`channelAxes.ts`** (pure rules and copy). Keyboard: Tab moves between the pop-up's controls and leaves at its edges (`suppressAxesPanelKeys`, the column's `suppressKeyboardEvent`); focus returns to the pop-up after a control removes itself, so Enter and Esc keep working. **`MediaChipField`**: a static chip row (nothing to remove or move) is not a Tab stop per chip.

## Variation theme pop-up, shared product: values with photos, variants, refused removal — 2026-09-28

Sheet pop-up rebuild P2 (`docs/sheet-popup-editor/PLAN-2026-09-27.md` §4.2). **`AxesPanel`** (master host, when the grid host is given a family loader): each axis row shows its **values as chips** — the photo axis's values with their photo (the plan's photo, else the first variant's), other axes plain (Owner: "We do not need to have images for the size chips") — dragged into the family's order (`VariationThemeCell.valueOrder`, a draft field); a **variant list** with photos, values and SKU (search past 8); removing an axis whose values are still on variants is **refused with the count** (the VT master rule; the chip used to remove it silently). The rows lift and slide while dragged (`OrderedList liveDrag`). New **`variationFamily.ts`** (`VariationFamilyView`, `familyAxisFor`, `axisRemovalRefusal`, `valueOrderAfterDrag`, `orderValues`, `filterVariants`). **`MediaChipField`** gains `searchable` and `removable` (an ordering-only chip row). **`useSortableDrag`**: the innermost sortable owns a press (chips inside a row). Editor kind `media` asks 480 px tall. Channel scopes and the dock are unchanged.

## Shopify pop-up pieces: reference chips with pictures, pick-list row actions, the panel key line — 2026-09-28

Sheet pop-up rebuild P1 (`docs/sheet-popup-editor/PLAN-2026-09-27.md` §4.3). **`MetafieldValue`** draws a reference as Shopify's cells do: a chip per reference with its picture or swatch in front (`MediaMark`) — a product's photo, an icon entry's icon, a colour entry's swatch — and files still as a picture strip; **`metafieldDisplay`** takes `swatches` and gives each reference `swatch`. **`MediaPickList`** gains `rowActions` (e.g. "Edit entry" on a picked entry; a click inside never ticks the row). Grid: **`EDITOR_KEY_HINT_PANEL`** ("Enter saves · Click outside saves · Esc cancels") for pop-ups made of several controls, and `editorBox`, `roomToRightOf`, `EDITOR_CAPS` exported so a pop-up hosted outside AG's layer sizes itself by the same rule. `MediaChipField`'s search line no longer draws a second focus ring inside the field's own.

## Media pickers: MediaMark, MediaPickList, MediaChipField, MediaOrderedList, ResourcePickerDialog — 2026-09-28

Sheet pop-up rebuild P0 (`docs/sheet-popup-editor/PLAN-2026-09-27.md` §4.1): pickers whose choices carry a picture or a colour swatch, modelled on Shopify's bulk-editor pop-ups (measured 2026-09-27). One shape, **`MediaChoice`** (`lib/media-choice.ts`: value, label, detail, image, swatch, group, disabled, heldReason), and one mark, **`MediaMark`** (picture → swatch → nothing; no empty picture slots; a failed picture shows "unavailable"). **`MediaPickList`** — search (local or remote), grouped rows `tick · picture · name`, single or multi, held rows with their reason, Load more, "Add new entry"; it does not position or portal itself (safe inside an AG pop-up), owns ↑ ↓ Home End PageUp PageDown Space Enter and exposes `handleKey` so a caller's own field can drive it. **`MediaChipField`** — the chosen values as picture chips with ×, drag and Alt+←/→ order, Backspace removal, "Clear". **`MediaOrderedList`** — `OrderedList` rows with picture, name, second line and ×, "Clear all", header actions. **`ResourcePickerDialog`** — search + pick many, "N selected", Cancel / Done; Done keeps hand-made order (`mergeSelection`); carries `ag-custom-component-popup`. A value no choice carries is shown marked, never dropped (`resolveChosen`). Grid: new editor size kind **`media`** (480 × 520). Catalog: `MediaPickersExample` (made-up data only).

**Live drag (same day, Owner: "the ui and ux of drag and drop has to be improved"):** new hook **`useSortableDrag`** (geometry in `lib/sortable.ts`) and an opt-in **`OrderedList liveDrag`** prop — the whole row is the handle, it LIFTS and follows the pointer, the other rows SLIDE to open the gap, Esc cancels, the list auto-scrolls near its edges, touch and pen work; the grip keeps ↑ ↓ with a spoken position. `MediaChipField` uses the `wrap` layout: the chip follows the pointer and the target chip shows an insertion bar. Off by default: every current `OrderedList` consumer is unchanged until it opts in.

## AliasMark — ★ the main listing, ①②③ its aliases — 2026-09-28

**`AliasMark`** (new primitive, `primitives/AliasMark.tsx`) with **`aliasMarkGlyph(position)`** and **`aliasMarkName(position)`**: the mark that tells a product's listings on one account and market apart — ★ for the main listing (position 0), ①②③… for its aliases, `(21)` after ⑳. It reads "Main listing" / "Listing alias 1" to a screen reader. Show it only when that account and market hold more than one listing. Moved out of the Information sheet's channel band (`sheet/channel/AliasBandCell.tsx`, `provenance.ts`, the `.nds-alias-mark` rule in `channel-sheet.css`) so the Media page shows the same mark (images W2, `docs/images-studio-rebuild/NEXT-PLAN-2026-09-28.md`). Style: `.nds-alias-mark` in `styles/primitives.css`. Catalog: the primitives section. Mirrored in Factory: `primitives/AliasMark.tsx`, `primitives/index.ts`, `styles/primitives.css`.

## Catalog: no text inside synthetic images — 2026-09-27

`catalog/MediaGalleryExample.tsx` — the synthetic example photos no longer draw a label: an SVG shown as an image cannot use the page's fonts, so its `font-family="sans-serif"` label fell back to the system font (Arial on Windows) on the `/design-system` page (Owner, 2026-09-27: no Arial anywhere). The pictures now differ by a bar count; the caption carries the label. `scripts/check-font-families.mjs` no longer excepts this file (web and Factory), so a font named there fails the guard again. Mirrored in Factory: `catalog/MediaGalleryExample.tsx`.

## MediaStrip: muted items — 2026-09-27

For the Information sheet's "Product media" column on the photo plan (images P3c, `docs/images-studio-rebuild/PLAN.md` §5.7): a variant's cell shows its own set, then the photos shared by every variant. **`MediaStripItem.muted`** marks an item that is shown for context and is not part of the cell's own list: dashed frame, image at 55% opacity, and "· shared" in its tooltip (the difference is never colour alone). Catalog: `MediaGalleryExample` (a variant strip). Mirrored in Factory: `MediaStrip.tsx`, `catalog/MediaGalleryExample.tsx`, `styles/components.css`.

## Row state `pending` and the projection word "Published · ASIN pending" — 2026-09-27

`grid/renderers/readiness.ts` — a sixth ROW state, **`pending`**, labelled **"Published · ASIN pending"** in `live`'s `info` tone: Amazon accepted the listing and Nexus has not read its ASIN back yet (`isAsinPending`, `packages/shared/listing-risk.ts`). Not a draft, and not yet `live`. **`readinessPillLabel`** — the words on `ReadinessCell`'s pill, moved out of the `.tsx` so node tests reach it; unchanged for the other states, and `pending` shows its label alone (no issue count, no reference). `grid/renderers/projection.ts` — **`asin-pending`**, whose tone AND word are read from `readinessMeta('pending', 'row')`; the catalog's projection table lists it. Mirrored in Factory: `readiness.ts`, `projection.ts`, `cells.tsx`.

## MediaBoard — several ordered photo sets on one board; MediaCard compact — 2026-09-27

For the Media page rebuild (images P3b, `docs/images-studio-rebuild/PLAN.md` §5.1–5.2: "a multi-row photo board with keyboard move between rows"). **`MediaBoard`** (new, `components/MediaBoard.tsx`): each row is one ordered set (Common, one per colour, safety, per SKU), the first tile is the row's main photo (★). A tile moves within its row or into another row by drag, by keyboard (arrows move the focus between tiles and rows; Space picks up, arrows choose a row and a position, Space drops, Escape cancels; M makes it the main photo; Delete removes it from the row, never from the library) or from its menu (Make main photo, Move earlier/later, Move to ▸ row, Also use in ▸ row, Remove). Alt while dropping — or Alt+Space — adds a copy and keeps the original. Photos dragged in from outside the board carry `MEDIA_BOARD_EXTERNAL_TYPE` with a JSON array of ids (`onDropExternal`). A roving tab stop keeps the board one Tab long; announcements go to a polite live region; a row can be read-only (`editable: false`); tiles take `badges` and a `warning`/`danger` edge. **`MediaCard compact`**: a dense tile for long lists (a photo library) — one-line name, the selection tick labelled "Select …", small paddings, a 240 px preview request. Styles: `.nds-media-board*`, `.nds-media-card.compact`, `.nds-media-card-name` (container query stacks a row's head above its tiles under 560 px). Catalog: `MediaGalleryExample` (MediaBoard + compact card). Mirrored in Factory: `MediaBoard.tsx`, `MediaGallery.tsx`, `components/index.ts`, `catalog/MediaGalleryExample.tsx`, `styles/components.css`.

## Variation theme tooltip carries the delivery note — 2026-09-27

`grid/renderers/variationTheme.tsx` — **`variationThemeTooltip`** now ends with the cell's **`deliveryNote`** when the cell is writable (it ended with `writeBlockedReason` only when it was not). The product-sheet create path (step 4/6) serves the theme cell writable on a market with no listing yet, with the note "Saved to the Amazon · SE draft. Publish sends it."; before this the note reached the axes editor's banner but not the cell's hover. Etsy's existing note ("Saved as a Nexus draft …") shows there too. Mirrored in Factory: `variationTheme.tsx`.

## Customise: always-shown columns, emptied groups; NexusGrid left-only pins — 2026-09-27

Rearranging in the product sheet's Customise (Owner, 2026-09-27: "I'm unable to rearrange the progress bar columns"). **`PreferencesColumnSpec.alwaysShown`** — a column that is always on screen yet the operator's to move and pin: its tick is held on ("Always shown"), its In-view row has no ✕, and no hide reaches it (a group's Clear, Clear all, bulk Hide). Unlike `locked` it keeps its place in its group and in the order — a locked column in the middle of the list was dropped from the In-view pane altogether. **Emptied groups**: a group whose every column was moved into another is left out of the tick-list, and the In-view pane marks it "Empty · drag a column here to put it back" instead of a count of 0/0 and a Show button that did nothing. **`NexusGrid pinSides="left"`** — the header menu's Pin offers only "No pin" and "Pin left" (AG's `clearPinned`, `pinLeft`), for a grid whose column model keeps left pins only. Mirrored in Factory: `PreferencesModal.tsx` (Factory has no `NexusGrid`).

## Sheet toolbar rebuild: menu headings and on/off items, Customise select-all, column menu verbs — 2026-09-27

For the product sheet's toolbar rebuild (Owner, 2026-09-27: "extremely confusing … especially the filters thing, the different chips"; `docs/product-sheet-toolbar/PLAN-2026-09-27.md`). All additive and opt-in; every other caller is unchanged. **`Menu`** — `MenuItemDef.heading` renders a section heading (not focusable; the arrow keys pass over it; the Listbox group heading's look, `.nds-menu-heading`), and `checked` makes an on/off item (`role="menuitemcheckbox"`, `aria-checked`, a ✓ in a fixed slot). **`PreferencesModal`** — `bulkPick` adds "Select all · Clear all" above the tick-list; with filter text they act on the matches only ("Select all 12 matches") — the Owner could not select every attribute when a text field was split per language. `rememberInteraction` keeps the filter text and the open groups from one opening to the next (the selection and a drag still reset). `confirmLabel` names the primary button ("Save “Launch check”"). `PreferencesColumnSpec.uncounted` lists a column without counting it (the sheet's progress bars), so the dialog and the toolbar agree on one number. **`GridViewsMenu`** — `headings` names the sections (Built-in views · My views · Team views · the active view's own verbs under its name), `triggerLabel` / `triggerAriaLabel` replace the computed trigger, `afterPresets` and `endItems` add the caller's items after the built-in views and at the end. **`NexusGrid`** — a column's own header-menu verbs from `colDef.context.menuItems()` (AG's `colDef.mainMenuItems` would replace the whole menu, Customise and Reset included); the sheet's progress columns use it for "Refresh progress". Styles: `.nds-menu-heading` (with `.nds-menu-heading-name`: a view's name keeps its own letters), the `menuitemcheckbox` tick, `.nds-prefs-pickall`, `.nds-toolbar-menu-lead`, `.nds-toolbar-rows`. Catalog: the Overlays card's "Rows ▾" menu, `PreferencesModalDemo` (bulk pick), `GridViewsMenuExample` ("As a sheet's Columns menu"). Mirrored in Factory: `Menu.tsx`, `PreferencesModal.tsx`, `styles/components.css`, `styles/patterns.css`, `grid/theme/grid.css` (Factory has no `NexusGrid`, grid toolbars or TokenCatalog).

## Focus outlines that paint, and a guard — 2026-09-27

`DetailPopover`'s trigger and panel declared `outline: 2px solid var(--nds-focus-ring)`. That token is a box-SHADOW value (`0 0 0 2px rgb(…)`), so the browser dropped the whole declaration and neither had a visible keyboard focus — every readiness and progress card. Both now use `var(--nds-primary)`, the DS rule `a11y.css` already follows. The same misuse in the app's notifications bell is fixed. New guard **`scripts/check-shadow-token-use.mjs`** (`--self-test`) derives every shadow-valued token from `tokens.css` (lengths + a colour, var() chains followed) and fails any declaration that uses one outside `box-shadow` / `text-shadow` / `filter` / a custom property; it runs in the CI static gates and `gates-full.sh`. Mirrored in Factory: `styles/components.css`.

## Progress meter, progress card, cell landing — 2026-09-26

The sheet's progress columns (Owner-approved preview, 2026-09-26). **Tokens** `--nds-progress-{complete,partial,missing}` (bright, the Owner's ask), each with an `-edge` — the 1px inset line the ground actually meets, so every tone clears 3:1 on every grid row ground in both themes (bright yellow is 1.69:1 and green-600 2.91:1 on the variation row without it) — and `--nds-progress-track`, all resolved through a new tier-1 `palette.signal` ramp (`--nds-signal-*`: the bright red, yellow and its edge, and the dark steps) so no stylesheet carries a literal; measured by the new guard `scripts/check-progress-contrast.mjs` (`--check`, `--self-test`, `--tokens`). **`ProgressBar`** gains `tone` (`complete | partial | missing | unknown`) and `showValue` (bar + one rounded number, `—` for a `null` value); without them it is unchanged. **`grid/renderers/progress.ts`** — colour rule A as ONE pure function, `progressTone`: red while a required field is empty whatever the percentage, yellow when only optional fields are, green when nothing is, grey when it cannot be said (never a guessed green; #43, #727, R-LX-9) — plus `progressDetailModel` (no cap: every field is listed), `progressTriggerLabel`, `progressText`, `combinedPercent`, `progressListKey`. **`ProgressCell`** — the meter in a `DetailPopover`; hover, click, Enter or Space opens **`ProgressDetailCard`**: header (tone swatch, scope · %, the tone in words), one line of counts, then "Required and empty", "Optional and empty" and "Other issues" as a dropdown-style list — full-width rows, sticky tone-coloured group headings, ↑ ↓ Home End, Enter goes, the list alone scrolls (`overscroll-behavior: contain`) — and a footer link. **`DetailPopover panelClassName`**; `nds-detailpop-scroll` caps a panel to `--nds-popover-room`. **`landOnCell(api, { rowId, colId, reveal?, root? })`** — opens collapsed ancestors, shows a hidden column, scrolls the row to the middle, puts the cursor in the cell and marks it `nds-cell-landing` (2px brand ring on a brand wash, pulsing twice, `LANDING_MS` 2400; no animation under reduced motion). **`bandColSpan` / `spanWithinSection` `stopBefore`** — a column a band row does not cover. **`IdentityBand title`** — the band's hover sentence (the channel listing band's moved here from the readiness pill). Catalog: `ProgressExample` under Progress. Lab: `/design/grid-lab/progress`. Mirrored in Factory: `ProgressBar.tsx`, `DetailPopover.tsx`, `styles/components.css`, tokens (Factory has no grid renderers of this kind, no `NexusGrid` and no TokenCatalog — see the mirror note in the PR).

## One value editor, Option A — 2026-09-26

`grid/editors` — the Owner's cell editor Option A (previewed and approved 2026-09-26). **`FormulaCellEditor`** — the one text/number/long-text editor (R-63) — now opens **under** its cell (`formulaCellEditorSelector` and `scalarValueEditorSpec` return `popupPosition: 'under'`; `scalarValueEditor` sets `cellEditorPopupPosition`), so the cell and its row stay in view. **One line, no Cancel / Apply**: Enter saves, Esc cancels, and the foot carries the one key line (R-48, unchanged, alone in `.nds-editor-keyhint`) and, for long text or a capped field, a **counter** (`n / cap`, red past the cap, never truncated). Long text opens a 104px box and keeps "Shift+Enter adds a line." on its own line. `=` expands the formula help below the line as before (signature, suggestions, Insert field / Add text / Help, click a field in the row, live result, error marks). **Enter or Tab on a formula with an error** says "Not saved. … Fix it, or press Esc to cancel." and keeps the draft; **`suppressFormulaKeys`** now hands Tab to the editor on a formula (`data-formula`), which checks it like Enter and then moves as AG would (`tabToNextCell` / `tabToPreviousCell`) — a broken formula is no longer committed by Tab. **Context icons, only when present** (`CellEditorContext`, new `FormulaWiring.contextFor`, and `maxLength` on the selector's column): ✦ AI draft (Use it / Dismiss, the review's own verbs), History (earlier values, read when opened; picking one fills the field), Follows <row>. Tooltips are portaled (`TooltipPortalProvider`) so the editor never scrolls sideways. `CELL_EDITING_UNDER_CLASS` marks a cell whose editor sits under it; `grid.css` #769 no longer hides that cell's value. Inside a cell editor, focus is a 2px primary ring, not the black frame forms draw (`.nds-field:focus-within` / `.nds-readable :focus-visible`). New anatomy in `grid.css`: `.nds-formula-line`, `-context`, `-contextpanel*`, `-historyrow`, `-note`, `-foot`, `-count`. Catalog: `FormulaEditorExample` shows the icons and the counter. Mirrored in Factory: `FormulaCellEditor.tsx`, `editors/index.ts`, `theme/grid.css`.

## Team views, product-type defaults, rule views, capped menus — 2026-09-26

`grid` — SHEET-VIEWS phase 2 (Owner-approved 2026-09-26). **`GridViewsMenu`**: my views first, then the views teammates shared, after a rule; a team view's second line reads "Shared by <name>" (a display name, never an email; "a teammate" when there is none) and its only verb is Duplicate…. My own view gains **Share with team / Stop sharing** and, with the new optional **`productType {code,label}`** prop, **Make default for <Type> products / Stop default**; both verbs appear only when the views API offers `setShared` / `setTypeDefault` (now on `useGridViews`), so every other caller is unchanged. New optional **`viewColumnCount`** — the count beside a saved view (a rule view counts what its rules add). Deleting a shared view warns that the team loses it too. **`SavedGridView`** gains `owned`, `shared`, `teamShared`, `sharedBy`, `defaultProductTypes` (an older server reads as mine and unshared). **`productTypeDefaultView(views, type)`** (`views/landing.ts`) — my default for the type, else the team's newest. **Rule views** (`views/viewRules.ts`): an optional `rules` list on the columns payloads — `group`, `required`, `gaps` — resolved when the view is applied, so a new column there joins by itself; `viewRulesOf` (checked read), `viewRuleMatches`, `withViewRules`, `viewRulesFor` (a save stores every fully ticked group, and an offered fact rule while all its columns stay ticked), `describeViewRules` ("Follows required fields, the Content group"). **`usePopoverPosition`** publishes the room on the side it opened as `--nds-popover-room`; **`.nds-menu`** caps to it and scrolls (measured: a 756px views menu under a 906px viewport hid Delete… 33px below the fold). A panel with its own CSS cap is unaffected. Catalog specimen: `GridViewsMenuExample` under Grid. Mirrored in Factory: `usePopoverPosition.ts`, `styles/components.css` (Factory has no grid views, toolbars or TokenCatalog).

## Blank empty cells, view display, folded-filter and footer fixes — 2026-09-26

`grid` — SHEET-VIEWS (Owner-approved 2026-09-26). **`NexusGrid emptyCells`** (`'dash'` default | `'blank'`): an editing grid draws nothing for a value nobody entered. The mode rides a context (`renderers/emptyCells.ts`: `GridEmptyCellsContext`, `useGridEmptyCells`, `BLANK_CELL_LABEL`) that `EmptyValue` and the variation-theme child cell read; the words stay for a screen reader (`.nds-vh`, "No value" / the child reason). A measured zero keeps its dash and title in both modes. The wrapper carries `data-empty-cells`. **`nds-cell-na`** — a diagonal hatch (a background image in `--nds-border`, so row tint, hover and range selection show through) for a cell that does not apply to its row; `variationThemeColumnDef` adds it on child rows. A followed-but-empty link mark turns `--nds-text-3`. **Views** — `ViewDisplay` on the columns payloads (optional, additive, no schema bump): `columnWidths`, `sort`, `density`; `viewDisplayOf()` reads them checked. **`useToolbarOverflowTier(anchor, armed)`** — a fold tier that latches only after the tier before it; the studio sheet folds its new row-height control before its verbs. **`GridToolbarFold`** — the panel is portaled and placed by `usePopoverPosition` (it was clipped under the grid by the toolbar's `overflow: auto`). **`PreferencesModal viewSave.startNaming`** — open with the view-name field showing ("New view…"). Sheet status strip: the FAB reservation applies only while the FAB is on screen (`:root:has([data-nds-fab])`), and the strip shares the toolbar's 6px gutter. **Selected rows** (Owner: "it should be selecting the whole row") — every cell of `.ag-row-selected` carries a 12% `--nds-primary` wash as a background image (over the child-row tint, which used to paint over the selected colour, over cell tints, beside the hatch) and the checkbox cell a 3px primary rail; a pointer tick no longer leaves AG's focus box or the checkbox halo (keyboard focus keeps both). Engine-wide: the products grid selects the same way. Catalog specimen: `EmptyCellsExample` under Grid. Mirrored in Factory: `cells.tsx`, `emptyCells.ts`, `variationTheme.tsx`, `editors/shapeColumn.ts`, `theme/grid.css`, `renderers/index.ts`, `PreferencesModal.tsx` (Factory has no `NexusGrid`, views or toolbars, and no TokenCatalog).
## DS fonts only — no Arial — 2026-09-26

Owner: "I've started to see Arial text in a lot of it … It must never happen again." Measured on 86 pages: next/font's default metric fallback face is `local("Arial")`, so every character the loaded Inter subsets lack (→ ≤ ≥ ✓ ↕ ⚠ ✦ …) and all text before Inter arrived was drawn in Arial; and 107 declarations named their own fonts (monospace stacks, `-apple-system` stacks, Arial on SVG logo letters, Amazon Ember in the ads console). **Fixed:** both root layouts (web, Factory) load Inter, Space Grotesk and JetBrains Mono with `adjustFontFallback: false` and a system-UI `fallback` stack; the Tailwind and body stacks no longer name Arial or Helvetica; every literal stack is now `var(--nds-font-mono)` / `var(--nds-font-sans)`; SVG letters inherit the page font; the ads console uses Inter (Owner's choice) and no longer loads Amazon Ember from Amazon's CDN. **Held by** `scripts/check-font-families.mjs` (strict, zero findings; `--self-test`), in CI's static gates and `gates-full.sh`. Output that is not the app's UI (printed labels, eBay listing HTML, generated images, email iframes) is a reasoned exception in that file.
## Picked file, job progress and file downloads (PSIE) — 2026-09-26

`FileRow` shows the one file an operator picked, in place of `FileDropzone`: a file-type icon, the name (truncated; the whole name in `title`) with its size, a status line, a ghost `sm` "Replace file" and a × named "Remove file" — both 28px, both described by the file name, both locked by `disabled`. `tone="danger"` marks a refused file; the status line carries the reason in `--nds-danger-text` (9.67:1 light, 8.85:1 dark on `--nds-surface`). `JobProgress` shows a background job in a dialog: the label, a `ProgressBar` (determinate only when `value` and `max` are both given — `jobPercent()`), a count line that is an always-mounted polite live region, the elapsed time as a `timer` that ticks each second from `startedAt` and stops on unmount (it reads "0 s" before the first tick, so server and client agree), and a muted note; the numerals are tabular. `lib/format` gains `formatBytes` ("673 KB"; never four digits) and `formatElapsed` ("1 min 1 s"). New `lib/download`: `downloadBlob(blob, filename)` (an attached, hidden anchor; the object URL is revoked after 40 s), `downloadResponse(response, fallbackName)` (the name from `Content-Disposition`, `filename*` first; a failed response throws instead of saving an error page) and `filenameFromContentDisposition()`. `grid/export`'s `downloadCsv` now hands its Blob to `downloadBlob`. Styles: `.nds-filerow-*`, `.nds-jobprogress-*`, semantic tokens only. Catalog specimens: `FileRowExample`, `JobProgressExample`, `DownloadExample`. Mirrored in Factory, except the catalog registration (Factory has no TokenCatalog) and `grid/export` (Factory has none).

## Button wrap — 2026-09-26

`Button` gains `wrap`: the label may break across lines, anywhere if it must (`.nds-btn.wrap` sets `white-space: normal`, `overflow-wrap: anywhere`, `text-align: start`). For a link-like button whose label is data, such as a SKU. `.nds-btn` is `nowrap`; measured in a real browser at 390 px, a 63-character SKU link in the saved listing issues card was 642 px wide and pushed its row off screen. With `wrap` it is 324 px wide on three lines, with the focus ring around all of them. Opt-in: every existing button keeps its single line. No token, colour or size changed. Catalog specimen under Primitives › Button (web). Mirrored in Factory.

## Tag text contrast — 2026-09-25

The saved listing issues browser check found danger Tag text at 6.41:1 light and 6.92:1 dark. Source-derived measurement also found success at 4.57:1 light. Both tones now use their existing semantic text tokens. The contrast gate reads each Tag tone’s actual foreground/background from primitives.css in both apps, so a passing unused token cannot hide a component mismatch. No fills, token values, thresholds, or APIs changed. The catalog documents all five tones.

## Store fields drawn by their type — 2026-09-24

`grid/renderers` — `MetafieldValue` draws one stored value by its type, using Shopify's metafield type vocabulary, so any connected store's fields read as what they are with no per-store code. The pure rules are in `metafieldDisplay.ts`. A file reference shows its picture (24 px, `cdnFit`). A product reference shows the product's picture and name. A metaobject reference shows the entry name; names still loading read "Entry" in italics, never a raw ID. Other references show name chips with "+N". Colours show swatches with the first hex. Yes/no shows a mark and the word. A rating shows five stars and "4.5 / 5". Numbers use tabular figures. Money, weight, volume and dimension show value and unit. Rich text shows its words. JSON shows "N properties". Lists of scalars reuse `ListChipValue`. A value that does not parse for its type reads "Stored value needs review". An unknown type shows its stored text. Everything is laid-out flex, with nothing absolutely positioned (PES.7 ruling #12). Styles are in `grid/theme/grid.css` (`.nds-mf-*`, tokens only). Catalog specimen: `MetafieldValueExample` under Grid. The first consumer is the studio's Shopify scope (`CascadeCell`). Mirrored in Factory, except the catalog specimen: Factory has no TokenCatalog.

## Bullets in one cell — 2026-09-24

`grid/editors` — Step 4.3 #3 (A-52; R-55, R-56). `SlotListEditor`: one popup editor for a list of positions, in two modes — `slots` (a channel's fixed positions, e.g. Amazon's 10 bullets: every position shown, an empty one kept in place, never compacted) and `list` (Shared bullets: the items plus one trailing empty position; blanks dropped on commit). It composes `OrderedList` (stable ids, drag and labelled up/down buttons) and a DS `Textarea` per position with a counter against the channel's cap; an over-cap position is marked (`aria-invalid`, the counter), never truncated. Keys (R-55): Tab / Shift+Tab move between positions, Tab on the last (Shift+Tab on the first) is left to AG, which commits and moves right (left); Alt+↑/↓ move the focused bullet with the same announcement `OrderedList` makes; Enter saves; Shift+Enter never adds a line; Esc cancels. Every change is reported through `onValueChange`, nothing on mount; opened and untouched cancels. Its key line is the new `EDITOR_KEY_HINT_FORM` ("Enter saves · Tab next bullet, then moves right · Esc cancels" — the one stated exception to `EDITOR_KEY_HINT`; the Enter and Esc parts are held equal by a test). `slotListColumnDef`: the ONE ColDef both sheet builders return for the one cell over a slot group — the selector cleared, the fill handle off, no paste parser, Delete writes nothing, a setter that writes only the changed positions through each slot column's own setter, structural equality, "N of 10 · first bullet" with the shared provenance mark and the positions' worst save state. `slotList.ts`: the pure rules. New `editorBox` kind `slotlist` (560 × ≤480). Styles in `grid/theme/grid.css` (`.nds-slotlist-*`, layout only). Mirrored in Factory.

## AAA text palette — 2026-09-24

Step 4.3 #5 (A-51; R-49, R-65, R-66). Every text pair measured by the then-current token gate reached 7:1 in both themes; the Tag use-site gap is corrected in the 2026-09-25 entry. `check-nds-contrast` went from 49 of 90 pairs below 7:1 (10 below 4.5:1) to 0 of 92, and Factory's own palette from 56 of 104 to 0 of 106. The push gate now holds both apps at 0 / 0. Light: `--nds-text-2` grey-700 #3a4452 · `--nds-text-3` #48505b · `--nds-text-muted` = text-3 · `--nds-text-link` and `--nds-primary` blue-800 #134da3 (the darker brand blue; white on it 8.02:1) · `--nds-primary-hover` #0f4290 (blue-700 is lighter than the new primary; white on it 9.54:1) · `--nds-pill-success-fg` #094397 · `palette.amber.text` #6b4800. Dark: text-2 #c3ccd6 · text-3 #b3bac6 · link #9cc2f3 · primary #98bbf0. `.dark` now declares `--nds-primary-hover` #b3cdf4 (it had none, and dark buttons hovered to the light fill at 2.66:1), and `--nds-amber-soft` / `--nds-amber-text` #3a2e12 / #f2bc79 (it painted the light chip). The gate now also measures the button label on the hover fill. The JS roles in `tokens/colors.ts` (`color.primary`, `primaryHover`, `text2`, `text3`, `textLink`) carry the same values, so the catalog swatches and `PerformanceGraph`'s axis labels (#48505b, 8.16:1) match the CSS. Text-2 and text-3 now sit close in colour; text-3 stays distinct by size and weight (R-66). Unchanged: `--nds-focus-rgb` and `--nds-info` stay on blue-600 #1f6fde. The grid spec's `stripFg` follows (#3a4452 / #c3ccd6). Mirrored in Factory (Factory has no grid spec or TokenCatalog).

## One text/number cell editor — 2026-09-24

`grid/editors` — ONE text/number editor on every studio surface (Step 4.3 #1, A-42 as amended by A-49; R-47, R-48, R-63). Number cells refuse a typed letter and keep their value (`numberEntry.ts`); the value editor's key line is `EDITOR_KEY_HINT` ("Enter saves · Tab saves and moves right · Esc cancels"); where no formula is available (a refused column or row, or a sheet built without formula wiring — the Variants page) the same popup opens with formulas off (`scalarValueEditor`, `scalarValueEditorSpec`); `textEditor()` returns it too; `EDITOR_MODE_BY_KIND` declares text/number `popup`. Mirrored in Factory.

## Scope menu, language control and folded filters — 2026-09-24

Step 4.3 #2 (A-44, R-51/R-52/R-53). `ScopeBar variant="menu"` — one 28px trigger showing the active scope as its chip would, and a listbox of every scope with its dot, state word and % (a held scope stays reachable and announced); the default chips are byte-identical. `ScopeBarReadiness.summary` replaces the state word and % with a sentence ("See each channel"). New `worstScopeState()`, `scopeMenuOptions()`. `MultiSelect`: `size="sm"` (28px), `width`, `minSelected`, `formatLabel`, `id`, and focus management for every caller (into the popover on open, back to the trigger on Esc / Tab out). `OptionList minSelected` + `nextSelection()`. `ListboxPanel`: Enter commits what the operator is ON — the highlight starts on the selected row and follows focus (it committed a hidden row 1 on short lists); ↑/↓ move focus on short lists; `heldReason` options. `GridToolbarFold mode="always"` + `activeLabel`. Mirrored in Factory.

## Detail popover — 2026-09-24

`DetailPopover` is a toggletip: a real button opens a non-modal dialog by click, Enter, Space or a 350 ms hover; the panel can hold actions, keeps Tab inside, and Esc returns focus to the trigger or to a caller-named element (the grid passes the cell). `HoverCard` is unchanged: text only, tooltip semantics. `ScopeReadinessCell` takes optional `detail` / `detailLabels`; without them the cell is byte-identical. `cellDetailKeys` lets a locked column open its cell's detail with Enter or Space. Mirrored in Factory.

## DateField calendar in dialogs and grids — 2026-09-19

`DateField`'s calendar is portalled with fixed coordinates (`usePopoverPosition`), like `Listbox`: in flow it was cut off by any scrolling or overflow-hidden ancestor — inside a DS `Modal` only a 4 px strip showed. Its body now uses the `nds-dp-cal` box, as `DateRangePicker` does (the title and the grid sat side by side with no padding). Keyboard: opening moves focus to the chosen day (else today, else the first day that can be picked); Tab and Shift+Tab stay inside the calendar; Escape closes only the calendar (a host `Modal` stays open) and returns focus to the field; choosing or clearing returns focus too. Each day is named by its full date, with `aria-pressed` for the chosen day and `aria-current="date"` for today. The calendar carries `ag-custom-component-popup`, so a DateField inside an AG Grid cell editor does not end the edit when a day is clicked. `DateTimeField` names its controls with the chosen date and time. Mirrored in Factory.

## End date and time — 2026-09-19

Added `DateTimeField`: a moment in time as a `DateField`, a time `Listbox` (15-minute steps by default) and the viewer's time zone named beside them. `value`/`onChange` are an ISO instant (UTC), so the stored moment never depends on who reads it. `min`/`max` are instants: days outside them cannot be picked and, on the edge days, the times outside them are not offered. Both controls keep their own size; the row wraps on narrow hosts. Used by Sync Control end times ("Fixed number until …"). Catalog specimen under Date and time; mirrored in Factory.

## Product selection — 2026-09-15

Added `LoadedRowsSelectionHeader`: a shared Checkbox header that selects explicit loaded rows without an implicit server-wide selection. Checked/mixed state follows loaded rows as groups expand. Mirrored in Factory.

## VP.F Variants final pass — 2026-09-11

Added SummaryTable for compact drawer comparisons and OrderedList.keyboardGrip/compact for 28px rows with drag plus keyboard order. BulkActionBar Clear now composes the shared sm Button. Sheet toolbars use one 40px band. Projection Needs a value uses the shared row missing/warning tone. Semantic tokens cover light/dark.

# Changelog — Nexus Design System

## Scrolling tab bars — 2026-09-11

`Tabs overflow="scroll"` constrains long labels to the host width and keeps the active tab visible. Arrow, Home and End navigation retains the existing roving focus behavior. Optional mode preserves existing consumers; mirrored in Factory and used in Products → Categories.

## Quiet channel cells — 2026-09-10

`TooltipPortalProvider disabled` renders labelled controls without tooltip wrappers, portal state or hover listeners, including nested providers and explicit portal hints. Channel sheets use it around the grid body and offer full cell explanations through Cell details. Header help and toolbar hints remain available. The provider and regression tests are mirrored in Factory; Factory has no channel grid or TokenCatalog. Measure cells expose the full unit through their accessible label without a competing native title.

## Mixed product media — 2026-09-10

`MediaPreview` supplies image, native video/audio, external-video and unknown-file presentation. Native playback is explicit; video supports alternative sources, posters, language-labelled WebVTT tracks and a transcript disclosure. Failed previews and caption loads announce a useful fallback. File links reject executable protocols; existing image-only data URL previews remain supported.

`MediaStrip` is non-interactive grid content with poster thumbnails, type icons, missing-preview handling and a full media count. The grid owns the edit action. `MediaGalleryItem.mediaType` and `placeholder` carry these same distinctions through the keyboard-reorderable gallery. These components preserve normal Nexus control sizes and are mirrored in Factory.


## Anchored Information editors — 2026-09-10

`Modal.anchor` keeps a cell editor in context on desktop with viewport clamping and the existing focus boundary; narrow screens use the normal modal. `MediaGallery` supports optional removal, one-based position selectors, keyboard pickup/move/drop/cancel and visible insertion feedback. Existing control sizes are retained. Both additions are demonstrated in the media catalog and mirrored in Factory.

## Readable ordering labels — 2026-09-09

`OrderedList.itemLabel` names ordering controls and live announcements independently of stable resource IDs. Shopify linked products and reference lists consume it. Control geometry and keyboard actions are unchanged; component and catalog documentation are mirrored in Factory.

## Shopify file previews — 2026-09-08

`MediaCard` supports missing preview URLs and a file-type placeholder. Documents and processing media retain the same keyboard preview action and card geometry without issuing broken image requests. The shared CDN helper now sizes Shopify image URLs while retaining their version parameters. The component, helper and catalog specimen are mirrored between Web and Factory.

## Sub-sidebar tooltip dismissal — 2026-09-08

Portal tooltips dismiss on activation and Escape, and distinguish pointer focus from keyboard focus. Returning focus after a disclosure closes no longer reopens its hint; keyboard navigation inside an expanded disclosure does not rearm the opener. Fresh pointer movement or a subsequent keyboard visit can show the hint again. The interaction logic and regression tests are mirrored in Factory. No focus restoration, control sizes, styles, or timing tokens changed.

## Grid lifecycle — 2026-09-08

`useGridLifetime` binds the current grid instance, clears it on `onGridPreDestroyed`, and exposes `getApi()` for deferred work. Its reactive `gridApi` identifies replacement grids so hosts can reapply their column layout. A late teardown cannot clear a newer instance. The hook is mirrored in Factory without an AG runtime dependency. Product sheet adapters remain Web-only.

## Account profile assignment — 2026-09-08

AccountsPanel adds optional `onAssignProfile`, `includeDisconnected` and `onChanged` props. The host owns destination selection and review. Inactive accounts retain Reconnect but omit Test, Make primary and Disconnect. Defaults preserve existing consumers.

## ScopeBar active destination visibility — 2026-09-08

The selected scope stays visible inside the chip track after navigation, label updates and resizing. Scrolling is immediate and confined to the track; focus, roving arrow keys and page position are preserved. Factory now includes the same ScopeBar, readiness vocabulary and base styles that its existing workspace layout referenced.

## Light shell semantic colors — 2026-09-08

The shared token source now exposes `--nds-info-text-light` as the stable light information color. Web and Factory generate the same light `--nds-info-text` alias. Web's light shell pins information, tonal and selected-filter roles, including portals, without changing control sizes. The shell guard parses selector lists and resolves aliases in the correct theme and pin contexts, so a generated `.dark, ...` selector cannot be mistaken for light CSS. Information Pill and Tag now use the dedicated text role: deep blue in light mode and primary text in dark mode. Both exceed 7:1 on their information surface. See the catalog theme verification notes.

## Drawer keyboard visibility — 2026-09-07

Modal Drawer excludes controls inside collapsed disclosures from its focus wrap. Geometry alone is insufficient because Chromium may retain rectangles for closed details content. Visibility, tab index, hidden/inert ancestors and closed details are now checked together. The catalog includes a collapsed-action example; source and documentation are mirrored in Web and Factory without control-size or token changes.

## Listbox focus recovery — 2026-09-07

Selecting an option or dismissing Listbox with Escape returns keyboard focus to its trigger. Tab can then continue to the next field instead of restarting from the document. Click-away retains focus at the clicked destination. The shared fix is mirrored in Web and Factory without control or token changes.

## Save recovery — 2026-09-07

The Web-only SheetWriter supports scoped recovery reads with product/listing versions and domain checks for reference names and reset inheritance. It preserves newer queued edits, rejects late results after discard, compares structured values, and exposes unconfirmed-cell counts for Reload review. The grid catalog includes an unconfirmed-save Reload specimen. Existing Modal, Button, Input and grid status surfaces retain their sizes and styles. Factory has no grid writer adapter; both catalogs document this boundary.


## Family action cancellation — 2026-09-07

The Web-only grid action runner accepts `ActionImpact.cancelled` from a parameter picker and returns its existing silent cancellation outcome before confirmation or execution. The Web grid catalog demonstrates cancelled selection and demotion with named children. Product pickers compose the existing shared Modal and AsyncListboxPanel. AsyncListboxPanel now marks its search field for Modal’s initial focus; this shared change is mirrored in Web and Factory. Control sizes and styles are unchanged. Factory has no grid action adapter to mirror.

## Tooltip token parity — 2026-09-07

Factory now defines the shared tooltip foreground/background roles already used by Web. The token resolution guard recognizes actual TypeScript object style assignments (including grid geometry and portal arrow positioning), while rejecting documentation and type-only declarations as definitions. Shared component export order is aligned.

## Information grid states — 2026-09-07

`GridLoadingOverlay.rowKind` matches text, media and single-line thumbnail rows at the selected density. Existing `media` callers retain their behavior. The React overlay wrapper fills the grid width so percentage-width skeleton lines remain visible. The Web grid catalog includes a product-row loading specimen. Information sheets use Nexus loading/empty overlays and shared error/retry controls; unavailable reads disable layout and data actions while retaining recovery. Grid adapters remain Web-only, as documented in both platform READMEs; Factory has no grid adapter to mirror.

## Account permission accuracy — 2026-09-07

`AccountsPanel` distinguishes an unrecorded OAuth grant from recorded missing permissions. An empty grant list shows neutral explanatory text and a plain Reconnect action; it no longer claims every catalog permission was denied. Recorded grant shortfalls retain the warning and count. Web and Factory share the behavior and regression coverage.

Newest first. Each shipped phase is an entry. Token-value changes that
intentionally restyle the app, and breaking changes to token names or primitive
props, are called out explicitly with a migration note.

## Asynchronous choice panel — 2026-09-07

`AsyncListboxPanel` composes Field, Input, ListboxPanel and Buttons for externally loaded choices. It provides loading, empty, error, retry and cancel states with standard small controls. The caller owns fetching and filtering; the panel commits option values only, skips disabled options, and keeps the input's active descendant synchronized with grouped choices. Escape cancels and Tab reaches actions without stepping through every option. `ListboxPanel.optionTabIndex` is optional, preserving existing consumers. Product categories, description themes and shipping templates consume this panel. Source and catalog examples are mirrored in Factory.

## Dense header metadata spacing — 2026-09-07

`DetailHeader dense` reserves its metadata track up to half the title area above the mobile breakpoint. Identity text truncates inside that track while fixed pills stay clear of autosave and actions. This fixes the product header overlap at 900px and leaves the existing mobile wrapping behavior intact. The layout rule is mirrored in Factory.

## Compact formula editor — 2026-09-07

Formula cells and forms use the standard Nexus `sm` controls (28px), concise in-context guidance and one consistent action row. Add text and Help are disclosed on demand; opening either hides suggestions. The body scrolls without shrinking its children into overlapping controls, while the grid action row stays visible. Formula text and its caret share the same measured font and bounds, including after resizing; code ligatures are disabled so `===` remains three visible equals signs. The field owns its focus ring, eliminating the clipped inner-input outline.

`ListboxOption` adds optional `searchText` and `trailing` values. Formula suggestions show each field label once with its current value at the end; technical references remain searchable and available in the option tooltip. `ListboxPanel` measures active rows relative to its own scroll viewport, preserving the first heading and keeping keyboard-selected rows visible in a static editor. Shared Listbox and readable-focus changes are mirrored in Factory. The Web catalog includes a 320px formula form.

## Mapping status contrast — 2026-09-07

Information pills and tonal selected controls now use dark semantic text and surfaces. Information-pill contrast on its dark wash rises from 2.25:1 to 11.23:1. Factory also declares the missing light `--nds-info-strong` role. `MappingStatusExample` exercises both treatments in the catalog; source changes are mirrored between Web and Factory.

## Formula recovery and accessible controls — 2026-09-07

`Modal readable` and the shared `nds-readable` composition provide primary semantic text and a visible keyboard focus ring without changing control sizes or input typography. Modal also makes background content inert, respects nested dialogs and honors `data-autofocus` without a Strict Mode focus jump. `SegmentedControl wrap` accommodates longer choices on narrow screens. `DataGrid keyboardScroll` adds a labelled keyboard focus stop only when its table overflows; `ListboxPanel ariaLabel` names external suggestion lists. Shared source and styles are mirrored in Factory.

The Web formula editor uses these controls, includes `===` comparison guidance and improves reference-token contrast. Bulk Apply and Formula history share the same guidance and expose persisted progress, safe continuation and undo after reload. The opt-in development specimen uses a disposable database; see the catalog documentation for commands and verification scope.

## Formula workflow consistency and modal access — 2026-09-06

Added the web grid's exported `FormulaComposer` and `FormulaGuidance`, shared by drawer fields and bulk previews. Insert field and Add text build expressions with the correct quoting; abortable previews include connection retry. Formula replacement accepts the literal value for an atomic save. The per-product save queue refreshes once after all writes settle and handles unmount/Strict Mode cleanup.

Shared `Modal` traps Tab, restores its opener, lets the top dialog handle Escape, preserves a scoped dark theme, and wraps footer actions at narrow widths. Formula guidance and modal explanatory text use primary semantic text for stronger contrast. Modal source and layout changes are mirrored in Factory. The web-only grid adapter stays in Web. Catalog documentation records the shared behavior.

## Guided formula editing — 2026-09-06

The web grid's shared formula selector keeps text, long text, and numeric cells formula-aware after opening; structured controls can switch to formulas with `=`. The editor provides immediate guidance, keyboard suggestions, same-row reference picking, live results, and explicit Apply/Cancel. Invalid formulas stay open when submitted. Copy/fill carries expressions so each target row evaluates its own fields. `ListboxPanel` exposes an ID for combobox `aria-controls`; that shared change is mirrored in Factory. See the web catalog's `#formula-editor-example`.

## Workspace navigation and neutral notices — 2026-09-06

Secondary navigation links, group labels, and neutral Banner descriptions now use `--nds-text` for AAA normal-text contrast in light and dark themes. Navigation geometry and interaction remain unchanged.

## Responsive drawer actions — 2026-09-06

- Drawer footers wrap action buttons and retain their height at narrow widths. A 390px listing-preset review previously placed its Close button at x=-157px; shared wrapping keeps actions within the panel. Desktop single-row footers retain their geometry.

## Embedded editors — 2026-09-06

- Added `Drawer mode="embedded"` for reusable editors within a page. It retains shared header/body/footer/confirmation content and respects surrounding navigation. Existing modal and dock behavior is preserved. Both catalogs include a specimen.
- Fixed the info wash in dark mode using the existing semantic primary wash and link text roles; the previous light wash made Banner text difficult to read.

## Catalog and product workspace integration — 2026-09-06

- Added `OrderedList`: controlled ordering with optional drag grips, keyboard-operable move buttons, disabled boundaries and live position announcements. The eBay axis/value editor consumes it while preserving the existing ordering service and presets.
- Added the `nds-workspace-scope` ScopeBar layout for an independent, wrapping scope row below WorkspaceSubheader. The title toggle divider ends above this row and reserves no content column.
- Added an interactive OrderedList catalog specimen. Shared components, styles, exports and catalog documentation are mirrored to Factory.


## Shared column customization — 2026-09-06

- Adopted the grouped product modal across advertising WorkspaceGrid, DataGrid, Campaigns, and reporting section controls. Search, group operations, multi-selection, and keyboard reorder remain in the shared Nexus implementation.
- Replaced the older `ColumnCustomizer` dialog with a compatibility adapter to `PreferencesModal`; updated the catalog and mirrored the modal, logic, and grouped styles to Factory.
- Normalized grouped order before confirmation and saved-view writes. Advertising stores now retain hidden-column order, group assignments, and locks alongside their existing preferences; old keys and layouts still load.
- Connected operator locks to actual AG Grid pins, including Campaigns' four-column Bid Algorithm bundle. Resizing and header moves retain the new layout metadata.

## Workspace secondary navigation — 2026-09-06

- Added `WorkspaceSubheader`: a 48px toggle cell beside the title and tabs, with no reserved column below the strip. The 224px secondary panel overlays the workspace, follows measured shell edges, scrolls internally and fills the available workspace at narrow widths.
- Extended `Drawer` with optional left placement, shell insets, a transparent dismissal backdrop and a labelled collapse icon. Escape, focus containment/restoration and reduced motion apply. Outside dismissal consumes the click.
- Extended `Menu` with controlled state, selected destinations, keyboard navigation and routing adapters; `DetailHeader.titleMenu` places it beside the heading. Sidebar and title menu share one open-surface state. Links retain browser-native modified-click behavior.
- Product Studio consumes existing visible views and permission-filtered catalog destinations. View links retain scope, market, locale and record context. Its global header is visible; compact search and a stacked subheader keep narrow layouts usable.
- Shared source/styles are mirrored in Factory, including its previously un-emitted spacing scale. The catalog example includes a long-list and long-label specimen at `/design-system#workspace-subheader-example`.

## Value source indicators — 2026-09-06

- Added `SourceIndicator`: consistent icons with accessible source descriptions, optional labelled actions, focus/hover portal tooltips and a visible-label mode for legends. Informational sources remain keyboard accessible without offering a disabled action.
- Channel sheets show a chain for Master, a pin for listing overrides, and distinct mapping/default/missing/link/formula states. Resolver source metadata distinguishes a missing Master value from an unmapped attribute. Defaults and expressions do not claim to follow Master.
- Cell controls use a 24px target and semantic text/focus colors. The component, styles and export are mirrored in Factory; examples are in the catalog’s component section.

## Advertising AG Grid adapters and tooltip layer — 2026-09-06

- Web advertising uses `grid/workspace` and `grid/datagrid` behind the existing Nexus props and saved preferences. Other platforms retain their current grid imports.
- Workspace selection and starting page now synchronize after AG initializes. Keyboard navigation follows the displayed page; embedded controls keep native Tab behavior.
- DataGrid preserves content-driven detail-row heights, accessible grid labels, and in-cell input focus during parent updates.
- Added `Tooltip portal` and `TooltipPortalProvider`. The advertising adapters enable the shared tooltip layer above sticky headers and scrolling panes, including first-row action buttons. Inline tooltips elsewhere retain their existing mode. Portal tooltips support focus, Escape, scroll/resize positioning, and viewport clamping.
- Advertising theme roles live in `tokens/workspace.ts`; shared tokens and tooltip changes are mirrored in Factory. The web grid engines are not installed in Factory.
- Reusable examples: `/design/grid-lab` (advertising comparison scenarios) and the Tooltip section of `/design-system`.

## Catalog transfer alignment — 2026-09-06

- `/products/catalog-transfer` now composes Nexus headers, cards, tabs, fields,
  listboxes, radio cards, file dropzone, banners, metrics, progress, table and
  pagination. Feature CSS handles layout and domain content using `--nds-*` tokens.
- Added `Disclosure` for collapsible supporting content, with native keyboard
  semantics, tokenized focus and expanded chevron. Closed/open examples live in
  the catalog. Its props extend native details attributes and add `summary`.
- Added optional `ariaLabel` to `DataGrid` and `ProgressBar`, preserving accessible
  names during migration. Existing consumers render as before when omitted.
- Shared component and style changes are mirrored in the factory design system.

## [PES.1c] — 2026-09-01 — `--nds-z-modal` → `--nds-z-drawer` (naming only)

Found by PES.4's z-order bug and diagnosed at the token: **`--nds-z-modal` (1410) had exactly ONE
consumer in either app — `.nds-drawer`.** Modals have no layer of their own; `.nds-modal` renders
inside `.nds-backdrop`, which is `--nds-z-overlay` (1400). So a token named for MODALS was the
drawer's layer, sitting above the layer modals actually occupy — which is how a confirmation raised
from inside a drawer rendered behind it. `--nds-z-drawer` was an unused name.

- Renamed at source (`tokens/css-vars.ts`) in both apps, regenerated `tokens.css` /
  `tokens-global.css`, and moved the single consumer in each app's `components.css` together.
- **Value unchanged (1410) — zero visual change, verified**: a real `.nds-drawer` element still
  computes to `1410`, `--nds-z-overlay` is still `1400`, and `--nds-z-modal` no longer resolves.
- ⚠ NOT changed, and queued for the Owner: **whether a confirmation should out-rank a drawer at
  all.** That is a stacking decision touching every modal+drawer pair app-wide, and it is a
  different question from what the layer is called. This entry only removes the trap that made the
  wrong answer look right.

## [PES.1b] — 2026-09-01 — Tabs becomes a real tablist

Parity audit rows 1.22 / 1.24 / 8.16 found the DS `Tabs` bar was a tablist in ROLES only. Fixed at
the DS layer, because fixing it on the page that noticed would fork it and leave every other
consumer with the same gap.

- **Keyboard navigation** — roving tabindex plus ←/→/Home/End, modelled on `ScopeBar`. Measured
  before the change: **zero** `onKeyDown`/`ArrowRight` in the file.
  ⚠ **Intentional behaviour change for every consumer:** the bar is now ONE tab stop instead of one
  per tab, and arrows move within it. That is the ARIA tablist pattern and is what a keyboard user
  expects, but it does change tab order on ~a dozen existing surfaces. Verified on `/design-system`:
  1 tabbable tab of 3, ArrowRight moved Overview→Targeting, focus followed the selection.
- **The `tab` ↔ `tabpanel` pairing** — an opt-in `idBase` makes each tab emit `id` + `aria-controls`,
  and the exported `tabPanelProps(base, activeId)` gives the caller the matching
  `id` / `role="tabpanel"` / `aria-labelledby` for its panel. ARIA wants the relationship stated from
  BOTH ends; the bar previously stated it from neither.
  **Non-breaking, verified:** without `idBase` no `id` or `aria-controls` is emitted, so existing
  consumers are untouched.
- Mirrored into `apps/factory` (`Tabs.tsx` + `components/index.ts`) — both were files the fork-drift
  ratchet holds identical.

## [PES.1] — 2026-09-01 — The scope bar, and a detail header that can be page chrome

Built for the Product Edit Studio's frame (`docs/2026-09-01-product-edit-studio-layout.md`, lane
PES.1), in the DS rather than beside the page that needed them.

- **`ScopeBar`** (`patterns/ScopeBar.tsx`) — choose which LAYER of a record you are editing: a base
  scope plus one chip per channel, each carrying how complete that scope is, an optional `[+]`, and a
  `right` slot for the coordinate controls those chips are read at.
  - Readiness states and their tone/label come from PES.2's `readinessMeta(state, 'scope')`
    (`grid/renderers/readiness.ts`) — this pattern re-exports the type and does not re-declare it,
    and the status dot is keyed on the returned TONE, not on the state name. A local
    `state === 'blocked' ? 'danger' : …` in the bar or in CSS would be a second copy of a mapping
    that two surfaces must agree on. Imported by its deep path because that module is pure; the
    `design-system/grid` barrel would pull the AG engine into a chip row.
  - The percentage is allowed to be `null`. 🔴 `null` renders `—`, never `0%`: in a completeness vocabulary `0%` states
    that everything required is missing, which is a strong and usually false claim about a scope
    nobody has scored yet. `absent` draws a HOLLOW dot so "no answer" does not become a fourth status
    colour to learn.
  - A `radiogroup`, not a tablist — one choice out of N, beside a surface that has its own real tab
    strip. Roving tabindex, arrows/Home/End move the selection.
  - `label` is a visible eyebrow AND the group's accessible name (`aria-labelledby`), so the two
    cannot drift apart the way a visible label plus a separate `aria-label` does.
  - ⚠ It is **not a filter bar**. It changes which stored layer the surface is reading and writing,
    not which rows pass. The ads console's `*ScopeBar` files answer the other question and were
    merged into `AdsFilterBar`; that bar was re-forked at least three times precisely because it
    never became one DS component, which is why this one starts here.
- **`DetailHeader` gains a `dense` form** — the same component as a one-row PAGE BAND: back link
  inline before the title, 48px, a bottom hairline instead of a bottom margin. New optional props:
  `dense` · `meta` (identity that travels with the title) · `status` (a live, non-clickable state
  region, kept apart from `actions`) · `backAsChild` (render the back control as the caller's own
  `<Link>`, the `Button asChild` idiom — a real anchor is the only back control that honours
  ⌘-click, middle-click and "Open in new tab").
  - **Non-breaking, and verified so:** with the new props omitted the DOM is unchanged, including
    not introducing the `.nds-detailhdr-right` wrapper unless `status` is passed. Its only consumer
    is the DS catalog.
  - Mirrored into `apps/factory` byte-identically — the file is one the fork-drift ratchet holds
    identical in both apps.
- Both are in the catalog (`/design-system`), and both are on `--nds-*` only.
- **Contrast, measured on the live frame:** the eyebrow labels first shipped on `--nds-text-3`
  (#7e8796) and measured **3.62:1** and **3.20:1** — that token clears the 3:1 ICON floor, not the
  4.5:1 TEXT floor. Moved to `--nds-text-2`; 16 of 16 text/graphic probes now pass their floor.
  `--nds-text-3` survives only on the `[+]` glyph and the hollow-dot ring, which are graphics.
## Account names — 2026-09-08

Account rows now stack below a 640px container width, keeping identity, scope chips, colour controls and actions readable at 390px. Hosts can name private verification accurately through `reconnectLabelForAccount`, or hold unavailable connectors without a dead button. Mirrored account styles also close Factory's missing account-style block.

`accountDisplayName` and `channelDisplayName` provide a shared name-only identity contract. `AccountSwitcher` and `AccountsPanel` never fall back to seller, connection, or advertising profile IDs, including legacy responses and accessible labels. Missing names are explicit and can be renamed. Scope chips no longer expose opaque marketplace/profile keys. Mirrored in Factory; pure regression tests cover opaque IDs and real names.

## Amazon Seller migration — 2026-09-08

`AccountsPanel` offers a primary replacement action for ENV-managed accounts when the host supplies reconnect. Amazon application-role grants are described without inventing OAuth scope counts, and the panel states that environment credentials remain active until reconnect succeeds. This supports both public website authorization and private-app self-authorization import. Mirrored in Factory.

## [GDS-4] — 2026-08-29 — The master sheet: a bounded sheet host, sheet cells, sheet validation

The Owner asked for "a proper grid where I can actually make changes cell by cell… the source of data… mapped,
converted, or directly pushed to multiple channels of a specific market". Designed in the DS, prototyped in the lab
(`#sheet`, a XAVIA fixture: 4 families, 38 colour × size variations, market IT); the approach and the open
questions are in `docs/2026-08-29-master-sheet-design.md`.

- **`GridSheet`** — the one bounded, virtualised page host (decision Q15): fills the viewport below its own top
  (or a `height` when embedded), compact by default, `NexusGrid fill` inside, `SHEET_GRID_OPTIONS` as the shared
  editing contract (Enter ↓ · Tab → · fill handle · clipboard · 200 undo steps), `GridSheetStatus` below.
- **Sheet cells** — `LongTextCell` (counter against the tightest channel cap), `ReadinessCell` (per channel × market:
  Ready · Missing · Errors · Live · id · Unlisted, issues on hover), `FollowsCell` (Follows master / Pinned).
- **Sheet validation** (`editors/sheet.ts`) — `sheetClassRules` → `.nds-cell-is-invalid` / `-warned` / `-inherited`
  (corner triangle + tint, never colour alone), `selectValidation` (strict lists WARN, never block),
  `lengthValidation`, `longTextEditor`, `sheetPasteProcessor` (header-matched paste). Tests beside it.
- **Measured in the browser:** a 5-digit EAN → saving → refused (red, reason, "1 refused" in the strip); corrected →
  saved, eBay readiness Errors → Live; a variation's Origin pinned from the parent's; Price · IT edit → Pinned;
  a parent title edit repaints every variation; Publish → Amazon · IT on two rows → "1 published · 1 refused" with
  the refused row's reason in its readiness cell. Conformance: `sheet` probed at compact (12/12 green).
- **A trap, recorded in GRID.md §9:** a value setter must mutate `params.data` synchronously — one that only
  scheduled React state handed the fake server the OLD value.

## [GDS-3.2] — 2026-08-29 — Identity chips; the checkbox column is first at every column load

Two things the Owner saw on the lab.

- **Chips, not columns.** The Ad Manager's campaign cell carries its marks as 20px squares — targeting A/M
  (filled), programme SP/SB/SD (outlined), each with a hover explanation — where the lab had spread them into
  a Type column. `IdentityChip` · `TargetingChip` · `ProgramChip` join the cell library (`.nds-cell-chip-*`, on
  `--nds-targeting-*` and the grid tokens, 20×20 · 11/800 filled · 9/800 outlined, `InfoTip` for the tip); the
  reporting scenarios use them and the Type column is gone.
- **The checkbox column is always first.** The engine only enforced it on a runtime pin; a column pinned in
  its DEFINITION (the reporting grid's Campaign) sat ahead of an unpinned selection column from the first
  render. `NexusGrid` now runs the rule on grid ready and on every `newColumnsLoaded` too — measured first in
  every selectable scenario, including the pinned-Campaign one.

## [GDS-3.1] — 2026-08-29 — The toolbar keeps its height when rows are selected

Reported by the Owner on the lab: ticking a row swapped the toolbar's search for the bulk actions and
the toolbar dropped 8px — `/products/next` did not, because its page stylesheet floored the cluster at
36px. Measured both: the page ALSO stepped 64.5 → 65 on every tick (a DS field is 35.5px, the floor 36).

- **`GridSelectionActions` · `SelectionLabel` · `SelectionNote` · `GridSearchSlot`** in `grid/toolbars` — the
  swap's two halves are DS pieces now; the page's `.selActions` / `.lbl` / `.reachNote` / `.searchField`
  rules and their container queries are deleted and `/products/next` and the lab use the same components.
- **One shared slot height** (`--nds-grid-toolbar-slot-h: 36px`): the search field and the cluster both sit
  on it, so the swap is exact by construction — measured **65 → 65 → 65** on both surfaces.

## [GDS-3] — 2026-08-29 — Every scenario rendered and MEASURED; the spec; the chrome guard

Phase 3 of the Grid Design System. Local, uncommitted until the Owner says so.

- **`/design/grid-lab?tab=gds`** — a third lab tab, rendered OUTSIDE the light-pinned console shell so both
  themes can be measured. Sixteen grids from frozen fixtures (`grid-lab/gdsFixtures.ts`, an in-memory SSRM
  datasource that pages, sorts, sinks blanks and caps a family at 10) cover the spec's §6: catalogue (SSRM tree,
  autoHeight + pager, selection swap, export) · family page · row grouping with aggregates · the editor in a
  modal (column-group strip, a matrix, pending → Apply with refusals) · a drawer · a tab panel · read-only
  reporting with totals · per-cell round trip (saving / saved / refused) · frozen-right actions · master/detail ·
  0 rows · 1 row · 10,000 rows · long text · loading skeleton · keyboard-only; and the five stated cases (saved
  views, viewports, screen readers, RTL/mobile out of scope, the ads console's local blindness).
  `window.__gdsProbe()` returns what every grid computed.
- **`design-system/grid/spec.json`** — the numbers: per-density row/header/thumb/pad, geometry, type, and the
  resolved light/dark colours.
- **`scripts/check-grid-chrome.mjs`** (`npm run grid:conformance`, in pre-push when :3000 answers, `--strict`
  otherwise): Playwright opens the tab and holds every scenario to the spec at compact/cozy/spacious × light/dark ×
  1440/1280-wide — **12 probes, ~20 assertions each, green.**
- **Two engine rules the runner found missing** (grid chrome lives in the engine): a pinned totals row is the
  HEADER's height — `NexusGrid` now supplies the `getRowHeight` unless the page brings its own (the inventory
  editor dropped its hand-rolled one); and rows are re-measured when the density changes (`resetRowHeights` + a
  pinned-data re-set — AG caches row heights and does not re-read a changed `getRowHeight` on its own).
- **`design-system/docs/GRID.md`** — the spec a new engineer builds a grid from: folder, decisions, tokens, density
  table, header chrome, cell types and the null rule, row kinds, selection/toolbar/footer, editing, row models and
  state, hosts, themes/a11y/locale/performance, empty/loading/error, guards. Every number in it is one the runner
  confirmed.
- **`/design-system`** catalog: a **Grid** section on `NexusGrid` (cozy, presets, totals, selection) above the
  retiring `DataGrid` one, linking to the lab.

**Migration:** none. Pages that hand `getRowHeight` keep it; pages with pinned rows and no function now get the
header-height totals row for free.

## [GDS-2] — 2026-08-29 — The grid becomes a system: `design-system/grid/`

Phase 2 of the Grid Design System (`docs/2026-08-28-grid-design-system-gds.md` §0c, §6). Local,
uncommitted until the Owner says so. **Both live grids re-measured identical** on every geometry
and colour after each step (expander x=178 · thumb x=209/56px · title x=276 · header 46 · row 85 ·
partition 13.8 · strip 30 · totals 46/700 · identity 344 · footer strip 10/14).

- **One folder, the Owner's five-layer layout.** `patterns/workspace-grid/engine/` → `design-system/grid/`
  (`NexusGrid.tsx`, `theme/`, `modules.ts`, `renderers/`, `editors/`, `columns/`, `toolbars/`, `hosts/`,
  `filters/`, `hooks/`, `sortValues.ts`), one barrel `@/design-system/grid`. The products-page datasource
  and server contract moved OUT to `app/products/next/` (they were page code inside the engine).
  `AgWorkspaceGrid` — the props-compatibility spike — is deleted; the parity lab's AG panel is now
  `NexusGrid` with the fixture projected to `ColDef[]` (`grid-lab/LabNexusGrid.tsx`). `sortValues`
  moved in; the legacy `WorkspaceGrid` imports it from here until wave 3 retires it.
- **One density vocabulary.** `density: compact | cozy | spacious` + `rows: text | media` replace `size`
  (xs/sm/md/lg/xl). Row/header heights come from `tokens/grid.ts`; a modal FOLLOWS its page through
  `GridDensityProvider` (the inventory editor opened from a Cozy page is Cozy — verified). The theme
  carries no row height any more; `sm`/`xl` retired with zero consumers.
- **`Thumbnail` is a DS component** (`components/Thumbnail`, both apps, `nds-thumb-*` in
  `components.css`, additions hashed identical): lifted from the Tailwind grid-lens kit with its CDN
  sizing (Amazon `._SL{px}_`, Cloudinary transforms), fallback, skeleton and hover preview. The DS grid
  imports nothing from `app/_shared/grid-lens` any more.
- **The cell library** (`grid/renderers`, class namespace `.nds-cell-*`): `EmptyValue` (the dash —
  muted; a `title` ONLY on a measured zero), `NumericCell` (integer · money cents · money2 · **eur** ·
  percent · delta), `DateCell`, `BadgeCell` (Pill), `LockedCell`, `LinkCell`, `StockCell`, `DeltaChip`,
  `GroupCell`, `TagsCell`, `CoverageCell`, `ActionsCell`, `IdentityCell` (+ `SkuTag`, `ExpandButton`,
  `ExpandSlot`), and the `GridLoadingOverlay` (density-aware skeleton) / `GridNoRowsOverlay`. All
  memoised. `formatGridValue` is the pure core with a test per kind: **a `null` is never a `0`**.
- **Column presets** (`grid/columns/presets.ts`): `gridSelection()`, `integerColumn`, `moneyColumn`,
  `euroColumn`, `percentColumn`, `deltaColumn`, `dateColumn`, `statusColumn`, `textColumn`,
  `stockColumn`, `lockedColumn`, `holdColumn`, `actionsColumn`.
- **Editors** (`grid/editors`): `numericEditor()` (AG's, configured as the inventory editor had it),
  `textEditor()`, `SelectCellEditor` (a DS `Listbox` in a cell), and the per-cell **round-trip state
  machine** the ads bid/budget cells need — `CellSaveTracker` + `roundTripClassRules` + `saveCell`
  (`saving → saved | refused`; a refusal is a result that stays). Tested.
- **Toolbars and hosts**: `GridPager` (the DS pager, 50/100/200/500), `GridFooterStrip` + spacer,
  `GridDensityToggle`, `GridToolbar` re-exported; `GridCard` (page, a size container) and `GridPanel`
  (modal/drawer). `/products/next` and the editor use them.
- **`useGridState`** (Q4): last-used state auto-persisted to `nds-grid:<surface>:v1` on AG's
  `stateUpdated` + the page's `markDirty()`, restored on mount unless a server default view exists;
  named views unchanged. Verified: switch to Cozy → reload → Cozy. No legacy-key adapters (§0b).
- `MasterDetailModule` registered (9 sites in wave 1 need it).
- **Guards, wired into pre-push:** `check-grid-option-identity.mjs` (TS AST: no inline object/arrow on
  a `<NexusGrid>` option or handler — it caught the inventory editor's five and the feature lab's six
  on its first run), `check-grid-kit-ratchet.mjs` (the rebuild backlog may only shrink: DataGrid 71 ·
  grid-lens 60 · AdsDataGrid 56 · WorkspaceGrid 4 · TanStack 17 · raw `<table>` 194),
  `check-ds-gaps-append-only.mjs`, and a stylesheet pass in the AG boundary guard (no `.ag-*`,
  `.nds-ag-*`, `.nds-cell-*` or GDS host selectors outside `design-system/grid/`).
- `/products/next` page stylesheet: 31 cell classes deleted (the DS owns them); `density.ts` is
  three lines of vocabulary.

**Found and fixed on the way:** the cell library first used `.nds-grid-*` — the RETIRING DS
`DataGrid`'s own namespace (`.nds-grid-empty` is its 40px-padded empty state) — so `EmptyValue`
would have inherited that padding; the library is `.nds-cell-*` and the guard scopes `.nds-grid-*`
to the hosts. Also: BSD `sed -E` silently ignores `\b`, renaming nothing — a Python pass did it.

**Migration:** `size` → `density` + `rows` on `NexusGrid` (three call sites, all updated).
`@/design-system/patterns/workspace-grid/engine/*` → `@/design-system/grid`.

## [GDS-1] — 2026-08-28 — Grid tokens: the AG grid's colours and numbers become one table

Phase 1 of the Grid Design System (`docs/2026-08-28-grid-design-system-gds.md`). Local, uncommitted
until the Owner says so. **Zero visual change on the two live grids, by measurement** (below), plus
one intended fix.

- **`tokens/grid.ts`** (new, byte-identical in web and factory): 69 `--nds-grid-*` custom
  properties — surfaces, rules, type, the three density tiers (compact 28/52 · cozy 43/68 ·
  spacious 49/85 text/media rows; headers 28/38/46; thumbs 32/40/56), geometry (strip 30, footer
  row 48, selection column 43, identity 320, partition 2px × 30 %), controls, editing states
  (pending / refused / saving / delta / locked), overlays. Emitted through `css-vars.ts` into
  `tokens.css` and `tokens-global.css` (311 vars + 91 dark). The TypeScript numbers a page hands AG
  (`gridDensity`, `gridGeometry`) and the CSS the theme binds are the same objects.
- **Every colour is a semantic role** (`--nds-surface-*`, `--nds-border-*`, `--nds-text-*`,
  `--nds-primary`, status hues) — never a ramp step. `engine/theme.ts` now binds only grid tokens;
  `theme.vitest.test.ts` reads the EMITTED css and fails on any `--nds-grey-*` / `--nds-white` / hex.
  Before this the theme bound `--nds-white` / `--nds-grey-25/150/200` directly and claimed to be
  dark-aware; measured, none of those flip. **Dark mode now flips the grid** — verified in
  `/design/grid-lab` with the shell pin lifted: ground `#18263b`, text `#e7ebf1`, rules `#26323f`.
- 🔴 **Two guards caught two real errors in this change before it shipped.** `check-dark-alias-scope`:
  a `var(X)` alias resolves where it is DECLARED, so the 37 colour aliases had to be re-declared in
  `.dark` (`gridVarsDark`) — "derives from a semantic token" is not enough on its own.
  `check-shell-pin-fresh`: the same 37 must be pinned inside `.h10-shell` (`shared-shell.css`,
  generated from the `.dark` block) or a light console would inherit dark literals.
- `engine/ag-grid.css` speaks grid tokens only; the four `nds-ag-nexus` colour overrides are gone
  (the theme binds the same roles). `NexusGrid` reads its tiers from `gridDensity` and stamps
  `--nds-grid-header-h` on its wrapper. `/products/next` (`density.ts`, `InventoryGrid`,
  `ProductsNextClient`, `styles.module.css`) reads every grid number and editing colour from the
  table; no bare `48`, `43`, `320`, `30` or `#fff` remains.
- **Intended fix:** the header partition is now `calc(var(--nds-grid-header-h) * 0.3)` — 30 % of
  the HEADER ROW. Quartz's `30%` was 30 % of the CELL, so the inventory editor's two cells that span
  the column-group strip drew 22.8px marks beside 13.8px ones. Now 13.8 everywhere (measured).
- **Factory:** its `tokens.css` was AHEAD of its own `css-vars.ts` (hand-edited; the generator
  reported it stale). Converged: `--nds-warning-border` and the dark tone/link roles ported into
  `css-vars.ts`, `--nds-fchip-on-bg` and `--nds-pill-neutral-fg` (`#6b7480` → `var(--nds-text-2)`)
  aligned with web, then regenerated — so factory's tokens are generator-owned again.

**Measured before/after** (`/products/next` Spacious, 1728×962, and the inventory editor):
header 46 · row 85 · partition 2 × 13.8 · header `#3a4452` · cell `#1c2530` 13px/500 · row rule
`#e6e9ee` · header rule `#d8dde4` · hover `#f7f9fb` · selected `#eef5ff` · checkbox 16 · selection
column 43 · thumb 56 · strip 30 `#eef1f5` 11px/700 · totals row 46/700 · identity 344 · locked
`#626c7b` — identical on every value except the spanning-cell partition above.

**Migration:** none. `size` on `NexusGrid` is unchanged (the `density` API is Phase 2). New names only.

## [9.3-css] — 2026-08-24 — The design system is loaded once, for the whole app

Until now the DS stylesheets arrived only where an individual file imported them:
`primitives.css` reached 46 files and **`a11y.css` reached one**. A DS component rendered
unstyled on any route where nothing happened to pull its sheet in — `.nds-btn` did not
resolve on `/design` at all. That is styling by coincidence of import graph, and it blocked
every remaining 9.3 tranche (`Button` alone is 205 files needing `primitives.css`).

- **`app/layout.tsx` now imports** `tokens-global.css` → `primitives.css` → `components.css`
  → `patterns.css` → `a11y.css`. **Order is the cascade** in this system — `a11y.css` last so
  its focus and reduced-motion rules win. Do not reorder.
- **`tokens.css` is now generated in two variants** from the one source (`tokens/css-vars.ts`):
  the full file, unchanged, for the 202 pages that opt in; and `tokens-global.css`, which is
  the same **minus the 11 contested platform aliases**, for the root layout.
- **Why withhold them:** publishing `--text-primary` app-wide as a colour would make Tailwind's
  `rgb(var(--text-primary) / <alpha-value>)` resolve to `rgb(#1c2530)` — invalid — and kill the
  utilities behind 636 files. **Phase 9.0b is what made this possible**, by removing the DS's
  own dependence on those names.
- `token-guard`'s `HEX_ALLOW` now covers both generated token files; `tokens:check` validates
  both.

**Verified** on `/sync-logs` and `/dashboard`, routes that import nothing themselves:
`.nds-btn` resolves (`padding: 7px 13px`, `radius: 8px`), and the DS `focus-visible` +
reduced-motion rules are present for the first time.

### 🔴 Found while verifying (pre-existing, not caused here)

The app's semantic Tailwind utilities are **dead wherever DS `tokens.css` is loaded**. Measured
on real elements on `/dashboard/overview`: `.text-secondary` computes `rgb(0,0,0)` instead of
slate-600, `.border-default` computes black, `.bg-card` is transparent. Same mechanism as 9.0b
in mirror image — the app reading the DS's colour tokens rather than the DS reading the app's
channel tokens. `tailwind.config.ts` records that these utilities replaced 6,485 raw
`text-slate-400` and 6,547 invisible borders; that migration is inert on those routes.
Confirmed pre-existing by re-measuring with the new layout imports removed. Full account and
proposed fix in `docs/PHASE-9-3-DUPLICATE-CONCEPTS.md` §3b.

## [9.3-t2] — 2026-08-24 — Card, EmptyState, Spinner, ProgressBar collapse onto the DS

Four more of the twelve duplicate concepts retired. `components/ui/{Card,EmptyState,Spinner,
ProgressBar}` are now adapters over the DS components, legacy APIs kept verbatim so no call
site changed.

### Lifted into the DS (capabilities, not shims)

- **`Card.description`** — a sub-line under the header title. 105 call sites wanted one, and
  the duplicate `components/ui/Card` was the only way to get it. Renders as a stacked
  title/description block; the 23 existing headed cards keep byte-identical markup because the
  stack only applies when `description` is passed.
- **`Card.padded` now reaches the BODY of a headed card.** It previously applied only to
  headerless cards, so a headed card always got 16px — which is why 17 charts and tables kept
  the legacy component. `padded={false}` → `.nds-card-body.flush`. No existing DS caller
  passes both props, so nothing shifts.

### Kept OUT of the DS (deliberately)

`Spinner.tone` / `Spinner.label` and `ProgressBar.label` / `showCount` / `showPercent` stay in
the adapters. Each has a single caller — `app/design/page.tsx`, the legacy showcase 9.7
deletes — and the DS's own answer to "spinner with a word beside it" is composition, not a
prop. Every production call site was already using the DS `Spinner`/`ProgressBar` directly.

### 🔴 Adapters now carry their own stylesheet imports

The DS stylesheets are **not** loaded app-wide: `primitives.css` is imported by 46 files,
`a11y.css` by **one**. Measured on `/design`, `.nds-card` resolves but `.nds-btn` does
not. This bit the `EmptyState` adapter directly — it renders a DS `Button`, which came out as
unstyled black text on 55 of its 56 pages until caught in review. Each adapter now imports the
stylesheets its component needs, as `AccountSwitcher` already did. Next dedupes them.

The real fix is loading the DS stylesheets once, app-wide, which **9.0b is what makes possible**
— `tokens.css` can now be split into the `--nds-*` tiers (safe globally) and the platform-alias
tier (opt-in, and a `:root` race with `globals.css` if loaded). It should land before the
`Button` tranche, which is 205 files needing `primitives.css`. See
`docs/PHASE-9-3-DUPLICATE-CONCEPTS.md` §3b.

**Migration:** none. No component API changed; `Card` and `EmptyState` render the DS look on
201 files that previously rendered bespoke Tailwind.

## [9.0b] — 2026-08-24 — 285 component declarations were being discarded by the browser

The DS published `--text-*` / `--surface-*` / `--border-*` as **colours**; `globals.css` and
`ads.css` define the same names as **RGB channels** (Tailwind composes them as
`rgb(var(--x) / <alpha-value>)`). Custom properties resolve from the nearest defining
**ancestor**, not by source order, so inside `.h10-shell` those shadowed the DS's and
`background: var(--surface-card)` became `background: 255 255 255` — invalid at
computed-value time, silently dropped. **285 declarations across nearly every component were
dead on every ads page**: 138 `color`, 79 `border`, 63 `background`, 3 `box-shadow`.

- **DS stylesheets now consume the DS-owned `--nds-*` tier only** — 394 substitutions
  (`primitives` 100, `components` 226, `patterns` 68). Value-preserving at `:root`; a fix
  inside the shell, where 6 of 6 sampled tokens went from `rgba(0,0,0,0)` to a real colour.
- **`token-guard` check D** bans the whole platform-alias tier inside DS stylesheets.
  Reports every alias on a line, not just the first.
- **New token `--nds-info-strong`.** The info tone had `soft` and `line` but no `strong`, so
  `--status-info-strong` reached past the semantic tier to `--nds-blue-700` — a numbered ramp,
  which check B bans. The alias now points at the new token so the two cannot drift.
- **The alias tier is KEPT, not deleted** (the plan said delete). Only 11 of 25 names are
  contested; the other 14 are DS-only and app CSS depends on them — `reporting.css` alone has
  47 uses. Deleting would have broken ~70 app declarations to fix what check D already
  prevents. `css-vars.ts` records the reason and the rule for adding to it.
- **`/products/next` fixed:** it pinned nine aliases to real colours but used
  `--text-disabled` and `--text-link` without pinning them, so both were dropped — the
  "Manage inventory" link did not render as a link and the sort chevron was not muted.
- **`GOVERNANCE.md` corrected.** Its tier model instructed components to consume the very
  tier that was silently failing. Now four tiers, tier 4 marked app-only.

**Migration:** none for callers — no component API changed. Expect ads surfaces to gain
borders, backgrounds and a real three-ink text hierarchy where declarations previously
vanished. Full account: `docs/PHASE-9-0B-TOKEN-FORM.md`.

## [CONFORMANCE] — 2026-08-24 — The DS's own two guards go green, and get enforced

`tools/token-guard.mjs` and `tools/api-guard.mjs` both shipped with the system and
both sat **unwired** — so every push measured the app's conformance to the DS while
nothing measured the DS's conformance to itself. Wired into `.githooks/pre-push` in
this entry; they were red when wired (55 token violations, 4 barrel gaps) and are
cleared here, because a gate is only honest once the tree passes it.

### Token-value changes (these restyle the app)

- **`.dark` gained the tone + link roles**: `--nds-success-strong`, `--nds-warning-strong`,
  `--nds-danger-strong`, `--nds-text-link`. The light values measured **2.94:1–3.18:1**
  on the dark canvas — below AA everywhere they were used, not just where someone had
  noticed. `components.css` had been patching this per-component with hex overrides on
  `.nds-acct*`; those are deleted, so any component now inherits the AA value instead
  of the sub-AA one. **Migration:** none — strictly a contrast improvement, dark only.
- **Tooltip inks are tokens and theme-invariant**: `--nds-tooltip-light-{bg,fg,fg-2,border}`
  and `--nds-tip-{bg,fg}`. The values they replace were foreign Tailwind slate hexes
  (`#1e293b` / `#e2e8f0` / `#28313d`) hardcoded in `primitives.css`; snapped onto the
  nearest H10 ramp step, max delta 4/255 per channel. They point at raw ramps, which
  `.dark` never redefines, so a tip keeps its own contrast rather than inverting.
- **`.nds-burn-tip` painted transparent, not white.** It read
  `var(--surface-raised, #fff)` — but `--surface-raised` IS defined app-wide, by
  globals.css and ads.css, as **RGB channels** (`255 255 255`). The substitution produced
  `background: 255 255 255`, invalid at computed-value time, and a `var()` fallback covers
  an *undefined* variable, never an invalid one. Now reads `var(--nds-surface-raised)` —
  DS-owned, a real colour in both themes. **Deliberately NOT fixed by aliasing
  `--surface-raised` in tokens.css**: that would have broken the reverse case,
  `rgb(var(--surface-raised))` in `reporting.css`, on the pages that load both.

### The DS no longer depends on the consuming app's Tailwind build

`ToolbarButton`, `ToolbarDivider` and `ColumnGroupModal` were styled with Tailwind
utilities. `apps/web/tailwind.config.ts` scans `./src/pages`, `./src/components` and
`./src/app` — **never `./src/design-system`** — so those utilities only reached a build
when some other file happened to use the same class. The ToolbarButton badge's arbitrary
values (`-right-0.5`, `min-w-[14px]`, `text-[9px]`) were emitted **zero times**: it was
mis-rendered wherever it shipped, and `ToolbarDivider` was an invisible dimensionless div.

Rewritten onto `.nds-tbtn*` / `.nds-tdivider` / `.nds-cgm-*` + tokens. Every
state (hover / pressed / disabled) is now CSS keyed off `:hover`, `[aria-pressed]` and
`:disabled`, so the visual cannot drift from the a11y tree. ColumnGroupModal's eleven
Tailwind dot hues collapse onto the DS palette via `[data-color]`; an unknown key falls
through to the neutral dot. **No content-glob was added** — the DS depends on nothing
outside itself, which is the point.

### Other

- `--nds-blue-600` × 6 in `components.css` → `var(--color-primary)` (value-identical).
- `ACCOUNT_COLORS` moved to `tokens/colors.ts` as `accountIdentity`; chart inks to
  `chart`. Both keep their exact hexes — `ChannelConnection.accountColor` **persists**
  these strings, so snapping one onto a ramp step would orphan stored accounts.
- Barrels: `LegacyTagTone` (primitives), `ShellSubItem` / `ShellNavGroup` / `ShellNavEntry`
  (patterns) are now re-exported — a consumer can name what `AppShellProps` hands it.
- `token-guard` itself is now **block-comment aware**. Its old per-line heuristic only saw
  the first line of a `/* … */` block, so prose *explaining* why an idiom is banned
  (Button.tsx's note on hand-rolled `!bg-red-600` overrides) counted as a violation — the
  guard was pressuring authors to delete the explanation. Negative-tested: real hex, ramp
  and Tailwind-palette violations in code still fail it.

## [DRAWER-WIDTH] — 2026-07-10 — Drawer width + subtitle props (EFX P6)

- **`Drawer` gained `width`** (number = px, or any CSS length; default stays the
  stylesheet's 420px, `max-width: 100%` still applies) **and `subtitle`** (small
  line under the title — new `.nds-drawer-ht` / `.st` in components.css,
  token-clean). Both optional; existing callers unchanged. First consumer: the
  eBay flat-file images drawer (840px).

## [ZERO-NATIVE] — 2026-07-04 — Listbox + DateField (Wave 1 conformance gap-fill)

- **`Listbox`** (`components/Listbox.tsx`) — plain single-select styled dropdown
  (button trigger in the Select box skin + the Combobox popover, no typeahead).
  The zero-native-control replacement for the `Select` primitive, which styles a
  native `<select>` and still opens the OS option list. New pages must use
  Listbox; the DS-conformance ratchet (scripts/ds-conformance-guard.mjs) bans
  new native selects in app code.
- **`DateField`** (`components/DateField.tsx`) — single-date calendar popover
  replacing native `<input type="date">` (same ban). Reuses the DateRangePicker
  month-grid vocabulary; min/max + clearable.
- No changes to existing components or tokens.

## [PREFERENCES] — 2026-06-28 — PreferencesModal pattern (two-panel "Customise") + DataGrid sticky-right

- **`PreferencesModal`** (`patterns/PreferencesModal.tsx`) — the two-panel grid
  Customise dialog ported to the DS from the live /products workspace. Left:
  optional rows-per-page · sticky first/last column · optional sort · a
  `workspaceSlot`; right: every column with a drag handle + DS `Toggle` (locked
  columns disabled). Draft-then-Save (atomic), Reset to defaults. Pure DS — built
  on `Modal` + `Button` + `Toggle`, no app i18n/utils. Optional sections collapse
  on empty option lists. Token-clean `.nds-prefs*`. Title defaults to "Customise".
- **`DataGrid` gained `stickyRight`** on `Column` — pins a column to the right
  edge (offsets stack, like sticky-left), with a left edge-shadow. Lets the
  Customise "Pin last column" toggle actually pin the trailing actions column.
  Additive; existing grids unaffected.
- Recorded in the patterns barrel + catalog (Builder & ColumnCustomizer →
  PreferencesModal). First consumer: `/products/next` Customise button.

## [GRIDTOOLBAR] — 2026-06-28 — GridToolbar pattern + grid-card wrapper (Ad-Manager toolbar)

- **`GridToolbar`** (`patterns/GridToolbar.tsx`) — the Ad-Manager `.h10-am-toolbar`
  row as a reusable DS pattern: `count` (left) + left-action `children` + flexible
  spacer + `right` actions. Token-clean `.nds-toolbar` (count `.cnt`, bold
  numbers, `.grow` spacer).
- **`.nds-gridcard`** wrapper — seats the toolbar inside the grid card above a
  `DataGrid` (toolbar gets a bottom divider; the inner `.nds-grid-wrap` drops
  its own border + radius), matching the campaigns page's one-card layout.
- Recorded in the patterns barrel + catalog (Filters & action bars → GridToolbar).
  First consumer: `/products/next` (count · Customise · Export · density · Live).

## [FILTERBAR] — 2026-06-28 — Config-driven FilterBar pattern (one bar for every grid)

The declarative filter bar the grid workspaces were missing — so feature pages
(products, listings, fulfillment, pricing…) own *configuration*, never filter-bar UI.

- **`FilterBar`** (`patterns/FilterBar.tsx`) — pass a `dimensions: FilterDimension[]`
  array; the bar renders the collapsible Ad-Manager panel (built on `FilterPanel`)
  with the right control per dimension: `multiselect` → `MultiSelect`, `select` →
  `Combobox`, `range` → a min/max field (optional €/% addon), `toggle` → `Toggle`.
  Options accept an optional facet `count`. Reproduces the campaigns-page
  `.h10-am-fpanel` through DS tokens. First consumer: `/products/next`.
- **`FilterPanel` gained `resetLabel` + `resetDisabled`** (additive) — lets the
  footer read **"Clear"** and disable when no filters are active, matching the
  Ad Manager. Existing consumers default to "Reset", unchanged.
- **New CSS** — `.nds-range*` (min/max field; input border uses
  `--border-strong` = the campaigns input border exactly) + `.nds-ms-count`
  (muted facet count after an option label). All semantic-token-clean; `token-guard`
  + `api-guard` green. Rendered in the catalog under Filters → FilterBar.
- **Known follow-up:** a token-reconciliation pass to lock the remaining DS↔campaigns
  drift (panel border `#d8dde4`→`#d6dbe2`, multiselect border, grid greys) is tracked
  separately — values, not structure.

## [DS-HARDEN] — 2026-06-27 — Consistency & hardening: semantic tokens + generated CSS + one API

The DS made internally consistent and self-truthful — no new colour values, a
consistency pass. Full map in `docs/AUDIT.md`; design at
`docs/superpowers/specs/2026-06-27-design-system-consistency-hardening-design.md`.

- **Platform-semantic alias layer is now LIVE.** Added the platform's semantic
  names — `--text-*`, `--surface-*`, `--border-*`,
  `--status-{success,warning,danger,info}-{soft,line,strong}`, `--color-primary`
  (+`-soft`) — as **value-preserving aliases** over the existing `--nds-*` roles,
  and repointed **every** component CSS rule onto them (the ~13 raw-ramp reaches
  in Tag/Toggle/Tooltip/Skeleton/DataGrid/AppShell are gone). `--nds-*` is now
  strictly the raw ramp + DS-only component-token tier underneath. No pixels move
  — the alias values are identical, so the catalog screenshot-diff is a no-op.
  `/marketing/ads` keeps reading `--nds-*` directly and is unaffected.
- **`tokens.css` is GENERATED from TypeScript.** `tokens/css-vars.ts` (hex
  sourced once from `tokens/colors.ts`) is the single source; new
  `tools/generate-tokens-css.ts` emits the `:root{}` + `.dark{}` blocks.
  `npm run tokens:gen` writes the stylesheet; **`npm run tokens:check`** is the CI
  guard that fails on staleness. Closes the old "TS generates CSS" claim that was
  previously hand-mirrored — drift is now structurally impossible.
- **API harmonized onto one `Tone` vocabulary.** `type Tone = 'neutral' | 'info'
  | 'success' | 'warning' | 'danger'` (+ `TONES`), applied via a `tone` prop to
  **Pill** (`status` `ok/warn/arch/err` → `tone` `success/warning/neutral/danger`),
  **Tag** (`positive` → `success`), **Toast** + **Banner** (`error` → `danger`;
  `variant` kept as a deprecated alias on Banner for the untouchable
  `EbayImportWizard`). **Button** keeps `variant` (`primary/secondary/ghost`) —
  the emphasis axis, deliberately distinct from tone.
- **Badge corrected to its real meaning.** `BadgeTone = sp|sd|sb|auto|manual`
  was never a tone — it's the **ad-program** axis. Renamed to `program: AdProgram`.
- **Types + sizing exported and standardized.** Every component now re-exports its
  public Props via the barrel (incl. previously-leaking `KbdProps`, `PillProps`,
  `TagProps`, and Toast's `ToastApi`). New shared `Size = sm|md|lg|xl`
  (`primitives/size.ts`); Spinner's numeric `size` is the documented exception.
- **Outliers conformed.** `TagInput` rebuilt onto `.nds-taginput*` + semantic
  tokens (dropping the raw Tailwind palette + hand-rolled `dark:` + `@/lib/utils`),
  props unchanged so its two untouchable consumers need no edits. `ImageUpload`
  CSS repointed onto the semantic aliases.
- **Guardrails extended.** `tools/token-guard.mjs` (raw-hex ban across
  primitives/components/patterns/styles) stays green; the generator's
  `tokens:check` guards TS↔CSS sync. The consistency contract (no raw ramp in
  component CSS, no raw Tailwind palette in `.tsx`, barrel-export completeness) is
  documented in `docs/AUDIT.md` + `docs/GOVERNANCE.md` and enforced by review,
  with a `tools/api-guard.mjs` lint planned.

## [P5.1] — 2026-06-23 — Tag primitive (neutral / semantic chip)

- **`Tag`** (`primitives/Tag.tsx` + `.nds-tag` in `styles/primitives.css`) — the
  generic inline label chip the console was missing. `Pill` encodes entity *status*
  (Active/Paused/Archived/Error) and `Badge` encodes the ad *program* (SP/SD/SB/Auto/
  Manual); `Tag` covers everything else you label inline. Five tones — `neutral` ·
  `info` · `positive` · `warning` · `danger` — all from existing tokens. First
  consumer: the rebuilt Suggestions page (entity type, marketplace, proposed-action
  sentiment); reused by the upcoming triage filters/metrics. Additive — no other changes.

## [P4.1] — 2026-06-23 — ImageUpload component

- **`ImageUpload`** (`components/ImageUpload.tsx` + `.nds-imgup-*` in
  `styles/components.css`) — a reusable image dropzone: drag-drop + click, live
  preview with remove, a criteria panel, and client-side format / size / minimum-
  dimension validation. Platform-agnostic — the caller passes `onUpload(file) =>
  Promise<url>` (wire to any asset/DAM endpoint) plus optional `onSelectFromAssets`
  for a DAM browse. First consumer: the Guided builder's Sponsored Brand creative
  (logo + custom image, wired to `/api/assets/upload`); reusable for product
  images, A+ modules, etc. Additive — no token/primitive changes.

## [ADS-CB] — 2026-06-23 — Campaign-builder shared blocks (Guided)

- New shared ads-builder components in `marketing/ads/_shared/`, recorded in the
  ads inventory (study 00 §7):
  - **`CampaignTypeSelect`** (+ co-located `.css`) — the SP / SB / SD multi-select
    cards (ad-format mocks + Amazon copy; `disabled` keys render a "Soon" pill).
    The canonical building block for any builder spanning ad formats.
  - **`HarvestRules`** — the Keyword Harvesting / Negative Targeting matrix +
    collapsible Performance Criteria, on the shared rule model (`RulesConfig` /
    `RuleRowSel`). (SP Super Wizard's `LaunchStep` keeps an inline twin for now —
    flagged as a dedupe candidate; model + engine are already shared.)
- These power the new **Guided** builder (multi-format SP+SB+SD), which otherwise
  reuses existing shared blocks (`BidStrategy`, `KeywordTargetingPanel`,
  `ProductSelection`, the `RuleControlPanel` canvas, `PerformanceCriteria`). No DS
  primitive/token changes; additive only.

## [P5.1a] — 2026-06-22 — AppShell: collapsible nav groups

- `AppShell` gains collapsible nav **groups** (`ShellNavGroup` — icon + label +
  sub-items + chevron; auto-opens if a child is active or `defaultOpen`),
  matching the H10 `AdsSidebar`'s AMC / Reporting expandable sections. Flat items
  and groups coexist; sub-items hide when the rail is collapsed; the active
  sub-item gets the primary treatment.
- Catalog demos a "Reporting" group (Overview / Brand metrics [active] / AMC
  audiences). Self-verified @2x (rail expanded). The sidebar now fully matches
  the ads rail. (Follow-up enhancement to the Phase 5 AppShell.)

## [P8] — 2026-06-22 — Studies hub (Phase 8 complete)

- The research hub is established: framework (`studies/README` + `_TEMPLATE`) +
  the foundational studies (`00-ads-inventory`, `01-color-drift`,
  `02-contrast-audit`) + the **exemplar feature dossier `03-ads-campaigns`** —
  which maps the ads cockpit onto the DS (that mapping *is* the Phase-9 migration
  checklist for `/marketing/ads`) and sketches cross-platform parity + the
  automation roadmap. Copy `_TEMPLATE.md` for each next feature.
- Additive docs; committed locally. Next: **Phase 9 — migration** (the gated
  `ads.css`→token rewrite + `.h10-*`→neutral rename + rollout) — needs the
  unblocked tree + healthy dev server + the screenshot harness.

## [P7] — 2026-06-22 — Governance hardening + guardrails (Phase 7 complete)

- `tools/token-guard.mjs` — drift guard: fails on raw hex in shipped DS code
  (primitives/components/patterns/styles; `tokens.css` excepted). **Passes today**
  — the whole system is tokenized. `tools/README.md` documents it + the
  visual-regression process (`catalog/verify.mjs` + baseline diff).
- `docs/GOVERNANCE.md` gains a **Guardrails** section (token-guard, visual
  regression, the contrast rule). CODEOWNERS deferred for a solo operator.
- Additive (scripts + docs); committed locally — push still queued behind the
  concurrent `SpSuperWizard.tsx` error. Next: Phase 8 (studies hub), 9 (migration).

## [P6] — 2026-06-22 — A11y · i18n · content & data standards (Phase 6 complete)

- **A11y:** `styles/a11y.css` (prefers-reduced-motion neutralizes DS animations +
  transitions; focus-visible baseline). Esc-to-close added to `MultiSelect` +
  `Combobox`. `docs/ACCESSIBILITY.md` documents focus / keyboard / ARIA / motion /
  contrast (ARIA roles + states were already applied across components).
- **Contrast:** `studies/02-contrast-audit.md` — WCAG AA ratios for the key token
  pairs; `--nds-text-3` (~3.2:1) flagged secondary/large-only (body uses
  `--nds-text-2`, 5.9:1); primary passes AA (~4.8:1). H10 values kept; usage rule
  documented for the Phase 7 lint.
- **Content/data:** canonical formatters in `lib/format.ts` (cents-based money,
  fraction `pct`, fixed `en-IE`/`en-GB` locales → no hydration drift),
  consolidating the duplicated ads `format.ts`. `docs/CONTENT.md` (English-UI /
  Italian-content stance, iconography, voice).
- `tsc` clean. Next: Phase 7 (governance lint + visual-regression CI).

## [P5.3] — 2026-06-22 — Builder framework + ColumnCustomizer (Phase 5 complete)

- `Builder` (full-screen wizard: top bar close + title + primary action, scroll-spy
  left nav, scrolling sections; portal + Esc) — the spine for rule/goal/campaign
  builders. `ColumnCustomizer` (column visibility + up/down reorder inside a
  Modal; locked columns; draft-then-Apply).
- **Phase 5 COMPLETE — 8 patterns:** AppShell, PageHeader, DetailHeader,
  FilterPanel, BulkActionBar, EditModeBar, Builder, ColumnCustomizer. All
  self-verified @2x. The live-WIP ads builders (`_rank`, budget) fold in during
  the migration once committed. Next: Phase 6 (a11y / i18n).

## [P5.2] — 2026-06-22 — Patterns wave 2: FilterPanel · BulkActionBar · EditModeBar

- `FilterPanel` (`.h10-am-fpanel`: collapsible, presets row, responsive 6→3→2
  col field grid via `FilterField`, reset/apply footer; DS controls fill their
  cells; orphan-margin balanced when collapsed). `BulkActionBar` (sticky
  "N selected" + actions + Clear; renders nothing at 0). `EditModeBar` (sticky
  discard/apply for unsaved edits). Shared `.nds-actionbar`.
- Catalog Filters section dog-foods them (FilterPanel with MultiSelect / Combobox
  / Select / €-% inputs). `tsc` clean; self-verified @2x (fields fill cells; sticky bars).

## [P5.1] — 2026-06-22 — Patterns wave 1: AppShell · PageHeader · DetailHeader

- First organisms in `patterns/` (+ `styles/patterns.css`): `AppShell` (H10 rail
  — 66px icon rail hover-expands to 248px; brand, nav items with active state +
  count badge, footer; fills its parent so the app layout supplies the height),
  `PageHeader` (eyebrow + title + subtitle + actions), `DetailHeader` (back link
  + badge + title + actions). The shell composes the headers + primitives.
- Catalog Patterns section: headers inline + AppShell in a contained 360px
  preview. Self-verified @2x. `tsc` clean.
- Remaining Phase 5: FilterPanel, BulkActionBar, EditModeBar, ColumnCustomizer,
  the Builder framework (full-screen wizard + scroll-spy).

## [P4.6] — 2026-06-22 — DataGrid + Phase 4 complete

- `DataGrid<T>` (`.h10-am-grid`): generic columns (render / align / sortable /
  sortValue / sticky / width / total), click-to-sort headers with arrows, row
  selection + select-all (indeterminate), sticky header, pinned left columns
  (accumulated offsets), a sticky totals row, and an empty state. Catalog
  dog-foods it (Badge/Pill cells, sortable metrics, totals, selection).
- **Phase 4 COMPLETE — 17 composites + `useClickAway`.** `tsc` clean;
  self-verified @2x. Next: Phase 5 (patterns — AppShell / PageHeader / Builder).

## [P4.5] — 2026-06-22 — Components wave 5: charts (PerformanceGraph · Heatmap)

- `PerformanceGraph` (Recharts `ComposedChart` — dual independent left/right
  axes, two line series, tokenized grid/axes via the TS token values, custom
  tooltip + legend). `Heatmap` (7×24 intensity grid, cell opacity scales with
  value/max; column labels).
- Catalog Charts section uses **deterministic** sample data (Math.sin, no random)
  so SSR matches the client; harness captures `[data-cat="charts"]`.
- Self-verified @2x: dual-axis lines + scaling, heatmap evening-peak gradient.
  `tsc` clean. Only the `DataGrid` remains in Phase 4.

## [P4.4] — 2026-06-22 — Components wave 4 (DateRangePicker · MetricStrip · HoverCard)

- `DateRangePicker` (`.h10-dp` — dual-month calendar + preset rail; two-click
  range select, future-disabled, today ring, en-GB format). `MetricStrip` (KPI
  tiles, auto-fit grid, up/down delta). `HoverCard` (rich hover panel on a light
  surface). All reuse `useClickAway` / token styles.
- Catalog dog-foods them; harness opens the date popover + hovers the card.
- `tsc` clean; self-verified @2x — calendar range highlight + today ring,
  MetricStrip deltas, HoverCard. Date popover opens left-aligned so a mid-content
  trigger doesn't clip (a top-right header can add right-align later).

## [P4.3] — 2026-06-22 — Components wave 3 (Toast · MultiSelect · Combobox)

- `Toast` system: `ToastProvider` + `useToast()` + a portaled bottom-center
  viewport (info/success/error, auto-dismiss). `MultiSelect` (`.h10-ms` checkbox
  dropdown — All / N-selected + Select-all with indeterminate). `Combobox`
  (`.h10-combo` typeahead — filter + pick). Shared `useClickAway` hook (promoted
  out of FilterDropdown).
- Catalog dog-foods them (MultiSelect + Combobox + a self-contained Toast demo);
  harness opens + captures each popover and the toast.
- `tsc` clean; self-verified @2x (MultiSelect indeterminate / Combobox / Toast).
  Fixed a `Toast` SSR hydration mismatch — the always-present viewport is now
  mounted-guarded so the first client render matches the server.

## [P4.2] — 2026-06-22 — Components wave 2: overlays (Modal · Drawer · Menu)

- Portal-based overlays tokenized to H10: `Modal` (`.h10-modal` — title/subtitle/X,
  bordered scroll body, right-aligned footer; sizes sm/md/lg; Esc + backdrop
  close), `Drawer` (right slide-over; Esc + backdrop close), `Menu` (`.h10-menu`
  anchored dropdown; outside-click close; disabled items).
- Catalog dog-foods them (interactive open buttons + a Menu); the harness opens
  each and screenshots the portaled element.
- Self-verified @2x: Modal, Drawer, Menu all match the H10 look. `tsc` clean.

## [P4.1] — 2026-06-22 — Components wave 1 (Card · EmptyState · Tabs · Pagination · ProgressBar)

- First composite components in `components/` + `styles/components.css`
  (`.nds-*`): `Card` (panel + optional header/action slot), `EmptyState`
  (icon + title + description + CTA), `Tabs` (underline indicator, controlled),
  `Pagination` (windowed page list with ellipses + prev/next), `ProgressBar`
  (determinate + indeterminate).
- Catalog gains a Components section that dog-foods them (interactive Tabs +
  Pagination); harness captures `[data-cat="components"]`.
- `tsc` clean. Self-verified @2x (Card / EmptyState / Tabs / Pagination / Progress).

## [P3.3] — 2026-06-22 — Primitives wave 3 + Phase 3 complete

- Final primitives, tokenized to the H10 spec: `Radio` (accent native),
  `RadioCard` (`.h10-radio-card`; selected = primary border + wash), `Tooltip`
  (CSS hover, `.h10-tip` dark bubble + arrow), `Spinner` (`h10spin` ring),
  `Skeleton` (`.skb` shimmer), `Kbd`, `Divider`. Appended to `primitives.css`;
  `primitives/icons/README` documents the Lucide convention.
- **Phase 3 complete: 14 primitives** — Button · Pill · Badge · Input · Select ·
  Checkbox · Toggle · Radio · RadioCard · Tooltip · Spinner · Skeleton · Kbd ·
  Divider. All self-verified @2x vs the H10 look in the catalog.
- Deferred to Phase 4 (composite): searchable/portal MultiSelect + Combobox, the
  adaptive InfoTip; custom builder-icons lift to the migration.

## [P3.2] — 2026-06-22 — Primitives wave 2 (Input · Select · Checkbox · Toggle)

- Form controls tokenized to the H10 spec: `Input` (plain / leading-icon /
  `€`-prefix / `%`-suffix via the `.h10-am-search` + `.mmin` field pattern),
  `Select` (styled native + chevron, `.h10-fsel`), `Checkbox` (accent-tinted
  native), `Toggle` (`role="switch"`, `.h10-toggle` 30×17 with sliding knob).
- Appended `.nds-field/select/check/toggle` to `styles/primitives.css`;
  catalog dog-foods them in a second Primitives card.
- `tsc` clean; identical pattern to the visually-verified wave 1. The @2x visual
  capture + push were deferred at commit time — a concurrent session was actively
  re-breaking the shared tree (dev 500 / non-buildable); both run on a clean window.
- Note: the searchable/portal MultiSelect + Combobox move to Phase 4 (composite).

## [P3.1] — 2026-06-22 — Primitives wave 1 (Button · Pill · Badge)

- First primitives in `primitives/`, tokenized to the H10 spec: `Button`
  (primary/secondary/ghost × md/sm + disabled, matches `.h10-am-btn`), `Pill`
  (ok/warn/arch, matches `.h10-pill`), `Badge` (SP/SD/SB program + A/M targeting).
- Self-contained `styles/primitives.css` under the `.nds-*` sub-namespace
  (collision-proof vs ads.css's route-scoped `.h10-*`; documented in NAMING).
  Added `--nds-text-strong` + `--nds-surface-hover` semantic tokens.
- Catalog now **dog-foods** the components (Primitives section); the verify
  harness gained a per-section `[data-cat]` capture.
- Verified @2x: light, dark, and a focused primitives shot — all match the H10
  look. Committed locally; push deferred behind a concurrent session's
  non-buildable tree.
- Remaining primitive waves: Input/Select/MultiSelect, Checkbox/Radio/Toggle,
  Tooltip/Spinner/Skeleton/Kbd/Divider, icons.

## [P2] — 2026-06-22 — Living catalog + verify harness

- New route `/design-system` (`app/design-system/page.tsx`) renders the full
  token set — primitive ramps, semantic roles, status pills, program chips,
  typography, spacing, radius, elevation, motion/z-index/breakpoints — driven by
  `@/design-system/tokens` so the catalog can never drift from the source. Light
  + a dark toggle that exercises the `.dark` CSS layer.
- `catalog/TokenCatalog.tsx` (the portable component) + `catalog/verify.mjs`, a
  Playwright @2x screenshot harness (light + dark, full page → `.analysis/dsshot`)
  reusing the established H10 capture pattern. This is the baseline that the
  component phases + the `ads.css` migration screenshot-diff against — i.e. it
  **unblocks** the deferred `ads.css` → token rewrite.
- Verified: `tsc` clean; isolated additive route (no existing file touched).
  Live visual review on the deploy (local dev server was in a concurrent-session
  500 state at build time, unrelated to this route).

## [P1] — 2026-06-22 — Token foundation

- Canonical token system shipped as new files (zero changes to existing code):
  `tokens/` (colors, typography, spacing, radius, shadow, motion, zindex,
  breakpoints + `index` barrel) and `styles/tokens.css` (the `--nds-*` CSS vars,
  three tiers: primitive ramps → semantic roles → component chips).
- Distilled the canon from **251 hex literals → ~70 tokens**; documented the
  drift (near-duplicate greens/reds/blues/greys, dual shadow tints) and the
  collapse worklist in `studies/01-color-drift.md`.
- Tokens are **dark-ready** (provisional `.dark` inversions of the semantic
  layer) though H10 ships light-first; no surface opts in yet.
- **Sequencing decision:** the `ads.css` rewrite onto tokens is deferred to
  *after* the Phase 2 screenshot-diff harness — canonicalizing drift changes
  pixels, so it must be verified, not done blind. Phase 1 stays pure-additive.
- Namespaced `--nds-*` to avoid colliding with `globals.css`; convergence onto
  the platform's semantic names is a deliberate migration step.

## [P0] — 2026-06-22 — Scaffold + governance + inventory

- Created `apps/web/src/design-system/` with the full folder structure
  (`tokens` · `styles` · `primitives` · `components` · `patterns` · `catalog` ·
  `studies` · `docs`), each self-documented.
- Founding governance docs: `README`, `GOVERNANCE`, `CONTRIBUTING`, `NAMING`,
  `TOKENS`, `TOKEN-RECONCILIATION`.
- Studies framework: `studies/README` + `_TEMPLATE` + the authoritative
  `00-ads-inventory.md` mapping every `/marketing/ads` UI element to its DS home.
- **Decision:** the H10 look becomes the canonical platform design language; the
  existing Tailwind semantic-token system converges onto it (one system, not a
  fork). Supersedes the unapproved `docs/UI_REBUILD_STRATEGY.md`.
- **Decision:** keep the `.h10-*` class prefix until a Phase 9 rename.
- Non-destructive: no existing page or stylesheet changed.

- Added `nds-theme-responsive`: an opt-in theme boundary that uses the generated DS dark palette inside legacy shells and their portals. No duplicated feature palette.


## 2026-09-07 — Media gallery composition

Added MediaCard and MediaGallery: uncropped inspection, separate selection, explicit image failure, stable ordering, keyboard/pointer parity and removal announcements. Media uses standard Nexus control sizes; the initial 44px wrapper and ToolbarButton expansion were removed after visual review. Components, exports, styles and catalog specimen are mirrored in Web and Factory.


### Control density correction — 2026-09-07

Removed Media’s blanket control overrides and its unused 44px ToolbarButton tier. MediaGallery uses standard 28px toolbar actions with consistent spacing. `nds-readable` / `Modal readable` now affect contrast and focus only; they no longer force 44px controls or 18px input text. The Media catalog compares ordinary and readable controls using the same size props. Web and Factory are mirrored.

### Media navigation — 2026-09-07

Added the decorative `PressableRow.leading` slot for thumbnails in gallery navigation. Selection remains on the labelled row action, with no nested control or density override. Catalog example, source and styles are mirrored in Factory.

Embedded Drawer headers now wrap long titles/subtitles within their text column, keeping Close aligned at the trailing edge. Modal sets its semantic text color on the root so plain footer text remains readable when portaled outside a dark shell. Neither correction changes control dimensions.

- 2026-09-07: Restored Factory pattern token parity with Web for 54 platform aliases. Shared patterns now reference their existing semantic Nexus tokens directly; layout and component density are preserved.

Account scope chips retain inactive marketplaces for history and explicitly label them “inactive” using the API’s participation state. They no longer imply that every stored marketplace is currently accessible.

`AccountsPanel` now uses its own container width to wrap actions below account details at 640px and below. This keeps identity, permission text, color choices and Test/Reconnect controls readable in narrow settings panels. Check 320px and 390px viewports in both themes.


## Grid guard cleanup — 2026-09-08

The Web formula sample keeps `getRowId` and its save callback stable. New mapping, listing-preset, catalog-transfer and formula-review consumers import `DataGrid` from `design-system/grid/datagrid`; the legacy table remains available for existing consumers and the comparison lab. The adapter honors `keyboardScroll` through AG cell focus and arrow-key navigation. Grid consumers import `CellClassParams` through the public grid barrel alongside the existing grid types.

The frozen Web comparison stylesheet scopes selection inputs to direct children of legacy selection cells, removes unused bulk/eBay checkbox and native-pager selectors, and names its radius values. `--nds-wsgrid-legacy-badge-radius` (4px) and `--nds-wsgrid-legacy-control-radius` (5px) preserve the reference's existing shapes; standard controls keep the current radius scale. These two token roles and generated CSS are mirrored in Factory. The AG adapter, formula catalog sample and comparison lab are Web-only.


Business profiles (2026-09-08): AccountsPanel describes account selection within the current business. Connection activity explanations use customer-facing language.

Amazon Seller migration (2026-09-08): AccountsPanel now offers a primary, explicit replacement action for env-managed accounts when the host supplies reconnect. Application-role grants are described without inventing OAuth scope counts, and environment credentials remain visibly active until Seller Central sign-in completes. Mirrored in Factory.

- OrderedList omits unavailable reorder controls for a single item; multi-item keyboard and pointer ordering is unchanged.

- MediaGallery `compact` keeps a larger featured first tile, contain-fit previews and keyboard move handles; contextual menus expose earlier/later/first and exact position actions.

- 2026-09-10: Added `CellAction` for grid disclosures and optional thumbnail reordering in `MediaStrip`. Pointer gestures retain cell focus without starting range selection. Removed competing native thumbnail titles. Portal hints are hoverable and Escape-dismissable, skip drag hover, and use stronger secondary text contrast. Web's grid adapter now dispatches column-level open handlers for fill-handle double-clicks as well as the host handler; Factory has no grid adapter.

## Information structured records — 2026-09-11

`RecordListInput` composes typed fields into repeatable records. It preserves unknown saved properties, stable option codes, explicit zero/false and empty lists. Add/remove announces the change and restores focus to the affected record. Layout wraps with container width; shared tokens and controls provide light/dark presentation.

### Grid host position — 2026-09-12

`useGridHostTop` observes the sheet and its parent as well as the viewport, so late-loading bands preserve the 8px bottom gutter. The hook is mirrored in Factory; the AG GridSheet host exists only in Web.

OrderedList keyboard grips use pointer capture for drag, including touch input; Escape cancels a drag. Native drag support remains for the existing non-button grips.

FilterChip compactLabel keeps docked sheet actions in one row at 1280px; the trigger retains its full accessible label.

2026-09-12: `usePointerReorder` shares captured pointer dragging across vertical OrderedList grips and horizontal AxisChip groups; keyboard reordering stays available through OrderedList.

2026-09-12 VP.F: FilterChip compact/full labels preserve the shared horizontal icon-and-text alignment, including SVG block defaults.

## Monospace token parity — 2026-09-12

Factory now defines `--nds-font-mono` for its grid editor styles. Both apps use a monospace fallback when the host does not supply `--font-mono`; generated stylesheets are refreshed.

2026-09-12 LX.7: moved the existing CellProvenance type to @nexus/shared/cell-provenance so API and grid contracts import one declaration. Renderer behavior and vocabulary unchanged; outdated rendering remains Step 6. Factory has no AG grid/provenance module.

### 2026-09-12 — LX strict editor gate

- SourceIndicator can show an exact server refusal through `tooltip`, preserving action naming.
- Formula-aware value textareas retain the grid editor’s no-manual-resize rule.

The exact SourceIndicator `tooltip` also supplies a native title, so critical server refusals remain available in hosts that disable custom tooltip portals.

LX.10 (2026-09-13): `outdated` is the translation-age provenance member, with a History glyph and warning semantic tokens. `describeCellSource()` produces the shared member/from/tooltip contract. Precedence: refused → AI → outdated → formula → mapped → inherited/pinned → own.

- 2026-09-13 · Language-axis LX.11: added `nds-ag-group-start` for readable labels on field groups wider than the viewport. Product Studio uses the existing strip-height token on both sheets.

2026-09-13 · Formula reference context: the Web AG formula adapter passes the edited field key to candidates, source labels and reference highlighting. Hosts can bind canonical references to a language-qualified view column. Existing single-language callbacks remain compatible. Verify editing a French column offers French field values and highlights the French source cell. Factory has no AG formula adapter; no shared Factory runtime changes.

## Unscorable readiness — 2026-09-13

CompletenessPill renders — with an accessible explanation when pct is null. It preserves scored ratios and state tones. Extracted from the web identity band into the same standalone renderer in Web and Factory.

## Canonical content marks — 2026-09-13

Both Studio sheets consume describeCellSource + ProvenanceMark for language, pin and source tiers. Resolver-owned `from` takes precedence over legacy row labels. Mapping diagnostics alone no longer assert derivation when the server supplies `derived: false`. Factory mirrors the shared classifier.

Canonical pin marks accept the DS description as their tooltip, keeping the addressed listing distinct from the shared language it overrides. API and inline explanations use the same sentence.


### 2026-09-13 — Variation Theme consistency and narrow editors

AxesPanel/AxesPanelEditor and VariationThemeValue share the server’s effective projection, including rule provenance, intentional omissions, unavailable schemas and collisions. The popup fits the viewport, wraps instructions in narrow hosts and uses strong semantic text tokens. Reset keeps its own intent when opening a live-change plan. Factory includes the editor, renderer and their grid dependencies; the drift guard requires their counterparts.

## Presence contract and accessibility — PR.6 — 2026-09-13

Grid actions now carry typed reach and reversibility; validation refuses a softer confirmation than the captured consequences require. This enhances the contract so guards can enforce promises that previously lived in prose. Declaration order is preserved in both menu adapters. Danger tone is rendered on the emitted button/link selectors; held menu items retain their visible description and title, accept keyboard focus, and cannot execute.

PresenceMark composes Tag, Pill and AsOf; no timestamp or stale observation can imply current green verification. AsOf shares the promoted ago/when formatters and says “not checked” or “never” for absence. ActionConfirm now lives in components with a compatibility export from grid/actions; exact typing, visible acknowledgement, Cancel-first focus, read-only SummaryTable review and typed reversal sentences share one implementation. SummaryTable row tone remains on a Pill. Disclosure accepts Tone and retains native open semantics. CellSaveMark distinguishes saving/waiting/unknown by glyph and border shape; provenance marks have accessible names without tab stops. SheetStatuses accepts data only, uses md Pills, exposes details through a focusable control and retains alerts when surplus coalesces. Views naming/deletion uses an anchored popover while its trigger stays in place.

Named danger/success/formula text tokens are raised, with source-derived ground calculations in docs/audits/2026-09-13-presence/pr6/contrast.mjs. Focus outlines replace weak glow-only rules; aria-disabled styling pairs native disabled selectors. Browser and guard results are recorded separately in the PR.6 ledger; this entry does not certify unfinished gates. Shared files and new shared components are mirrored in Factory; web-only catalog and Views integration remain web-only.


### PR.6 approved accessibility follow-up — 2026-09-13

ScopeBar now lets arrow keys reach a held scope and its InfoTip without changing the selected scope; Enter and click remain guarded. Theme-controlled AxesPanel checkboxes keep keyboard focus, their supplied explanation and unchanged checked state. The ModeNotches consumer exposes the pending-write sentence through its existing refusal banner callback.

`nds-focus-inset` keeps a Button outline inside a clipped joined control and uses currentColor so the ring follows the actual normal, selected and hovered ink. Use it only where that ink clears 3:1 on every control fill. The catalog includes held and editable axes as local demonstrations; held scopes are in the existing ScopeBar example. PresenceMark additionally accepts `{line, now, via?}` for canonical aggregate metadata without an invented member Presence, and preserves “Could not ask” when observation time/source are absent.

With Owner approval, existing danger/warning/formula text tokens now clear 7:1 across the conservative 80-ground light and dark matrices; success already clears that bar. No new token, fill, or ratchet-baseline increase. The corrected source-derived measurements live in the PR.6 audit.

SheetStatuses accepts compact=true from the host’s existing last toolbar tier: one +N control retains every detail and danger announcement; default rendering remains at most three Pills. It defines no breakpoint.

PresenceMark axis=intent|fact|both (default both) separates adjacent columns; compact=true moves the full canonical explanation into a keyboard-reachable InfoTip. Fact keeps AsOf; no vocabulary or freshness logic is duplicated.
## Field publication review — 2026-09-25

`ChangeReview` composes labelled native checkboxes and `KeyValue` comparisons, with a visible status and reason per field. Ineligible rows keep their evidence readable and cannot appear selected. Narrow screens stack the values; all styling uses semantic tokens. Catalog specimen: `ChangeReviewExample`. Mirrored between Web and Factory.

## PressableRow stacked — 2026-09-26

`PressableRow stacked` puts `children` on their own full-width line under the label; `leading`, the label and `actions` keep the first line, and the whole row stays one keyboard and pointer target. Use it when a row's details are wider than its label: side by side, a wide body squeezed the label to its padding and the label's words overflowed onto the body (measured on the File mappings version list, `/channels/mapping?view=files`). Off by default, so existing rows are unchanged. Specimen: the stacked row under "Gallery navigation" in `MediaGalleryExample`. Mirrored between Web and Factory.

## Shared stock cell state — 2026-10-01

`.nds-cell-is-shared-stock` (grid.css) with the token `--nds-grid-shared-stock-bg` (tokens/grid.ts, teal at 14%; the Owner tried violet at 18% and chose teal): a grid cell whose number follows ANOTHER business profile's lent stock. The Matrix puts it on the Qty and Mode cells of a SKU that sells from a lent stock and follows it (not on a fixed, paused or Amazon-managed listing), and names the lending business in the cell's tooltip — never colour alone. It comes after the inherited tint in the stylesheet, so it shows on a following cell. Mirrored between Web and Factory.

## Selection note size — 2026-10-01

`.nds-grid-selbar-note` (grid.css; `SelectionNote`) now has the size of the count beside it (`--nds-font-size-sm-plus`, the size of `.nds-toolbar .cnt`). Before, it took the page's 16px: on the Matrix, "Selected 21 rows" was 12.5px and "on Amazon EU · Inventory · IT DE FR ES" next to it 16px, so the Owner read it as another font (Chrome draws both in Inter). Also fixes the Products page, which uses the same note.
