# catalog/

Quiet controls: `TooltipPortalProvider disabled` removes all descendant Tooltip wrappers and behavior, preserving each trigger's accessible name and interaction. Nested portal providers cannot re-enable hints inside a quiet host. The Tooltip specimen includes a “Quiet grid control” beside normal hints. Use this only when details have an explicit accessible action; channel sheets provide Cell details from the cell context menu and the toolbar More menu. Verify pointer sweep, keyboard editing, full-value inspection and return focus in light/dark and narrow layouts. Factory mirrors the provider and tests; its catalog has no TokenCatalog surface.

Tooltip bubbles use the same theme-invariant `--nds-tip-bg` and `--nds-tip-fg` roles in Web and Factory. Portal arrow offsets are local runtime style properties, not global color or spacing tokens. Verify a focused tooltip in both themes and near viewport edges.

Portal tooltip dismissal: in `#workspace-subheader-example`, open navigation with the pointer and with Enter/Space. Tab through the panel, then close with its collapse button, Escape, a destination, or the backdrop. Focus must return to the opener without a tooltip reopening. A subsequent Tab visit or deliberate pointer movement should show the hint again; pointer exit should hide a hover hint even when the opener retained focus. Repeat at 390px in light/dark themes. Activation and Escape dismiss immediately; no timeout or focus removal is used.

The drawer examples include collapsed actions. With the section closed, Shift+Tab from Close wraps to the visible summary, never to its hidden button. Open the section and verify the button enters the sequence. Tab remains within a modal drawer; Escape returns to its opener. Verify both themes and 390px width. Web and Factory use the same visibility checks.

The Web `/design/grid-lab` includes `loading-products`: `GridLoadingOverlay rowKind="media-line"` uses the product grid's thumbnail and single-line row height in compact, cozy and spacious density. Verify loading, empty-search recovery and retry in light/dark and narrow layouts. Factory's design system has no grid adapter; shared controls retain their existing implementation.

`DetailHeader dense` keeps metadata within a reserved track capped at half the title area at widths of 720px and above. Verify a long title with SKU, external ID, status and Parent pills beside autosave and an action at 900px: metadata must remain clear of the status region. WorkspaceSubheader retains its existing wrapped mobile layout below 720px. The shared rule is mirrored in Factory.

The living style guide — one screen that renders every token (and, as Phases 3–5
land, every component) at native resolution. It is both the **documentation**
surface and the **verification harness** target.

The component section includes `SourceIndicator` examples for Master inheritance,
listing overrides, mapping rules, channel defaults and missing mappings. They use
the same component as channel cells, with `showLabel` enabled for a visible legend.

- `TokenCatalog.tsx` — the catalog component, driven by `@/design-system/tokens`
  so it can never drift from the source of truth. Light + a dark toggle (which
  exercises the `.dark` CSS layer). Mounted at the route `/design-system`
  (`apps/web/src/app/design-system/page.tsx`).
- `verify.mjs` — the screenshot harness. Captures the catalog @2x (light + dark,
  full page) to `.analysis/dsshot/` for self-review and as the baseline that the
  component + `ads.css`-migration phases screenshot-diff against. Reuses the H10
  Playwright pattern. Run from repo root with the dev server up (see the file
  header). Ignored by the Next build + tsc.

This is the screen used to judge the whole system at once, and the surface where
"screenshot-diff before showing" is enforced for every later visual phase.

- **WorkspaceSubheader** (`#workspace-subheader-example`, Patterns): subheader-only toggle cell, overlay navigation, independent title menu and native view links. The optional 32-collection specimen exercises long-label wrapping, badges, disclosure and internal scrolling. Main content is a sibling of the strip.

`OrderedList` is demonstrated at `#ordered-list-example`: controlled string IDs, optional `renderItem`, `disabled` and `draggable`; use stable unique IDs. Keyboard move buttons are always available. `ScopeBar` can use `nds-workspace-scope` below a WorkspaceSubheader to keep navigation geometry independent from scope.

`EmbeddedDrawerExample` demonstrates `Drawer mode="embedded"`: normal document flow, a scrolling body, no backdrop/focus trap and no overlay of the surrounding workspace. Existing `dock` record panels keep their overlay geometry.

Drawer footer actions wrap inside the panel at narrow widths. The `DrawerFooterExample` specimen (`#drawer-footer-example`) includes three actions to exercise wrapping; its body scrolls independently of the footer.

### Workspace navigation contrast (2026-09-06)

The existing WorkspaceSubheader and Banner catalog specimens include primary semantic text for secondary navigation links/group labels and neutral notices. Check both themes at desktop and narrow widths; normal text must meet 7:1 contrast.


### Formula editing — 2026-09-06

`ListboxPanel` now exposes `${idPrefix}-listbox` as the listbox ID, paired with its existing option IDs for external combobox controls.

The web catalog's `#formula-editor-example` mounts the real `FormulaCellEditor` with finite sample responses and in-memory rows. It covers entering `=` after double-click, references selected by clicking a field in the same row, function suggestions, `&` text joining, Enter/Apply, Escape/Cancel, and formula copy/fill. The sample states that it is not the product evaluator. Grid adapters remain web-only; shared ListboxPanel changes are mirrored in Factory.


### Formula composer and modal access — 2026-09-06

The web `#formula-editor-example` demonstrates the same grid editor and shared guidance used in product cells. **Add text** quotes and escapes the text automatically; **Insert field** opens field suggestions. `FormulaComposer` provides that guidance, completion, keyboard behavior, abortable previews and retry for record drawers and bulk forms. A host may choose linked or one-time guidance; the host owns preview and persistence. `replaceFormula` receives the replacement literal so metadata and value can commit together.

The shared Modal specimen now keeps Tab/Shift+Tab within the top dialog, restores focus to the opener, honors an inner control's Escape handling and retains its originating dark theme. Footer controls wrap; the body scrolls while header/footer remain visible. Shared Modal changes are mirrored between Web and Factory; grid adapters are Web-only.


### Media galleries — 2026-09-07

`MediaCard` presents an uncropped image with a separately focusable preview, optional selection, metadata and actions. Failed images show “Image unavailable”. `MediaGallery` composes cards into a controlled sequence with drag grips, standard ToolbarButton move/first/remove controls and position announcements. Provide unique stable IDs and update the controlled order in `onChange`. Removing assignments must be handled by the host; the component does not delete source assets.

Media uses the normal Nexus control sizes and semantic text hierarchy, including 28px ToolbarButton actions. No page wrapper resizes or restyles shared controls. Arrange action containers with layout; choose component sizes through their documented props.

`MediaGalleryExample` (`#media-gallery-example` in Web) demonstrates reordering, source selection and an unavailable image using clearly synthetic catalog assets. Factory carries the same component and specimen source.


### Formula recovery and readable controls — 2026-09-07

Use `Modal readable` or the `nds-readable` composition for forms that need primary semantic text and strong keyboard focus while preserving the selected control sizes and input typography. `SegmentedControl wrap` keeps long choices within narrow forms. `DataGrid keyboardScroll` makes overflowing tables keyboard focusable and labels their scroll region; provide `ariaLabel`. `ListboxPanel ariaLabel` names suggestion lists controlled by a separate combobox. Modal backgrounds are inert while open; nested dialogs, Escape dismissal, initial `data-autofocus` and returning focus to the opener are handled centrally.

The Web catalog's `#formula-editor-example` exercises the shared formula editor. `===` and `!==` compare values exactly; Add text handles quoting and `&` joins text. The separate `/design-system/formula-workflow` specimen mounts the real product bulk and history dialogs, including refresh recovery and undo. It is only available in development with `FORMULA_BROWSER_FIXTURE=1` and `NEXT_PUBLIC_API_URL=http://localhost:4115`; the production route returns 404. `/design-system/formula-workflow/responsive` renders actual 320px and 768px viewports in both themes and reports DOM contrast, target and overflow measurements. The fixture backend uses a disposable PGlite PostgreSQL database and no external queues. Reproduction and results: `docs/2026-09-07-product-formula-quality.md`. Shared controls are mirrored in Factory; formula grid adapters and workflow specimens are Web-only.


### Mapping status contrast — 2026-09-07

`MappingStatusExample` shows the existing information, success and neutral pills with a tonal selected control. Check in light/dark: the information pill must remain readable (dark: `--nds-text` on `--nds-primary-soft`, 11.23:1), and the selected control must use a dark surface. Its specimen source is mirrored in Factory. The controls retain their existing API and keyboard behavior.


### Compact formula editing — 2026-09-07

The Web `#formula-editor-example` demonstrates the refined editor and a 320px form. Button and Input use their standard `sm` size (28px); readability only changes contrast/focus. One helper sentence accompanies the formula input. Insert field, Add text and Help share a compact toolbar. Add text and Help hide the suggestions while expanded. Help explains same-row sources, linked updates, `&`, `===` and keyboard completion. The scrollable grid body keeps suggestions, guidance and result in flow; the action footer remains visible.

The syntax overlay copies the native input's font and exact bounds, remeasures when resized, and vertically centers its text. Code ligatures are disabled so operators match what was typed. The native field focus ring is retained without a second clipped outline inside the input.

`ListboxOption.searchText` provides searchable terms separately from its visible `label`; `trailing` adds a supporting value at the end of the option row. Formula suggestions use these to avoid repeating long technical names. `ListboxPanel` keeps the active row visible using coordinates relative to the panel, including when it is statically positioned inside a popup. The shared Listbox APIs, styles and focus correction are mirrored in Factory; grid adapters remain Web-only.

Media gallery: the navigation example composes `PressableRow.leading` with a passive `Thumbnail`; the labelled row is one keyboard action.

Mapping workflow checks (2026-09-07): mapping status, history Drawer, DataGrid keyboard scrolling and product/account navigation compose the existing catalog controls. Factory pattern styles use the same semantic color tokens as Web.


Account permissions (2026-09-07): `AccountsPanel` uses neutral “No permissions recorded” text when the stored grant list is empty, even when the catalog requests permissions. Its Reconnect action has no invented missing-permission count. Verify alongside a recorded partial grant (warning and count), an environment-managed account, and a fully recorded grant in light/dark and narrow layouts. Shared row behavior is mirrored in Factory.

Account scope chips retain inactive marketplaces for history and explicitly label them “inactive” using the API’s participation state. They no longer imply that every stored marketplace is currently accessible.

`AccountsPanel` now uses its own container width to wrap actions below account details at 640px and below. This keeps identity, permission text, color choices and Test/Reconnect controls readable in narrow settings panels. Check 320px and 390px viewports in both themes.

Web `/design/grid-lab` action-confirm specimens cover cancelled product selection and typed demotion with named children. Cancellation returns without a write or an error. Family product selection composes existing Modal and AsyncListboxPanel controls; Factory has no grid adapter.

`AsyncListboxPanel` marks its search input for modal initial focus. Check that opening it in a Modal focuses search, Escape cancels, and focus returns to the trigger. This shared behavior is mirrored in Factory; control sizes are unchanged.

Save recovery (2026-09-07): Web `/design/grid-lab` includes Reload with an unconfirmed save. Verify Cancel keeps local work and the confirmation explains that Reload cannot undo a server write. Recovery uses existing grid states and control sizes. The writer adapter remains Web-only; no shared Factory runtime changed.
## Listbox focus verification — 2026-09-07

Open a Listbox with Enter, dismiss with Escape, and verify focus returns to its trigger. Tab should reach the following field. Selecting an option also returns to the trigger; clicking another field must retain focus on that field. Web and Factory share this behavior.


Grid guard verification (2026-09-08): Web formula catalog saves use stable grid callbacks. The formula, mapping, preset and transfer review grids use the AG DataGrid adapter. With `keyboardScroll`, arrow keys navigate cells and reveal offscreen columns; embedded controls retain their keyboard handling. In `/design/grid-lab`, compare legacy selection/search before and after token changes. The mirrored `--nds-wsgrid-legacy-badge-radius` (4px) and `--nds-wsgrid-legacy-control-radius` (5px) are frozen-reference shapes, not sizes for new controls. The adapter and lab remain Web-only.

Light shell colors (2026-09-08): `--nds-info-text-light` is the invariant light reference for the information role. Use `MappingStatusExample` to compare the information Pill and Tag beside tonal and selected-filter controls under light and dark themes; information text must exceed 7:1 on its surface. In Web, also check a light-pinned `.h10-shell` and its portal while the root is dark: info, tonal and selected-filter roles must remain light. Responsive themed content still uses the dark semantic roles. Factory mirrors the shared token source; the legacy application shell belongs to Web. No control geometry changes.


Business profiles (2026-09-08): AccountsPanel describes account selection within the current business. Connection activity explanations use customer-facing language.


### ScopeBar destination visibility (2026-09-08)

Render Shared product, Shopify and Etsy in a `ScopeBar` with Etsy selected, inside a narrow `nds-workspace-scope`. At 390px and 768px, verify the selected chip remains fully visible after a channel change, an async readiness label update and resizing. ArrowLeft/Right and Home/End change selection and focus together. The chip track alone scrolls; the surrounding page stays still. Verify light and dark themes. Factory exports the same pattern and uses the same readiness labels.

### Account profile assignment — 2026-09-08

`AccountsPanel` accepts `onAssignProfile(account)` for a host-owned review dialog, `includeDisconnected` for administration and `onChanged` to refresh surrounding counts. `AccountRow.isActive` controls unavailable actions. Verify Assign profile by keyboard, nested destination search, and disconnected Reconnect rows in light/dark at 390px. Business ownership and API checks remain in the feature.

### Grid lifecycle — 2026-09-08

Use `useGridLifetime` from `grid/hooks`: pass `bind(event.api)` from `onGridReady`, pass `onGridPreDestroyed` to the grid, and obtain the API through `getApi()` inside deferred callbacks. Depend on `gridApi` when a layout must be applied to every replacement grid. Persist state before releasing the grid; pending data writes retain their existing settlement behavior.

The Web fixture in `docs/audits/2026-09-08-grid-lifecycle/browser-fixture` mounts the real product editor under StrictMode. Load Shared product, Shopify or Etsy; choose Required; use **Fail next sheet read**, **More → Reload**, then **Try again**. Verify the correct channel name, restored column membership, working keyboard editing, and empty browser diagnostics. Repeat at desktop and narrow widths in light and dark themes. Factory mirrors the lifecycle hook; the AG product editor fixture remains Web-only.

### Shopify file previews — 2026-09-08

`MediaCard` accepts a nullable `src` and a `placeholder` for documents, videos without posters, and processing files. It renders no image request for an absent preview; an actual image load failure remains a separate state. The media specimen includes a document card.

### Anchored Information editors

The MediaGallery specimen demonstrates `Modal.anchor` and `MediaGallery.positionControls`. Move a tile with Space, arrows, Space; Escape cancels without emitting a change. The explicit position selector uses one-based labels. Omit `onRemove` for workflows that only reorder existing associations.

- OrderedList omits unavailable reorder controls for a single item; multi-item keyboard and pointer ordering is unchanged.

- MediaGallery `compact` keeps a larger featured first tile, contain-fit previews and keyboard move handles; contextual menus expose earlier/later/first and exact position actions.

## Mixed product media — 2026-09-10

`MediaPreview` supplies image, native video/audio, external-video and unknown-file presentation. Native playback is explicit; video supports alternative sources, posters, language-labelled WebVTT tracks and a transcript disclosure. Failed previews and caption loads announce a useful fallback. File links reject executable protocols; existing image-only data URL previews remain supported.

`MediaStrip` is non-interactive grid content with poster thumbnails, type icons, missing-preview handling and a full media count. The grid owns the edit action. `MediaGalleryItem.mediaType` and `placeholder` carry these same distinctions through the keyboard-reorderable gallery. These components preserve normal Nexus control sizes and are mirrored in Factory.

Use `MediaPreview` inside the shared Modal for focus trapping and return focus. Give videos a meaningful `label`, provide caption tracks with a language and descriptive label, and pass translated transcripts as plain text. Captions need a publicly readable WebVTT endpoint with the appropriate cross-origin access. Unknown types keep an original-file link; an unsupported codec must never be reported as playable. A host persists metadata by destination and locale and decides which channel operations are supported.

Media cell interaction: `#media-gallery-example` composes `MediaStrip` with `CellAction`. Grid hosts keep one tab stop per cell, supply Enter/F2, and pass `onFocusCell` to retain grid navigation after thumbnail clicks/drags. `CellAction` intercepts mousedown in capture phase before the native grid selection listener. An interactive strip only reorders within itself; the host owns cross-row transfers. Portal tooltips remain hoverable across their 8px gap, dismiss with Escape, avoid opening during drag, wrap long labels, and use the 700 foreground role for secondary text (AAA text contrast on the invariant white bubble). Verify light/dark and 320px/390px widths.

### Scrolling Tabs

`ScrollingTabsExample` demonstrates `Tabs overflow="scroll"` in a 320px host. Arrow keys, Home and End select and reveal each section; a touch gesture scrolls labels without widening the document. Products → Categories uses the same mode.

`RecordListInput` accepts `fields` (key, label, kind, required, options), an array of records, and `onChange`. Use for material/percentage composition or other paired facts; keep validation in the data contract. In the Information fixture, Tab through a composition, add/remove records and verify focus/announcements, explicit 0/false, empty lists, 200% zoom and narrow light/dark layouts. Unknown properties are retained by edits.

VP.F: `SummaryTable` is a compact read-only comparison for cards/drawers (`label`, `columns`, keyed `rows.cells`). Rows are 24px; semantic table headers associate each value. Interactive datasets use NexusGrid. `OrderedList keyboardGrip` offers pointer drag and ArrowUp/ArrowDown on a labelled focusable grip, with live position announcements; the default retains arrow buttons. Sheet toolbars stay on the 40px band with a flexible search slot.

### VP.F shared sheet controls — 2026-09-11

`SummaryTable` renders compact read-only axis comparisons with semantic typography in both themes. `OrderedList keyboardGrip compact` exposes ArrowUp/ArrowDown on each 28px drag handle without a separate pair of arrow buttons. `BulkActionBar` uses a quiet sm Button for Clear selection. These patterns are shared by the Information and Variants surfaces.

`useGridHostTop` keeps the host budget current when a band mounts above an already-rendered grid. Verify the footer stays 8px above the viewport edge before and after loading.

`FilterChip compactLabel` uses a shorter visible label below 900px of available sheet-toolbar width. The full accessible name and count remain unchanged. Both variants are demonstrated by the Variants mapping toolbar.

2026-09-12: `usePointerReorder` shares captured pointer dragging across vertical OrderedList grips and horizontal AxisChip groups; keyboard reordering stays available through OrderedList.

2026-09-12 VP.F: FilterChip compact/full labels preserve the shared horizontal icon-and-text alignment, including SVG block defaults.
Account names (2026-09-08): `accountDisplayName` / `channelDisplayName` are exported from `design-system/lib`. Verify the switcher and AccountsPanel with real names, legacy `sellerId` placeholders, numeric profile IDs, and missing marketplace names. No technical keys should appear as text, tooltips, dialog copy, or accessible labels. Names can be supplied with Rename; IDs remain internal routing keys.

Amazon Seller migration (2026-09-08): verify an ENV-managed Amazon row, its primary **Replace environment credentials** action, the application-role permission copy, and the preserved ENV fallback note. Exercise both website authorization and private-app self-authorization import. Repeat after conversion to confirm the row reads as connected and no longer offers ENV replacement. Check narrow and desktop layouts in light and dark themes.

Monospace token parity (2026-09-12): grid formula/editor specimens use `--nds-font-mono` in both apps, with a fallback for hosts without a custom mono font.
