/**
 * The authoritative ORDERED list of CSS custom properties emitted to
 * styles/tokens.css. This is the single source of truth for tokens.css —
 * `tools/generate-tokens-css.mts` reads this and writes the stylesheet.
 *
 * Hex values come from ./colors (palette/pill/badge) so colour is defined ONCE.
 * Tier-2 roles are `var(--…)` reference strings (no hex to duplicate). Radius /
 * shadow / structural / type / the dark block are literals here (their only home).
 */
import { palette, pill, badge } from './colors'
import { gridVars, gridVarsDark } from './grid'
import { workspaceVars } from './workspace'
import { fontSize, fontWeight } from './typography'
import { duration, easing } from './motion'
import { space } from './spacing'
import { radius } from './radius'

export interface CssVar {
  /** when set, a section-comment is emitted before this row */
  section?: string
  name: string
  value: string
}

const kebab = (k: string) =>
  k.replace(/^px/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

const spacingVars: ReadonlyArray<CssVar> = Object.entries(space).map(([k, v], i) => ({
  ...(i === 0 ? { section: 'Dimension: spacing (scale lives in tokens/spacing.ts)' } : {}),
  name: `--nds-space-${kebab(k)}`,
  value: v,
}))

/**
 * Type scale — ported from apps/web (hub #633). The fork carried colour + grid but never the type
 * dimension, while components.css already referenced six of these tokens
 * (`--nds-font-size-{micro,sm,xs-plus}`, `--nds-font-weight-semibold`). An undefined custom property
 * makes the declaration invalid at computed-value time, so `font-size` silently INHERITS — measured
 * on :3100 before this landed. Derived from ./typography rather than restated, exactly as apps/web
 * does it, so the scale is defined once per fork and the two cannot drift apart.
 */
const typeVars: ReadonlyArray<CssVar> = [
  { name: '--nds-font-mono', value: "var(--font-mono, ui-monospace), SFMono-Regular, Menlo, monospace" },
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

/**
 * Radius — DERIVED from ./radius (hub #648), not restated. See apps/web for why: the scale existed
 * twice, hand-synced with no guard, so minting a step in `radius.ts` alone regenerated tokens.css
 * successfully and added nothing. `--nds-radius-round` had also drifted to the end of the
 * note-severity block here; deriving returns it to the scale.
 */
const radiusVars: ReadonlyArray<CssVar> = Object.entries(radius).map(([k, v], i) => ({
  ...(i === 0 ? { section: 'Radius' } : {}),
  name: `--nds-radius-${kebab(k)}`,
  value: v,
}))

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
  { name: '--nds-text-3', value: '#7e8796' },
  // 5.01:1 on --nds-surface. --nds-text-3 is 3.10:1 and fails AA as body text; muted is the
  // tier to use for secondary copy. Ported from apps/web 2026-08-25.
  { name: '--nds-text-muted', value: '#626c7b' },
  { name: '--nds-text-strong', value: 'var(--nds-grey-700)' },
  { name: '--nds-text-disabled', value: 'var(--nds-grey-400)' },
  { name: '--nds-text-inverse', value: 'var(--nds-white)' },
  // NOT --nds-blue-600: 4.42:1 on the ads console's ground, i.e. AA inside a card and failing
  // the moment the card is removed. #1a60c4 clears AA on every ground. See apps/web's copy.
  { name: '--nds-text-link', value: '#1a60c4' },
  { name: '--nds-tooltip-light-fg', value: 'var(--nds-grey-900)' },
  { name: '--nds-tooltip-light-bg', value: 'var(--nds-white)' },
  { name: '--nds-tooltip-light-border', value: 'var(--nds-grey-150)' },
  { name: '--nds-tooltip-light-fg-2', value: 'var(--nds-grey-700)' },
  { name: '--nds-tip-bg', value: 'var(--nds-grey-800)' },
  { name: '--nds-tip-fg', value: 'var(--nds-white)' },

  { name: '--nds-bg', value: 'var(--nds-grey-50)' },
  { name: '--nds-surface', value: 'var(--nds-white)' },
  { name: '--nds-surface-raised', value: 'var(--nds-grey-25)' },
  { name: '--nds-surface-sunken', value: 'var(--nds-grey-100)' },
  // `--nds-surface-2` is a NAME this fork's app code already uses for the sunken surface — six
  // fallback-less consumers (analytics/charts.tsx tooltip cursors, TeamClient and ShippingClient
  // count badges), and `background` does not inherit, so those badges have been painting nothing.
  // It is NOT mirrored from apps/web: the name is defined nowhere in that fork either (checked
  // repo-wide), so there was no value to copy — it aliases the role it is being used AS, which
  // introduces no new colour. Hub #687/P2 (extended).
  { name: '--nds-surface-2', value: 'var(--nds-surface-sunken)' },
  { name: '--nds-surface-hover', value: 'var(--nds-grey-75)' },
  { name: '--nds-wash-primary', value: 'var(--nds-blue-50)' },
  // Same story: `--nds-primary-subtle` is consumed as the wash BEHIND a primary-bordered row
  // (ShippingClient.tsx:344 selected rate, no fallback; TeamClient.tsx:110 with one), which is
  // exactly `--nds-wash-primary`. Aliased rather than given a new hex — a fresh "subtle primary"
  // value is how --nds-primary-soft ended up at 1.15:1.
  { name: '--nds-primary-subtle', value: 'var(--nds-wash-primary)' },
  { name: '--nds-rail-bg', value: 'var(--nds-rail-surface)' },

  { name: '--nds-border', value: 'var(--nds-grey-200)' },
  { name: '--nds-border-subtle', value: 'var(--nds-grey-150)' },
  { name: '--nds-border-strong', value: 'var(--nds-grey-300)' },
  { name: '--nds-rail-border', value: 'var(--nds-rail-line)' },
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
  { name: '--nds-danger-strong', value: '#a3211a' },
  { name: '--nds-warning-soft', value: '#fff6e8' },
  { name: '--nds-warning', value: 'var(--nds-amber-600)' },
  { name: '--nds-warning-strong', value: 'var(--nds-amber-700)' },
  { name: '--nds-warning-border', value: '#f0d9a8' },
  // The `-text` tier, LIGHT. Values mirror apps/web (tokens.css:109/:110) rather than being
  // re-derived: #146034 measures 6.95:1 on --nds-success-soft and #6d3f10 8.27:1 on
  // --nds-warning-soft, and a second opinion about a contrast number is how two forks stop being
  // one design system. This fork carried them ONLY in `.dark` (below), while three LIGHT consumers
  // already read them with no fallback — `styles/tokens.css` (--nds-pill-warning-fg, in :root),
  // `styles/components.css:847` and `styles/primitives.css:956` — so in light each declaration was
  // invalid at computed-value time and the colour fell through to inherit. Hub #687/P2.
  // PR.6: derived on cell, hover, child, primary-soft and danger-soft grounds, not on a plain panel alone.
  { name: '--nds-success-text', value: '#0b4b28' },
  { name: '--nds-warning-text', value: '#653a0f' },
  { name: '--nds-info-soft', value: 'var(--nds-blue-100)' },
  { name: '--nds-info-text-light', value: '#10457f' },
  { name: '--nds-info-text', value: 'var(--nds-info-text-light)' },
  { name: '--nds-info', value: 'var(--nds-blue-600)' },
  { name: '--nds-info-strong', value: 'var(--nds-blue-700)' },

  // status pills
  // FilterChip engaged — mirrors apps/web. blue-900 on blue-50 = 7.41:1.
  // Tonal — tier 2, shared by FilterChip's engaged state and Button's tonal variant.
  { section: 'Tonal', name: '--nds-tonal-bg', value: 'var(--nds-blue-50)' },
  { name: '--nds-tonal-border', value: 'var(--nds-blue-200)' },
  { name: '--nds-tonal-fg', value: 'var(--nds-blue-900)' },
  { section: 'FilterChip', name: '--nds-fchip-on-bg', value: 'var(--nds-tonal-bg)' },
  { name: '--nds-fchip-on-border', value: 'var(--nds-tonal-border)' },
  { name: '--nds-fchip-on-fg', value: 'var(--nds-tonal-fg)' },
  { section: 'status pills (tone-named: success/warning/neutral/danger)', name: '--nds-pill-success-fg', value: 'var(--nds-blue-900)' },
  { name: '--nds-pill-success-bg', value: pill.ok.bg },
  { name: '--nds-pill-warning-fg', value: 'var(--nds-warning-text)' },
  { name: '--nds-pill-warning-bg', value: 'var(--nds-amber-soft)' },
  { name: '--nds-pill-neutral-fg', value: 'var(--nds-text-2)' },
  { name: '--nds-pill-neutral-bg', value: 'var(--nds-grey-100)' },
  { name: '--nds-danger-text', value: '#7d2621' },
  // Provenance marks (D-#533/#563) — semantic, because a palette step is not where a theme lives.
  // Light was never the defect; these keep the shipped values. Dark is in the .dark list below.
  { name: '--nds-prov-ai-fg', value: '#6d28d9' },
  { name: '--nds-prov-formula-fg', value: '#094b5e' },
  { name: '--nds-prov-inherited-fg', value: '#1a60c4' },
  // NOT --nds-danger-strong: `.dark` overrides that to #f79289 while --nds-danger-soft stays
  // light, so the dark danger pill was #f79289 on #fde8e8 — 1.9:1, illegible. --nds-danger-text
  // has no dark override: 6.27:1 in BOTH themes (was 4.63 light / 1.9 dark).
  { name: '--nds-pill-danger-fg', value: 'var(--nds-danger-text)' },
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

  // ── Radius ───────────────────────────────────────────────────────
  // Layering. Mirrors apps/web — see that copy for why the bands sit above 1301.
  { section: 'Layering', name: '--nds-z-sticky', value: '5' },
  { name: '--nds-z-actionbar', value: '20' },
  { name: '--nds-z-rail', value: '50' },
  { name: '--nds-z-overlay', value: '1400' },
  // The drawer layer, above `--nds-z-overlay` (1400) so a confirmation opened FROM a drawer is not
  // painted behind it. `.nds-drawer` (styles/components.css:299) already consumed this name — PES
  // ruling #136 renamed `--nds-z-modal` on the web fork and the rename reached this fork's
  // stylesheet but not its token layer, so the declaration resolved to nothing and the drawer fell
  // to `z-index: auto`, under the rail and the action bar. Minted per hub #684; the dead
  // `--nds-z-modal` entry that sat above it — zero consumers here, dropped from apps/web's token
  // layer at [PES.1c] — was deleted per hub #687/P3, which finishes the rename on this fork.
  { name: '--nds-z-drawer', value: '1410' },
  { name: '--nds-z-popover', value: '1450' },
  // ── Popover geometry (D18) ──────────────────────────────────────────────────────────────────
  // The widest a closed-list popover may grow. Three declarations in styles/components.css already
  // read it — `.nds-pop-clamp` (:624, :641) from hub #676 and `.nds-hovercard-card` (:881) from
  // #678 — and this fork defined it nowhere, so each `max-width: var(--nds-popover-max-w)` was
  // invalid at computed-value time and took the initial `none`: the cap both rulings landed was
  // silently absent on exactly the fork that received the fix. Value mirrors apps/web (320px) so
  // the two forks cap at one number. Minted per hub #684.
  { name: '--nds-popover-max-w', value: '320px' },
  { name: '--nds-z-toast', value: '1600' },
  { name: '--nds-z-tooltip', value: '1700' },
  ...radiusVars,
  // Inline-note severities, one pair each. Values are the HIGHEST-contrast variant found among
  // the six that existed, so adopting them raises contrast everywhere and lowers it nowhere:
  // error 6.24/9.16/9.23 → 9.23, caution 5.79/5.89/6.63 → 6.63.
  { name: '--nds-note-error-bg', value: '#fdf0ef' },
  { name: '--nds-note-error-fg', value: '#7a2018' },
  { name: '--nds-note-error-icon', value: '#b3261e' },
  { name: '--nds-note-warn-bg', value: '#fdf6e3' },
  { name: '--nds-note-warn-fg', value: '#6b5514' },
  { name: '--nds-note-warn-icon', value: '#8a6d1f' },
  // The note trios shipped no BORDER step — see apps/web.
  { name: '--nds-note-warn-border', value: '#e0d4a8' },
  { name: '--nds-note-error-border', value: '#eec9c4' },

  // ── Elevation + focus ────────────────────────────────────────────
  { section: 'Elevation + focus', name: '--nds-shadow-card', value: '0 6px 22px rgb(var(--nds-shadow-rgb) / 0.16)' },
  { name: '--nds-shadow-menu', value: '0 12px 30px rgb(var(--nds-shadow-rgb) / 0.16)' },
  { name: '--nds-shadow-pop', value: '0 16px 40px rgb(var(--nds-shadow-rgb) / 0.2)' },
  { name: '--nds-shadow-modal', value: '0 18px 48px rgb(var(--nds-shadow-rgb) / 0.28)' },
  { name: '--nds-shadow-rail', value: '8px 0 30px rgb(var(--nds-shadow-rgb) / 0.13)' },
  { name: '--nds-shadow-tip', value: '0 10px 26px rgb(var(--nds-shadow-rgb) / 0.3)' },
  { name: '--nds-focus-ring', value: '0 0 0 2px rgb(var(--nds-focus-rgb) / 0.12)' },

  // ── Structural dimensions ────────────────────────────────────────
  // Frozen Web comparison grid: mirrored roles preserve its measured rectangular shapes.
  { name: '--nds-wsgrid-legacy-badge-radius', value: '4px' },
  { name: '--nds-wsgrid-legacy-control-radius', value: '5px' },
  { section: 'Secondary navigation', name: '--nds-secondary-nav-w', value: '224px' },
  { name: '--nds-secondary-nav-toggle-w', value: 'var(--nds-space-48)' },
  { name: '--nds-duration-panel', value: duration.panel },
  { name: '--nds-easing-standard', value: easing.standard },
  { section: 'Structural dimensions', name: '--nds-rail-collapsed', value: '66px' },
  { name: '--nds-rail-expanded', value: '344px' },
  { name: '--nds-row-nav', value: '46px' },
  { name: '--nds-icon-zone', value: '50px' },
  // Mirrors apps/web (CT.1, 2026-09-04): the bar height DS.1 minted under #182 had never reached
  // this fork, and the two control tiers are new in both. See the web file for the reasoning.
  { name: '--nds-toolbar-h', value: '40px' },
  { name: '--nds-control-h-sm', value: '28px' },
  { name: '--nds-control-h-md', value: '30px' },

  // ── Type ─────────────────────────────────────────────────────────
  { section: 'Type', name: '--nds-font-sans', value: "var(--font-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  { name: '--nds-font-smoothing', value: 'auto' },

  // ── Platform-semantic aliases (components consume THESE; bridge to globals.css) ──
  // ── Tier 3: grid (GDS) — defined once in ./grid.ts; every colour a semantic role, no .dark entry ──
  ...gridVars,
  ...workspaceVars,

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
  { name: '--status-info-strong', value: 'var(--nds-blue-700)' },

  ...spacingVars,
  ...typeVars,
]

/** Dark-mode overrides (the `.dark` block). Provisional inversions; their only home. */
export const cssVarsDark: ReadonlyArray<CssVar> = [
  // Mapping status pills and selected controls share readable dark semantic roles.
  { name: '--nds-info-strong', value: 'var(--nds-text)' },
  { name: '--nds-tonal-bg', value: 'var(--nds-primary-soft)' },
  { name: '--nds-tonal-border', value: 'var(--nds-border-strong)' },
  { name: '--nds-tonal-fg', value: 'var(--nds-text)' },
  { name: '--nds-info-soft', value: 'var(--nds-primary-soft)' },
  { name: '--nds-info-text', value: 'var(--nds-text)' },
  { name: '--nds-text', value: '#e7ebf1' },
  { name: '--nds-text-2', value: '#aab6c2' },
  { name: '--nds-text-3', value: '#8a94a6' },
  { name: '--nds-text-disabled', value: '#5b6b7b' },
  { name: '--nds-text-inverse', value: '#14223a' },

  { name: '--nds-bg', value: '#14223a' },
  { name: '--nds-surface', value: '#18263b' },
  { name: '--nds-surface-raised', value: '#1f2c3d' },
  { name: '--nds-surface-sunken', value: '#1a2330' },
  // Re-declared in .dark for the reason check-dark-alias-scope exists: a var() alias resolves in
  // the scope where it is DECLARED, so a :root-only alias keeps its LIGHT value inside .dark.
  { name: '--nds-surface-2', value: 'var(--nds-surface-sunken)' },
  { name: '--nds-rail-bg', value: '#18263b' },

  // ── the dark palette, measured 2026-08-26 ────────────────────────────────────────────────────
  // The dark block overrode 29 tokens out of ~240, so most washes and fills kept their LIGHT
  // value on a dark canvas: 28 DS rules measured below AA after the aliases below were applied.
  // Every value here was chosen against its ACTUAL usage, not picked to look right in isolation.
  //
  // --nds-primary is the constrained one: it is a FILL carrying --nds-text-inverse AND is used as
  // TEXT on --nds-surface, so one value has to clear both. #6d9ee8 gives 5.84 and 5.59.
  // Deliberately NOT #8ab6f0, which would clear both more comfortably but IS --nds-text-link —
  // reusing it makes "primary" and "link" the same colour in dark and different in light.
  { name: '--nds-primary', value: '#6d9ee8' },
  { name: '--nds-primary-soft', value: '#1c2f4d' },      // link on it 6.42
  { name: '--nds-wash-primary', value: '#182a44' },      // link on it 6.90
  { name: '--nds-primary-subtle', value: 'var(--nds-wash-primary)' },
  { name: '--nds-pill-neutral-bg', value: '#26323f' },   // text-2 on it 6.32
  { name: '--nds-success-soft', value: '#173a2c' },      // success-strong on it 8.14
  { name: '--nds-danger-soft', value: '#3a1c1c' },       // danger-strong on it 6.92
  { name: '--nds-danger-text', value: '#f3b7b0' },       // PR.6: >=7.05 across the full declared-ground matrix
  // App chrome in dark (D-#540): the page is #14223a and this ground was #18263b — 1.05:1.
  { name: '--nds-chrome-bg', value: '#1e3050' },
  // Provenance marks in dark (D-#533/#563). The light values are dark by construction, so on
  // #18263b they measured 2.14 / 2.00 / 2.55 — the failure a semantic token exists to prevent.
  { name: '--nds-prov-ai-fg', value: '#c4b5fd' },
  { name: '--nds-prov-formula-fg', value: '#39d8f0' },
  { name: '--nds-prov-inherited-fg', value: '#93c5fd' },
  { name: '--nds-targeting-auto', value: '#7fd4b0' },    // text-inverse on it 9.05
  { name: '--nds-targeting-manual', value: '#c9a86a' },  // text-inverse on it 7.04
  { name: '--nds-imgup-surface', value: '#1a2330' },     // text-muted on it 7.67
  { name: '--nds-imgup-drag', value: '#1c2f4d' },        // text-link on it 6.42
  // The -text tier is DARK by construction (it exists to be read on a light wash), so on a dark
  // wash it is dark-on-dark: success-text measured 1.64:1 on the new --nds-success-soft. In dark
  // the -strong tier is the readable one — this block already chose those values to be AA on the
  // dark canvas — so -text aliases to it. --nds-stale-text follows --nds-warning-text and needs
  // no entry of its own.
  { name: '--nds-success-text', value: 'var(--nds-success-strong)' },   // 8.14 on success-soft
  { name: '--nds-warning-text', value: '#f2bc79' },   // PR.6: pending cell over hover ground >=7.07
  // warning-soft had no dark value, so a "warning" surface rendered a LIGHT amber wash on a dark
  // canvas — a contrast PASS that is still a visual bug, and the reason a ratio check alone is
  // not enough.
  { name: '--nds-warning-soft', value: '#3a2e12' },
  // The status pills carry their own bg tokens, which had no dark value — so once the -text tier
  // aliased to -strong (light) above, a warning pill was light-on-light at 1.66:1. These three
  // mirror the tone washes.
  { name: '--nds-pill-warning-bg', value: '#3a2e12' },
  // BLUE, not green. This console's success pill is blue — "ok = blue Enabled" is the convention
  // pillTone.ts documents, and the LIGHT value is #d2e6fc with a blue-900 foreground. Mirroring
  // the tone NAME to green would have made the same pill green in dark and blue in light.
  { name: '--nds-pill-success-bg', value: '#1c2f4d' },
  { name: '--nds-pill-success-fg', value: 'var(--nds-text-link)' },   // 6.42 on it
  { name: '--nds-pill-danger-bg', value: '#3a1c1c' },
  // 🔴 These four ALIAS a token that .dark overrides, and must therefore be re-declared HERE.
  // A custom property whose value is `var(X)` resolves in the scope where it is DECLARED, not
  // where it is used: declared on :root, `--nds-pill-warning-fg: var(--nds-warning-text)`
  // computes to the LIGHT #6d3f10 on :root and then inherits that literal into .dark. Overriding
  // --nds-warning-text in .dark never reaches it. Measured in-browser: the warning pill was
  // 1.50:1, the neutral pill 2.21:1 and the danger pill 2.09:1 — while a static resolver that
  // assumed lazy resolution reported all three as passing.
  { name: '--nds-pill-warning-fg', value: 'var(--nds-warning-text)' },
  { name: '--nds-pill-neutral-fg', value: 'var(--nds-text-2)' },
  { name: '--nds-pill-danger-fg', value: 'var(--nds-danger-text)' },
  { name: '--nds-stale-text', value: 'var(--nds-warning-text)' },
  //
  // NOT overridden on purpose: --nds-white and --nds-grey-100, which workspace-grid.css uses as
  // BACKGROUNDS. A ramp step is an absolute colour — a dark "white" would make every other
  // consumer shift silently. Those two rules need repointing to a semantic surface instead.

  // Three tokens with no dark value kept their LIGHT one on a dark canvas — see apps/web.
  { name: '--nds-surface-hover', value: 'var(--nds-surface-raised)' },
  { name: '--nds-text-strong', value: 'var(--nds-text)' },
  { name: '--nds-text-muted', value: 'var(--nds-text-2)' },

  { name: '--nds-border', value: '#2f3a4a' },
  { name: '--nds-border-subtle', value: '#26323f' },
  { name: '--nds-border-strong', value: '#46505f' },
  { name: '--nds-rail-border', value: '#26323f' },
  { section: 'Dark tone + link roles (AA on the dark canvas)', name: '--nds-success-strong', value: '#6ee7a8' },
  { name: '--nds-warning-strong', value: '#f0b46a' },
  { name: '--nds-danger-strong', value: '#f79289' },
  { name: '--nds-text-link', value: '#8ab6f0' },

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

  // ── grid aliases, re-declared so they resolve against the dark tier (tokens/grid.ts) ──
  ...gridVarsDark,
]
