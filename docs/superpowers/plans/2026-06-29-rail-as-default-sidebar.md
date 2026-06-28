# Rail as Default Sidebar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live `AppSidebar` with the new hover-rail (`AppRail`) as the default left navigation across the entire Nexus web app, with zero feature regression in any theme, device, or route.

**Architecture:** Keep `AppRail` presentational. Add a client container `AppNavRail` that owns app data (counts, connections), chrome (workspace, ⌘K/search/theme, recently-viewed, user, markets modal), pin state, and mobile-drawer state, feeding a canonical `APP_NAV`. Tokenize the rail CSS so it follows the app theme, while pinning the deliberately-light standalone shells (`.h10-shell`) light. Swap `AppShell`'s `sidebar` slot to `AppNavRail` and rewrite its chrome layout to the rail model. Keep `AppSidebar` as instant rollback until a full verification sweep, then delete it.

**Tech Stack:** Next.js 16 (App Router), React 18, TypeScript, CSS custom properties (`--h10-*` design tokens in `design-system/styles/tokens.css`), lucide-react icons, Tailwind utility classes in the shell.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-29-rail-as-default-sidebar-design.md` (authoritative).
- Zero changes to the ads cockpit nav (`marketing/ads/_shell/AdsSidebar.tsx`) and to `/products/amazon-flat-file` / `/products/ebay-flat-file` (untouchable).
- The deliberately-light surfaces — the ads cockpit and `/products/next` — must remain visually light in both app themes.
- `AppSidebar.tsx` must keep working and stay wired until Phase 7; rollback = revert the one slot swap.
- Verification per task: `cd apps/web && npx tsc --noEmit -p tsconfig.json` exits 0, AND visual self-verify in the browser (screenshot; both themes where relevant) before claiming done. The pre-push hook runs the full `apps/web` + `apps/api` build — a push that builds is the build gate.
- Commit after each task (standing rule). Use `git commit --only <paths>` to avoid sweeping unrelated in-progress files on `main`.
- This codebase has no UI unit-test harness for nav components; "test" here means tsc + production build + browser visual verification, not pytest/vitest unit tests. Do not invent a test runner.
- Preview bed for Phases 2–4: render `AppNavRail` at `/products/next` (swap `ProductsRail` → `AppNavRail`) so the full-featured rail is verifiable in isolation before going app-wide in Phase 5.

---

## Phase 1 — Theme-aware rail

### Task 1.1: Add rail tokens + pin `.h10-shell` light

**Files:**
- Modify: `apps/web/src/design-system/styles/tokens.css` (`:root` ~line 35-56 and `.dark` ~line 177-192)
- Modify: `apps/web/src/app/marketing/ads/ads.css:6` (`.h10-shell`)

**Interfaces:**
- Produces: CSS custom properties `--h10-rail-item-hover`, `--h10-rail-chip-bg`, `--h10-rail-chip-active-bg`, `--h10-rail-chip-active-fg` (light + dark values), consumed by Task 1.2.

- [ ] **Step 1: Add rail tokens to `:root`** (after `--h10-rail-line` at line 36)

```css
  --h10-rail-item-hover: #e6eaf0;
  --h10-rail-chip-bg: #e8ebf0;
  --h10-rail-chip-active-bg: #dce8fb;
  --h10-rail-chip-active-fg: #1f6fde;
```

- [ ] **Step 2: Add the dark overrides to `.dark`** (inside the `.dark { … }` block, after `--h10-rail-border`)

```css
  --h10-rail-item-hover: #223247;
  --h10-rail-chip-bg: #243345;
  --h10-rail-chip-active-bg: #1d3a5f;
  --h10-rail-chip-active-fg: #cfe1fb;
  /* fill gaps the rail consumes that .dark did not previously override */
  --h10-text-strong: #cdd6e1;
  --h10-surface-hover: #223247;
```

- [ ] **Step 3: Pin `.h10-shell` to light tokens** so standalone shells stay light regardless of `.dark`. Edit `ads.css:6` — keep its hardcoded light `background`/`color`, and ADD a re-scope of the rail tokens to their light values (mirror `products-next-shell.css`):

```css
.h10-shell {
  /* …existing display/height/background/color/font rules unchanged… */
  --h10-rail-bg: #f1f3f5;
  --h10-rail-border: #e3e7ec;
  --h10-rail-item-hover: #e6eaf0;
  --h10-rail-chip-bg: #e8ebf0;
  --h10-rail-chip-active-bg: #dce8fb;
  --h10-rail-chip-active-fg: #1f6fde;
  --h10-text: #1c2530;
  --h10-text-2: #4a5462;
  --h10-text-3: #8a93a1;
  color-scheme: light;
}
```

- [ ] **Step 4: Verify** `cd apps/web && npx tsc --noEmit -p tsconfig.json` → exit 0 (CSS-only change; just confirms nothing else broke).

- [ ] **Step 5: Commit**

```bash
git commit --only apps/web/src/design-system/styles/tokens.css apps/web/src/app/marketing/ads/ads.css -m "feat(rail): add theme-aware rail tokens + pin .h10-shell light"
```

### Task 1.2: Tokenize the rail colour rules in `ads.css`

**Files:**
- Modify: `apps/web/src/app/marketing/ads/ads.css` (`.h10-rail`, `.h10-brand`, `.h10-item`, `.h10-sub*`, `.h10-subsub*` colour declarations, ~lines 20-98)

**Interfaces:**
- Consumes: tokens from Task 1.1 + existing `--h10-text`, `--h10-text-2`, `--h10-text-3`, `--h10-primary`, `--h10-rail-bg`, `--h10-rail-border`, `--h10-shadow-rail`.

- [ ] **Step 1: Replace hardcoded hex with `var(--h10-*)`** in the rail rules. Mapping (apply to every matching declaration):
  - rail `background: #f1f3f5` → `var(--h10-rail-bg)`; `border-right: 1px solid #e3e7ec` → `var(--h10-rail-border)`; hover `box-shadow` → `var(--h10-shadow-rail)`
  - brand `.word .mk` `#1c2530` → `var(--h10-text)`; logo keeps `#1f6fde` (brand blue, theme-agnostic) or `var(--h10-primary)`
  - item text `#4a5462` → `var(--h10-text-2)`; icon `#8a93a1` → `var(--h10-text-3)`; hover bg `#e6eaf0` → `var(--h10-rail-item-hover)`; hover text `#1c2530` → `var(--h10-text)`; active `.on` keeps `background: var(--h10-primary); color: #fff`
  - sub text `#5b6573` → `var(--h10-text-2)`; subitem hover `#f1f4f8` → `var(--h10-rail-item-hover)`; `.on` `#1f6fde` → `var(--h10-primary)`
  - subsub: `.subchev-btn` color `#98a2b3` → `var(--h10-text-3)`; chip `.mcode` bg `#e8ebf0` → `var(--h10-rail-chip-bg)`, fg `#5b6573` → `var(--h10-text-2)`; `.on .mcode` → `var(--h10-rail-chip-active-bg)` / `var(--h10-rail-chip-active-fg)`; tree line `#e3e7ec` → `var(--h10-rail-border)`

- [ ] **Step 2: Verify light unchanged** — restart not needed (CSS hot-reloads). In the browser at `/products/next`: rail must look identical to before (it's under `.h10-shell` which pins light). Screenshot + compare to the pre-change look.

- [ ] **Step 3: Verify dark renders** — temporarily, in devtools, add class `dark` to `<html>` while on a NON-standalone route is not yet possible (rail isn't app-wide). Instead create a throwaway check: in devtools console on `/products/next`, run `document.querySelector('.h10-shell').classList.remove` is N/A; simplest — wrap a copy: open any normal route (e.g. `/products`) — rail there is still AppSidebar. So validate dark via a temporary harness: in `/products/next`, in devtools, set on the `.h10-rail` element’s computed style by toggling `:root`→`.dark`: run `document.documentElement.classList.add('dark')` and confirm the rail under `.h10-shell` STAYS light (pin works). Remove the class after. (True dark rail is verified in Phase 5 when it’s app-wide and theme-reactive.)

- [ ] **Step 4: Verify** `npx tsc --noEmit` → exit 0.

- [ ] **Step 5: Commit**

```bash
git commit --only apps/web/src/app/marketing/ads/ads.css -m "refactor(rail): tokenize rail colours so the rail can follow app theme"
```

---

## Phase 2 — Canonical nav + live data

### Task 2.1: Promote nav to canonical `APP_NAV`

**Files:**
- Create: `apps/web/src/app/_shared/app-nav.ts`
- Modify: `apps/web/src/app/products/next/_shell/nav.ts` (re-export from the new module)
- Modify: `apps/web/src/app/products/next/_shell/ProductsRail.tsx` (import `APP_NAV`)

**Interfaces:**
- Produces: `APP_NAV: RailNavItem[]` and a `RailNavItem` shape extended with optional `count?: string` (semantic key) and `indicator?: 'action'|'warning'|'disconnected'|{key:string}`.

- [ ] **Step 1:** Move the current `PRODUCTS_NAV` array into `app-nav.ts` as `APP_NAV`, and ADD the collapsible parents present in `AppSidebar.tsx` so structure matches:
  - Stock → child `Channel Drift` (`/fulfillment/stock/channel-drift`)
  - Outbound → child `Outbound Analytics` (`/fulfillment/outbound/analytics`)
  - Returns → children `Returns Analytics`, `Returns Automation`, `Return Policies`
  - (Insights and Sync Logs already have children in the existing nav — keep.)
  - Add semantic `count`/`indicator` keys mirroring `AppSidebar.tsx:381-765`: e.g. Products `count:'catalog.products'`; Organize `count:'catalog.pimPending'`, `indicator:{key:'catalog.pimPending'}`; All Listings `count:'listings.total'`; Orders + Outbound `count:'operations.pendingOrders'`, `indicator:{key:'operations.pendingOrders'}`; Inbox `count:'inbox.total'`, `indicator:{key:'inbox'}`; Sync Logs `indicator:{key:'monitoring.syncIssues'}`; Connections `count:'system.connectedChannels'`. Amazon/eBay channels keep their market children (already shipped).

- [ ] **Step 2:** In `nav.ts`, replace the array with `export { APP_NAV as PRODUCTS_NAV } from '@/app/_shared/app-nav'` (keeps existing importers working).

- [ ] **Step 3:** Point `ProductsRail.tsx` at `APP_NAV` (or leave it importing `PRODUCTS_NAV`, now a re-export — either is fine; prefer direct `APP_NAV`).

- [ ] **Step 4: Verify** `npx tsc --noEmit` → 0; at `/products/next` the rail still renders all sections (now with the extra Stock/Outbound/Returns children when expanded).

- [ ] **Step 5: Commit**

```bash
git commit --only apps/web/src/app/_shared/app-nav.ts apps/web/src/app/products/next/_shell/nav.ts apps/web/src/app/products/next/_shell/ProductsRail.tsx -m "feat(rail): canonical APP_NAV with collapsible parents + count/indicator keys"
```

### Task 2.2: Add `indicator` to `AppRail` rendering

**Files:**
- Modify: `apps/web/src/app/_shared/AppRail.tsx` (types + render)
- Modify: `apps/web/src/app/marketing/ads/ads.css` (indicator dot + "Connect" styles)

**Interfaces:**
- Consumes: `RailNavItem.indicator` / `RailSubItem.indicator` resolved to a literal `'action'|'warning'|'disconnected'` by the time it reaches `AppRail` (the container resolves `{key}` → literal).
- Produces: rail rows render a red dot (`action`), amber dot (`warning`), or a trailing "Connect" label (`disconnected`).

- [ ] **Step 1:** Add `indicator?: 'action' | 'warning' | 'disconnected'` to `RailNavItem` and `RailSubItem`.

- [ ] **Step 2:** In the item body render, after the badge, add the dot/Connect markup (mirror `AppSidebar.tsx:856-905` semantics):

```tsx
{it.indicator === 'disconnected' ? (
  <span className="h10-connect">Connect</span>
) : it.indicator === 'action' ? (
  <span className="h10-dot action" aria-hidden />
) : it.indicator === 'warning' ? (
  <span className="h10-dot warning" aria-hidden />
) : null}
```

- [ ] **Step 3:** Add CSS in `ads.css`:

```css
.h10-dot { width: 7px; height: 7px; border-radius: 999px; margin-left: auto; flex-shrink: 0; }
.h10-dot.action { background: var(--h10-danger); }
.h10-dot.warning { background: var(--h10-warning); }
.h10-connect { margin-left: auto; font-size: 11px; color: var(--h10-text-3); opacity: 0; transition: opacity .14s; }
.h10-rail:hover .h10-connect { opacity: 1; }
```

- [ ] **Step 4: Verify** `npx tsc --noEmit` → 0; temporarily add `indicator:'warning'` to one APP_NAV item and confirm the dot renders at `/products/next`, then remove the temp.

- [ ] **Step 5: Commit**

```bash
git commit --only apps/web/src/app/_shared/AppRail.tsx apps/web/src/app/marketing/ads/ads.css -m "feat(rail): indicator dots + Connect affordance"
```

### Task 2.3: `AppNavRail` container with live counts + connections

**Files:**
- Create: `apps/web/src/app/_shared/AppNavRail.tsx`
- Modify: `apps/web/src/app/products/next/_shell/ProductsRail.tsx` (render `<AppNavRail/>` as the preview bed)

**Interfaces:**
- Consumes: `APP_NAV`, `AppRail`, `/api/sidebar/counts`, `/api/connections`, `getBackendUrl`, `useInvalidationChannel`.
- Produces: `export function AppNavRail(): JSX.Element` — the full-featured rail; placed in `AppShell`'s sidebar slot in Phase 5.

- [ ] **Step 1:** Create `AppNavRail.tsx` (`'use client'`). Port verbatim from `AppSidebar.tsx`:
  - the `SidebarCounts` interface (lines 58-68)
  - the counts fetch + 60s poll + focus refetch + `useInvalidationChannel` debounced refetch (lines 224-293)
  - the connections fetch → `amazonConnected` / `ebayConnected` (lines 199-220)
  Then build the concrete nav: map `APP_NAV` → `RailNavItem[]`, resolving each `count` key against `SidebarCounts` (e.g. `'listings.total'` → `counts.listings?.total`) and each `indicator` `{key}` to `'action'|'warning'` per the same thresholds AppSidebar uses, and the Amazon/eBay channel `indicator` to `'disconnected'` when not connected. Render `<AppRail navItems={resolved} brand={{mark:'N',name:'Nexus'}} />`.

- [ ] **Step 2:** In `ProductsRail.tsx`, replace the body with `return <AppNavRail />` (preview bed). Keep the file so the layout import is stable.

- [ ] **Step 3: Verify** at `/products/next`: counts badges + connection dots now appear and match what `/products` (AppSidebar) shows for the same data. `npx tsc --noEmit` → 0.

- [ ] **Step 4: Commit**

```bash
git commit --only apps/web/src/app/_shared/AppNavRail.tsx apps/web/src/app/products/next/_shell/ProductsRail.tsx -m "feat(rail): AppNavRail container with live counts + connection dots"
```

---

## Phase 3 — Chrome parity

### Task 3.1: Header chrome (brand, workspace, ⌘K, search, theme)

**Files:**
- Modify: `apps/web/src/app/_shared/AppRail.tsx` (add `header?: ReactNode` slot rendered under `.h10-brand`)
- Modify: `apps/web/src/app/_shared/AppNavRail.tsx` (build the header)
- Modify: `apps/web/src/app/marketing/ads/ads.css` (header control styles)

**Interfaces:**
- Consumes: `useTheme` (`@/lib/theme/use-theme`), `nexus:open-command-palette` event.
- Produces: header slot with workspace switcher + ⌘K + search + theme toggle.

- [ ] **Step 1:** Add `header?: ReactNode` to `AppRailProps`; render it directly under `.h10-brand` (visible only when expanded — reuse `.lbl`/opacity pattern, or a `.h10-railhdr` wrapper hidden when collapsed via `.h10-rail:not(:hover) .h10-railhdr { display:none }` unless pinned).

- [ ] **Step 2:** In `AppNavRail`, build the header: workspace button (port `AppSidebar.tsx:366-377`), ⌘K + search buttons dispatching `new CustomEvent('nexus:open-command-palette')` (port lines 312-314, 349-362), and the theme toggle (port `SidebarThemeToggle` lines 1238-1258 but use theme-aware token colours, not fixed slate). Pass as `header` prop.

- [ ] **Step 3:** Add `.h10-railhdr` styles in `ads.css` (a thin control row; buttons use `var(--h10-text-2)` with `var(--h10-rail-item-hover)` hover).

- [ ] **Step 4: Verify** at `/products/next`: workspace + ⌘K (opens palette) + search + theme toggle all present and working. `npx tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git commit --only apps/web/src/app/_shared/AppRail.tsx apps/web/src/app/_shared/AppNavRail.tsx apps/web/src/app/marketing/ads/ads.css -m "feat(rail): header chrome — workspace, Cmd-K, search, theme toggle"
```

### Task 3.2: Footer chrome (recently-viewed + user)

**Files:**
- Modify: `apps/web/src/app/_shared/AppRail.tsx` (change `footer?: string` → `footer?: ReactNode`)
- Modify: `apps/web/src/app/_shared/AppNavRail.tsx` (build footer)

**Interfaces:**
- Consumes: `useRecentlyViewed` (`@/lib/use-recently-viewed`).
- Produces: footer slot with collapsible recently-viewed + user profile.

- [ ] **Step 1:** Widen `footer` to `ReactNode` in `AppRailProps` (update the one existing `footer="…"` string usage — still valid as a ReactNode).

- [ ] **Step 2:** In `AppNavRail`, build the footer: recently-viewed (port `AppSidebar.tsx:768-805` incl. the collapse-persist) and the user profile button (port lines 808-821), themed via tokens. Pass as `footer`.

- [ ] **Step 3: Verify** at `/products/next`: recently-viewed list + user block render; collapse persists. `npx tsc --noEmit` → 0.

- [ ] **Step 4: Commit**

```bash
git commit --only apps/web/src/app/_shared/AppRail.tsx apps/web/src/app/_shared/AppNavRail.tsx -m "feat(rail): footer chrome — recently-viewed + user profile"
```

### Task 3.3: Markets modal

**Files:**
- Modify: `apps/web/src/app/_shared/AppNavRail.tsx` (render `MarketsModal`, add "See all markets" trigger)

**Interfaces:**
- Consumes: `MarketsModal` (`@/components/layout/MarketsModal`) — already light-themed with Tailwind, renders fine under both shells.

- [ ] **Step 1:** In `AppNavRail`, add per-channel modal state + a "See all N markets" sub-row under Amazon/eBay markets (reuse the `MarketsModal` Map<code,count> built from counts). Pass `connectionStatus` per channel.

- [ ] **Step 2: Verify** at `/products/next`: expanding Amazon shows priority markets + "See all"; the modal opens, searches, links work. `npx tsc --noEmit` → 0.

- [ ] **Step 3: Commit**

```bash
git commit --only apps/web/src/app/_shared/AppNavRail.tsx -m "feat(rail): See-all markets modal parity"
```

---

## Phase 4 — Mobile drawer

### Task 4.1: Rail mobile drawer

**Files:**
- Modify: `apps/web/src/app/_shared/AppRail.tsx` (accept `mobileOpen`, `onMobileClose`; apply drawer classes/backdrop)
- Modify: `apps/web/src/app/_shared/AppNavRail.tsx` (own mobile state via `nexus:toggle-sidebar`/`nexus:close-sidebar`, close on route change)
- Modify: `apps/web/src/app/marketing/ads/ads.css` (mobile rail rules)

**Interfaces:**
- Consumes: `nexus:toggle-sidebar` / `nexus:close-sidebar` events (already dispatched by `MobileTopBar`).
- Produces: a usable full-width slide-in rail on touch/small screens.

- [ ] **Step 1:** In `AppNavRail`, port the mobile-drawer state from `AppSidebar.tsx:128-146` (toggle/close listeners + close on `pathname` change). Pass `mobileOpen` + `onMobileClose` to `AppRail`.

- [ ] **Step 2:** In `AppRail`, when `mobileOpen`, render a tap-to-close backdrop and apply mobile classes; below `md` the rail is `position:fixed; transform:translateX(-100%)` and `translateX(0)` when open, full-label width.

- [ ] **Step 3:** Add the mobile CSS in `ads.css` under a `@media (max-width: 767px)` block: rail fixed, off-canvas by default, `.h10-rail.mobile-open { transform: none; width: 280px; }`, sub-items always visible (override the hover-hide on mobile), backdrop `.h10-rail-backdrop`.

- [ ] **Step 4: Verify** in the browser at a narrow viewport (devtools responsive, ~390px) on `/products/next`: burger opens the rail, nav reachable, tap-outside closes, route change closes. `npx tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git commit --only apps/web/src/app/_shared/AppRail.tsx apps/web/src/app/_shared/AppNavRail.tsx apps/web/src/app/marketing/ads/ads.css -m "feat(rail): mobile drawer (touch-usable nav)"
```

---

## Phase 5 — Make the rail the default

### Task 5.1: Pin toggle + state

**Files:**
- Modify: `apps/web/src/app/_shared/AppRail.tsx` (`pinned?` prop → forced-expanded class)
- Modify: `apps/web/src/app/_shared/AppNavRail.tsx` (pin state + persist + a pin button in header)
- Modify: `apps/web/src/app/marketing/ads/ads.css` (`.h10-rail.pinned` forces expanded width; suppress hover-overlay)

**Interfaces:**
- Produces: `AppNavRail` exposes pin state via a `data-rail-pinned` attribute on a stable ancestor so `AppShell` can reserve the matching width (or via a shared context — pick the attribute approach for simplicity).

- [ ] **Step 1:** Add `pinned` to `AppRailProps`; when true add class `pinned`. CSS: `.h10-rail.pinned { width: var(--h10-rail-expanded); }` and `.h10-rail.pinned .lbl,.chev,.h10-railhdr,.h10-railft { opacity:1 }`.

- [ ] **Step 2:** In `AppNavRail`, add `pinned` state (localStorage `nexus.rail.pinned`), a pin/unpin button in the header, and set `document.documentElement.dataset.railPinned = pinned ? '1' : '0'` in an effect so the shell can react.

- [ ] **Step 3: Verify** pin persists across reload; `npx tsc --noEmit` → 0.

- [ ] **Step 4: Commit**

```bash
git commit --only apps/web/src/app/_shared/AppRail.tsx apps/web/src/app/_shared/AppNavRail.tsx apps/web/src/app/marketing/ads/ads.css -m "feat(rail): pin-open toggle (persisted)"
```

### Task 5.2: Swap the AppShell sidebar slot + rewrite chrome layout

**Files:**
- Modify: `apps/web/src/components/layout/AppShell.tsx` (chrome path)
- Modify: `apps/web/src/app/layout.tsx` (pass `<AppNavRail/>` as `sidebar`)

**Interfaces:**
- Consumes: `AppNavRail`, the `data-rail-pinned` attribute.

- [ ] **Step 1:** In `app/layout.tsx`, change `sidebar={<AppSidebar />}` → `sidebar={<AppNavRail />}` (keep the `AppSidebar` import for rollback). `AppNavRail` is a client component; importing into the server layout is fine (it self-marks `'use client'`).

- [ ] **Step 2:** Rewrite the `AppShell` chrome (non-standalone) branch to the rail model:

```tsx
return (
  <>
    <div className="relative flex h-[100dvh] bg-slate-50 dark:bg-slate-950 overflow-hidden">
      {sidebar /* AppNavRail: renders the fixed/absolute .h10-rail itself */}
      <div
        className="flex-1 flex flex-col overflow-hidden transition-[padding] duration-150"
        style={{ paddingLeft: 'var(--rail-reserve, 66px)' }}
      >
        <div data-print-hide>{topBar}</div>
        <main id="main-content" className="flex-1 overflow-auto" tabIndex={-1}>
          <div data-print-hide>{banners}</div>
          <div className="p-3 md:p-6">{children}</div>
        </main>
      </div>
    </div>
    <div data-print-hide>{overlays}</div>
  </>
)
```

  Set `--rail-reserve` from the pin attribute: add a tiny effect/CSS — `:root[data-rail-pinned='1'] { --rail-reserve: var(--h10-rail-expanded); }` and default `66px`. Below `md`, `--rail-reserve: 0` (drawer overlays). Mark the rail `data-print-hide` (add the attribute on the `.h10-rail` in `AppRail`).

- [ ] **Step 3:** z-index check: ensure command palette / modals / toasts sit above the rail (`z-50`). Bump the rail to a defined layer if needed (rail `z-40`, overlays `z-50`).

- [ ] **Step 4: Verify** across a sample of routes in BOTH themes (`/`, `/products`, `/orders`, `/fulfillment/stock`, `/settings`): rail renders app-wide, hover-expand works, pin reserves width, no content overlap/shift, dark theme correct, print hides the rail. `npx tsc --noEmit` → 0. Push (runs full build).

- [ ] **Step 5: Commit + push**

```bash
git commit --only apps/web/src/components/layout/AppShell.tsx apps/web/src/app/layout.tsx -m "feat(rail): make AppNavRail the default app-wide sidebar (AppSidebar kept as rollback)"
git push origin main
```

---

## Phase 6 — Sub-layout collisions

### Task 6.1: `/settings` double-rail + audit

**Files:**
- Modify: `apps/web/src/app/settings/layout.tsx` and/or `apps/web/src/app/settings/_shell/SettingsRail.tsx`

- [ ] **Step 1:** Load `/settings` with the new rail. Confirm whether the global rail + `SettingsRail` double-reserve horizontal space. If so, adjust the settings layout so `SettingsRail` sits inside the content column (it already breaks out with `-m-3 md:-m-6`; ensure that breakout accounts for the rail's reserved width, not the old 240px).

- [ ] **Step 2:** Quick audit: `/pricing` (inline `PricingTabs` — should be fine), `/orders`, `/marketing/*` (non-ads), `/insights` — confirm no other route hardcodes a left offset or renders a competing rail. Grep: `rg -n "left-\[|ml-\[|240px|w-60" apps/web/src/app` and eyeball hits.

- [ ] **Step 3: Verify** `/settings` and audited routes look correct in both themes. `npx tsc --noEmit` → 0.

- [ ] **Step 4: Commit + push**

```bash
git commit --only apps/web/src/app/settings/layout.tsx apps/web/src/app/settings/_shell/SettingsRail.tsx -m "fix(rail): resolve /settings double-rail width with the global rail"
git push origin main
```

---

## Phase 7 — Verification sweep + retire AppSidebar

### Task 7.1: Route-group matrix verification

**Files:** none (verification only)

- [ ] **Step 1:** For each section, load a representative route and screenshot-verify in **light, dark, and mobile (≈390px)**: Catalog (`/products`), Syndication (`/listings`), Fulfillment (`/fulfillment/stock`), Marketing (`/marketing/content`), Operations (`/orders`), Monitoring (`/inbox`), System (`/settings/channels`), Settings (`/settings`). Check: active highlighting correct, counts/dots present, collapsible parents work, hover-expand + pin, mobile drawer, no overlap, theme correct.

- [ ] **Step 2:** Record results inline in this plan (check the boxes); fix any defect found before proceeding (loop back to the owning phase's files).

### Task 7.2: Retire AppSidebar

**Files:**
- Delete: `apps/web/src/components/layout/AppSidebar.tsx`
- Modify: `apps/web/src/app/layout.tsx` (remove the now-unused `AppSidebar` import)
- Check: remove any now-dead helpers exclusive to AppSidebar (e.g. duplicate market constants) only if nothing else imports them (`rg` first).

- [ ] **Step 1:** Confirm nothing imports `AppSidebar` except the (already-swapped) layout: `rg -n "components/layout/AppSidebar|from './AppSidebar'" apps/web/src`.

- [ ] **Step 2:** Delete the file + import. `npx tsc --noEmit` → 0.

- [ ] **Step 3: Verify** the app still renders app-wide (sample routes). Push (full build gate).

- [ ] **Step 4: Commit + push**

```bash
git commit --only apps/web/src/components/layout/AppSidebar.tsx apps/web/src/app/layout.tsx -m "chore(rail): retire AppSidebar — rail is the verified default"
git push origin main
```

---

## Self-Review Notes

- **Spec coverage:** theming (P1), parity data (P2), chrome (P3), mobile (P4), default swap + pin (P5), `/settings` collision (P6), verification + retire (P7) — all spec sections mapped.
- **Rollback:** preserved through P1–P6 (AppSidebar wired until P5 swap, then present-but-unwired until P7).
- **Light-surface protection:** `.h10-shell` pin (Task 1.1 Step 3) keeps ads cockpit + `/products/next` light; verified Task 1.2 Step 2-3.
- **Type consistency:** `indicator` literal `'action'|'warning'|'disconnected'` defined in Task 2.2, resolved from `{key}` in Task 2.3, used through P3–P5. `AppNavRail` is the single export placed in the slot (P5) and the preview bed (P2–P4).
