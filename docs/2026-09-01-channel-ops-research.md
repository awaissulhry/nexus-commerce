# Channel-ops beside a grid-first editor — industry research (D1, hub-commissioned 2026-09-01)

Commissioned by the Owner ("research how it could be done the best way possible") for ruling #105's
D1: where do the 22 per-listing channel operations live in the rebuilt studio? Researched across
Rithum/ChannelAdvisor, Salsify, Akeneo, Plytix, ChannelEngine, Channable, Linnworks, Sellercloud,
Feedonomics, Lengow, plus the data-app canon (Airtable, Notion, Monday, Retool, Linear, IBM Carbon,
Shopify, Webflow, Contentful). Evidence-honesty notes at the end.

## 1. The five patterns actually in use

**A. Channel console / channel workspace** — a channel-scoped surface (grid + per-product channel
detail) separate from the master catalog.
Used by: **Akeneo Activation** (per-channel tabs Dashboard/Reports/Products; product detail with
readiness panel, errors panel split "Internal vs From the retailer", activation timeline —
documented), **Salsify** (channel page: products tab, readiness tab, publish button),
**Rithum/ChannelAdvisor** (`Sell > [Marketplace] > Listings > Errors & Messages` grouped by error
type, plus `By Product`), **Plytix** (channels module + process log), **ChannelEngine** (Listed
products + "Validation and feedback" + "Out of sync offer tasks").
Trade-off: the right shape for **queue-shaped work** (errors, suppressions, sync drift — triaged by
error TYPE across many SKUs), wrong for "fix this product while I'm editing it". The dominant
documented shape among PIM incumbents — and **none of them documents a drawer on the master grid**.

**B. Per-channel property page reached from the product row** — one product×channel gets a full
actionable surface.
Used by: **Sellercloud** (Product → Toolbox → "eBay/Amazon Properties": Actions menu with
List/Revise/Revise-one-attribute, Get Info From ASIN, Get Buy Box Price; policies, item specifics,
categories all on that page — documented), **Linnworks** (right-click the channel cell in the
inventory grid → listing template: categories, specifics, policies — documented). The only two
products giving one listing a full ops surface holding nearly all 22 capability types.
Trade-off: proves the CONTENT of a per-listing surface, but as full-page navigation — context loss.
Linnworks' grid (per-channel columns, red cell = error, right-click → edit) is the closest existing
analog to a grid re-projected per scope.

**C. Fix-by-rule pipeline (no listing surface at all)** — every "listing op" is a mapping/rule/
template edit, compensated by strong error consoles.
Used by: **Channable** (Categories→Build→Rules→Quality→Preview→Result; Items tab explicitly
read-only), **ChannelEngine**, **Lengow** (uniquely NORMALIZES cross-channel error vocabulary into
one report), **Feedonomics** (transformers; API-docs only — inferred), **Rithum** (templates +
business rules).
Trade-off: scales, but is the antithesis of a grid-first editor. Two ideas worth stealing:
Channable's **error→fix jump** ("View items" filters the preview; "Go to attribute" jumps to the
mapping) and Lengow's error normalization.

**D. Record drawer/sidesheet with zoned depth** — grid stays visible; a right panel carries depth.
Used by: **Airtable** (sidesheet default, prev/next record navigation, "User actions" section,
activity rail — documented, with rationale: sidesheet when browsing many records, full-screen for
deep single-record focus), **Notion** side peek (documented rationale), **Retool** drawers,
**Monday** item view (depth only; ops stay on the row). **IBM Carbon's criteria**: side panel when
main-view context is useful and fields overflow a modal; **full page when the majority of fields
are editable**. Counter-model: Shopify's full-page resource doctrine; its "Publishing" section
(channel matrix + Manage dialog) is the status-readout precedent.
Trade-off: best-in-class for depth-in-context — but **no researched product houses one-shot
operations ONLY inside a panel**; operations always also live on row/selection surfaces.

**E. Selection action bar + row menu + palette mirror (action-registry symmetry)** — verbs on the
grid's selection surfaces, defined once, exposed everywhere.
Used by: **Carbon data table** (three documented scopes: global toolbar / batch bar on selection,
which disables row actions / per-row overflow), **Linear** (ONE action registry behind palette,
context menu, and bulk toolbar — documented), **Akeneo grid** (bottom selection toolbar),
**Sellercloud Manage Catalog** (bulk Action menu: Launch on Channel, End Listing, Get Buy Box
Prices). Command palettes are never the primary home — always a mirror.
Trade-off: perfect for verbs, useless for depth and status readouts.

## 2. Fit against the 22 — the HYBRID is the norm

No single pattern covers the list; every mature platform runs a two- or three-tier hybrid. Sorted:

- **Verbs** (pull latest, publish, restore, translate, replicate, apply-to-siblings, dismiss
  suppression): pattern **E** primary + mirrored in the drawer. Note: **replicate-to-sibling-market
  is config-level copy everywhere in the industry** — offering it per-listing is a differentiator,
  not a convention.
- **Structured sub-editors** (category picker, aspects, policies, fulfillment, fitment): drawer
  **panes** (D, content proven by B) with **full-screen escalation** for the big ones (fitment,
  aspects) per Carbon's majority-of-fields rule. Policies are picked from account-level profiles
  everywhere, not edited inline.
- **Status readouts** (buy-box, A+ status, realtime sync, schema alerts): chip/column at scope
  level in the grid (Linnworks cell-state precedent; ChannelEngine's sent-vs-reported side-by-side)
  + detail pane in the drawer (Shopify Publishing-card shape).
- **Queue-shaped** (suppressions/errors, sync drift, schema alerts): pattern **A** — a
  channel-scoped errors/sync view grouped by error type, each row jumping to the grid row / drawer
  pane (Channable's jump). **Universal across all eleven platforms; never inline-only.**
- **Publish-snapshot + restore: essentially ABSENT from the commerce cohort** (Akeneo removed its
  channel-snapshot feature in Feb 2024). The documented playbook is CMS-side (Webflow, Contentful):
  **snapshot-on-publish; restore lands in DRAFT, never directly live; auto-snapshot current state
  before restoring; field-level rollback.** Genuinely novel among comparables.

## 3. Recommendation — three legs, two amendments

**Drawer panes survives — as one leg of three:**
1. **Drawer = depth home** (channel panes: transformed values, readiness, this-product errors,
   timeline, sub-editors, publish history/restore) — Akeneo Activation's detail + Sellercloud's
   property-page CONTENT, delivered as an Airtable-style sidesheet (prev/next, grid visible) with
   full-screen escalation for fitment/aspects. This modernizes what incumbents ship as separate
   pages — the page-based versions are exactly what their reviews punish (Salsify: "3–4 clicks and
   2–3 page loads to edit"; Rithum: "the UI isn't great").
2. **Verbs must NOT live only in the drawer:** every one-shot op goes through row context menu /
   ⋯ column / selection action bar, backed by **ONE action registry** so drawer, row menu, and a
   future palette stay identical (Linear's model; /products/next's row context menu already
   establishes this in the codebase).
3. **Queues need a CONSOLE, not a pane:** a channel-scoped "Errors & Sync" view as a studio TAB
   (extend-don't-add-pages), grouped by error type, rows jumping to grid row / drawer pane. A
   drawer shows THIS product's errors; it cannot do triage-across-200-SKUs.
4. **Publish/restore follows the CMS doctrine** (snapshot on publish, restore-to-draft +
   re-publish, pre-restore auto-snapshot; consider field-level restore) — drawer history pane +
   publish flow.

## Evidence honesty
Akeneo, Linnworks, Sellercloud, Channable, ChannelEngine, Airtable, Notion, Carbon, Webflow,
Contentful: explicitly documented (vendor help / design-system pages). Rithum (JS-walled KB),
Salsify's getstarted site, Lengow, Monday: search-indexed snippets of official articles.
Feedonomics: marketing-inferred. The drawer-on-master-grid shape is imported from data-app
patterns — no PIM incumbent documents it — so the claim is "better than what incumbents ship,
supported by their own review-site criticism", not "what incumbents ship".
