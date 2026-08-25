# design-sync notes — Nexus Design System

## Shape & wiring (why this repo needs a scaffold)

- The DS lives at `apps/web/src/design-system/` **inside the Next.js app** — it is not a
  package and has no standalone build. `.design-sync/ds-pkg/` is the sync scaffold:
  a barrel (`index.ts`, mirroring the DS's own three barrels), a declaration-only
  `tsconfig.json`, `base.css`, `fonts/`, and `build.mjs`. It writes **only** into its own
  gitignored `dist/`; `apps/web` is read-only to it.
- `buildCmd` = `node .design-sync/ds-pkg/build.mjs`. It emits (1) the `.d.ts` tree the
  converter reads the API contract from and (2) `dist/ds.css`, one concatenated
  stylesheet, because `cfg.cssEntry` takes a single file.
- **All `cfg` paths resolve relative to PKG_DIR** (`.design-sync/ds-pkg`), including
  `tsconfig` and `extraFonts` — the field docs say "workspace-relative", but that is only
  the *containment bound*, not the resolution base. Repo-root-relative values silently
  print `! <field>: … not found — skipped` and the build continues degraded.
- `--node-modules` must be the **repo root** `node_modules`, not `apps/web/node_modules`
  (only 5 entries there; recharts / @dnd-kit / next are hoisted to the root).
- `--entry .design-sync/ds-pkg/index.ts`. The converter walks up from the entry to the
  nearest named `package.json`, which is what makes `ds-pkg` the PKG_DIR.

## Stylesheet order IS the cascade

`build.mjs` concatenates tokens → base → primitives → components → patterns → **a11y last**.
This DS resolves conflicts by source order, not specificity, so a11y.css must stay last.
`tokens.css` rides inside that file rather than in `tokens/`: `cfg.tokensGlob` only reaches a
package under `node_modules`, and this DS's tokens are a generated source file
(`tools/generate-tokens-css.ts`). **`tokens/` in the bundle is empty by design.**

## Fonts

The DS's own CSS says `font-family: inherit` everywhere — the host app supplies **Inter**
via `next/font/google` as `--font-sans`. Without it every design renders in browser-default
serif. `.design-sync/ds-pkg/fonts/` ships the real Inter variable woff2 (latin + latin-ext),
lifted verbatim from `apps/web/.next/static/media/`. Inter is SIL OFL 1.1 — redistribution
is permitted. `base.css` reproduces the single `body` rule from `apps/web/src/app/globals.css`
(family chain, smoothing, canvas colours) so the cascade has a root to inherit from.
The metric-matched `Inter Fallback` face lives in `base.css`, **not** `fonts/fonts.css`:
`extractFonts` only keeps `url()`-bearing rules, so a `local()`-only face there is dropped
and then reported as `[FONT_MISSING]`.

## Group labels

`.design-sync/overrides/source-kit.mjs` is a one-line fork that removes `'components'` from
the converter's `GENERIC_DIR`. Without it all 27 components collapse into a group called
`general`, which misrepresents a DS whose own vocabulary is primitives / components / patterns.
Declared in `cfg.libOverrides`. On a skill upgrade, diff it against the bundled
`lib/source-kit.mjs` and re-apply the one-line change.
`FilterField`, `ToastProvider` and `ToolbarDivider` are pinned via `componentSrcMap` — they
are secondary exports living inside another component's file, so the fuzzy src-find misses
them and they land in `general` with no JSDoc.

## Composition source

`apps/web/src/design-system/catalog/TokenCatalog.tsx` (1121 lines) is the DS team's own living
catalog and the canonical composition source — port from it before inventing. Realistic
domain content (ad campaigns, €, ACOS, marketplace names) is the house style. Second source:
real usage across `apps/web/src/app/**`. `catalog/` is excluded from the declaration build
(it is a demo surface, not API).

## Known render warns

- `[RENDER_THIN]` / `[RENDER_BLANK]` on unauthored components are **floor cards**, not
  failures — they disappear as previews are authored.

## Contracts: auxiliary types must be inlined (`gen-dts-props.mjs`)

The converter resolves props structurally but leaves **referenced named types as bare
names** — `Tabs.d.ts` said `items: TabItem[]` and never said what a `TabItem` is. The design
agent reads only that one file, so every such name is a hole in the contract. 21 of 60
components had one; `CSSProperties` was also emitted unqualified.

There is no config knob for auxiliary declarations: `cfg.dtsPropsFor` supplies a props
**body** only, and `lib/dts.mjs` always returns an empty `prelude` (emit.mjs would consume one).
So `.design-sync/ds-pkg/gen-dts-props.mjs` inlines the shapes structurally instead, reading
them out of the DS source **every run** rather than freezing them into config by hand.

**It is a second pass — it reads the emitted `.d.ts` bodies, so it must run between two builds:**

```sh
node .ds-sync/package-build.mjs … --out ./ds-bundle   # emit bodies
node .design-sync/ds-pkg/gen-dts-props.mjs            # patch cfg.dtsPropsFor
node .ds-sync/package-build.mjs … --out ./ds-bundle   # apply
```

Bugs worth remembering if it is ever edited (all fixed, all found by type-checking the
generated bodies in isolation before rebuilding — do that again after any change):
- `type X = …` alias capture must be balance-aware; a blank-line heuristic swallows the next
  declaration whole.
- Re-prefixing a React name twice yields `React.React.ReactNode` — qualify with a lookbehind.
- Substituting a generic name leaves its argument list (`Column<T>` → `{…}<T>`) — consume it.
- A union spliced into an array position needs parens: `A | B[]` parses as `A | (B[])`.
- A flattened alias can carry a trailing `;` which is a syntax error inside parens.

`cfg.dtsPropsFor` is **not** part of the grade key (`configSlicesFor` keys only provider,
storyImports, extraEntries, fork bytes, titleMap and overrides), so regenerating it never
invalidates preview grades. `cfg.provider` **is** — changing it re-keys every component.

## AccountSwitcher and the Next App Router

`AccountSwitcher` calls `usePathname`/`useRouter`/`useSearchParams` at render, so it throws
"invariant expected app router to be mounted" anywhere outside a Next App Router host.
Fixed **inside its own preview** (`.design-sync/previews/AccountSwitcher.tsx`) by mounting
`AppRouterContext`, `PathnameContext` and `SearchParamsContext` from
`next/dist/shared/lib/*.shared-runtime` around it. Deliberately NOT via `cfg.provider`: that
is in the global grade key, so one component's fix would re-key all 60 grades.
The component's own `initialData` prop is the fetch seam — no network in the preview.
**Re-sync risk:** those are Next internals (Next 16.2.4). If a Next major bumps and the card
breaks, check the module paths first.

## ✅ Two components used to depend on the consuming app's Tailwind build

`ToolbarButton` / `ToolbarDivider` (and part of `ColumnGroupModal`) are styled with **Tailwind
utilities**, not the DS's `.nds-*` convention. They therefore render unstyled anywhere the
host app's Tailwind build is absent — which is every design produced from this bundle.
Without the shim: ToolbarButton is raw UA button chrome and **ToolbarDivider is an invisible
dimensionless div** (`<div class="mx-1 h-4 w-px flex-shrink-0 bg-slate-200">`).

**This is also a live production bug, not just a preview gap.** `apps/web/tailwind.config.ts`
scans `./src/pages`, `./src/components`, `./src/app` — **not `./src/design-system`**. So these
utilities only reach the app when some *other* file happens to use the same class. Measured
against the real build (`apps/web/.next/static/chunks/*.css`): `h-7`, `w-px`, `bg-slate-200`
survive incidentally, but the count-badge's arbitrary values **`-right-0.5`, `min-w-[14px]`
and `text-[9px]` are emitted ZERO times** — the ToolbarButton badge is mis-rendered in
production today.

Sync-side fix: `.design-sync/ds-pkg/tailwind-shim.config.ts` + `tailwind-shim.in.css`
regenerate exactly those utilities from apps/web's own config on every build (88 rules,
preflight off), spliced into `ds.css` between `patterns.css` and `a11y.css`. `base.css` adds
the matching narrow reset (`button.flex.h-7.w-7`) plus the `--tw-*` variable defaults that
normally come from preflight — without those, `[TOKENS_MISSING]` fires and the transform /
transition utilities resolve to nothing.

**FIXED IN THE REPO, 2026-08-24** (commit alongside the DS `[CONFORMANCE]` changelog entry).
`ToolbarButton` / `ToolbarDivider` / `ColumnGroupModal` now carry `.nds-tbtn*`,
`.nds-tdivider` and `.nds-cgm-*` classes in the DS stylesheets, tokens throughout.
`token-guard.mjs` bans raw Tailwind palette classes in DS `.tsx` and is enforced in
`.githooks/pre-push`, so this cannot come back. The `content` globs were deliberately NOT
widened — the DS depends on nothing outside itself, which is the stronger guarantee.

**⚠ The shim is now inert and should be REMOVED on the next sync.** Its config scans exactly
those two files for Tailwind classes; both are now Tailwind-free, so it emits an empty
stylesheet. Removal is four pieces, and they must go together:
  1. `.design-sync/ds-pkg/tailwind-shim.config.ts` + `tailwind-shim.in.css` — delete.
  2. `build.mjs` §2b (the `npx tailwindcss` exec) and the `tailwind-shim.css` entry in its
     concat list — delete. That also drops a `npx tailwindcss` call from every build.
  3. `base.css` — drop the narrow `button.flex.h-7.w-7` reset AND the `--tw-*` variable
     defaults block. Nothing consumes them once the shim is gone.
  4. NOTES.md "Known render warns" — the `[TOKENS_MISSING]` for `--tw-*` line goes with it.
Not done in the repo session that fixed the components: verifying the removal needs a full
converter run, and a half-removed shim silently unstyles two cards. Do it as one step, then
check the ToolbarButton / ColumnCustomizer cards on the contact sheet before uploading.

## `_PreviewRouterHost` — why it lives in the bundle

Wrapping `AccountSwitcher` in Next's contexts **from the preview file does not work**: esbuild
bundles a second copy of Next's context module into the preview, so the preview's Provider and
the component's `useContext` are different instances and the invariant still throws. The host
must be in the same bundle as the component, so it is exported from
`.design-sync/ds-pkg/index.ts` (`preview-router-host.tsx`). The leading underscore keeps it out
of component discovery (`^[A-Z][A-Za-z0-9]*$`), so it never becomes a card or a contract.

## Wave learnings folded from A1 / B1 / P1

- **Two components share the name `Input`.** `@/components/ui/Input` takes `label`/`error`/`mono`;
  the DS `primitives/Input.tsx` takes none of them. Same trap for `AppShell`, `FilterPanel`,
  `FilterBar`, `BulkActionBar` — the app has local twins. Grepping `apps/web/src/app` finds the
  WRONG component for those. `TokenCatalog.tsx` is the only true call site for several patterns.
- **No `error`/`invalid` affordance exists on any field.** There is no `.nds-field.invalid`
  rule. The DS's honest answer is composition: label above, message below in
  `var(--status-danger-strong)`, `aria-invalid` on the control (`Input.CampaignForm` shows it).
- **`Pill tone="success"` is BLUE; `Tag tone="success"` is GREEN** — different token families,
  both intentional. An agent will get this wrong without being told.
- Fields are `inline-flex` and shrink-wrap; `style` on `Input` lands on the inner `<input>`, not
  the bordered wrapper. The portable width lever is the native `size` attribute.
- `Textarea`'s `rows` is inert (`min-height: 168px` wins). `RadioCard` has no visual disabled
  state. `Checkbox` indeterminate is ref-only. `Button` has no `loading` prop — the house
  pattern is a disabled Button with a Spinner in its children.
- `FilterField`'s `wide` prop collapses below 1320px, so at the 900px capture viewport the panel
  is always 3-up. True 6-col needs >1368px.
- `Tooltip`'s open state IS statically renderable via `:focus-within` + `autoFocus` on the
  trigger; only one `autoFocus` wins per composite card. `InfoTip` is `position:fixed` portalled,
  so forcing it open makes it float over neighbouring cells — deliberately not forced.
- `lucide-react` imports work inside preview `.tsx` and bundle correctly.
- **Presentation-only overrides (`cardMode`, `primaryStory`) do NOT invalidate grades** — the
  capture confirmed `carried forward` after applying 13 of them.

### Known render warns (checked on re-sync; an unrecorded warn is new)

- Floor-card `[RENDER_THIN]` / `[RENDER_BLANK]` on any component with no authored preview.

## Wave-2 findings (each verified by the orchestrator before recording)

- **CONFIRMED repo bug — `SAMPLE_IMG` is double-encoded.** `catalog/TokenCatalog.tsx:274-278`
  pre-escapes `#` as `%23` inside the literal AND wraps it in `encodeURIComponent`, so the SVG
  parser receives `fill='%2523e7f0fd'` — invalid, and it falls back to solid black. The catalog
  never shows it because its own ImageUpload demo passes `value={null}`. Anyone reusing the
  constant gets a black square.
- **CONFIRMED — `Tabs` at `size="md"` has no icon/count spacing.** `components.css:77` is the
  base `.nds-tab`; the inline-flex + `gap:7px` treatment is at `:113`, scoped to
  `.nds-tabs.lg`. A `md` tab with an icon renders the glyph flush against the label.
- **CONFIRMED — `PerformanceGraph` takes `left` and `right` as two SEPARATE series props**, not
  a `ChartSeries[]`. (The batch brief said otherwise and was wrong.)
- **CONFIRMED — `AccountsPanel`/`AccountSwitcher` channel keys are UPPERCASE.** `CHANNEL_LABEL`
  (`AccountSwitcher.tsx:100`) is keyed `AMAZON`/`EBAY`/`SHOPIFY`; `channelName()` falls through to
  the raw value, so a lowercase `channel` renders an un-prettified "amazon". The first
  AccountSwitcher preview had this wrong and was corrected.
- **CONFIRMED — recharts animates on mount and the harness screenshots mid-animation.**
  `<Line>` walks `stroke-dasharray` over 1.5s; `BurnDownChart` passes `isAnimationActive={false}`
  but `PerformanceGraph` neither sets nor forwards it, so lines captured ~57% drawn, at a
  different point each run. `page.clock.setFixedTime` does not help (react-smooth runs on rAF).
  Pinned in the preview with a module-scope `.recharts-line-curve{stroke-dasharray:none!important}`.
  **Any future recharts component that doesn't disable its own animation will do the same** —
  promote that rule to shared preview CSS if more arrive.
- **FALSE, do not propagate — "there is no `--font-mono`, `Tag.tsx` renders SKUs in Inter."**
  Wrong twice: `Tag.tsx` has no mono styling at all, and the DS stylesheets hard-code
  `ui-monospace, SFMono-Regular, Menlo, monospace` (`primitives.css:548`, `components.css:1456`)
  rather than referencing the variable. `var(--font-mono)` appears only in `ads.css` (2 rules),
  and the app supplies it at runtime via `next/font` JetBrains Mono (`layout.tsx:28,75`) with a
  literal fallback chain. Nothing to fix.

### Component-source improvements worth making in the repo (not sync fixes)

- `AccountsPanel` has no `initialData` seam although `AccountSwitcher` does — its preview has to
  stub `window.fetch` to reach loaded/degraded/failed states.
- `DateField` / `DateRangePicker` keep `open` private with no `defaultOpen`, so the month grid,
  presets rail and `.nds-dp-day` styling are unreachable from any static card.
- `ToolbarButton` / `ToolbarDivider` / `ColumnGroupModal`'s grip should get `.nds-*` classes
  so they stop depending on the consuming app's Tailwind build (see the 🔴 section above).

## Overlay components — how their cards were made to render

Five of the eight overlays expose **no `open` prop**; their previews open them imperatively from a
mount effect (`.click()` survives because outside-close listens on `mousedown`; `Combobox` needs the
native value setter plus a bubbling `input` event). Nothing is hand-written markup — `ToastProvider`
raises real toasts through the real `useToast` API.

- **`useToast` imports fine even though it is not in `manifest.exported`** — the package shim does
  `export * from` the raw bundle global, so any non-component named export is reachable from a preview.
- **`Drawer` draws a UA focus ring in capture that production never shows**: it claims panel focus
  programmatically and, with no prior interaction, Chrome resolves `:focus-visible`. Fixed through the
  component's own contract — it only claims focus when nothing inside has, and React's `autoFocus`
  runs first, so each cell autofocuses the control a keyboard user should land on. Not a CSS hack.
- **`Combobox` shows the query, not the selection, while open.** Surprising but real; the `OpenList`
  cell documents it rather than dodging it.
- **`Drawer.overlay` is only a scrim** — the caller supplies the whole confirm surface.

### 🔴 `viewport` is NOT grade-free — `cardMode` / `primaryStory` are

`configSlicesFor().componentFor()` strips only the presentation-only knobs. Adding a `viewport`
override re-keys that component's grade and forces a re-capture and re-grade. Consequence accepted
here: `Modal size="xl"` clamps to ~860px of its declared 920px at the 900px capture viewport, and the
cell's grade note says so. Reach for `viewport` only when you are ready to re-grade.

### The default card is not what the grading sheet shows

Grading reads `?story=` captures — one cell at a time. The **browsable** card is `<Name>.html` with no
query, rendering every export at once, and that is where portalled overlays collide: four Modals stack
over four superimposed scrims, three Drawers stack on one right edge, two toast viewports land at the
same fixed coordinates, and `HoverCard`'s `:focus-within` reveal can only fire for one element per
document. Always open the default card before declaring an overlay component done.

## Re-sync risks — what can silently go stale

- **🔴 This bundle was built from a working tree containing another session's UNCOMMITTED DS
  changes.** At upload time (2026-08-24) the `.nds-tbtn*` / `.nds-tdivider` /
  `.nds-cgm-*` conformance work existed only as unstaged edits to `ToolbarButton.tsx`,
  `ColumnGroupModal.tsx`, `AccountSwitcher.tsx`, `BurnDownChart.tsx`, `primitives.css`,
  `components.css`, `tokens.css`, `colors.ts` and `css-vars.ts`. The five affected components
  were re-captured and re-graded against that state, and the uploaded bundle matches it exactly
  (`bundleSha12 a943b17b68ba`). **If those edits are reworked or dropped before landing, the
  published cards describe code that does not exist** — re-sync and the diff will show it.
- The **Tailwind shim is now dead** — it emits only Tailwind's unconditional preamble
  (`.visible`, `.transform`, `.filter`, `.transition`; 700 bytes, down from 6.7 KB). Remove it
  per the four-step list above, as one step, with a full converter run.
- `_PreviewRouterHost` imports Next internals (`next/dist/shared/lib/*.shared-runtime`, Next
  16.2.4). A Next major bump can move those paths; the AccountSwitcher card breaks first.
- The Inter woff2 in `ds-pkg/fonts/` were lifted from `apps/web/.next/static/media/`. They are
  committed, so they survive a clean, but they are a **snapshot** — if the app changes its font
  or subsets, these do not follow automatically.
- `gen-dts-props.mjs` must always run via `refresh-contracts.mjs` (clear → build → gen → build).
  Calling it twice in a row silently drops already-fixed components out of `cfg.dtsPropsFor`.
- Grades live in the gitignored `.design-sync/.cache/`; the durable carry-forward is the
  uploaded `_ds_sync.json`. A fresh clone re-verifies only what the anchor says changed.

## 🔴 The card harness clips every in-flow overlay — fixed globally, and guarded

`.ds-cell` in the generated card HTML (`lib/emit.mjs`) is `{overflow:hidden; transform:translateZ(0)}`
and the page is `body{padding:24px}`. Any overlay escaping its trigger's box was sliced off.
**Only `InfoTip` survives natively** — it portals to `<body>`; every other DS overlay is in-flow:
`.nds-tooltip > .tip` and `.nds-hovercard > .hc` open ABOVE; `.nds-menu`,
`.nds-ms-pop`, `.nds-combo-pop`, `.nds-dp-pop`, `.nds-taginput-menu`,
`.nds-acct-panel` open BELOW. **`cardMode:"single"` does NOT help** — it still uses `.ds-cell`.

🔴 **Do not fix this per component.** The first attempt patched the eleven "overlay components"
and the operator immediately found more: `ToolbarDivider` clips because its story composes
`ToolbarButton`s, and the filter patterns clip because they contain selects. Anything can compose
anything, so the property belongs to the harness, not to a list of components.

**The fix — two rules in `ds-pkg/base.css`, which every card loads via `_ds_bundle.css`:**

```css
.ds-grid > .ds-cell { overflow: visible; }   /* (0,2,0) — the harness rule is (0,1,0) and its
                                                <style> loads AFTER this sheet, so a bare
                                                `.ds-cell` selector loses the cascade */
html > body { padding: 72px 64px; }          /* room for a bubble centred near the page edge */
```

Both are inert outside the harness — no product page has a `.ds-cell` or `.ds-grid`.

**The guard: `ds-pkg/check-clipping.mjs`, run automatically as step 4 of every `build.mjs`.**
It loads all 59 cards in Chromium, opens what can be opened, and fails if any `.ds-cell` computes
`overflow` other than `visible`, or if anything renders outside the viewport. It found two cases
the CSS alone did not fix — `DataGrid` (a 5-column grid wider than a cell) and `Tooltip` (a centred
bubble at the row's left edge), both resolved with `cardMode:"column"` plus an indent — and it is
negative-tested both ways: reintroduce `overflow:hidden` on one card and it names the cells; push
an element off-viewport and it reports the box.

## 🔴 …and fixing the crop EXPOSED a second bug: the next story paints over the overlay

Reported by the operator with a screenshot the day after the crop fix shipped: the Combobox card's
dropdown was no longer sliced, but the *next* story's heading, its `Marketplace` label and its
search input were drawn straight through the open list. Two independent bugs with one symptom —
"I cannot read the dropdown" — and fixing the first is what made the second visible.

**Cause: `.ds-cell` carries `transform: translateZ(0)`, so every cell is its own stacking
context.** The overlay's own z-index (40 for combo/menu pops, 50 for listboxes, 1000 for portal
tips) is therefore scoped *inside* its cell and cannot order it against anything outside; sibling
cells then paint in DOM order, so cell N+1 lands on top of whatever cell N let escape.

**The transform is deliberate upstream** — it makes the cell the containing block for
`position: fixed` descendants, so a pattern's fixed action bar renders in its own card instead of
pinned to the viewport. Removing it trades this bug for a worse one. The cells get an explicit
paint order instead (`base.css`):

```css
.ds-grid > .ds-cell:nth-child(1) { z-index: 24 }   /* …descending to nth-child(24) { z-index: 1 } */
.ds-grid > .ds-cell:hover,
.ds-grid > .ds-cell:focus-within { z-index: 60 }
```

Two rules because they cover opposite directions: descending order handles every **downward**
overlay, and only the active-cell rule can lift an **upward** one (tooltips and hover cards open
onto the story *above* them). Cards top out at 5 stories (`ImageUpload`), so 24 is headroom.

### Three ways this check lied before it worked

The guard grew with the bug; each of these passed a visibly broken card.

1. **One viewport is not enough.** Occlusion needs a later story *below* an earlier one, so it only
   exists once the `auto-fit` grid collapses. Combobox at 1200px: clean. At 640px: 55 occluded
   points. The check now sweeps **640 / 900 / 1200**.
2. **It never opened the thing it was asserting about.** The original opened one trigger per card
   from a three-selector list; the Combobox card has no toolbar button, so nothing opened, no panel
   existed, and it reported the card clean. It now focuses a trigger in **every cell in turn**, and
   a card with overlay markup where nothing opened *and* no panel ever rendered is a **failure**,
   not a pass.
3. **It invented failures.** Flagging `Badge`, `Divider`, `Kbd`, `Pill` as "unverified" is noise —
   they have no overlay to verify. And an overlay covering *another overlay* is legitimate: two
   open panels must resolve somehow and the top one stays readable. The rule is narrow on purpose:
   **an overlay may be covered by another overlay, never by ordinary story content.**

Negative-tested both directions: run it against a bundle built before the `base.css` fix and it
names the exact card, width, story pair and point count —
`Combobox @640px: MarketplacePicker's overlay covered by NoMatches at 55 points`.

**The DS stylesheets themselves are clean.** Every `transform`/`filter` in `primitives.css`,
`components.css` and `patterns.css` is an icon rotation, a toggle knob, a spinner or a
drawer/toast animation — none wraps an overlay. This is a harness property, not a DS defect, which
is why the product does not show it and the cards did.

### Why the grades never caught it

A tooltip exists only while hovered or focused. Every one of these cards graded `good` from a
screenshot in which the overlay **was not rendered at all**. An overlay whose open state is not
forced is *ungraded*, not verified. The operator found it by using the pane; the geometry check now
covers what a static image cannot.

Three component-specific gotchas worth keeping:

- An overlay centred on its trigger (`left:50%; translateX(-50%)`) clips **sideways** when the
  trigger sits near a page edge — `overflow:visible` cannot help. Indent the trigger.
- `ToolbarButton` has a **closed prop list** with no rest spread, so `autoFocus` is silently
  dropped. Its tip is revealed by the DS's own `:focus-within`, so its preview focuses the button
  on mount (`ref.current?.querySelector('button.nds-tbtn')?.focus()`).
- Only **one** element per document can hold focus, so in a composite card only the first
  `autoFocus` story shows its overlay — `Tooltip.OpenBubble` is the known case, and its per-story
  capture does show the bubble.
