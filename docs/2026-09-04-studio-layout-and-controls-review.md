# Product Edit Studio — layout & controls review (2026-09-04)

**Status:** review only. Nothing built, nothing committed. Written for the Owner's decision.
**Measured on:** local web :3000 → local API :8091, GALE-JACKET (`cmokmy3a40078pm0p1fvnu523`, 21 rows),
Chrome viewport **1728×906**, dpr 2, master and Amazon·DE scopes, all five tabs, the record drawer.
Every number below was read from the DOM or a screenshot in this session; nothing is inferred.

---

## 0. The one fact that outranks everything else

**Nothing of the studio is in git.** HEAD is `80f6cfb84` (2026-09-02). `git ls-files` returns **0**
files under `apps/web/src/app/products/[id]/edit/_studio/`; the folder is `??` in its entirety.
`docs/pes-claims.md` and `docs/2026-09-01-layout-v2-spec.md` are untracked too. Working tree:
149 tracked files modified (+12,501 / −1,995), 330 untracked entries. The product exists only on
this disk. No quality bar is reachable while that is true.

## 1. Layout — what is on screen, band by band (master, 1728×906)

| y | h | band | v2 spec §2.2 |
|---|---|---|---|
| 0 | 48 | product header (`.nds-detailhdr.dense`) | 48 ✅ |
| 48 | 40 | scope chips + tabs + market/locale (one row) | 40 ✅ |
| 89 | 40 | sheet toolbar | 40 ✅ |
| 129 | 57 | AG header + floating filters | 56 (±1) ✅ |
| 186 | 675 | rows viewport (21 rows × 36px, 32px thumbnails) | 678 ✅ |
| 861 | 36 | footer strip | 36 ✅ |
| 897 | 9 | gutter | 8 (±1) ✅ |

Rows = **74.5%** of the viewport; the sheet (toolbar→footer) = **89.2%**. The approved v2 layout is
what renders, to the pixel. **The frame is not the problem.** Master first rows at **3.5 s** from
navigation, Amazon·DE at **3.4 s** (warm API, 21 rows).

Channel scope differs in two structural ways: no floating-filter row (AG header **29** vs 57) and
13 columns / 1,877 px against master's 26 / 3,754 px.

## 2. Controls — the census (why "the chips look wrong")

Distinct control signatures visible in ONE viewport (Amazon·DE, Errors & Sync, Analytics, drawer):

| control | class | height | type | radius |
|---|---|---|---|---|
| Publish ▾ | `nds-btn` (md) | 30 | 13 / 600 | 8 |
| toolbar buttons ×8 (Missing required… Reload) | `nds-btn sm` | 28 | 12.5 / 600 | 8 |
| scope chips ×6 | `nds-scope` | 28 | 12.5 / 600·700 | 999 |
| tabs (scope row) | `nds-tab` | 31 | 13 / 600 | 0 |
| tabs (drawer) | `nds-tab` | **38** | 13 / 600 | 0 |
| market / locale switchers | `nds-listbox-btn` | 31 | 12.5 / 400 | 8 |
| Find… input | `nds-input xs` | 26 | 11.5 / 400 | — |
| **Dead / Retrying / Stuck / All** | `nds-pill btn` | **30** | **16 / 400** | 999 |
| 30 / 60 / 90 days | `nds-seg-opt` | 26 | 12.5 / 600 | 7 |
| "1 change" ×102 (Activity), Retry (Images) | `nds-btn sm` + link tint | 28 | 12.5 / 600 | 8 |
| row ⋯ (identity band) | `nds-btn` | **29** | 12.5 / 600 | 8 |
| cascade marks ×7 per row | `nds-btn nds-cascade-mark` | 18 | 11 / 500 | 999 |
| drawer close | `nds-modal-x` | 26 | 16 / 400 | 6 |
| drawer group rows ×7 | `nds-prow-action` | 33 | 13 / 500 | 0 |
| **Ask AI** (global FAB) | Tailwind, no DS class | **48** | 16 / 400 | 9999 |

Five heights (26 · 28 · 30 · 31 · 48) and four type sizes (11.5 · 12.5 · 13 · 16) on controls that
share a 40 px bar. The DS has **no control-height scale** (DS-GAPS DS1-7, open) — every height is
an emergent sum of padding + line-height, which is exactly how this happens.

### 2.1 The Errors & Sync chips — root cause, already on file
`ErrorsSyncConsole.tsx:200` renders them as `<Pill onClick>`. `.nds-pill.btn { font: inherit;
font-size: inherit; font-weight: inherit }` (primitives.css:1220) beats `.nds-pill`'s own
`11px / 600`, so a clickable pill takes the PAGE's type: **16 px / 400, 30 px tall** — measured.
Filed in `.claude/DS-GAPS.md` on **2026-08-26** ("the fix is one line in the DS"); never fixed.
Every future `Pill onClick` inherits the defect. The DS already has the right primitive:
`FilterChip` (`.nds-fchip`: 11.5 / 600, `aria-pressed`, `count`, 7.41:1 pressed state), used on
8 ads pages and **0 studio files**.

### 2.2 The toolbar "view chips" are the same mistake in a different coat
`Missing required (25)`, `Warnings (42)`, `Mapping errors (90)` are `Button size="sm"` carrying
`aria-pressed` — a filter toggle styled as a secondary button (DS-GAPS DS.1 audit says so). Same
role as the Errors facets, different component, different look.

### 2.3 Other inconsistencies, measured
- **Ask AI FAB** at y 834–882 overlaps the sheet's horizontal scrollbar (845–861) and footer
  (861–897). `--nds-fab-inset` exists for this; the studio never sets it. Tailwind, off-DS.
- **Drawer top = 56 px** (`.nds-drawer-dock { top: var(--nds-topbar-h, 56px) }`) on a route that
  removed the 56 px top bar: an 8 px sliver of the scope row shows above the panel, and it covers
  Customise · Export · Import · Reload and both switchers while open. All 7 record groups open
  **collapsed** (v2 §14.2 already ruled against this).
- Identity band header is **"Product"** on master, **"SKU"** on channel (`MasterSheet.tsx:1179`
  vs `ChannelSheet.tsx:1541`). Channel toolbar says **20 rows**, its footer **21 rows** (alias band
  counted once, not twice).
- 6 of 26 default-view headers truncate ("Bullet Poi…", "Country of O…", "Dangerous G…",
  "Item Nam…", "Product …", "Base Pr…") at the ruled 110/130 px widths.
- Channel cells carry up to three glyphs in 130 px (chevron · red ! · cascade mark) plus 7 cascade
  buttons per row; master cells carry link/pencil marks in a different position.
- Disabled scope chips (Shopify · WooCommerce · Etsy) are `opacity: .5`; the reason lives only in
  the tooltip.
- Tab switch **unmounts the sheet**: Sheet → Images → Sheet re-reads the whole scope
  ("Loading AMAZON · DE…" > 6 s after returning). Images tab showed "Loading images… Still waiting
  on the server. Retry" at 5 s and 8 s in this session (cause not measured).
- Analytics "Pricing" table renders **330 px** wide inside a full-width card and clips its columns.

## 3. Recommendation

**Keep the v2 frame. Do not restructure the layout.** It measures as approved, the account-scale
answer is already ruled (wave-4 D14.9: the studio is a family surface; thousands of SKUs land on
`/products/next` + jobs), and the only layout-level decision still open is app-wide chrome
(Owner item 34, Option A = full-height rail, the hub's recommendation) — that changes every page,
not the studio, and it needs DS.2's one layout grid first.

Spend the effort on **one control vocabulary**, fixed at the DS, then adopted, then gated:

1. **Push** (Owner). Nothing else is safe first.
2. **DS (one session, `design-system/` only):** mint `--nds-control-h-sm: 28px` and a bar height
   token; fix `.nds-pill.btn`; give `Tabs` a `size` that lands on 28 in a bar; a 28 px
   `Listbox` trigger; an "on chrome" `Button` variant for the FAB.
3. **Studio adopts (one pass per scope):** every control in the three 40 px bars is 28 px —
   Publish → `sm`, switchers → `sm`, row ⋯ → `sm`; every filter toggle (both sheets' view chips,
   Errors facets) → `FilterChip`; `Pill` is a status and never a control; `SegmentedControl` only
   for presentation choices (30/60/90). Scope chips stay the `ScopeBar` shape — they are the one
   deliberately distinct control (navigation). Drawer `top` → 0 on this route, first group open,
   DS icon button for close, tabs at the row's size. FAB inset set (or hidden on the studio).
   Identity label, footer count and floating filters unified across scopes.
4. **Gate:** a control census in pre-push — every interactive element inside the studio's bands
   must be one of {`nds-btn.sm`, `nds-fchip`, `nds-seg-opt`, `nds-scope`, `nds-tab`,
   `nds-listbox-btn`} at 28 px, derived from the DOM (the same shape as `check-editor-open.mjs`).
   That is what makes "no inconsistencies" survive the next lane.

Open question for the Owner: **which layout change did you have in mind?** Cost it against §1.

---

## 4. What landed — CT.1, 2026-09-04 23:20–23:50 (nothing committed; the Owner pushes)

Owner: "I just want you to fix it all … everything has to be AAA quality." Claim CT.1 in
`docs/pes-claims.md`. Session 45 (VW.1) owns the master/channel PARITY set and was mid-edit in
those files, so this pass did not touch `MasterSheet.tsx`, `ChannelSheet.tsx`, `master/columns.tsx`,
`renderers/cells.tsx`, `grid/editors/*`, `grid/filters/*` or `check-editor-open.mjs`.

### 4.1 Design system (apps/web AND apps/factory — mirrored by content)
| change | why |
|---|---|
| tokens `--nds-control-h-sm: 28px` · `--nds-control-h-md: 30px` (both `css-vars.ts`, regenerated) | the DS had no control-height scale (DS1-7); named from what `.nds-btn.sm` / `.nds-scope` / `.nds-btn` already measured |
| `--nds-toolbar-h` added to the factory fork | DS.1's #182 mint had never reached it |
| `.nds-pill.btn` drops `font: inherit` (keeps family + line-height) | the 2026-08-26 gap: a clickable Pill took the page's 16px / 400 |
| `.nds-btn.sm` pinned to the tier; `.nds-btn.inline { height: auto }` | 28 with a label, 29 with an icon; sentence buttons must never take a tier |
| `FilterChip size="md"` → `.nds-fchip.md` 28px; `.nds-fchip .t` is a flex row | the chip at toolbar height (Pill's `md` naming); Tailwind's `svg { display: block }` stacked a ⚠ above its label |
| `Tabs size="sm"` → `.nds-tabs.sm` | a tab strip INSIDE a 40px bar: sm-plus type, stretched to the strip, host draws the hairline |
| `.nds-listbox.sm .nds-listbox-btn` 28 (was 31) · `.nds-modal-x` 28 square (was 26) · `.nds-toolbar .nds-field.xs/.sm` 28 (was 26) | every bar control on one tier |

### 4.2 Studio
- `SheetToolbar.tsx`: the view chips (Missing required / Warnings / Mapping errors, both scopes) are
  `FilterChip size="md"` with `count`, not a `Button` carrying `aria-pressed`.
- `ErrorsSyncConsole.tsx`: the facets (Dead / Retrying / Stuck / All) are `FilterChip size="md"`; the
  cause row is the DS `PressableRow` (it was a `Button` restyled by a module class to 34px / 12px / 400).
- `PublishMenu.tsx`: the trigger is `sm` (28, was 30). `StudioBar.tsx`: `Tabs size="sm"`, and the
  scope row's right slot stretches so the tab indicator meets the row edge (tabs 39 in a 40 row).
- `RecordDrawer.tsx` + `drawer.module.css`: the pane strip is a 40px `--nds-toolbar-h` strip hosting
  `Tabs size="sm"` (was 38 beside a 31); `studio.module.css` sets `--nds-topbar-h: 0px` on the dock
  track so the fixed panel starts at y = 0 (was 56, the removed top bar's height).
- `studio.module.css`: every literal 40px is `var(--nds-toolbar-h)`; the page-local tab overrides
  are gone (the DS `sm` strip owns them).
- `AnalyticsAdsTab.tsx` + css: the small tables are exactly as wide as their columns
  (`tableWidth()`), so the 4-column pricing table no longer clips at the 380px floor.
- `CopilotMount.tsx`: the "Ask AI" FAB is not mounted on `/products/[id]/edit/studio` — the same
  opt-out the route already makes for the top bar; one regex to reverse.

### 4.3 The instrument
`scripts/check-control-census.mjs` (wired in `.githooks/pre-push` after the open-gesture gate): reads
six surfaces off the rendered DOM at 1728×906 and asserts (1) every control in the header, scope
row, toolbar and drawer strip is 28px, tabs at strip height; (2) every interactive element in the
frame carries a DS class from an allow-list; (3) every panel control is on a DS tier; (4) no FAB;
(5) the record panel starts at y = 0. Exit 2 (refused) when another gate is mid-run or the server
is down — never green over nothing. It reads only: every non-GET to `/api/` is aborted.

### 4.4 Measured after (1728×906, Amazon·DE, Errors & Sync, drawer)
| control | before | after |
|---|---|---|
| Publish ▾ | 30 | 28 |
| scope chips | 28 | 28 |
| tabs in the scope row / in the drawer | 31 / 38 | 39 / 39 in 40px strips |
| market · locale switchers | 31 | 28 |
| Find… field | 26 | 28 |
| toolbar view chips | `Button` 28 | `FilterChip md` 28, 11.5 / 600 |
| Dead / Retrying / Stuck / All | `Pill` 30, 16 / 400 | `FilterChip md` 28, 11.5 / 600 |
| drawer close | 26 | 28 |
| record panel top | 56 | 0 |
| Ask AI FAB | 48, Tailwind, over the scrollbar | absent |

### 4.5 Deliberately left, and to whom
- Session 45's parity set (Product vs SKU header, 20 vs 21 rows, floating filters on the channel
  scope, required marks, header truncation) — theirs, in flight.
- `SegmentedControl` at 26px (Analytics card header — not in a bar; a DS tier) and the DS `Input.sm`
  at 36px beside `Button.sm` at 28 OUTSIDE toolbars (147 consumer files): recorded in DS-GAPS, not
  moved app-wide in a studio pass.
- Disabled scope chips at opacity .5 with the reason only in the tooltip; channel cell glyph density
  (chevron + ! + cascade mark in 130px); the sheet remounting on every tab switch; the Images tab's
  "still waiting on the server": design or server questions, listed in §2.3, not control fixes.
- The `ebay.css` local `.nds-pill.btn` workaround is now redundant (another page; left).
- The push. Nothing here is in git.

### 4.6 The record
`scripts/check-control-census.mjs` run 4, 2026-09-04 23:48, load 2.68, fresh servers hosted by this
session: **6 / 6 surfaces green, 235 controls read, 0 off-DS, 0 off-tier, FAB absent everywhere,
record panel at y = 0.** (Run 2 at 23:38 had one real miss — the Errors & Sync cause row — fixed;
run 3 at 23:41 was taken against dead servers and is discarded.) Static gates green after the last
edit: css-parse · token-resolution · ds-conformance · raw-primitives · hex/radius/shadow ratchets ·
fork-drift · tokens:check (both apps); scoped typecheck clean on every file touched; factory tsc clean.

### 4.7 Follow-up, 2026-09-05 00:50–01:05 (still nothing committed)
- The Images tab loads in ~1 s against quiet servers (endpoint 200 in 1.0 s, 123 KB); the earlier
  "still waiting on the server" was starvation during other gates' runs, not a client defect.
- Its census found the last two off-tier controls: the DS `Select.sm` and `Input.sm` measured 31px
  beside 28px buttons (the schedule row). Both pinned to `--nds-control-h-sm` in both forks —
  §4.5's "Input.sm at 36" was wrong about the number; the DS `sm` family is now one height.
- The census gate gained two surfaces: `amazon·DE · images` and `ebay·IT · sheet` (a third
  coordinate on a different channel). Binary inputs (`Toggle`/`Switch`/`Checkbox`/`Radio`) are
  tier-exempt: DS controls at their own size, not bar boxes. Wrapped `Select`/`Input` are measured
  at their wrapper.
- **Run 5, 2026-09-05 00:5x, load 4.04: 8 / 8 surfaces green, 286 controls, 0 off-DS, 0 off-tier.**
  Static DS gates green; DS-GAPS append-only green.
- Layout refinements (§ the Owner's question, answered 2026-09-05 00:1x): (1) identity band 404 →
  ~300 + two-line headers, (2) header as a fourth 40px bar and the collapse deleted, (3) drawer
  starting below the product header with a one-line strip, (4) sheet kept mounted across tabs.
  (2) and (3) reverse approved v2 decisions and wait for the Owner's own word; (1) is in session
  45's files.
