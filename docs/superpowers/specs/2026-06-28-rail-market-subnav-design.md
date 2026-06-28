# Rail market sub-navigation (`/products/next`) — Design

**Date:** 2026-06-28
**Status:** Approved (direction), pending implementation
**Scope:** First feature in an incremental sidebar-improvement track for the new `/products/next` shell.

## Problem

The new `/products/next` shell uses the shared hover-rail (`AppRail` + `PRODUCTS_NAV`). Its
Syndication area is `Listings → [Amazon, eBay, Shopify]`, where each channel is a plain
dead-end link. The **live** sidebar (`AppSidebar.tsx`, `ChannelNav`) is richer: each channel
(`Amazon`, `eBay`) expands to a third level of **markets** (IT / DE / FR / ES / UK), with a
"See all markets" modal for the long tail and per-market counts + connection dots.

We want the new rail to gain the same expandable **market sub-sub-navigation**, "similar or
even better" than live — done feature-by-feature.

## Decisions (approved)

1. **Interaction:** Inline 3-level accordion (Pattern A) — markets expand *under* a channel,
   the same idiom the rail already uses for one level. Not a hover-flyout, not a modal.
   Rationale: matches the live behaviour the user likes, fits the "visibility over
   minimalism / inline over dropdowns" preference, and is the lowest-risk extension of the
   existing accordion.
2. **Scope:** `Amazon` **+ `eBay`** get markets (both expand in live). `Shopify` stays a leaf.
3. **Data:** **Static-first.** Render the 5 priority markets (IT/DE/FR/ES/UK) as plain links.
   Live counts + connection dots + the "See all 18 markets" modal are an *immediate
   follow-up* feature, not this pass. This pass is purely the nav structure.

## Architecture

Three files change; all changes are additive and backward-compatible.

### 1. `apps/web/src/app/_shared/AppRail.tsx` (shared component)

- Extend the nav model to allow a **third level**:
  ```ts
  export interface RailMarketItem { code?: string; label: string; href: string }
  export interface RailSubItem { label: string; href: string; children?: RailMarketItem[] }
  export interface RailNavItem { /* …unchanged… */ children?: RailSubItem[] }
  ```
  Existing `{ label, href }` children still satisfy `RailSubItem` (children optional), so no
  other rail consumer (e.g. AdsSidebar) is affected.
- A sub-item **with** `children` renders as a **two-target row** (mirroring live `ChannelNav`):
  the **label is a `<Link>`** to the channel page (`/listings/amazon`), and a **separate
  chevron `<button>`** toggles its markets. This preserves direct navigation to the channel
  aggregate page (a pure-toggle would lose it).
- A sub-item **without** `children` renders exactly as today (plain `<Link>`).
- Grandchildren (markets) render in a deeper-indented `.h10-subsub` list. Each shows an
  optional monospace **code chip** (IT/DE/…) + the country name.
- **Open state:** extend the existing in-memory `open: Record<href, boolean>`. Seed a market
  group open when the current pathname is the channel or one of its markets (same
  auto-reveal logic already used for top-level groups). No persistence (matches the rail's
  current behaviour; persistence can be a later polish).

### 2. `apps/web/src/app/products/next/_shell/nav.ts` (data)

- Give the `Listings → Amazon` and `Listings → eBay` entries a `children` array of the 5
  priority markets, each `{ code, label, href }`, e.g.
  `{ code: 'IT', label: 'Italy', href: '/listings/amazon/it' }`.
- `Shopify` unchanged.

### 3. `apps/web/src/app/marketing/ads/ads.css` (rail styles — source of truth)

- Add additive rules after the existing `.h10-subitem` block:
  - `.h10-subparent` two-target row (flex; label link grows, chevron button trailing).
  - `.subchev` rotation on open (mirrors `.chev`).
  - `.h10-subsub` deeper-indented third-level container.
  - `.h10-subsubitem` (+ `:hover`, `.on`) market rows, and `.mcode` code chip.
- These class names do not exist elsewhere, so the ads cockpit (whose nav has no
  grandchildren) is visually unchanged. Third-level rows are nested inside `.h10-sub`, which
  ads.css already hides when the rail is collapsed — so collapse behaviour is inherited.

## Data flow

Static. `PRODUCTS_NAV` is a constant; `AppRail` derives active/open state from `usePathname()`.
No API calls added in this pass.

## Non-goals (this pass)

- Live market counts / connection dots (`/api/sidebar/counts`).
- "See all markets" modal for the long tail (>5 markets).
- Expand-state persistence in localStorage.
- Any change to the live `AppSidebar.tsx` or the ads cockpit.

These are tracked as the next feature(s) in the track.

## Testing / verification

- `tsc` clean (types compile; backward-compatible model).
- Visual self-verify in the browser at `/products/next` per the "UI self-verify before
  showing" rule: hover the rail, expand Listings → Amazon → markets; confirm alignment
  (code chip + indent), active highlighting on a market route, two-target click behaviour
  (label navigates, chevron toggles), and that collapse hides the third level. Screenshot
  before presenting.
