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
