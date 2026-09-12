# Formula editor UI refinement — 2026-09-07

Addresses the screenshots showing oversized buttons, a displaced formula/caret, repeated instructions and overlapping text-building/suggestion controls. Work remains uncommitted and unpushed.

## Changes

- Formula inputs and actions use the standard Nexus `sm` size: 28px controls and 12.5px type. Readability preserves their geometry. Cell and form formula inputs both use the same monospace face.
- The syntax overlay measures the already styled input, copies its exact bounds, centers the text and observes resizing. The native field owns the focus ring; the clipped inner-input outline is removed. Ligatures are disabled so typed operators such as `===` remain visibly unchanged.
- One short helper sentence replaces the repeated paragraphs. Insert field, Add text and Help share a compact toolbar. Help contains the same-row/linked behavior, text example and keyboard instructions. Add text and Help hide suggestions while open.
- A scrolling body keeps sections in flow without flex shrinking them into one another. The grid action footer remains visible. Result/error messages use ordinary UI type; the formula itself uses monospace.
- Suggestions display the field name once, with the current value at the end. Technical names remain searchable and available in tooltips through shared `ListboxOption.searchText` and `trailing` props.
- The shared Listbox scroll calculation now uses coordinates relative to the panel instead of an unrelated positioned ancestor. The first heading is retained and keyboard-selected rows remain visible.

Shared Listbox source/styles and the readable input-focus correction are mirrored in Factory. Both catalogs and changelogs document the APIs; DS-GAPS records the measured defects. Formula grid adapters remain Web-only.

## Verification

- Actual product Studio: Shared Name and Amazon Title, including the long Battery Cell Composition Other Than Listed suggestion, arrow-key navigation, Tab insertion of its technical reference, Add text, Escape and Cancel. Product values were previewed and cancelled.
- Catalog: light and dark grid editors; formula save/reopen/cancel on synthetic rows; 320px shared form, Help and Add text. The narrow form's client width and scroll width both measured 320px. Sample rows were reset afterward.
- Formula overlay and native input measured identical position, width, height and font. All final editor action buttons measured 28px high. Text helper and suggestions occupy separate states; body sections have non-overlapping bounds.
- Full Web suite: 252 suites, 3,442 tests passed; focused formula suites: 139 tests passed. Web and Factory TypeScript, both generated-token checks, Web token guard, raw-primitive ratchet, DS-GAPS append-only and whitespace checks passed.
- Existing unrelated guard findings remain: SourceIndicator export ordering in the DS fork guard and 32 selectors in the legacy grid-lab CSS shadow ratchet.

These are specific visual, keyboard and responsive checks, not a claim of universal WCAG AAA certification. Control density follows `DESIGN.md`; quality does not enlarge the platform's existing controls.


Repository guard follow-up (2026-09-08): the previously reported fork/token failures are resolved in the current workspace. The legacy grid-lab selector/radius failures and additional grid import, callback identity and retiring-grid findings are now fixed. See [the guard cleanup report](2026-09-08-repository-grid-guards.md) for the current results and verification scope.
