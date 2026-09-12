# Channel sheet hover and interaction quality

Implemented and verified against the actual local Product Edit Studio on 2026-09-10. No fixture server or deployment was used.

## Changes

- Removed the common ChannelSheet's per-field AG tooltip getters. Pointer movement no longer composes and validates a cell explanation.
- Added `TooltipPortalProvider disabled` in the design system and applied it around the channel grid. Nested source, edit and media controls render without tooltip wrappers or portal interaction state. Header help and toolbar hints retain their existing behavior.
- Source icons open Cell details. Full values, source information, validation, mapping errors/warnings, limits and write restrictions are available on demand. The context menu and toolbar More menu open the same dialog.
- Pin/reset are explicitly labelled actions inside the dialog. Inspecting a source no longer immediately changes a listing override. Existing writer gates and whole-list review are retained.
- Removed competing native mapping-error and measurement-unit titles while preserving their accessible text. Feature CSS only lays out/wraps the dialog's content.
- Mirrored the provider and tests in Factory and documented the pattern in both catalogs/changelogs. Factory has no channel grid or TokenCatalog component to mirror.

## Browser evidence

Real route: `http://localhost:3000/products/cmokmy3a40078pm0p1fvnu523/edit/studio?market=GLOBAL&locale=en&scope=SHOPIFY`.

| Scope | Mounted cells | Shared tooltip wrappers after change |
| --- | ---: | ---: |
| Shopify · GLOBAL | 210 | 0 (336 before) |
| Amazon · BE | 126 | 0 |
| eBay · DE | 210 | 0 |

Verified source inspection, context-menu details, toolbar-menu details, Shopify editor open/cancel, eBay select → F2 → Escape and ArrowDown navigation, filtering with the parent band retained, and light/dark presentation. The details dialog fits at 390 × 844 without horizontal content overflow. Closing details restores the selected cell. Final source-icon open/close verification retained the same eBay title and override state with zero refused cells.

During early keyboard QA, the old direct source action changed the eBay parent title's source and exposed a refused write. The starting title (`tets`) and listing-override state were restored through the editor and verified saved before final checks. This led to moving source mutations behind labelled dialog actions. No channel publish/synchronize action was used.

The performance evidence is structural: 336 tooltip wrappers and their portal interaction components were removed from the measured Shopify view, and whole-cell tooltip getters are absent. These checks do not establish a production latency benchmark or certify all channel integrations.

Screenshots: [desktop dark](desktop-dark.png), [desktop light](desktop-light.png), [mobile dark](mobile-dark.png), [mobile light](mobile-light.png).

## Checks

- Web focused suites: 231 passed; 13 optional live-API tests skipped because their local API was unavailable on the final run. The skipped suite only performs reads.
- Factory tooltip suites: 13 passed, including the four new suppression regressions.
- Web and Factory full type checks passed.
- Web and Factory token generation checks passed.
- DS conformance, raw-primitives ratchet, AG import boundary, grid modules, CSS parsing and token resolution passed. Targeted whitespace checks passed.
- Shared tooltip source/test parity passed. The repository fork guard remains red for the pre-existing three-blank-line difference in `components/index.ts`. No guard baseline was changed.

Commands: `npm test --workspace=@nexus/web -- tooltipSuppression tooltipInteraction SourceIndicator cellTooltip shapeFormat sheet/channel`; `npm test --workspace=@nexus/factory -- tooltipSuppression tooltipInteraction`; each workspace's `npm run typecheck`; root `tokens:check` and `tokens:check:factory` scripts.
