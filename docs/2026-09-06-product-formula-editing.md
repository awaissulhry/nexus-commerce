# Product formula editing — 2026-09-06

Formula authoring now follows the ordinary field writer’s availability instead of the previous price-only restriction. Writable text fields, including Brand and Manufacturer, can use formulas; field options, scope restrictions, and the ordinary write validation remain in force.

The shared web grid editor accepts `=` directly, after double-clicking a text/number/long-text cell, or through a structured control. It shows suggestions immediately, completes functions with Tab, inserts a reference when another field in the same row is clicked, and previews the result. `&` joins text without numerically adding numeric-looking strings. Enter/Apply checks a formula and leaves an invalid draft open; Escape/Cancel cancels. Explicitly applying plain text over a stored formula removes its rule, including when the text equals the previous result.

Copy and fill carry the expression, evaluated separately for each target row. References are named fields in the current product row, not arbitrary Excel A1 references. Existing primary-listing/primary-account restrictions still apply to channel formulas.

The preview and save service now build columns for the actual scope and listing category, include inherited global master values, and use the channel resolver’s effective values. This fixes a measured discrepancy where a visible eBay Brand override read as empty in the formula. Formula batch reads filter by content locale; authoring market remains evaluation context rather than a separate cell identity.

## Verification

- Full web suite: 247 suites / 3,423 tests passed. After the final editor refinements, its 23 focused suites / 305 tests passed again.
- Formula API coverage: 12 suites / 111 tests passed, covering field saves, option validation, refusal handling, recalculation, source projection, locale filtering, and expression syntax.
- Web, API, and Factory TypeScript checks passed.
- Web and Factory generated tokens are current. Web token guard passed. Factory token guard reports 320 existing violations in untouched CSS/control files; no Factory token/control stylesheet was changed by this task.
- Browser: real eBay title double-click → `=` guidance → click Brand → `=$brand & " Jacket"` produced `Xavia Racing Jacket`. Master Manufacturer also opened formula mode after double-click and previewed a text constant. These product checks were cancelled rather than saved.
- Interactive catalog sample: Enter save, stored-expression reopen, Tab/function help, click-reference insertion, invalid-expression correction, Escape, copy/paste, drag-fill, and literal replacement exercised using only in-memory sample rows. Copying/filling `$brand` produced Xavia, Nexus, and Atlas for their respective rows.
- Light/dark and 760px viewport checked visually. The editor inherited the grid theme and remained inside the viewport. Shared ListboxPanel ID changes were mirrored in Factory. Grid adapters remain web-only, as documented in both design-system catalogs.

No commit or push was made. Existing workspace edits were preserved.
