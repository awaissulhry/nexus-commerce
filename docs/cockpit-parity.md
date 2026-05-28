# Listing Cockpit Parity (Amazon ↔ eBay)

Reference for the per-channel listing cockpits on `/products/[id]/edit`
(tabs `AMAZON` / `EBAY`). Documents what each cockpit provides, where
they deliberately differ, the shared substrate, and the guards that keep
them from regressing. Companion to [edit-ux.md](./edit-ux.md).

> Hard constraint (unchanged): `/products/amazon-flat-file` and
> `/products/ebay-flat-file` (pages **and** routes) are off-limits. The
> cockpits reuse their *services* (e.g. the flat-file template endpoint)
> but never edit those surfaces.

## Shared substrate

Both cockpits compose the same primitives under
`app/products/[id]/edit/_shared/`:

- **cockpit-shell** — 4-zone layout (sticky header / collapsible preview
  band / card grid / all-fields drawer), `CockpitHeader`,
  `CockpitPreviewBand`, `CockpitCardGrid`, `CockpitDrawer`, the
  provenance `FieldSourceBadge` + `FieldScopePopover`, and the
  Field-Linking hook `useFieldLinks` / `useVariantCube`.
- **market-switch** — URL-first market chip strip (`?market=`), stable
  chip ordering, dirty-flush guard. Both cockpits drop the legacy
  `MarketplaceSidebar` (one chip strip, no second rail).
- **cockpit-health**, **cockpit-preview**, **telemetry**, **announce**,
  **draft-bus** — health panel scaffold, mobile/desktop preview toggle,
  event telemetry, ARIA live region, real-time draft updates.

## Card matrix

| Surface | Amazon | eBay |
|---|---|---|
| Identifiers / Shared fields | ✅ | ✅ |
| Category & aspects | CategoryCard (+ schema grid) | CategoryCard + AspectsCard |
| Variations | VariantCube (axis / by-variant / by-market) | VariationsMatrixCard |
| Images | ImagesSummaryCard | ImagesCard |
| Pricing & offers | PricingCard (Buy Box, repricing, S&S, business) | PricingPoliciesCard |
| Fulfilment | FulfillmentCard (FBA/FBM, mixed-fulfilment warn) | n/a (eBay = merchant) |
| Compliance | ComplianceCard (country/GPSR/battery/hazmat) | folded into aspects |
| Fit / Compatibility | adaptive FitCompatibilityCard | CompatibilityCard (Motors) |
| Suppression / quality | SuppressionCard | HealthScoreRail checks |
| Auto-fill | AutoFillCard (master / AI / sibling) | FieldSource per-field switcher |
| Publish | PublishCard (multi-market) | PublishDrawer |
| Health | severity panel (Blockers/Required/…) | **section rail** (richer; kept) |

No `PlaceholderCard` ("Soon") remains on either cockpit.

## Deliberate differences (not gaps)

- **Health UI.** Amazon uses a severity-grouped panel; eBay keeps its
  richer section rail (Content / Images / Category & Aspects / Pricing &
  Policies / Category gates) with a publish-gate. Unifying would dilute
  eBay's model — kept distinct on purpose.
- **Fit dimension.** `FitCompatibilityCard` is adaptive: apparel/gear
  (OUTERWEAR, GLOVES, HELMET…) → Size & Fit; parts or anything carrying
  vehicle-fitment attributes → Vehicle Compatibility. eBay has a
  dedicated Motors `CompatibilityCard`.
- **Fulfilment** is Amazon-only (FBA/FBM); eBay is merchant-fulfilled.

## Field Linking (FL) + propagation

`useFieldLinks` + `FieldLinkGroup` model the cross-market/channel link
state; precedence is **pinned > linked > master > default**
(`field-resolution/resolveFieldValue`, unit-tested).

**Resolution is *not* wired into the live read path on purpose.** A live
override would silently replace stored per-market values in the display,
bypassing the **diff-then-apply** safety the product owner endorsed.
Instead, linking is metadata + a propagation *planner*: the operator
previews the diff (`propagate-preview`, AI-translated + budget-capped)
and applies via the editor's own listing/price writes.

FL scope changes are **audited**: `PUT /field-links/:fieldKey` writes
`field_link.linked|updated|unlinked|independent` to the Audit Log
(`entityType=field_link`, `entityId=productId:fieldKey`) with before/
after members + affected `channel:marketplace` coordinates. No-op clears
aren't logged; writes are fail-open.

## Tier 3 — per-variant linking + cross-channel matrix

- **T3.1 — CHILD link groups.** `FieldLinkGroup` carries a nullable
  `variantId`; identity is `(productId, fieldKey, variantId)`. A field can
  hold one PARENT (product-level) group plus many CHILD groups (one per
  variant) that pin a single variant's value across coordinates, fully
  independent of each other. `PUT/GET /field-links` key by the triple; a
  variant coordinate forces CHILD parentage; audit entityId is suffixed
  with the variant. `useFieldLinks` is variant-aware (`scopeFor` /
  `memberKeysFor` / `setScope` take an optional `variantId`), backward-
  compatible — no variantId still means PARENT.
- **T3.2 — per-variant price linking.** The cube's by-market view shows a
  price-link button per variant row (price field only — quantity is
  per-market) that opens the shared `FieldScopePopover` and links that
  variant's `our_price` across markets via a CHILD group.
- **T3.3a — cross-channel matrix (read-only).** `GET /products/:id/listings`
  returns every channel × market with effective title/price/status; the
  `CrossChannelMatrix` drawer (opened from the Amazon cockpit's
  "Cross-channel" header button) shows them side by side. A *lens* over
  the separate tabs, never a merge.
- **T3.3b — cross-channel propagation (diff-then-apply).** From the matrix,
  pick a field (title/description/price/brand) + a source coordinate →
  `POST /cross-channel/propagate-preview` (group-less, explicit targets) →
  in-drawer diff → Apply (`applyPropagation` fans out to the existing
  `/channel-pricing` + listings PUT endpoints). Guardrails, because
  operators can't read the target languages:
  - **Currency (B2):** price targets in a different currency than the
    source are flagged `currencyMismatch` + skipped (no raw €→£ copy).
  - **Glossary + review (B3):** `TerminologyPreference` (brand-scoped +
    global, per language) is injected into the translate prompt; machine-
    translated entries are flagged `needsReview` and can be **back-
    translated to English on demand** (`POST /cross-channel/back-translate`)
    to verify meaning.
  - **`sourceLanguage`** is defaulted from the source market so cross-
    language targets plan as `translate` (a German listing is never handed
    Italian text verbatim).
  - **Apply audit + partial-failure (B5):** per-coordinate ✓/⚠ results,
    "Retry failed", and one `cross_channel_propagation` Audit Log row per
    apply (`POST /cross-channel/applied`).
  - **Pending publish (B6):** applied changes update the ChannelListing
    but don't republish — the matrix flags "N updated — publish to push
    live."
  > **Prod note:** the translate + back-translate paths need an AI
  > provider (`GEMINI_API_KEY`/`ANTHROPIC_API_KEY`) on the API. With AI
  > off they degrade safely — cross-language text gets a null proposal and
  > is skipped on Apply; price + same-language propagation work unaided.

## eBay variations (EV-series)

The eBay Variations Matrix (`VariationsMatrixCard`, `/ebay/cockpit/
variation-cells` + `variation-matrix`) and its publish/export paths:

- **EV.1 — data source.** Axis values come from
  `categoryAttributes.variations` ({Size, Color}); declared axes from
  `variationTheme`, else the children's variation keys. (EC.6 read the
  empty `variantAttributes`/`variationAxes`, so the matrix was blank.)
- **EV.3 — up to 5 specifics.** Picker selects ≤5 axes (eBay's limit),
  stored eBay-only on the parent listing's `_variationAxes`. ≤2 → the
  Size×Color grid; 3–5 → a flat one-row-per-variant table.
- **EV.4 — eBay-only rename.** `_axisNameLabels` (Color→Colour) +
  `_axisValueLabels` (Giallo→Yellow) on the parent listing; applied to
  the grid/flat-table/sort-editor display and to publish. Never mutates
  the canonical `categoryAttributes.variations`.
- **EV.5 — flat-file family load.** `/ebay/flat-file/rows?familyId` now
  loads parent **+** variant children (`OR id/parentId`) so the bulk
  editor shows the variations; price/qty come from the eBay
  `ChannelListing` rows the matrix writes (shared data, no other flat-file
  change). *Approved exception to the untouchable flat-file.*
- **EV.6a — File Exchange CSV.** `GET /ebay/cockpit/file-exchange-csv`
  emits a parent row + `Relationship=Variation` child rows (Relationship
  details + per-axis columns), rendered through the renames. Net-new.
- **EV.6b — Inventory API publish renames.** The flat-file `/push`
  variation publish applies the renames to the per-item aspects, the
  `inventory_item_group` `variesBy.specifications`, and
  `aspectsImageVariesBy` — consistently. Identity when no renames are set
  (so a no-rename publish is unchanged). *Approved flat-file edit;
  code-verified — a real eBay publish isn't exercised in tests.*
- **EV.7 — validation.** Advisory counts in the matrix (missing price /
  quantity / axis value, ≤250 cap). eBay still rejects at publish.

> Image varies by one specific (the first axis), per eBay's
> `aspectsImageVariesBy` — ties into the IM.5/EC.7 colour image sets.

## i18n

UI chrome is keyed under `products.edit.cockpit.{amazon,ebay}.*` in the
flat `messages/{en,it}.json` catalogs. Covered: the eBay core cards
(Listing Essentials, Aspects, Pricing & Policies, Images, Compatibility,
Variations Matrix, Health rail) and the Amazon Variant Cube + the new
Fulfilment / Compliance / Fit cards. Dynamic data (aspect/policy names,
vehicle/variation values) stays dynamic.

Catalog correctness is enforced by the **pre-push i18n hook** (en/it key
parity + every literal & dynamic `t()` ref resolves), not by e2e.

> The locale shim hydrates from `localStorage['nexus:locale']` per
> component on mount — it does not switch reliably under headless
> Chromium, so e2e asserts the English fallback. See
> `reference_i18n_verification` in auto-memory.

## Real-time (SSE)

All SSE handlers (`/api/{orders,listings,fulfillment×3,bulk-operations,
dashboard,sync-logs}/events`) write headers on `reply.raw`, bypassing
`@fastify/cors`. They emit validated CORS headers via the shared
`lib/sse.ts#sseResponseHeaders` against the single origin allow-list in
`lib/cors-origins.ts` (also used by the cors registration). Without this,
cross-origin `EventSource` (Vercel → Railway) is blocked and every
real-time feature dies on prod.

## Regression harness

`apps/web/tests/cockpit-regression.spec.ts` (Playwright) guards the
above against the live deploy — the editor is currently open (no auth),
so it drives the cockpit for real:

```bash
PLAYWRIGHT_BASE_URL=https://nexus-commerce-three.vercel.app \
  npx playwright test cockpit-regression
# override the target product with PLAYWRIGHT_PRODUCT_ID=<id>
```

Asserts: real cards / no "Soon" placeholders, the Variant Cube's three
views, **zero SSE/CORS console errors**, and eBay's health rail. Not run
in the pre-push hook (e2e against a deploy is too slow/flaky there) — run
manually or wire into `.github/workflows/ci.yml` against a preview URL.
