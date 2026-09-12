# Product Edit Studio (PES) — Approved Layout & Programme Control Tower

**Status:** Layout APPROVED by the Owner 2026-09-01 (this doc is the single source of truth for every PES session).
**Programme:** part of the full rebuild programme (2026-08-31) — Nexus DS + AG Grid Enterprise, everything
uncommitted until the Owner's word, 5–6 parallel sessions, shared working tree.
**Control tower session:** PES.0 (the session that produced this doc and the lane prompts).

---

## §1b LAYOUT v2 — Owner's amendment, 2026-09-01 evening (hub ruling #169; supersedes §1 where they conflict)

The Owner reviewed the built studio and rejected its proportions: the sheet was ~60% of the
screen under three rows of chrome and a docked 520px drawer, showed "barely a few columns", and
editing/sorting were "really complicated". **The grid-first principle stands; the chrome around it
does not.** Decided, with mockups, in the hub:

- **Full-bleed sheet.** ~90–95% of viewport height, full width. The drawer is NOT docked: it
  **slides over** from the right only when a row is opened, and closes back to the full sheet.
- **Collapsing chrome.** The product header (name · SKU · ASIN · status · autosave · Publish ▾)
  collapses to a ~32px strip as the **grid** scrolls (the grid scrolls internally — the bounded
  GridSheet host rule holds; chrome collapse is driven by the grid's scroll position, never page
  scroll). Scope chips and tabs merge into **one compact row** that stays.
- **The picture on the left = a thumbnail in the pinned identity cell**, exactly as /products/next
  does it. Not a persistent left image panel (rejected: costs ~260px of sheet width).
- ~~**Curated default view per scope** (~12–15 fields that matter: title, price, qty, brand, key
  attributes, readiness) with the other ~90 columns behind the DS Customize dialog and saved
  views. "You see the RIGHT few, not a squeezed hundred."~~ **REVERSED by the Owner 2026-09-04:
  the sheet lands on ALL attributes (import/export work on the whole record); the curated set
  survives as the "Essentials" preset one click away.** See
  `docs/2026-09-04-sheet-views-and-full-attributes-design.md`.
- **Editing, all of it:** channel-scope cells must become writable (attr_* channel routing, #58 —
  backend); the cell-editing gesture, sorting, column resize/reorder/freeze, and the
  dropdown/select editors are all to be redone with the AG Grid Enterprise specialist lane.
- **Zero DS inconsistencies** — spacing, layouts, buttons, dropdowns — is a stated acceptance bar,
  audited by a dedicated DS lane.

The full v2 spec is written by the UX.1 lane (terminal-visual, approved by the Owner through the
hub) before PES.1/PES.2/PES.4 change frame, sheet or drawer geometry. PES.2 may start the two
already-decided pieces immediately: curated default views, and the thumbnail identity cell.

## §1 The approved layout — "the grid IS the page" (v1, 2026-09-01 morning)

Route stays `/products/[id]/edit`. Rebuilt as fresh files beside the old client; the old
`ProductEditClient.tsx` is replaced only at swap time. Shell = the `/products/next` family
(`h10-shell` + `ProductsRail` + global `AppTopBar`).

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ ‹ Products  GALE Pro Racing Suit · GALE-KAN-PRO · ● Active    autosave ✓ 12:41  [Publish ▾]│
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ SCOPE [ Master 96% ][ Amazon ●92% ][ eBay ⚠71% ][ Shopify ○— ][ + ]     Market [ IT ▾ ]    │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ View [💰 Pricing ▾] [⚠ Missing required (7)]  Search  ⚲ col filters  [Bulk fill][Customise]│
├────────────────────────────────────────────────────────────────────────────────────────────┤
│                     THE SHEET (NexusGrid in GridSheet host, fills viewport)                │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ 9 rows · 2 selected · 1 warning · autosave ✓                                       ‹ 1 ›   │
└────────────────────────────────────────────────────────────────────────────────────────────┘
Tabs (thin, non-tabular surfaces only): Sheet (default) · Images · Analytics/Ads · Activity
```

**One grid component, one data spine.** Every scope is the SAME sheet re-projected. Master
values are the only stored truth; channel/alias/variant layers are sparse overrides resolved
at read time (pinned override → linked group → master → schema default — the order already in
the Prisma schema docs).

### Master scope
Rows = parent + child SKUs (tree, collapsible). Columns = every master attribute, scoped by
views. Children are full `Product` rows, so per-variant Title/Description/bullets are just
editable cells — NO migration needed. Cell provenance: `🔗` inherits master (tinted) ·
`✎` pinned per-variant · `⚠` validation (warns, never blocks). Locale dropdown swaps content
columns; a Localisation view shows locales side-by-side.

### Channel scope (e.g. eBay · IT) — alias groups
Rows = one collapsible group per **listing alias** (①②③…), each with the SAME child SKUs
underneath, sharing one stock pool (qty per-channel, never summed — see
reference_oversell_is_per_channel_not_summed). Columns = that channel's field family (from the
channel schema, same source as mapping + preflight). Override cascade visible per cell:
alias×variant `✎` → alias `✎` → master `🔗`. Hover names the source; one click pins, one
click resets. `[+ Add listing alias]` row at group end. Per-row publish status + readiness bar.

### Views
> 🟢 **SUPERSEDED 2026-09-04 (Owner):** the sheet LANDS ON EVERY ATTRIBUTE, on every scope and on every
> reload; the only narrowing that survives a reload is a saved view the operator marked as the
> default for that scope. Presets stay (Essentials = the #173 rule, Content / Specs / Logistics /
> Pricing / Identifiers / Localisation, "Everything else"); user views are attribute-key lists on
> `SavedView` (surface `product-edit:views:master` / `product-edit:views:<CHANNEL>`), built in the ONE
> Customise dialog (quick picks, group ticks, Save as view). Export carries D15.2's key row and an
> "all attributes" option; import is view-independent. Design + measurements:
> `docs/2026-09-04-sheet-views-and-full-attributes-design.md`. The paragraph below is history.

Named presets per scope (Content / Specs / Logistics / Pricing / Identifiers / Localisation /
Missing-required) + user-defined via the ONE DS `PreferencesModal`; persisted through
`useGridState` → server `SavedView` (surface `product-edit:<scope>`). ~~Default landing view is
NARROW (5–8 columns).~~ Rithum-style per-column floating filters.

### Readiness (Akeneo completeness × Salsify gating)
Scope chips carry per-channel×market readiness % computed against that channel's required-field
schema. Per-row completeness column per scope. "Missing required" is a first-class filtered
view — the guided-enrichment path, as a sheet.

### The full-record drawer (Airtable expanded-record, adopted)
`⤢` on a row/cell opens a docked right drawer WITHOUT leaving the sheet: the entire record as
a DS form (attribute groups, rich text editor, galleries), per-cell history (who/when/old→new/
which layer, from the override-audit table), compare/translate (vs master, another locale,
another alias, with copy-across), listing status + channel errors. Grid stays live behind it.

### Autosave & writes
Per-cell/per-field autosave, no page Save. Master/attr cells → `PATCH /api/products/bulk`
(`expectedVersion`, 409 = repaint + refetch). Channel price/qty → existing channel-pricing
route. Publish stays explicit per channel (preflight-first, dry-run default — see
project_master_sheet_gds4 MS.5 rules; eBay publish stays preview-only; publish mode from
`getAmazonPublishMode()`/`getEbayPublishMode()`, NEVER re-derived from env).

### AI enrichment (a layer, not a layout)
`✦ AI-drafted` is a provenance state: tinted until approved, applied through the SAME bulk
PATCH + audit trail, reviewed as a filtered view like missing-required. Draft → review diff →
apply. Never lands as confirmed fact without review.

### Mapping
Global mapping/formula engine lives at `/channels/mapping` (Rithum model). The sheet only
SHOWS its results as `🔗` derived values with mapped/unmapped/error status.

## §2 Decision log (Owner, 2026-09-01)
1. Grid-first detail page APPROVED over form-first — after industry validation (Akeneo,
   Salsify, Plytix, Pimcore, Rithum study incl. frames 1400–2350 of the 2026-08-12 recording).
2. Everything derives from ONE grid + one data spine; channel layers are sparse overrides.
3. Aliases: N listings per product per channel×market, collapsible groups sharing children.
4. Readiness chips + completeness column + missing-required view are IN the layout.
5. Full-record drawer replaces form tabs; tabs shrink to Sheet/Images/Analytics·Ads/Activity.
6. Locales/SEO fold into the sheet + drawer; mapping is global, not per-product.
7. Autosave per cell everywhere; Publish explicit. Dirty-registry/header-Save retired.
8. AI enrichment lane approved as provenance-based review flow.
9. GDS components are substrate to PERFECT along the way; /products/next is the chrome
   benchmark; every DS shortfall is fixed IN `design-system/grid/`, never page-locally.
10. **BUILD FROM SCRATCH (Owner, 2026-09-01, programme-wide):** "We are actually building
    everything from scratch. We must not make use of anything that already exists in the UI" —
    because the architecture changed and the UI will be different. Old trees (`tabs/**`,
    `components/ui/**`, cockpits, MatrixTab) are read as SPECIFICATION, never imported, copied,
    reskinned or wrapped. The DS (`design-system/**`) is the substrate, not "existing UI".
    Capabilities survive (inventoried per lane, re-derived, freshly tested); code does not.
    PES.7 §9 records the canonical interpretation — all lanes apply it.

## §3 Data-model notes for the backend lane
**CORRECTED 2026-09-01 by PES.0 on PES.3 + PES.5 prod evidence** (`docs/pes5-phase0-backend.md`
§0–§2 is now the authoritative design, superseding both this section's original text and PES.3's
earlier `aliasKey` sketch in the claims file):
- 🔴 **`VariantChannelListing` and `ProductVariation` are DEAD (0 rows each).** The per-variant
  channel layer is `ChannelListing` keyed by the CHILD `Product` id (912 of 977 rows). The alias
  change touches `ChannelListing` only.
- **Alias design = PES.5 §2:** slim `ProductListingAlias` table (label ①②③, position, status,
  `adoptedFromProductId`) + nullable `aliasId` FK on `ChannelListing`; both `@@unique`s widen
  keeping the Prisma `name:` verbatim (MAP.2b trick); NULLS NOT DISTINCT means zero backfill.
  ⚠ 16 upsert call sites sweep (reference_prisma_upsert_on_conflict), one of them `as any`-blind
  (flat-file-unified.routes.ts:631). Two-step index migration for rolling deploys; alias creation
  enabled only after PES.5-ii drops the old indexes.
- **22 `EBAY_LISTING_SHELL` phantom products in prod ARE today's alias workaround** — adoption
  backfill is a separate, dry-run-first, reversible approval.
- `followMaster*` covers only 6 fields; JSONB attributes derive follows-state from
  `resolveAttributes().source`. The resolver gains the alias layer (PES.5 owns
  `attribute-resolver.ts` / `resolve-channel-field.ts` during this work; PES.6 consumes the SAME
  resolver, never a parallel one).
- **Readiness vocabularies are TWO, deliberately:** scope-level `ready|warn|blocked|absent`
  (PES.1's chips) vs row/listing-level `ready|missing|errors|live|unlisted`. No lane maps one
  onto the other locally; PES.2 exports `readinessMeta()` as the one tone/label source.
- Readiness computation: reuse `listing-preflight.service.ts` validators (pure, batchable) +
  channel schema caps (`services/pim/schema-caps.ts`). A market is a coordinate LIST
  (no Market entity); `Marketplace.language` gives content locale.
- Sheet reads: extend the MS.1/MS.2 pattern (`GET /api/products/sheet/columns`, `/sheet`) with
  family scoping + channel scopes + per-cell provenance + readiness.

## §4 Lanes & substrate ownership (claim before touching)

| Lane | Mission | Owns (nobody else edits) |
|---|---|---|
| PES.1 | Frame: route, shell, sticky header, scope bar, readiness chips, thin tabs | `apps/web/src/app/products/[id]/edit/_studio/` (new), `ScopeBar`/`DetailHeader` extensions in `design-system/patterns/` |
| PES.2 | Master scope sheet + sheet substrate perfection | `design-system/grid/` (THE substrate owner), `_studio/sheet/master/` |
| PES.3 | Channel scopes + alias groups UI | `_studio/sheet/channel/` |
| PES.4 | Full-record drawer (form, history, compare, status) | `_studio/drawer/`, `design-system` Drawer patterns |
| PES.5 | Backend: alias entity, sheet reads, readiness API, per-cell history API | `apps/api` services/routes for sheet/alias/readiness, prisma migration |
| PES.6 | Global Mapping Engine `/channels/mapping` | `apps/web/src/app/channels/mapping/`, its api routes |
| PES.7 | Images tab rebuild + Analytics/Ads/Activity thin tabs | `_studio/images/`, `_studio/ancillary/` |
| PES.8 | AI enrichment lane (draft→review→apply) | `_studio/ai/`, AI api routes |

Cross-lane DS needs: request in `docs/pes-claims.md`; the owning lane implements. Start order:
PES.1/2/5/6 immediately; PES.3 implementation waits on PES.5's alias read shape + PES.2's
substrate (its study phase can start now); PES.4/7/8 study now, implement when PES.1 frame lands.

## §5 Coordination protocol (shared tree, no git safety net)
1. **Claim your lane** on session start: append to `docs/pes-claims.md` (session id, lane,
   date, files). Check existing claims BEFORE editing anything.
2. NOTHING is committed or pushed. No exceptions (supersedes commit-and-push default).
3. Never edit outside your lane's owned paths. A shared file belongs to its owning lane.
4. Every session: study → phase plan → **Owner approval → only then implement**.
5. Verify on the dev server (:3000). ⚠ Local web hits the PROD API unless `NEXT_PUBLIC_API_URL`
   is set — cell autosave writes are REAL. Verification writes go to the XAVIA test family
   (GALE/MISANO/AIREON/XRI01 fixtures) or a locally-run API only.
6. Chrome benchmark is /products/next; measure parity numerically (see
   reference_ag_grid_probe_traps). 100% honest UI: what displays must round-trip to the server.
7. Report findings as "at <time>, X" — siblings mutate the tree under you.
