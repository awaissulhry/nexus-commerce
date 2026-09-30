## Replacement rows keep confirmed write versions — 2026-09-30

**`SheetWriter`** accepts an optional `mergeRow(previous, incoming, knownVersion)` function on row seeds and edits. Product sheets use it to retain confirmed content and listing versions without replacing edited values. Ownership rules stay in the sheet. Mirrored in Factory.

## Batch replies keep newer version numbers — 2026-09-30

**`SheetWriter`** keeps the highest confirmed row version when a save finishes. An older reply cannot undo a newer version learned from another alias, so the next edit uses the right number. Uses the existing seed rule. Mirrored in Factory.

## Clear is reachable with the arrow keys — 2026-09-30

**`ListboxPanel`** lets ArrowUp reach Clear from the first option. Enter and Tab report an empty value before a grid ends the edit. Focusing Clear also updates the keyboard choice. A missing stored value still stays unchanged until the operator chooses. Mirrored in Factory.

## A short list takes the keyboard before it is painted — 2026-09-30

Mirrored from web. `ListboxPanel` without a search field focuses its container in a layout effect, before the paint.

## A source mark in a grid without hints mounts no tooltip — 2026-09-30

Mirrored from web. `SourceIndicator` skips its `Tooltip` inside a `TooltipPortalProvider disabled` host (same markup); `useTooltipsDisabled()` in `primitives/Tooltip.tsx`.

## A save that answers with a warning says so on its cell — 2026-09-30

Mirrored from web. `CellSaveEntry.warning`, `CellSaveTracker.setSavedWithWarning` / `warnedCount`, `saveNote`, a `SheetWriter` result cell's `warning`, the `nds-cell-is-saved-warned` class and its `grid.css` rule.

## MediaBoard: a row's mark wraps — 2026-09-29

Mirrored from web. `.nds-media-board-source` keeps to the row head's width; a Tag or Button directly inside it may break its words.

## Live photo drag: MediaBoard `liveDrag`, `useSortableDrag` layout `grid` — 2026-09-28

Mirrored from web. `gridDropIndex` / `gridShift` in `lib/sortable.ts`, `layout: 'grid'` in `useSortableDrag`, opt-in `liveDrag` on `MediaBoard` (one-row boards; off by default) and its `.nds-media-board-list.live` / `.dragging` rules.

## Variation theme pop-up on Shopify — 2026-09-28

Mirrored from web. The channel layout on Shopify: free option names (`freeNameRefusal`), own options, the live-product lock; `.nds-axes-chead > .nds-field` (+ its input shrinks); a cell panel outside AG's popup layer does not take focus on load.

## Variation theme pop-up on a channel: "New attribute" — 2026-09-28

Mirrored from web. `NewOwnAttribute` (say first, then Create; Use it for an existing attribute; held with its reason), `createOwnAxisAttribute` editor param, `OwnAxisSourcesLoader` answers `{ sources, newAttribute }`, `.nds-axes-newattr`.

## Variation theme pop-up on a channel — 2026-09-28

Mirrored from web. `AxesPanel` channel layout (eBay, Etsy): rows with origin, value chips and empty-variant hints; "+ Add" with Shared, channel-list and own-name groups; `channelAxes.ts`; `suppressAxesPanelKeys`; `MediaChipField` static chips are not Tab stops.

## Variation theme pop-up, shared product — 2026-09-28

Mirrored from web. `AxesPanel` master rows with value chips (photos on the photo axis only) and a variant list, refused axis removal, `variationFamily.ts`, `MediaChipField` `searchable`/`removable`, nested `useSortableDrag`.

## Shopify pop-up pieces — 2026-09-28

Mirrored from web. `MetafieldValue` reference chips with pictures and swatches (`metafieldDisplay` `swatches`), `MediaPickList` `rowActions`, `EDITOR_KEY_HINT_PANEL`, `editorBox`/`EDITOR_CAPS` exported from the editors barrel.

## Media pickers: MediaMark, MediaPickList, MediaChipField, MediaOrderedList, ResourcePickerDialog — 2026-09-28

Mirrored from web. Pickers whose choices carry a picture or a colour swatch (`MediaChoice`, `lib/media-choice.ts`), and the grid editor size kind `media` (480 × 520). Also the opt-in `OrderedList liveDrag` prop and `useSortableDrag` (`lib/sortable.ts`).

## Catalog: no text inside synthetic images — 2026-09-27

Mirrored from web. The synthetic example photos in `catalog/MediaGalleryExample.tsx` draw no text (an SVG image cannot use the page fonts; its label fell back to Arial on Windows).

## MediaStrip: muted items — 2026-09-27

Mirrored from web. **`MediaStripItem.muted`**: an item shown for context, not part of the cell's own list (dashed frame, faded image, "· shared" in the tooltip).

## MediaBoard — several ordered photo sets on one board; MediaCard compact — 2026-09-27

Mirrored from web. **`MediaBoard`** (new): ordered photo sets in rows; move a tile within or between rows by drag, keyboard (Space, arrows, Space; M main; Delete remove) or its menu; Alt copies; outside drops via `MEDIA_BOARD_EXTERNAL_TYPE`. **`MediaCard compact`**: a dense tile for long lists. Styles `.nds-media-board*`, `.nds-media-card.compact`, `.nds-media-card-name`; catalog `MediaGalleryExample`.

## Variation theme tooltip carries the delivery note — 2026-09-27

Mirrored from web. **`variationThemeTooltip`** ends with the cell's `deliveryNote` when the cell is writable, and with `writeBlockedReason` when it is not.

## Customise: always-shown columns, emptied groups — 2026-09-27

Mirrored from web. **`PreferencesColumnSpec.alwaysShown`** (always on screen, still movable and pinnable; held tick, no ✕, no hide) and **emptied groups** (left out of the tick-list; "Empty · drag a column here to put it back" in In view). Opt-in; every other caller is unchanged.

## Menu headings and on/off items, Customise select-all — 2026-09-27

Mirrored from web (the product sheet's toolbar rebuild). **`Menu`**: `MenuItemDef.heading` (a section heading, skipped by the arrow keys, `.nds-menu-heading`) and `checked` (`role="menuitemcheckbox"`, a ✓ in a fixed slot). **`PreferencesModal`**: `bulkPick` ("Select all · Clear all", on the matches when filtering), `rememberInteraction` (the filter text and open groups survive a reopen), `confirmLabel`, and `PreferencesColumnSpec.uncounted` (listed, never counted). Styles in `components.css`, `patterns.css` and `grid/theme/grid.css` (the toolbar's “Columns:” / “Rows:” lead words). All opt-in.

## Focus outlines that paint, and a guard — 2026-09-27

`DetailPopover`'s trigger and panel declared `outline: 2px solid var(--nds-focus-ring)`. That token is a box-SHADOW value (`0 0 0 2px rgb(…)`), so the browser dropped the whole declaration and neither had a visible keyboard focus — every readiness and progress card. Both now use `var(--nds-primary)`, the DS rule `a11y.css` already follows. The same misuse in the app's notifications bell is fixed. New guard **`scripts/check-shadow-token-use.mjs`** (`--self-test`) derives every shadow-valued token from `tokens.css` (lengths + a colour, var() chains followed) and fails any declaration that uses one outside `box-shadow` / `text-shadow` / `filter` / a custom property; it runs in the CI static gates and `gates-full.sh`. Mirrored in Factory: `styles/components.css`.

## Progress meter, progress card, cell landing — 2026-09-26

The sheet's progress columns (Owner-approved preview, 2026-09-26). **Tokens** `--nds-progress-{complete,partial,missing}` (bright, the Owner's ask), each with an `-edge` — the 1px inset line the ground actually meets, so every tone clears 3:1 on every grid row ground in both themes (bright yellow is 1.69:1 and green-600 2.91:1 on the variation row without it) — and `--nds-progress-track`, all resolved through a new tier-1 `palette.signal` ramp (`--nds-signal-*`: the bright red, yellow and its edge, and the dark steps) so no stylesheet carries a literal; measured by the new guard `scripts/check-progress-contrast.mjs` (`--check`, `--self-test`, `--tokens`). **`ProgressBar`** gains `tone` (`complete | partial | missing | unknown`) and `showValue` (bar + one rounded number, `—` for a `null` value); without them it is unchanged. **`grid/renderers/progress.ts`** — colour rule A as ONE pure function, `progressTone`: red while a required field is empty whatever the percentage, yellow when only optional fields are, green when nothing is, grey when it cannot be said (never a guessed green; #43, #727, R-LX-9) — plus `progressDetailModel` (no cap: every field is listed), `progressTriggerLabel`, `progressText`, `combinedPercent`, `progressListKey`. **`ProgressCell`** — the meter in a `DetailPopover`; hover, click, Enter or Space opens **`ProgressDetailCard`**: header (tone swatch, scope · %, the tone in words), one line of counts, then "Required and empty", "Optional and empty" and "Other issues" as a dropdown-style list — full-width rows, sticky tone-coloured group headings, ↑ ↓ Home End, Enter goes, the list alone scrolls (`overscroll-behavior: contain`) — and a footer link. **`DetailPopover panelClassName`**; `nds-detailpop-scroll` caps a panel to `--nds-popover-room`. **`landOnCell(api, { rowId, colId, reveal?, root? })`** — opens collapsed ancestors, shows a hidden column, scrolls the row to the middle, puts the cursor in the cell and marks it `nds-cell-landing` (2px brand ring on a brand wash, pulsing twice, `LANDING_MS` 2400; no animation under reduced motion). **`bandColSpan` / `spanWithinSection` `stopBefore`** — a column a band row does not cover. **`IdentityBand title`** — the band's hover sentence (the channel listing band's moved here from the readiness pill). Catalog: `ProgressExample` under Progress. Lab: `/design/grid-lab/progress`. Mirrored in Factory: `ProgressBar.tsx`, `DetailPopover.tsx`, `styles/components.css`, tokens (Factory has no grid renderers of this kind, no `NexusGrid` and no TokenCatalog — see the mirror note in the PR).

## Blank empty cells and view naming — 2026-09-26

Mirrored from web (SHEET-VIEWS). `grid/renderers/emptyCells.ts` (new): the grid's empty-cell mode as a context — `dash` by default, `blank` for an editing grid; `EmptyValue` and the variation-theme child cell read it, a measured zero keeps its dash. `nds-cell-na` hatch and the muted followed-but-empty link mark in `grid/theme/grid.css`; the sheet status strip's FAB reservation now applies only while the FAB is on screen, and the folded-filter panel is a fixed popover. `variationThemeColumnDef` marks child rows `nds-cell-na`. `PreferencesModal viewSave.startNaming`. The selected-row wash, rail and pointer-focus rules are in the same stylesheet. Factory has no `NexusGrid`, so the mode stays `dash` here until a Factory grid asks for `blank`.
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

# Nexus design system additions

## Scrolling tab bars — 2026-09-11

`Tabs overflow="scroll"` constrains long labels to the host width and keeps the active tab visible. Arrow, Home and End navigation retains the existing roving focus behavior. Optional mode preserves existing consumers; mirrored in Factory and used in Products → Categories.

## Quiet channel cells — 2026-09-10

`TooltipPortalProvider disabled` renders labelled controls without tooltip wrappers, portal state or hover listeners, including nested providers and explicit portal hints. Channel sheets use it around the grid body and offer full cell explanations through Cell details. Header help and toolbar hints remain available. The provider and regression tests are mirrored in Factory; Factory has no channel grid or TokenCatalog. Measure cells expose the full unit through their accessible label without a competing native title.

## Mixed product media — 2026-09-10

`MediaPreview` supplies image, native video/audio, external-video and unknown-file presentation. Native playback is explicit; video supports alternative sources, posters, language-labelled WebVTT tracks and a transcript disclosure. Failed previews and caption loads announce a useful fallback. File links reject executable protocols; existing image-only data URL previews remain supported.

`MediaStrip` is non-interactive grid content with poster thumbnails, type icons, missing-preview handling and a full media count. The grid owns the edit action. `MediaGalleryItem.mediaType` and `placeholder` carry these same distinctions through the keyboard-reorderable gallery. These components preserve normal Nexus control sizes and are mirrored in Factory.


## Readable ordering labels — 2026-09-09

`OrderedList.itemLabel` names ordering controls and live announcements independently of stable resource IDs. Shopify linked products and reference lists consume it. Control geometry and keyboard actions are unchanged; component and catalog documentation are mirrored in Factory.

## Shopify file previews — 2026-09-08

`MediaCard` supports missing preview URLs and a file-type placeholder. Documents and processing media retain the same keyboard preview action and card geometry without issuing broken image requests. The shared CDN helper now sizes Shopify image URLs while retaining their version parameters. The component, helper and catalog specimen are mirrored between Web and Factory.

## Sub-sidebar tooltip dismissal — 2026-09-08

Portal tooltips dismiss on activation and Escape, and distinguish pointer focus from keyboard focus. Returning focus after a disclosure closes no longer reopens its hint; keyboard navigation inside an expanded disclosure does not rearm the opener. Fresh pointer movement or a subsequent keyboard visit can show the hint again. The interaction logic and regression tests are mirrored from Web. No focus restoration, control sizes, styles, or timing tokens changed.

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

## Information grid states (Web) — 2026-09-07

The Web-only grid adapter now supports `GridLoadingOverlay.rowKind` for single-line thumbnail skeletons and keeps the React overlay wrapper at grid width. Its Information grids use the existing Nexus loading, empty and retry patterns. Factory has no grid adapter; shared controls and tokens are unchanged. The product-row specimen is in the Web `/design/grid-lab` catalog.

## Account permission accuracy — 2026-09-07

`AccountsPanel` distinguishes an unrecorded OAuth grant from recorded missing permissions. An empty grant list shows neutral explanatory text and a plain Reconnect action; it no longer claims every catalog permission was denied. Recorded grant shortfalls retain the warning and count. Web and Factory share the behavior and regression coverage.

## Asynchronous choice panel — 2026-09-07

`AsyncListboxPanel` composes Field, Input, ListboxPanel and Buttons for externally loaded choices. It provides loading, empty, error, retry and cancel states with standard small controls. The caller owns fetching and filtering; the panel commits option values only, skips disabled options, and keeps the input's active descendant synchronized with grouped choices. Escape cancels and Tab reaches actions without stepping through every option. `ListboxPanel.optionTabIndex` is optional, preserving existing consumers. Product categories, description themes and shipping templates consume this panel. Source and catalog examples are mirrored in Factory.

## Dense header metadata spacing — 2026-09-07

`DetailHeader dense` reserves its metadata track up to half the title area above the mobile breakpoint. Identity text truncates inside that track while fixed pills stay clear of autosave and actions. This fixes the product header overlap at 900px and leaves the existing mobile wrapping behavior intact. The layout rule is mirrored from Web.

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

## 2026-09-06

Mirrored OrderedList, exports, semantic styles and catalog specimen from Web. Added independent wrapping workspace ScopeBar layout.

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

Amazon Seller migration (2026-09-08): AccountsPanel now offers a primary, explicit replacement action for env-managed accounts when the host supplies reconnect. Application-role grants are described without inventing OAuth scope counts, and environment credentials remain visibly active until Seller Central sign-in completes. Mirrored from Web.

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
# Changelog — Nexus Design System (Factory mirror)

## Account names — 2026-09-08

Mirrored the complete account-style block, previously absent in Factory, including 390px-tested container-responsive layout. Hosts can supply accurate verification wording or hold unavailable actions through `reconnectLabelForAccount`.

Mirrored the shared account/channel display-name helpers and name-only switcher, panel, and scope chips from Web. Opaque keys remain internal, including in accessible labels and dialogs; missing names are explicit and can be renamed. Regression tests cover legacy IDs and real names.

## Amazon Seller migration — 2026-09-08

Mirrors Web’s `AccountsPanel`, account model, tests, application-role permission copy, and explicit ENV-credential replacement action. The copy covers both public website authorization and private-app self-authorization import.

## Monospace token parity — 2026-09-12

Factory now defines `--nds-font-mono` for its grid editor styles. Both apps use a monospace fallback when the host does not supply `--font-mono`; generated stylesheets are refreshed.

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
