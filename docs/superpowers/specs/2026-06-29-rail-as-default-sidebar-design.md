# Rail as the default app-wide sidebar — Design

**Date:** 2026-06-29
**Status:** Approved (direction), pending implementation
**Goal:** Replace the live `AppSidebar` with the new hover-rail (`AppRail`) as the default
left navigation across the **entire** Nexus web app, with **zero feature regression and no
errors in any mode (light/dark), on any device (desktop/touch), on any route.**

## Problem

Two sidebars exist:

- **Live default** — `apps/web/src/components/layout/AppSidebar.tsx`. Always-open 240px,
  always-dark. Feature-rich: live counts, connection dots, recently-viewed, theme toggle,
  workspace switcher, user profile, ⌘K/search, markets modal, collapsible parents, mobile
  drawer. Mounted via `AppShell` (`components/layout/AppShell.tsx`) `sidebar` slot from the
  root layout (`app/layout.tsx`).
- **New rail** — `apps/web/src/app/_shared/AppRail.tsx`. 66px hover-expand (→344px), light
  only, **static** nav (`PRODUCTS_NAV`), with the market sub-nav shipped 2026-06-28. Used
  only on standalone routes (`/products/next`; the ads cockpit has its own `AdsSidebar`
  using the same `.h10-*` CSS).

Making the rail the default means closing a large parity gap and adapting the layout model,
theming, and mobile behaviour — without breaking the deliberately-light standalone surfaces.

## Approved decisions

1. **Theme-aware rail (dark + light).** The rail follows the app theme. Not always-light
   (clashes for dark users), not always-dark (loses the new look).
2. **Hover-collapse by default, with a persisted "pin open" toggle.** Satisfies both the new
   look and the "visibility over minimalism" preference for an always-open option.
3. **Ship live as the default, keep `AppSidebar` in the tree (unwired) as instant rollback**
   until every section is verified, then delete it.

## Architecture

Clear separation of concerns — presentational rail vs data/chrome container vs shell.

### `AppRail` (existing, `app/_shared/AppRail.tsx`) — presentational only
- Renders the nav (already supports 3 levels + the two-target channel row) and the
  hover/pin behaviour. Stays dumb: no data fetching.
- **Additions:**
  - `indicator?: 'action' | 'warning' | 'disconnected'` per `RailNavItem` / `RailSubItem`
    → renders the red/amber dot or the "Connect" affordance (parity with AppSidebar).
  - `header?: ReactNode` and `footer?: ReactNode` slots (footer changes from `string` to
    `ReactNode`) so the container injects chrome (⌘K/search/theme up top; recently-viewed +
    user at the bottom).
  - `pinned?: boolean` — when true, a class forces the expanded width (overrides
    hover-collapse). Pin is owned/persisted by the container.
  - `mobileOpen?: boolean` + `onMobileClose?: () => void` — drawer state for touch.

### `AppNavRail` (new container, `app/_shared/AppNavRail.tsx`) — data + chrome + state
- Owns everything app-specific so `AppRail` stays reusable:
  - Resolves the canonical `APP_NAV` skeleton → concrete `RailNavItem[]` by merging live
    counts + indicators (the same logic currently inline in AppSidebar).
  - Fetches `/api/sidebar/counts` (60s poll + focus refetch + `useInvalidationChannel`
    debounced refetch) and `/api/connections` (Amazon/eBay dots) — ported verbatim from
    AppSidebar so behaviour is identical.
  - Owns pin state (`localStorage`) and mobile-drawer state (listens to
    `nexus:toggle-sidebar` / `nexus:close-sidebar`, closes on route change).
  - Renders chrome into AppRail's slots: brand, workspace switcher, ⌘K + search + theme
    toggle (header); recently-viewed + user profile (footer); and the markets modal.
- This is the component placed in `AppShell`'s `sidebar` slot.

### `APP_NAV` (shared, `app/_shared/app-nav.ts`) — the one canonical nav
- Promote/rename `products/next/_shell/nav.ts` (`PRODUCTS_NAV`) to the shared app nav, the
  single source of truth for both `/products/next` and the global rail.
- Each item carries a **semantic** `count` key (e.g. `'listings.total'`) and optional
  `indicator` key, resolved to numbers/dots by `AppNavRail`. Add the collapsible parents
  AppSidebar has: Stock→Channel Drift, Outbound→Outbound Analytics, Returns→Analytics/
  Automation/Policies, Insights→Sales/Profit, Sync Logs→Health/Audit/Outbound/
  Reconciliation. (`AppRail` already supports the nesting.)
- `ProductsRail` switches to `APP_NAV` so the two never drift.

### `AppShell` (`components/layout/AppShell.tsx`) — chrome layout rewrite
- The chrome (non-standalone) path is rewritten to the rail model: a theme-reactive
  container that reserves the rail width (66px collapsed / expanded when pinned) with the
  rail at the left edge and `topBar + banners + main(children)` in the padded area.
- Does **not** reuse `.h10-shell` (that is pinned light — see Theming); uses the app's
  normal `bg-slate-50 dark:bg-slate-950`.
- Standalone path unchanged.

## Feature-parity map

| AppSidebar feature | Source | Lands in |
| --- | --- | --- |
| Listing/order/inbox counts | `/api/sidebar/counts` | `AppNavRail` data hook → `RailNavItem.badge` |
| Amazon/eBay connection dots | `/api/connections` | `AppNavRail` → channel `indicator` |
| action/warning indicator dots | counts thresholds | `AppRail` `indicator` render |
| "Connect" (disconnected) | static | `AppRail` `indicator: 'disconnected'` |
| Collapsible parents + persist | localStorage | `APP_NAV` children + `AppRail` open-state (extend to persist) |
| Channel → markets + modal | static + `MarketsModal` | already in rail; modal rendered by `AppNavRail` |
| ⌘K + search buttons | `nexus:open-command-palette` | `AppNavRail` header slot |
| Theme toggle | `useTheme` | `AppNavRail` header slot |
| Workspace switcher | static | `AppNavRail` header slot |
| Recently-viewed (persist) | `useRecentlyViewed` | `AppNavRail` footer slot |
| User profile | static | `AppNavRail` footer slot |
| Mobile drawer | `nexus:toggle-sidebar` | `AppNavRail` state + `AppRail` mobile classes |

## Theming

- **Tokenize** the rail colour rules in `ads.css` (`.h10-rail`, `.h10-item`, `.h10-sub*`,
  `.h10-brand`, the new `.h10-subsub*`) from hardcoded hex to `var(--h10-*)`. Mapping:
  surface `#f1f3f5`→`--h10-rail-bg`; line `#e3e7ec`→`--h10-rail-border`; strong text
  `#1c2530`→`--h10-text`; item text `#4a5462`→`--h10-text-2`; icon `#8a93a1`→`--h10-text-3`;
  active `#1f6fde`→`--h10-primary` (blue fill + white text works in both themes).
- **Add** rail-specific tokens with **both** `:root` and `.dark` values:
  `--h10-rail-item-hover` (`#e6eaf0` / a dark slate), `--h10-rail-chip-bg`,
  `--h10-rail-chip-active-bg` (+ fg). The market code chip uses these.
- **Fill `.dark` gaps:** `--h10-text-strong` and `--h10-surface-hover` are not currently
  overridden in `.dark`; the rail must avoid them or add overrides.
- **Protect the light surfaces:** pin `.h10-shell` to light token values (re-scope `--h10-*`
  there) so the ads cockpit and `/products/next` — both wrap in `.h10-shell` — stay light
  regardless of `.dark`. Only the app-wide rail (in `AppShell`, not `.h10-shell`) follows the
  theme. (`/products/next`'s `.productsNextLight` pin becomes redundant but harmless.)

## Mobile / touch

- The rail has no hover on touch. Add mobile CSS: below `md`, the rail is off-canvas
  (`translate-x-full`), slides in (`translate-x-0`) when `mobileOpen`, with a tap-to-close
  backdrop — mirroring AppSidebar's existing drawer. Reuse the unchanged `MobileTopBar`
  burger (`nexus:toggle-sidebar`). On mobile the rail shows full width (labels visible), not
  the 66px hover model.

## Interaction (pin)

- Default: hover-collapse (66↔expanded). A pin control (in the header chrome) toggles a
  persisted always-open state; when pinned, `AppShell` reserves the expanded width and the
  rail stops collapsing on mouse-leave.

## Sub-layout collisions

- **`/settings`** has its own `SettingsRail` left column → would stack two rails. Reconcile:
  keep SettingsRail as the secondary nav but ensure the global rail + SettingsRail don't
  double-reserve width (audit the negative-margin breakout). Verify pricing/orders/marketing
  sub-navs are inline (tabs), not competing rails.

## Rollout + rollback

- `AppSidebar.tsx` stays in the repo, unwired, through P5–P7. If anything regresses, revert
  the one-line slot swap in `app/layout.tsx`/`AppShell`. Delete `AppSidebar` only in P7 after
  the full verification sweep signs off.

## Phases (each: implement → `tsc` + build → visual self-verify → commit + push)

- **P1 — Theme-aware rail.** Tokenize rail rules; add tokens; pin `.h10-shell` light. Verify
  `/products/next` + ads cockpit stay light; rail renders correct in `.dark` (test harness).
  *Accept:* both standalone surfaces visually unchanged; rail legible in dark.
- **P2 — Canonical nav + live data.** `APP_NAV` (sections + collapsible children + count/
  indicator keys); `AppNavRail` data hook (counts + connections). `ProductsRail` uses
  `APP_NAV`. *Accept:* badges + dots match AppSidebar on the same routes.
- **P3 — Chrome parity.** ⌘K/search, theme toggle, workspace, recently-viewed, user, markets
  modal into AppRail slots. *Accept:* every AppSidebar chrome affordance present + functional.
- **P4 — Mobile drawer.** Rail mobile classes + `AppNavRail` drawer state via the burger.
  *Accept:* full nav reachable on touch/small screens; closes on route change.
- **P5 — Make default.** Rewrite `AppShell` chrome layout to the rail model; swap `sidebar`
  slot to `AppNavRail`; pin behaviour; z-index/print (`data-print-hide` on the rail)/Cmd-K.
  `AppSidebar` kept as rollback. *Accept:* app-wide rail live; no layout shift/overlap.
- **P6 — Sub-layout collisions.** Fix `/settings` double-rail; audit others. *Accept:* no
  double-reserved width anywhere.
- **P7 — Verification sweep + retire.** Every section × {light, dark, mobile}; screenshot
  self-verify per route group; then delete `AppSidebar` + dead events. *Accept:* sign-off on
  every section in all three modes; build green.

## Risks & mitigations

- **Breaking the light standalone surfaces** → pin `.h10-shell` light (above); P1 verifies.
- **Dark `.dark` token gaps** → audit every var the rail consumes has a `.dark` value.
- **z-index** (rail `z-50` vs overlays/popovers) → audit in P5; keep command palette/modals
  above the rail.
- **Print** → mark the rail `data-print-hide`.
- **`/settings` double-rail** → P6.
- **SSR/hydration** → `AppNavRail`/`AppRail` are `'use client'`; data deferred to effects
  (no SSR mismatch), matching AppSidebar.

## Non-goals

- Redesigning any page's content. Changing `AdsSidebar` (the ads cockpit keeps its own rail).
- New nav destinations or IA changes beyond parity. Functional workspace switcher / user menu
  (ported as-is, same as today's static buttons).

## Verification

- Per phase: `tsc --noEmit` clean + `apps/web` production build green (pre-push hook) + visual
  self-verify (screenshot, both themes where relevant) before claiming done.
- P7 final: a route-group matrix (Catalog/Syndication/Fulfillment/Marketing/Operations/
  Monitoring/System/Settings) × {light, dark, mobile}, each screenshot-checked.
