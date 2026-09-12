# Product grid source indicators — 2026-09-06

The channel grid now distinguishes Master inheritance from listing overrides,
channel defaults, mapping expressions, linked fields and missing mappings. A chain
means “Follows Master”; a pin means “Listing override”. A persistent legend and
hover/focus explanations use the same shared SourceIndicator component.

## Resolution contract

1. Resolve the product’s Master data, including parent/variant and content-language rules.
2. Apply the channel/market mapping. Declared semantic matches may provide default
   Master mappings. A saved mapping takes precedence over those automatic matches.
3. An explicit override on the exact SKU, channel, market, account and listing alias
   takes precedence. Clearing a value and removing an override are distinct actions;
   blank, false and zero overrides must not silently resume inheritance.
4. Removing an override resumes the configured mapping/default. With no configured
   source the result can be empty. Resetting a projected list position removes the
   whole list override only after the existing confirmation.

Classification/category defaults, expressions, shared field links and channel-owned
metadata have their own source semantics. There is no automatic parent-listing to
child-listing override cascade. “Every Amazon/eBay attribute follows Master” is only
correct for attributes with a declared Master source/mapping.

## Implementation

The sheet API retains sourcePath, fallbackPath, usesExpression and legacySource
from the existing resolver. No mapping is executed in the browser. An older server
that omits these details receives a conservative “Mapping rule” label.

SourceIndicator composes Nexus Button and portal Tooltip, with a 24px target,
semantic text/focus colors, accessible explanations and labelled legend mode. Its
component, styles, export and usage documentation are mirrored in Factory. A source
that cannot perform a supported action is focusable information instead of a disabled
button. Formula/draft indicators do not offer pin/reset actions.

Browser testing caught native AG keyboard handling opening a value editor when Enter
was pressed on a source button. Capture-phase handling now keeps Enter/Space with the
source action. Informational sources cannot start an editor with those keys.

## Verification

- 2,157 web tests across 141 grid/product-edit suites passed after the keyboard fix.
- 26 focused API tests passed (Master defaults, batched resolution and sheet axes).
- Final web, API and Factory type checks passed. Concurrent edits temporarily exposed a
  WorkspaceSubheader/Menu contract mismatch; the updated Menu resolved it. Two
  small validation fixes restore a missing Factory motion-token import and remove
  an unused StudioBar icon import after its icons moved to the shared navigation.
  The final web and Factory checks passed after those fixes.
- An isolated production build passed before the final informational-key guard and
  confirmation wording adjustments. Final regression tests cover those adjustments.
- Web token guard passed. Factory’s existing token guard reports 332 violations;
  they concern existing styles outside the added SourceIndicator block.
- Live Amazon and eBay IT browser inspection confirmed Master title/brand sources,
  category defaults, explicit empty overrides and empty mapped Master values.
- Hover/focus tooltip, Escape dismissal, visible focus, Enter pin and Space reset
  were checked in the browser. The temporary Amazon IT parent Brand override was
  removed; its original value, source, layer, pin state and mapping metadata match
  the saved pre-test response.
- Source text/icon contrast measured 15.48:1 in light and 12.73:1 in dark. The labelled
  example wraps within a 320px container without overflowing in the dark catalog.
- The live Amazon response contained 3,381 mapped/unmapped field results across 21
  rows, all carrying the new source metadata.

The live comparison also observed a separate child productType changing from a category
default to an explicit OUTERWEAR override, with the displayed value unchanged. The
browser test targeted only the parent Brand cell; the separate change was preserved.

This update does not clear the previously recorded connection, missing requirements,
product-data, formula identity or cross-store concurrency limitations in
2026-09-06-master-first-implementation.md. It is not a whole-application accessibility
certification or a claim that every marketplace is ready to publish.
