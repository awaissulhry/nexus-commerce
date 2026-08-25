/**
 * The authoritative ORDERED list of CSS custom properties emitted to
 * styles/tokens.css. This is the single source of truth for tokens.css —
 * `tools/generate-tokens-css.mts` reads this and writes the stylesheet.
 *
 * Hex values come from ./colors (palette/pill/badge) so colour is defined ONCE.
 * Spacing and type sizes come from ./spacing and ./typography for the same
 * reason — before 2026-08-24 those scales existed ONLY as TypeScript, so a
 * stylesheet had no way to reference a padding or a font size and every one of
 * them was written raw (63 distinct spacing values, 36 font sizes, measured).
 * Tier-2 roles are `var(--…)` reference strings (no hex to duplicate). Radius /
 * shadow / structural / type / the dark block are literals here (their only home).
 */
import { palette, pill, badge } from './colors'
import { space } from './spacing'
import { fontSize, fontWeight } from './typography'

export interface CssVar {
  /** when set, a section-comment is emitted before this row */
  section?: string
  name: string
  value: string
}

/** `px12` -> `12`, `xsPlus` -> `xs-plus`, `2xl` -> `2xl`. */
const kebab = (k: string): string =>
  k.replace(/^px/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

const spacingVars: ReadonlyArray<CssVar> = Object.entries(space).map(([k, v], i) => ({
  ...(i === 0 ? { section: 'Dimension: spacing (scale lives in tokens/spacing.ts)' } : {}),
  name: `--nds-space-${kebab(k)}`,
  value: v,
}))

const typeVars: ReadonlyArray<CssVar> = [
  ...Object.entries(fontSize).map(([k, v], i) => ({
    ...(i === 0 ? { section: 'Dimension: type scale (tokens/typography.ts)' } : {}),
    name: `--nds-font-size-${kebab(k)}`,
    value: v,
  })),
  ...Object.entries(fontWeight).map(([k, v], i) => ({
    ...(i === 0 ? { section: 'Dimension: type weight' } : {}),
    name: `--nds-font-weight-${kebab(k)}`,
    value: String(v),
  })),
]

export const cssVars: ReadonlyArray<CssVar> = [
  // ── Tier 1: primitive ramps ──────────────────────────────────────
  { section: 'Tier 1: primitive ramps', name: '--nds-white', value: palette.white },

  { name: '--nds-blue-50', value: palette.blue[50] },
  { name: '--nds-blue-100', value: palette.blue[100] },
  { name: '--nds-blue-200', value: palette.blue[200] },
  { name: '--nds-blue-600', value: palette.blue[600] },
  { name: '--nds-blue-700', value: palette.blue[700] },
  { name: '--nds-blue-800', value: palette.blue[800] },
  { name: '--nds-blue-900', value: palette.blue[900] },

  { name: '--nds-grey-25', value: palette.grey[25] },
  { name: '--nds-grey-50', value: palette.grey[50] },
  { name: '--nds-grey-75', value: palette.grey[75] },
  { name: '--nds-grey-100', value: palette.grey[100] },
  { name: '--nds-grey-150', value: palette.grey[150] },
  { name: '--nds-grey-200', value: palette.grey[200] },
  { name: '--nds-grey-300', value: palette.grey[300] },
  { name: '--nds-grey-400', value: palette.grey[400] },
  { name: '--nds-grey-450', value: palette.grey[450] },
  { name: '--nds-grey-500', value: palette.grey[500] },
  { name: '--nds-grey-600', value: palette.grey[600] },
  { name: '--nds-grey-700', value: palette.grey[700] },
  { name: '--nds-grey-800', value: palette.grey[800] },
  { name: '--nds-grey-900', value: palette.grey[900] },

  { name: '--nds-rail-surface', value: palette.railBg },
  { name: '--nds-rail-line', value: palette.railBorder },

  // Rail-specific colours, dedicated so the app-wide rail can follow theme
  // without shifting the general --nds-text-* roles used elsewhere. Light
  // values; the dark block overrides them, and .h10-shell pins them light for
  // the deliberately-light standalone shells (ads cockpit + /products/next).
  // Hand-lived in tokens.css from 2026-06-29 (99746dbe8) until TECH_DEBT #62
  // ported them here — hex literals like the ImageUpload washes below.
  { section: 'Rail palette (theme-following; .h10-shell pins light)', name: '--nds-rail-text', value: '#4a5462' },
  { name: '--nds-rail-text-2', value: '#5b6573' },
  { name: '--nds-rail-text-strong', value: '#1c2530' },
  { name: '--nds-rail-icon', value: '#8a93a1' },
  { name: '--nds-rail-chev', value: '#98a2b3' },
  { name: '--nds-rail-item-hover', value: '#e6eaf0' },
  { name: '--nds-rail-item-hover-2', value: '#f1f4f8' },
  { name: '--nds-rail-chip-bg', value: '#e8ebf0' },
  { name: '--nds-rail-chip-active-bg', value: '#dce8fb' },
  { name: '--nds-rail-chip-active-fg', value: '#1f6fde' },
  { name: '--nds-rail-ft', value: '#aeb6c2' },

  { name: '--nds-green-soft', value: palette.green.soft },
  { name: '--nds-green-500', value: palette.green[500] },
  { name: '--nds-green-600', value: palette.green[600] },
  { name: '--nds-green-700', value: palette.green[700] },
  { name: '--nds-red-soft', value: palette.red.soft },
  { name: '--nds-red-500', value: palette.red[500] },
  { name: '--nds-red-600', value: palette.red[600] },
  { name: '--nds-red-700', value: palette.red[700] },
  { name: '--nds-amber-soft', value: palette.amber.soft },
  { name: '--nds-amber-600', value: palette.amber[600] },
  { name: '--nds-amber-700', value: palette.amber[700] },
  { name: '--nds-amber-text', value: palette.amber.text },
  { name: '--nds-purple-bg', value: palette.purple.bg },
  { name: '--nds-purple-600', value: palette.purple[600] },
  { name: '--nds-purple-700', value: palette.purple[700] },
  { name: '--nds-cyan-bg', value: palette.cyan.bg },
  { name: '--nds-cyan-700', value: palette.cyan[700] },
  { name: '--nds-amazon', value: palette.amazon },

  { name: '--nds-shadow-rgb', value: '20 28 38' },
  { name: '--nds-focus-rgb', value: '31 111 222' },

  // ── Tier 2: semantic roles (components consume these) ─────────────
  { section: 'Tier 2: semantic roles', name: '--nds-text', value: 'var(--nds-grey-900)' },
  { name: '--nds-text-2', value: 'var(--nds-grey-600)' },
  { name: '--nds-text-3', value: 'var(--nds-grey-500)' },
  { name: '--nds-text-strong', value: 'var(--nds-grey-700)' },
  { name: '--nds-text-disabled', value: 'var(--nds-grey-400)' },
  { name: '--nds-text-inverse', value: 'var(--nds-white)' },
  { name: '--nds-text-link', value: 'var(--nds-blue-600)' },

  { name: '--nds-bg', value: 'var(--nds-grey-50)' },
  { name: '--nds-surface', value: 'var(--nds-white)' },
  { name: '--nds-surface-raised', value: 'var(--nds-grey-25)' },
  { name: '--nds-surface-sunken', value: 'var(--nds-grey-100)' },
  { name: '--nds-surface-hover', value: 'var(--nds-grey-75)' },
  { name: '--nds-wash-primary', value: 'var(--nds-blue-50)' },
  { name: '--nds-rail-bg', value: 'var(--nds-rail-surface)' },

  { name: '--nds-border', value: 'var(--nds-grey-200)' },
  { name: '--nds-border-subtle', value: 'var(--nds-grey-150)' },
  { name: '--nds-border-strong', value: 'var(--nds-grey-300)' },
  { name: '--nds-rail-border', value: 'var(--nds-rail-line)' },

  { name: '--nds-primary', value: 'var(--nds-blue-600)' },
  { name: '--nds-primary-hover', value: 'var(--nds-blue-700)' },
  { name: '--nds-primary-dark', value: 'var(--nds-blue-800)' },
  { name: '--nds-primary-soft', value: 'var(--nds-blue-100)' },
  { name: '--nds-primary-ghost-border', value: 'var(--nds-blue-200)' },

  { name: '--nds-success-soft', value: 'var(--nds-green-soft)' },
  { name: '--nds-success', value: 'var(--nds-green-600)' },
  { name: '--nds-success-strong', value: 'var(--nds-green-700)' },
  { name: '--nds-live', value: 'var(--nds-green-500)' },
  { name: '--nds-danger-soft', value: 'var(--nds-red-soft)' },
  { name: '--nds-danger', value: 'var(--nds-red-500)' },
  { name: '--nds-danger-strong', value: 'var(--nds-red-700)' },
  { name: '--nds-warning-soft', value: 'var(--nds-amber-soft)' },
  { name: '--nds-warning', value: 'var(--nds-amber-600)' },
  { name: '--nds-warning-strong', value: 'var(--nds-amber-700)' },
  { name: '--nds-info-soft', value: 'var(--nds-blue-100)' },
  { name: '--nds-info', value: 'var(--nds-blue-600)' },
  // The info tone had soft + line but no `strong`: `--status-info-strong` reached past the
  // semantic tier straight to the ramp (`--nds-blue-700`), which is the one thing component
  // CSS may not do (token-guard check B). Named here so the tone family is complete and the
  // 9.0b substitution has a legal target, like every other tone.
  { name: '--nds-info-strong', value: 'var(--nds-blue-700)' },

  // ── status TEXT — the tier this system was missing ───────────────────────────────────────────
  // Every tone had `-soft` (a background) and `-strong` (a fill/border), and nothing for TEXT ON
  // that soft background. So the ads console computed its own and wrote the ratios into ads.css
  // ("#8a5316 on #fff6e8 is 5.89:1 — computed, not guessed"). Measured 2026-08-25, on each tone's
  // own `-soft`:
  //
  //            -strong today            these
  //   success  4.57  ✓                  5.40  ✓
  //   warning  3.39  ✗ FAILS AA         5.69  ✓
  //   danger   4.63  ✓                  6.27  ✓
  //   info     5.20  ✓                  8.39  ✓
  //
  // The warning row is why this is a fix and not a tidy-up: `--nds-warning` on
  // `--nds-warning-soft` is 3.39:1, so anyone using the system as intended today ships
  // inaccessible warning text. The console was not diverging from the design system here — it hit
  // a gap and solved it correctly, three years of ratios ahead of the tokens.
  //
  // LITERAL values, not `var(--nds-*-800)`, and deliberately. These were derived from a contrast
  // requirement, not from a ramp position: #10457f is 17.7 ΔE from the existing --nds-blue-800,
  // so folding it into the ramp would move 74 declarations visibly to satisfy a naming
  // convention. A semantic token carrying its own computed value is the honest shape — the same
  // one --nds-rail-* already uses.
  // ── the missing AA step in the text ramp ─────────────────────────────────────────────────────
  // Measured 2026-08-25, on white: --nds-text 15.48 ✓ · --nds-text-2 5.91 ✓ · --nds-text-3 3.10 ✗.
  // WCAG AA needs 4.5:1 under 18.66px, so the ramp jumps from comfortable straight to failing
  // with nothing usable in between — and 18 DS components were using text-3 at 9–12.5px.
  //
  // #667080 is 5.01:1 and is not invented: the ads console computed it and used it 207 times,
  // noting "measured in the deployed DOM, not estimated". Same story as the status -text tier —
  // the console hit a gap in this system and filled it correctly.
  { name: '--nds-text-muted', value: '#667080' },
  { name: '--nds-success-text', value: '#14724d' },
  { name: '--nds-warning-text', value: '#8a5316' },
  // "Stale" had FIVE browns across the ads console — #8a5316, #6d3f10, #7a4512, #7a5b00 and a
  // red — for one meaning. This is the darkest measured value, so adopting it everywhere only
  // ever RAISES contrast: 5.89 → 8.27 on the stale badge, 7.29 → 8.27 on the feed banner.
  { name: '--nds-stale-text', value: '#6d3f10' },
  // Inline-note severities, one pair each. Values are the HIGHEST-contrast variant found among
  // the six that existed, so adopting them raises contrast everywhere and lowers it nowhere:
  // error 6.24/9.16/9.23 → 9.23, caution 5.79/5.89/6.63 → 6.63.
  { name: '--nds-note-error-bg', value: '#fdf0ef' },
  { name: '--nds-note-error-fg', value: '#7a2018' },
  { name: '--nds-note-error-icon', value: '#b3261e' },
  { name: '--nds-note-warn-bg', value: '#fdf6e3' },
  { name: '--nds-note-warn-fg', value: '#6b5514' },
  { name: '--nds-note-warn-icon', value: '#8a6d1f' },
  { name: '--nds-danger-text', value: '#9c2f2a' },
  { name: '--nds-info-text', value: '#10457f' },

  // status pills
  { section: 'status pills (tone-named: success/warning/neutral/danger)', name: '--nds-pill-success-fg', value: 'var(--nds-blue-900)' },
  { name: '--nds-pill-success-bg', value: pill.ok.bg },
  { name: '--nds-pill-warning-fg', value: 'var(--nds-amber-text)' },
  { name: '--nds-pill-warning-bg', value: 'var(--nds-amber-soft)' },
  { name: '--nds-pill-neutral-fg', value: pill.arch.fg },
  { name: '--nds-pill-neutral-bg', value: 'var(--nds-grey-100)' },
  // NOT --nds-danger-strong: `.dark` overrides that to #f79289 while --nds-danger-soft stays
  // light, so the dark danger pill was #f79289 on #fde8e8 — 1.9:1, illegible. --nds-danger-text
  // has no dark override: 6.27:1 in BOTH themes (was 4.63 light / 1.9 dark).
  { name: '--nds-pill-danger-fg', value: 'var(--nds-danger-text)' },
  // ── WorkspaceGrid (tier 3) ─────────────────────────────────────────────────────
  // Arrived with the grid in WG.3e. Kept as component tokens rather than snapped to the
  // nearest ramp entry: the nearest is 2.4–44.1 away in RGB, and in this codebase a colour
  // far from the palette has repeatedly turned out to be a contrast ratio somebody computed.
  // A substitution may only ever RAISE contrast, so these keep their measured values.
  { name: '--nds-wsgrid-head-fg', value: '#475467' }, // column header text
  { name: '--nds-wsgrid-dot', value: '#cbd2db' }, // inactive state dot in the name cell
  { name: '--nds-wsgrid-icon-muted', value: '#b6bdc8' }, // pin and bulb glyphs in the name cell
  { name: '--nds-wsgrid-badge-sb-fg', value: '#b45309' }, // Sponsored Brands badge text
  { name: '--nds-wsgrid-tag-auto', value: '#4f46e5' }, // AUTO targeting tag
  { name: '--nds-wsgrid-tag-manual', value: '#7c3aed' }, // MANUAL targeting tag
  { name: '--nds-wsgrid-pb-bg', value: '#2f3a4a' }, // placement badge ground
  { name: '--nds-wsgrid-pb-border', value: '#cfd6de' }, // placement badge edge
  { name: '--nds-wsgrid-rule', value: '#d0d5dd' }, // frozen-column and checkbox-column rules
  { name: '--nds-wsgrid-drag-ring', value: '#2f6bff' }, // the ring on a header being dragged
  { name: '--nds-pill-danger-bg', value: 'var(--nds-danger-soft)' },

  // ── Tier 3: program / targeting chips ────────────────────────────
  { section: 'Tier 3: program / targeting chips', name: '--nds-badge-sp-fg', value: 'var(--nds-purple-700)' },
  { name: '--nds-badge-sp-bg', value: 'var(--nds-purple-bg)' },
  { name: '--nds-badge-sd-fg', value: 'var(--nds-cyan-700)' },
  { name: '--nds-badge-sd-bg', value: 'var(--nds-cyan-bg)' },
  { name: '--nds-badge-sb-fg', value: 'var(--nds-amber-700)' },
  { name: '--nds-badge-sb-bg', value: badge.sb.bg },
  { name: '--nds-targeting-auto', value: 'var(--nds-blue-800)' },
  { name: '--nds-targeting-manual', value: 'var(--nds-purple-600)' },

  // ImageUpload component tokens (bespoke washes — exact legacy values, were raw hex)
  { name: '--nds-imgup-surface', value: '#f7faff' },
  { name: '--nds-imgup-hover', value: '#f0f6ff' },
  { name: '--nds-imgup-drag', value: '#e9f2ff' },
  { name: '--nds-imgup-spin-track', value: '#cdd5df' },
  { name: '--nds-imgup-err', value: '#cc1100' },

  // Tooltip bubbles. Both are deliberately THEME-INVARIANT — they point at the
  // raw ramps, which the `.dark` block never redefines, so a tip keeps its own
  // contrast instead of inverting with the canvas. The values they replace were
  // foreign Tailwind slate hexes (#1e293b / #e2e8f0 / #28313d) hardcoded in
  // primitives.css; snapped onto the nearest H10 ramp step 2026-08-24 (max
  // delta 4/255 per channel — below a JND, and on-system).
  { name: '--nds-tooltip-light-bg', value: 'var(--nds-white)' },
  { name: '--nds-tooltip-light-fg', value: 'var(--nds-grey-900)' },
  { name: '--nds-tooltip-light-border', value: 'var(--nds-grey-150)' },
  { name: '--nds-tooltip-light-fg-2', value: 'var(--nds-grey-600)' },
  { name: '--nds-tip-bg', value: 'var(--nds-grey-800)' },
  { name: '--nds-tip-fg', value: 'var(--nds-white)' },

  // ── Radius ───────────────────────────────────────────────────────
  { section: 'Radius', name: '--nds-radius-pill', value: '4px' },
  { name: '--nds-radius-sm', value: '6px' },
  { name: '--nds-radius-md', value: '7px' },
  { name: '--nds-radius-lg', value: '8px' },
  { name: '--nds-radius-xl', value: '10px' },
  { name: '--nds-radius-2xl', value: '12px' },
  { name: '--nds-radius-3xl', value: '14px' },
  // A full capsule — toggles, progress bars, icon buttons. NOT `--nds-radius-pill` (4px), which is
  // the status-pill rounded rect. The DS was writing 999px as a literal 9 times and the ads
  // console 75 more; neither could say it meant the same shape.
  { name: '--nds-radius-full', value: '999px' },
  { name: '--nds-radius-round', value: '999px' },

  // ── Elevation + focus ────────────────────────────────────────────
  { section: 'Elevation + focus', name: '--nds-shadow-card', value: '0 6px 22px rgb(var(--nds-shadow-rgb) / 0.16)' },
  { name: '--nds-shadow-menu', value: '0 12px 30px rgb(var(--nds-shadow-rgb) / 0.16)' },
  { name: '--nds-shadow-pop', value: '0 16px 40px rgb(var(--nds-shadow-rgb) / 0.2)' },
  { name: '--nds-shadow-modal', value: '0 18px 48px rgb(var(--nds-shadow-rgb) / 0.28)' },
  { name: '--nds-shadow-rail', value: '8px 0 30px rgb(var(--nds-shadow-rgb) / 0.13)' },
  { name: '--nds-shadow-tip', value: '0 10px 26px rgb(var(--nds-shadow-rgb) / 0.3)' },
  { name: '--nds-focus-ring', value: '0 0 0 2px rgb(var(--nds-focus-rgb) / 0.12)' },

  // ── Structural dimensions ────────────────────────────────────────
  { section: 'Structural dimensions', name: '--nds-rail-collapsed', value: '66px' },
  { name: '--nds-rail-expanded', value: '344px' },
  { name: '--nds-row-nav', value: '46px' },
  { name: '--nds-icon-zone', value: '50px' },

  // ── Type ─────────────────────────────────────────────────────────
  { section: 'Type', name: '--nds-font-sans', value: "var(--font-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  { name: '--nds-font-smoothing', value: 'auto' },

  // ── Platform-semantic aliases ────────────────────────────────────────
  //
  // 🔴 DS stylesheets DO NOT consume these. `token-guard` check D enforces it.
  //
  // This tier is published for APP CSS only. Eleven of these names — --text-*,
  // --surface-* and --border-* — are ALSO defined by globals.css (`:root`) and
  // ads.css (`.h10-shell`) as space-separated RGB CHANNELS, because Tailwind
  // composes them as `rgb(var(--x) / <alpha-value>)`. Custom properties resolve
  // from the nearest defining ANCESTOR, not by source order, so inside the shell
  // those definitions shadow these and `background: var(--surface-card)` becomes
  // `background: 255 255 255` — invalid at computed-value time, silently dropped.
  // 285 DS declarations were dead that way until Phase 9.0b moved every one of
  // them onto the DS-owned `--nds-*` tier (docs/PHASE-9-0B-TOKEN-FORM.md).
  //
  // The tier is KEPT rather than deleted: --color-primary and the --status-*
  // family are NOT contested (nothing else defines them) and app stylesheets
  // depend on them — reporting.css alone has 47 uses, plus trust.css and
  // /products/next. Deleting the tier would break ~70 app declarations to fix a
  // problem the guard already prevents.
  //
  // If you add a name here, first `grep -rn -- "--<name>:" apps/web/src/app`.
  // If globals.css or ads.css already defines it, adding it is a landmine, not a
  // fix — that is why --surface-raised is deliberately absent.
  { section: 'Platform-semantic aliases', name: '--text-primary', value: 'var(--nds-text)' },
  { name: '--text-secondary', value: 'var(--nds-text-2)' },
  { name: '--text-tertiary', value: 'var(--nds-text-3)' },
  { name: '--text-disabled', value: 'var(--nds-text-disabled)' },
  { name: '--text-link', value: 'var(--nds-text-link)' },
  { name: '--surface-canvas', value: 'var(--nds-bg)' },
  { name: '--surface-card', value: 'var(--nds-surface)' },
  { name: '--surface-sunken', value: 'var(--nds-surface-sunken)' },
  { name: '--border-default', value: 'var(--nds-border)' },
  { name: '--border-subtle', value: 'var(--nds-border-subtle)' },
  { name: '--border-strong', value: 'var(--nds-border-strong)' },
  { name: '--color-primary', value: 'var(--nds-primary)' },
  { name: '--color-primary-soft', value: 'var(--nds-primary-soft)' },
  { name: '--status-success-soft', value: 'var(--nds-success-soft)' },
  { name: '--status-success-line', value: 'var(--nds-success)' },
  { name: '--status-success-strong', value: 'var(--nds-success-strong)' },
  { name: '--status-warning-soft', value: 'var(--nds-warning-soft)' },
  { name: '--status-warning-line', value: 'var(--nds-warning)' },
  { name: '--status-warning-strong', value: 'var(--nds-warning-strong)' },
  { name: '--status-danger-soft', value: 'var(--nds-danger-soft)' },
  { name: '--status-danger-line', value: 'var(--nds-danger)' },
  { name: '--status-danger-strong', value: 'var(--nds-danger-strong)' },
  { name: '--status-info-soft', value: 'var(--nds-info-soft)' },
  { name: '--status-info-line', value: 'var(--nds-info)' },
  { name: '--status-info-strong', value: 'var(--nds-info-strong)' },

  // ── Dimension: spacing + type ────────────────────────────────────
  // Derived from ./spacing and ./typography rather than restated here, so each
  // scale is still defined exactly once: `px12` -> `--nds-space-12`,
  // `xsPlus` -> `--nds-font-size-xs-plus`.
  //
  // These are theme-invariant, so they are emitted to :root only and never to
  // the .dark block — a padding does not change with the canvas.
  ...spacingVars,
  ...typeVars,
]

/** Dark-mode overrides (the `.dark` block). Provisional inversions; their only home. */
export const cssVarsDark: ReadonlyArray<CssVar> = [
  { name: '--nds-text', value: '#e7ebf1' },
  { name: '--nds-text-2', value: '#aab6c2' },
  { name: '--nds-text-3', value: '#8a94a6' },
  { name: '--nds-text-disabled', value: '#5b6b7b' },
  { name: '--nds-text-inverse', value: '#14223a' },

  { name: '--nds-bg', value: '#14223a' },
  { name: '--nds-surface', value: '#18263b' },
  { name: '--nds-surface-raised', value: '#1f2c3d' },
  { name: '--nds-surface-sunken', value: '#1a2330' },
  { name: '--nds-rail-bg', value: '#18263b' },

  { name: '--nds-border', value: '#2f3a4a' },
  { name: '--nds-border-subtle', value: '#26323f' },
  { name: '--nds-border-strong', value: '#46505f' },
  { name: '--nds-rail-border', value: '#26323f' },

  // Tone + link roles on a dark canvas. The light values (--nds-amber-700 /
  // --nds-red-700 / --nds-green-700 / --nds-blue-600) measure 2.94:1 - 3.18:1
  // against the dark surfaces — all below AA. Measured in-browser 2026-08-19;
  // every value below measures >= 4.5:1 on --nds-surface / --nds-surface-raised.
  // These lived as `.dark .nds-acct*` hex overrides in components.css until
  // 2026-08-24: a DS-wide gap patched per-component, so any NEW component
  // inherited the sub-AA value. Fixed at the token tier, which is its only home.
  { section: 'Dark tone + link roles (AA on the dark canvas)', name: '--nds-success-strong', value: '#6ee7a8' },
  { name: '--nds-warning-strong', value: '#f0b46a' },
  { name: '--nds-danger-strong', value: '#f79289' },
  { name: '--nds-text-link', value: '#8ab6f0' },

  // Dark rail palette (consumed only when the rail is NOT under .h10-shell —
  // i.e. the app-wide rail; standalone shells pin these light).
  { section: 'Dark rail palette (app-wide rail only; shells pin light)', name: '--nds-rail-text', value: '#aab6c2' },
  { name: '--nds-rail-text-2', value: '#97a3b1' },
  { name: '--nds-rail-text-strong', value: '#e7ebf1' },
  { name: '--nds-rail-icon', value: '#8a94a6' },
  { name: '--nds-rail-chev', value: '#6f7b8b' },
  { name: '--nds-rail-item-hover', value: '#223247' },
  { name: '--nds-rail-item-hover-2', value: '#1d2a3c' },
  { name: '--nds-rail-chip-bg', value: '#243345' },
  { name: '--nds-rail-chip-active-bg', value: '#1d3a5f' },
  { name: '--nds-rail-chip-active-fg', value: '#cfe1fb' },
  { name: '--nds-rail-ft', value: '#6f7b8b' },

]
