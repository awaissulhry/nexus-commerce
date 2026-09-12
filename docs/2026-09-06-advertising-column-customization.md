# Shared column customization — 2026-09-06

The newer modal used on `/products/next` and the product editor is now the documented Nexus column customization pattern and is enabled throughout advertising. It was already present in the uncommitted web `PreferencesModal`; the advertising configuration, persistence bridges, catalog, and Factory copy were behind.

## Changes

- Advertising WorkspaceGrid and DataGrid, Campaigns, and reporting section controls use the grouped registry and In view panels, group operations, bulk selection, and keyboard reorder controls.
- The older `ColumnCustomizer` implementation now delegates to `PreferencesModal`, so its existing import is compatible without maintaining another dialog.
- Advertising saves column order, hidden-column positions, group order and assignments, and locks alongside the existing preference fields. Existing storage keys, widths, and older saved layouts remain supported.
- Operator locks now become actual AG Grid pins. Campaigns maps its logical Bid Algorithm item onto the four physical grid columns. Reset restores the default right pins.
- The modal flattens its displayed grouped order before confirmation and saved-view callbacks, so hosts apply the order the user sees. Named-view actions are available where the host supplies a saved-view implementation.
- Modal source, logic, compatibility adapter, and styles are mirrored to Factory. The Nexus catalog, READMEs, changelog, and gap log document the shared pattern.

No product-page feature implementation was replaced. No live advertising data was edited. All changes remain local and uncommitted.

## Validation

- Full web suite: **236 files / 3,346 tests passed**.
- Focused modal logic, advertising persistence and column-model checks: **12 files / 141 tests passed**, including eight new regression cases.
- Web and Factory TypeScript checks passed.
- Production web build passed using an isolated output directory. The initial sandboxed compiler stalled; retrying outside the sandbox completed successfully.
- Web and Factory token freshness, web token guard, raw-control baseline, AG module coverage, grid option identity, retired-grid baseline, and generated web DS declarations passed.
- Browser comparison with the product modal confirmed the same shared component and grouped interface on Campaigns.
- DataGrid fixture: moved Figures before Identity, pinned Spend, hid Market, saved and reloaded. Group order, visibility, and the actual grid pin survived. Cancel discarded an additional edit.
- WorkspaceGrid fixture: searched columns, pinned Spend, showed CPC, saved and reloaded. Both changes survived. Reset removed the temporary changes and restored Daily Budget and Actions on the right.
- At a 680px viewport, the modal was 640px wide, panels stacked, controls remained reachable, and the document had no horizontal overflow. The viewport override was reset and temporary fixture changes were reset.

The repository-wide AG import boundary still reports the seven product/sheet files listed in [the migration validation](2026-09-06-ads-ag-grid-completion.md). The fork guard also reports unrelated `components/index.ts` drift while other local work continues. The modal files and their CSS rules match between web and Factory.
