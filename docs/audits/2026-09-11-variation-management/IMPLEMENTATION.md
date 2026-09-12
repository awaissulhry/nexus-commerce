# Variants & relationships workspace

Implemented on the new product editor at `?tab=variants`, immediately below Information in product navigation and available under each connected channel.

## Shipped behavior

- Shared family: declared axes and effective values, parent/child relationships, existing guarded family actions, and missing/duplicate axis-value diagnostics. Axes appear before other variant fields. The axis editor adds dictionary attributes, removes declarations without deleting values, and reorders axes with drag or keyboard buttons. Localized saved names remain visible; canonical synonyms cannot be added twice.
- Channel values: the existing Information grid, resolver, category schema, cell writers, reset/inheritance behavior, formulas, import/export, recovery and validation are reused. This workspace shows declared axes, variant-level fields, relationship setup and category controls. Information remains the complete attribute view. The two workspaces have separate layout and saved-view identities.
- Listing aliases: primary and additional aliases use the existing account/market/listing selection and alias-by-variant rows. Alias labels are editable in a scoped dialog. Existing creation and information-check actions are exposed. Creating an alias from a focused listing returns to all aliases so the new draft is visible. Alias creation prevents a destination switch while the request is pending.
- Shopify: Linked products opens the existing linked-family editor inside the workspace, preserving separate products, native variants, field selection and draft/synchronization controls.
- eBay: Variation order opens the existing destination-aware ordering editor inside the workspace. Values and ordering keep their respective save contracts.
- Explicit-save editors guard local view and destination changes. Failed axis/label writes share a stable save subject with retries; discarding their drafts clears that subject. Cell saves must finish, and refusals must be resolved, before switching local views.

## Consistency fixes

The shared axes endpoint reads the actual parent from a child. Writes use the root version and reviewed child IDs in a serializable transaction. Changed membership or a stale version is refused. A successful change advances the root version, records a product event, and refreshes the family cache atomically. It preserves child values and listing aliases. Unchanged saves are a no-op.

Family reads exclude deleted products. Children use the parent's axis declaration. Axis identity and coverage use the effective sheet cells, including channel mapping and explicit clearing, rather than stale legacy values. Removing an axis stops it participating in family identity without deleting its saved attribute value.

Category column construction recognizes canonical axis names across localized declarations such as Colore/Color and Taglia/Size. An explicitly declared axis stays per-variant even when a dictionary default says global. This fixes Amazon Color/Size disappearing from the focused workspace. Category-specific options, requirements and validation still come from the existing channel schema.

## Design system and browser verification

All new controls compose Nexus Button, Select, Input, Field, Menu, Modal, OrderedList, Tabs and Banner. Feature CSS uses semantic Nexus tokens and controls layout only. No shared design-system source changed, so no Factory mirror was needed.

Verified in the running local new editor with GALE-JACKET:

- Navigation placement directly after Information.
- Shared family, Amazon DE, eBay DE, Shopify GLOBAL and Etsy GLOBAL load in the workspace.
- Amazon includes Colour, Size, shared relationship fields, Amazon listing role, parent SKU, relationship type, variation theme and product type. Existing missing/invalid-value feedback remains visible.
- eBay ordering and Shopify linked-product tools load under the selected destination. Keyboard ArrowRight activates the eBay ordering tab and its explicit-save label.
- Shared axis dialog shows localized saved labels and excludes duplicate canonical choices. Enter reorders an axis; undoing the reorder returns to the original draft; Cancel restores focus to Manage axes. No product save was made during this browser check.
- Light and dark presentation checked, including the axis dialog at 390 × 844. The narrow worksheet initially had zero height because its wrapped toolbar filled the viewport. The workspace now scrolls vertically, and uses GridSheet's public embedded-height contract. Measured grid height after the fix: 285 px; page width: 390 px, with no document horizontal overflow. The focusable workspace scroll region reaches the grid with End/PageDown. Grid columns retain their own horizontal scrolling.
- Browser viewport and theme restored after verification.

## Automated verification

- Web: variants, scope navigation, family semantics, exact channel/alias writes and navigation URLs — 89 tests passing.
- API: attribute foundation and studio axis projection — 30 tests passing.
- API: new shared-axis transaction suite — 7 tests passing against disposable PostgreSQL; existing relationship suite — 35 tests passing.
- Scoped TypeScript checks cover StudioClient, both changed route modules and their transitive imports.
- Nexus token guard and design-system conformance ratchet pass. New feature CSS token references were checked against emitted tokens.

The broader legacy `pim-sheet-columns.test.ts` suite has one unrelated expectation mismatch: line 295 expects Name storage `column`; the current localization implementation returns `localizedContent`. Its other 43 tests pass. The variation changes do not alter the Name storage calculation, and that older expectation was left untouched.

## Boundaries

This delivers the workspace and shared-axis management, reusing the existing channel capabilities. It does not implement the entire publishing architecture proposed in the preceding audit. Amazon's older wizard defects and Etsy's full inventory/three-axis publishing workflow remain separate work. Existing provider limitations, incomplete category setup and synchronization reviews stay explicit. Alias archiving is not exposed by the new dialog. No provider publication or live catalog data migration was performed.
