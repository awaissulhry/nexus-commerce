# Design System — AUDIT (The Map)

> **Task 0.1** of the *Design System — Consistency & Hardening* engagement
> (`docs/superpowers/plans/2026-06-27-design-system-consistency-hardening.md`).
> This is the exhaustive, read-only inventory the engagement is judged against,
> and the **authoritative source** for the `--h10-* → platform-semantic` mapping
> (consumed verbatim by Tasks 1.2 + 2.2) and the per-value tone remap (consumed
> by Tasks 3.1–3.4).
>
> **Snapshot:** `apps/web/src/design-system` — 18 primitives + 21 components +
> 8 patterns = **47 runtime `.tsx`**; token layer (`tokens/*.ts` + `styles/tokens.css`);
> living catalog (`catalog/TokenCatalog.tsx`); guard (`tools/token-guard.mjs`);
> 8 governance docs. Generated 2026-06-27. No `--h10-*` value moves in this engagement.

---

## 0. How to read this

- **Tiers** (per `styles/tokens.css` `:root`, which is explicitly 3-tiered):
  - **Tier 1 — primitive ramps:** raw scale stops (`--h10-blue-600`, `--h10-grey-150`, …) + the `*-rgb` shadow/focus bases. Never consumed by component CSS *except* where a definition composes one (and the ~13 raw-ramp reaches this audit flags as defects).
  - **Tier 2 — semantic roles:** the meaning layer components are *supposed* to consume (`--h10-text`, `--h10-bg`, `--h10-border`, `--h10-primary`, `--h10-success-soft`…). These are what the new platform-semantic aliases will mirror.
  - **Tier 3 — component tokens:** purpose-built chip/structure tokens (`--h10-pill-*`, `--h10-badge-*`, `--h10-targeting-*`, radius/shadow/focus/rail/dim/type).
- **Platform-semantic target:** the new alias name a Tier-2 *core color role* will get (Task 1.2), or **"DS-only — stays `--h10-*`"** for everything with no platform counterpart.
- **Contract C1–C6** (spec §3): C1 styling via `.h10-ds-*` + semantic tokens (no raw hex / raw Tailwind palette / raw `--h10-*-NNN` ramp in component CSS) · C2 canonical `tone`/`size`/`variant` vocabulary · C3 component + all public types exported via barrel · C4 forwards `ref` and merges `className`; consistent controlled pattern · C5 catalog entry in every relevant state · C6 a11y (focus-visible, ARIA, keyboard, reduced-motion, AA contrast).

---

## 1. Token register

Every `--h10-*` defined in `styles/tokens.css` `:root` (116 total), in file order, with tier and platform-semantic target. The `.dark` block re-declares 14 of the Tier-2 roles (text/surface/border) with provisional inverted values; because the aliases point at the `--h10-*` role names, dark is covered transitively (no separate alias rows needed).

### Tier 1 — primitive ramps (DS-only — stay `--h10-*`)

| `--h10-*` | Value | Target |
|---|---|---|
| `--h10-white` | `#ffffff` | DS-only — stays `--h10-*` |
| `--h10-blue-50` | `#eef5ff` | DS-only — stays `--h10-*` |
| `--h10-blue-100` | `#e7f0fd` | DS-only — stays `--h10-*` |
| `--h10-blue-200` | `#cfe0fb` | DS-only — stays `--h10-*` |
| `--h10-blue-600` | `#1f6fde` | DS-only — stays `--h10-*` |
| `--h10-blue-700` | `#1a60c4` | DS-only — stays `--h10-*` |
| `--h10-blue-800` | `#134da3` | DS-only — stays `--h10-*` |
| `--h10-blue-900` | `#0a4ba8` | DS-only — stays `--h10-*` |
| `--h10-grey-25` | `#f7f9fb` | DS-only — stays `--h10-*` |
| `--h10-grey-50` | `#f4f6f9` | DS-only — stays `--h10-*` |
| `--h10-grey-75` | `#f1f4f8` | DS-only — stays `--h10-*` |
| `--h10-grey-100` | `#eef1f5` | DS-only — stays `--h10-*` |
| `--h10-grey-150` | `#e6e9ee` | DS-only — stays `--h10-*` |
| `--h10-grey-200` | `#d8dde4` | DS-only — stays `--h10-*` |
| `--h10-grey-300` | `#c2c9d3` | DS-only — stays `--h10-*` |
| `--h10-grey-400` | `#aeb6c2` | DS-only — stays `--h10-*` |
| `--h10-grey-450` | `#98a2b3` | DS-only — stays `--h10-*` |
| `--h10-grey-500` | `#8a93a1` | DS-only — stays `--h10-*` |
| `--h10-grey-600` | `#5b6573` | DS-only — stays `--h10-*` |
| `--h10-grey-700` | `#3a4452` | DS-only — stays `--h10-*` |
| `--h10-grey-800` | `#2b3440` | DS-only — stays `--h10-*` |
| `--h10-grey-900` | `#1c2530` | DS-only — stays `--h10-*` |
| `--h10-rail-surface` | `#f1f3f5` | DS-only — stays `--h10-*` |
| `--h10-rail-line` | `#e3e7ec` | DS-only — stays `--h10-*` |
| `--h10-green-soft` | `#dcfce7` | DS-only — stays `--h10-*` |
| `--h10-green-500` | `#1e9e62` | DS-only — stays `--h10-*` |
| `--h10-green-600` | `#15a34a` | DS-only — stays `--h10-*` |
| `--h10-green-700` | `#15803d` | DS-only — stays `--h10-*` |
| `--h10-red-soft` | `#fde8e8` | DS-only — stays `--h10-*` |
| `--h10-red-500` | `#e5484d` | DS-only — stays `--h10-*` |
| `--h10-red-600` | `#d4493f` | DS-only — stays `--h10-*` |
| `--h10-red-700` | `#c0392b` | DS-only — stays `--h10-*` |
| `--h10-amber-soft` | `#fdf3d3` | DS-only — stays `--h10-*` |
| `--h10-amber-600` | `#b87503` | DS-only — stays `--h10-*` |
| `--h10-amber-700` | `#c2410c` | DS-only — stays `--h10-*` |
| `--h10-amber-text` | `#9a6700` | DS-only — stays `--h10-*` |
| `--h10-purple-bg` | `#f3e8ff` | DS-only — stays `--h10-*` |
| `--h10-purple-600` | `#7400bc` | DS-only — stays `--h10-*` |
| `--h10-purple-700` | `#6d28d9` | DS-only — stays `--h10-*` |
| `--h10-cyan-bg` | `#e0f2fe` | DS-only — stays `--h10-*` |
| `--h10-cyan-700` | `#0e7490` | DS-only — stays `--h10-*` |
| `--h10-amazon` | `#232f3e` | DS-only — stays `--h10-*` |
| `--h10-shadow-rgb` | `20 28 38` | DS-only — stays `--h10-*` |
| `--h10-focus-rgb` | `31 111 222` | DS-only — stays `--h10-*` |

### Tier 2 — semantic roles

| `--h10-*` | Value | Tier | Platform-semantic target |
|---|---|---|---|
| `--h10-text` | `var(--h10-grey-900)` | semantic role | **`--text-primary`** |
| `--h10-text-2` | `var(--h10-grey-600)` | semantic role | **`--text-secondary`** |
| `--h10-text-3` | `var(--h10-grey-500)` | semantic role | **`--text-tertiary`** |
| `--h10-text-strong` | `var(--h10-grey-700)` | semantic role | DS-only — stays `--h10-*` |
| `--h10-text-disabled` | `var(--h10-grey-400)` | semantic role | **`--text-disabled`** |
| `--h10-text-inverse` | `var(--h10-white)` | semantic role | DS-only — stays `--h10-*` |
| `--h10-text-link` | `var(--h10-blue-600)` | semantic role | **`--text-link`** |
| `--h10-bg` | `var(--h10-grey-50)` | semantic role | **`--surface-canvas`** |
| `--h10-surface` | `var(--h10-white)` | semantic role | **`--surface-card`** |
| `--h10-surface-raised` | `var(--h10-grey-25)` | semantic role | DS-only — stays `--h10-*` |
| `--h10-surface-sunken` | `var(--h10-grey-100)` | semantic role | **`--surface-sunken`** |
| `--h10-surface-hover` | `var(--h10-grey-75)` | semantic role | DS-only — stays `--h10-*` |
| `--h10-wash-primary` | `var(--h10-blue-50)` | semantic role | DS-only — stays `--h10-*` |
| `--h10-rail-bg` | `var(--h10-rail-surface)` | semantic role | DS-only — stays `--h10-*` |
| `--h10-border` | `var(--h10-grey-200)` | semantic role | **`--border-default`** |
| `--h10-border-subtle` | `var(--h10-grey-150)` | semantic role | **`--border-subtle`** |
| `--h10-border-strong` | `var(--h10-grey-300)` | semantic role | **`--border-strong`** |
| `--h10-rail-border` | `var(--h10-rail-line)` | semantic role | DS-only — stays `--h10-*` |
| `--h10-primary` | `var(--h10-blue-600)` | semantic role | **`--color-primary`** |
| `--h10-primary-hover` | `var(--h10-blue-700)` | semantic role | DS-only — stays `--h10-*` |
| `--h10-primary-dark` | `var(--h10-blue-800)` | semantic role | DS-only — stays `--h10-*` |
| `--h10-primary-soft` | `var(--h10-blue-100)` | semantic role | **`--color-primary-soft`** |
| `--h10-primary-ghost-border` | `var(--h10-blue-200)` | semantic role | DS-only — stays `--h10-*` |
| `--h10-success-soft` | `var(--h10-green-soft)` | semantic role | **`--status-success-soft`** |
| `--h10-success` | `var(--h10-green-600)` | semantic role | **`--status-success-line`** |
| `--h10-success-strong` | `var(--h10-green-700)` | semantic role | **`--status-success-strong`** |
| `--h10-live` | `var(--h10-green-500)` | semantic role | DS-only — stays `--h10-*` |
| `--h10-danger-soft` | `var(--h10-red-soft)` | semantic role | **`--status-danger-soft`** |
| `--h10-danger` | `var(--h10-red-500)` | semantic role | **`--status-danger-line`** |
| `--h10-danger-strong` | `var(--h10-red-700)` | semantic role | **`--status-danger-strong`** |
| `--h10-warning-soft` | `var(--h10-amber-soft)` | semantic role | **`--status-warning-soft`** |
| `--h10-warning` | `var(--h10-amber-600)` | semantic role | **`--status-warning-line`** |
| `--h10-warning-strong` | `var(--h10-amber-700)` | semantic role | **`--status-warning-strong`** |
| `--h10-info-soft` | `var(--h10-blue-100)` | semantic role | **`--status-info-soft`** |
| `--h10-info` | `var(--h10-blue-600)` | semantic role | **`--status-info-line`** |

> **Note (Task 2.1 dependency):** the raw-ramp fix needs a `--status-info-strong` alias (`var(--h10-blue-700)`) that does **not** exist in `tokens.css` today — it must be added to `css-vars.ts` when `.h10-ds-tag.info`'s `--h10-blue-700` foreground is repointed. `--h10-text-strong` (Tier-2, DS-only) is the target for `.h10-ds-tag.neutral`'s `--h10-grey-700` foreground.

### Tier 3 — component tokens (all DS-only — stay `--h10-*`)

| `--h10-*` | Value | Group |
|---|---|---|
| `--h10-pill-ok-fg` | `var(--h10-blue-900)` | status pill |
| `--h10-pill-ok-bg` | `#d2e6fc` | status pill |
| `--h10-pill-warn-fg` | `var(--h10-amber-text)` | status pill |
| `--h10-pill-warn-bg` | `var(--h10-amber-soft)` | status pill |
| `--h10-pill-arch-fg` | `#6b7480` | status pill |
| `--h10-pill-arch-bg` | `var(--h10-grey-100)` | status pill |
| `--h10-pill-err-fg` | `var(--h10-danger-strong)` | status pill |
| `--h10-pill-err-bg` | `var(--h10-danger-soft)` | status pill |
| `--h10-badge-sp-fg` | `var(--h10-purple-700)` | program badge |
| `--h10-badge-sp-bg` | `var(--h10-purple-bg)` | program badge |
| `--h10-badge-sd-fg` | `var(--h10-cyan-700)` | program badge |
| `--h10-badge-sd-bg` | `var(--h10-cyan-bg)` | program badge |
| `--h10-badge-sb-fg` | `var(--h10-amber-700)` | program badge |
| `--h10-badge-sb-bg` | `#fef3c7` | program badge |
| `--h10-targeting-auto` | `var(--h10-blue-800)` | targeting chip |
| `--h10-targeting-manual` | `var(--h10-purple-600)` | targeting chip |
| `--h10-radius-pill` | `4px` | radius |
| `--h10-radius-sm` | `6px` | radius |
| `--h10-radius-md` | `7px` | radius |
| `--h10-radius-lg` | `8px` | radius |
| `--h10-radius-xl` | `10px` | radius |
| `--h10-radius-2xl` | `12px` | radius |
| `--h10-radius-3xl` | `14px` | radius |
| `--h10-radius-round` | `999px` | radius |
| `--h10-shadow-card` | `0 6px 22px rgb(var(--h10-shadow-rgb) / 0.16)` | elevation |
| `--h10-shadow-menu` | `0 12px 30px rgb(var(--h10-shadow-rgb) / 0.16)` | elevation |
| `--h10-shadow-pop` | `0 16px 40px rgb(var(--h10-shadow-rgb) / 0.2)` | elevation |
| `--h10-shadow-modal` | `0 18px 48px rgb(var(--h10-shadow-rgb) / 0.28)` | elevation |
| `--h10-shadow-rail` | `8px 0 30px rgb(var(--h10-shadow-rgb) / 0.13)` | elevation |
| `--h10-shadow-tip` | `0 10px 26px rgb(var(--h10-shadow-rgb) / 0.3)` | elevation |
| `--h10-focus-ring` | `0 0 0 2px rgb(var(--h10-focus-rgb) / 0.12)` | focus |
| `--h10-rail-collapsed` | `66px` | structural dim |
| `--h10-rail-expanded` | `344px` | structural dim |
| `--h10-row-nav` | `46px` | structural dim |
| `--h10-icon-zone` | `50px` | structural dim |
| `--h10-font-sans` | `var(--font-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` | type |
| `--h10-font-smoothing` | `auto` | type |

**Totals:** 116 `--h10-*` in `:root` — 44 Tier-1 (ramps + `*-rgb`), 35 Tier-2 (semantic roles), 37 Tier-3 (component tokens). Of the 35 Tier-2 roles, **24 get a platform-semantic alias** (the core color-role mapping below); 11 stay DS-only. `.dark` re-declares 14 Tier-2 roles.

---

## 2. The `--h10-* → platform-semantic` mapping table

**Authoritative** for Tasks 1.2 + 2.2 (copied verbatim from the plan, Task 0.1). Core color roles only — added as value-preserving `var(--h10-*)` aliases; **no value moves.**

| `--h10-*` (current) | Platform-semantic alias (new) |
|---|---|
| `--h10-text` | `--text-primary` |
| `--h10-text-2` | `--text-secondary` |
| `--h10-text-3` | `--text-tertiary` |
| `--h10-text-disabled` | `--text-disabled` |
| `--h10-text-link` | `--text-link` |
| `--h10-bg` | `--surface-canvas` |
| `--h10-surface` | `--surface-card` |
| `--h10-surface-sunken` | `--surface-sunken` |
| `--h10-border` | `--border-default` |
| `--h10-border-subtle` | `--border-subtle` |
| `--h10-border-strong` | `--border-strong` |
| `--h10-primary` | `--color-primary` |
| `--h10-primary-soft` | `--color-primary-soft` |
| `--h10-success-soft` | `--status-success-soft` |
| `--h10-success` | `--status-success-line` |
| `--h10-success-strong` | `--status-success-strong` |
| `--h10-warning-soft` | `--status-warning-soft` |
| `--h10-warning` | `--status-warning-line` |
| `--h10-warning-strong` | `--status-warning-strong` |
| `--h10-danger-soft` | `--status-danger-soft` |
| `--h10-danger` | `--status-danger-line` |
| `--h10-danger-strong` | `--status-danger-strong` |
| `--h10-info-soft` | `--status-info-soft` |
| `--h10-info` | `--status-info-line` |

**DS-only (no alias, stay `--h10-*`):** all `--h10-*-NNN` ramps, `--h10-surface-raised/hover`, `--h10-wash-primary`, `--h10-text-strong/inverse`, `--h10-primary-hover/dark/ghost-border`, `--h10-live`, `--h10-rail-*`, `--h10-radius-*`, `--h10-shadow-*`, `--h10-focus-ring`, `--h10-pill-*`, `--h10-badge-*`, `--h10-targeting-*`, `--h10-row-nav`, `--h10-icon-zone`, `--h10-font-*`.

---

## 3. Per-component register

47 runtime components (18 primitives + 21 components + 8 patterns). For each: file, props, tone/size axis, catalog coverage, a11y notes, and C1–C6 verdict.

**Cross-cutting a11y baseline** (`styles/a11y.css`): `@media (prefers-reduced-motion: reduce)` neutralizes all `[class*='h10-ds-']` animation/transition (C6 motion ✓ system-wide); `:focus-visible` ring is provided for `.h10-ds-navitem/.tab/.pgbtn/.fpanel-toggle/.builder-navitem`; `.h10-ds-btn/.select/.toggle/.seg-opt/.dropzone` ring in their own CSS.

### Primitives (18)

| # | Component (file) | Props | tone/size axis | Catalog | A11y notes | C1 | C2 | C3 | C4 | C5 | C6 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Badge** (`primitives/Badge.tsx`) | `tone: BadgeTone`, `children` | tone = `sp\|sd\|sb\|auto\|manual` (mislabeled — it's an ad-program axis, not a color tone) | ✅ | static `<span>`; no interactivity (decorative) | ✅ | ❌ prop named `tone` but values are program codes; type `BadgeTone` misnamed (→ `AdProgram`/`program`, Task 3.5) | ✅ | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 2 | **Button** (`primitives/Button.tsx`) | extends `ButtonHTMLAttributes`; `variant?: ButtonVariant`, `size?: ButtonSize`, `children?` | variant = `primary\|secondary\|ghost` (emphasis, kept distinct from tone ✓); size = `md\|sm` | ✅ | native `<button>`; `:focus-visible` ring (primitives.css:33); spreads `...rest` (aria-* pass through) | ✅ | ✅ `variant`/`size` canonical for the emphasis/size axes | ✅ | ⚠ merges `className`; no `ref` forward (not `forwardRef`) | ✅ | ✅ |
| 3 | **Checkbox** (`primitives/Checkbox.tsx`) | extends `InputHTMLAttributes` (minus `type`); `label?` | — | ✅ | native `<input type=checkbox>` in `<label>`; `accent-color`; `disabled` state; spreads `...rest` | ✅ | ✅ (n/a) | ✅ | ⚠ merges `className`; no `ref` forward | ✅ | ✅ |
| 4 | **Divider** (`primitives/Divider.tsx`) | `orientation?: 'horizontal'\|'vertical'`, `className?` | — | ✅ | `<hr aria-orientation>` | ✅ | ✅ (n/a) | ✅ | ⚠ merges `className`; no `ref` | ✅ | ✅ |
| 5 | **Input** (`primitives/Input.tsx`) | extends `InputHTMLAttributes` (minus `prefix`); `leadingIcon?`, `prefix?`, `suffix?`, `fieldClassName?` | — | ✅ | native `<input>`; wrapper owns hover/focus ring; `disabled` state; spreads `...rest`. NB: `className` lands on the inner input, `fieldClassName` on the wrapper | ✅ | ✅ (n/a) | ✅ | ⚠ `className`→input, `fieldClassName`→wrapper; no `ref` forward to the input | ✅ | ✅ |
| 6 | **Kbd** (`primitives/Kbd.tsx`) | `children` only (inline `{ children: ReactNode }` — **no exported props type**) | — | ✅ | static `<kbd>` | ✅ | ✅ (n/a) | ❌ exported without a `KbdProps` type (Task 3.6) | ❌ no `className`, no ref | ✅ | ✅ |
| 7 | **Pill** (`primitives/Pill.tsx`) | `status: PillStatus`, `children` (inline type) | tone-shaped axis but named `status`; values `ok\|warn\|arch\|err` (non-canonical) | ✅ | static `<span>` | ✅ | ❌ uses `status` + `ok/warn/arch/err` instead of `tone` + canonical `Tone` (Task 3.1) | ⚠ `Pill` + `PillStatus` exported; no `PillProps` type | ❌ no `className`, no ref | ✅ | ✅ |
| 8 | **Radio** (`primitives/Radio.tsx`) | extends `InputHTMLAttributes` (minus `type`); `label?` | — | ✅ | native `<input type=radio>` in `<label>`; `disabled`; spreads `...rest` | ✅ | ✅ (n/a) | ✅ | ⚠ merges `className`; no `ref` forward | ✅ | ✅ |
| 9 | **RadioCard** (`primitives/RadioCard.tsx`) | extends `InputHTMLAttributes` (minus `type`,`title`); `title`, `description?`, `selected?` | — | ✅ | native `<input type=radio>` in `<label>`; `.on` visual = `selected`; spreads `...rest` | ✅ | ✅ (n/a) | ✅ | ⚠ merges `className`; no `ref` forward | ✅ | ✅ |
| 10 | **SegmentedControl** (`primitives/SegmentedControl.tsx`) | `options: SegmentedOption[]`, `value`, `onChange`, `size?`, `disabled?` | size = `sm\|md` | ✅ | `role="radiogroup"`; segments `role="radio"` + `aria-checked` + roving `tabIndex`; ArrowLeft/Right/Up/Down selection moves + focus; `:focus-visible` ring (primitives.css:541) | ✅ | ✅ size canonical subset | ✅ | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 11 | **Select** (`primitives/Select.tsx`) | extends `SelectHTMLAttributes`; `children?` | — | ✅ | native `<select>` + decorative chevron (`aria-hidden`); `:focus-visible` ring (primitives.css:265); spreads `...rest`. NB: `className` lands on the inner `<select>`, not the wrapper | ✅ | ✅ (n/a) | ✅ | ⚠ `className`→select; no `ref` forward; no `fieldClassName` for the wrapper | ✅ | ✅ |
| 12 | **Skeleton** (`primitives/Skeleton.tsx`) | `width?`, `height?`, `radius?`, `className?` | — | ✅ | `aria-hidden` (decorative placeholder); shimmer honored by reduced-motion | ❌ **C1 raw-ramp** — shimmer gradient uses `--h10-grey-100/-150` (primitives.css:458) | ✅ (n/a) | ✅ | ⚠ merges `className`; no ref | ✅ | ✅ |
| 13 | **Spinner** (`primitives/Spinner.tsx`) | `size?`, `className?` | size = numeric px (not the `sm\|md` scale) | ✅ | `role="status"` + `aria-label="Loading"`; spin honored by reduced-motion | ✅ | ⚠ `size` is `number` (px), diverges from the `sm\|md\|lg\|xl` scale (documented exception, Task 3.7) | ✅ | ⚠ merges `className`; no ref | ✅ | ✅ |
| 14 | **Tag** (`primitives/Tag.tsx`) | `tone?: TagTone`, `children` (inline type) | tone = `neutral\|info\|positive\|warning\|danger` (`positive` non-canonical → `success`) | ✅ | static `<span>` | ❌ **C1 raw-ramp** — `.h10-ds-tag.{neutral,info,positive,danger}` reach `--h10-grey-700/-100`, `--h10-blue-700/-100`, `--h10-green-700`, `--h10-red-700` (primitives.css:147–151) | ❌ `positive` instead of `success` (Task 3.2; keep `positive` as deprecated alias) | ⚠ `Tag` + `TagTone` exported; no `TagProps` type | ❌ no `className`, no ref | ✅ | ✅ |
| 15 | **TagInput** (`primitives/TagInput.tsx`) | `value: string[]`, `onChange`, `placeholder?`, `suggestions?`, `disabled?`, `className?`, `maxTags?`, `'aria-label'?` | — | ❌ | chips have `aria-label="Remove {tag}"`; input takes `aria-label`; Enter/comma/Tab commit, Backspace removes last, Escape closes menu; suggestion `<ul>`/`<button>` menu (no `role=listbox`/`option`/active-descendant) | ❌ **C1 — the outlier**: raw Tailwind palette (`bg-blue-100`, `text-slate-800`, `border-slate-300`…), hand-rolled `dark:`, imports `@/lib/utils` `cn`; **no `.h10-ds-*`** (rebuild in Task 3.8) | ✅ (n/a) | ✅ | ✅ accepts `className` (merged via `cn`); no ref | ❌ absent from catalog | ⚠ menu lacks combobox/listbox ARIA |
| 16 | **Textarea** (`primitives/Textarea.tsx`) | `TextareaProps = TextareaHTMLAttributes` (type alias; `className?` via attrs) | — | ❌ | native `<textarea>`; spreads `...rest` (aria-* pass through) | ✅ | ✅ (n/a) | ✅ | ⚠ merges `className`; no `ref` forward | ❌ absent from catalog | ✅ |
| 17 | **Toggle** (`primitives/Toggle.tsx`) | extends `ButtonHTMLAttributes` (minus `onChange`,`type`); `checked`, `onChange?` | — | ✅ | `role="switch"` + `aria-checked`; native `<button>`; `:focus-visible` ring (primitives.css:333); `disabled`; spreads `...rest` | ❌ **C1 raw-ramp** — track background uses `--h10-grey-300` (primitives.css:307) | ✅ (n/a) | ✅ | ⚠ merges `className`; no ref | ✅ | ✅ |
| 18 | **Tooltip** (`primitives/Tooltip.tsx`) | `label`, `children` | — | ✅ | CSS hover/focus bubble; bubble `role="tooltip"`; shows on `:hover`/`:focus-within` (keyboard reachable if child is focusable) | ❌ **C1 raw-ramp** — bubble bg + arrow use `--h10-grey-900` (primitives.css:414, 433) | ✅ (n/a) | ✅ | ❌ no `className`, no ref | ✅ | ✅ |

### Components (21)

| # | Component (file) | Props | tone/size axis | Catalog | A11y notes | C1 | C2 | C3 | C4 | C5 | C6 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 19 | **Banner** (`components/Banner.tsx`) | `variant?: BannerVariant`, `title?`, `children?`, `icon?`, `action?`, `onDismiss?` | variant = `info\|warning\|error\|success` (this is a *tone* axis mislabeled `variant`; `error` non-canonical) | ✅ | `role="alert"` when `error` else `role="status"`; default per-variant lucide icon (`aria-hidden`); dismiss `aria-label="Dismiss"` | ✅ | ❌ `variant` + `error` instead of `tone` + `danger` (Task 3.4; keep `variant`/`error` deprecated for untouchable `EbayImportWizard`) | ✅ `Banner` + `BannerProps` + `BannerVariant` | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 20 | **Card** (`components/Card.tsx`) | `padded?`, `elevated?`, `header?`, `headerAction?`, `children?`, `className?` | — | ✅ (imported as `DSCard`) | static container; no interactivity | ✅ | ✅ (n/a) | ✅ | ⚠ merges `className`; no ref | ✅ | ✅ |
| 21 | **Combobox** (`components/Combobox.tsx`) | `options: ComboboxOption[]`, `value?`, `onChange`, `placeholder?` | — | ✅ | popup `role="listbox"`, items `role="option"` + `aria-selected`; Escape closes; `useClickAway`. Gaps: input lacks `role=combobox`/`aria-expanded`/active-descendant; no arrow-key navigation | ✅ | ✅ (n/a) | ✅ | ❌ no `className` passthrough; no ref | ✅ | ⚠ combobox ARIA + arrow-keys incomplete |
| 22 | **DataGrid** (`components/DataGrid.tsx`) | `columns: Array<Column<T>>`, `rows`, `rowKey`, `selectable?`, `selected?`, `onSelectedChange?`, `showTotals?`, `emptyState?`, `initialSort?`, `maxHeight?` (generic `<T>`) | — | ✅ | `<table>` semantics; sort via `<button>` headers; select-all + per-row checkboxes have `aria-label`; indeterminate select-all set on the DOM node | ❌ **C1 raw-ramp** — thead/row-hover/totals bg use `--h10-grey-25` (components.css:850, 868, 928) | ✅ (n/a) | ✅ `DataGrid` + `DataGridProps` + `Column` | ❌ no `className` passthrough; no ref | ✅ | ⚠ sort buttons lack `aria-sort` on `<th>` |
| 23 | **DateRangePicker** (`components/DateRangePicker.tsx`) | `value: DateRange`, `onChange` | — | ✅ | trigger `aria-expanded`; prev/next month `aria-label`; `useClickAway`. Gaps: day grid is buttons without `role=grid`/`gridcell`; no roving arrow-key date nav | ✅ | ✅ (n/a) | ✅ `DateRangePicker` + `DateRangePickerProps` + `DateRange` | ❌ no `className` passthrough; no ref | ✅ | ⚠ calendar grid ARIA + keyboard incomplete |
| 24 | **Drawer** (`components/Drawer.tsx`) | `open`, `onClose`, `title?`, `footer?`, `children?` | — | ✅ | `role="dialog"` + `aria-modal`; Esc + backdrop close; portaled to `<body>`; close `aria-label`. Gaps: no focus trap / focus restore / `aria-labelledby` | ✅ | ✅ (n/a) | ✅ | ❌ no `className` passthrough; no ref | ✅ | ⚠ no focus trap/restore |
| 25 | **EmptyState** (`components/EmptyState.tsx`) | `icon?`, `title`, `description?`, `action?` | — | ✅ | static; no interactivity | ✅ | ✅ (n/a) | ✅ | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 26 | **FileDropzone** (`components/FileDropzone.tsx`) | `onFiles`, `accept?`, `maxBytes?`, `multiple?`, `disabled?`, `hint?` | — | ✅ | `<button>` trigger; Enter/Space opens picker; drag-drop; error `role="alert"`; `:focus-visible` ring (components.css:1153); hidden native `<input type=file>` | ✅ | ✅ (n/a) | ✅ | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 27 | **Heatmap** (`components/Heatmap.tsx`) | `data: number[][]`, `rowLabels`, `colLabels?`, `format?` | — | ✅ | cells convey value via opacity + `title` tooltip; decorative (no ARIA table) | ⚠ **C1** — cell color is an inline `rgba(31,111,222,…)` literal (`Heatmap.tsx:12`), not a token (raw color in `.tsx`, not caught by the ramp guard but a token gap) | ✅ (n/a) | ✅ | ❌ no `className` passthrough; no ref | ✅ | ⚠ value encoded only by color+title (no text/ARIA) |
| 28 | **HoverCard** (`components/HoverCard.tsx`) | `card`, `children` | — | ✅ | wrapper `tabIndex=0`; panel `role="tooltip"`; shows on hover/focus | ✅ | ✅ (n/a) | ✅ | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 29 | **ImageUpload** (`components/ImageUpload.tsx`) | `value`, `onChange`, `onUpload`, `label?`, `criteria?`, `accept?`, `maxBytes?`, `minWidth?`, `minHeight?`, `aspect?`, `onSelectFromAssets?`, `disabled?` | — | ❌ | `<button>` zone with `aria-label`; remove `aria-label`; busy/drag states; format/size/dimension validation. NB: preview `<img>` has `alt` | ✅ | ✅ (n/a) | ✅ `ImageUpload` + `ImageUploadProps` + `ImageUploadCriterion` | ❌ no `className` passthrough; no ref | ❌ absent from catalog | ✅ |
| 30 | **Menu** (`components/Menu.tsx`) | `label`, `items: MenuItemDef[]`, `align?`, `triggerProps?` | — | ✅ | trigger `aria-haspopup="menu"` + `aria-expanded`; popup `role="menu"`, items `role="menuitem"` + `disabled`; outside-click closes. Gaps: no arrow-key roving / Esc-to-close / focus-into-menu | ✅ | ✅ (n/a) | ✅ `Menu` + `MenuProps` + `MenuItemDef` | ⚠ `triggerProps` spread onto the trigger; no `className`/ref on root | ✅ | ⚠ menu keyboard nav incomplete |
| 31 | **MetricStrip** (`components/MetricStrip.tsx`) | `metrics: Metric[]` | — | ✅ | static KPI tiles; delta up/down by class | ✅ | ✅ (n/a) | ✅ `MetricStrip` + `MetricStripProps` + `Metric` | ❌ no `className` passthrough; no ref | ✅ | ⚠ delta direction encoded by color/class only |
| 32 | **Modal** (`components/Modal.tsx`) | `open`, `onClose`, `title?`, `subtitle?`, `footer?`, `size?`, `children?` | size = `sm\|md\|lg\|xl` | ✅ | `role="dialog"` + `aria-modal`; Esc + backdrop close; portaled; close `aria-label`; body stops propagation. Gaps: no focus trap / focus restore / `aria-labelledby` | ✅ | ✅ size canonical (full `sm\|md\|lg\|xl`) | ✅ | ❌ no `className` passthrough; no ref | ✅ | ⚠ no focus trap/restore |
| 33 | **MultiSelect** (`components/MultiSelect.tsx`) | `options: MultiSelectOption[]`, `value: string[]`, `onChange`, `placeholder?` | — | ✅ | trigger `aria-expanded`; popup `role="listbox"` + `aria-multiselectable`; Select-all + per-option checkboxes; indeterminate set on DOM; Escape closes; `useClickAway`. Gaps: options are `<label>`+checkbox not `role=option`; no arrow-key nav | ✅ | ✅ (n/a) | ✅ `MultiSelect` + `MultiSelectProps` + `MultiSelectOption` | ❌ no `className` passthrough; no ref | ✅ | ⚠ listbox option ARIA + keyboard incomplete |
| 34 | **Pagination** (`components/Pagination.tsx`) | `page`, `pageCount`, `onPage` | — | ✅ | prev/next `aria-label`; current page `aria-current="page"`; `disabled` at ends; `:focus-visible` ring via a11y.css | ✅ | ✅ (n/a) | ✅ | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 35 | **PerformanceGraph** (`components/PerformanceGraph.tsx`) | `data`, `xKey`, `left: ChartSeries`, `right: ChartSeries`, `height?` | — | ✅ | recharts SVG; custom tokenized tooltip + legend; chart is decorative (no ARIA data table) | ⚠ **C1** — axes/grid resolve through `tokens/colors.ts` (`color.border*`, `color.text3`) ✓ but the tooltip uses an inline `style={{ color: 'var(--h10-text-2)' }}` literal (`PerformanceGraph.tsx:44`) — consumes a Tier-2 role directly in `.tsx` rather than a `.h10-ds-*` class; series colors are caller-supplied | ✅ (n/a) | ✅ `PerformanceGraph` + `PerformanceGraphProps` + `ChartSeries` | ❌ no `className` passthrough; no ref | ✅ | ⚠ no accessible data fallback |
| 36 | **ProgressBar** (`components/ProgressBar.tsx`) | `value?`, `indeterminate?`, `height?`, `className?` | — | ✅ | `role="progressbar"` + `aria-valuenow/min/max` (omits `valuenow` when indeterminate); animation honored by reduced-motion | ✅ | ✅ (n/a) | ✅ | ⚠ merges `className`; no ref | ✅ | ✅ |
| 37 | **Stepper** (`components/Stepper.tsx`) | `steps: StepperStep[]`, `current` | — | ✅ | `<ol>`/`<li>`; active step `aria-current="step"`; done/active/upcoming by class; check icon `aria-hidden`; connector `aria-hidden` | ✅ | ✅ (n/a) | ✅ `Stepper` + `StepperProps` + `StepperStep` | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 38 | **Tabs** (`components/Tabs.tsx`) | `tabs: TabItem[]`, `active`, `onChange`, `className?` | — | ✅ | `role="tablist"`, tabs `role="tab"` + `aria-selected`; `:focus-visible` ring via a11y.css. Gaps: no `aria-controls`/tabpanel linkage; no arrow-key roving | ✅ | ✅ (n/a) | ✅ `Tabs` + `TabItem` + `TabsProps` | ⚠ merges `className`; no ref | ✅ | ⚠ tab arrow-key roving + panel linkage absent |
| 39 | **Toast** (`components/Toast.tsx`) | `ToastProvider({ children, duration? })`; `useToast(): ToastApi`; `toast(message, variant?: ToastVariant)` | variant = `info\|success\|error` (tone axis mislabeled `variant`; `error` non-canonical) | ✅ (via `ToastDemo`) | each toast `role="status"`; portaled bottom-center; mounted-gate avoids hydration mismatch. Gaps: not `aria-live="assertive"` for errors; no dismiss/pause | ✅ | ❌ `variant` + `error` instead of `tone` + `danger` (Task 3.3) | ❌ **barrel exports `ToastVariant` but NOT `ToastApi`** (the typed public surface) | n/a (provider/hook — no className/ref) | ✅ | ⚠ no assertive live region for errors |
| 40 | **useClickAway** (`components/useClickAway.ts`) | `useClickAway(ref, onAway, active?)` | — | n/a | hook only — `mousedown` outside-click; not a rendered component | ✅ (n/a) | ✅ (n/a) | ✅ exported | n/a | n/a (utility hook) | ✅ (n/a) |

> *useClickAway is a shared utility hook (`.ts`), not one of the 47 runtime `.tsx` components; listed for completeness because it is barrel-exported.*

### Patterns (8)

| # | Component (file) | Props | tone/size axis | Catalog | A11y notes | C1 | C2 | C3 | C4 | C5 | C6 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 41 | **AppShell** (`patterns/AppShell.tsx`) | `brand`, `nav: ShellNavEntry[]`, `footer?`, `children`; also exports `ShellNavItem`/`ShellSubItem`/`ShellNavGroup`/`ShellNavEntry` | — | ✅ | `<aside>`/`<nav>`/`<main>` landmarks; nav items/links `aria-current="page"`; groups `aria-expanded`; chevrons `aria-hidden`; `:focus-visible` ring via a11y.css | ❌ **C1 raw-ramp** — `.h10-ds-navitem:hover` bg uses `--h10-grey-150` (patterns.css:108) | ✅ (n/a) | ⚠ barrel exports `AppShell` + `AppShellProps` + `ShellNavItem`; **`ShellNavGroup`/`ShellNavEntry`/`ShellSubItem` exported from file but not all re-exported** | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 42 | **Builder** (`patterns/Builder.tsx`) | `open`, `onClose`, `title`, `sections: BuilderSection[]`, `primaryLabel?`, `onPrimary?`, `busy?` | — | ✅ | `role="dialog"` + `aria-modal`; Esc closes; portaled; scroll-spy nav; close `aria-label`; `:focus-visible` ring (nav) via a11y.css. Gaps: no focus trap/restore; nav buttons aren't tabs | ✅ | ✅ (n/a) | ✅ `Builder` + `BuilderProps` + `BuilderSection` | ❌ no `className` passthrough; no ref | ✅ | ⚠ no focus trap/restore |
| 43 | **BulkActionBar** (`patterns/BulkActionBar.tsx`) | `count`, `children`, `onClear?`, `noun?` | — | ✅ | `role="region"` + `aria-label="Bulk actions"`; renders nothing at `count<=0` | ✅ | ✅ (n/a) | ✅ | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 44 | **ColumnCustomizer** (`patterns/ColumnCustomizer.tsx`) | `open`, `onClose`, `columns: CustomizableColumn[]`, `onApply` | — | ✅ | renders inside `<Modal>` (inherits dialog ARIA); move up/down `aria-label`; locked rows disable controls; draft-then-Apply | ✅ | ✅ (n/a) | ✅ `ColumnCustomizer` + `ColumnCustomizerProps` + `CustomizableColumn` | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 45 | **DetailHeader** (`patterns/DetailHeader.tsx`) | `backLabel?`, `onBack?`, `badge?`, `title`, `actions?` | — | ✅ | back `<button>`; semantic `<h1>` | ✅ | ✅ (n/a) | ✅ | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 46 | **EditModeBar** (`patterns/EditModeBar.tsx`) | `message?`, `count?`, `onDiscard?`, `onApply?`, `applyLabel?`, `busy?` | — | ✅ | `role="region"` + `aria-label="Edit mode"`; `busy` disables actions | ✅ | ✅ (n/a) | ✅ | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 47 | **FilterPanel** (`patterns/FilterPanel.tsx`) + **FilterField** | FilterPanel: `title?`, `presets?`, `children`, `onReset?`, `onApply?`, `footerExtra?`, `defaultOpen?`; FilterField: `label`, `wide?`, `children` | — | ✅ | collapse toggle `aria-expanded`; `:focus-visible` ring (toggle) via a11y.css; `<h3>` heading | ✅ | ✅ (n/a) | ✅ `FilterPanel` + `FilterField` + `FilterPanelProps` (FilterField's inline prop type isn't exported) | ❌ no `className` passthrough; no ref | ✅ | ✅ |
| 48 | **PageHeader** (`patterns/PageHeader.tsx`) | `eyebrow?`, `title`, `subtitle?`, `actions?` | — | ✅ | semantic `<h1>`; static | ✅ | ✅ (n/a) | ✅ | ❌ no `className` passthrough; no ref | ✅ | ✅ |

> *Row 47 covers two exported functions (FilterPanel + FilterField) from one file, so the table is rows #1–#48 across the 8 patterns while the 47-component count is preserved (FilterField is a sub-part of the FilterPanel pattern).*

### Contract roll-up

- **C1 (semantic styling):** **9 components fail.** TagInput (raw Tailwind + `@/lib/utils`, the outlier) and the ~13 raw-ramp reaches in 6 others — Tag, Toggle, Tooltip, Skeleton (primitives.css), DataGrid (components.css), AppShell (patterns.css). Two soft gaps (Heatmap inline `rgba()`, PerformanceGraph tooltip inline `var(--h10-text-2)`) consume color in `.tsx` outside a `.h10-ds-*` class but are not numbered-ramp reaches.
- **C2 (prop vocabulary):** **5 fail** — Pill (`status`/`ok\|warn\|arch\|err`), Tag (`positive`), Toast (`variant`/`error`), Banner (`variant`/`error`), Badge (`tone`/program codes). Spinner `size` is a documented numeric exception.
- **C3 (exports):** **4 fail/partial** — Kbd (no type), Pill (no `PillProps`), Tag (no `TagProps`), Toast (`ToastApi` not exported); AppShell partial (`ShellNavGroup`/`ShellNavEntry`/`ShellSubItem` not all re-exported).
- **C4 (ref + className):** **systemic gap** — **0 of 48** forward a `ref`; the majority (~30) don't accept `className` at all. Form primitives that spread `...rest` (Button/Input/Checkbox/Radio/RadioCard/Toggle/Textarea/Select) merge `className` but still don't forward `ref`. Best-cased: TagInput (already accepts `className`), Card/Skeleton/Spinner/Divider/ProgressBar/Tabs/Tag-family-via-rest.
- **C5 (catalog):** **3 fail** — **Textarea, TagInput, ImageUpload** have no catalog story (every other component is rendered, Toast via `ToastDemo`).
- **C6 (a11y):** baseline solid (system-wide reduced-motion + focus rings). Recurring gaps: no focus trap/restore on the 4 overlays (Modal, Drawer, Builder, + Drawer); incomplete keyboard/ARIA on the dropdown/listbox family (Combobox, Menu, MultiSelect, DateRangePicker, Tabs, DataGrid `aria-sort`); Toast not assertive for errors.

---

## 4. Tone remap table

**Authoritative** for Phase 3 (Tasks 3.1–3.4). Canonical vocabulary: `type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'`.

| Component | Old | New (`Tone`) |
|---|---|---|
| Pill | `ok` / `warn` / `arch` / `err` | `success` / `warning` / `neutral` / `danger` |
| Tag | `positive` | `success` (keep `positive` as deprecated alias) |
| Toast | `error` | `danger` |
| Banner | `error` | `danger` (keep `variant` prop as deprecated alias) |

> Badge's `BadgeTone = sp|sd|sb|auto|manual` is **not** a tone — it is the ad-program/targeting axis and renames to `program: AdProgram` (Task 3.5), not part of the `Tone` remap. The prop names also change with the tone: Pill `status` → `tone`; Toast/Banner `variant` → `tone` (with `variant` kept on Banner as a deprecated alias for the untouchable `EbayImportWizard.tsx`).

---

## 5. Inconsistency register

The 5 spec findings (design §1) + the 13 raw-ramp reaches, each with file:line evidence and the resolving plan task.

### Finding #1 — Semantic tier exists but is `--h10-`-named, not platform-named (Structural)

`NAMING.md`, `GOVERNANCE.md`, `TOKEN-RECONCILIATION.md` say components consume the platform's semantic names (`--text-primary`, `--surface-card`, `--status-*`). Reality: the Tier-2 semantic layer exists but only under the `--h10-` prefix — **79 distinct `--h10-*`** are consumed by component CSS; **0** platform-semantic names are. Convergence with the ~290 platform pages is unwired.

- **Evidence:** `styles/tokens.css:68–107` (Tier-2 roles declared as `--h10-*`); `styles/tokens.css:1–13` header comment explicitly defers convergence ("Convergence … happens deliberately in the migration phase"); 79 distinct `var(--h10-*)` reached across `styles/{primitives,components,patterns}.css`.
- **Resolution:** **Task 1.2** (add platform-semantic aliases) + **Task 2.2** (repoint all component CSS off `--h10-*` core roles onto `--text-*`/`--surface-*`/`--border-*`/`--status-*`/`--color-primary*`).

### Finding #1b — ~13 genuine raw-ramp reaches (Mechanical)

A handful of component CSS rules skip the semantic tier and consume Tier-1 ramps directly. Exact list from `rg -n 'var\(--h10-(grey|blue|green|red|amber|purple|cyan)-[0-9]' styles/{primitives,components,patterns}.css`:

| # | file:line | Selector / context | Raw ramp(s) | Owning component | Repoint to |
|---|---|---|---|---|---|
| 1 | `styles/primitives.css:147` | `.h10-ds-tag.neutral` | `--h10-grey-700` (fg), `--h10-grey-100` (bg) | Tag | `--h10-text-strong` (fg, DS-only), `--surface-sunken` (bg) |
| 2 | `styles/primitives.css:148` | `.h10-ds-tag.info` | `--h10-blue-700` (fg), `--h10-blue-100` (bg) | Tag | `--status-info-strong` *(new alias `var(--h10-blue-700)`)*, `--status-info-soft` (bg) |
| 3 | `styles/primitives.css:149` | `.h10-ds-tag.positive` | `--h10-green-700` (fg) | Tag | `--status-success-strong` (fg), `--status-success-soft` (bg via `--h10-green-soft`) |
| 4 | `styles/primitives.css:151` | `.h10-ds-tag.danger` | `--h10-red-700` (fg) | Tag | `--status-danger-strong` (fg), `--status-danger-soft` (bg via `--h10-red-soft`) |
| 5 | `styles/primitives.css:307` | `.h10-ds-toggle` track | `--h10-grey-300` | Toggle | `--border-strong` |
| 6 | `styles/primitives.css:414` | `.h10-ds-tooltip > .tip` bg | `--h10-grey-900` | Tooltip | `--text-primary` |
| 7 | `styles/primitives.css:433` | `.h10-ds-tooltip > .tip::after` arrow | `--h10-grey-900` | Tooltip | `--text-primary` |
| 8 | `styles/primitives.css:458` | `.h10-ds-skeleton` gradient | `--h10-grey-100`, `--h10-grey-150` | Skeleton | `--surface-sunken`, `--border-subtle` |
| 9 | `styles/components.css:378` | `.h10-ds-toast` bg | `--h10-grey-900` | Toast | `--text-primary` |
| 10 | `styles/components.css:850` | `.h10-ds-grid thead th` bg | `--h10-grey-25` | DataGrid | `--h10-surface-raised` (DS-only role) |
| 11 | `styles/components.css:868` | `.h10-ds-grid tbody tr:hover td` bg | `--h10-grey-25` | DataGrid | `--h10-surface-raised` (DS-only role) |
| 12 | `styles/components.css:928` | `.h10-ds-grid tr.totals td` bg | `--h10-grey-25` | DataGrid | `--h10-surface-raised` (DS-only role) |
| 13 | `styles/patterns.css:108` | `.h10-ds-navitem:hover` bg | `--h10-grey-150` | AppShell | `--border-subtle` |

> Note: `.h10-ds-tag.info`/`.positive`/`.danger` lines also carry `--h10-blue-100`/`--h10-green-soft`/`--h10-red-soft` backgrounds; the grep only flags the *numbered* ramp on each line (`-blue-100` is matched on line 148; `green-soft`/`red-soft` are name-suffix ramps, not numbered, and repoint to the corresponding `--status-*-soft`). Total numbered-ramp hits = **13 lines** across **7 components**.

- **Resolution:** **Task 2.1** (repoint each to its semantic/platform token; add the missing `--status-info-strong` alias). Re-grep must return **zero** hits. Guarded going forward by **Task 4.1** (token-guard D1 ramp check).

### Finding #2 — Two parallel token sources, no generator (Structural)

`tokens/*.ts` (the JS API) and `styles/tokens.css` (the render source) are hand-maintained separately, while `GOVERNANCE.md` claims "TS generates CSS." No generator exists — only the lint. Values agree today (`#1f6fde` in both) but nothing enforces it.

- **Evidence:** `docs/GOVERNANCE.md:9` — "Token **values** | `tokens/` (TS) → generates/wires `styles/tokens.css` + Tailwind"; no `tools/generate-tokens-css.mjs` in the tree (only `tools/token-guard.mjs`); `styles/tokens.css:1–3` header calls itself "the runtime source of truth … Mirrors ../tokens/colors.ts" (hand-mirror, not generated).
- **Resolution:** **Task 1.1** (build `tokens/css-vars.ts` + `tools/generate-tokens-css.mjs`, regenerate value-identically) + **Task 1.3** (CI `tokens:check` gate) + **Task 4.4** (fix the GOVERNANCE wording).

### Finding #3 — One outlier component: TagInput (Mechanical)

`TagInput.tsx` bypasses the system — raw Tailwind palette + hand-rolled `dark:`, no `.h10-ds-*`, imports `@/lib/utils`. It is the **only** such file.

- **Evidence:** `primitives/TagInput.tsx:6` `import { cn } from '@/lib/utils'`; `:85` `border-slate-300 dark:border-slate-600`; `:87` `focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500`; `:95` `bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200`; `:101` `text-blue-500 hover:text-blue-700 dark:hover:text-blue-100`; `:118` `text-slate-800 dark:text-slate-100`; `:125`/`:132` more `slate`/`dark:` (8 raw-palette hits, 7 `dark:` variants).
- **Resolution:** **Task 3.8** (rebuild onto `.h10-ds-taginput*` + semantic tokens; props unchanged so the two untouchable consumers — `AmazonFlatFileClient`, `AddListingPopover` — need no edits). This is the **one task allowed to change pixels** (a deliberate rebuild, verified by eye). Guarded by **Task 4.1** (token-guard D2 Tailwind check).

### Finding #4 — Status/color-role API uses three value vocabularies + a mislabeled component + missing types (Mechanical)

The semantic color-role API is inconsistent across components; one component is mislabeled; types leak.

- **Evidence (vocabulary divergence):**
  - Pill: `status` prop, values `ok\|warn\|arch\|err` — `primitives/Pill.tsx:3,6`.
  - Tag: `tone` prop, values `neutral\|info\|positive\|warning\|danger` (`positive` ≠ `success`) — `primitives/Tag.tsx:10,12`.
  - Toast: `variant` arg, values `info\|success\|error` (`error` ≠ `danger`) — `components/Toast.tsx:6,15,31`.
  - Banner: `variant` prop, values `info\|warning\|error\|success` (`error` ≠ `danger`) — `components/Banner.tsx:14,16,37`.
- **Evidence (mislabeled Badge):** `BadgeTone = sp\|sd\|sb\|auto\|manual` is the **ad-program** axis, not a tone — `primitives/Badge.tsx:4,6`; prop is `tone`.
- **Evidence (type leaks / missing types):** `Kbd` exported without a props type — `primitives/Kbd.tsx:4` + barrel `primitives/index.ts:15`; `ToastApi` defined but not exported (barrel exports `ToastVariant` instead) — `components/Toast.tsx:14` + `components/index.ts:9`; Pill/Tag exported without `PillProps`/`TagProps`.
- **Evidence (size scales differ):** `size` appears only on Modal (`sm\|md\|lg\|xl` — `components/Modal.tsx:15`) and SegmentedControl (`sm\|md` — `primitives/SegmentedControl.tsx:21`); Spinner's `size` is a `number` (px) — `primitives/Spinner.tsx:3`. No shared `Size` type.
- **Resolution:** **Task 3.1** (canonical `Tone` in `primitives/tone.ts`; Pill `status`→`tone`, remap values + rename `--h10-pill-*` tokens + 3 consumers) · **Task 3.2** (Tag `positive`→`success`, keep `positive` deprecated) · **Task 3.3** (Toast `variant`→`tone`, `error`→`danger`, export `ToastApi`) · **Task 3.4** (Banner `tone` canonical, `variant`/`error` kept deprecated for untouchable consumer) · **Task 3.5** (Badge `tone`/`BadgeTone` → `program`/`AdProgram`) · **Task 3.6** (export `KbdProps`) · **Task 3.7** (shared `Size = sm\|md\|lg\|xl` + docs) · **Task 4.2** (api-guard enforces every type re-exported by its barrel).

### Finding #5 — Docs drift from reality (Mechanical)

`README.md` says *"Phase 0 — No runtime code yet"* and tags every folder with a future-tense "Built in" phase, while 47 runtime components exist and `CHANGELOG` shows P0–P8 complete.

- **Evidence:** `README.md:9–11` — "**Status:** Phase 0 — scaffolding + governance + inventory. **No runtime code yet**"; `README.md:50–59` "Built in" column tags `primitives/` "Phase 3", `components/` "Phase 4", `patterns/` "Phase 5", `catalog/` "Phase 2" (all future tense); `README.md:61` "Using it (once populated)". Separately `GOVERNANCE.md:9` carries the false generator claim (see Finding #2).
- **Resolution:** **Task 4.4** (rewrite README status to P0–P8 shipped / 47 components live; "Built in" → "Shipped"; update GOVERNANCE generator wording to "generated by `tools/generate-tokens-css.mjs`; CI-checked"; note the live platform-semantic layer in NAMING; add a CHANGELOG entry).

---

## 6. Summary counts

- **Tokens:** 116 `--h10-*` in `:root` (44 Tier-1 · 35 Tier-2 · 37 Tier-3); 24 Tier-2 core roles get a platform-semantic alias; `.dark` re-declares 14 roles. 79 distinct `--h10-*` consumed by component CSS today; target after Task 2.2 = only DS-only names remain.
- **Components registered:** 47 runtime `.tsx` (18 primitives + 21 components + 8 patterns; +`useClickAway` hook + `FilterField` sub-part listed for completeness).
- **Contract verdict:** C1 fails 9 (TagInput + 13 raw-ramp reaches across 6 others; 2 soft inline-color gaps) · C2 fails 5 · C3 fails/partial 5 · C4 systemic (0/48 forward ref; ~30 lack `className`) · C5 fails 3 (Textarea, TagInput, ImageUpload) · C6 baseline solid with recurring overlay-focus-trap + dropdown-keyboard gaps.
- **Inconsistencies logged:** 5 spec findings (#1, #1b, #2, #3, #4, #5 — six entries, #1/#1b split as in the spec) + the 13 enumerated raw-ramp reaches, each with file:line evidence and resolving task number.
</content>
</invoke>
